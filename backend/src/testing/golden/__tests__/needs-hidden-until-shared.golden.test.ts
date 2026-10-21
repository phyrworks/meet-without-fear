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
 * Probes are the partner's need labels and evidence. In the target the
 * partner sees `need_share.shared_text` instead; on today's shape the shared
 * comparison returns the label itself (a known leak, with findings).
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
  NEEDS_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS,
  NEEDS_SHARE_WRITES_NO_NEED_SHARE,
} from '../allow-lists/needs-hidden-until-shared';
import { viewName } from '../concept-views';
import { listTables } from '../db';
import type { ActorRef, Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { NEEDS_CONFIRMED_TEXT } from '../../fixture-scenarios/scenarios';
import { findLeaks, fullRead, unexpectedLeakReport } from '../privacy';
import { goldenScenarioChecks } from '../scenario-checks';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'needs-hidden-until-shared';
const READ_TABLES = ['User', 'Message', 'UserVessel', 'StageProgress', 'IdentifiedNeed', 'ConsentRecord'];
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

    const snap = await harness.snapshot(['IdentifiedNeed', 'UserVessel']);
    const needIdsOf = (actor: ActorRef): string[] => {
      const vessel = snap.tables.UserVessel.find(v => v.userId === actor.id)!.id;
      return snap.tables.IdentifiedNeed.filter(n => n.vesselId === vessel).map(n => String(n.id));
    };
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
    harness: () => harness,
    steps: () => steps,
  });

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

  // A documented failure of the current shape, not of the scenario: it must
  // flip (and this test be inverted) when the target writes need_share.
  it(`KNOWN FINDING — ${NEEDS_SHARE_WRITES_NO_NEED_SHARE}`, () => {
    const last = steps[steps.length - 1].concept!.after!.tables;
    const needConsents = last[viewName('consent')].filter(r => r.target_kind === 'NEED' && r.decision === 'GRANTED');
    expect(needConsents).toHaveLength(4);
    expect(last[viewName('need_share')]).toEqual([]);
  });

  it('proposal_need and need_disposition name only need_share ids', () => {
    const last = steps[steps.length - 1].concept!.after!.tables;
    const shared = new Set(last[viewName('need_share')].map(r => String(r.need_id)));
    const named = [...last[viewName('proposal_need')], ...last[viewName('need_disposition')]].map(r => String(r.need_id));
    expect(named.filter(id => !shared.has(id))).toEqual([]);
  });
});
