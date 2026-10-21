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
  REFLECTION_NEVER_CROSSES_ALLOW,
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
  unexpectedLeakReport,
} from '../privacy';
import { goldenScenarioChecks } from '../scenario-checks';

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
const READ_TABLES = ['User', 'Message', 'UserVessel', 'StageProgress', 'InnerWorkSession', 'InnerWorkMessage', 'BrainActivity'];

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
  });

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
    const last = steps[steps.length - 1].concept!.after.tables[viewName('brain_activity')];
    const sessionRows = last.filter(r => r.session_id !== null);
    expect(sessionRows.length).toBeGreaterThan(0);
    const text = JSON.stringify(sessionRows.map(r => r.input));
    expect(Object.entries(PROBES).filter(([, p]) => text.includes(p)).map(([k]) => k)).toEqual([]);
  });
});
