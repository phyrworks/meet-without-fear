/**
 * Golden scenario R5: account deletion leaves a tombstone, not a hole
 * (plan §4; spec §4 `app.anonymize_user_account` "the complete walk").
 *
 * Fixture TOMBSTONE_READY: a finished legacy journey with everything the walk
 * must sort — both attempts revealed and validated, Ada's shared context
 * delivered into Bob's conversation, both partners' needs shared, an agreement,
 * private chat for both, Ada's reflection, and prompt captures of Ada's
 * session and reflection turns. The session is still ACTIVE.
 *
 * Bob reads everything; Ada deletes her account (`DELETE /auth/me`, the
 * production endpoint); Bob reads everything again. The target's walk says:
 *
 *   survives, readable to the partner   delivered messages, revealed attempts, need_share, agreements
 *   gone                                the leaver's private rows (own conversation, drafts, reflection),
 *                                       and every brain_activity of theirs
 *   tombstoned                          participant.display_name NULL; the user row scrubbed, never deleted
 *   session                             a live session → ABANDONED
 *
 * Each rule is checked against the database after the deletion and Bob's
 * reads; every rule today's code breaks is a KNOWN deviation with a finding
 * (`allow-lists/tombstone.ts`). Today's deletion also leaves rows the
 * migration's mapping cannot direct (the leaver's attempt loses its author), so
 * the harness records the concept views as unrepresentable from the deletion
 * on (`conceptUnrepresentable: 'record'`) — itself a known deviation.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build TOMBSTONE_READY
 * Record:   GOLDEN_UPDATE=tombstone npx jest tombstone.golden
 *           GOLDEN_UPDATE=tombstone.concept npx jest tombstone.golden
 */

import {
  afterRead,
  beforeRead,
  TOMBSTONE_ALLOW,
  TOMBSTONE_BYTE_TARGET_ALLOW,
  TOMBSTONE_DELETION_STEP,
  TOMBSTONE_KNOWN_DEVIATIONS,
  TOMBSTONE_PRIVATE_KNOWN_LEAKS,
  TOMBSTONE_NAME_KNOWN_LEAKS,
  TOMBSTONE_READ_EXCEPT,
} from '../allow-lists/tombstone';
import { withClient, listTables } from '../db';
import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { ADA_REFLECTION, scenarioFor, TOMBSTONE_TEXT } from '../../fixture-scenarios/scenarios';
import { TargetStage } from '../../fixture-scenarios/target-stage';
import { findLeaks, findMissing, fullRead, Leak, shapeTables, unexpectedLeakReport } from '../privacy';
import {
  authorClosureChecks,
  goldenScenarioChecks,
  targetFixtureDeltaChecks,
  targetMessageStageChecks,
} from '../scenario-checks';
import type { Snapshot } from '../snapshot';
import { isTargetShape } from '../shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'tombstone';
const fixture = scenarioFor(TargetStage.TOMBSTONE_READY, { a: 'Ada Lovelace', b: 'Bob Ross' });
const ADA_PRIVATE_LINES = (fixture.participants[0].messages ?? []).map(m => m.content);
const AGREEMENT = fixture.legacyStrategies!.agreement!.description;

/** What the target keeps readable to Bob after Ada leaves. */
const SURVIVES: Record<string, string> = {
  'delivered shared context': TOMBSTONE_TEXT.adaSharedContext,
  "Ada's revealed statement": TOMBSTONE_TEXT.adaEmpathy,
  agreement: AGREEMENT,
  ...Object.fromEntries(TOMBSTONE_TEXT.adaNeedShares.map((t, i) => [`Ada's shared need ${i + 1}`, t])),
};

/**
 * Ada's private material (fix round 1, C2): none of it may be in Bob's reads
 * after she leaves — her own conversation, her needs' labels and evidence,
 * her reflection. (Her draft text is her revealed statement, which survives
 * by design, so it is not a probe.)
 */
const ADA_PRIVATE_PROBES: Record<string, string> = {
  ...Object.fromEntries(ADA_PRIVATE_LINES.map((l, i) => [`Ada's private line ${i + 1}`, l])),
  ...Object.fromEntries(
    TOMBSTONE_TEXT.adaNeeds.flatMap((n, i) => [
      [`Ada's need ${i + 1} label`, n.need],
      ...(n.evidence ?? []).map((e, j) => [`Ada's need ${i + 1} evidence ${j + 1}`, e] as const),
    ]),
  ),
  "Ada's reflection title": ADA_REFLECTION.title,
  "Ada's reflection theme": ADA_REFLECTION.theme,
  "Ada's reflection summary": ADA_REFLECTION.summary,
  "Ada's reflection line": ADA_REFLECTION.userLine,
  "Ada's reflection reply": ADA_REFLECTION.aiLine,
};

