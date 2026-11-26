/**
 * Review schema S4 / services "inviter leaves" (work-k5fk.33): every path that
 * ends a session ABANDONED withdraws its PENDING invitations (EXPIRED), so the
 * link no longer previews as open, no longer claims, and an accept answers 410
 * (before: PENDING on an ABANDONED session — the link claimed, then accept
 * answered 400 "not ready"). The invitations are locked before the session
 * (the accept's lock order), as app.session_archive does.
 *
 *   - the inviter deletes the session (app.anonymize_user_in_session step 1);
 *   - app.session_set_status → ABANDONED (the "Start New Anyway" route ends a
 *     live session this way; here a CREATED one, which still has its invitation);
 *   - a decline still ends its session (app.session_abandon_declined, now in
 *     one transaction with the answer).
 *
 * CREATED clone, app over HTTP as mwf_app with identity binding on.
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndInvitee, httpAs, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('an ABANDONED session withdraws its PENDING invitation (review schema S4)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ada: { id: string; email: string };
  const carol = { id: randomUuidV7(), email: `carol-${process.pid}@e2e.test` };
  const dan = { id: randomUuidV7(), email: `dan-${process.pid}@e2e.test` };

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `k5fk33_inv_${process.pid}`);
    const ids = await adaAndInvitee(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  /** A new session of Ada's, made acceptable (topic frame and invitation message confirmed, INVITED). */
  const invitedSession = async (inviteName: string) => {
    const created = await http(ada, 'post', '/sessions', { inviteName });
    expect(created.status).toBe(201);
    const sessionId: string = created.body.data.session.id;
    const invitationId: string = created.body.data.invitationId;
    await run.sql(`UPDATE session SET topic_frame = 'the chores', topic_frame_confirmed_at = now() WHERE id = $1`, [
      sessionId,
    ]);
    await run.sql(`UPDATE invitation SET message_confirmed_at = now() WHERE session_id = $1`, [sessionId]);
    await run.sql(`UPDATE session SET status = 'INVITED' WHERE id = $1::uuid`, [sessionId]);
    return { sessionId, invitationId };
  };
  const statusOf = async (sessionId: string) =>
    (
      await run.sql<{ session: string; invitation: string }>(
        `SELECT s.status::text AS session, i.status::text AS invitation
         FROM session s JOIN invitation i ON i.session_id = s.id WHERE s.id = $1`,
        [sessionId],
      )
    )[0];

  it('the inviter deletes the session: the invitation is EXPIRED, does not claim, and accept answers 410', async () => {
    const { sessionId, invitationId } = await invitedSession('Carol');
    expect(await statusOf(sessionId)).toEqual({ session: 'INVITED', invitation: 'PENDING' });

    expect((await http(ada, 'delete', `/sessions/${sessionId}`)).status).toBe(200);
    expect(await statusOf(sessionId)).toEqual({ session: 'ABANDONED', invitation: 'EXPIRED' });

    expect((await http(carol, 'get', `/invitations/${invitationId}`)).body.data.invitation).toMatchObject({
      status: 'EXPIRED',
    });
    const ack = await http(carol, 'post', `/invitations/${invitationId}/acknowledge`);
    expect(ack.status).toBe(200);
    expect(ack.body.data).toMatchObject({ acknowledged: false, reason: 'expired' });
    expect(await run.sql(`SELECT claimed_by_user_id FROM invitation WHERE id = $1`, [invitationId])).toEqual([
      { claimed_by_user_id: null },
    ]);
    expect((await http(carol, 'post', `/invitations/${invitationId}/accept`)).status).toBe(410);
  });

  it('app.session_set_status → ABANDONED withdraws the PENDING invitation in the same move', async () => {
    const { sessionId } = await invitedSession('Carol');
    await run.as('mwf_app', ada.id, `SELECT app.session_set_status($1::uuid, 'ABANDONED'::session_status)`, [
      sessionId,
    ]);
    expect(await statusOf(sessionId)).toEqual({ session: 'ABANDONED', invitation: 'EXPIRED' });
  });

  it('a decline ends its session: the invitation DECLINED, the session ABANDONED', async () => {
    const { sessionId, invitationId } = await invitedSession('Dan');
    expect((await http(dan, 'post', `/invitations/${invitationId}/acknowledge`)).body.data.acknowledged).toBe(true);
    expect((await http(dan, 'post', `/invitations/${invitationId}/decline`, { reason: 'not now' })).status).toBe(200);
    expect(await statusOf(sessionId)).toEqual({ session: 'ABANDONED', invitation: 'DECLINED' });
  });
});
