/**
 * Golden scenario R2: a co-participant cannot read an unrevealed attempt
 * (plan §4 "New golden scenarios"; spec §7).
 *
 * Fixture RECONCILER_SHOWN_B: Ada's attempt about Bob is AWAITING_SHARING
 * (the reconciler found gaps and offered Bob a share); Bob's attempt about Ada
 * is HELD. The scenario walks Ada's attempt through every non-disclosing
 * status and reads as its subject (Bob) at each:
 *
 *   AWAITING_SHARING  (as restored)          Bob reads; Ada reads (Bob's HELD attempt)
 *   REFINING          Bob accepts the share  Bob reads
 *   READY             Ada resubmits          Bob reads (neither her old nor new text)
 *   REVEALED          Bob's direction runs   Bob and Ada read: each other's statement present
 *
 * The last transition runs Bob→Ada's reconciler through the E2E hook
 * (`POST /e2e/trigger-reconciler`), which calls the same
 * `runReconcilerForDirection` that `confirmFeelHeard` runs when a subject
 * finishes Stage 1: Ada finished it in the fixture, and nothing a client can
 * call re-runs it for a HELD attempt (feel-heard refuses outside stage 1).
 *
 * "Shows the status with no content": at every unrevealed phase Bob's
 * `partner empathy` read names the status and carries no attempt.
 * "Still present after the next round supersedes it" is target-only (the
 * current shape has no rounds) — see the allow-list's `targetOnly`.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build RECONCILER_SHOWN_B
 * Record:   GOLDEN_UPDATE=unrevealed-attempt-hidden npx jest unrevealed-attempt-hidden.golden
 *           GOLDEN_UPDATE=unrevealed-attempt-hidden.concept npx jest unrevealed-attempt-hidden.golden
 */

