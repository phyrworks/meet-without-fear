/**
 * Golden scenario: the Stage 2 mutual empathy reveal — a WRITE scenario.
 *
 * Every other golden here is read-only, so `describeChange`, `timestampFacts` and
 * the settle machinery had never produced a non-trivial artifact and the write
 * path had no coverage at all. This scenario is the counterweight.
 *
 * Why this path specifically: `checkAndRevealBothIfReady` (services/reconciler/
 * state.ts) is the hardest write in the product to reproduce in SQL by hand —
 * a Serializable transaction wrapping a read-check-write, an `updateMany` with
 * `statusVersion: { increment: 1 }`, and a mutual-reveal invariant that must hold
 * for both partners at once. It also runs *after the response returns*, kicked
 * off fire-and-forget by `consentToShare`, which is what makes the difference
 * between `changesAtResponse` and `changes` load-bearing here.
 *
 * Scope is the whole database, derived from `information_schema` rather than
 * declared. The scoped-table pattern the other scenario uses cannot see a
 * spurious write to an undeclared table, and a write scenario is exactly where
 * that blindness costs the most.
 *
 * Requires a running local Postgres and a built fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 *
 * Record:  GOLDEN_UPDATE=1 npx jest empathy-reveal.golden
 */

import { listTables } from '../db';
import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { recordOrVerify } from '../runner';
import type { SnapshotRow } from '../snapshot';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL ||
  'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'empathy-reveal';