const READS = { tables: shapeTables(['User', 'Message', 'UserVessel']), set: 'all' as const, except: TOMBSTONE_READ_EXCEPT };

const AFTER_TABLES = isTargetShape()
  ? [
      'session', 'user', 'participant', 'conversation', 'message', 'empathy_attempt', 'draft', 'need', 'need_share',
      'proposal_choice', 'agreement', 'agreement_party', 'reflection', 'reflection_message', 'brain_activity',
      'conversation_read_state', 'participant_milestone', 'consent', 'invitation', 'ai_memory', 'mood_reading',
      'feature_state', 'user_device', 'user_preferences', 'user_memory', 'user_key', 'participant_key',
    ]
  : [
      'Session', 'User', 'Message', 'EmpathyAttempt', 'EmpathyDraft', 'IdentifiedNeed', 'Agreement', 'InnerWorkSession',
      'InnerWorkMessage', 'BrainActivity', 'UserVessel', 'StageProgress', 'ConsentRecord', 'Invitation',
    ];

/**
 * TS-12, target only: the leaver's private rows TOMBSTONE_READY does not hold,
 * written right before the deletion (after Bob's first reads, so the baseline
 * reads are untouched) so that every absence rule of the walk has a row to
 * find gone: a SUMMARY and a GLOBAL_FACTS memory, a mood reading, an unshared
 * need, an unrevealed round, wellbeing state, a device, preferences, a user
 * memory, and her user and participant keys.
 */
const SEEDED_PRIVATE = 'PROBE_TS12_LEAVER_PRIVATE';
async function seedLeaverPrivateRows(h: Harness, adaUser: string): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  await withClient(
    h.fixture.target,
    async c => {
      const one = async (label: string, sql: string, params: unknown[]) => {
        const rows = (await c.query<{ id: string }>(sql, params)).rows;
        if (rows[0]?.id) labels[rows[0].id] = `<seeded:${label}>`;
      };
      const [{ pid, bob }] = (
        await c.query<{ pid: string; bob: string }>(
          `SELECT p.id AS pid, q.id AS bob FROM participant p JOIN participant q ON q.session_id = p.session_id AND q.id <> p.id
           WHERE p.user_id = $1`,
          [adaUser],
        )
      ).rows;
      const [{ attempt }] = (
        await c.query<{ attempt: string }>(`SELECT id AS attempt FROM empathy_attempt WHERE author_participant_id = $1`, [pid])
      ).rows;
      await one(
        'ai_memory/SUMMARY',
        `INSERT INTO ai_memory (participant_id, kind, doc) VALUES ($1, 'SUMMARY', jsonb_build_object('text', $2::text, 'messageCount', 1, 'generatedAt', now())) RETURNING id`,
        [pid, SEEDED_PRIVATE],
      );
      await one(
        'ai_memory/GLOBAL_FACTS',
        `INSERT INTO ai_memory (user_id, kind, doc) VALUES ($1, 'GLOBAL_FACTS', jsonb_build_object('facts', jsonb_build_array($2::text))) RETURNING id`,
        [adaUser, SEEDED_PRIVATE],
      );
      await one('mood_reading', `INSERT INTO mood_reading (participant_id, intensity, context) VALUES ($1, 7, $2) RETURNING id`, [pid, SEEDED_PRIVATE]);
      await one('need/unshared', `INSERT INTO need (participant_id, label, category, ai_confidence) VALUES ($1, $2, 'SAFETY', 0.9) RETURNING id`, [pid, SEEDED_PRIVATE]);
      await one(
        'empathy_attempt/unrevealed',
        `INSERT INTO empathy_attempt (author_participant_id, subject_participant_id, round, supersedes_attempt_id, content, status)
         VALUES ($1, $2, 2, $3, $4, 'HELD') RETURNING id`,
        [pid, bob, attempt, SEEDED_PRIVATE],
      );
      await c.query(`INSERT INTO feature_state (user_id, feature, doc) VALUES ($1, 'people', '{}')`, [adaUser]);
      await one('user_device', `INSERT INTO user_device (user_id, push_token, platform) VALUES ($1, 'ExponentPushToken[ts12]', 'ios') RETURNING id`, [adaUser]);
      await c.query(`INSERT INTO user_preferences (user_id, doc) VALUES ($1, '{"memory": {}, "notifications": {}, "privacy": {}}')`, [adaUser]);
      await one('user_memory', `INSERT INTO user_memory (user_id, content, category) VALUES ($1, $2, 'PREFERENCE') RETURNING id`, [adaUser, SEEDED_PRIVATE]);
      await one('user_key', `INSERT INTO user_key (user_id, key_id, wrapped_dek) VALUES ($1, 'ts12-user-key', '\\x00') RETURNING id`, [adaUser]);
      await one('participant_key', `INSERT INTO participant_key (participant_id, key_id, wrapped_dek) VALUES ($1, 'ts12-participant-key', '\\x00') RETURNING id`, [pid]);
      // Fix round 1 (M5): the rest of spec §4 steps 3/5 — a regulation event, a need disposition,
      // a follow-up note, a check-in on her INDIVIDUAL follow-up, and her reminder of it.
      await one('regulation_event', `INSERT INTO regulation_event (participant_id, type) VALUES ($1, 'BREATHING_EXERCISE') RETURNING id`, [pid]);
      await c.query(
        `INSERT INTO need_disposition (participant_id, need_id, status, note)
         SELECT $1, n.id, 'OPEN', $2 FROM need n WHERE n.participant_id = $1 AND n.label <> $2 ORDER BY n.created_at LIMIT 1`,
        [pid, SEEDED_PRIVATE],
      );
      await one('follow_up_note', `INSERT INTO follow_up_note (participant_id, content) VALUES ($1, $2) RETURNING id`, [pid, SEEDED_PRIVATE]);
      const [{ id: individual }] = (
        await c.query<{ id: string }>(
          `INSERT INTO follow_up (session_id, type, scope, owner_participant_id, status, scheduled_for)
           SELECT p.session_id, 'SCHEDULED_INDIVIDUAL_COMMITMENT', 'INDIVIDUAL', p.id, 'OPEN', now() FROM participant p WHERE p.id = $1 RETURNING id`,
          [pid],
        )
      ).rows;
      labels[individual] = '<seeded:follow_up/individual>';
      await one(
        'follow_up_checkin/individual',
        `INSERT INTO follow_up_checkin (follow_up_id, participant_id, payload) VALUES ($1, $2, jsonb_build_object('note', $3::text)) RETURNING id`,
        [individual, pid, SEEDED_PRIVATE],
      );
      await one('reminder', `INSERT INTO reminder (user_id, follow_up_id, remind_at, note) VALUES ($1, $2, now() + interval '1 day', $3) RETURNING id`, [
        adaUser,
        individual,
        SEEDED_PRIVATE,
      ]);
    },
    h.fixture.database,
  );
  return labels;
}


