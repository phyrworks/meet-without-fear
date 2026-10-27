/**
 * Golden scenario R3, order 1: Ada's direction is READY first; Bob's second
 * fires the reveal (plan §4 "N=2 reveal fires on all-ready").
 *
 * Fixture FEEL_HEARD_B: Ada's attempt about Bob is HELD and Bob has just felt
 * heard. Ada→Bob's reconciler runs first — through the E2E hook, which calls
 * the `runReconcilerForDirection` that `confirmFeelHeard` runs for a HELD
 * partner attempt (Bob's feel-heard is already in the fixture and cannot be
 * re-confirmed) — and marks Ada READY. Both read. Then Bob drafts and consents:
 * both attempts are shared, the symmetric reconciler marks Bob READY and the
 * reveal fires. Both read again.
 *
 * The order is the point: `empathy-reveal` covers the case where both
 * directions become READY inside one reconciler run. Here they become READY in
 * separate requests, Ada first. `reveal-all-ready-bob-first` is the mirror.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 * Record:   GOLDEN_UPDATE=reveal-all-ready-ada-first npx jest reveal-all-ready-ada-first.golden
 *           GOLDEN_UPDATE=reveal-all-ready-ada-first.concept npx jest reveal-all-ready-ada-first.golden
 */

import { REVEAL_ADA_FIRST_ALLOW, REVEAL_ADA_FIRST_BYTE_TARGET_ALLOW, REVEAL_ADA_FIRST_STEP } from '../allow-lists/reveal-all-ready';
import { listTables } from '../db';
import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { EMPATHY_READS, fullRead, shapeTables } from '../privacy';
import { revealChecks } from '../reveal-checks';
import { goldenScenarioChecks, targetFixtureDeltaChecks, targetMessageStageChecks } from '../scenario-checks';
import { isTargetShape } from '../shape';
import type { SnapshotRow } from '../snapshot';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'reveal-all-ready-ada-first';
const BOB_EMPATHY = 'I think you feel unseen when the chores pile up and nobody says anything.';
const READ_TABLES = shapeTables(['User', 'Message', 'UserVessel', 'EmpathyAttempt', 'ReconcilerResult']);

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  let afterFirst: SnapshotRow[];
  const FIRST = 'run ada→bob reconciler (e2e hook)';

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'FEEL_HEARD_B',
      runId: `${SCENARIO}_${process.pid}`,
      concept: true,
    });
    const { userA: ada, userB: bob } = harness.actors;
    if (!bob) throw new Error('FEEL_HEARD_B must seed two users');
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

    steps = [await write(FIRST, ada, '/e2e/trigger-reconciler', { sessionId: sid, guesserId: ada.id, subjectId: bob.id })];
    const attemptTable = isTargetShape() ? 'empathy_attempt' : 'EmpathyAttempt';
    afterFirst = (await harness.snapshot([attemptTable])).tables[attemptTable];
    steps.push(...(await reads('ada ready')));
    steps.push(await write('draft as bob', bob, `/sessions/${sid}/empathy/draft`, { content: BOB_EMPATHY, readyToShare: true }));
    steps.push(await write('consent as bob', bob, `/sessions/${sid}/empathy/consent`, { consent: true }));
    steps.push(...(await reads('revealed')));
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: REVEAL_ADA_FIRST_ALLOW,
    byteTargetAllowList: REVEAL_ADA_FIRST_BYTE_TARGET_ALLOW,
    harness: () => harness,
    steps: () => steps,
  });

  it('the reveal happens at the step the allow-list pins the delivered copies to', () => {
    expect(steps[REVEAL_ADA_FIRST_STEP].label).toBe('consent as bob');
  });

  revealChecks({
    harness: () => harness,
    steps: () => steps,
    firstReadyStep: FIRST,
    firstReady: 'ada',
    attemptsAfterFirst: () => afterFirst,
    revealStep: 'consent as bob',
  });

  targetMessageStageChecks({ harness: () => harness, steps: () => steps });
  targetFixtureDeltaChecks({ harness: () => harness, steps: () => steps });

  // Ruling R32 pair: the revealed rounds are at status_version 2 (no ANALYZING).
  (isTargetShape() ? it : it.skip)("mayDiffer pair: Ada's partner-empathy read shows Bob's round at status_version 2", () => {
    const step = steps[38];
    expect(step.label).toBe('revealed: partner empathy as ada@e2e.test');
    expect((step.body as { data: { attempt: { statusVersion: number } } }).data.attempt.statusVersion).toBe(2);
  });
});
