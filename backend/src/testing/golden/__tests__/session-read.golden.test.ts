/**
 * Golden scenario: per-user session reads.
 *
 * This is the privacy boundary. On the current shape the old Message recipient
 * column (a nullable, un-foreign-keyed text column) is the entire mechanism
 * separating what each partner can see; on the target it is the conversation
 * each message belongs to. In the FEEL_HEARD_B fixture the two users see different, overlapping row
 * sets — which is what makes a leak detectable here rather than theoretical.
 *
 * Requires a running local Postgres and a built fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 *
 * Record:  GOLDEN_UPDATE=session-read npm run test --workspace=backend -- session-read.golden
 *
 * The same run also records a NORMALISED baseline through the `old_concept_*`
 * views (`__golden__/session-read.concept.json`), compared under
 * `allow-lists/session-read.ts` rather than byte-for-byte — the oracle that survives
 * the data-layer rebuild. Record it (never the byte-level one) with:
 *          GOLDEN_UPDATE=session-read.concept npx jest session-read.golden
 *
 * On the TARGET shape (TS-9) the same steps run against the target app and a
 * target fixture (`mwf_tfx_feel_heard_b`, built by the target writer):
 * the byte-level golden is compared under `SESSION_READ_BYTE_TARGET_ALLOW`
 * (never re-recorded), the normalised one under `SESSION_READ_ALLOW`, and the
 * scope is the target tables that hold the same facts.
 */

