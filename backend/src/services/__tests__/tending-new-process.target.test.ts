/**
 * Review services F5 (work-k5fk.34): a Tending "New process" check-in resolves the session and starts a follow-up
 * session linked to it. The partner joins it the one way a human is seated on the target — by accepting an
 * invitation — so the new session is created as createSession creates one: the caller's seat, conversation and read
 * state, and a PENDING invitation named for the partner. Before, it had no invitation, so the partner could never
 * join it and never saw it.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { actingAs, adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('Tending NEW_PROCESS: the follow-up session can seat the partner (review services F5)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `b3_newproc_${process.pid}`);
    ids = await adaAndBob(run);
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('the new session has the caller’s invitation for the partner, and the partner joins it by accepting', async () => {
    // Ada's own (INDIVIDUAL) follow-up: a shared one is held for coordination until both check in.
    await run.sql(
      `INSERT INTO follow_up (session_id, type, scope, status, owner_user_id, scheduled_for, opened_at, summary)
       VALUES ($1, 'SCHEDULED_INDIVIDUAL_COMMITMENT', 'INDIVIDUAL', 'OPEN', $2, now() - interval '1 day', now(), 'Check in')`,
      [ids.session, ids.adaUser],
    );
    const tending = await import('../tending.service');
    const result = await actingAs(ids.adaUser, () =>
      tending.submitTendingCheckin({
        sessionId: ids.session,
        userId: ids.adaUser,
        orientations: {
          whatWorked: { reflection: '' },
          whereMoreSupport: { reflection: '' },
          whatComesNext: { continueChoice: 'NEW_PROCESS' as never },
        },
      }),
    );
    const linked = result.newSessionId!;
    expect(linked).toBeTruthy();
    expect(
      await run.sql(`SELECT status::text AS status, previous_session_id::text AS prev FROM session WHERE id = $1`, [
        linked,
      ]),
    ).toEqual([{ status: 'CREATED', prev: ids.session }]);
    const [invitation] = await run.sql<{ id: string; by: string; status: string; name: string | null }>(
      `SELECT id::text, invited_by_user_id::text AS by, status::text AS status, invitee_name AS name
       FROM invitation WHERE session_id = $1`,
      [linked],
    );
    expect(invitation).toMatchObject({ by: ids.adaUser, status: 'PENDING' });
    expect(invitation.name).toMatch(/Bob/);
    expect(
      await run.sql(`SELECT count(*)::int AS n FROM conversation_read_state WHERE session_id = $1 AND user_id = $2`, [
        linked,
        ids.adaUser,
      ]),
    ).toEqual([{ n: 1 }]);

    // Ada's Stage 0 there, as for any new session: she confirms the topic and the invitation message (the link is
    // then ready to share), and the partner accepts it and is seated — the follow-up is then in his session list.
    const ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    expect((await http(ada, 'post', `/sessions/${linked}/topic-frame/confirm`)).status).toBe(200);
    expect((await http(ada, 'post', `/sessions/${linked}/invitation/confirm`, { message: 'Shall we start again?' })).status).toBe(200);
    const bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    const accepted = await http(bob, 'post', `/invitations/${invitation.id}/accept`);
    expect(accepted.status).toBe(200);
    const list = await http(bob, 'get', '/sessions');
    expect((list.body.data.items as Array<{ id: string }>).map(s => s.id)).toContain(linked);
  });
});
