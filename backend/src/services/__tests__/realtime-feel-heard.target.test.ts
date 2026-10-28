/**
 * TS-12 fix round 1, I2 (Ruling R36): confirmFeelHeard's share suggestion.
 *
 * On a FEEL_HEARD_B clone Ada's round about Bob is HELD; Bob confirms he feels
 * heard, so the reconciler runs for that direction (the `reconciler-offer-
 * sharing` fixture finds significant gaps) and Bob — the subject — is told a
 * share suggestion exists. That event is on the SESSION channel, which Ada's
 * device receives too (`forUserId` is a client-side filter): it must carry no
 * suggested content, no reason and no status DTO — the same addressed,
 * content-free ping stage2's consent path sends. Mobile
 * (UnifiedSessionScreen.tsx `empathy.share_suggestion`) refetches the status
 * and the offer.
 *
 * Ably and push are mocked at the module boundary; the app runs as `mwf_app`.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { listTables, withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

type Wire = { channel: string; name: string; data: Record<string, unknown> };
const mockWire: Wire[] = [];

jest.mock('../push', () => ({ sendPushNotification: jest.fn(async () => true) }));
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

const FORBIDDEN_KEYS = [
  'empathyStatus',
  'empathyStatuses',
  'suggestedContent',
  'suggestedReason',
  'shareOffer',
  'content',
];

describeTarget('confirmFeelHeard share suggestion on the session channel (R36)', () => {
  let harness: Harness;

  beforeAll(async () => {
    process.env.ABLY_API_KEY = 'test-app.key:secret';
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'FEEL_HEARD_B',
      runId: `ts12_rtfh_${process.pid}`,
      appLogin: 'mwf_app',
    });
    const { resetAblyClient } = await import('../realtime');
    resetAblyClient();
  });
  afterAll(async () => {
    delete process.env.ABLY_API_KEY;
    if (harness) await harness.teardown();
  });

  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql, params)).rows, harness.fixture.database);
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

  it("Bob's feel-heard runs the reconciler; his share suggestion is addressed and content-free", async () => {
    const bob = harness.actors.userB!;
    const sid = harness.sessionId;
    // Bob has not yet confirmed (the fixture's feel_heard is removed), Ada's round about him is HELD.
    await rows(
      `DELETE FROM participant_milestone pm USING participant p WHERE p.id = pm.participant_id AND p.user_id = $1 AND pm.milestone_key = 'feel_heard'`,
      [bob.id],
    );
    expect(
      await rows(
        `SELECT a.status::text AS status FROM empathy_attempt a JOIN participant p ON p.id = a.subject_participant_id WHERE p.user_id = $1`,
        [bob.id],
      ),
    ).toEqual([{ status: 'HELD' }]);
    mockWire.length = 0;

    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const res = await harness.step({
      label: 'feel heard as bob',
      actor: bob,
      tables: scope,
      asyncBoundary: true,
      call: agent =>
        agent
          .post(`/api/v1/sessions/${sid}/feel-heard`)
          .set('x-e2e-fixture-id', 'reconciler-offer-sharing')
          .send({ confirmed: true }),
    });
    expect(res.status).toBe(200);
    await quiesce();

    // The scenario reached what the test is about: an offer for Bob exists.
    const offers = await rows<{ suggested: string | null }>(
      `SELECT o.suggested_content AS suggested FROM context_share_offer o JOIN participant p ON p.id = o.subject_participant_id WHERE p.user_id = $1`,
      [bob.id],
    );
    expect(offers.length).toBe(1);

    const session = mockWire.filter(w => w.channel === `meetwithoutfear:session:${sid}`);
    const suggestion = session.filter(w => w.name === 'empathy.share_suggestion');
    expect(suggestion).toHaveLength(1);
    expect(suggestion[0].data).toMatchObject({ forUserId: bob.id, guesserName: 'your partner' });
    for (const w of session) {
      for (const k of FORBIDDEN_KEYS)
        expect({ event: w.name, key: k, present: k in w.data }).toEqual({ event: w.name, key: k, present: false });
      if (offers[0].suggested) expect(JSON.stringify(w.data)).not.toContain(offers[0].suggested);
      // The guesser's notice (reconciler/state.ts, TS-10) is canned copy, never row text.
      if ('message' in w.data) expect(w.data.message).toMatch(/ is considering a suggestion to share more$/);
    }
  });
});
