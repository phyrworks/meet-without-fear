/**
 * TS-10 fix round 1, m2 + m3: the review of an attempt.
 *
 * m2 — before the feedback is sent the author sees nothing of the review, the
 * `validated` flag included (spec §1.2). A positive verdict reaches the author
 * through their round's status only, so a verdict whose status move failed
 * must not show the author a `validatedAt`.
 *
 * m3 — validating after a sent feedback keeps the sent feedback and its
 * `feedback_sent_at`: the review's GRANTED consent names a review that still
 * carries what the author was sent.
 *
 * FEEL_HEARD_B clone driven to the mutual reveal (Bob writes and consents to
 * his attempt; Ada's is HELD; the reconciler moves both READY and reveals them,
 * as in the empathy-reveal golden), app as `mwf_app` with identity binding on,
 * job as `mwf_job`.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { listTables, withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const FEEDBACK = 'It was less about the plans and more about not being asked.';

describeTarget('the review of an attempt: what the author sees, and a sent feedback survives a verdict', () => {
  let harness: Harness;
  const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql)).rows, harness.fixture.database);
  const roundOf = (email: string) =>
    rows<{ status: string }>(
      `SELECT a.status::text AS status FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id
       JOIN "user" u ON u.id = p.user_id WHERE u.email = '${email}' ORDER BY a.round DESC LIMIT 1`,
    ).then(r => r[0].status);
  const reviewBy = (email: string) =>
    rows<{ validated: boolean; feedback: string | null; sent: Date | null }>(
      `SELECT r.validated, r.feedback, r.feedback_sent_at AS sent FROM empathy_review r
       JOIN participant p ON p.id = r.reviewer_participant_id JOIN "user" u ON u.id = p.user_id WHERE u.email = '${email}'`,
    );
  const post = (who: 'userA' | 'userB', path: string, body: object) =>
    harness.step({
      label: `${path} as ${who}`,
      actor: harness.actors[who]!,
      tables: [],
      call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}${path}`).send(body),
    });
  const myAttempt = async (who: 'userA' | 'userB') => {
    const res = await harness.step({
      label: `status as ${who}`,
      actor: harness.actors[who]!,
      tables: [],
      call: agent => agent.get(`/api/v1/sessions/${harness.sessionId}/empathy/status`),
    });
    expect(res.status).toBe(200);
    return (res.body as { data: { myAttempt: { status: string; validatedAt: string | null } } }).data.myAttempt;
  };

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'FEEL_HEARD_B',
      runId: `ts10_review_${process.pid}`,
      appLogin: 'mwf_app',
    });
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const bob = harness.actors.userB!;
    for (const [label, path, body] of [
      ['draft as bob', 'draft', { content: 'I think you felt unseen when the plans changed.', readyToShare: true }],
      ['consent as bob', 'consent', { consent: true }],
    ] as const) {
      const res = await harness.step({
        label,
        actor: bob,
        tables: scope,
        asyncBoundary: true,
        call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/empathy/${path}`).send(body),
      });
      expect(res.status).toBe(200);
    }
  });

  it('setup: both rounds are revealed, no review yet', async () => {
    expect([await roundOf('ada@e2e.test'), await roundOf('bob@e2e.test')]).toEqual(['REVEALED', 'REVEALED']);
    expect(await rows(`SELECT count(*)::int AS n FROM empathy_review`)).toEqual([{ n: 0 }]);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (harness) await harness.teardown();
  });

  it('m2: a verdict whose VALIDATED move failed shows the author nothing — no validatedAt', async () => {
    expect(await roundOf('bob@e2e.test')).toBe('REVEALED');
    const store = await import('../empathy-store');
    const real = store.setAttemptStatus;
    jest.spyOn(store, 'setAttemptStatus').mockImplementation(async (id, status, opts) => {
      if (status === 'VALIDATED') throw new Error('injected: VALIDATED move failed');
      return real(id, status, opts);
    });
    const res = await post('userA', '/empathy/validate', { validated: true });
    jest.restoreAllMocks();
    expect(res.status).toBe(500);
    // Ada's verdict row exists (her own), unsent; Bob's round is still REVEALED.
    expect(await reviewBy('ada@e2e.test')).toEqual([{ validated: true, feedback: null, sent: null }]);
    expect(await roundOf('bob@e2e.test')).toBe('REVEALED');
    expect(await myAttempt('userB')).toMatchObject({ status: 'REVEALED', validatedAt: null });
  });

  it("m2: Ada's retried verdict lands; Bob learns it from his round's status", async () => {
    const res = await post('userA', '/empathy/validate', { validated: true });
    expect(res.status).toBe(200);
    expect(await roundOf('bob@e2e.test')).toBe('VALIDATED');
    const bobs = await myAttempt('userB');
    expect(bobs.status).toBe('VALIDATED');
    expect(bobs.validatedAt).toBeTruthy();
  });

  it('m3: validating after a sent feedback keeps the feedback and its send instant', async () => {
    const sent = await post('userB', '/empathy/validate', { validated: false, feedback: FEEDBACK });
    expect(sent.status).toBe(200);
    const [afterSend] = await reviewBy('bob@e2e.test');
    expect(afterSend).toMatchObject({ validated: false, feedback: FEEDBACK });
    expect(afterSend.sent).toBeTruthy();
    expect(await roundOf('ada@e2e.test')).toBe('REFINING');

    // Ada accepts the difference: her round READY, and (Bob's being VALIDATED) revealed again.
    const skip = await post('userA', '/empathy/skip-refinement', { willingToAccept: true });
    expect(skip.status).toBe(200);
    expect(await roundOf('ada@e2e.test')).toBe('REVEALED');

    const verdict = await post('userB', '/empathy/validate', { validated: true });
    expect(verdict.status).toBe(200);
    expect(await roundOf('ada@e2e.test')).toBe('VALIDATED');
    expect(await reviewBy('bob@e2e.test')).toEqual([{ validated: true, feedback: FEEDBACK, sent: afterSend.sent }]);
    const consents = await rows<{ decision: string; feedback: string | null }>(
      `SELECT c.decision::text AS decision, r.feedback FROM consent c JOIN empathy_review r ON r.id = c.review_id`,
    );
    expect(consents).toEqual([{ decision: 'GRANTED', feedback: FEEDBACK }]);
    // The author learns the verdict from her round's status.
    const mine = await myAttempt('userA');
    expect(mine.status).toBe('VALIDATED');
    expect(mine.validatedAt).toBeTruthy();
  });
});
