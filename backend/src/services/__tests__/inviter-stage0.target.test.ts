/**
 * work-qmgc, real roles on a clone of the CREATED target fixture: the inviter
 * signs the compact BEFORE crafting the invitation (the mobile flow). The old
 * StageProgress contract kept them IN_PROGRESS in stage 0 until
 * POST /invitation/confirm (old sessions.ts completed stage 0 there with
 * { compactSigned, invitationSent } and opened stage 1); the client's
 * invitation follow-up is gated on that (UnifiedSessionScreen
 * shouldRunInvitationFollowUp: currentStage === Stage.ONBOARDING).
 *
 * The partner can accept before the inviter's app ever confirms (topic-frame
 * confirm makes the link acceptable; the share modal that calls confirm is
 * not re-shown once the partner accepted): accepting reaches the inviter's
 * invitation_sent, so they still leave stage 0, and a later confirm is a no-op.
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { randomUUID } from 'crypto';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('Inviter stage while crafting the invitation (work-qmgc)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `qmgc_stage0_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const state = async () => {
    const res = await http(ada, 'get', `/sessions/${ids.session}/state`);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  it('stays in stage 0 after compact sign + topic-frame confirm, moves to stage 1 at invitation confirm', async () => {
    expect((await http(ada, 'post', `/sessions/${ids.session}/compact/sign`, { agreed: true })).status).toBe(200);
    await run.sql(`UPDATE session SET topic_frame = 'PROBE_QMGC the dishes' WHERE id = $1`, [ids.session]);
    expect((await http(ada, 'post', `/sessions/${ids.session}/topic-frame/confirm`)).status).toBe(200);

    // An AI turn while crafting the invitation (after signing, before sending).
    await run.sql(
      `INSERT INTO message (conversation_id, role, content, created_at)
       SELECT c.id, 'AI', 'PROBE_QMGC crafting turn', now() FROM conversation c
       WHERE c.participant_id = $1 AND c.kind = 'MAIN'`,
      [ids.ada],
    );
    const probeStage = (msgs: Array<{ content: string; stage: number }>) =>
      msgs.find(m => m.content === 'PROBE_QMGC crafting turn')?.stage;

    const crafting = await state();
    expect(crafting.session.status).toBe('INVITED');
    expect(crafting.invitation.messageConfirmedAt).not.toBeNull();
    expect(crafting.session.currentStage).toBe(0);
    expect(crafting.progress.myProgress).toMatchObject({ stage: 0, status: 'IN_PROGRESS', completedAt: null });
    expect(crafting.compact.mySigned).toBe(true);
    expect(probeStage(crafting.messages.messages)).toBe(0);

    expect((await http(ada, 'post', `/sessions/${ids.session}/invitation/confirm`)).status).toBe(200);

    const sent = await state();
    expect(sent.session.currentStage).toBe(1);
    expect(sent.progress.myProgress).toMatchObject({ stage: 1, status: 'IN_PROGRESS' });
    // History keeps the crafting turn in stage 0 (stage 0 ended at invitation_sent).
    expect(probeStage(sent.messages.messages)).toBe(0);
    const history = await http(ada, 'get', `/sessions/${ids.session}/messages`);
    expect(history.status).toBe(200);
    expect(probeStage(history.body.data.messages)).toBe(0);
  });

  /**
   * A fresh session Ada creates for `invitee`, taken to "invitation ready, never confirmed": compact
   * signed, topic frame confirmed (INVITED, message_confirmed_at set), a crafting turn in her chat.
   */
  const craftedButUnconfirmed = async (invitee: string) => {
    const created = await http(ada, 'post', '/sessions', { inviteName: invitee });
    expect(created.status).toBe(201);
    const sessionId: string = created.body.data.session.id;
    const invitationId: string = created.body.data.invitationId;
    expect((await http(ada, 'post', `/sessions/${sessionId}/compact/sign`, { agreed: true })).status).toBe(200);
    await run.sql(`UPDATE session SET topic_frame = 'PROBE_QMGC the dishes' WHERE id = $1`, [sessionId]);
    expect((await http(ada, 'post', `/sessions/${sessionId}/topic-frame/confirm`)).status).toBe(200);
    const [{ inviter }] = await run.sql<{ inviter: string }>(
      `SELECT invited_by_participant_id AS inviter FROM invitation WHERE id = $1`,
      [invitationId],
    );
    await run.sql(
      `INSERT INTO message (conversation_id, role, content, created_at)
       SELECT c.id, 'AI', 'PROBE_QMGC crafting turn', now() FROM conversation c
       WHERE c.participant_id = $1 AND c.kind = 'MAIN'`,
      [inviter],
    );
    const before = await http(ada, 'get', `/sessions/${sessionId}/state`);
    expect(before.body.data.session.currentStage).toBe(0);
    return { sessionId, invitationId, inviter };
  };

  /** After the partner accepted, Ada never having confirmed: past stage 0, and confirm is a no-op. */
  const expectInviterPastStage0 = async (sessionId: string, invitationId: string, inviter: string) => {
    const milestones = () =>
      run.sql<{ key: string; reached_at: Date }>(
        `SELECT milestone_key AS key, reached_at FROM participant_milestone WHERE participant_id = $1 ORDER BY milestone_key`,
        [inviter],
      );
    const [{ accepted_at }] = await run.sql<{ accepted_at: Date }>(`SELECT accepted_at FROM invitation WHERE id = $1`, [
      invitationId,
    ]);
    const reached = await milestones();
    expect(reached.map(m => m.key)).toEqual(['compact_signed', 'invitation_sent']);
    // invitation_sent at the accept instant: the crafting turn before it stays in stage 0
    expect(reached.find(m => m.key === 'invitation_sent')!.reached_at).toEqual(accepted_at);

    const after = await http(ada, 'get', `/sessions/${sessionId}/state`);
    expect(after.status).toBe(200);
    expect(after.body.data.session.currentStage).toBe(1);
    expect(after.body.data.progress.myProgress).toMatchObject({ stage: 1, status: 'IN_PROGRESS' });
    expect(
      after.body.data.messages.messages.find((m: { content: string }) => m.content === 'PROBE_QMGC crafting turn')
        ?.stage,
    ).toBe(0);

    // The share modal's confirm, late: short-circuits — same milestones, no new message.
    const count = async () =>
      (
        await run.sql<{ n: number }>(
          `SELECT count(*)::int AS n FROM message m JOIN conversation c ON c.id = m.conversation_id
           WHERE c.participant_id = $1`,
          [inviter],
        )
      )[0].n;
    const messagesBefore = await count();
    const confirm = await http(ada, 'post', `/sessions/${sessionId}/invitation/confirm`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.confirmed).toBe(true);
    expect(await milestones()).toEqual(reached);
    expect(await count()).toBe(messagesBefore);
    expect((await http(ada, 'get', `/sessions/${sessionId}/state`)).body.data.session.currentStage).toBe(1);
  };

  it('a partner who accepts before the inviter ever confirms still moves the inviter out of stage 0', async () => {
    const { sessionId, invitationId, inviter } = await craftedButUnconfirmed('Carol');
    const carol = { id: randomUUID(), email: `carol-qmgc-${process.pid}@e2e.test` };
    expect((await http(carol, 'post', `/invitations/${invitationId}/accept`)).status).toBe(200);
    await expectInviterPastStage0(sessionId, invitationId, inviter);
  });

  it('the E2E auto-accept on the partner’s first /state read does the same', async () => {
    const { sessionId, invitationId, inviter } = await craftedButUnconfirmed('Dan');
    const dan = { id: randomUUID(), email: `dan-qmgc-${process.pid}@e2e.test` };
    expect((await http(dan, 'get', `/sessions/${sessionId}/state`)).status).toBe(200);
    expect(await run.sql(`SELECT status::text AS status FROM invitation WHERE id = $1`, [invitationId])).toEqual([
      { status: 'ACCEPTED' },
    ]);
    await expectInviterPastStage0(sessionId, invitationId, inviter);
  });
});
