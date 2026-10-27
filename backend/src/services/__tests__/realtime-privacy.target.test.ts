/**
 * TS-10 fix round 1, I1 (Ruling R36): what each participant's realtime
 * channels receive after a submission, a share suggestion and a status change.
 *
 * Both devices subscribe to the SESSION channel; `forUserId` and
 * `excludeUserId` are client-side filters (mobile/src/hooks/useRealtime.ts,
 * `isRealtimePayloadAddressedToCurrentUser` and the `excludeUserId` skip), not
 * delivery rules. So the wire check is on everything published to the session
 * channel: no status DTO, no row text. The per-participant view applies the
 * mobile filter and pins which events reach each user.
 *
 * Ably and push are mocked at the module boundary; the app runs in-process on
 * a FEEL_HEARD_B clone as `mwf_app` with identity binding on. Bob's consent
 * carries the `reconciler-offer-sharing` LLM fixture, so the reconciler moves
 * both rounds to AWAITING_SHARING and makes each subject a share suggestion.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { listTables, withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

type Wire = { channel: string; name: string; data: Record<string, unknown> };
const mockWire: Wire[] = [];
const mockPush: Array<{ userId: string; event: string; data: Record<string, unknown> }> = [];

jest.mock('../push', () => ({
  sendPushNotification: jest.fn(async (userId: string, event: string, data: Record<string, unknown>) => {
    mockPush.push({ userId, event, data });
    return true;
  }),
}));

jest.mock('ably', () => {
  const MockRest = jest.fn().mockImplementation(() => ({
    channels: {
      get: jest.fn((channel: string) => ({
        publish: jest.fn(async (name: string, data: Record<string, unknown>) => {
          mockWire.push({ channel, name, data: JSON.parse(JSON.stringify(data ?? {})) });
        }),
        presence: { get: jest.fn(async () => ({ items: [] })) },
      })),
    },
  }));
  return { __esModule: true, default: { Rest: MockRest }, Rest: MockRest };
});

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(240_000);

const BOB_EMPATHY = 'I think you felt unseen when the plans changed without a word from me.';

/** Keys that carried one participant's private rows before I1. */
const FORBIDDEN_KEYS = [
  'empathyStatus',
  'empathyStatuses',
  'partnerEmpathy',
  'empathyContent',
  'content',
  'sharedContent',
  'suggestedContent',
  'suggestedReason',
  'shareOffer',
  'validationFeedback',
  'messagesByUserId',
];

