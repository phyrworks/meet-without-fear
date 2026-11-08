/**
 * work-2doq: "Seen" for shared context, restored (owner decision 2026-11-07).
 *
 * RECONCILER_SHOWN_B clone, app as `mwf_app` (identity binding on), job as
 * `mwf_job`. Bob (the subject) accepts the offer: the job delivers his text
 * into Ada's conversation as SHARED_CONTEXT. When Ada's chat shows that
 * frame, mobile posts POST /sessions/:id/shared-context-viewed { messageId }.
 * That one write must make Bob's delivery line "seen", clear Ada's
 * hasUnviewedSharedContext and her context_received action / badge — and
 * only Ada, for a frame delivered to her, may write it. It is idempotent and
 * the instant never moves back.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Actor = Harness['actors']['userA'];
type Body<T> = { data: T };
type EmpathyStatus = {
  hasUnviewedSharedContext: boolean;
  sharedContentDeliveryStatus: string | null;
  mySharedContext: { deliveryStatus: string | null } | null;
};

describeTarget('shared-context-viewed: the recipient marks the frame she was shown (work-2doq)', () => {
  let harness: Harness;
  let ada: Actor;
  let bob: Actor;
  let messageId: string;

  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql, params)).rows, harness.fixture.database);
  const get = <T>(actor: Actor, path: string) =>
    harness
      .step({ label: `GET ${path}`, actor, tables: [], call: agent => agent.get(`/api/v1${path}`) })
      .then(r => ({ status: r.status, data: (r.body as Body<T>).data }));
  const view = (actor: Actor, body: Record<string, unknown>) =>
    harness.step({
      label: `shared-context-viewed as ${actor.email}`,
      actor,
      tables: [],
      call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/shared-context-viewed`).send(body),
    });
  const readStates = () =>
    rows<{ email: string; viewed: Date | null }>(
      `SELECT u.email, r.last_viewed_share_tab_at AS viewed
       FROM participant p JOIN "user" u ON u.id = p.user_id
       LEFT JOIN conversation_read_state r ON r.participant_id = p.id ORDER BY u.email`,
    );
  const empathy = (actor: Actor) => get<EmpathyStatus>(actor, `/sessions/${harness.sessionId}/empathy/status`);
  const contextActions = async (actor: Actor) =>
    (
      await get<{ actions: Array<{ type: string }> }>(actor, `/sessions/${harness.sessionId}/pending-actions`)
    ).data.actions.filter(a => a.type === 'context_received').length;
  const badge = async (actor: Actor) => (await get<{ count: number }>(actor, '/notifications/badge-count')).data.count;

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `fix2doq_${process.pid}`,
      appLogin: 'mwf_app',
    });
    ada = harness.actors.userA;
    bob = harness.actors.userB!;
    const accept = await harness.step({
      label: 'accept as bob',
      actor: bob,
      tables: [],
      asyncBoundary: true,
      call: agent =>
        agent.post(`/api/v1/sessions/${harness.sessionId}/reconciler/share-offer/respond`).send({ action: 'accept' }),
    });
    expect(accept.status).toBe(200);
    const [msg] = await rows<{ id: string }>(`SELECT id FROM message WHERE kind = 'SHARED_CONTEXT'`);
    messageId = msg.id;
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('before the frame is shown: Bob reads delivered; Ada has unviewed context, an action and a badge', async () => {
    const bobStatus = await empathy(bob);
    expect(bobStatus.data.mySharedContext?.deliveryStatus).toBe('delivered');
    expect(bobStatus.data.sharedContentDeliveryStatus).toBe('delivered');
    expect((await empathy(ada)).data.hasUnviewedSharedContext).toBe(true);
    expect(await contextActions(ada)).toBe(1);
    expect(await badge(ada)).toBe(1);
  });

  it('authz: the sender cannot mark it, nor anyone a frame not delivered to them; bad ids are 400', async () => {
    expect((await view(bob, { messageId })).status).toBe(404);
    expect((await view(ada, { messageId: '01900000-0000-7000-8000-000000000000' })).status).toBe(404);
    expect((await view(ada, {})).status).toBe(400);
    expect((await view(ada, { messageId: 'context-shared-x' })).status).toBe(400);
    // A message of Ada's own conversation that is not a received shared frame.
    const [own] = await rows<{ id: string }>(
      `SELECT m.id FROM message m JOIN conversation c ON c.id = m.conversation_id
       JOIN participant p ON p.id = c.participant_id JOIN "user" u ON u.id = p.user_id
       WHERE u.email = 'ada@e2e.test' AND m.kind <> 'SHARED_CONTEXT' LIMIT 1`,
    );
    expect(own).toBeDefined();
    expect((await view(ada, { messageId: own.id })).status).toBe(404);
    expect((await readStates()).every(r => r.viewed === null)).toBe(true);
  });

  it("Ada's view makes Bob's line seen and clears her unviewed context, action and badge", async () => {
    const r = await view(ada, { messageId });
    expect(r.status).toBe(200);
    const body = (r.body as Body<{ advanced: boolean; lastViewedSharedContextAt: string }>).data;
    expect(body.advanced).toBe(true);
    const [{ created }] = await rows<{ created: Date }>(`SELECT created_at AS created FROM message WHERE id = $1`, [
      messageId,
    ]);
    expect(new Date(body.lastViewedSharedContextAt).getTime()).toBeGreaterThanOrEqual(created.getTime());

    const states = await readStates();
    expect(states.find(s => s.email === 'bob@e2e.test')?.viewed ?? null).toBeNull();
    expect(states.find(s => s.email === 'ada@e2e.test')?.viewed?.toISOString()).toBe(body.lastViewedSharedContextAt);

    const bobStatus = await empathy(bob);
    expect(bobStatus.data.mySharedContext?.deliveryStatus).toBe('seen');
    expect(bobStatus.data.sharedContentDeliveryStatus).toBe('seen');
    expect((await empathy(ada)).data.hasUnviewedSharedContext).toBe(false);
    expect(await contextActions(ada)).toBe(0);
    expect(await badge(ada)).toBe(0);
  });

  it('idempotent: viewing the same frame again writes nothing', async () => {
    const [before] = await rows<{ viewed: Date }>(
      `SELECT r.last_viewed_share_tab_at AS viewed FROM conversation_read_state r
       JOIN participant p ON p.id = r.participant_id JOIN "user" u ON u.id = p.user_id WHERE u.email = 'ada@e2e.test'`,
    );
    const r = await view(ada, { messageId });
    expect(r.status).toBe(200);
    expect((r.body as Body<{ advanced: boolean }>).data.advanced).toBe(false);
    expect((await readStates()).find(s => s.email === 'ada@e2e.test')?.viewed).toEqual(before.viewed);
  });

  it('monotonic: a stored instant past the frame is never moved back', async () => {
    const future = new Date(Date.now() + 3_600_000);
    await rows(
      `UPDATE conversation_read_state SET last_viewed_share_tab_at = $1
       WHERE participant_id = (SELECT p.id FROM participant p JOIN "user" u ON u.id = p.user_id WHERE u.email = 'ada@e2e.test')`,
      [future],
    );
    const r = await view(ada, { messageId });
    expect(r.status).toBe(200);
    expect((r.body as Body<{ advanced: boolean; lastViewedSharedContextAt: string }>).data).toMatchObject({
      advanced: false,
      lastViewedSharedContextAt: future.toISOString(),
    });
    expect((await readStates()).find(s => s.email === 'ada@e2e.test')?.viewed?.toISOString()).toBe(
      future.toISOString(),
    );
  });
});
