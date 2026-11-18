/**
 * Owner decision 2026-11-18 (work-k5fk.10.7 review r1, after 10.36): each participant's Stage 4 transition line
 * ("Let's start with one of yours: <label>") names their own first need and is written from their OWN request. The
 * request that completes the mutual share writes the requester's line; the partner's is written by the partner's
 * next read of the session's state or messages, exactly once. So a participant's label never enters the other's
 * process, and no partner.stage_completed payload carries a line (the session channel reaches every device of the
 * session; the forUserId filter is client-side).
 *
 * On a NEEDS_CONFIRMED clone, as mwf_app with identity binding on; Ably is mocked at the module boundary.
 * Requires: npx tsx src/testing/golden/cli.ts build NEEDS_CONFIRMED
 */
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

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

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('Stage 4 transition lines: each written from its own participant’s request (review r1)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let http: Awaited<ReturnType<typeof httpAs>>;

  beforeAll(async () => {
    run = await openTargetRun('NEEDS_CONFIRMED', `stage4_announce_${process.pid}`);
    ids = await adaAndBob(run);
    process.env.ABLY_API_KEY = 'test-app.key:secret';
    http = await httpAs();
  });
  afterAll(async () => {
    delete process.env.ABLY_API_KEY;
    await run?.drop();
  });

  const liveNeeds = (userId: string) =>
    run.sql<{ id: string; label: string }>(
      `SELECT id::text, label FROM need
       WHERE session_id = $1 AND user_id = $2 AND deleted_at IS NULL AND superseded_by_need_id IS NULL AND confirmed_at IS NOT NULL
       ORDER BY created_at, id`,
      [ids.session, userId],
    );
  const linesOf = async (userId: string) =>
    (
      await run.sql<{ content: string }>(
        `SELECT m.content FROM message m JOIN conversation c ON c.id = m.conversation_id
         WHERE c.session_id = $1 AND c.user_id = $2 AND c.kind = 'MAIN' AND m.content LIKE 'You have both sent your needs%'`,
        [ids.session, userId],
      )
    ).map(r => r.content);
  const ada = () => ({ id: ids.adaUser, email: 'ada@e2e.test' });
  const bob = () => ({ id: ids.bobUser, email: 'bob@e2e.test' });

  it('the requester writes their own line; the partner’s own read writes theirs, once; no event carries a line', async () => {
    const adaNeeds = await liveNeeds(ids.adaUser);
    const bobNeeds = await liveNeeds(ids.bobUser);
    expect(adaNeeds.length).toBeGreaterThan(0);
    expect(bobNeeds.length).toBeGreaterThan(0);

    // Ada shares first; Bob's share completes the mutual share.
    const first = await http(ada(), 'post', `/sessions/${ids.session}/needs/consent`, {
      needIds: adaNeeds.map(n => n.id),
    });
    expect(first.status).toBe(200);
    mockWire.length = 0;
    const second = await http(bob(), 'post', `/sessions/${ids.session}/needs/consent`, {
      needIds: bobNeeds.map(n => n.id),
    });
    expect(second.status).toBe(200);
    expect(second.body.data.advancedToStage4).toBe(true);

    // Bob's request wrote Bob's line, with his own label, and nothing into Ada's conversation.
    expect(await linesOf(ids.bobUser)).toEqual([
      expect.stringContaining(`Let's start with one of yours: ${bobNeeds[0].label}.`),
    ]);
    expect(await linesOf(ids.adaUser)).toEqual([]);
    expect(JSON.stringify(second.body)).not.toContain(adaNeeds[0].label);

    // No partner.stage_completed payload carries a line — neither Ada's nor Bob's own.
    const completed = mockWire.filter(w => w.name === 'partner.stage_completed');
    expect(completed.length).toBeGreaterThan(0);
    for (const w of completed) expect('message' in w.data).toBe(false);
    for (const w of mockWire) {
      expect(JSON.stringify(w.data)).not.toContain(adaNeeds[0].label);
      expect(JSON.stringify(w.data)).not.toContain(bobNeeds[0].label);
    }

    // Ada's next read writes her line, with her own label; further reads (state and messages) write nothing more.
    expect((await http(ada(), 'get', `/sessions/${ids.session}/state`)).status).toBe(200);
    expect((await http(ada(), 'get', `/sessions/${ids.session}/messages`)).status).toBe(200);
    expect((await http(ada(), 'get', `/sessions/${ids.session}/state`)).status).toBe(200);
    expect(await linesOf(ids.adaUser)).toEqual([
      expect.stringContaining(`Let's start with one of yours: ${adaNeeds[0].label}.`),
    ]);
    // ...and Bob's reads leave his single line alone.
    expect((await http(bob(), 'get', `/sessions/${ids.session}/messages`)).status).toBe(200);
    expect(await linesOf(ids.bobUser)).toHaveLength(1);
  });
});
