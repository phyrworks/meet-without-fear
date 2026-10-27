/**
 * Golden scenario R4 (needs half): a need's label and evidence never reach
 * the partner, before or after sharing (plan §4 "choices and needs hidden
 * until shared"; spec §7).
 *
 * Fixture NEEDS_CONFIRMED: both partners in Stage 3 with confirmed needs,
 * nothing shared. The needs are shared through production's own endpoint
 * (`POST /needs/consent`), Bob first, then Ada, and the other partner reads at
 * each phase:
 *
 *   nothing shared      Ada reads (Bob's needs must be absent)
 *   Bob shared          Ada reads (still absent: she has not shared)
 *   both shared         Ada and Bob read the side-by-side comparison
 *
 * Probes are the partner's need labels and evidence. On the target (TS-11)
 * the partner reads `need_share.shared_text` (the job's transformed text) and
 * the category — never the label; the old shape returned the label (the
 * known leak work-a39h.11.21, closed on the target).
 *
 * The concept half: every `need_id` that `proposal_need` / `need_disposition`
 * name is a `need_share` id (spec §7 "can never name an unshared need").
 *
 * Requires: npx tsx src/testing/golden/cli.ts build NEEDS_CONFIRMED
 * Record:   GOLDEN_UPDATE=needs-hidden-until-shared npx jest needs-hidden-until-shared.golden
 *           GOLDEN_UPDATE=needs-hidden-until-shared.concept npx jest needs-hidden-until-shared.golden
 */

