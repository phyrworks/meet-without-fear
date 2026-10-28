/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture: push
 * delivery on the target. The recipient's devices are read and cleared by the
 * JOB (user_device is `user_id = me` for the request role; the push goes to
 * another user than the caller), the progress copy comes from the stage shim,
 * the actor is named by the recipient's nickname, else the actor's display
 * name. Expo is mocked at its SDK boundary; nothing else is.
 *
 * Replaces the send-path half of services/__tests__/push.test.ts.
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const mockSend = jest.fn();
jest.mock('expo-server-sdk', () => {
  const Expo = jest.fn().mockImplementation(() => ({ sendPushNotificationsAsync: mockSend }));
  (Expo as unknown as { isExpoPushToken: (t: string) => boolean }).isExpoPushToken = (t: string) =>
    t.startsWith('ExponentPushToken[');
  return { Expo };
});

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const BOB_PHONE = 'ExponentPushToken[ts12-bob-phone-xxxxxxxxxx]';
const BOB_TABLET = 'ExponentPushToken[ts12-bob-tablet-xxxxxxxxx]';

describeTarget('push on the target: the job reads the recipient’s devices', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let push: typeof import('../push');
  let ctx: typeof import('../../lib/request-context');
  /** Ada's request (her identity), sending to Bob. */
  const asAda = <T>(fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext(
      { turnId: 't', requestId: 'r', startTime: Date.now(), userId: ids.adaUser },
      async () => await fn(),
    );

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_push_${process.pid}`);
    ids = await adaAndBob(run);
    push = await import('../push');
    ctx = await import('../../lib/request-context');
  });
  afterAll(async () => {
    if (run) await run.drop();
  });
  beforeEach(() => {
    mockSend.mockReset();
    push.resetExpoClient();
  });

  it('no device: nothing is sent', async () => {
    expect(await asAda(() => push.sendPushNotification(ids.bobUser, 'partner.empathy_shared', {}, ids.session))).toBe(
      false,
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('one notification per device, named by the recipient’s nickname for the actor', async () => {
    await run.sql(
      `INSERT INTO user_device (user_id, push_token, last_seen_at) VALUES ($1, $2, now()), ($1, $3, now() - interval '1 day')`,
      [ids.bobUser, BOB_PHONE, BOB_TABLET],
    );
    await run.sql(`UPDATE relationship_member SET nickname = 'Ads' WHERE user_id = $1`, [ids.bobUser]);
    mockSend.mockResolvedValue([{ status: 'ok' }, { status: 'ok' }]);
    const sent = await asAda(() =>
      push.sendPushNotification(
        ids.bobUser,
        'partner.stage_completed',
        { completedBy: ids.adaUser, stage: 1 },
        ids.session,
      ),
    );
    expect(sent).toBe(true);
    const messages = mockSend.mock.calls[0][0] as Array<{
      to: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
    }>;
    expect(messages.map(m => m.to)).toEqual([BOB_PHONE, BOB_TABLET]);
    // Bob is past Stage 1 (feel_heard reached in the fixture), so the copy is the progress nudge
    expect(messages[0]).toMatchObject({
      title: 'Ads is progressing',
      body: 'Ads felt heard and moved forward. Come back and keep going when you are ready.',
      data: { screen: 'session', sessionId: ids.session, event: 'partner.stage_completed' },
    });
  });

  it('without a nickname the actor is named by their display name, never their user row', async () => {
    await run.sql(`UPDATE relationship_member SET nickname = NULL WHERE user_id = $1`, [ids.bobUser]);
    await run.sql(`UPDATE participant SET display_name = 'PROBE_TS12_DISPLAY' WHERE id = $1`, [ids.ada]);
    mockSend.mockResolvedValue([{ status: 'ok' }, { status: 'ok' }]);
    await asAda(() =>
      push.sendPushNotification(
        ids.bobUser,
        'partner.stage_completed',
        { completedBy: ids.adaUser, stage: 2 },
        ids.session,
      ),
    );
    expect((mockSend.mock.calls[0][0] as Array<{ title: string }>)[0].title).toBe('PROBE_TS12_DISPLAY is progressing');
  });

  it('an unregistered device’s token is cleared by the job; a send with one good device still counts', async () => {
    mockSend.mockResolvedValue([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      { status: 'ok' },
    ]);
    expect(await asAda(() => push.sendPushNotification(ids.bobUser, 'partner.empathy_shared', {}, ids.session))).toBe(
      true,
    );
    expect(
      await run.sql(`SELECT push_token FROM user_device WHERE user_id = $1 AND push_token IS NOT NULL`, [ids.bobUser]),
    ).toEqual([{ push_token: BOB_TABLET }]);

    mockSend.mockResolvedValue([{ status: 'error', message: 'x', details: {} }]);
    expect(
      await asAda(() =>
        push.sendPushNotifications([ids.bobUser, ids.adaUser], 'partner.needs_shared', {}, ids.session),
      ),
    ).toBe(0);
  });
});
