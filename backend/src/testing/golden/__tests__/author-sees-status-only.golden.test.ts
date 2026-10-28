/**
 * Golden scenario R6: the author sees status only (plan §4, adversarial
 * P1-15; spec §7 "the gap analysis only as its subject").
 *
 * Fixture RECONCILER_SHOWN_B: the reconciler analysed Ada's attempt about Bob,
 * found significant gaps and offered Bob a share. Ada is the AUTHOR: her full
 * read and the prompt built for her next turn may show the direction's status
 * (`v_empathy_direction_status`) and the guidance (`reconciler_guidance`) and
 * nothing else — no `reconciler_result` detail (alignment, gaps, missed
 * feelings, rationale, suggested share), no `context_share_offer` text, and no
 * unsent `empathy_review.feedback`. Bob first saves an unsent
 * validation-feedback draft about her attempt, so that last probe is live.
 *
 * Ada also calls `POST /reconciler/run`, a client endpoint that returns the
 * analysis in its body: an author can reach it, so it is part of what she can
 * read.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build RECONCILER_SHOWN_B
 * Record:   GOLDEN_UPDATE=author-sees-status-only npx jest author-sees-status-only.golden
 *           GOLDEN_UPDATE=author-sees-status-only.concept npx jest author-sees-status-only.golden
 */

import {
  AUTHOR_SEES_STATUS_ONLY_ALLOW,
  AUTHOR_SEES_STATUS_ONLY_BYTE_TARGET_ALLOW,
  AUTHOR_SEES_STATUS_ONLY_KNOWN_LEAKS,
} from '../allow-lists/author-sees-status-only';
import { listTables } from '../db';
import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { scenarioFor } from '../../fixture-scenarios/scenarios';
import { TargetStage } from '../../fixture-scenarios/target-stage';
import {
  CapturedCall,
  capturePrompts,
  findLeaks,
  findPromptLeaks,
  fullRead,
  shapeTables,
  unexpectedLeakReport,
} from '../privacy';
import {
  authorClosureChecks,
  goldenScenarioChecks,
  mockIndexChecks,
  targetFixtureDeltaChecks,
  targetMessageStageChecks,
} from '../scenario-checks';
import { isTargetShape } from '../shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'author-sees-status-only';
const UNSENT_FEEDBACK = 'You missed how lonely the evenings are once the dishes are done.';
const ADA_TURN = 'I am still waiting. Is there anything I should be thinking about?';
const READ_TABLES = shapeTables([
  'User',
  'Message',
  'UserVessel',
  'EmpathyAttempt',
  'ReconcilerResult',
  'ReconcilerShareOffer',
]);

const fixture = scenarioFor(TargetStage.RECONCILER_SHOWN_B, { a: 'Ada Lovelace', b: 'Bob Ross' });
const result = fixture.reconciliation!.result;
const offer = fixture.reconciliation!.shareOffer;

