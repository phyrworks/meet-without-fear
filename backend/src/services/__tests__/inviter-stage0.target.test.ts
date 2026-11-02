/**
 * work-qmgc, real roles on a clone of the CREATED target fixture: the inviter
 * signs the compact BEFORE crafting the invitation (the mobile flow). The old
 * StageProgress contract kept them IN_PROGRESS in stage 0 until
 * POST /invitation/confirm (old sessions.ts completed stage 0 there with
 * { compactSigned, invitationSent } and opened stage 1); the client's
 * invitation follow-up is gated on that (UnifiedSessionScreen
 * shouldRunInvitationFollowUp: currentStage === Stage.ONBOARDING).
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

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
});
