/**
 * Golden scenario R3, order 2: Bob's direction is READY first; Ada's second
 * fires the reveal (plan §4 "N=2 reveal fires on all-ready").
 *
 * Fixture RECONCILER_SHOWN_B: Ada's attempt is AWAITING_SHARING (gaps found,
 * share offered to Bob); Bob's attempt is HELD. Bob→Ada's reconciler runs
 * first through the E2E hook (the `runReconcilerForDirection` that
 * `confirmFeelHeard` runs; Ada's feel-heard is already in the fixture) and
 * marks Bob READY while Ada still awaits sharing. Both read. Then Bob declines
 * the share offer: Ada's attempt becomes READY and the decline path's
 * `checkAndRevealBothIfReady` fires the reveal. Both read again.
 *
 * Mirror of `reveal-all-ready-ada-first`; together they are R3's "either
 * order".
 *
 * Requires: npx tsx src/testing/golden/cli.ts build RECONCILER_SHOWN_B
 * Record:   GOLDEN_UPDATE=reveal-all-ready-bob-first npx jest reveal-all-ready-bob-first.golden
 *           GOLDEN_UPDATE=reveal-all-ready-bob-first.concept npx jest reveal-all-ready-bob-first.golden
 */

import { REVEAL_BOB_FIRST_ALLOW, REVEAL_BOB_FIRST_STEP } from '../allow-lists/reveal-all-ready';
import { listTables } from '../db';
import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { EMPATHY_READS, fullRead } from '../privacy';
import { revealChecks } from '../reveal-checks';
import { goldenScenarioChecks } from '../scenario-checks';
import type { SnapshotRow } from '../snapshot';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'reveal-all-ready-bob-first';
const READ_TABLES = ['User', 'Message', 'UserVessel', 'EmpathyAttempt', 'ReconcilerResult', 'ReconcilerShareOffer'];

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  let afterFirst: SnapshotRow[];
  const FIRST = 'run bob→ada reconciler (e2e hook)';

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
    const write = (label: string, actor: typeof ada, path: string, body: object) =>
      harness.step({
        label,
        actor,
        tables: scope,
        asyncBoundary: true,
        call: agent => agent.post(`/api/v1${path}`).send(body),
      });
    const reads = async (phase: string) => [
      ...(await fullRead(harness, ada, phase, { tables: READ_TABLES, set: 'all', only: EMPATHY_READS })),
      ...(await fullRead(harness, bob, phase, { tables: READ_TABLES, set: 'all', only: EMPATHY_READS })),
    ];

    steps = [await write(FIRST, bob, '/e2e/trigger-reconciler', { sessionId: sid, guesserId: bob.id, subjectId: ada.id })];
    afterFirst = (await harness.snapshot(['EmpathyAttempt'])).tables.EmpathyAttempt;
    steps.push(...(await reads('bob ready')));
    steps.push(
      await write('decline share as bob', bob, `/sessions/${sid}/reconciler/share-offer/respond`, { action: 'decline' }),
    );
    steps.push(...(await reads('revealed')));
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: REVEAL_BOB_FIRST_ALLOW,
    harness: () => harness,
    steps: () => steps,
  });

  it('the reveal happens at the step the allow-list pins the delivered copies to', () => {
    expect(steps[REVEAL_BOB_FIRST_STEP].label).toBe('decline share as bob');
  });

  revealChecks({
    harness: () => harness,
    steps: () => steps,
    firstReadyStep: FIRST,
    firstReady: 'bob',
    attemptsAfterFirst: () => afterFirst,
  });
});