/** Everything the author must not read. */
export const PROBES: Record<string, string> = {
  'result.alignmentSummary': result.alignmentSummary,
  'result.gapSummary': result.gapSummary,
  'result.mostImportantGap': result.mostImportantGap,
  'result.missedFeelings': JSON.stringify(result.missedFeelings),
  'result.rationale': result.rationale,
  'result.suggestedShareFocus': result.suggestedShareFocus,
  'result.suggestedShareReason': result.suggestedShareReason,
  'offer.suggestedContent': offer.suggestedContent,
  'unsent feedback': UNSENT_FEEDBACK,
  // Fix round 1 (I5): the offer's EXISTENCE, not only its text. The direction's
  // status (AWAITING_SHARING) is what v_empathy_direction_status shows by
  // design; anything beyond it that says "an offer was made" is a trace.
  'offer exists: pending offer count': '"pendingShareOffers":1',
  'offer exists: recommended action': '"action":"OFFER_SHARING"',
  'offer exists: sharing would help': '"sharingWouldHelp":true',
};

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  let adaSteps: StepResult[];
  let calls: CapturedCall[];
  const TURN = 'chat turn as ada@e2e.test';

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
    const prompts = await capturePrompts();
    calls = prompts.calls;

    const draft = await harness.step({
      label: 'unsent feedback draft as bob',
      actor: bob,
      tables: scope,
      call: agent =>
        agent
          .post(`/api/v1/sessions/${sid}/empathy/validation-feedback/draft`)
          .send({ content: UNSENT_FEEDBACK, readyToShare: false }),
    });
    const reads = await prompts.during('ada reads', () =>
      fullRead(harness, ada, 'author', { tables: READ_TABLES, set: 'all' }),
    );
    const run = await prompts.during('ada reads', () =>
      harness.step({
        label: 'reconciler run as ada@e2e.test',
        actor: ada,
        tables: scope,
        call: agent => agent.post(`/api/v1/sessions/${sid}/reconciler/run`).send({}),
      }),
    );
    const turn = await prompts.during(TURN, () =>
      harness.step({
        label: TURN,
        actor: ada,
        tables: scope,
        sse: true,
        asyncBoundary: true,
        call: agent => agent.post(`/api/v1/sessions/${sid}/messages/stream`).send({ content: ADA_TURN }),
      }),
    );
    adaSteps = [...reads, run, turn];
    steps = [draft, ...adaSteps];
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: AUTHOR_SEES_STATUS_ONLY_ALLOW,
    byteTargetAllowList: AUTHOR_SEES_STATUS_ONLY_BYTE_TARGET_ALLOW,
    harness: () => harness,
    steps: () => steps,
  });
  targetMessageStageChecks({ harness: () => harness, steps: () => steps });
  targetFixtureDeltaChecks({ harness: () => harness, steps: () => steps });
  authorClosureChecks({ steps: () => steps, empathyStatus: [8], reconcilerStatus: [12], summary: [14] });
  mockIndexChecks({ harness: () => harness, steps: () => steps, step: 33, email: 'ada@e2e.test' });
  (isTargetShape() ? it : it.skip)(
    'closure pair: reconciler/run returns Ada only the direction she is the subject of',
    () => {
      const run = (steps[32].body as { data: { aUnderstandingB: unknown; bUnderstandingA: unknown } }).data;
      expect(steps[32].label).toBe('reconciler run as ada@e2e.test');
      expect(run.aUnderstandingB).toBeNull();
      expect(run.bUnderstandingA).not.toBeNull();
    },
  );

  it("the probes are live: Bob's unsent draft and the analysis exist", () => {
    if (isTargetShape()) {
      // Fix round 1, m1 (R6_REFUSED_UNREVEALED_DRAFT): the target refuses a
      // feedback draft about an unrevealed round, and writes nothing.
      expect(steps[0].status).toBe(404);
      expect(steps[0].changes.some(c => c.table === 'draft')).toBe(false);
    } else {
      expect(steps[0].status).toBe(200);
      expect(steps[0].changes.some(c => c.table === 'ValidationFeedbackDraft' && c.kind === 'added')).toBe(true);
    }
  });

  it("Ada's turn built a prompt (the prompt assertion is not vacuous)", () => {
    expect(calls.filter(c => c.step === TURN && c.fn === 'getSonnetStreamingResponse')).toHaveLength(1);
  });

  it('the author reads her direction’s status', () => {
    const status = adaSteps.find(s => s.label === 'author: empathy status as ada@e2e.test');
    expect((status?.body as { data?: { myAttempt?: { status?: string } } })?.data?.myAttempt?.status).toBe(
      'AWAITING_SHARING',
    );
  });

  it('no reconciler detail, offer text or unsent feedback in the author’s reads or prompts (known leaks aside)', () => {
    const observed = [...findLeaks(adaSteps, PROBES), ...findPromptLeaks(calls, PROBES)];
    expect(unexpectedLeakReport(observed, AUTHOR_SEES_STATUS_ONLY_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });
});
