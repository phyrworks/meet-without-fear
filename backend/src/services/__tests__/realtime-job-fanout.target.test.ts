/**
 * Review platform M1 / security S3 (work-k5fk.34): an event a JOB raises has no request identity, so the session-list
 * fan-out (realtime notifySessionMembers) must not depend on one. openDueTendingEntries — the worker's open-due job,
 * run here with no request context at all — opens a due SHARED follow-up and publishes on the session channel; each
 * present human then hears `session.updated` on their own user channel, and the session's updated_at is touched.
 * The worker touches only that one column of that one session (worker_touch, t_session_scope_worker).
 *
 * Ably is mocked at the module boundary (the wire is recorded); the run's roles are real.
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

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
jest.setTimeout(180_000);

describeTarget('job-originated session fan-out (review platform M1 / security S3)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `b3_fanout_${process.pid}`);
    ids = await adaAndBob(run);
    process.env.ABLY_API_KEY = 'test-app.key:secret';
    const { resetAblyClient } = await import('../realtime');
    resetAblyClient();
  });
  afterAll(async () => {
    delete process.env.ABLY_API_KEY;
    if (run) await run.drop();
  });

  const userChannelUpdates = () =>
    mockWire
      .filter(w => w.name === 'session.updated' && w.channel.includes(':user:') && w.data.sessionId === ids.session)
      .map(w => w.channel);

  it('openDueTendingEntries, with no request context, notifies both members and touches updated_at', async () => {
    const { getRequestContext } = await import('../../lib/request-context');
    expect(getRequestContext()).toBeUndefined();
    await run.sql(`UPDATE session SET updated_at = now() - interval '1 day' WHERE id = $1`, [ids.session]);
    const [{ before }] = await run.sql<{ before: Date }>(`SELECT updated_at AS before FROM session WHERE id = $1`, [
      ids.session,
    ]);
    await run.sql(
      `INSERT INTO follow_up (session_id, type, scope, status, scheduled_for, summary)
       VALUES ($1, 'SCHEDULED_SHARED_AGREEMENT', 'SHARED', 'SCHEDULED', now() - interval '1 hour', 'due')`,
      [ids.session],
    );
    const tending = await import('../tending.service');
    expect((await tending.openDueTendingEntries(new Date())).opened).toBe(1);

    // notifySessionMembers is fire-and-forget after the session-channel publish: wait for the user channels.
    const deadline = Date.now() + 10_000;
    while (userChannelUpdates().length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    const { REALTIME_CHANNELS } = await import('@meet-without-fear/shared');
    expect(userChannelUpdates().sort()).toEqual(
      [REALTIME_CHANNELS.user(ids.adaUser), REALTIME_CHANNELS.user(ids.bobUser)].sort(),
    );
    const [{ after }] = await run.sql<{ after: Date }>(`SELECT updated_at AS after FROM session WHERE id = $1`, [
      ids.session,
    ]);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('the worker touches only the scoped session’s updated_at: not another session, not status, not unscoped', async () => {
    const other = randomUuidV7();
    await run.sql(`INSERT INTO session (id, status) VALUES ($1, 'CREATED')`, [other]);
    // Scoped to the session: the touch is allowed.
    await run.as('mwf_worker', null, `UPDATE session SET updated_at = now() WHERE id = $1`, [ids.session], ids.session);
    // Another session than the scope: no row (worker_touch), and the trigger refuses a write outside it.
    await expect(
      run.as(
        'mwf_worker',
        null,
        `UPDATE session SET updated_at = now() WHERE id = $1 RETURNING id`,
        [other],
        ids.session,
      ),
    ).resolves.toEqual([]);
    // Unscoped: no row.
    await expect(
      run.as(
        'mwf_worker',
        null,
        `UPDATE session SET updated_at = now() WHERE id = $1 RETURNING id`,
        [ids.session],
        null,
      ),
    ).resolves.toEqual([]);
    await expect(
      run.as('mwf_worker', null, `UPDATE session SET status = 'ABANDONED' WHERE id = $1`, [ids.session], ids.session),
    ).rejects.toThrow(/permission denied/);
  });
});