/**
 * Fix round 1 (M5): one count per seeded private row class of the leaver, taken right after
 * seeding (each must be ≥ 1: the absence rules are not vacuous) and again after the walk (each
 * must be 0 — keys: 0 live). Per row class, not an aggregate.
 */
const LEAVER_ROW_CENSUS: Record<string, string> = {
  'ai_memory SUMMARY': `SELECT count(*)::int AS n FROM ai_memory m JOIN participant p ON p.id = m.participant_id WHERE p.user_id = $1 AND m.kind = 'SUMMARY'`,
  'ai_memory GLOBAL_FACTS': `SELECT count(*)::int AS n FROM ai_memory WHERE user_id = $1 AND kind = 'GLOBAL_FACTS'`,
  mood_reading: `SELECT count(*)::int AS n FROM mood_reading m JOIN participant p ON p.id = m.participant_id WHERE p.user_id = $1`,
  'unshared need': `SELECT count(*)::int AS n FROM need n JOIN participant p ON p.id = n.participant_id WHERE p.user_id = $1 AND NOT EXISTS (SELECT 1 FROM need_share s WHERE s.need_id = n.id)`,
  'unrevealed attempt': `SELECT count(*)::int AS n FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id WHERE p.user_id = $1 AND a.revealed_at IS NULL`,
  feature_state: `SELECT count(*)::int AS n FROM feature_state WHERE user_id = $1`,
  user_device: `SELECT count(*)::int AS n FROM user_device WHERE user_id = $1`,
  user_preferences: `SELECT count(*)::int AS n FROM user_preferences WHERE user_id = $1`,
  user_memory: `SELECT count(*)::int AS n FROM user_memory WHERE user_id = $1`,
  'live user_key': `SELECT count(*)::int AS n FROM user_key WHERE user_id = $1 AND destroyed_at IS NULL`,
  'live participant_key': `SELECT count(*)::int AS n FROM participant_key k JOIN participant p ON p.id = k.participant_id WHERE p.user_id = $1 AND k.destroyed_at IS NULL`,
  regulation_event: `SELECT count(*)::int AS n FROM regulation_event r JOIN participant p ON p.id = r.participant_id WHERE p.user_id = $1`,
  need_disposition: `SELECT count(*)::int AS n FROM need_disposition d JOIN participant p ON p.id = d.participant_id WHERE p.user_id = $1`,
  follow_up_note: `SELECT count(*)::int AS n FROM follow_up_note x JOIN participant p ON p.id = x.participant_id WHERE p.user_id = $1`,
  'INDIVIDUAL check-in': `SELECT count(*)::int AS n FROM follow_up_checkin c JOIN follow_up f ON f.id = c.follow_up_id JOIN participant p ON p.id = c.participant_id WHERE p.user_id = $1 AND f.scope = 'INDIVIDUAL'`,
  reminder: `SELECT count(*)::int AS n FROM reminder WHERE user_id = $1`,
  draft: `SELECT count(*)::int AS n FROM draft d JOIN participant p ON p.id = d.participant_id WHERE p.user_id = $1`,
  conversation: `SELECT count(*)::int AS n FROM conversation c JOIN participant p ON p.id = c.participant_id WHERE p.user_id = $1`,
  reflection: `SELECT count(*)::int AS n FROM reflection WHERE user_id = $1`,
};
async function leaverCensus(h: Harness, adaUser: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await withClient(
    h.fixture.target,
    async c => {
      for (const [k, sql] of Object.entries(LEAVER_ROW_CENSUS)) out[k] = (await c.query<{ n: number }>(sql, [adaUser])).rows[0].n;
    },
    h.fixture.database,
  );
  return out;
}

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  let bobAfter: StepResult[];
  let deletion: StepResult;
  let after: Snapshot;
  let adaId: string;
  let bobId: string;
  let adaDisplayNames: Array<string | null>;
  let seededLabels: Record<string, string> = {};
  let censusBefore: Record<string, number> = {};
  let censusAfter: Record<string, number> = {};

  beforeAll(async () => {
    // The deletion calls Clerk's API with the account's clerkId when a secret is
    // configured; a test must not reach an external service.
    process.env.CLERK_SECRET_KEY = '';
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'TOMBSTONE_READY',
      runId: `${SCENARIO}_${process.pid}`,
      concept: true,
      conceptUnrepresentable: 'record',
    });
    const { userA: ada, userB: bob } = harness.actors;
    if (!bob) throw new Error('TOMBSTONE_READY must seed two users');
    adaId = ada.id;
    bobId = bob.id;
    const scope = await listTables(harness.fixture.target, harness.fixture.database);

    const before = await fullRead(harness, bob, 'before deletion', READS);
    if (isTargetShape()) {
      seededLabels = await seedLeaverPrivateRows(harness, adaId);
      censusBefore = await leaverCensus(harness, adaId);
    }
    deletion = await harness.step({
      label: 'delete account as ada@e2e.test',
      actor: ada,
      tables: scope,
      call: agent => agent.delete('/api/v1/auth/me'),
    });
    // No request as Ada after this: the E2E auth bypass would re-create her.
    bobAfter = await fullRead(harness, bob, 'after deletion', READS);
    steps = [...before, deletion, ...bobAfter];

    after = await harness.snapshot(AFTER_TABLES);
    if (isTargetShape()) censusAfter = await leaverCensus(harness, adaId);
    adaDisplayNames = await withClient(
      harness.fixture.target,
      async c =>
        (
          await c.query<{ display_name: string | null }>(
            isTargetShape()
              ? `SELECT display_name FROM participant WHERE user_id = $1`
              : `SELECT display_name FROM old_concept_participant WHERE user_id = $1`,
            [adaId],
          )
        ).rows.map(r => r.display_name),
      harness.fixture.database,
    );
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: TOMBSTONE_ALLOW,
    harness: () => harness,
    steps: () => steps,
    byteTargetAllowList: TOMBSTONE_BYTE_TARGET_ALLOW,
    byteFixtureLabels: true,
    byteExtraLabels: () => seededLabels,
  });

  targetMessageStageChecks({ harness: () => harness, steps: () => steps });
  targetFixtureDeltaChecks({ harness: () => harness, steps: () => steps, partnerLeftFromStep: TOMBSTONE_DELETION_STEP });
  authorClosureChecks({
    steps: () => steps,
    email: 'bob@e2e.test',
    empathyStatus: [beforeRead('empathy status'), afterRead('empathy status')],
    reconcilerStatus: [beforeRead('reconciler status'), afterRead('reconciler status')],
    summary: [beforeRead('reconciler summary'), afterRead('reconciler summary')],
  });

  // ---- TS-12 pairs of the target-only rules (allow-lists/tombstone.ts) ------
  const targetIt = isTargetShape() ? it : it.skip;
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql, params)).rows, harness.fixture.database);
  const data = (i: number) => (steps[i].body as { data?: Record<string, any> }).data ?? {};

  targetIt('stage 4 completion pair: a legacy completion without `closed` is IN_PROGRESS with the selection gate', async () => {
    const ms = await q<{ user_id: string; key: string }>(
      `SELECT p.user_id, pm.milestone_key AS key FROM participant_milestone pm JOIN participant p ON p.id = pm.participant_id`,
    );
    expect(ms.filter(m => m.key === 'closed')).toEqual([]);
    expect(ms.filter(m => m.key === 'choices_shared').map(m => m.user_id).sort()).toEqual([adaId, bobId].sort());
    for (const i of [beforeRead('progress'), afterRead('progress')]) {
      expect(data(i).myProgress).toMatchObject({ stage: 4, status: 'IN_PROGRESS', completedAt: null });
      expect(data(i).myProgress.gatesSatisfied.selectionSubmitted).toBe(true);
    }
    for (const i of [beforeRead('session'), afterRead('session')]) {
      expect(data(i).session).toMatchObject({ stageStatus: 'IN_PROGRESS', myProgress: { stage: 4, status: 'IN_PROGRESS' } });
    }
  });

  targetIt("needs comparison pair: partnerNeeds are Ada's need_share texts, myNeeds Bob's own needs", async () => {
    const [bobNeeds, adaShares] = await Promise.all([
      q<{ label: string }>(
        `SELECT n.label FROM need n JOIN participant p ON p.id = n.participant_id WHERE p.user_id = $1 AND n.deleted_at IS NULL ORDER BY n.created_at, n.id`,
        [bobId],
      ),
      q<{ shared_text: string }>(
        `SELECT s.shared_text FROM need_share s JOIN participant p ON p.id = s.participant_id WHERE p.user_id = $1 ORDER BY s.shared_at, s.need_id`,
        [adaId],
      ),
    ]);
    const d = data(beforeRead('needs comparison'));
    expect(d.myNeeds.map((n: { need: string }) => n.need)).toEqual(bobNeeds.map(n => n.label));
    expect(d.partnerNeeds.map((n: { need: string }) => n.need).sort()).toEqual(adaShares.map(s => s.shared_text).sort());
    expect(adaShares.map(s => s.shared_text).sort()).toEqual([...TOMBSTONE_TEXT.adaNeedShares].sort());
  });

  targetIt('stage 4 state pair: the selections are the choice rows; the open needs are the four shares no proposal covers', async () => {
    const choices = await q<{ user_id: string; proposal_id: string; decision: string }>(
      `SELECT p.user_id, c.proposal_id, c.decision::text AS decision FROM proposal_choice c JOIN participant p ON p.id = c.participant_id`,
    );
    const shares = await q<{ need_id: string }>(
      `SELECT s.need_id FROM need_share s WHERE NOT EXISTS (SELECT 1 FROM proposal_need pn WHERE pn.need_id = s.need_id)`,
    );
    for (const i of [beforeRead('stage4'), afterRead('stage4')]) {
      const d = data(i);
      const mine = choices.filter(c => c.user_id === bobId).map(c => ({ proposalId: c.proposal_id, decision: c.decision }));
      const theirs = choices.filter(c => c.user_id === adaId).map(c => ({ proposalId: c.proposal_id, decision: c.decision }));
      expect(d.mySelections.map((x: { proposalId: string; decision: string }) => ({ proposalId: x.proposalId, decision: x.decision }))).toEqual(mine);
      expect(d.partnerSelections.map((x: { proposalId: string; decision: string }) => ({ proposalId: x.proposalId, decision: x.decision }))).toEqual(theirs);
      expect(d.inventory.unaddressedNeeds.map((n: { id: string }) => n.id).sort()).toEqual(shares.map(x => x.need_id).sort());
    }
  });

  targetIt("tombstone attribution pair: the partner id and the delivered rows' sender are Ada's tombstone user", async () => {
    const after = (read: string) => data(afterRead(read));
    expect(after('session').session.partner).toEqual({ id: adaId, name: null, nickname: null });
    expect(after('state').session.partner).toEqual({ id: adaId, name: null, nickname: null });
    expect(after('session list').items[0].partner).toEqual({ id: adaId, name: null, nickname: null });
    const delivered = (after('messages').messages as Array<{ senderId: string | null; role: string }>).filter(m => m.senderId === adaId);
    expect(delivered.length).toBe(2);
    const [inv] = await q<{ id: string }>(`SELECT id FROM invitation WHERE session_id = $1`, [harness.sessionId]);
    expect(after('state').invitation?.id).toBe(inv.id);
  });

  targetIt("revealed-round pair: after the deletion Bob's empathy status shows Ada's revealed round, his own as his", async () => {
    const [adaAttempt] = await q<{ id: string }>(
      `SELECT a.id FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id WHERE p.user_id = $1 AND a.revealed_at IS NOT NULL`,
      [adaId],
    );
    const d = data(afterRead('empathy status'));
    expect(d.partnerAttempt).toMatchObject({ id: adaAttempt.id, content: TOMBSTONE_TEXT.adaEmpathy, sourceUserId: adaId });
    expect(d.myAttempt).toMatchObject({ content: TOMBSTONE_TEXT.bobEmpathy, sourceUserId: bobId });
  });

  targetIt('initial rank pair: the target writer stamps the offer once (updated_at = created_at)', async () => {
    const rows = await q<{ same: boolean }>(`SELECT updated_at = created_at AS same FROM context_share_offer`);
    expect(rows).toEqual([{ same: true }]);
  });

  targetIt('brain_activity cost pair: every cost is numerically the baseline 0', async () => {
    const rows = await q<{ cost: string }>(`SELECT cost::text AS cost FROM brain_activity`);
    for (const r of rows) expect(Number(r.cost)).toBe(0);
  });

  it('the deletion ran, at the index the allow-list pins', () => {
    expect(steps[TOMBSTONE_DELETION_STEP]).toBe(deletion);
    expect(steps).toHaveLength(2 * TOMBSTONE_DELETION_STEP + 1);
    expect(deletion.status).toBe(200);
    expect((isTargetShape() ? after.tables.session : after.tables.Session).map(s => s.id)).toEqual([harness.sessionId]);
  });

  it('every rule of the tombstone walk holds (known deviations aside)', () => {
    const t = after.tables;
    const deviations: Leak[] = [];
    const rule = (name: string, holds: boolean) => {
      if (!holds) deviations.push({ step: 'tombstone', probe: name });
    };
    if (isTargetShape()) {
      targetWalkRules(rule);
      deviations.push(...findMissing(bobAfter, SURVIVES, "Bob's reads after the deletion"));
      expect(unexpectedLeakReport(deviations, TOMBSTONE_KNOWN_DEVIATIONS)).toEqual({ unexpected: [], stale: [] });
      return;
    }
    const adaReflections = t.InnerWorkSession.filter(r => r.userId === adaId).map(r => r.id);

    rule('live session → ABANDONED', t.Session[0].status === 'ABANDONED');
    rule(
      'delivered message survives',
      t.Message.some(m => m.content === TOMBSTONE_TEXT.adaSharedContext && m.forUserId === bobId),
    );
    const adaAttempt = t.EmpathyAttempt.find(a => a.content === TOMBSTONE_TEXT.adaEmpathy);
    rule('revealed attempt survives', !!adaAttempt);
    rule('revealed attempt keeps its author (the tombstone)', !!adaAttempt && adaAttempt.sourceUserId !== null);
    rule('agreement survives', t.Agreement.some(a => a.description === AGREEMENT));
    rule(
      'shared needs survive',
      fixture.participants[0].needs!.every(n => t.IdentifiedNeed.some(r => r.need === n.need)),
    );
    rule(
      "leaver's own conversation is gone",
      !t.Message.some(m => ADA_PRIVATE_LINES.includes(String(m.content))),
    );
    rule("leaver's drafts are gone", !t.EmpathyDraft.some(d => d.userId === adaId));
    rule("leaver's reflections are gone", adaReflections.length === 0);
    // Ada's two captures: her session turn (her private lines) and her
    // reflection turn (the reflection's system prompt).
    const adaCapture = (b: Record<string, unknown>) => {
      const input = JSON.stringify(b.input);
      return ADA_PRIVATE_LINES.some(l => input.includes(l)) || input.includes("Ada's private reflection guide");
    };
    rule("leaver's brain_activity is gone", !t.BrainActivity.some(adaCapture));
    rule('participant.display_name is NULL', adaDisplayNames.length === 1 && adaDisplayNames[0] === null);
    rule(
      "the partner no longer reads the leaver's name",
      !bobAfter.some(s => {
        const body = JSON.stringify(s.body);
        return body.includes('"name":"Ada Lovelace"') || body.includes('"nickname":"Ada Lovelace"');
      }),
    );
    // Fix round 2: the scrub, not mere existence (spec §4 walk step 6).
    const adaUser = t.User.find(u => u.id === adaId);
    rule(
      'user row is tombstoned, not deleted',
      !!adaUser &&
        String(adaUser.email).startsWith('deleted+') &&
        adaUser.name === null &&
        adaUser.firstName === null &&
        adaUser.lastName === null &&
        adaUser.clerkId === null,
    );
    rule(
      'the concept views represent the state after the deletion',
      !steps.some(s => s.concept?.unrepresentable !== undefined),
    );
    deviations.push(...findMissing(bobAfter, SURVIVES, "Bob's reads after the deletion"));

    expect(unexpectedLeakReport(deviations, TOMBSTONE_KNOWN_DEVIATIONS)).toEqual({ unexpected: [], stale: [] });
  });


  /**
   * TS-12: the walk on the TARGET (spec §4 app.anonymize_user_account →
   * app.anonymize_user_in_session; R17), asserted on the database after the
   * deletion and Bob's reads. Survives, attributed to the tombstone: the
   * delivered message in Bob's conversation, the revealed attempt, need_share
   * (and its need row), the shared choices, the agreement. Gone or shredded:
   * the leaver's conversations, drafts, ai_memory (SUMMARY and GLOBAL_FACTS),
   * mood, unshared needs, unrevealed attempts, reflections, feature_state,
   * devices, preferences, user memories, her brain_activity, her keys.
   */
  function targetWalkRules(rule: (name: string, holds: boolean) => void): void {
    const t = after.tables;
    const [ada] = t.participant.filter(p => p.user_id === adaId);
    const [bobP] = t.participant.filter(p => p.user_id === bobId);
    const bobConversations = t.conversation.filter(c => c.participant_id === bobP.id).map(c => c.id);
    const has = (rows: Array<Record<string, unknown>>, pred: (r: Record<string, unknown>) => boolean) => rows.some(pred);

    rule('live session → ABANDONED', t.session[0].status === 'ABANDONED');
    rule('participant left (left_at set)', !!ada && ada.left_at !== null);
    rule(
      'delivered message survives',
      has(t.message, m => m.content === TOMBSTONE_TEXT.adaSharedContext && bobConversations.includes(m.conversation_id as string)),
    );
    const adaAttempt = t.empathy_attempt.find(a => a.content === TOMBSTONE_TEXT.adaEmpathy);
    rule('revealed attempt survives', !!adaAttempt && adaAttempt.revealed_at !== null);
    rule('revealed attempt keeps its author (the tombstone)', !!adaAttempt && adaAttempt.author_participant_id === ada.id);
    rule("leaver's unrevealed attempts are gone", !has(t.empathy_attempt, a => a.author_participant_id === ada.id && a.revealed_at === null));
    rule('agreement survives', has(t.agreement, a => a.description === AGREEMENT));
    rule('agreement keeps the tombstone as a party', has(t.agreement_party, a => a.participant_id === ada.id));
    rule(
      'shared needs survive',
      TOMBSTONE_TEXT.adaNeedShares.every(text => has(t.need_share, s => s.participant_id === ada.id && s.shared_text === text)) &&
        t.need_share.filter(s => s.participant_id === ada.id).every(s => has(t.need, n => n.id === s.need_id)),
    );
    rule("leaver's unshared needs are gone", !has(t.need, n => n.participant_id === ada.id && !has(t.need_share, s => s.need_id === n.id)));
    rule('shared choices survive', has(t.proposal_choice, c => c.participant_id === ada.id));
    rule("leaver's own conversation is gone", !has(t.conversation, c => c.participant_id === ada.id));
    rule(
      "none of the leaver's private lines remain (her copy of the delivered context included)",
      !has(t.message, m => ADA_PRIVATE_LINES.includes(String(m.content)) && !bobConversations.includes(m.conversation_id as string)),
    );
    rule("leaver's read state is gone", !has(t.conversation_read_state, r => r.participant_id === ada.id));
    rule("leaver's drafts are gone", !has(t.draft, d => d.participant_id === ada.id));
    rule("leaver's ai_memory is gone", !has(t.ai_memory, m => m.participant_id === ada.id || m.user_id === adaId));
    rule("leaver's mood readings are gone", !has(t.mood_reading, m => m.participant_id === ada.id));
    rule("leaver's reflections are gone", !has(t.reflection, r => r.user_id === adaId));
    rule("leaver's wellbeing state is gone", !has(t.feature_state, f => f.user_id === adaId));
    rule("leaver's devices are gone", !has(t.user_device, d => d.user_id === adaId));
    rule("leaver's preferences are gone", !has(t.user_preferences, d => d.user_id === adaId));
    rule("leaver's user memories are gone", !has(t.user_memory, d => d.user_id === adaId));
    rule(
      "leaver's keys are shredded",
      t.user_key.filter(k => k.user_id === adaId).length === 1 &&
        t.user_key.filter(k => k.user_id === adaId).every(k => k.destroyed_at !== null) &&
        t.participant_key.filter(k => k.participant_id === ada.id).length === 1 &&
        t.participant_key.filter(k => k.participant_id === ada.id).every(k => k.destroyed_at !== null),
    );
    // Fix round 1 (I1): the prompt is input/output on the target; scan every blob.
    const adaCapture = (b: Record<string, unknown>) => {
      const blobs = JSON.stringify([b.input, b.output, b.structured_output]);
      return ADA_PRIVATE_LINES.some(l => blobs.includes(l)) || blobs.includes("Ada's private reflection guide") || blobs.includes(SEEDED_PRIVATE);
    };
    rule("leaver's brain_activity is gone", !has(t.brain_activity, adaCapture) && !has(t.brain_activity, b => b.participant_id === ada.id));
    rule('participant.display_name is NULL', adaDisplayNames.length === 1 && adaDisplayNames[0] === null);
    rule(
      "the partner no longer reads the leaver's name",
      !bobAfter.some(s => {
        const body = JSON.stringify(s.body);
        return body.includes('"name":"Ada Lovelace"') || body.includes('"nickname":"Ada Lovelace"');
      }),
    );
    const adaUser = t.user.find(u => u.id === adaId);
    rule(
      'user row is tombstoned, not deleted',
      !!adaUser &&
        adaUser.email === `deleted+${adaId}` &&
        adaUser.name === null &&
        adaUser.first_name === null &&
        adaUser.last_name === null &&
        adaUser.clerk_id === null &&
        adaUser.deleted_at !== null,
    );
    rule('the concept views represent the state after the deletion', !steps.some(s => s.concept?.unrepresentable !== undefined));
    rule(
      'the seeded private rows were there to delete (the absence rules are not vacuous)',
      Object.values(censusBefore).every(n => n >= 1) && Object.keys(censusBefore).length === Object.keys(LEAVER_ROW_CENSUS).length,
    );
    for (const k of Object.keys(LEAVER_ROW_CENSUS)) rule(`leaver's ${k} is gone (census)`, censusAfter[k] === 0);
  }

  it("none of the leaver's private material is in Bob's reads after the deletion (known leaks aside)", () => {
    const observed = findLeaks(bobAfter, ADA_PRIVATE_PROBES);
    expect(unexpectedLeakReport(observed, TOMBSTONE_PRIVATE_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });

  // Fix round 2: checked against the restored state (the target keeps some of
  // these rows, so "the deletion removed them" would not hold there).
  it('the probes are live: the restored state carries them', () => {
    const initial = JSON.stringify(harness.conceptInitial!.tables);
    for (const probe of [
      ADA_REFLECTION.title,
      ADA_REFLECTION.userLine,
      ...ADA_PRIVATE_LINES,
      ...TOMBSTONE_TEXT.adaNeeds.flatMap(n => [n.need, ...(n.evidence ?? [])]),
      'ada@e2e.test',
      'Lovelace',
    ]) {
      expect(initial).toContain(probe);
    }
  });

  // Fix round 2: the leaver's identity on the three reads that carry the
  // partner's name. Scoped to those reads: reconciler text and messages name
  // "Ada Lovelace" by design (stored content, not a user fact).
  it("the leaver's email and names are not on the partner's name-bearing reads (known leaks aside)", () => {
    const nameReads = bobAfter.filter(s =>
      ['after deletion: session as', 'after deletion: state as', 'after deletion: session list as'].some(p =>
        s.label.startsWith(p),
      ),
    );
    expect(nameReads).toHaveLength(3);
    const observed = findLeaks(nameReads, { "Ada's email": 'ada@e2e.test', "Ada's first name": 'Ada', "Ada's last name": 'Lovelace' });
    expect(unexpectedLeakReport(observed, TOMBSTONE_NAME_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });
});