import {
  NEEDS_HIDDEN_UNTIL_SHARED_ALLOW,
  NEEDS_HIDDEN_UNTIL_SHARED_BYTE_TARGET_ALLOW,
  NEEDS_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS,
  NEEDS_SHARE_WRITES_NO_NEED_SHARE,
  NEEDS_STAGE4_READ_STEPS,
  NEEDS_STEPS,
} from '../allow-lists/needs-hidden-until-shared';
import { viewName } from '../concept-views';
import { listTables, withClient } from '../db';
import type { ActorRef, Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { NEEDS_CONFIRMED_TEXT } from '../../fixture-scenarios/scenarios';
import { findLeaks, fullRead, unexpectedLeakReport } from '../privacy';
import { goldenScenarioChecks, targetFixtureDeltaChecks } from '../scenario-checks';
import { isTargetShape } from '../shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'needs-hidden-until-shared';
const TARGET = isTargetShape();
// The tables each read snapshots, by shape (TS-11: the 1:1 renames — User →
// user, Message → message, UserVessel → conversation_read_state,
// StageProgress → participant_milestone, IdentifiedNeed → need,
// ConsentRecord → consent).
const READ_TABLES = TARGET
  ? ['user', 'message', 'conversation_read_state', 'participant_milestone', 'need', 'consent']
  : ['User', 'Message', 'UserVessel', 'StageProgress', 'IdentifiedNeed', 'ConsentRecord'];
const NEED_READS = ['session', 'state', 'progress', 'messages', 'needs', 'needs comparison', 'stage4', 'strategies',
  'pending consent', 'consent history', 'session list'];

const probesOf = (who: 'ada' | 'bob'): Record<string, string> =>
  Object.fromEntries(
    NEEDS_CONFIRMED_TEXT[who].flatMap((n, i) => [
      [`${who} need ${i + 1} label`, n.need],
      ...(n.evidence ?? []).map((e, j) => [`${who} need ${i + 1} evidence ${j + 1}`, e] as const),
    ]),
  );

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  const phase: Record<string, StepResult[]> = {};
  const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(text, params)).rows, harness.fixture.database);

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'NEEDS_CONFIRMED',
      runId: `${SCENARIO}_${process.pid}`,
      concept: true,
    });
    const { userA: ada, userB: bob } = harness.actors;
    if (!bob) throw new Error('NEEDS_CONFIRMED must seed two users');
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const sid = harness.sessionId;
    steps = [];

    let needIdsOf: (actor: ActorRef) => string[];
    if (TARGET) {
      const snap = await harness.snapshot(['need', 'participant']);
      needIdsOf = actor => {
        const p = snap.tables.participant.find(r => r.user_id === actor.id)!.id;
        return snap.tables.need.filter(n => n.participant_id === p).map(n => String(n.id));
      };
    } else {
      const snap = await harness.snapshot(['IdentifiedNeed', 'UserVessel']);
      needIdsOf = actor => {
        const vessel = snap.tables.UserVessel.find(v => v.userId === actor.id)!.id;
        return snap.tables.IdentifiedNeed.filter(n => n.vesselId === vessel).map(n => String(n.id));
      };
    }
    const read = async (label: string, actor: ActorRef): Promise<StepResult[]> => {
      const r = await fullRead(harness, actor, label, { tables: READ_TABLES, set: 'all', only: NEED_READS });
      steps.push(...r);
      return r;
    };
    const share = async (actor: ActorRef): Promise<void> => {
      steps.push(
        await harness.step({
          label: `share needs as ${actor.email}`,
          actor,
          tables: scope,
          call: agent => agent.post(`/api/v1/sessions/${sid}/needs/consent`).send({ needIds: needIdsOf(actor) }),
        }),
      );
    };

    phase.none = await read('nothing shared', ada);
    await share(bob);
    phase.bobShared = await read('bob shared', ada);
    await share(ada);
    phase.bothAda = await read('both shared', ada);
    phase.bothBob = await read('both shared', bob);
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: NEEDS_HIDDEN_UNTIL_SHARED_ALLOW,
    byteTargetAllowList: NEEDS_HIDDEN_UNTIL_SHARED_BYTE_TARGET_ALLOW,
    harness: () => harness,
    steps: () => steps,
  });
  targetFixtureDeltaChecks({ harness: () => harness, steps: () => steps });

  it('both shares succeeded (the shared phase is real)', () => {
    expect(steps.filter(s => s.label.startsWith('share needs as')).map(s => s.status)).toEqual([200, 200]);
  });

  it('the probes are live: each partner reads their own needs', () => {
    expect(findLeaks(phase.none, probesOf('ada')).length).toBeGreaterThan(0);
  });

  it('a partner’s need label and evidence never reach the other partner (known leaks aside)', () => {
    const observed = [
      ...findLeaks([...phase.none, ...phase.bobShared, ...phase.bothAda], probesOf('bob')),
      ...findLeaks(phase.bothBob, probesOf('ada')),
    ];
    expect(unexpectedLeakReport(observed, NEEDS_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });

  if (!TARGET) {
    // A documented failure of the current shape, not of the scenario: on the
    // target it is inverted (below).
    it(`KNOWN FINDING — ${NEEDS_SHARE_WRITES_NO_NEED_SHARE}`, () => {
      const last = steps[steps.length - 1].concept!.after!.tables;
      const needConsents = last[viewName('consent')].filter(r => r.target_kind === 'NEED' && r.decision === 'GRANTED');
      expect(needConsents).toHaveLength(4);
      expect(last[viewName('need_share')]).toEqual([]);
    });

    // TAUTOLOGICAL ON THE CURRENT SHAPE (fix round 1, I4): the current-shape
    // views join old_concept_need_share, so they can only name need_share ids.
    it('proposal_need and need_disposition are empty on the current shape (the junction check is targetOnly)', () => {
      const last = steps[steps.length - 1].concept!.after!.tables;
      expect(last[viewName('proposal_need')]).toEqual([]);
      expect(last[viewName('need_disposition')]).toEqual([]);
    });
  } else {
    // targetOnly #1 (F2 inverted): the shares write need_share — four rows,
    // one per need, each with its owner's GRANTED NEED consent; every need id
    // proposal_need / need_disposition name is one of them.
    it('target: after both shares need_share holds the four shared needs; junctions name only need_share ids', () => {
      const last = steps[steps.length - 1].concept!.after!.tables;
      const shares = last[viewName('need_share')];
      expect(shares).toHaveLength(4);
      const needConsents = last[viewName('consent')].filter(r => r.target_kind === 'NEED' && r.decision === 'GRANTED');
      expect(needConsents).toHaveLength(4);
      const shareIds = new Set(shares.map(r => r.need_id));
      for (const r of [...last[viewName('proposal_need')], ...last[viewName('need_disposition')]]) {
        expect(shareIds.has(r.need_id)).toBe(true);
      }
    });

    // targetOnly #2: each partner reads the other's needs as shared_text with
    // its category; the comparison never carries need.label or evidence.
    it('target: each partner reads the other’s needs as need_share.shared_text with its category', async () => {
      const shares = await sql<{ need_id: string; email: string; shared_text: string; category: string }>(
        `SELECT s.need_id, u.email, s.shared_text, s.category::text AS category
         FROM need_share s JOIN participant p ON p.id = s.participant_id JOIN "user" u ON u.id = p.user_id`,
      );
      const comparison = (who: string) =>
        (phase[who === 'ada' ? 'bothAda' : 'bothBob'].find(s => s.label.includes(': needs comparison as'))!.body as {
          data: { partnerNeeds: Array<{ id: string; category: string; need: string }> };
        }).data.partnerNeeds;
      for (const [reader, owner] of [
        ['ada', 'bob@e2e.test'],
        ['bob', 'ada@e2e.test'],
      ] as const) {
        const expected = shares
          .filter(s => s.email === owner)
          .map(s => ({ id: s.need_id, category: s.category, need: s.shared_text }))
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        const got = comparison(reader).map(n => ({ id: n.id, category: n.category, need: n.need })).sort((a, b) => (a.id < b.id ? -1 : 1));
        expect(got).toEqual(expected);
        for (const probe of Object.values(probesOf(reader === 'ada' ? 'bob' : 'ada'))) {
          expect(JSON.stringify(comparison(reader))).not.toContain(probe);
        }
      }
    });

    // TS-11 post-merge: the pairs of the allow-list's fixture deltas and R33.
    describe('fixture deltas and R33 (allow-list pairs)', () => {
      const body = (n: number) => (steps[n].body as { data: Record<string, any> }).data;
      const milestones = async () =>
        sql<{ email: string; key: string; at: Date }>(
          `SELECT u.email, pm.milestone_key AS key, pm.reached_at AS at FROM participant_milestone pm
           JOIN participant p ON p.id = pm.participant_id JOIN "user" u ON u.id = p.user_id`,
        );
      const iso = (d: Date | undefined) => (d ? new Date(d).toISOString() : undefined);

      it('the step layout the allow-list names', () => {
        expect(steps[NEEDS_STEPS.bobShares].label).toBe('share needs as bob@e2e.test');
        expect(steps[NEEDS_STEPS.adaShares].label).toBe('share needs as ada@e2e.test');
        for (const [k, n] of Object.entries(NEEDS_STEPS.state)) expect([k, steps[n].label]).toEqual([k, expect.stringMatching(/: state as /)]);
        for (const [k, n] of Object.entries(NEEDS_STEPS.progress)) expect([k, steps[n].label]).toEqual([k, expect.stringMatching(/: progress as /)]);
        for (const n of Object.values(NEEDS_STEPS.consentHistory)) expect(steps[n].label).toMatch(/: consent history as /);
        for (const n of Object.values(NEEDS_STEPS.sessionList)) expect(steps[n].label).toMatch(/: session list as ada@e2e.test$/);
        for (const n of Object.values(NEEDS_STAGE4_READ_STEPS)) expect(steps[n].label).toMatch(/: stage4 as /);
      });

      it("feelHeardConfirmedAt is the reader's feel_heard instant; the needs gate is needsConfirmed at needs_confirmed", async () => {
        const ms = await milestones();
        const at = (email: string, key: string) => iso(ms.find(m => m.email === email && m.key === key)?.at);
        for (const n of [NEEDS_STEPS.state.none, NEEDS_STEPS.state.bobShared]) {
          const d = body(n);
          expect(d.progress.milestones.feelHeardConfirmedAt).toBe(at('ada@e2e.test', 'feel_heard'));
          expect(d.progress.myProgress.gatesSatisfied).toEqual({
            needsConfirmed: true,
            needsConfirmedAt: at('ada@e2e.test', 'needs_confirmed'),
          });
        }
        for (const n of [NEEDS_STEPS.progress.none, NEEDS_STEPS.progress.bobShared]) {
          const d = body(n);
          expect(d.milestones.feelHeardConfirmedAt).toBe(at('ada@e2e.test', 'feel_heard'));
          expect(d.myProgress.gatesSatisfied).toEqual({ needsConfirmed: true, needsConfirmedAt: at('ada@e2e.test', 'needs_confirmed') });
          expect(d.partnerProgress.gatesSatisfied).toEqual({ needsConfirmed: true, needsConfirmedAt: at('bob@e2e.test', 'needs_confirmed') });
        }
        for (const n of [NEEDS_STEPS.state.bothBob, NEEDS_STEPS.progress.bothBob]) {
          const d = body(n);
          expect((d.progress ?? d).milestones.feelHeardConfirmedAt).toBe(at('bob@e2e.test', 'feel_heard'));
        }
      });

      it('after both shares the stage-4 gates are derived and empty', () => {
        expect(body(NEEDS_STEPS.state.bothAda).progress.myProgress.gatesSatisfied).toEqual({});
        expect(body(NEEDS_STEPS.state.bothBob).progress.myProgress.gatesSatisfied).toEqual({});
        for (const n of [NEEDS_STEPS.progress.bothAda, NEEDS_STEPS.progress.bothBob]) {
          expect(body(n).myProgress.gatesSatisfied).toEqual({});
          expect(body(n).partnerProgress.gatesSatisfied).toEqual({});
        }
      });

      it('R33: Bob is still IN_PROGRESS in stage 3 after his share; both reach needs_shared at one instant at Ada’s', async () => {
        expect(body(NEEDS_STEPS.state.bobShared).progress.partnerProgress.status).toBe('IN_PROGRESS');
        expect(body(NEEDS_STEPS.progress.bobShared).partnerProgress).toMatchObject({ stage: 3, status: 'IN_PROGRESS' });
        expect(body(NEEDS_STEPS.sessionList.bobShared).items[0].partnerProgress.status).toBe('IN_PROGRESS');
        // The two values the list derives from that status (r33NeedsSharedForAll's other mayDiffer paths).
        expect(body(NEEDS_STEPS.sessionList.bobShared).items[0].statusSummary.partnerStatus).toBe('Bob Ross is exploring what matters to them');
        expect(body(NEEDS_STEPS.sessionList.bobShared).items[0].partnerActionNeeded).toEqual(['complete_stage']);
        const shared = (await milestones()).filter(m => m.key === 'needs_shared');
        expect(shared.map(m => m.email).sort()).toEqual(['ada@e2e.test', 'bob@e2e.test']);
        expect(new Set(shared.map(m => iso(m.at))).size).toBe(1);
        const [adaShare] = await sql<{ at: Date }>(
          `SELECT min(c.decided_at) AS at FROM consent c JOIN participant p ON p.id = c.participant_id
           JOIN "user" u ON u.id = p.user_id WHERE u.email = 'ada@e2e.test' AND c.need_id IS NOT NULL`,
        );
        expect(new Date(shared[0].at).getTime()).toBeGreaterThanOrEqual(new Date(adaShare.at).getTime());
      });

      it('the session list says unread only for a message after last_viewed_at not sent by the reader (none yet)', async () => {
        for (const n of Object.values(NEEDS_STEPS.sessionList)) expect(body(n).items[0].hasUnread).toBe(false);
        const [row] = await sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM message m JOIN conversation c ON c.id = m.conversation_id
           JOIN participant p ON p.id = c.participant_id JOIN "user" u ON u.id = p.user_id
           WHERE u.email = 'ada@e2e.test' AND m.sender_participant_id IS DISTINCT FROM p.id
             AND m.created_at < (SELECT min(c2.created_at) FROM consent c2 WHERE c2.participant_id = p.id AND c2.need_id IS NOT NULL)`,
        );
        expect(row.n).toBe('0');
      });

      it("the fixture's VALIDATED attempts are revealed at their submission (revealedAtFor)", async () => {
        const rows = await sql<{ s: Date; r: Date | null }>(`SELECT submitted_at AS s, revealed_at AS r FROM empathy_attempt`);
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(iso(r.r ?? undefined)).toBe(iso(r.s));
      });

      it("R29 step 20: Bob has shared, Ada has not — her walkthrough opens on Bob's shared needs", async () => {
        const d = body(NEEDS_STAGE4_READ_STEPS.bobShared);
        const shares = await sql<{ need_id: string; shared_text: string }>(
          `SELECT s.need_id, s.shared_text FROM need_share s JOIN participant p ON p.id = s.participant_id
           JOIN "user" u ON u.id = p.user_id WHERE u.email = 'bob@e2e.test' ORDER BY s.need_id`,
        );
        expect(d.walkthrough.phase).toBe('PARTNER_NEEDS');
        expect(d.walkthrough.ownNeeds).toEqual([]);
        expect(d.walkthrough.partnerNeeds.map((n: { id: string; label: string }) => ({ id: n.id, label: n.label })).sort((a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1))).toEqual(
          shares.map(s => ({ id: s.need_id, label: s.shared_text })),
        );
        expect(d.walkthrough.currentNeed.id).toBe(d.walkthrough.partnerNeeds[0].id);
      });
    });

    // Ruling R29 (Q3): after both shares the Stage 4 walkthrough lists the
    // four shared needs — the reader's own by their label, the partner's by
    // the shared text.
    it('target: after both shares Ada’s Stage 4 walkthrough lists the four shared needs', async () => {
      const stage4 = phase.bothAda.find(s => s.label.includes(': stage4 as'))!.body as {
        data: { walkthrough: { ownNeeds: Array<{ id: string; label: string }>; partnerNeeds: Array<{ id: string; label: string }> } };
      };
      const shares = await sql<{ need_id: string; email: string; shared_text: string; label: string }>(
        `SELECT s.need_id, u.email, s.shared_text, n.label
         FROM need_share s JOIN need n ON n.id = s.need_id JOIN participant p ON p.id = s.participant_id JOIN "user" u ON u.id = p.user_id`,
      );
      const sortById = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(sortById(stage4.data.walkthrough.ownNeeds.map(n => ({ id: n.id, label: n.label })))).toEqual(
        sortById(shares.filter(s => s.email === 'ada@e2e.test').map(s => ({ id: s.need_id, label: s.label }))),
      );
      expect(sortById(stage4.data.walkthrough.partnerNeeds.map(n => ({ id: n.id, label: n.label })))).toEqual(
        sortById(shares.filter(s => s.email === 'bob@e2e.test').map(s => ({ id: s.need_id, label: s.shared_text }))),
      );
    });
  }
});
