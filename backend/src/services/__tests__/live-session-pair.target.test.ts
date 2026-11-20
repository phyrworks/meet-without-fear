/**
 * work-k5fk.2 (design note §2, §4; owner decision Q3): who is in a session
 * without `relationship`, on a clone of the CREATED target fixture, over HTTP
 * as `mwf_app` with identity binding on and in SQL as the real roles.
 *
 *   - one live session per pair of HUMANS is `live_session_pair`'s key: a
 *     second live session for the same pair fails with unique_violation
 *     (23505, live_session_pair_pkey) at the moment its second human joins —
 *     the session itself was created fine — and the accept answers 409; once
 *     the first session is RESOLVED the pair may start again;
 *   - the AI and a persona sit as `ai` / `persona` participants: they create
 *     no pair, block no pair, and never count toward session readiness
 *     (v_session_readiness); a seat's kind is its user's kind (FK
 *     participant_user_id_kind_fkey, work-k5fk.3), so a human cannot be seated
 *     as the AI, nor the AI or a persona as human; a persona is seated only by
 *     its owner;
 *   - `participant.added_by_user_id`: the initiator has none, the invitee is
 *     added by the inviter; a second initiator is refused
 *     (sql_participant_one_initiator);
 *   - nicknames are `user_contact` rows, private to their owner: PATCH
 *     /contacts/:userId/nickname writes the caller's own entry only, a
 *     partner reads their own (never the other's), a user the caller shares
 *     no session with is not found;
 *   - the invite-time pre-check (createSession with personId): an existing
 *     live session with that person comes back as existingActiveSession, and
 *     forceCreate gives a friendly 409 instead of a second session;
 *   - no session DTO carries relationshipId.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { actingAs, adaAndInvitee, httpAs, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Http = Awaited<ReturnType<typeof httpAs>>;

describeTarget('live_session_pair, participant.added_by_user_id and user_contact (work-k5fk.2)', () => {
  let run: TargetRun;
  let http: Http;
  let ada: { id: string; email: string };
  let aiUser: string;
  const pid = process.pid;
  const person = (name: string) => ({ id: randomUuidV7(), email: `${name}-${pid}@e2e.test` });
  const ken = person('ken');
  const lea = person('lea');
  const max = person('max');

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `k5fk2_pair_${pid}`);
    const ids = await adaAndInvitee(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
    [{ id: aiUser }] = await run.sql<{ id: string }>(`SELECT app.ai_user_id()::text AS id`);
    // Materialise the bypass users (the E2E bypass creates a user on first request).
    for (const u of [ken, lea, max]) expect((await http(u, 'get', '/sessions')).status).toBe(200);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  /** Ada creates a session by invite link and makes it acceptable (topic frame, message confirmed, INVITED). */
  const invite = async (inviteName: string, body: object = {}) => {
    const created = await http(ada, 'post', '/sessions', { inviteName, ...body });
    expect(created.status).toBe(201);
    const sessionId: string = created.body.data.session.id;
    await run.sql(`UPDATE session SET topic_frame = 'the chores', topic_frame_confirmed_at = now() WHERE id = $1`, [
      sessionId,
    ]);
    await run.sql(`UPDATE invitation SET message_confirmed_at = now() WHERE session_id = $1`, [sessionId]);
    await run.sql(`UPDATE session SET status = 'INVITED' WHERE id = $1::uuid`, [sessionId]);
    return { sessionId, invitationId: created.body.data.invitationId as string };
  };
  const pairsOf = (sessionId: string) =>
    run.sql<{ user_a: string; user_b: string }>(
      `SELECT user_a::text, user_b::text FROM live_session_pair WHERE session_id = $1 ORDER BY 1, 2`,
      [sessionId],
    );
  const sorted = (a: string, b: string) => (a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a });
  /** The SQLSTATE and constraint of a failing statement. */
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      return { code: err.code, constraint: err.constraint };
    }
    throw new Error('expected the statement to fail');
  };

  it('a second live session for the same human pair fails with 23505 at the second human’s join, not before', async () => {
    const first = await invite('Ken');
    const accepted = await http(ken, 'post', `/invitations/${first.invitationId}/accept`);
    expect(accepted.status).toBe(200);
    expect(await pairsOf(first.sessionId)).toEqual([sorted(ada.id, ken.id)]);

    // The second session is created fine (no invitee is known yet) …
    const second = await invite('Ken again');
    expect(await pairsOf(second.sessionId)).toEqual([]);

    // … and the database refuses Ken's join with the pair key. (Written by the superuser: the app role seats a human
    // only as the invitee of an invitation they accepted — participant app_insert, work-k5fk.10.7 — and the accept,
    // below, is that path.)
    expect(
      await failure(
        run.sql(
          `INSERT INTO participant (session_id, user_id, kind, added_by_user_id, display_name) VALUES ($1, $2, 'human', $3, 'Ken')`,
          [second.sessionId, ken.id, ada.id],
        ),
      ),
    ).toEqual({ code: '23505', constraint: 'live_session_pair_pkey' });

    // Over HTTP the accept answers a friendly 409 and changes nothing.
    const refused = await http(ken, 'post', `/invitations/${second.invitationId}/accept`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT');
    expect(refused.body.error.message).toMatch(/already .*session/i);
    expect(
      await run.sql(
        `SELECT s.status::text AS status, i.status::text AS invitation,
                (SELECT count(*)::int FROM participant p WHERE p.session_id = s.id) AS participants
         FROM session s JOIN invitation i ON i.session_id = s.id WHERE s.id = $1`,
        [second.sessionId],
      ),
    ).toEqual([{ status: 'INVITED', invitation: 'PENDING', participants: 1 }]);

    // Once the first session is no longer live the pair is released and the join succeeds.
    await run.as(
      'mwf_worker',
      null,
      `SELECT app.session_set_status($1::uuid, 'RESOLVED')`,
      [first.sessionId],
      first.sessionId,
    );
    expect(await pairsOf(first.sessionId)).toEqual([]);
    expect((await http(ken, 'post', `/invitations/${second.invitationId}/accept`)).status).toBe(200);
    expect(await pairsOf(second.sessionId)).toEqual([sorted(ada.id, ken.id)]);
  });

  it('the AI and a persona are non-human seats: they make and block no pair, and never count toward readiness', async () => {
    const s = await invite('Lea');
    expect((await http(lea, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    const [persona] = await run.sql<{ id: string }>(
      `WITH u AS (INSERT INTO "user" (kind, first_name) VALUES ('persona', 'Imagined Lea') RETURNING id)
       INSERT INTO persona (user_id, owner_user_id) SELECT id, $1 FROM u RETURNING user_id::text AS id`,
      [ada.id],
    );
    const seat = (userId: string, kind: string, addedBy: string, sessionId = s.sessionId) =>
      run.as(
        'mwf_app',
        addedBy,
        `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, $3, $4) RETURNING user_id::text AS user_id`,
        [sessionId, userId, kind, addedBy],
      );

    // Neither kind of non-human seat can pose as a human, and a human cannot sit as the AI or a persona:
    // a seat's kind is its user's kind, pinned by the FK (user_id, kind) -> "user" (work-k5fk.3).
    const kindRefused = { code: '23503', constraint: 'participant_user_id_kind_fkey' };
    // (A human seat the app never writes for another user — participant app_insert, work-k5fk.10.7 — so the FK is
    // shown by the superuser; the app's refusal of it is rls-cross-user.target.test.ts's.)
    const seatHuman = (userId: string) =>
      run.sql(`INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'human', $3)`, [
        s.sessionId,
        userId,
        ada.id,
      ]);
    expect(await failure(seatHuman(aiUser))).toEqual(kindRefused);
    expect(await failure(seatHuman(persona.id))).toEqual(kindRefused);
    expect(await failure(seat(max.id, 'ai', ada.id))).toEqual(kindRefused);
    expect(await failure(seat(max.id, 'persona', ada.id))).toEqual(kindRefused);
    // A persona is seated by its owner only (t_participant_added_by); the AI and a persona always have an adder.
    expect(await failure(seat(persona.id, 'persona', lea.id))).toEqual({ code: '23514', constraint: undefined });
    expect(
      await failure(
        run.as('mwf_app', ada.id, `INSERT INTO participant (session_id, user_id, kind) VALUES ($1, $2, 'ai')`, [
          s.sessionId,
          aiUser,
        ]),
      ),
      // work-k5fk.10.7: refused by participant app_insert (an adder-less seat is the caller's own, as initiator)
      // before participant_check (only a human starts a session) is reached.
    ).toEqual({ code: '42501', constraint: undefined });

    const [aiSeat] = await seat(aiUser, 'ai', ada.id);
    const [personaSeat] = await seat(persona.id, 'persona', ada.id);
    expect(aiSeat.user_id).toBe(aiUser);
    expect(personaSeat.user_id).toBe(persona.id);
    // Only the human pair is a pair.
    expect(await pairsOf(s.sessionId)).toEqual([sorted(ada.id, lea.id)]);

    // A second live session of Ada with the AI and the persona is no pair conflict either.
    const solo = await http(ada, 'post', '/sessions', { inviteName: 'nobody yet' });
    expect(solo.status).toBe(201);
    await seat(aiUser, 'ai', ada.id, solo.body.data.session.id);
    await seat(persona.id, 'persona', ada.id, solo.body.data.session.id);
    expect(await pairsOf(solo.body.data.session.id)).toEqual([]);

    // Readiness: compact_signed (session scope) waits on the two humans only.
    const readiness = () =>
      run.sql<{ all_reached: boolean; waiting: number }>(
        `SELECT all_reached, cardinality(waiting_on) AS waiting FROM v_session_readiness
         WHERE session_id = $1 AND milestone_key = 'compact_signed'`,
        [s.sessionId],
      );
    expect(await readiness()).toEqual([{ all_reached: false, waiting: 2 }]);
    await run.sql(
      `INSERT INTO participant_milestone (session_id, user_id, milestone_key)
       SELECT p.session_id, p.user_id, 'compact_signed' FROM participant p WHERE p.session_id = $1 AND p.kind = 'human'`,
      [s.sessionId],
    );
    expect(await readiness()).toEqual([{ all_reached: true, waiting: 0 }]);
  });

  it('records who added each participant: the initiator none, the invitee the inviter; one initiator per session', async () => {
    const s = await invite('Max');
    expect((await http(max, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    expect(
      await run.sql(
        `SELECT user_id::text, added_by_user_id::text FROM participant WHERE session_id = $1 ORDER BY joined_at, user_id`,
        [s.sessionId],
      ),
    ).toEqual([
      { user_id: ada.id, added_by_user_id: null },
      { user_id: max.id, added_by_user_id: ada.id },
    ]);
    // A second participant without an adder would be a second initiator.
    const other = person('other');
    expect((await http(other, 'get', '/sessions')).status).toBe(200);
    expect(
      await failure(
        run.sql(`INSERT INTO participant (session_id, user_id, kind) VALUES ($1, $2, 'human')`, [
          s.sessionId,
          other.id,
        ]),
      ),
    ).toEqual({ code: '23505', constraint: 'sql_participant_one_initiator' });
  });

  it('nicknames are the caller’s own user_contact entry: private to their owner', async () => {
    const s = await invite('Nell');
    const nell = person('nell');
    expect((await http(nell, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);

    // Review round 1 (Q1): Nell's accept writes nothing into Ada's rows. Ada still calls her by the invite
    // name, resolved at read time from Ada's own invitation (accepted_by_user_id = Nell).
    expect(
      await run.sql(`SELECT count(*)::int AS n FROM user_contact WHERE user_id = $1 AND contact_user_id = $2`, [
        ada.id,
        nell.id,
      ]),
    ).toEqual([{ n: 0 }]);
    expect((await http(ada, 'get', `/sessions/${s.sessionId}`)).body.data.session.partner).toMatchObject({
      id: nell.id,
      nickname: 'Nell',
      name: 'Nell',
    });

    const nick = await http(ada, 'patch', `/contacts/${nell.id}/nickname`, { nickname: 'Nelly' });
    expect(nick.status).toBe(200);
    expect(nick.body.data).toEqual({ nickname: 'Nelly' });
    expect((await http(ada, 'get', `/sessions/${s.sessionId}`)).body.data.session.partner).toMatchObject({
      id: nell.id,
      nickname: 'Nelly',
      name: 'Nelly',
    });

    // Nell reads her own (none), never Ada's word for her.
    const nellView = await http(nell, 'get', `/sessions/${s.sessionId}`);
    expect(nellView.body.data.session.partner).toMatchObject({ id: ada.id, nickname: null });
    for (const path of [`/sessions/${s.sessionId}`, `/sessions/${s.sessionId}/state`, '/sessions']) {
      expect(JSON.stringify((await http(nell, 'get', path)).body)).not.toContain('Nelly');
    }

    // Nell's own nickname for Ada is hers alone.
    expect((await http(nell, 'patch', `/contacts/${ada.id}/nickname`, { nickname: 'Ads' })).status).toBe(200);
    expect(
      await run.sql(
        `SELECT user_id::text, nickname FROM user_contact WHERE (user_id, contact_user_id) IN (($1, $2), ($2, $1)) ORDER BY nickname`,
        [ada.id, nell.id],
      ),
    ).toEqual([
      { user_id: nell.id, nickname: 'Ads' },
      { user_id: ada.id, nickname: 'Nelly' },
    ]);
    expect(JSON.stringify((await http(ada, 'get', `/sessions/${s.sessionId}`)).body)).not.toContain('Ads');

    // Clearing works; a user the caller shares no session with is not found; the old route is gone.
    expect((await http(ada, 'patch', `/contacts/${nell.id}/nickname`, { nickname: null })).body.data).toEqual({
      nickname: null,
    });
    // … and cleared means cleared (review round 2, N3): Ada's entry with a NULL nickname is authoritative, so the
    // invite name does not come back — the partner shows by their own names.
    const [nellUser] = await run.sql<{ first_name: string | null; name: string | null }>(
      `SELECT first_name, name FROM "user" WHERE id = $1`,
      [nell.id],
    );
    expect((await http(ada, 'get', `/sessions/${s.sessionId}`)).body.data.session.partner).toMatchObject({
      nickname: null,
      name: nellUser.first_name || nellUser.name || null,
    });
    expect(await (await import('../contacts')).getNicknameForSessionPartner(s.sessionId, ada.id)).toBeNull();
    // A blank nickname is refused by the route (and by the person_name domain).
    expect((await http(ada, 'patch', `/contacts/${nell.id}/nickname`, { nickname: '   ' })).status).toBe(400);
    expect(
      await failure(
        run.sql(`UPDATE user_contact SET nickname = '  ' WHERE user_id = $1 AND contact_user_id = $2`, [
          ada.id,
          nell.id,
        ]),
      ),
    ).toEqual({ code: '23514', constraint: 'person_name_check' }); // the person_name domain (work-k5fk.9, D1)
    const stranger = person('stranger');
    expect((await http(stranger, 'get', '/sessions')).status).toBe(200);
    expect((await http(ada, 'patch', `/contacts/${stranger.id}/nickname`, { nickname: 'S' })).status).toBe(404);
    expect((await http(ada, 'patch', `/contacts/${ada.id}/nickname`, { nickname: 'me' })).status).toBe(400);
    expect((await http(ada, 'patch', `/relationships/${randomUuidV7()}/nickname`, { nickname: 'x' })).status).toBe(404);
  });

  it('the invite-time pre-check: an existing live session with that person, and a friendly 409 on forceCreate', async () => {
    const s = await invite('Olaf');
    const olaf = person('olaf');
    expect((await http(olaf, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);

    const again = await http(ada, 'post', '/sessions', { personId: olaf.id });
    expect(again.status).toBe(200);
    expect(again.body.data.existingActiveSession).toMatchObject({ id: s.sessionId, status: 'ACTIVE' });

    const [{ before }] = await run.sql<{ before: number }>(`SELECT count(*)::int AS before FROM session`);
    const forced = await http(ada, 'post', '/sessions', { personId: olaf.id, forceCreate: true });
    expect(forced.status).toBe(409);
    expect(forced.body.error.code).toBe('CONFLICT');
    expect(forced.body.error.message).toMatch(/already .*session/i);
    // Nothing was written for the refused session.
    expect(await run.sql(`SELECT count(*)::int AS n FROM session`)).toEqual([{ n: before }]);
  });

  it('review F2: before the invitee joins, what the inviter calls them is the invite name (not "Partner")', async () => {
    const s = await invite('Zed');
    const contacts = await import('../contacts');
    expect(await actingAs(ada.id, () => contacts.getNicknameForSessionPartner(s.sessionId, ada.id))).toBe('Zed');
    expect(await actingAs(ada.id, () => contacts.loadSessionPartner(s.sessionId, ada.id))).toBeNull();
    const zed = person('zed');
    expect((await http(zed, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    // After the join: the invite name of the invitation Zed accepted (Ada's own row).
    expect(await actingAs(ada.id, () => contacts.getNicknameForSessionPartner(s.sessionId, ada.id))).toBe('Zed');
    expect(await actingAs(zed.id, () => contacts.getNicknameForSessionPartner(s.sessionId, zed.id))).toBeNull();
  });

  it('review F4: a NEW_PROCESS follow-up shows the partner of the session it continues', async () => {
    const s = await invite('Quin');
    const quin = person('quin');
    expect((await http(quin, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    // The follow-up as tending startLinkedProcess writes it: the caller alone, previous_session_id = the old session.
    const [f] = await run.sql<{ id: string }>(
      `INSERT INTO session (status, previous_session_id) VALUES ('CREATED', $1) RETURNING id::text`,
      [s.sessionId],
    );
    await run.sql(`INSERT INTO participant (session_id, user_id, display_name) VALUES ($1, $2, 'Ada')`, [f.id, ada.id]);
    await run.sql(
      `INSERT INTO conversation (session_id, user_id) SELECT session_id, user_id FROM participant WHERE session_id = $1`,
      [f.id],
    );
    const view = await http(ada, 'get', `/sessions/${f.id}`);
    expect(view.status).toBe(200);
    expect(view.body.data.session.partner).toMatchObject({ id: quin.id, name: 'Quin', nickname: 'Quin' });
    const list = await http(ada, 'get', '/sessions');
    expect(list.body.data.items.find((i: { id: string }) => i.id === f.id)?.partner).toMatchObject({ id: quin.id });
  });

  it('review round 2 N1: two follow-ups of one session, loaded in one batch, both show the partner', async () => {
    const s = await invite('Rhea');
    const rhea = person('rhea');
    expect((await http(rhea, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    const followUps: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [f] = await run.sql<{ id: string }>(
        `INSERT INTO session (status, previous_session_id) VALUES ('CREATED', $1) RETURNING id::text`,
        [s.sessionId],
      );
      await run.sql(`INSERT INTO participant (session_id, user_id, display_name) VALUES ($1, $2, 'Ada')`, [
        f.id,
        ada.id,
      ]);
      followUps.push(f.id);
    }
    const contacts = await import('../contacts');
    const partners = await actingAs(ada.id, () => contacts.loadSessionPartners(followUps, ada.id));
    expect(followUps.map(f => partners.get(f)?.userId)).toEqual([rhea.id, rhea.id]);
  });

  it('review round 2 N2: the lineage walk never enters a session the caller is not in', async () => {
    // A stranger's live session (two other humans) …
    const [x] = await run.sql<{ id: string }>(`INSERT INTO session (status) VALUES ('CREATED') RETURNING id::text`);
    const sam = person('sam');
    const tess = person('tess');
    for (const u of [sam, tess]) expect((await http(u, 'get', '/sessions')).status).toBe(200);
    await run.sql(`INSERT INTO participant (session_id, user_id) VALUES ($1, $2)`, [x.id, sam.id]);
    await run.sql(`INSERT INTO participant (session_id, user_id, added_by_user_id) VALUES ($1, $2, $3)`, [
      x.id,
      tess.id,
      sam.id,
    ]);
    // … named as the previous session of a session of Ada's.
    const [f] = await run.sql<{ id: string }>(
      `INSERT INTO session (status, previous_session_id) VALUES ('CREATED', $1) RETURNING id::text`,
      [x.id],
    );
    await run.sql(`INSERT INTO participant (session_id, user_id, display_name) VALUES ($1, $2, 'Ada')`, [f.id, ada.id]);
    const contacts = await import('../contacts');
    expect(await actingAs(ada.id, () => contacts.loadSessionPartner(f.id, ada.id))).toBeNull();
    expect(JSON.stringify((await http(ada, 'get', `/sessions/${f.id}`)).body)).not.toContain(sam.id);
  });

  it('review F7: an AI seat is never the partner, a contact or a departed partner', async () => {
    const solo = await http(ada, 'post', '/sessions', { inviteName: 'nobody' });
    const sid = solo.body.data.session.id as string;
    await run.as(
      'mwf_app',
      ada.id,
      `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'ai', $3)`,
      [sid, aiUser, ada.id],
    );
    const contacts = await import('../contacts');
    expect(await contacts.loadSessionPartner(sid, ada.id)).toBeNull();
    expect(await contacts.sharesASession(ada.id, aiUser)).toBe(false);
    expect((await http(ada, 'patch', `/contacts/${aiUser}/nickname`, { nickname: 'Bot' })).status).toBe(404);
    expect((await http(ada, 'get', `/sessions/${sid}`)).body.data.session.partner).toMatchObject({ id: '' });
    await run.sql(`UPDATE participant SET left_at = now() WHERE session_id = $1 AND user_id = $2`, [sid, aiUser]);
    const { departedParticipantUsers } = await import('../../utils/session');
    expect([...(await departedParticipantUsers([sid]))]).toEqual([]);
  });

  it('no session DTO carries relationshipId', async () => {
    const [{ session }] = await run.sql<{ session: string }>(
      `SELECT p.session_id::text AS session FROM participant p WHERE p.user_id = $1 ORDER BY p.joined_at LIMIT 1`,
      [ada.id],
    );
    for (const path of [`/sessions/${session}`, `/sessions/${session}/state`, '/sessions']) {
      const res = await http(ada, 'get', path);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('relationshipId');
    }
  });
});