import {
  UNREVEALED_ATTEMPT_HIDDEN_ALLOW,
  UNREVEALED_ATTEMPT_HIDDEN_BYTE_TARGET_ALLOW,
  UNREVEALED_ATTEMPT_HIDDEN_KNOWN_LEAKS,
  ADA_ORIGINAL,
  ADA_REVISED,
  R2_RESUBMIT_STEP,
  R2_REVEAL_STEP,
} from '../allow-lists/unrevealed-attempt-hidden';
import { listTables } from '../db';
import type { ActorRef, Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { ADA_EMPATHY_STATEMENT, BOB_HELD_EMPATHY_STATEMENT } from '../../fixture-scenarios/scenarios';
import { EMPATHY_READS, findLeaks, fullRead, shapeTables, unexpectedLeakReport } from '../privacy';
import {
  authorClosureChecks,
  goldenScenarioChecks,
  roundAndNotificationChecks,
  targetFixtureDeltaChecks,
  targetMessageStageChecks,
} from '../scenario-checks';
import { isTargetShape } from '../shape';
import { withClient } from '../db';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'unrevealed-attempt-hidden';

const READ_TABLES = shapeTables(['User', 'Message', 'UserVessel', 'EmpathyAttempt', 'ReconcilerShareOffer', 'ReconcilerResult']);
/** Ada's round 3 (target only): resubmitted after Bob's feedback on the revealed round 2. */
const ADA_ROUND_THREE = 'TS10_ROUND_THREE: what I missed is the evenings — you carry them alone.';

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  const phases: Record<string, { bob: StepResult[]; ada: StepResult[] }> = {};
  const roundThree: { feedback?: StepResult; resubmit?: StepResult; bob: StepResult[] } = { bob: [] };

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `${SCENARIO}_${process.pid}`,
      concept: true,
    });
    const { userA: ada, userB: bob } = harness.actors;
    if (!bob) throw new Error('RECONCILER_SHOWN_B must seed two users');
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const sid = harness.sessionId;
    steps = [];

    const read = async (phase: string, actor: ActorRef): Promise<StepResult[]> => {
      const r = await fullRead(harness, actor, phase, { tables: READ_TABLES, set: 'all', only: EMPATHY_READS });
      steps.push(...r);
      return r;
    };
    const write = async (label: string, actor: ActorRef, path: string, body: object): Promise<StepResult> => {
      const s = await harness.step({
        label,
        actor,
        tables: scope,
        // Every Stage 2 write here publishes and re-checks the reveal after the
        // transaction it responds from.
        asyncBoundary: true,
        call: agent => agent.post(`/api/v1${path}`).send(body),
      });
      steps.push(s);
      return s;
    };

    phases.awaiting = { bob: await read('awaiting sharing', bob), ada: await read('awaiting sharing', ada) };
    await write('accept share as bob', bob, `/sessions/${sid}/reconciler/share-offer/respond`, { action: 'accept' });
    phases.refining = { bob: await read('refining', bob), ada: [] };
    await write('resubmit as ada', ada, `/sessions/${sid}/empathy/resubmit`, { content: ADA_REVISED });
    phases.ready = { bob: await read('ready', bob), ada: [] };
    await write('run bob→ada reconciler (e2e hook)', bob, '/e2e/trigger-reconciler', {
      sessionId: sid,
      guesserId: bob.id,
      subjectId: ada.id,
    });
    phases.revealed = { bob: await read('revealed', bob), ada: await read('revealed', ada) };

    // TARGET ONLY (allow-list targetOnly): round 3 supersedes the revealed
    // round 2. Bob sends feedback on round 2 (REVEALED → REFINING), Ada
    // resubmits. These steps are not part of the recorded baseline (the
    // current shape has no rounds), so they are kept apart from `steps`.
    if (isTargetShape()) {
      const extra = async (label: string, actor: ActorRef, path: string, body: object) =>
        harness.step({ label, actor, tables: scope, asyncBoundary: true, call: agent => agent.post(`/api/v1${path}`).send(body) });
      roundThree.feedback = await extra('feedback on round 2 as bob', bob, `/sessions/${sid}/empathy/validate`, {
        validated: false,
        feedback: 'TS10_FEEDBACK: it is the evenings I needed you to see.',
      });
      roundThree.resubmit = await extra('resubmit round 3 as ada', ada, `/sessions/${sid}/empathy/resubmit`, { content: ADA_ROUND_THREE });
      roundThree.bob = await fullRead(harness, bob, 'round three', { tables: READ_TABLES, set: 'all', only: EMPATHY_READS });
    }
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: UNREVEALED_ATTEMPT_HIDDEN_ALLOW,
    byteTargetAllowList: UNREVEALED_ATTEMPT_HIDDEN_BYTE_TARGET_ALLOW,
    harness: () => harness,
    steps: () => steps,
  });
  targetMessageStageChecks({ harness: () => harness, steps: () => steps });
  targetFixtureDeltaChecks({ harness: () => harness, steps: () => steps });
  authorClosureChecks({ steps: () => steps, empathyStatus: [19], reconcilerStatus: [23], summary: [25] });
  roundAndNotificationChecks({
    harness: () => harness,
    steps: () => steps,
    notified: { stampStep: 34, laterReads: [50, 66] },
    instantReads: [51, 67, 68, 82],
  });
  (isTargetShape() ? it : it.skip)("mayDiffer pair: Bob's partner-empathy read after the reveal shows round 2 at status_version 2", () => {
    expect(steps[68].label).toBe('revealed: partner empathy as bob@e2e.test');
    expect((steps[68].body as { data: { attempt: { statusVersion: number; round: number } } }).data.attempt).toMatchObject({
      statusVersion: 2,
      round: 2,
    });
  });

  const targetOnly = isTargetShape() ? it : it.skip;

  // allow-list targetOnly (plan §4 R2 "still present after the author's next round supersedes it").
  targetOnly("after round 3 supersedes the revealed round 2, Bob still reads round 2 and never round 3", async () => {
    expect(roundThree.feedback?.status).toBe(200);
    expect(roundThree.resubmit?.status).toBe(200);
    const rounds = await withClient(
      harness.fixture.target,
      async c =>
        (
          await c.query<{ round: number; status: string; revealed: boolean }>(
            `SELECT a.round, a.status::text AS status, a.revealed_at IS NOT NULL AS revealed FROM empathy_attempt a
             JOIN participant p ON p.id = a.author_participant_id JOIN "user" u ON u.id = p.user_id
             WHERE u.email = 'ada@e2e.test' ORDER BY a.round`,
          )
        ).rows,
      harness.fixture.database,
    );
    expect(rounds.map(r => [r.round, r.status, r.revealed])).toEqual([
      [1, 'SUPERSEDED', false],
      [2, 'SUPERSEDED', true],
      [3, expect.stringMatching(/^(HELD|READY)$/), false],
    ]);
    // Bob reads round 2 (his delivered copy and the revealed row), never round 3.
    expect(findLeaks(roundThree.bob, { revised: ADA_REVISED }).length).toBeGreaterThan(0);
    expect(findLeaks(roundThree.bob, { 'round 3': ADA_ROUND_THREE })).toEqual([]);
    const partner = roundThree.bob.find(s => s.label === 'round three: partner empathy as bob@e2e.test');
    expect((partner?.body as { data: { attempt: { content: string; round: number } } }).data.attempt).toMatchObject({
      content: ADA_REVISED,
      round: 2,
    });
  });

  const adaProbes = { "Ada's statement": ADA_EMPATHY_STATEMENT, "Ada's revised statement": ADA_REVISED };
  const bobProbes = { "Bob's statement": BOB_HELD_EMPATHY_STATEMENT };

  it('an unrevealed attempt is absent from its subject’s reads (known leaks aside)', () => {
    const observed = [
      ...['awaiting', 'refining', 'ready'].flatMap(p => findLeaks(phases[p].bob, adaProbes)),
      ...findLeaks(phases.awaiting.ada, bobProbes),
    ];
    expect(unexpectedLeakReport(observed, UNREVEALED_ATTEMPT_HIDDEN_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });

  it('the subject sees the status of an unrevealed attempt, with no content', () => {
    const partnerView = (p: string) => {
      const s = phases[p].bob.find(x => x.label.startsWith(`${p === 'awaiting' ? 'awaiting sharing' : p}: partner empathy`));
      return (s?.body as { data?: { attempt: unknown; partnerStatus: string } })?.data;
    };
    expect(partnerView('awaiting')).toMatchObject({ attempt: null, partnerStatus: 'AWAITING_SHARING' });
    expect(partnerView('refining')).toMatchObject({ attempt: null, partnerStatus: 'REFINING' });
    expect(partnerView('ready')).toMatchObject({ attempt: null, partnerStatus: 'READY' });
  });

  it('the resubmit and the reveal sit at the step indices the allow-list pins', () => {
    expect(steps[R2_RESUBMIT_STEP].label).toBe('resubmit as ada');
    expect(steps[R2_REVEAL_STEP].label).toBe('run bob→ada reconciler (e2e hook)');
    expect(steps[66].label).toBe('revealed: pending actions as bob@e2e.test');
    expect(steps[67].label).toBe('revealed: empathy status as bob@e2e.test');
    expect(steps[68].label).toBe('revealed: partner empathy as bob@e2e.test');
    expect(steps[82].label).toBe('revealed: empathy status as ada@e2e.test');
  });

  // Fix round 2: the reveal discloses the live round only. Ada's superseded
  // first statement was never revealed and must stay out of Bob's reads.
  it("after the reveal Bob reads Ada's revised statement and never her superseded original", () => {
    expect(findLeaks(phases.revealed.bob, { "Ada's original statement": ADA_ORIGINAL })).toEqual([]);
  });

  it('after the reveal each subject reads the statement about them', () => {
    expect(findLeaks(phases.revealed.bob, { revised: ADA_REVISED }).length).toBeGreaterThan(0);
    expect(findLeaks(phases.revealed.ada, { bob: BOB_HELD_EMPATHY_STATEMENT }).length).toBeGreaterThan(0);
  });
});
