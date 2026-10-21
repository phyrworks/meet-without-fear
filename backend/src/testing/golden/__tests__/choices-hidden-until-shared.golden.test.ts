/**
 * Golden scenario R4 (choices half): a partner's choices stay hidden until
 * they are shared (plan §4 "choices and needs hidden until shared"; spec §7).
 *
 * Fixture STAGE4_REDESIGN_PARTNER_INACTIVE: Stage 4 inventory; Ada has made
 * and shared her choice; Bob has made none. Bob chooses (WILLING on both
 * shared proposals) without sharing, Ada reads, Bob sets aside the one open
 * need his choices do not cover and shares, Ada reads again:
 *
 *   before Bob chooses       Ada reads (baseline)
 *   Bob chose, not shared    Ada reads: no partner selection, no partner decision on any card
 *   Bob shared               Ada reads: Bob's decisions visible
 *
 * Probes are Bob's selection rows' ids: before sharing they must appear in no
 * read of Ada's. The concept half: every need id `proposal_need` and
 * `need_disposition` name is a `need_share` id.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_PARTNER_INACTIVE
 * Record:   GOLDEN_UPDATE=choices-hidden-until-shared npx jest choices-hidden-until-shared.golden
 *           GOLDEN_UPDATE=choices-hidden-until-shared.concept npx jest choices-hidden-until-shared.golden
 */

import {
  CHOICES_HIDDEN_UNTIL_SHARED_ALLOW,
  CHOICES_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS,
} from '../allow-lists/choices-hidden-until-shared';
import { viewName } from '../concept-views';
import { listTables } from '../db';
import type { ActorRef, Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { findLeaks, fullRead, unexpectedLeakReport } from '../privacy';
import { goldenScenarioChecks } from '../scenario-checks';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'choices-hidden-until-shared';
const READ_TABLES = ['User', 'Message', 'UserVessel', 'StageProgress', 'Stage4ProposalSelection', 'Stage4NeedDeclination'];
// Not 'strategies': GET /strategies shuffles its list on every call
// (controllers/stage4.ts shuffleArray — the anonymous legacy pool), so with
// more than one proposal it cannot be a recorded baseline (measured: two
// orders in three runs). It carries no choices.
const CHOICE_READS = ['session', 'state', 'progress', 'messages', 'stage4', 'agreements', 'pending actions',
  'session list', 'badge count'];

type Stage4 = { data?: { partnerSelections?: unknown[]; partnerSelectionStatus?: string } };

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  const phase: Record<string, StepResult[]> = {};
  let bobSelectionIds: string[] = [];
  let aliases: Array<{ id: string; sameAs: string }> = [];

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'STAGE4_REDESIGN_PARTNER_INACTIVE',
      runId: `${SCENARIO}_${process.pid}`,
      concept: true,
    });
    const { userA: ada, userB: bob } = harness.actors;
    if (!bob) throw new Error('STAGE4_REDESIGN_PARTNER_INACTIVE must seed two users');
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const sid = harness.sessionId;
    steps = [];

    const fixtureRows = await harness.snapshot(['StrategyProposal', 'Stage4NeedCoverage', 'IdentifiedNeed', 'UserVessel']);
    // A coverage row with no needId stands for the need it covers (the DTOs
    // name the need by the row's id): the owner's need with that label.
    aliases = fixtureRows.tables.Stage4NeedCoverage.flatMap(c => {
      const vessel = fixtureRows.tables.UserVessel.find(v => v.userId === c.sourceUserId);
      const need = fixtureRows.tables.IdentifiedNeed.find(n => n.vesselId === vessel?.id && n.need === c.needLabel);
      return need && !c.needId ? [{ id: String(c.id), sameAs: String(need.id) }] : [];
    });
    const proposal = (prefix: string) =>
      String(fixtureRows.tables.StrategyProposal.find(p => String(p.description).startsWith(prefix))!.id);
    const read = async (label: string, actor: ActorRef): Promise<StepResult[]> => {
      const r = await fullRead(harness, actor, label, { tables: READ_TABLES, set: 'all', only: CHOICE_READS });
      steps.push(...r);
      return r;
    };
    const post = async (label: string, actor: ActorRef, path: string, body: object): Promise<StepResult> => {
      const s = await harness.step({
        label,
        actor,
        tables: scope,
        call: agent => agent.post(`/api/v1/sessions/${sid}${path}`).send(body),
      });
      steps.push(s);
      return s;
    };

    phase.before = await read('before bob chooses', ada);
    for (const [name, prefix] of [
      ['pause', 'Use a pause phrase'],
      ['checkin', 'Try a Sunday'],
    ] as const) {
      await post(`choose ${name} as bob`, bob, `/stage4/proposals/${proposal(prefix)}/selection`, { decision: 'WILLING' });
    }
    bobSelectionIds = (await harness.snapshot(['Stage4ProposalSelection'])).tables.Stage4ProposalSelection.filter(
      s => s.userId === bob.id,
    ).map(s => String(s.id));
    phase.unshared = await read('bob chose, not shared', ada);
    // Ada's "Appreciation" is the open need no shared proposal covers: Bob must
    // set it aside before the share gate lets him through.
    const open = fixtureRows.tables.Stage4NeedCoverage.find(c => c.needLabel === 'Appreciation')!;
    await post('set aside open need as bob', bob, `/stage4/needs/${String(open.needId ?? open.id)}/decline`, {});
    await post('share selections as bob', bob, '/stage4/share-selections', {});
    phase.shared = await read('bob shared', ada);
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: CHOICES_HIDDEN_UNTIL_SHARED_ALLOW,
    harness: () => harness,
    steps: () => steps,
    conceptAliases: () => aliases,
  });

  const stage4Of = (p: string) => phase[p].find(s => s.label.includes(': stage4 as'))!.body as Stage4;

  it('every write succeeded and Bob holds two unshared choices before sharing', () => {
    expect(steps.filter(s => !s.label.includes(' as ada@')).map(s => [s.label, s.status])).toEqual([
      ['choose pause as bob', 200],
      ['choose checkin as bob', 200],
      ['set aside open need as bob', 200],
      ['share selections as bob', 200],
    ]);
    expect(bobSelectionIds).toHaveLength(2);
  });

  it("before Bob shares, none of Ada's reads carries his choices (known leaks aside)", () => {
    expect(stage4Of('unshared').data?.partnerSelections).toEqual([]);
    expect(JSON.stringify(stage4Of('unshared'))).not.toContain('"partnerDecisionVisible":"WILLING"');
    const probes = Object.fromEntries(bobSelectionIds.map((id, i) => [`bob selection ${i + 1}`, id]));
    const observed = findLeaks([...phase.before, ...phase.unshared], probes);
    expect(unexpectedLeakReport(observed, CHOICES_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });

  it('after Bob shares, Ada reads his decisions', () => {
    expect(stage4Of('shared').data?.partnerSelectionStatus).toBe('SUBMITTED');
    expect(stage4Of('shared').data?.partnerSelections).toHaveLength(2);
  });

  it('proposal_need and need_disposition name only need_share ids', () => {
    const last = steps[steps.length - 1].concept!.after!.tables;
    const shared = new Set(last[viewName('need_share')].map(r => String(r.need_id)));
    const named = [...last[viewName('proposal_need')], ...last[viewName('need_disposition')]].map(r => String(r.need_id));
    expect(named.filter(id => !shared.has(id))).toEqual([]);
  });
});
