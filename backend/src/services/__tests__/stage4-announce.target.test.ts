/**
 * work-k5fk.10.36 (owner decision 2026-11-18): the mutual needs share writes each participant's Stage 4 transition
 * line ("Let's start with one of yours: <label>") from the request of whoever completed it. The partner's label
 * reaches that request's server process (app.first_need_label — field encryption keeps the key out of Postgres, so
 * no definer can compose the line), but never a client: not the requester's HTTP response, and not the partner's
 * partner.stage_completed payload on the session channel, which every device of the session receives (the
 * forUserId filter is client-side). The partner's client refetches its messages on that event instead.
 *
 * On a NEEDS_CONFIRMED clone, as mwf_app with identity binding on; Ably is mocked at the module boundary.
 * Requires: npx tsx src/testing/golden/cli.ts build NEEDS_CONFIRMED
 */
import { decryptColumnValue } from '../../lib/prisma-encryption-middleware';
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

describeTarget('Stage 4 transition lines: the partner’s label never reaches a client (work-k5fk.10.36)', () => {
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
  // The line names the first need the participant SHARED, in its shared wording (app.first_need_label, review F1).
  const firstShared = async (userId: string) => {
    const [row] = await run.sql<{ shared_text: string }>(
      `SELECT s.shared_text FROM need n JOIN need_share s ON s.need_id = n.id AND s.revoked_at IS NULL
       WHERE n.session_id = $1 AND n.user_id = $2 AND n.deleted_at IS NULL AND n.superseded_by_need_id IS NULL
         AND n.confirmed_at IS NOT NULL
       ORDER BY n.created_at, n.id LIMIT 1`,
      [ids.session, userId],
    );
    return decryptColumnValue('need_share', 'shared_text', row.shared_text) as string;
  };
  const user = (id: string, email: string) => ({ id, email });

  it('both lines are written, the requester’s response and the partner’s payload carry no partner label', async () => {
    const adaNeeds = await liveNeeds(ids.adaUser);
    const bobNeeds = await liveNeeds(ids.bobUser);
    expect(adaNeeds.length).toBeGreaterThan(0);
    expect(bobNeeds.length).toBeGreaterThan(0);

    // Ada shares first; Bob's share completes the mutual share, so Bob's request writes both lines.
    const first = await http(user(ids.adaUser, 'ada@e2e.test'), 'post', `/sessions/${ids.session}/needs/consent`, {
      needIds: adaNeeds.map(n => n.id),
    });
    expect(first.status).toBe(200);
    mockWire.length = 0;
    const second = await http(user(ids.bobUser, 'bob@e2e.test'), 'post', `/sessions/${ids.session}/needs/consent`, {
      needIds: bobNeeds.map(n => n.id),
    });
    expect(second.status).toBe(200);
    expect(second.body.data.advancedToStage4).toBe(true);

    // Both MAIN conversations hold their own transition line, naming their own first need.
    const lines = await run.sql<{ user_id: string; content: string }>(
      `SELECT c.user_id::text, m.content FROM message m JOIN conversation c ON c.id = m.conversation_id
       WHERE c.session_id = $1 AND c.kind = 'MAIN' AND m.content LIKE 'You have both sent your needs%'`,
      [ids.session],
    );
    const lineOf = (u: string) => lines.find(l => l.user_id === u)?.content ?? '';
    const adaShared = await firstShared(ids.adaUser);
    expect(lineOf(ids.adaUser)).toContain(`Let's start with one of yours: ${adaShared}.`);
    expect(lineOf(ids.bobUser)).toContain(`Let's start with one of yours: ${bobNeeds[0].label}.`);

    // Bob's own client: his HTTP response never carries Ada's label.
    expect(JSON.stringify(second.body)).not.toContain(adaNeeds[0].label);

    // The session channel: Ada's partner.stage_completed carries no message (her client refetches), so Bob's
    // device, subscribed to the same channel, never receives her label.
    const forAda = mockWire.filter(w => w.name === 'partner.stage_completed' && w.data.forUserId === ids.adaUser);
    expect(forAda.length).toBeGreaterThan(0);
    for (const w of forAda) expect('message' in w.data).toBe(false);
    for (const w of mockWire) expect(JSON.stringify(w.data)).not.toContain(adaNeeds[0].label);
  });
});
