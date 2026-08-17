/**
 * Golden scenario: per-user session reads.
 *
 * This is the privacy boundary. `Message.forUserId` is a nullable, un-foreign-keyed
 * text column, and it is the entire mechanism separating what each partner can
 * see. In the FEEL_HEARD_B fixture the two users see different, overlapping row
 * sets — which is what makes a leak detectable here rather than theoretical.
 *
 * Requires a running local Postgres and a built fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 *
 * Record:  GOLDEN_UPDATE=1 npm run test --workspace=backend -- session-read.golden
 */

import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { recordOrVerify } from '../runner';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL ||
  'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'session-read';

jest.setTimeout(120_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'FEEL_HEARD_B',
      runId: `${SCENARIO}_${process.pid}`,
      // The read scenario is where the dropped-`take` blind spot lives, so this
      // is the scenario the trace oracle was built for.
      trace: true,
    });

    const { userA, userB } = harness.actors;
    if (!userB) throw new Error('FEEL_HEARD_B must seed two users');

    const scope = ['Message', 'StageProgress', 'EmpathyAttempt'];

    steps = [];
    for (const actor of [userA, userB]) {
      steps.push(
        await harness.step({
          label: `messages as ${actor.email}`,
          actor,
          tables: scope,
          call: (agent) => agent.get(`/api/v1/sessions/${harness.sessionId}/messages`),
        })
      );
      steps.push(
        await harness.step({
          label: `session state as ${actor.email}`,
          actor,
          tables: scope,
          call: (agent) => agent.get(`/api/v1/sessions/${harness.sessionId}/state`),
        })
      );
      // A page smaller than the row count, so `take` actually binds. Mutation
      // testing showed a dropped LIMIT escaping undetected without this: the
      // fixture holds 13 messages and the default page is 25, so the limit
      // never applied and the scenario could not observe it disappearing.
      steps.push(
        await harness.step({
          label: `messages page of 5 as ${actor.email}`,
          actor,
          tables: scope,
          call: (agent) => agent.get(`/api/v1/sessions/${harness.sessionId}/messages?limit=5`),
        })
      );
    }
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('every identifier resolves to a structural label', async () => {
    const report = await recordOrVerify({ scenario: SCENARIO, harness, steps });
    // An unresolved cuid means a row appeared that the label map does not know
    // about — exactly what a regression that leaks extra rows would produce.
    expect(report.unresolved).toEqual([]);
  });

  it('matches the recorded baseline', async () => {
    const report = await recordOrVerify({ scenario: SCENARIO, harness, steps });
    if (report.recorded) {
      // Recording is an explicit, deliberate act (GOLDEN_UPDATE=1). Reaching
      // here in a normal run would mean the oracle rewrote itself.
      expect(process.env.GOLDEN_UPDATE).toBe('1');
      return;
    }
    if (report.diff) {
      throw new Error(`Golden mismatch for "${SCENARIO}":\n${report.diff}`);
    }
    expect(report.diff).toBeNull();
  });

  it('every step reached quiescence (a timed-out step is not a baseline)', () => {
    expect(steps.filter(s => !s.settled).map(s => s.label)).toEqual([]);
  });

  // Same lesson as `settled`, one layer down. A window that was empty, truncated
  // or rate-limited produces *smaller* counts, which is indistinguishable from
  // the code having got cheaper. It has to fail loudly or it is worse than not
  // capturing at all.
  it('every step captured a complete SQL trace', () => {
    expect(
      steps.filter(s => !s.trace?.complete).map(s => `${s.label}: ${s.trace?.incompleteReason ?? 'no trace'}`)
    ).toEqual([]);
  });

  // The regression this whole oracle exists for. `take: limit + 1` is re-sliced
  // by the controller at `messages.ts:671`, so removing it leaves every HTTP
  // response byte-identical and only the rows read from Postgres change.
  it('the paginated read bounds the rows it reads from Message', () => {
    for (const step of steps.filter(s => s.label.startsWith('messages page of 5'))) {
      const rowsRead = step.trace?.rowsRead;
      // This step declares no band, so the count must be an exact number. A
      // banded string here would mean the assertion had quietly stopped asserting.
      expect(typeof rowsRead).toBe('object');
      const read = (rowsRead as Record<string, number>).Message;
      expect(read).toBeDefined();
      // `limit + 1` is the whole trick: 6 rows fetched to answer `hasMore` on a
      // page of 5. The fixture holds 13 messages, so an unbounded read is 13
      // (or 10 for the partner) and this assertion moves.
      expect(read).toBeLessThanOrEqual(6);
    }
  });

  it('the two participants see different message sets', () => {
    const counts = steps
      .filter((s) => s.label.startsWith('messages as'))
      .map((s) => {
        const body = s.body as { data?: { messages?: unknown[] } };
        return body?.data?.messages?.length ?? 0;
      });
    expect(counts).toHaveLength(2);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThan(0);
    // If these ever match by accident the scenario has lost its power to detect
    // a forUserId leak, so assert the asymmetry the fixture is built to provide.
    expect(counts[0]).not.toEqual(counts[1]);
  });
});
