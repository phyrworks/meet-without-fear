/**
 * Owner decision 2026-11-25 (review clients C5, work-k5fk.34): the AI's "Do you feel heard?" offer is persisted, so
 * the card survives a reload or another device, and is cleared when answered. It is the participant's own
 * (conversation_read_state.feel_heard_offered_at, app_own): the partner reads nothing of it.
 * Base persisted it as gatesSatisfied.feelHeardCheckOffered.
 *
 * One run (one fixture database) per file. Requires: npx tsx src/testing/golden/cli.ts build EMPATHY_SHARED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { actingAs, adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('the feel-heard offer is persisted, private, and cleared on the answer (work-k5fk.34)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let me: { id: string; email: string };
  let other: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('EMPATHY_SHARED_A', `b3_fho_${process.pid}`);
    ids = await adaAndBob(run);
    // Bob has joined and signs the compact: he is in Stage 1 (witness), where the AI offers the check.
    await run.sql(
      `INSERT INTO participant_milestone (session_id, user_id, milestone_key, reached_at) VALUES ($1, $2, 'compact_signed', now())`,
      [ids.session, ids.bobUser],
    );
    me = { id: ids.bobUser, email: 'bob@e2e.test' };
    other = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const offered = async (who: { id: string; email: string }) => {
    const res = await http(who, 'get', `/sessions/${ids.session}/state`);
    expect(res.status).toBe(200);
    return res.body.data.progress.myProgress.feelHeardCheckOffered;
  };

  it('an AI offer in Stage 1 is stored on the participant’s own read state and read back on a fresh load', async () => {
    expect(await offered(me)).toBe(false);
    const { persistTurnState } = await import('../stream-turn-actions');
    const { resolveParticipant } = await import('../participant-resolver');
    await actingAs(me.id, async () => {
      const participant = (await resolveParticipant(ids.session, me.id))!;
      await persistTurnState({
        requestId: 'r-fho',
        sessionId: ids.session,
        userId: me.id,
        currentStage: 1,
        effectiveStage: 1,
        isInvitationPhase: false,
        session: { topicFrame: null, topicFrameConfirmedAt: new Date() },
        participant,
        userMessageId: 'm',
        userContent: 'that is it, really',
        aiMessageContent: 'It sounds like you have said what matters. Do you feel heard?',
        metadata: { offerFeelHeardCheck: true } as never,
      });
    });
    expect(await offered(me)).toBe(true);
    const progress = await http(me, 'get', `/sessions/${ids.session}/progress`);
    expect(progress.body.data.myProgress.feelHeardCheckOffered).toBe(true);

    // Private: the partner's reads carry nothing of it, and the database shows them no such row.
    expect(await offered(other)).toBe(false);
    const theirs = await http(other, 'get', `/sessions/${ids.session}/progress`);
    expect(JSON.stringify(theirs.body.data.partnerProgress)).not.toContain('feelHeard');
    expect(
      await run.as(
        'mwf_app',
        other.id,
        `SELECT feel_heard_offered_at FROM conversation_read_state WHERE session_id = $1 AND user_id = $2`,
        [ids.session, me.id],
      ),
    ).toEqual([]);
  });

  it('answering clears it', async () => {
    const res = await http(me, 'post', `/sessions/${ids.session}/feel-heard`, { confirmed: true });
    expect(res.status).toBe(200);
    expect(
      await run.sql(
        `SELECT feel_heard_offered_at FROM conversation_read_state WHERE session_id = $1 AND user_id = $2`,
        [ids.session, me.id],
      ),
    ).toEqual([{ feel_heard_offered_at: null }]);
  });
});