const BOB_EMPATHY = 'I think you feel unseen when the chores pile up and nobody says anything.';

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  let consentStep: StepResult;
  let attemptsAfter: SnapshotRow[];

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'FEEL_HEARD_B',
      runId: `${SCENARIO}_${process.pid}`,
      // The other escaped mutation lives here: moving the reveal write out of
      // its Serializable `$transaction` writes identical rows.
      trace: true,
    });

    const { userA, userB } = harness.actors;
    if (!userB) throw new Error('FEEL_HEARD_B must seed two users');

    // Whole-database scope. Nothing hand-maintained: a table added by a future
    // migration is in scope the day it exists.
    const scope = await listTables(harness.fixture.target, harness.fixture.database);

    const s = harness.step.bind(harness);

    // In FEEL_HEARD_B, Ada's empathy attempt is already HELD and Bob has just
    // finished Stage 1. Bob writing and consenting to his own attempt is the
    // event that makes both directions submittable, so the reveal is reached
    // through the real controller flow rather than by poking the database.
    const draft = await s({
      label: 'draft as bob',
      actor: userB,
      tables: scope,
      call: (agent) =>
        agent
          .post(`/api/v1/sessions/${harness.sessionId}/empathy/draft`)
          .send({ content: BOB_EMPATHY, readyToShare: true }),
    });

    const consent = await s({
      label: 'consent as bob',
      actor: userB,
      tables: scope,
      // `consentToShare` fires `triggerReconcilerAndUpdateStatuses` without
      // awaiting it, so the reveal lands somewhere after the response — measured
      // returning on READY in one run and REVEALED in the next.
      asyncBoundary: true,
      // The only unasserted trace fields in either scenario, and the only step
      // that needs any. 48 recorded runs (18 + 30) say what moves here; nothing
      // moves on any other step of either scenario.
      //
      //   connections                     4 x45, 3 x3
      //   rowsRead.Message (rollup)       34 x46, 35 x2
      //   one Message-only Index Scan      0 x46,  1 x2
      //
      // Both are refused rather than given a measured range, and the history is
      // why. An earlier version declared `connections: [3, 4]` from the first 18
      // runs. The mutation gate then produced `5` on a clean, unmutated tree —
      // a value 48 runs never showed — and `connections` also moved under two
      // unrelated mutations, so it cannot separate "the pool scheduled
      // differently" from "a regression added a query". A range that fails on a
      // clean tree teaches a reader to dismiss exactly the failures this harness
      // exists to raise.
      //
      // `rowsRead.Message` looked far tighter (46/48 at one value, moving by a
      // single row) but it is the same kind of claim. The raced statement is a
      // `findMany` with no LIMIT, so nothing bounds it at one row, and the reveal
      // inserts TWO Message rows in separate autocommit transactions. 34-35 was a
      // property of the sample exactly as 3-4 was, so it goes too.
      //
      // What is NOT refused is the point: every other relation this step touches
      // stays exact — EmpathyAttempt 23, RelationshipMember 35, Relationship 21,
      // Session 21, User 19, StageProgress 8, UserVessel 6, EmpathyDraft 2, and
      // three zeroes — as do statement count (139), transaction count (129),
      // kinds, isolation and every plan node type, all identical 48/48.
      //
      // EmpathyAttempt is the control that shows the line is real rather than
      // superstition: the reveal writes it too, but only with UPDATE, so its read
      // counts cannot move with timing. INSERT/DELETE moves row counts; UPDATE
      // does not.
      traceUnasserted: {
        connections: true,
        rowCounts: ['Message'],
      },
      call: (agent) =>
        agent.post(`/api/v1/sessions/${harness.sessionId}/empathy/consent`).send({ consent: true }),
    });
    consentStep = consent;

    steps = [draft, consent];

    // Read the reveal back through both partners' eyes. A reveal that writes the
    // right rows but routes them to the wrong reader is the failure mode this
    // product cannot afford, and only the read-back can see it.
    for (const actor of [userA, userB]) {
      for (const [label, path] of [
        ['empathy status', 'empathy/status'],
        ['partner empathy', 'empathy/partner'],
        ['messages', 'messages'],
      ] as const) {
        steps.push(
          await s({
            label: `${label} as ${actor.email}`,
            actor,
            tables: scope,
            call: (agent) => agent.get(`/api/v1/sessions/${harness.sessionId}/${path}`),
          })
        );
      }
    }

    attemptsAfter = (await harness.snapshot(['EmpathyAttempt'])).tables.EmpathyAttempt;
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('every identifier resolves to a structural label', async () => {
    const report = await recordOrVerify({ scenario: SCENARIO, harness, steps });
    expect(report.unresolved).toEqual([]);
  });

  it('matches the recorded baseline', async () => {
    const report = await recordOrVerify({ scenario: SCENARIO, harness, steps });
    if (report.recorded) {
      expect(process.env.GOLDEN_UPDATE).toBe('1');
      return;
    }
    if (report.diff) {
      throw new Error(`Golden mismatch for "${SCENARIO}":\n${report.diff}`);
    }
    expect(report.diff).toBeNull();
  });

  it('every step reached quiescence (a timed-out step is not a baseline)', () => {
    expect(steps.filter((s) => !s.settled).map((s) => s.label)).toEqual([]);
  });

  // An empty or rate-limited window reads as a *smaller* trace, which looks
  // exactly like the code having got cheaper. Same failure shape as `settled`.
  it('every step captured a complete SQL trace', () => {
    expect(
      steps
        .filter((s) => !s.trace?.complete)
        .map((s) => `${s.label}: ${s.trace?.incompleteReason ?? 'no trace'}`)
    ).toEqual([]);
  });

  // The mutation that escaped every row and response assertion here: moving the
  // reveal `updateMany` out of `checkAndRevealBothIfReady`'s Serializable
  // `$transaction` writes the same rows in the same order and returns the same
  // bodies. Only the envelope differs — and the envelope is the TOCTOU
  // protection, so its loss is the whole defect.
  it('the reveal runs inside one Serializable transaction', () => {
    const serializable = (consentStep.trace?.shapes ?? []).filter((t) => t.isolation === 'SERIALIZABLE');
    expect(serializable).toHaveLength(1);
    // One occurrence, not two: the reveal is a single read-check-write.
    expect(serializable[0].occurrences).toBe(1);
    // Read-check-write: the check reads and the reveal writes, in one group.
    const kinds = serializable[0].kinds;
    expect(kinds.SELECT ?? 0).toBeGreaterThan(0);
    expect((kinds.UPDATE ?? 0) + (kinds.INSERT ?? 0)).toBeGreaterThan(0);
    // Grouped by vxid, never by "has a BEGIN": Prisma wraps a bare `updateMany`
    // in its own implicit BEGIN/COMMIT, so the mutated code still has one.
    expect(serializable[0].statementCount).toBeGreaterThan(2);
  });

  // Without this, a regression that stops writing entirely would still record a
  // perfectly stable golden — which is how this suite spent its first milestone
  // asserting nothing about writes at all.
  it('the consent step actually writes rows', () => {
    expect(consentStep.changes.length).toBeGreaterThan(0);
    expect(consentStep.changes.some((c) => c.table === 'EmpathyAttempt')).toBe(true);
  });

  // The reveal commentary is written by the background reconciler, one message
  // per subject, and each must reach exactly one inbox. Asserting the routing
  // rather than the count is what makes this a privacy test: a reveal that wrote
  // both messages to the same user would satisfy any count-based check.
  it('routes one reveal message to each partner', () => {
    const inboxes = consentStep.changes
      .filter((c) => c.table === 'Message' && c.kind === 'added')
      .map((c) => (c.after as { forUserId?: string; role?: string; content?: string }))
      .filter((m) => m.role === 'AI' && m.content?.includes('is ready for you to review'))
      .map((m) => m.forUserId);
    expect(new Set(inboxes)).toEqual(new Set([harness.actors.userA.id, harness.actors.userB?.id]));
  });

  it('reveals both attempts or neither', () => {
    expect(attemptsAfter).toHaveLength(2);
    const revealed = attemptsAfter.filter((a) => a.status === 'REVEALED');
    expect(revealed).toHaveLength(attemptsAfter.length);
    // revealedAt is the field a hand-written UPDATE is most likely to drop: the
    // status alone still reads as revealed, and every downstream "when" is wrong.
    for (const a of attemptsAfter) {
      expect(a.revealedAt).not.toBeNull();
      expect(a.deliveredAt).not.toBeNull();
      expect(a.deliveryStatus).toBe('DELIVERED');
    }
  });

  it('bumps statusVersion on every status change', () => {
    // Ada's attempt entered the run at statusVersion 0 and passes through
    // ANALYZING, READY and REVEALED. Event ordering on the client is derived from
    // this counter, so a lost increment is a silent ordering bug.
    for (const a of attemptsAfter) {
      expect(Number(a.statusVersion)).toBeGreaterThanOrEqual(3);
    }
  });
});
