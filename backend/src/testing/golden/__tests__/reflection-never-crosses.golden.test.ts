/**
 * Golden scenario R1: a reflection never crosses to the co-participant
 * (plan §4 "New golden scenarios"; spec §7, D2).
 *
 * Fixture INNER_WORK_LINKED_A: FEEL_HEARD_B plus an Inner Work reflection of
 * Ada's, linked to the session, and prompt captures for her reflection turn
 * and Bob's last session turn. Bob — the co-participant — makes a full read
 * (every session and user GET), takes a chat turn, and reads again. Every
 * string of Ada's reflection is a probe: it must appear in none of Bob's
 * bodies, in no prompt the app builds during Bob's turn, and in no
 * session-scoped `brain_activity.input`. Ada's own read of the same endpoint
 * is the control that the probes are live (her reflection is visible to her).
 *
 * Requires a running local Postgres and a built fixture:
 *   npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 * Record:  GOLDEN_UPDATE=reflection-never-crosses npx jest reflection-never-crosses.golden
 *          GOLDEN_UPDATE=reflection-never-crosses.concept npx jest reflection-never-crosses.golden
 */

import {
  R1_AFTER_DRAFT_STEP,
  R1_AFTER_MESSAGES_STEP,
  R1_AFTER_STATE_STEP,
  R1_TURN_STEP,
  REFLECTION_NEVER_CROSSES_ALLOW,
  REFLECTION_NEVER_CROSSES_BYTE_TARGET_ALLOW,
  REFLECTION_NEVER_CROSSES_KNOWN_LEAKS,
} from '../allow-lists/reflection-never-crosses';
import { viewName } from '../concept-views';
import { listTables } from '../db';
import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { ADA_REFLECTION } from '../../fixture-scenarios/scenarios';
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
  goldenScenarioChecks,
  mockIndexChecks,
  targetFixtureDeltaChecks,
  targetMessageStageChecks,
} from '../scenario-checks';
import { isTargetShape } from '../shape';
import { withClient } from '../db';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'reflection-never-crosses';
const BOB_TURN = 'Some days I think we are just two tired people keeping score.';

/** Every string of Ada's reflection. */
const PROBES: Record<string, string> = {
  'reflection title': ADA_REFLECTION.title,
  'reflection theme': ADA_REFLECTION.theme,
  'reflection summary': ADA_REFLECTION.summary,
  'reflection user line': ADA_REFLECTION.userLine,
  'reflection ai line': ADA_REFLECTION.aiLine,
};

