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
  UNREVEALED_ATTEMPT_HIDDEN_KNOWN_LEAKS,
} from '../allow-lists/unrevealed-attempt-hidden';
import { listTables } from '../db';
import type { ActorRef, Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { ADA_EMPATHY_STATEMENT, BOB_HELD_EMPATHY_STATEMENT } from '../../fixture-scenarios/scenarios';
import { EMPATHY_READS, findLeaks, fullRead, unexpectedLeakReport } from '../privacy';
import { goldenScenarioChecks } from '../scenario-checks';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'unrevealed-attempt-hidden';
const ADA_REVISED = 'I see now that you are running on empty and need someone to notice how hard you try.';

const READ_TABLES = ['User', 'Message', 'UserVessel', 'EmpathyAttempt', 'ReconcilerShareOffer', 'ReconcilerResult'];

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  const phases: Record<string, { bob: StepResult[]; ada: StepResult[] }> = {};

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
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: UNREVEALED_ATTEMPT_HIDDEN_ALLOW,
    harness: () => harness,
    steps: () => steps,
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

  it('after the reveal each subject reads the statement about them', () => {
    expect(findLeaks(phases.revealed.bob, { revised: ADA_REVISED }).length).toBeGreaterThan(0);
    expect(findLeaks(phases.revealed.ada, { bob: BOB_HELD_EMPATHY_STATEMENT }).length).toBeGreaterThan(0);
  });
});