import { TS4_CONCEPT_NAMES } from '../concept-views';
import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { SESSION_READ_ALLOW, SESSION_READ_BYTE_TARGET_ALLOW } from '../allow-lists/session-read';
import { conceptGoldenName, recordOrVerify, recordOrVerifyConcept } from '../runner';
import { isTargetShape } from '../shape';
import { withClient } from '../db';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

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
      // Snapshot the `old_concept_*` views around every step for the normalised
      // baseline. Muted harness reads outside the trace window: the byte-level
      // golden is unaffected.
      // Pinned to the views this baseline was recorded through (TS4_CONCEPT_NAMES).
      concept: { views: TS4_CONCEPT_NAMES },
    });

    const { userA, userB } = harness.actors;
    if (!userB) throw new Error('FEEL_HEARD_B must seed two users');

    // The same three facts in either shape: messages, progress, attempts.
    const scope = isTargetShape()
      ? ['message', 'participant_milestone', 'empathy_attempt']
      : ['Message', 'StageProgress', 'EmpathyAttempt'];

    steps = [];
    for (const actor of [userA, userB]) {
      steps.push(
        await harness.step({
          label: `messages as ${actor.email}`,
          actor,
          tables: scope,
          call: agent => agent.get(`/api/v1/sessions/${harness.sessionId}/messages`),
        }),
      );
      steps.push(
        await harness.step({
          label: `session state as ${actor.email}`,
          actor,
          tables: scope,
          call: agent => agent.get(`/api/v1/sessions/${harness.sessionId}/state`),
        }),
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
          call: agent => agent.get(`/api/v1/sessions/${harness.sessionId}/messages?limit=5`),
        }),
      );
    }
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('every identifier resolves to a structural label', async () => {
    const report = await recordOrVerify({
      scenario: SCENARIO,
      harness,
      steps,
      targetAllowList: SESSION_READ_BYTE_TARGET_ALLOW,
    });
    // An unresolved cuid means a row appeared that the label map does not know
    // about — exactly what a regression that leaks extra rows would produce.
    expect(report.unresolved).toEqual([]);
  });

  it('matches the recorded baseline', async () => {
    const report = await recordOrVerify({
      scenario: SCENARIO,
      harness,
      steps,
      targetAllowList: SESSION_READ_BYTE_TARGET_ALLOW,
    });
    if (report.recorded) {
      // Recording is an explicit, deliberate act, and it has to name this
      // scenario. Reaching here in a normal run would mean the oracle rewrote
      // itself.
      expect(process.env.GOLDEN_UPDATE?.split(',')).toContain(SCENARIO);
      return;
    }
    if (report.diff) {
      throw new Error(`Golden mismatch for "${SCENARIO}":\n${report.diff}`);
    }
    expect(report.diff).toBeNull();
  });

  // The shape-independent oracle (TS-4): the same steps through the concept
  // views, compared as "baseline ⊆ run, plus only the changes the allow-list
  // names". On the current shape the allow-list is satisfied trivially.
  it('matches the normalised concept baseline under its allow-list', async () => {
    const report = await recordOrVerifyConcept({ scenario: SCENARIO, harness, steps, allowList: SESSION_READ_ALLOW });
    expect(report.unresolved).toEqual([]);
    if (report.recorded) {
      expect(process.env.GOLDEN_UPDATE?.split(',')).toContain(conceptGoldenName(SCENARIO));
      return;
    }
    if (report.violations.length) {
      throw new Error(`Normalised baseline mismatch for "${SCENARIO}":\n${report.violations.join('\n')}`);
    }
    // A rule whose path vanished would otherwise pass while asserting nothing.
    expect(report.unmatchedRules).toEqual([]);
  });

  it('every step reached quiescence (a timed-out step is not a baseline)', () => {
    expect(steps.filter(s => !s.settled).map(s => s.label)).toEqual([]);
  });

  // Same lesson as `settled`, one layer down. A window that was empty, truncated
  // or rate-limited produces *smaller* counts, which is indistinguishable from
  // the code having got cheaper. It has to fail loudly or it is worse than not
  // capturing at all.
  // `settle()` watches rows, so a read that touches none can outlive it and
  // either contaminate the next step's window or fall between two and be seen by
  // neither. Measured at zero today; this exists so an undeclared fire-and-forget
  // path added later announces itself instead of quietly skewing a trace.
  it('no app statement fell outside every step window', async () => {
    expect(await harness.unwindowedStatements()).toBe(0);
  });

  it('every step captured a complete SQL trace', () => {
    expect(
      steps.filter(s => !s.trace?.complete).map(s => `${s.label}: ${s.trace?.incompleteReason ?? 'no trace'}`),
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
      const read = (rowsRead as Record<string, number>)[isTargetShape() ? 'message' : 'Message'];
      expect(read).toBeDefined();
      // `limit + 1` is the whole trick: 6 rows fetched to answer `hasMore` on a
      // page of 5. The fixture holds 13 messages, so an unbounded read is 13
      // (or 10 for the partner) and this assertion moves.
      expect(read).toBeLessThanOrEqual(6);
    }
  });

  it('the two participants see different message sets', () => {
    const counts = steps
      .filter(s => s.label.startsWith('messages as'))
      .map(s => {
        const body = s.body as { data?: { messages?: unknown[] } };
        return body?.data?.messages?.length ?? 0;
      });
    expect(counts).toHaveLength(2);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThan(0);
    // If these ever match by accident the scenario has lost its power to detect
    // a cross-conversation leak, so assert the asymmetry the fixture is built to provide.
    expect(counts[0]).not.toEqual(counts[1]);
  });

  // ---------------------------------------------------------------------------
  // TS-9: the pairs of the allow-list's fixture deltas. Each delta stops the
  // comparison demanding the baseline's value; these assert the target's.
  // ---------------------------------------------------------------------------
  const targetOnly = isTargetShape() ? it : it.skip;

  /** Every milestone instant, by user email, read straight from the run database. */
  const milestonesByEmail = async (): Promise<Map<string, Array<{ key: string; at: Date }>>> => {
    const rows = await withClient(
      harness.fixture.target,
      async c =>
        (
          await c.query<{ email: string; key: string; at: Date }>(
            `SELECT u.email, pm.milestone_key AS key, pm.reached_at AS at
             FROM participant_milestone pm JOIN participant p ON p.id = pm.participant_id JOIN "user" u ON u.id = p.user_id
             WHERE p.session_id = $1 ORDER BY pm.reached_at`,
            [harness.sessionId],
          )
        ).rows,
      harness.fixture.database,
    );
    const out = new Map<string, Array<{ key: string; at: Date }>>();
    for (const r of rows) out.set(r.email, [...(out.get(r.email) ?? []), { key: r.key, at: new Date(r.at) }]);
    return out;
  };

  targetOnly("fixtureMask pair: compact signedAt is each signer's compact_signed instant", async () => {
    const ms = await milestonesByEmail();
    const { userA, userB } = harness.actors;
    const signed = (email: string) =>
      ms
        .get(email)
        ?.find(m => m.key === 'compact_signed')
        ?.at.toISOString();
    for (const [step, me, partner] of [
      [steps[1], userA, userB!],
      [steps[4], userB!, userA],
    ] as const) {
      const compact = (step.body as { data: { compact: Record<string, unknown> } }).data.compact;
      expect(compact.mySignedAt).toBe(signed(me.email));
      expect(compact.partnerSignedAt).toBe(signed(partner.email));
      expect(compact.mySignedAt).toEqual(expect.any(String));
    }
  });

  targetOnly("mayDiffer pair: a message's stage is its owner's stage at the message instant", async () => {
    const ms = await milestonesByEmail();
    const TERMINALS = ['compact_signed', 'feel_heard', 'empathy_validated', 'needs_shared'];
    const stageAt = (email: string, at: Date): number => {
      let stage = 0;
      for (const key of TERMINALS) {
        const reached = ms.get(email)?.find(m => m.key === key)?.at;
        if (!reached || reached > at) break;
        stage++;
      }
      return stage;
    };
    const { userA, userB } = harness.actors;
    const owners = [userA, userA, userA, userB!, userB!, userB!];
    let checked = 0;
    steps.forEach((step, i) => {
      const data = (step.body as { data: { messages: unknown } }).data;
      const list = (
        Array.isArray(data.messages) ? data.messages : (data.messages as { messages: unknown[] }).messages
      ) as Array<{
        stage: number;
        timestamp: string;
      }>;
      for (const m of list) {
        expect({ step: step.label, at: m.timestamp, stage: m.stage }).toEqual({
          step: step.label,
          at: m.timestamp,
          stage: stageAt(owners[i].email, new Date(m.timestamp)),
        });
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(40);
  });
});