/** Tables a read can touch (the auth bypass writes User; GETs may stamp vessels). */
const READ_TABLES = shapeTables([
  'User',
  'Message',
  'UserVessel',
  'StageProgress',
  'InnerWorkSession',
  'InnerWorkMessage',
  'BrainActivity',
]);

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  let bobSteps: StepResult[];
  let adaControl: StepResult[];
  let calls: CapturedCall[];
  let turnLabel: string;

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'INNER_WORK_LINKED_A',
      runId: `${SCENARIO}_${process.pid}`,
      concept: true,
    });
    const { userA: ada, userB: bob } = harness.actors;
    if (!bob) throw new Error('INNER_WORK_LINKED_A must seed two users');
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const prompts = await capturePrompts();
    calls = prompts.calls;

    const before = await prompts.during('bob reads', () =>
      fullRead(harness, bob, 'before turn', { tables: READ_TABLES, set: 'all' }),
    );
    turnLabel = 'chat turn as bob@e2e.test';
    const turn = await prompts.during(turnLabel, () =>
      harness.step({
        label: turnLabel,
        actor: bob,
        tables: scope,
        sse: true,
        // The turn pipeline stores the AI reply and kicks off summarisation
        // without awaiting it.
        asyncBoundary: true,
        call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/messages/stream`).send({ content: BOB_TURN }),
      }),
    );
    const after = await prompts.during('bob reads', () =>
      fullRead(harness, bob, 'after turn', { tables: READ_TABLES, set: 'all' }),
    );
    bobSteps = [...before, turn, ...after];
    // Control: the same reads as Ada show her reflection, so the probes are live.
    adaControl = await prompts.during('control', () =>
      fullRead(harness, ada, 'control', {
        tables: READ_TABLES,
        set: 'all',
        only: ['inner thoughts', 'inner thoughts list', 'inner work list'],
      }),
    );
    steps = [...bobSteps, ...adaControl];
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: REFLECTION_NEVER_CROSSES_ALLOW,
    harness: () => harness,
    steps: () => steps,
    byteTargetAllowList: REFLECTION_NEVER_CROSSES_BYTE_TARGET_ALLOW,
  });
  targetMessageStageChecks({ harness: () => harness, steps: () => steps });
  targetFixtureDeltaChecks({ harness: () => harness, steps: () => steps });
  mockIndexChecks({ harness: () => harness, steps: () => steps, step: R1_TURN_STEP, email: 'bob@e2e.test' });

  const targetIt = isTargetShape() ? it : it.skip;
  targetIt('pairs: the step indices the rules pin are the turn and Bob’s own after-turn reads', () => {
    expect(steps[R1_TURN_STEP].label).toBe(turnLabel);
    expect(steps[R1_AFTER_STATE_STEP].label).toBe('after turn: state as bob@e2e.test');
    expect(steps[R1_AFTER_MESSAGES_STEP].label).toBe('after turn: messages as bob@e2e.test');
    expect(steps[R1_AFTER_DRAFT_STEP].label).toBe('after turn: empathy draft as bob@e2e.test');
  });

  targetIt(
    "pair (mayDiffer): Bob's after-turn reads show the streamed reply and the streamed proposed statement as his draft",
    () => {
      const sse = steps[R1_TURN_STEP].sse ?? [];
      const streamed = sse
        .filter(e => e.event === 'chunk')
        .map(e => (e.data as { text?: string }).text ?? '')
        .join('')
        .trim();
      const proposed = sse
        .map(e => (e.data as { metadata?: { proposedEmpathyStatement?: string } })?.metadata?.proposedEmpathyStatement)
        .find(Boolean);
      expect(streamed.length).toBeGreaterThan(0);
      expect(proposed).toBeTruthy();
      const stateMsgs = (
        steps[R1_AFTER_STATE_STEP].body as {
          data: { messages: { messages: Array<{ content: string; role: string }> } };
        }
      ).data.messages.messages;
      const msgs = (
        steps[R1_AFTER_MESSAGES_STEP].body as { data: { messages: Array<{ content: string; role: string }> } }
      ).data.messages;
      for (const list of [stateMsgs, msgs]) {
        expect(list[11].role).toBe('AI');
        expect(list[11].content.trim()).toBe(streamed);
      }
      const draft = (steps[R1_AFTER_DRAFT_STEP].body as { data: { draft: { content: string } | null } }).data.draft;
      expect(draft?.content).toBe(proposed);
    },
  );

  targetIt('pair (mayDiffer): every brain_activity cost is numerically the baseline 0', async () => {
    const rows = await withClient(
      harness.fixture.target,
      async c => (await c.query<{ cost: string }>(`SELECT cost::text AS cost FROM brain_activity`)).rows,
      harness.fixture.database,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Number(r.cost)).toBe(0);
  });

  targetIt(
    "pair (addedEntries): Ada's empathy_submitted milestone is reached at her attempt's submitted_at",
    async () => {
      const [row] = await withClient(
        harness.fixture.target,
        async c =>
          (
            await c.query<{ same: boolean }>(
              `SELECT pm.reached_at = a.submitted_at AS same
             FROM participant_milestone pm JOIN empathy_attempt a ON a.author_participant_id = pm.participant_id
             JOIN participant p ON p.id = pm.participant_id JOIN "user" u ON u.id = p.user_id
             WHERE u.email = 'ada@e2e.test' AND pm.milestone_key = 'empathy_submitted'`,
            )
          ).rows,
        harness.fixture.database,
      );
      expect(row).toEqual({ same: true });
    },
  );

  it('the probes are live: Ada can read her own reflection', () => {
    expect(findLeaks(adaControl, PROBES).map(l => l.probe)).toContain('reflection title');
  });

  it("Bob's turn built a prompt (the prompt assertion is not vacuous)", () => {
    expect(calls.filter(c => c.step === turnLabel && c.fn === 'getSonnetStreamingResponse')).toHaveLength(1);
  });

  it("no reflection text in any of Bob's reads or in any prompt built during Bob's steps (known leaks aside)", () => {
    const observed = [
      ...findLeaks(bobSteps, PROBES),
      ...findPromptLeaks(
        calls.filter(c => c.step !== 'control'),
        PROBES,
      ),
    ];
    expect(unexpectedLeakReport(observed, REFLECTION_NEVER_CROSSES_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });

  it('no session-scoped brain_activity input carries reflection text', () => {
    const last = steps[steps.length - 1].concept!.after!.tables[viewName('brain_activity')];
    const sessionRows = last.filter(r => r.session_id !== null);
    expect(sessionRows.length).toBeGreaterThan(0);
    const text = JSON.stringify(sessionRows.map(r => r.input));
    expect(
      Object.entries(PROBES)
        .filter(([, p]) => text.includes(p))
        .map(([k]) => k),
    ).toEqual([]);
  });
});
