/**
 * TS-12, real roles on a clone of the CREATED target fixture: Stage 0's two
 * confirmations on the target (mwf_app; the session status by mwf_job through
 * app.session_set_status, the only writer of session.status).
 *   - POST /sessions/:id/topic-frame/confirm: creator only; 400 with no topic
 *     frame; stamps topic_frame_confirmed_at once (idempotent); CREATED → INVITED;
 *     the pending invitation's message_confirmed_at.
 *   - POST /sessions/:id/invitation/confirm: 400 before the topic frame is
 *     confirmed; then compact_signed + invitation_sent milestones (Stage 0 → 1)
 *     and no message text written to the invitation; idempotent.
 *
 * Replaces the Prisma-mock suites controllers/__tests__/topic-frame.test.ts and
 * controllers/__tests__/confirm-invitation.test.ts.
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('Stage 0 confirmations on the target (mwf_app; status by mwf_job)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `ts12_topic_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const session = async () =>
    (
      await run.sql<{ status: string; confirmed: Date | null }>(
        `SELECT status::text AS status, topic_frame_confirmed_at AS confirmed FROM session WHERE id = $1`,
        [ids.session],
      )
    )[0];
  const adaMilestones = async () =>
    (await run.sql<{ k: string }>(`SELECT milestone_key AS k FROM participant_milestone WHERE participant_id = $1 ORDER BY k`, [ids.ada])).map(r => r.k);

  it('before a topic frame: both confirmations refuse with 400 and write nothing', async () => {
    expect((await http(ada, 'post', `/sessions/${ids.session}/topic-frame/confirm`)).status).toBe(400);
    expect((await http(ada, 'post', `/sessions/${ids.session}/invitation/confirm`)).status).toBe(400);
    expect(await session()).toEqual({ status: 'CREATED', confirmed: null });
    expect(await adaMilestones()).toEqual([]);
  });

  it('topic frame: the non-creator is refused, the creator confirms once; CREATED → INVITED; a missing session 404', async () => {
    // The coach proposes the frame during Stage 0 chat (update_session_state.topicFrame)
    await run.sql(`UPDATE session SET topic_frame = 'PROBE_TS12_TOPIC the dishes' WHERE id = $1`, [ids.session]);
    expect((await http(bob, 'post', `/sessions/${ids.session}/topic-frame/confirm`)).status).toBe(403);
    expect((await session()).confirmed).toBeNull();

    const first = await http(ada, 'post', `/sessions/${ids.session}/topic-frame/confirm`);
    expect(first.status).toBe(200);
    expect(first.body.data.topicFrame).toBe('PROBE_TS12_TOPIC the dishes');
    const after = await session();
    expect(after.status).toBe('INVITED');
    expect(after.confirmed).not.toBeNull();
    const [inv] = await run.sql<{ c: Date | null }>(`SELECT message_confirmed_at AS c FROM invitation WHERE session_id = $1`, [ids.session]);
    expect(inv.c).not.toBeNull();

    const again = await http(ada, 'post', `/sessions/${ids.session}/topic-frame/confirm`);
    expect(again.status).toBe(200);
    expect(again.body.data.confirmedAt).toBe(first.body.data.confirmedAt);
    expect((await session()).confirmed).toEqual(after.confirmed);

    expect((await http(ada, 'post', `/sessions/00000000-0000-7000-8000-000000000000/topic-frame/confirm`)).status).toBe(404);
  });

  it('invitation confirm: Stage 0 → 1 by milestones, no message text on the invitation; idempotent', async () => {
    const before = await run.sql(`SELECT name, status::text AS status FROM invitation WHERE session_id = $1`, [ids.session]);
    const res = await http(ada, 'post', `/sessions/${ids.session}/invitation/confirm`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ confirmed: true, advancedToStage: 1, invitation: { messageConfirmed: true } });
    expect(await adaMilestones()).toEqual(['compact_signed', 'invitation_sent']);
    expect(await run.sql(`SELECT name, status::text AS status FROM invitation WHERE session_id = $1`, [ids.session])).toEqual(before);

    const again = await http(ada, 'post', `/sessions/${ids.session}/invitation/confirm`);
    expect(again.status).toBe(200);
    expect(again.body.data.advancedToStage).toBeUndefined();
    expect(await adaMilestones()).toEqual(['compact_signed', 'invitation_sent']);
  });
});
