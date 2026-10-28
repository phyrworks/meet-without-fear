/**
 * TS-10 real-role tests: immutable rounds, the status writer, the review path.
 *
 * Against a clone of the RECONCILER_SHOWN_B target fixture, with the app
 * logged in as `mwf_app` (identity binding on) and the job as `mwf_job`
 * (harness `appLogin: 'mwf_app'`). Every status move goes through
 * `app.empathy_set_status`; the assertions read the rows back on the
 * fixture's owner connection.
 *
 * RECONCILER_SHOWN_B: Ada's round 1 about Bob is AWAITING_SHARING (a share was
 * offered to Bob); Bob's round 1 about Ada is HELD; both are in stage 2.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const REVISED = 'TS10_ROUND_TWO: I see now you are running on empty and need someone to notice.';
const UNSENT = 'TS10_UNSENT_FEEDBACK: the evenings are the loneliest part.';
const SENT = 'TS10_SENT_FEEDBACK: it is the evenings, not the work, that I needed you to see.';

describeTarget('empathy rounds, the status writer and the review path (mwf_app + mwf_job, identity binding on)', () => {
  let harness: Harness;
  let ada: { participantId: string; userId: string };
  let bob: { participantId: string; userId: string };
  let adaRound1: string;
  let bobRound1: string;

  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql, params)).rows, harness.fixture.database);
  const as = async <T>(userId: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const { runWithContext } = await import('../../lib/request-context');
    return runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId }, async () => await fn());
  };
  const store = () => import('../empathy-store');
  const attempts = () =>
    rows<{
      id: string;
      author: string;
      round: number;
      status: string;
      content: string;
      supersedes: string | null;
      revealed: boolean;
    }>(
      `SELECT a.id, u.email AS author, a.round, a.status::text AS status, a.content, a.supersedes_attempt_id AS supersedes,
              a.revealed_at IS NOT NULL AS revealed
       FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id JOIN "user" u ON u.id = p.user_id
       ORDER BY u.email, a.round`,
    );
  const get = (actor: Harness['actors']['userA'], path: string) =>
    harness.step({
      label: path,
      actor,
      tables: [],
      call: agent => agent.get(`/api/v1/sessions/${harness.sessionId}${path}`),
    });

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `ts10_rounds_${process.pid}`,
      appLogin: 'mwf_app',
    });
    const parts = await rows<{ id: string; user_id: string; email: string }>(
      `SELECT p.id, p.user_id, u.email FROM participant p JOIN "user" u ON u.id = p.user_id`,
    );
    const pick = (email: string) => {
      const p = parts.find(x => x.email === email)!;
      return { participantId: p.id, userId: p.user_id };
    };
    ada = pick('ada@e2e.test');
    bob = pick('bob@e2e.test');
    const a = await attempts();
    adaRound1 = a.find(x => x.author === 'ada@e2e.test')!.id;
    bobRound1 = a.find(x => x.author === 'bob@e2e.test')!.id;
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('runs as the real roles: the app is mwf_app with an identity, the job is mwf_job', async () => {
    const { prisma, getJobPrisma } = await import('../../lib/prisma');
    const [app] = await as(
      ada.userId,
      () =>
        prisma.$queryRaw<
          Array<{ u: string; me: string | null }>
        >`SELECT session_user AS u, app.current_user_id()::text AS me`,
    );
    expect(app).toEqual({ u: 'mwf_app', me: ada.userId });
    const [job] = await getJobPrisma().$queryRaw<Array<{ u: string }>>`SELECT session_user AS u`;
    expect(job.u).toBe('mwf_job');
  });

  // --- rounds -----------------------------------------------------------------

  it('a resubmission supersedes round n and inserts round n+1 HELD; a retried call returns the same round', async () => {
    const { resubmitAttempt } = await store();
    const round2 = await as(ada.userId, () => resubmitAttempt(adaRound1, REVISED));
    const retry = await as(ada.userId, () => resubmitAttempt(adaRound1, REVISED));
    expect(retry).toBe(round2);

    const mine = (await attempts()).filter(a => a.author === 'ada@e2e.test');
    expect(mine.map(a => [a.round, a.status, a.supersedes])).toEqual([
      [1, 'SUPERSEDED', null],
      [2, 'HELD', adaRound1],
    ]);
    expect(mine[1].id).toBe(round2);
    expect(mine[1].content).toBe(REVISED);
    // round 1's statement is untouched: the app never rewrites content
    expect(mine[0].content).not.toBe(REVISED);
  });

  it('the circuit breaker counts resubmissions as rounds − 1 (RefinementAttemptCounter → rounds)', async () => {
    const { checkAttempts } = await import('../reconciler/circuit-breaker');
    expect(await checkAttempts(ada.participantId, bob.participantId)).toEqual({
      shouldSkipReconciler: false,
      attempts: 1,
    });
    expect(await checkAttempts(bob.participantId, ada.participantId)).toEqual({
      shouldSkipReconciler: false,
      attempts: 0,
    });
  });

  it('only the author resubmits', async () => {
    const { resubmitAttempt, currentAttempt } = await store();
    const round2 = (await currentAttempt(ada.participantId, bob.participantId))!;
    await expect(as(bob.userId, () => resubmitAttempt(round2.id, 'not mine to write'))).rejects.toThrow(
      /only the author resubmits/,
    );
    await expect(as(undefined, () => resubmitAttempt(round2.id, 'no identity'))).rejects.toThrow(/attempt not found/);
  });

  // --- the status writer ----------------------------------------------------------

  it('a non-author cannot move a row into a disclosing state', async () => {
    const { setAttemptStatus } = await store();
    // Bob's round about Ada is HELD; Ada is its subject.
    for (const to of ['READY', 'AWAITING_SHARING'] as const) {
      await expect(as(ada.userId, () => setAttemptStatus(bobRound1, to, { actor: 'participant' }))).rejects.toThrow(
        /only the author or the job moves this attempt/,
      );
    }
    expect((await attempts()).find(a => a.id === bobRound1)!.status).toBe('HELD');
  });

  it('a non-job cannot reveal — neither the author nor the owner login', async () => {
    const { setAttemptStatus } = await store();
    await as(bob.userId, () => setAttemptStatus(bobRound1, 'READY', { actor: 'participant' }));
    await expect(
      as(bob.userId, () => setAttemptStatus(bobRound1, 'REVEALED', { actor: 'participant' })),
    ).rejects.toThrow(/only the job reveals/);
    await expect(
      rows(`SELECT set_config('app.current_user_id', $1, false), app.empathy_set_status($2, 'REVEALED', NULL)`, [
        bob.userId,
        bobRound1,
      ]),
    ).rejects.toThrow(/only the job reveals/);
  });

  it('the reveal is refused while a direction is not READY, and then writes the subject’s delivered copy', async () => {
    const { setAttemptStatus, currentAttempt } = await store();
    // Bob READY, Ada's round 2 HELD → the gate does not hold.
    await expect(setAttemptStatus(bobRound1, 'REVEALED', { actor: 'job' })).rejects.toThrow(/reveal gate not met/);
    expect((await attempts()).find(a => a.id === bobRound1)!.revealed).toBe(false);

    const round2 = (await currentAttempt(ada.participantId, bob.participantId))!;
    await setAttemptStatus(round2.id, 'READY', { actor: 'job' });
    await setAttemptStatus(bobRound1, 'REVEALED', { actor: 'job' });
    await setAttemptStatus(round2.id, 'REVEALED', { actor: 'job' });

    const copies = await rows<{ owner: string; sender: string; source: string; kind: string; role: string }>(
      `SELECT ou.email AS owner, su.email AS sender, m.source_attempt_id AS source, m.kind::text AS kind, m.role::text AS role
       FROM message m JOIN conversation c ON c.id = m.conversation_id
       JOIN participant op ON op.id = c.participant_id JOIN "user" ou ON ou.id = op.user_id
       JOIN participant sp ON sp.id = m.sender_participant_id JOIN "user" su ON su.id = sp.user_id
       WHERE m.kind = 'EMPATHY_STATEMENT' AND op.id <> sp.id ORDER BY ou.email`,
    );
    expect(copies).toEqual([
      { owner: 'ada@e2e.test', sender: 'bob@e2e.test', source: bobRound1, kind: 'EMPATHY_STATEMENT', role: 'USER' },
      { owner: 'bob@e2e.test', sender: 'ada@e2e.test', source: round2.id, kind: 'EMPATHY_STATEMENT', role: 'USER' },
    ]);
    // Round 1 was never revealed and stays so.
    expect((await attempts()).find(a => a.id === adaRound1)).toMatchObject({ status: 'SUPERSEDED', revealed: false });
  });

  // --- the review path -------------------------------------------------------------

  it('the author sees nothing of the review before it is sent', async () => {
    const { recordReview, reviewVisibleToAuthor } = await store();
    // Ada (subject of Bob's revealed round) drafts feedback, then records an unsent verdict.
    const draft = await harness.step({
      label: 'feedback draft as ada',
      actor: harness.actors.userA,
      tables: [],
      call: agent =>
        agent
          .post(`/api/v1/sessions/${harness.sessionId}/empathy/validation-feedback/draft`)
          .send({ content: UNSENT, readyToShare: false }),
    });
    expect(draft.status).toBe(200);
    await as(ada.userId, () =>
      recordReview({
        attemptId: bobRound1,
        reviewerParticipantId: ada.participantId,
        validated: false,
        sentFeedback: null,
        at: new Date(),
      }),
    );

    expect(await reviewVisibleToAuthor(bobRound1, ada.participantId)).toBeNull();
    const bobReads = [
      await get(harness.actors.userB!, '/empathy/status'),
      await get(harness.actors.userB!, '/empathy/partner'),
      await get(harness.actors.userB!, '/messages'),
      await get(harness.actors.userB!, '/pending-actions'),
    ];
    for (const r of bobReads) {
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(UNSENT);
    }
    const status = (bobReads[0].body as { data: { myAttempt: { validatedAt: string | null; status: string } } }).data
      .myAttempt;
    expect(status).toMatchObject({ validatedAt: null, status: 'REVEALED' });

    // The explicit send delivers it.
    const send = await harness.step({
      label: 'send feedback as ada',
      actor: harness.actors.userA,
      tables: [],
      asyncBoundary: true,
      call: agent =>
        agent.post(`/api/v1/sessions/${harness.sessionId}/empathy/validate`).send({ validated: false, feedback: SENT }),
    });
    expect(send.status).toBe(200);
    const [review] = await rows<{ feedback: string | null; sent: boolean }>(
      `SELECT feedback, feedback_sent_at IS NOT NULL AS sent FROM empathy_review WHERE attempt_id = $1`,
      [bobRound1],
    );
    expect(review).toEqual({ feedback: SENT, sent: true });
    expect(await reviewVisibleToAuthor(bobRound1, ada.participantId)).toMatchObject({ feedback: SENT });
    const bobMessages = JSON.stringify((await get(harness.actors.userB!, '/messages')).body);
    expect(bobMessages).toContain(SENT);
    expect(bobMessages).not.toContain(UNSENT);
    expect((await attempts()).find(a => a.id === bobRound1)!.status).toBe('REFINING');
  });
});
