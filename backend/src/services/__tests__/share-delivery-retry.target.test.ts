/**
 * TS-10 fix round 1, I2: an accepted share whose delivery fails is delivered
 * by the retry, exactly once.
 *
 * The subject's answer (offer ACCEPTED + GRANTED consent, app connection) and
 * the job's delivery are two transactions. Before the fix, a failed delivery
 * left the offer ACCEPTED/PENDING and a retry answered "shared" without
 * delivering. Now the retry re-runs the delivery, which is idempotent: the job
 * locks the offer and delivers only while `delivery_status` is PENDING, and
 * the SHARED_CONTEXT copy commits with the DELIVERED stamp.
 *
 * RECONCILER_SHOWN_B clone, app as `mwf_app` (identity binding on), job as
 * `mwf_job`. The first delivery is made to fail inside the job transaction by
 * failing the SHARED_CONTEXT insert once.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('accepted share: a failed delivery is delivered by the retry, once (I2)', () => {
  let harness: Harness;
  const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql)).rows, harness.fixture.database);
  const accept = () =>
    harness.step({
      label: 'accept as bob',
      actor: harness.actors.userB!,
      tables: [],
      call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/reconciler/share-offer/respond`).send({ action: 'accept' }),
    });
  const state = async () => {
    const [offer] = await rows<{ status: string; delivery: string; shared: string | null }>(
      `SELECT status::text AS status, delivery_status::text AS delivery, shared_content AS shared FROM context_share_offer`,
    );
    const [ada] = await rows<{ status: string }>(
      `SELECT a.status::text AS status FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id
       JOIN "user" u ON u.id = p.user_id WHERE u.email = 'ada@e2e.test'`,
    );
    const counts = await rows<{ owner: string; kind: string; role: string; n: number }>(
      `SELECT u.email AS owner, m.kind::text AS kind, m.role::text AS role, count(*)::int AS n
       FROM message m JOIN conversation c ON c.id = m.conversation_id JOIN participant p ON p.id = c.participant_id
       JOIN "user" u ON u.id = p.user_id GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    );
    const consents = await rows<{ decision: string }>(
      `SELECT decision::text AS decision FROM consent WHERE share_offer_id IS NOT NULL`,
    );
    return { offer, adaStatus: ada.status, counts, consents };
  };
  const count = (s: Awaited<ReturnType<typeof state>>, owner: string, kind: string, role: string) =>
    s.counts.find(c => c.owner === owner && c.kind === kind && c.role === role)?.n ?? 0;

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `ts10_retry_${process.pid}`,
      appLogin: 'mwf_app',
    });
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (harness) await harness.teardown();
  });

  it('the delivery fails after the answer commits: ACCEPTED, undelivered, nothing in the author\'s conversation', async () => {
    const before = await state();
    const store = await import('../message-store');
    const real = store.deliverMessage;
    jest.spyOn(store, 'deliverMessage').mockImplementationOnce(async opts => {
      // Fail inside the job transaction, after a real write: the rollback must take it too.
      await real(opts);
      throw new Error('injected delivery failure');
    });

    const res = await accept();
    expect(res.status).toBe(500);
    const after = await state();
    expect(after.offer).toMatchObject({ status: 'ACCEPTED', delivery: 'PENDING' });
    expect(after.offer.shared).toBeTruthy();
    expect(after.consents).toEqual([{ decision: 'GRANTED' }]);
    expect(count(after, 'ada@e2e.test', 'SHARED_CONTEXT', 'USER')).toBe(0);
    expect(after.adaStatus).toBe(before.adaStatus);
    // The rolled-back job transaction left no message (the subject's own suggestion card aside).
    const notCard = (c: { kind: string }) => c.kind !== 'SHARE_SUGGESTION';
    expect(after.counts.filter(notCard)).toEqual(before.counts.filter(notCard));
  });

  it('the retry delivers: one SHARED_CONTEXT copy of the accepted text, DELIVERED, the round at REFINING', async () => {
    const before = await state();
    const res = await accept();
    expect(res.status).toBe(200);
    expect((res.body as { data: { status: string; guesserUpdated: boolean } }).data).toMatchObject({
      status: 'shared',
      guesserUpdated: true,
    });
    const after = await state();
    expect(after.offer).toMatchObject({ status: 'ACCEPTED', delivery: 'DELIVERED' });
    expect(after.adaStatus).toBe('REFINING');
    expect(count(after, 'ada@e2e.test', 'SHARED_CONTEXT', 'USER')).toBe(1);
    // The reflection for the author, the acknowledgement for the subject.
    expect(count(after, 'ada@e2e.test', 'CHAT', 'AI')).toBe(count(before, 'ada@e2e.test', 'CHAT', 'AI') + 1);
    expect(count(after, 'bob@e2e.test', 'CHAT', 'AI')).toBe(count(before, 'bob@e2e.test', 'CHAT', 'AI') + 1);
    const [copy] = await rows<{ content: string }>(`SELECT content FROM message WHERE kind = 'SHARED_CONTEXT'`);
    expect(copy.content).toBe(after.offer.shared);
    expect(after.consents).toEqual([{ decision: 'GRANTED' }]);
  });

  it('a further retry and a direct second delivery write nothing (idempotent)', async () => {
    const before = await state();
    const res = await accept();
    expect(res.status).toBe(200);
    expect((res.body as { data: { status: string; guesserUpdated: boolean } }).data).toMatchObject({
      status: 'shared',
      guesserUpdated: false,
    });

    const { deliverAcceptedShare } = await import('../reconciler/sharing');
    const [o] = await rows<{ id: string; attempt_id: string; subject: string }>(
      `SELECT id, attempt_id, subject_participant_id AS subject FROM context_share_offer`,
    );
    const [author] = await rows<{ id: string; conv: string }>(
      `SELECT p.id, c.id AS conv FROM participant p JOIN "user" u ON u.id = p.user_id
       JOIN conversation c ON c.participant_id = p.id AND c.kind = 'MAIN' WHERE u.email = 'ada@e2e.test'`,
    );
    const again = await deliverAcceptedShare({
      offerId: o.id,
      attemptId: o.attempt_id,
      subject: { participantId: o.subject, userId: null, name: 'Bob', joinedAt: new Date(), mainConversationId: null },
      author: { participantId: author.id, userId: null, name: 'Ada', joinedAt: new Date(), mainConversationId: author.conv },
      sharedContent: 'must never be written',
      subjectAckMessage: 'x',
      reflectionMessage: 'y',
    });
    expect(again).toEqual({ sharedMessageId: null, delivered: false });
    expect(await state()).toEqual(before);
  });
});