describeTarget('Stage 2 realtime payloads (I1): what each participant receives', () => {
  let harness: Harness;
  let scope: string[];
  let ada: Harness['actors']['userA'];
  let bob: Harness['actors']['userA'];

  const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql)).rows, harness.fixture.database);
  const sessionChannel = () => `meetwithoutfear:session:${harness.sessionId}`;

  /** Every text a participant wrote or was written privately: none may be on the wire. */
  const privateTexts = async () =>
    (
      await rows<{ t: string }>(`
        SELECT content AS t FROM message WHERE length(content) >= 24
        UNION SELECT content FROM empathy_attempt
        UNION SELECT content FROM draft WHERE length(content) >= 24
        UNION SELECT suggested_content FROM context_share_offer WHERE suggested_content IS NOT NULL
        UNION SELECT shared_content FROM context_share_offer WHERE shared_content IS NOT NULL
        UNION SELECT offer_message FROM context_share_offer WHERE offer_message IS NOT NULL`)
    ).map(r => r.t);

  /** Wait until no publish has landed for `quietMs` (fire-and-forget work outlives the response). */
  const quiesce = async (quietMs = 1500, timeoutMs = 60_000) => {
    const start = Date.now();
    let seen = -1;
    let since = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (mockWire.length !== seen) {
        seen = mockWire.length;
        since = Date.now();
      } else if (Date.now() - since >= quietMs) return;
      await new Promise(r => setTimeout(r, 100));
    }
  };

  /** The mobile filter (useRealtime.ts): excluded actor skipped; addressed events only for their owner. */
  const viewOf = (userId: string, wire: Wire[]) => [
    ...wire
      .filter(w => w.channel === sessionChannel())
      .filter(w => w.data.excludeUserId !== userId)
      .filter(w => w.data.forUserId === undefined || w.data.forUserId === userId)
      .map(w => `session:${w.name}`),
    ...wire.filter(w => w.channel === `meetwithoutfear:user:${userId}`).map(w => `user:${w.name}`),
  ];

  const wireChecks = async (wire: Wire[]) => {
    const texts = await privateTexts();
    expect(texts.length).toBeGreaterThan(0);
    for (const w of wire.filter(x => x.channel === sessionChannel())) {
      for (const k of FORBIDDEN_KEYS) {
        expect({ event: w.name, key: k, present: k in w.data }).toEqual({ event: w.name, key: k, present: false });
      }
      if (w.name === 'partner.stage_completed') expect(typeof w.data.message).not.toBe('object');
      const json = JSON.stringify(w.data);
      for (const t of texts) {
        expect({ event: w.name, leaks: json.includes(t) ? t : null }).toEqual({ event: w.name, leaks: null });
      }
    }
    for (const p of mockPush) {
      for (const k of FORBIDDEN_KEYS) expect({ event: p.event, key: k, present: k in p.data }).toEqual({ event: p.event, key: k, present: false });
    }
  };

  const take = () => mockWire.splice(0, mockWire.length);

  beforeAll(async () => {
    process.env.ABLY_API_KEY = 'test-app.key:secret';
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'FEEL_HEARD_B',
      runId: `ts10_rt_${process.pid}`,
      appLogin: 'mwf_app',
    });
    ada = harness.actors.userA;
    bob = harness.actors.userB!;
    scope = await listTables(harness.fixture.target, harness.fixture.database);
    const { resetAblyClient } = await import('../realtime');
    resetAblyClient();
  });
  afterAll(async () => {
    delete process.env.ABLY_API_KEY;
    if (harness) await harness.teardown();
  });

  it("submission + share suggestion + status change: Ada's device never receives Bob's rows, nor his offer", async () => {
    const sid = harness.sessionId;
    const draft = await harness.step({
      label: 'draft as bob',
      actor: bob,
      tables: scope,
      call: agent => agent.post(`/api/v1/sessions/${sid}/empathy/draft`).send({ content: BOB_EMPATHY, readyToShare: true }),
    });
    expect(draft.status).toBe(200);
    take();
    mockPush.length = 0;

    const consent = await harness.step({
      label: 'consent as bob',
      actor: bob,
      tables: scope,
      asyncBoundary: true,
      call: agent =>
        agent
          .post(`/api/v1/sessions/${sid}/empathy/consent`)
          .set('x-e2e-fixture-id', 'reconciler-offer-sharing')
          .send({ consent: true }),
    });
    expect(consent.status).toBe(200);
    await quiesce();
    const wire = take();

    const directions = await rows<{ author: string; status: string; offers: number }>(`
      SELECT u.email AS author, a.status::text AS status,
             (SELECT count(*)::int FROM context_share_offer o WHERE o.attempt_id = a.id) AS offers
      FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id JOIN "user" u ON u.id = p.user_id
      ORDER BY u.email`);
    // The scenario reached what the test is about: both rounds await sharing, each with an offer.
    expect(directions).toEqual([
      { author: 'ada@e2e.test', status: 'AWAITING_SHARING', offers: 1 },
      { author: 'bob@e2e.test', status: 'AWAITING_SHARING', offers: 1 },
    ]);

    await wireChecks(wire);

    const adaView = viewOf(ada.id, wire);
    const bobView = viewOf(bob.id, wire);
    // Submission: Ada hears that Bob shared; Bob (the actor) is excluded.
    expect(adaView).toContain('session:partner.empathy_shared');
    expect(bobView).not.toContain('session:partner.empathy_shared');
    // Share suggestion: each subject gets their own, addressed, content-free.
    const suggestions = wire.filter(w => w.name === 'empathy.share_suggestion');
    expect(suggestions.map(s => s.data.forUserId).sort()).toEqual([ada.id, bob.id].sort());
    // Status change: one addressed ping per participant (no broadcast DTO map).
    const statusPings = wire.filter(w => w.name === 'empathy.status_updated' && w.data.statuses);
    expect(statusPings.map(s => s.data.forUserId).sort()).toEqual([ada.id, bob.id].sort());
    expect(wire.filter(w => w.name === 'empathy.status_updated' && w.data.forUserId === undefined)).toEqual([]);
    expect(adaView.filter(v => v === 'session:empathy.status_updated').length).toBeGreaterThanOrEqual(1);
    expect(bobView.filter(v => v === 'session:empathy.status_updated').length).toBeGreaterThanOrEqual(1);
    // Ada's filtered view never names Bob's offer event.
    expect(wire.filter(w => w.name === 'empathy.share_suggestion' && w.data.forUserId === ada.id).length).toBe(1);
  });

  it("accepting the offer: Ada learns context arrived, with no text and no status DTO on the wire", async () => {
    const accept = await harness.step({
      label: 'accept as bob',
      actor: bob,
      tables: scope,
      asyncBoundary: true,
      call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/reconciler/share-offer/respond`).send({ action: 'accept' }),
    });
    expect(accept.status).toBe(200);
    await quiesce();
    const wire = take();
    await wireChecks(wire);

    const adaView = viewOf(ada.id, wire);
    const bobView = viewOf(bob.id, wire);
    expect(adaView).toContain('session:empathy.context_shared');
    expect(bobView).not.toContain('session:empathy.context_shared');
  });
});
