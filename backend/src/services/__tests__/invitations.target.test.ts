/**
 * TS-12 (work-a39h.11.25, the TS-9 leftovers), real roles on a clone of the
 * CREATED target fixture: the invitation lifecycle on `invitation`,
 * `participant`, `user_contact` and `app.session_set_status`, over HTTP
 * as `mwf_app` with identity binding on.
 *
 *   - create: the session, the inviter's participant (display name, MAIN
 *     conversation, read state), the invitation by invited_by_user_id;
 *   - accept: the invitee becomes a participant (added by the inviter,
 *     work-k5fk.2) and the session ACTIVE through the status writer in one
 *     transaction (T-cardinality-1 at COMMIT); the pair is a live_session_pair
 *     row; accepted_by_user_id stamped; a second accept refused;
 *   - decline: DECLINED, the session ABANDONED (by the job); a declined or an
 *     expired invitation never grants session access (W6 arm);
 *   - the inviter is named by display_name; the invite name is the inviter's
 *     user_contact nickname for the invitee, edited by PATCH /contacts/:userId/nickname.
 *
 * Replaces the Prisma-mock suites routes/__tests__/invitations.test.ts and
 * controllers/__tests__/confirm-invitation.test.ts (with job-path.target's
 * confirm-invitation case).
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndInvitee, httpAs, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Http = Awaited<ReturnType<typeof httpAs>>;

describeTarget('invitations on the target, as mwf_app (the decline as the job)', () => {
  let run: TargetRun;
  let http: Http;
  let ada: { id: string; email: string };
  const carol = { id: randomUuidV7(), email: `carol-${process.pid}@e2e.test` };
  const dan = { id: randomUuidV7(), email: `dan-${process.pid}@e2e.test` };
  const erin = { id: randomUuidV7(), email: `erin-${process.pid}@e2e.test` };

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `ts12_invitations_${process.pid}`);
    const ids = await adaAndInvitee(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  /** Make a created session acceptable (the topic frame and the invitation message confirmed, INVITED). */
  const ready = async (sessionId: string) => {
    await run.sql(`UPDATE session SET topic_frame = 'the chores', topic_frame_confirmed_at = now() WHERE id = $1`, [
      sessionId,
    ]);
    await run.sql(`UPDATE invitation SET message_confirmed_at = now() WHERE session_id = $1`, [sessionId]);
    await run.sql(`UPDATE session SET status = 'INVITED' WHERE id = $1::uuid`, [sessionId]);
  };

  it('create, read, accept: participants and the status writer, never a write of session.status by the app', async () => {
    const created = await http(ada, 'post', '/sessions', { inviteName: 'Carol' });
    expect(created.status).toBe(201);
    const sessionId = created.body.data.session.id;
    const invitationId = created.body.data.invitationId;

    const parts = await run.sql<{ user_id: string; display_name: string | null; main: number; read_state: number }>(
      `SELECT p.user_id, p.display_name,
              (SELECT count(*)::int FROM conversation c WHERE c.session_id = p.session_id AND c.user_id = p.user_id AND c.kind = 'MAIN') AS main,
              (SELECT count(*)::int FROM conversation_read_state r WHERE r.session_id = p.session_id AND r.user_id = p.user_id) AS read_state
       FROM participant p WHERE p.session_id = $1`,
      [sessionId],
    );
    expect(parts).toEqual([{ user_id: ada.id, display_name: 'Ada Lovelace', main: 1, read_state: 1 }]);
    const [inv] = await run.sql<{ invited_by: string; invitee_name: string; status: string }>(
      `SELECT p.user_id AS invited_by, i.invitee_name, i.status::text AS status FROM invitation i JOIN participant p ON p.session_id = i.session_id AND p.user_id = i.invited_by_user_id WHERE i.id = $1`,
      [invitationId],
    );
    expect(inv).toEqual({ invited_by: ada.id, invitee_name: 'Carol', status: 'PENDING' });

    expect((await http(carol, 'get', `/invitations/${invitationId}`)).body.data.invitation).toMatchObject({
      invitedBy: { name: 'Ada Lovelace' },
      status: 'PENDING',
      session: { id: sessionId, status: 'CREATED' },
    });
    expect((await http(carol, 'post', `/invitations/${invitationId}/accept`)).status).toBe(400); // not ready
    expect((await http(ada, 'post', `/invitations/${invitationId}/accept`)).status).toBe(400); // own invitation

    await ready(sessionId);
    const ack = await http(carol, 'post', `/invitations/${invitationId}/acknowledge`);
    expect(ack.body.data).toMatchObject({
      acknowledged: true,
      invitation: { invitedBy: { id: ada.id, name: 'Ada Lovelace' } },
    });

    const accepted = await http(carol, 'post', `/invitations/${invitationId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.session.status).toBe('ACTIVE');
    expect(accepted.body.data.session.members.map((m: { id: string }) => m.id).sort()).toEqual(
      [ada.id, carol.id].sort(),
    );
    expect(
      await run.sql(`SELECT status::text AS status, accepted_by_user_id FROM invitation WHERE id = $1`, [invitationId]),
    ).toEqual([{ status: 'ACCEPTED', accepted_by_user_id: carol.id }]);
    expect(
      await run.sql(`SELECT count(*)::int AS n FROM participant WHERE session_id = $1 AND user_id = $2`, [
        sessionId,
        carol.id,
      ]),
    ).toEqual([{ n: 1 }]);
    expect((await http(carol, 'post', `/invitations/${invitationId}/accept`)).status).toBe(400); // already accepted
    expect((await http(carol, 'get', `/sessions/${sessionId}/state`)).status).toBe(200);

    // work-k5fk.2: the inviter added the invitee; the two are a live pair.
    expect(
      await run.sql(
        `SELECT user_id, added_by_user_id FROM participant WHERE session_id = $1 ORDER BY joined_at, user_id`,
        [sessionId],
      ),
    ).toEqual([
      { user_id: ada.id, added_by_user_id: null },
      { user_id: carol.id, added_by_user_id: ada.id },
    ]);
    expect(
      await run.sql(`SELECT count(*)::int AS n FROM live_session_pair WHERE session_id = $1`, [sessionId]),
    ).toEqual([{ n: 1 }]);

    // The invite name is what Ada calls Carol, resolved from Ada's own invitation (nothing written into Ada's
    // rows by Carol's accept, review round 1 Q1); the nickname route writes Ada's own user_contact entry.
    expect(await run.sql(`SELECT count(*)::int AS n FROM user_contact WHERE contact_user_id = $1`, [carol.id])).toEqual(
      [{ n: 0 }],
    );
    expect((await http(ada, 'get', `/sessions/${sessionId}`)).body.data.session.partner).toMatchObject({
      id: carol.id,
      nickname: 'Carol',
    });
    const nick = await http(ada, 'patch', `/contacts/${carol.id}/nickname`, { nickname: 'Caz' });
    expect(nick.body.data).toEqual({ nickname: 'Caz' });
    expect(
      await run.sql(`SELECT nickname FROM user_contact WHERE user_id = $1 AND contact_user_id = $2`, [
        ada.id,
        carol.id,
      ]),
    ).toEqual([{ nickname: 'Caz' }]);
  });

  it('decline: DECLINED and ABANDONED (by the job); a declined or expired invitation never grants access', async () => {
    const created = await http(ada, 'post', '/sessions', { inviteName: 'Dan' });
    const sessionId = created.body.data.session.id;
    await ready(sessionId);
    // The live PENDING arm admits the invitee (the handler then finds no participant: 404, not 403).
    // (Not /state: under the E2E bypass that read auto-accepts a pending invitation.)
    expect((await http(dan, 'get', `/sessions/${sessionId}/emotions`)).status).toBe(404);
    const declined = await http(dan, 'post', `/invitations/${created.body.data.invitationId}/decline`, {
      reason: 'not now',
    });
    expect(declined.status).toBe(200);
    expect(await run.sql(`SELECT status::text AS status FROM session WHERE id = $1`, [sessionId])).toEqual([
      { status: 'ABANDONED' },
    ]);
    expect(
      await run.sql(
        `SELECT status::text AS status, decline_reason, claimed_by_user_id FROM invitation WHERE session_id = $1`,
        [sessionId],
      ),
    ).toEqual([{ status: 'DECLINED', decline_reason: 'not now', claimed_by_user_id: dan.id }]); // the answer claims it
    expect((await http(dan, 'get', `/sessions/${sessionId}/emotions`)).status).toBe(403);

    const other = await http(ada, 'post', '/sessions', { inviteName: 'Erin' });
    await run.sql(`UPDATE invitation SET expires_at = now() - interval '1 minute' WHERE session_id = $1`, [
      other.body.data.session.id,
    ]);
    expect((await http(erin, 'get', `/sessions/${other.body.data.session.id}/emotions`)).status).toBe(403);
    expect((await http(erin, 'post', `/invitations/${other.body.data.invitationId}/accept`)).status).toBe(410);
  });

  // work-k5fk.10.8 (owner decision 2026-11-23): the first signed-in non-inviter to open the invitation is its invitee.
  it('first opener claims: only they read past the claim notice, accept or decline; the inviter sees who', async () => {
    const fay = { id: randomUuidV7(), email: `fay-${process.pid}@e2e.test` };
    const gus = { id: randomUuidV7(), email: `gus-${process.pid}@e2e.test` };
    const created = await http(ada, 'post', '/sessions', { inviteName: 'Fay' });
    const sessionId = created.body.data.session.id;
    const invitationId = created.body.data.invitationId;
    await ready(sessionId);

    // Unclaimed, the link's preview is anyone's; opening it (acknowledge) claims it.
    expect((await http(gus, 'get', `/invitations/${invitationId}`)).status).toBe(200);
    expect((await http(fay, 'post', `/invitations/${invitationId}/acknowledge`)).body.data.acknowledged).toBe(true);
    const claim = await run.sql<{ claimed_by_user_id: string; claimed: boolean }>(
      `SELECT claimed_by_user_id, claimed_at IS NOT NULL AS claimed FROM invitation WHERE id = $1`,
      [invitationId],
    );
    expect(claim).toEqual([{ claimed_by_user_id: fay.id, claimed: true }]);
    // Opening it again changes nothing.
    expect((await http(fay, 'post', `/invitations/${invitationId}/acknowledge`)).status).toBe(200);

    // Anyone else: a refusal, and nothing moves (the decline would have abandoned Ada's session).
    for (const [method, path] of [
      ['get', `/invitations/${invitationId}`],
      ['post', `/invitations/${invitationId}/acknowledge`],
      ['post', `/invitations/${invitationId}/accept`],
      ['post', `/invitations/${invitationId}/decline`],
    ] as const) {
      const r = await http(gus, method, path, method === 'post' ? {} : undefined);
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
    expect((await http(gus, 'get', `/sessions/${sessionId}/emotions`)).status).toBe(403);
    expect(
      await run.sql(
        `SELECT i.status::text AS invitation, s.status::text AS session FROM invitation i JOIN session s ON s.id = i.session_id WHERE i.id = $1`,
        [invitationId],
      ),
    ).toEqual([{ invitation: 'PENDING', session: 'INVITED' }]);

    // The inviter sees who claimed it, in both of their invitation views.
    const claimedBy = { id: fay.id, claimedAt: expect.any(String) };
    expect((await http(ada, 'get', `/sessions/${sessionId}/invitation`)).body.data.invitation.claimedBy).toMatchObject(
      claimedBy,
    );
    expect((await http(ada, 'get', `/sessions/${sessionId}/state`)).body.data.invitation.claimedBy).toMatchObject(
      claimedBy,
    );

    // The claimer still reads the details and accepts.
    expect((await http(fay, 'get', `/invitations/${invitationId}`)).body.data.invitation).toMatchObject({
      invitedBy: { name: 'Ada Lovelace' },
      status: 'PENDING',
    });
    expect((await http(fay, 'post', `/invitations/${invitationId}/accept`)).status).toBe(200);
    expect(
      await run.sql(`SELECT accepted_by_user_id, claimed_by_user_id FROM invitation WHERE id = $1`, [invitationId]),
    ).toEqual([{ accepted_by_user_id: fay.id, claimed_by_user_id: fay.id }]);
  });

  it('the database: one claim wins, the answer is the claimer’s, accepted_by is the claimer', async () => {
    const hal = { id: randomUuidV7(), email: `hal-${process.pid}@e2e.test` };
    const ivy = { id: randomUuidV7(), email: `ivy-${process.pid}@e2e.test` };
    // Users exist once they have made a request (the E2E bypass creates them).
    for (const u of [hal, ivy]) await http(u, 'get', '/sessions');
    const created = await http(ada, 'post', '/sessions', { inviteName: 'Hal' });
    const invitationId = created.body.data.invitationId;
    await ready(created.body.data.session.id);
    const code = (userId: string, text: string) =>
      run.as('mwf_app', userId, text, [invitationId]).then(
        () => 'ok',
        (e: { code?: string }) => e.code ?? String(e),
      );

    expect(await code(ada.id, `SELECT app.invitation_claim($1::uuid)`)).toBe('P0002'); // the inviter
    expect(await code(hal.id, `SELECT app.invitation_claim($1::uuid)`)).toBe('ok');
    expect(await code(hal.id, `SELECT app.invitation_claim($1::uuid)`)).toBe('ok'); // idempotent
    expect(await code(ivy.id, `SELECT app.invitation_claim($1::uuid)`)).toBe('MWI01');
    expect(await code(ivy.id, `SELECT app.invitation_answer($1::uuid, 'DECLINED')`)).toBe('MWI01');
    expect(await code(ivy.id, `SELECT app.invitation_answer($1::uuid, 'ACCEPTED')`)).toBe('MWI01');
    // Past the claim notice: nothing of the invitation for anyone else.
    expect(
      await run.as(
        'mwf_app',
        ivy.id,
        `SELECT withheld, session_id, invited_by_user_id, invitee_name FROM app.invitation_peek($1::uuid)`,
        [invitationId],
      ),
    ).toEqual([{ withheld: true, session_id: null, invited_by_user_id: null, invitee_name: null }]);
    expect(
      await run.as('mwf_app', ada.id, `SELECT withheld, claimed_by_user_id FROM app.invitation_peek($1::uuid)`, [
        invitationId,
      ]),
    ).toEqual([{ withheld: false, claimed_by_user_id: hal.id }]);
    // The table refuses an acceptor who is not the claimer, and the inviter as claimer.
    expect(
      await run
        .sql(`UPDATE invitation SET status = 'ACCEPTED', accepted_by_user_id = $2, accepted_at = now() WHERE id = $1`, [
          invitationId,
          ivy.id,
        ])
        .then(
          () => 'ok',
          (e: { constraint?: string }) => e.constraint,
        ),
    ).toBe('invitation_check3');
    expect(
      await run.sql(`UPDATE invitation SET claimed_by_user_id = invited_by_user_id WHERE id = $1`, [invitationId]).then(
        () => 'ok',
        (e: { constraint?: string }) => e.constraint,
      ),
    ).toBe('invitation_check2');
  });
});
