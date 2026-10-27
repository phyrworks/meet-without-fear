/**
 * TS-12 (work-a39h.11.25, the TS-9 leftovers), real roles on a clone of the
 * CREATED target fixture: the invitation lifecycle on `invitation`,
 * `participant`, `relationship_member` and `app.session_set_status`, over HTTP
 * as `mwf_app` with identity binding on.
 *
 *   - create: the session, the inviter's participant (display name, MAIN
 *     conversation, read state), the invitation by invited_by_participant_id;
 *   - accept: the invitee becomes a participant and the session ACTIVE through
 *     the status writer in one transaction (T-cardinality-1 at COMMIT);
 *     accepted_by_user_id stamped; a second accept refused;
 *   - decline: DECLINED, the session ABANDONED (by the job); a declined or an
 *     expired invitation never grants session access (W6 arm);
 *   - the inviter is named by display_name; nickname by the composite key.
 *
 * Replaces the Prisma-mock suites routes/__tests__/invitations.test.ts and
 * controllers/__tests__/confirm-invitation.test.ts (with job-path.target's
 * confirm-invitation case).
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { randomUUID } from 'crypto';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Http = Awaited<ReturnType<typeof httpAs>>;

describeTarget('invitations on the target, as mwf_app (the decline as the job)', () => {
  let run: TargetRun;
  let http: Http;
  let ada: { id: string; email: string };
  const carol = { id: randomUUID(), email: `carol-${process.pid}@e2e.test` };
  const dan = { id: randomUUID(), email: `dan-${process.pid}@e2e.test` };
  const erin = { id: randomUUID(), email: `erin-${process.pid}@e2e.test` };

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `ts12_invitations_${process.pid}`);
    const ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  /** Make a created session acceptable (the topic frame and the invitation message confirmed, INVITED). */
  const ready = async (sessionId: string) => {
    await run.sql(`UPDATE session SET topic_frame = 'the chores', topic_frame_confirmed_at = now() WHERE id = $1`, [sessionId]);
    await run.sql(`UPDATE invitation SET message_confirmed_at = now() WHERE session_id = $1`, [sessionId]);
    await run.as('mwf_job', null, `SELECT app.session_set_status($1::uuid, 'INVITED')`, [sessionId]);
  };

  it('create, read, accept: participants and the status writer, never a write of session.status by the app', async () => {
    const created = await http(ada, 'post', '/sessions', { inviteName: 'Carol' });
    expect(created.status).toBe(201);
    const sessionId = created.body.data.session.id;
    const invitationId = created.body.data.invitationId;

    const parts = await run.sql<{ user_id: string; display_name: string | null; main: number; read_state: number }>(
      `SELECT p.user_id, p.display_name,
              (SELECT count(*)::int FROM conversation c WHERE c.participant_id = p.id AND c.kind = 'MAIN') AS main,
              (SELECT count(*)::int FROM conversation_read_state r WHERE r.participant_id = p.id) AS read_state
       FROM participant p WHERE p.session_id = $1`,
      [sessionId],
    );
    expect(parts).toEqual([{ user_id: ada.id, display_name: 'Ada Lovelace', main: 1, read_state: 1 }]);
    const [inv] = await run.sql<{ invited_by: string; name: string; status: string }>(
      `SELECT p.user_id AS invited_by, i.name, i.status::text AS status FROM invitation i JOIN participant p ON p.id = i.invited_by_participant_id WHERE i.id = $1`,
      [invitationId],
    );
    expect(inv).toEqual({ invited_by: ada.id, name: 'Carol', status: 'PENDING' });

    expect((await http(carol, 'get', `/invitations/${invitationId}`)).body.data.invitation).toMatchObject({
      invitedBy: { name: 'Ada Lovelace' },
      status: 'PENDING',
      session: { id: sessionId, status: 'CREATED' },
    });
    expect((await http(carol, 'post', `/invitations/${invitationId}/accept`)).status).toBe(400); // not ready
    expect((await http(ada, 'post', `/invitations/${invitationId}/accept`)).status).toBe(400); // own invitation

    await ready(sessionId);
    const ack = await http(carol, 'post', `/invitations/${invitationId}/acknowledge`);
    expect(ack.body.data).toMatchObject({ acknowledged: true, invitation: { invitedBy: { id: ada.id, name: 'Ada Lovelace' } } });

    const accepted = await http(carol, 'post', `/invitations/${invitationId}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.session.status).toBe('ACTIVE');
    expect(accepted.body.data.session.members.map((m: { id: string }) => m.id).sort()).toEqual([ada.id, carol.id].sort());
    expect(await run.sql(`SELECT status::text AS status, accepted_by_user_id FROM invitation WHERE id = $1`, [invitationId])).toEqual([
      { status: 'ACCEPTED', accepted_by_user_id: carol.id },
    ]);
    expect(await run.sql(`SELECT count(*)::int AS n FROM participant WHERE session_id = $1 AND user_id = $2`, [sessionId, carol.id])).toEqual([{ n: 1 }]);
    expect((await http(carol, 'post', `/invitations/${invitationId}/accept`)).status).toBe(400); // already accepted
    expect((await http(carol, 'get', `/sessions/${sessionId}/state`)).status).toBe(200);

    // Nickname by the composite key
    const [rel] = await run.sql<{ relationship_id: string }>(`SELECT relationship_id FROM session WHERE id = $1`, [sessionId]);
    const nick = await http(ada, 'patch', `/relationships/${rel.relationship_id}/nickname`, { nickname: 'Caz' });
    expect(nick.body.data).toEqual({ nickname: 'Caz' });
  });

  it('decline: DECLINED and ABANDONED (by the job); a declined or expired invitation never grants access', async () => {
    const created = await http(ada, 'post', '/sessions', { inviteName: 'Dan' });
    const sessionId = created.body.data.session.id;
    await ready(sessionId);
    // The live PENDING arm admits the invitee (the handler then finds no participant: 404, not 403).
    // (Not /state: under the E2E bypass that read auto-accepts a pending invitation.)
    expect((await http(dan, 'get', `/sessions/${sessionId}/emotions`)).status).toBe(404);
    const declined = await http(dan, 'post', `/invitations/${created.body.data.invitationId}/decline`, { reason: 'not now' });
    expect(declined.status).toBe(200);
    expect(await run.sql(`SELECT status::text AS status FROM session WHERE id = $1`, [sessionId])).toEqual([{ status: 'ABANDONED' }]);
    expect(await run.sql(`SELECT status::text AS status, decline_reason FROM invitation WHERE session_id = $1`, [sessionId])).toEqual([
      { status: 'DECLINED', decline_reason: 'not now' },
    ]);
    expect((await http(dan, 'get', `/sessions/${sessionId}/emotions`)).status).toBe(403);

    const other = await http(ada, 'post', '/sessions', { inviteName: 'Erin' });
    await run.sql(`UPDATE invitation SET expires_at = now() - interval '1 minute' WHERE session_id = $1`, [other.body.data.session.id]);
    expect((await http(erin, 'get', `/sessions/${other.body.data.session.id}/emotions`)).status).toBe(403);
    expect((await http(erin, 'post', `/invitations/${other.body.data.invitationId}/accept`)).status).toBe(410);
  });
});
