/**
 * TS-10 real-role test: the accepted share's delivery and the notification
 * path (spec §1.2 context_share_offer: `delivery_notified_at` /
 * `seen_notified_at` are WRITTEN by the notification path — review F4.2).
 *
 * RECONCILER_SHOWN_B clone, app as `mwf_app` (identity binding on), job as
 * `mwf_job`. Bob (the subject) accepts the offer: the job delivers the text
 * into Ada's conversation as SHARED_CONTEXT, stamps the delivery and moves
 * Ada's round to REFINING. Bob's first pending-actions read counts the
 * delivery once and stamps it; the next read counts 0. Ada sees the context
 * as an action and in her badge, never the offer.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('share acceptance and the notification path (mwf_app + mwf_job, identity binding on)', () => {
  let harness: Harness;
  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql, params)).rows, harness.fixture.database);
  const get = (actor: Harness['actors']['userA'], path: string) =>
    harness.step({ label: path, actor, tables: [], call: agent => agent.get(`/api/v1${path}`) });

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `ts10_share_${process.pid}`,
      appLogin: 'mwf_app',
    });
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('accepting delivers the text to the author through the job, stamps the delivery and moves her round', async () => {
    const accept = await harness.step({
      label: 'accept as bob',
      actor: harness.actors.userB!,
      tables: [],
      asyncBoundary: true,
      call: agent =>
        agent.post(`/api/v1/sessions/${harness.sessionId}/reconciler/share-offer/respond`).send({ action: 'accept' }),
    });
    expect(accept.status).toBe(200);
    const [offer] = await rows<{
      status: string;
      delivery: string;
      delivered: boolean;
      notified: boolean;
      shared: string;
    }>(
      `SELECT status::text AS status, delivery_status::text AS delivery, delivered_at IS NOT NULL AS delivered,
              delivery_notified_at IS NOT NULL AS notified, shared_content AS shared FROM context_share_offer`,
    );
    expect(offer).toMatchObject({ status: 'ACCEPTED', delivery: 'DELIVERED', delivered: true, notified: false });
    const delivered = await rows<{ owner: string; sender: string; kind: string; content: string }>(
      `SELECT ou.email AS owner, su.email AS sender, m.kind::text AS kind, m.content
       FROM message m JOIN conversation c ON c.id = m.conversation_id
       JOIN participant op ON op.id = c.participant_id JOIN "user" ou ON ou.id = op.user_id
       JOIN participant sp ON sp.id = m.sender_participant_id JOIN "user" su ON su.id = sp.user_id
       WHERE m.kind = 'SHARED_CONTEXT'`,
    );
    expect(delivered).toEqual([
      { owner: 'ada@e2e.test', sender: 'bob@e2e.test', kind: 'SHARED_CONTEXT', content: offer.shared },
    ]);
    const [attempt] = await rows<{ status: string }>(
      `SELECT a.status::text AS status FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id
       JOIN "user" u ON u.id = p.user_id WHERE u.email = 'ada@e2e.test'`,
    );
    expect(attempt.status).toBe('REFINING');
    const [consent] = await rows<{ decision: string; requester: string | null }>(
      `SELECT decision::text AS decision, requested_by_participant_id AS requester FROM consent WHERE share_offer_id IS NOT NULL`,
    );
    expect(consent).toEqual({ decision: 'GRANTED', requester: null });
  });

  it("the subject's pending-actions read counts the delivery once and writes delivery_notified_at", async () => {
    const first = await get(harness.actors.userB!, `/sessions/${harness.sessionId}/pending-actions`);
    expect(first.status).toBe(200);
    expect((first.body as { data: { sentTabUpdates: number } }).data.sentTabUpdates).toBe(1);
    expect(await rows(`SELECT delivery_notified_at IS NOT NULL AS notified FROM context_share_offer`)).toEqual([
      { notified: true },
    ]);
    const second = await get(harness.actors.userB!, `/sessions/${harness.sessionId}/pending-actions`);
    expect((second.body as { data: { sentTabUpdates: number } }).data.sentTabUpdates).toBe(0);
  });

  it('the author sees the delivered context as an action and in her badge — never the offer', async () => {
    const actions = await get(harness.actors.userA, `/sessions/${harness.sessionId}/pending-actions`);
    const list = (actions.body as { data: { actions: Array<{ type: string }>; sentTabUpdates: number } }).data;
    expect(list.actions.map(a => a.type)).toEqual(['context_received']);
    expect(list.sentTabUpdates).toBe(0);
    const badge = await get(harness.actors.userA, '/notifications/badge-count');
    expect((badge.body as { data: { count: number } }).data.count).toBe(1);
    const status = await get(harness.actors.userA, `/sessions/${harness.sessionId}/reconciler/status`);
    expect((status.body as { data: { pendingShareOffers: number } }).data.pendingShareOffers).toBe(0);
  });
});
