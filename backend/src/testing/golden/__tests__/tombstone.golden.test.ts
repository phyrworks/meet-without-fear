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

import { TOMBSTONE_ALLOW, TOMBSTONE_DELETION_STEP, TOMBSTONE_KNOWN_DEVIATIONS } from '../allow-lists/tombstone';
import { withClient, listTables } from '../db';
import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { scenarioFor, TOMBSTONE_TEXT } from '../../fixture-scenarios/scenarios';
import { TargetStage } from '../../fixture-scenarios/target-stage';
import { findMissing, fullRead, Leak, unexpectedLeakReport } from '../privacy';
import { goldenScenarioChecks } from '../scenario-checks';
import type { Snapshot } from '../snapshot';

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
 * Bob's full read, minus `strategies`: GET /strategies shuffles its list on
 * every call (controllers/stage4.ts shuffleArray) and this fixture has two
 * proposals, so its order is not a baseline (measured flipping).
 */
const READS = { tables: ['User', 'Message', 'UserVessel'], set: 'all' as const, except: ['strategies'] };

const AFTER_TABLES = [
  'Session', 'User', 'Message', 'EmpathyAttempt', 'EmpathyDraft', 'IdentifiedNeed', 'Agreement', 'InnerWorkSession',
  'InnerWorkMessage', 'BrainActivity', 'UserVessel', 'StageProgress', 'ConsentRecord', 'Invitation',
];

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
    adaDisplayNames = await withClient(
      harness.fixture.target,
      async c =>
        (await c.query<{ display_name: string | null }>(`SELECT display_name FROM old_concept_participant WHERE user_id = $1`, [
          adaId,
        ])).rows.map(r => r.display_name),
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
  });

  it('the deletion ran, at the index the allow-list pins', () => {
    expect(steps[TOMBSTONE_DELETION_STEP]).toBe(deletion);
    expect(steps).toHaveLength(2 * TOMBSTONE_DELETION_STEP + 1);
    expect(deletion.status).toBe(200);
    expect(after.tables.Session.map(s => s.id)).toEqual([harness.sessionId]);
  });

  it('every rule of the tombstone walk holds (known deviations aside)', () => {
    const t = after.tables;
    const deviations: Leak[] = [];
    const rule = (name: string, holds: boolean) => {
      if (!holds) deviations.push({ step: 'tombstone', probe: name });
    };
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
      !bobAfter.some(s => JSON.stringify(s.body).includes('"name":"Ada Lovelace"')),
    );
    rule('user row is tombstoned, not deleted', t.User.some(u => u.id === adaId));
    rule(
      'the concept views represent the state after the deletion',
      !steps.some(s => s.concept?.unrepresentable !== undefined),
    );
    deviations.push(...findMissing(bobAfter, SURVIVES, "Bob's reads after the deletion"));

    expect(unexpectedLeakReport(deviations, TOMBSTONE_KNOWN_DEVIATIONS)).toEqual({ unexpected: [], stale: [] });
  });
});
