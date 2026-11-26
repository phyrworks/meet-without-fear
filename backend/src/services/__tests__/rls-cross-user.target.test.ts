/**
 * work-k5fk.10.7 (design note §6, §7 rows 9d–9g): one cross-user behaviour test per table, in the
 * database. On a clone of FEEL_HEARD_B (Ada and Bob in one ACTIVE session), plus Carol — a signed-in
 * user who is in no session of theirs — each test proves a wrong-user read or write fails as the
 * login production uses (mwf_app, mwf_ai, mwf_worker), with the identity bound as prisma-identity
 * binds it: Bob cannot read or write Ada's private row, Carol cannot see their session at all.
 *
 * A refused read is no row (RLS filters); a refused write is either no row (UPDATE / DELETE: the
 * row is not there for the caller) or 42501 "new row violates row-level security policy" (INSERT,
 * or an UPDATE whose new row leaves the caller's reach).
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
import { isTargetShape } from '../../testing/golden/shape';
import { Client } from 'pg';
import { adaAndBob, appUrlFor, openTargetRun, randomUuidV7, type RunRole, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('row-level security: one cross-user test per table (work-k5fk.10.7)', () => {
  let run: TargetRun;
  let session: string;
  let ada: string;
  let bob: string;
  const carol = randomUuidV7();

  beforeAll(async () => {
    run = await openTargetRun('FEEL_HEARD_B', `rls_cross_${process.pid}`);
    const ids = await adaAndBob(run);
    session = ids.session;
    ada = ids.adaUser;
    bob = ids.bobUser;
    await run.sql(`INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, 'Carol')`, [
      carol,
      `carol-${process.pid}@e2e.test`,
    ]);
  });
  afterAll(async () => {
    await run?.drop();
  });

  /** Rows a statement returns as `role` acting for `user` (scope: the AI / worker transaction's session). */
  const as = <T extends Record<string, unknown> = Record<string, unknown>>(
    role: RunRole,
    user: string | null,
    text: string,
    params: unknown[] = [],
    scope: string | null = null,
  ) => run.as<T>(role, user, text, params, scope);
  const count = async (
    role: RunRole,
    user: string | null,
    table: string,
    where = 'true',
    params: unknown[] = [],
    scope: string | null = null,
  ) =>
    (await as<{ n: number }>(role, user, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params, scope))[0].n;
  /**
   * How a statement ends: 'ok', 'rls' (42501 "new row violates row-level security policy" — a policy, not a grant,
   * refused it), or the SQLSTATE.
   */
  const code = async (
    role: RunRole,
    user: string | null,
    text: string,
    params: unknown[] = [],
    scope: string | null = null,
  ) => {
    try {
      await as(role, user, text, params, scope);
      return 'ok';
    } catch (e) {
      const { code: c, message } = e as { code?: string; message?: string };
      return c === '42501' && /row-level security policy/.test(message ?? '') ? 'rls' : (c ?? String(e));
    }
  };

  describe('core (9d)', () => {
    it('"user": Carol reads only herself (and the AI); Ada reads Bob’s name only, never his row; Bob cannot rename Ada (review F7)', async () => {
      expect(await count('mwf_app', carol, '"user"', 'id = ANY($1::uuid[])', [[ada, bob]])).toBe(0);
      expect(await count('mwf_app', carol, '"user"', "kind = 'human'")).toBe(1);
      // the reviewer's repro: Bob's row (email, last name, deleted_at) is not Ada's to read
      await run.sql(`UPDATE "user" SET first_name = 'Bob', last_name = 'Builder' WHERE id = $1`, [bob]);
      expect(
        await as(
          'mwf_app',
          ada,
          `SELECT id, email, first_name, last_name, name, deleted_at FROM "user" WHERE id = $1`,
          [bob],
        ),
      ).toEqual([]);
      expect(await count('mwf_app', ada, '"user"', 'id = $1', [carol])).toBe(0);
      // the name the app calls him by — first name only, no email, no last name beside it, no deletion instant
      const parties = await as<{ user_id: string; user_name: string | null; is_tombstone: boolean }>(
        'mwf_app',
        ada,
        `SELECT user_id::text, user_name, is_tombstone FROM app.session_parties(ARRAY[$1]::uuid[]) WHERE user_id = $2`,
        [session, bob],
      );
      expect(parties).toEqual([{ user_id: bob, user_name: 'Bob', is_tombstone: false }]);
      expect(
        await as(
          'mwf_app',
          ada,
          `SELECT display_name, is_tombstone FROM v_participant WHERE session_id = $1 AND user_id = $2`,
          [session, bob],
        ),
      ).toEqual([{ display_name: expect.not.stringContaining('Builder'), is_tombstone: false }]);
      // Carol, in no session of theirs, learns nothing through the definer or the createSession check
      expect(await count('mwf_app', carol, `app.session_parties(ARRAY[$1]::uuid[])`, 'true', [session])).toBe(0);
      expect(await as('mwf_app', carol, `SELECT app.shares_session_with($1) AS k`, [bob])).toEqual([{ k: false }]);
      expect(await as('mwf_app', ada, `SELECT app.shares_session_with($1) AS k`, [bob])).toEqual([{ k: true }]);
      expect(
        await as('mwf_app', bob, `UPDATE "user" SET first_name = 'Mallory' WHERE id = $1 RETURNING id`, [ada]),
      ).toEqual([]);
      expect(await run.sql(`SELECT first_name FROM "user" WHERE id = $1`, [ada])).not.toEqual([
        { first_name: 'Mallory' },
      ]);
    });

    it('user_contact: Bob cannot read Ada’s nickname for him, nor write one in her name', async () => {
      await run.sql(
        `INSERT INTO user_contact (user_id, contact_user_id, nickname) VALUES ($1, $2, 'B.') ON CONFLICT DO NOTHING`,
        [ada, bob],
      );
      expect(await count('mwf_app', ada, 'user_contact', 'user_id = $1', [ada])).toBe(1);
      expect(await count('mwf_app', bob, 'user_contact', 'user_id = $1', [ada])).toBe(0);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO user_contact (user_id, contact_user_id, nickname) VALUES ($1, $2, 'x')`,
          [ada, carol],
        ),
      ).toBe('rls');
    });

    it('session: Carol sees no session of theirs and cannot change its topic frame', async () => {
      expect(await count('mwf_app', ada, 'session', 'id = $1', [session])).toBe(1);
      expect(await count('mwf_app', carol, 'session')).toBe(0);
      expect(
        await as('mwf_app', carol, `UPDATE session SET topic_frame = NULL WHERE id = $1 RETURNING id`, [session]),
      ).toEqual([]);
      // a session continuing one of theirs is not Carol's to start
      expect(
        await code('mwf_app', carol, `INSERT INTO session (status, previous_session_id) VALUES ('CREATED', $1)`, [
          session,
        ]),
      ).toBe('rls');
    });

    it('session: a new session starts CREATED — mwf_app cannot insert one in any later status (work-k5fk.10.14)', async () => {
      for (const status of ['INVITED', 'ACTIVE', 'RESOLVED', 'ABANDONED']) {
        expect(await code('mwf_app', carol, `INSERT INTO session (status) VALUES ($1)`, [status])).toBe('rls');
      }
      // createSession's own insert still works (rolled back: an unseated CREATED session is visible to every caller)
      const c = new Client({ connectionString: appUrlFor(run.fx.target, run.fx.database) });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [carol]);
        const { rows } = await c.query(`INSERT INTO session (status) VALUES ('CREATED') RETURNING status::text`);
        expect(rows).toEqual([{ status: 'CREATED' }]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    });

    it('participant: Carol sees no seat of their session and cannot seat herself in it (as added by Ada)', async () => {
      expect(await count('mwf_app', bob, 'participant', 'session_id = $1', [session])).toBe(2);
      expect(await count('mwf_app', carol, 'participant')).toBe(0);
      expect(
        await code(
          'mwf_app',
          carol,
          `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'human', $3)`,
          [session, carol, ada],
        ),
      ).toBe('rls');
      // …nor can Ada seat Carol: nobody seats another human
      expect(
        await code(
          'mwf_app',
          ada,
          `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'human', $3)`,
          [session, carol, ada],
        ),
      ).toBe('rls');
    });

    it('live_session_pair: only the pair reads its row', async () => {
      expect(await count('mwf_app', ada, 'live_session_pair')).toBe(1);
      expect(await count('mwf_app', carol, 'live_session_pair')).toBe(0);
    });

    it('invitation: Carol cannot read, confirm, claim or answer it; app.invitation_peek shows her the claim notice only', async () => {
      expect(await count('mwf_app', ada, 'invitation', 'session_id = $1', [session])).toBe(1);
      expect(await count('mwf_app', carol, 'invitation')).toBe(0);
      const [{ id }] = await run.sql<{ id: string }>(`SELECT id::text FROM invitation WHERE session_id = $1`, [
        session,
      ]);
      expect(
        await as('mwf_app', carol, `UPDATE invitation SET message_confirmed_at = now() WHERE id = $1 RETURNING id`, [
          id,
        ]),
      ).toEqual([]);
      // Bob claimed it (work-k5fk.10.8: first opener claims): Carol gets the claim notice — its status, nothing else
      const peek = await as<{ status: string; session_id: string | null; withheld: boolean }>(
        'mwf_app',
        carol,
        `SELECT status::text, session_id::text, withheld FROM app.invitation_peek($1)`,
        [id],
      );
      expect(peek).toEqual([{ status: 'ACCEPTED', session_id: null, withheld: true }]);
      expect(await as('mwf_app', bob, `SELECT session_id::text, withheld FROM app.invitation_peek($1)`, [id])).toEqual([
        { session_id: session, withheld: false },
      ]);
      // the answer is the claimer's: never Carol's (MWI01), and an accepted one not even Bob's to re-answer
      expect(await code('mwf_app', carol, `SELECT app.invitation_answer($1, 'DECLINED')`, [id])).toBe('MWI01');
      expect(await code('mwf_app', carol, `SELECT app.invitation_claim($1)`, [id])).toBe('MWI01');
      expect(await code('mwf_app', bob, `SELECT app.invitation_answer($1, 'DECLINED')`, [id])).toBe('23514');
    });

    // work-k5fk.10.38 (owner decision 2026-11-24): two humans per session, for now. Ada and Bob fill theirs.
    it('invitation: neither member of a two-human session can invite a third (MWS01); Carol is refused by RLS', async () => {
      const invite = `INSERT INTO invitation (session_id, invited_by_user_id, expires_at)
                      VALUES ($1, $2, now() + interval '7 days') RETURNING id`;
      expect(await code('mwf_app', ada, invite, [session, ada])).toBe('MWS01');
      expect(await code('mwf_app', bob, invite, [session, bob])).toBe('MWS01');
      expect(await code('mwf_app', carol, invite, [session, ada])).toBe('rls');
      expect(await count('mwf_app', ada, 'invitation', 'session_id = $1', [session])).toBe(1);
    });

    it('participant_milestone: Ada cannot reach a milestone for Bob, nor a system one for herself (work-k5fk.10.28)', async () => {
      const insert = `INSERT INTO participant_milestone (session_id, user_id, milestone_key) VALUES ($1, $2, $3)`;
      // choices_shared for Bob would un-hide his Stage 4 choices
      expect(await code('mwf_app', ada, insert, [session, bob, 'choices_shared'])).toBe('rls');
      expect(await code('mwf_app', ada, insert, [session, ada, 'needs_shared'])).toBe('rls');
      expect(await code('mwf_app', ada, insert + ' ON CONFLICT DO NOTHING', [session, ada, 'compact_signed'])).toBe(
        'ok',
      );
      expect(await count('mwf_app', carol, 'participant_milestone')).toBe(0);
    });

    it('milestone, app.json_schema: reference data every caller reads', async () => {
      expect(await count('mwf_app', carol, 'milestone')).toBe(13);
      expect(await count('mwf_app', carol, 'app.json_schema')).toBe(4);
    });

    it.each([
      [
        'user_device',
        `INSERT INTO user_device (user_id, push_token, push_provider) VALUES ($1, 'ExponentPushToken[ada]', 'expo')`,
        `UPDATE user_device SET push_token = 'ExponentPushToken[evil]' WHERE user_id = $1 RETURNING id`,
      ],
      [
        'user_preferences',
        `INSERT INTO user_preferences (user_id, doc) VALUES ($1, '{"memory": {}, "notifications": {}, "privacy": {}}') ON CONFLICT DO NOTHING`,
        `UPDATE user_preferences SET doc = doc WHERE user_id = $1 RETURNING user_id`,
      ],
      [
        'feature_state',
        `INSERT INTO feature_state (user_id, feature, doc) VALUES ($1, 'gratitude', '{}') ON CONFLICT DO NOTHING`,
        `UPDATE feature_state SET doc = '{}' WHERE user_id = $1 RETURNING user_id`,
      ],
      [
        'user_memory',
        `INSERT INTO user_memory (user_id, content, category) VALUES ($1, 'ada likes tea', 'PREFERENCE')`,
        `UPDATE user_memory SET status = 'REJECTED' WHERE user_id = $1 RETURNING id`,
      ],
    ])('%s: Bob neither reads nor changes Ada’s row', async (table, seed, update) => {
      await run.sql(seed, [ada]);
      expect(await count('mwf_app', ada, table, 'user_id = $1', [ada])).toBeGreaterThan(0);
      expect(await count('mwf_app', bob, table, 'user_id = $1', [ada])).toBe(0);
      expect(await as('mwf_app', bob, update, [ada])).toEqual([]);
    });

    it('ai_memory: Bob does not read Ada’s summary; the AI acting for Carol reads none in their session', async () => {
      await run.sql(
        `INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES ($1, $2, 'NOTABLE_FACTS', '{"facts": []}')`,
        [session, ada],
      );
      expect(await count('mwf_app', ada, 'ai_memory', 'user_id = $1', [ada])).toBe(1);
      expect(await count('mwf_app', bob, 'ai_memory', 'user_id = $1', [ada])).toBe(0);
      expect(await count('mwf_ai', bob, 'ai_memory', 'true', [], session)).toBe(1);
      expect(await count('mwf_ai', carol, 'ai_memory', 'true', [], session)).toBe(0);
      expect(await count('mwf_ai', carol, 'participant', 'true', [], session)).toBe(0);
    });

    it('brain_activity: the AI acting for Bob neither reads nor completes the telemetry of Ada’s inner work (work-k5fk.10.33)', async () => {
      const [{ id: reflection }] = await run.sql<{ id: string }>(
        `INSERT INTO reflection (user_id) VALUES ($1) RETURNING id::text`,
        [ada],
      );
      const [{ id }] = await run.sql<{ id: string }>(
        `INSERT INTO brain_activity (reflection_id, activity_type, model) VALUES ($1, 'LLM_CALL', 'm') RETURNING id::text`,
        [reflection],
      );
      expect(await count('mwf_ai', ada, 'brain_activity', 'id = $1', [id])).toBe(1);
      expect(await count('mwf_ai', bob, 'brain_activity', 'id = $1', [id])).toBe(0);
      expect(
        await as('mwf_ai', bob, `UPDATE brain_activity SET output = '{"forged": true}' WHERE id = $1 RETURNING id`, [
          id,
        ]),
      ).toEqual([]);
      expect(
        await code(
          'mwf_ai',
          bob,
          `INSERT INTO brain_activity (reflection_id, activity_type, model) VALUES ($1, 'LLM_CALL', 'm')`,
          [reflection],
        ),
      ).toBe('rls');
    });

    it('brain_activity: a call of neither a session nor a reflection is its acting user’s alone (work-k5fk.10.35)', async () => {
      // Ada's gratitude/meditation/memory call: written by the AI acting for her, owned by her (user_id)
      const [{ id }] = await as<{ id: string }>(
        'mwf_ai',
        ada,
        `INSERT INTO brain_activity (user_id, activity_type, model) VALUES ($1, 'LLM_CALL', 'm') RETURNING id::text`,
        [ada],
      );
      expect(await count('mwf_ai', ada, 'brain_activity', 'id = $1', [id])).toBe(1);
      expect(
        await as('mwf_ai', ada, `UPDATE brain_activity SET status = 'COMPLETED' WHERE id = $1 RETURNING id::text`, [id]),
      ).toEqual([{ id }]);
      // the AI acting for Bob, or for no one, neither reads nor completes it
      expect(await count('mwf_ai', bob, 'brain_activity', 'id = $1', [id])).toBe(0);
      expect(await count('mwf_ai', null, 'brain_activity', 'id = $1', [id])).toBe(0);
      expect(
        await as('mwf_ai', bob, `UPDATE brain_activity SET output = '{"forged": true}' WHERE id = $1 RETURNING id`, [
          id,
        ]),
      ).toEqual([]);
      // …nor writes one in her name, nor one with no owner
      expect(
        await code(
          'mwf_ai',
          bob,
          `INSERT INTO brain_activity (user_id, activity_type, model) VALUES ($1, 'LLM_CALL', 'm')`,
          [ada],
        ),
      ).toBe('rls');
      expect(
        await code('mwf_ai', bob, `INSERT INTO brain_activity (activity_type, model) VALUES ('LLM_CALL', 'm')`),
      ).toBe('rls');
      // (and the CHECK refuses an ownerless one from any writer, the superuser included)
      expect(
        await run.sql(`INSERT INTO brain_activity (activity_type, model) VALUES ('LLM_CALL', 'm')`).catch(
          (e: { code?: string }) => e.code,
        ),
      ).toBe('23514');
      // a session's row has no user owner
      expect(
        await code(
          'mwf_ai',
          ada,
          `INSERT INTO brain_activity (session_id, user_id, activity_type, model) VALUES ($1, $2, 'LLM_CALL', 'm')`,
          [session, ada],
          session,
        ),
      ).toBe('23514');
    });

    it('the worker clears a push token but never sets one, and never writes a telemetry blob (work-k5fk.10.29 R1, R2)', async () => {
      await run.sql(
        `INSERT INTO user_device (user_id, push_token, push_provider) VALUES ($1, 'ExponentPushToken[w]', 'expo')`,
        [bob],
      );
      expect(
        await code(
          'mwf_worker',
          null,
          `UPDATE user_device SET push_token = 'ExponentPushToken[evil]' WHERE user_id = $1`,
          [bob],
        ),
      ).toBe('rls');
      expect(
        await as(
          'mwf_worker',
          null,
          `UPDATE user_device SET push_token = NULL, push_provider = NULL WHERE user_id = $1 RETURNING user_id`,
          [bob],
        ),
      ).toHaveLength(1);
      const [{ id }] = await run.sql<{ id: string }>(
        `INSERT INTO brain_activity (session_id, activity_type, model) VALUES ($1, 'LLM_CALL', 'm') RETURNING id::text`,
        [session],
      );
      // (the worker reads session_id and created_at only: its retention filters)
      void id;
      expect(
        await code('mwf_worker', null, `UPDATE brain_activity SET output = '{"forged": true}' WHERE session_id = $1`, [
          session,
        ]),
      ).toBe('rls');
      expect(
        await code(
          'mwf_worker',
          null,
          `UPDATE brain_activity SET input = NULL, output = NULL, metadata = NULL WHERE session_id = $1`,
          [session],
        ),
      ).toBe('ok');
    });
  });

  describe('thread (9e)', () => {
    const mainOf = async (user: string) =>
      (
        await run.sql<{ id: string }>(
          `SELECT id::text FROM conversation WHERE session_id = $1 AND user_id = $2 AND kind = 'MAIN'`,
          [session, user],
        )
      )[0].id;

    it('conversation: Bob gets Ada’s MAIN conversation id from the definer, never her row (next_seq) nor her sub-chat, and cannot change it (review F8)', async () => {
      const adaMain = await mainOf(ada);
      const [{ id: sub }] = await run.sql<{ id: string }>(
        `INSERT INTO conversation (session_id, user_id, kind, anchor_kind) VALUES ($1, $2, 'SUBCHAT', 'NEEDS_BRAINSTORM') RETURNING id::text`,
        [session, ada],
      );
      // the reviewer's repro: SELECT id, kind, status, next_seq FROM conversation WHERE user_id = A
      expect(
        await as('mwf_app', bob, `SELECT id, kind, status, next_seq FROM conversation WHERE user_id = $1`, [ada]),
      ).toEqual([]);
      expect(
        await as<{ m: string }>(
          'mwf_app',
          bob,
          `SELECT main_conversation_id::text AS m FROM app.session_parties(ARRAY[$1]::uuid[]) WHERE user_id = $2`,
          [session, ada],
        ),
      ).toEqual([{ m: adaMain }]);
      expect(await count('mwf_app', bob, 'conversation', 'id = $1', [sub])).toBe(0);
      expect(await count('mwf_app', carol, 'conversation')).toBe(0);
      expect(
        await as('mwf_app', bob, `UPDATE conversation SET status = 'RESOLVED' WHERE id = $1 RETURNING id`, [adaMain]),
      ).toEqual([]);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO conversation (session_id, user_id, kind, anchor_kind) VALUES ($1, $2, 'SUBCHAT', 'NEEDS_BRAINSTORM')`,
          [session, ada],
        ),
      ).toBe('rls');
    });

    it('message: Bob reads none of Ada’s conversation and writes nothing into it', async () => {
      const adaMain = await mainOf(ada);
      expect(await count('mwf_app', ada, 'message', 'conversation_id = $1', [adaMain])).toBeGreaterThan(0);
      expect(await count('mwf_app', bob, 'message', 'conversation_id = $1', [adaMain])).toBe(0);
      expect(await count('mwf_app', carol, 'message')).toBe(0);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO message (conversation_id, session_id, sender_user_id, role, kind, content) VALUES ($1, $2, $3, 'USER', 'CHAT', 'x')`,
          [adaMain, session, bob],
        ),
      ).toBe('42501');
      expect(
        await as('mwf_app', bob, `DELETE FROM message WHERE conversation_id = $1 RETURNING seq`, [adaMain]),
      ).toEqual([]);
    });

    it('conversation_read_state: Bob neither reads nor moves Ada’s; nobody points theirs at another’s conversation (work-k5fk.10.21)', async () => {
      const adaMain = await mainOf(ada);
      const bobMain = await mainOf(bob);
      expect(await count('mwf_app', bob, 'conversation_read_state', 'user_id = $1', [ada])).toBe(0);
      expect(
        await as(
          'mwf_app',
          bob,
          `UPDATE conversation_read_state SET last_viewed_at = now() WHERE user_id = $1 RETURNING user_id`,
          [ada],
        ),
      ).toEqual([]);
      const [{ seq }] = await run.sql<{ seq: number }>(
        `SELECT max(seq)::int AS seq FROM message WHERE conversation_id = $1`,
        [bobMain],
      );
      // Ada's own read state may not name Bob's conversation (the FK alone pinned only the session)
      expect(
        await code(
          'mwf_app',
          ada,
          `UPDATE conversation_read_state SET last_seen_conversation_id = $2, last_seen_seq = $3 WHERE user_id = $1`,
          [ada, bobMain, seq],
        ),
      ).toBe('rls');
      void adaMain;
    });

    it('draft: Bob neither reads nor deletes Ada’s drafts, nor writes one in her name', async () => {
      await run.sql(
        `INSERT INTO draft (session_id, user_id, kind, about_user_id, content) VALUES ($1, $2, 'EMPATHY', $3, 'ada draft')
         ON CONFLICT DO NOTHING`,
        [session, ada, bob],
      );
      expect(await count('mwf_app', ada, 'draft', 'user_id = $1', [ada])).toBeGreaterThan(0);
      expect(await count('mwf_app', bob, 'draft', 'user_id = $1', [ada])).toBe(0);
      expect(await as('mwf_app', bob, `DELETE FROM draft WHERE user_id = $1 RETURNING id`, [ada])).toEqual([]);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO draft (session_id, user_id, kind, about_user_id, content) VALUES ($1, $2, 'EMPATHY', $3, 'forged')`,
          [session, ada, bob],
        ),
      ).toBe('rls');
    });

    it('reflection, reflection_message, takeaway, takeaway_link: Bob reads and writes none of Ada’s inner work', async () => {
      const [{ id: r }] = await run.sql<{ id: string }>(
        `INSERT INTO reflection (user_id) VALUES ($1) RETURNING id::text`,
        [ada],
      );
      await run.sql(`INSERT INTO reflection_message (reflection_id, role, content) VALUES ($1, 'USER', 'private')`, [
        r,
      ]);
      const [{ id: t1 }] = await run.sql<{ id: string }>(
        `INSERT INTO takeaway (reflection_id, content) VALUES ($1, 'one') RETURNING id::text`,
        [r],
      );
      const [{ id: t2 }] = await run.sql<{ id: string }>(
        `INSERT INTO takeaway (reflection_id, content) VALUES ($1, 'two') RETURNING id::text`,
        [r],
      );
      await run.sql(`INSERT INTO takeaway_link (source_id, target_id, link_type) VALUES ($1, $2, 'USER_MANUAL')`, [
        t1,
        t2,
      ]);
      expect(await count('mwf_app', ada, 'takeaway_link', 'source_id = $1', [t1])).toBe(1);
      for (const [table, where] of [
        ['reflection', 'id = $1'],
        ['reflection_message', 'reflection_id = $1'],
        ['takeaway', 'reflection_id = $1'],
      ] as const) {
        expect(await count('mwf_app', ada, table, where, [r])).toBeGreaterThan(0);
        expect(await count('mwf_app', bob, table, where, [r])).toBe(0);
      }
      expect(await count('mwf_app', bob, 'takeaway_link', 'source_id = $1', [t1])).toBe(0);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO reflection_message (reflection_id, role, content) VALUES ($1, 'USER', 'x')`,
          [r],
        ),
      ).toBe('rls');
      expect(await code('mwf_app', bob, `INSERT INTO takeaway (reflection_id, content) VALUES ($1, 'x')`, [r])).toBe(
        'rls',
      );
      // Bob links from his own takeaway to Ada's: refused (both ends are the caller's)
      const [{ id: br }] = await run.sql<{ id: string }>(
        `INSERT INTO reflection (user_id) VALUES ($1) RETURNING id::text`,
        [bob],
      );
      const [{ id: bt }] = await run.sql<{ id: string }>(
        `INSERT INTO takeaway (reflection_id, content) VALUES ($1, 'mine') RETURNING id::text`,
        [br],
      );
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO takeaway_link (source_id, target_id, link_type) VALUES ($1, $2, 'USER_MANUAL')`,
          [bt, t1],
        ),
      ).toBe('rls');
      // …nor links his reflection to a session he is not in
      expect(
        await code(
          'mwf_app',
          carol,
          `INSERT INTO reflection (user_id, linked_session_id, linked_at) VALUES ($1, $2, now())`,
          [carol, session],
        ),
      ).toBe('rls');
    });

    it.each([
      ['mood_reading', `INSERT INTO mood_reading (session_id, user_id, intensity) VALUES ($1, $2, 5)`],
      [
        'regulation_event',
        `INSERT INTO regulation_event (session_id, user_id, type) VALUES ($1, $2, 'BREATHING_EXERCISE')`,
      ],
    ])('%s: Bob neither reads Ada’s nor records one for her', async (table, insert) => {
      await run.sql(insert, [session, ada]);
      expect(await count('mwf_app', ada, table, 'user_id = $1', [ada])).toBeGreaterThan(0);
      expect(await count('mwf_app', bob, table, 'user_id = $1', [ada])).toBe(0);
      expect(await code('mwf_app', bob, insert, [session, ada])).toBe('rls');
    });

    it('the AI acting for Carol reads none of their chat, even scoped to their session', async () => {
      expect(await count('mwf_ai', ada, 'message', 'true', [], session)).toBeGreaterThan(0);
      expect(await count('mwf_ai', carol, 'message', 'true', [], session)).toBe(0);
      expect(await count('mwf_ai', carol, 'conversation', 'true', [], session)).toBe(0);
    });
  });

  describe('empathy (9f)', () => {
    /** Bob's attempt about Ada, its reconciler result (subject Ada), guidance and share offer (superuser setup). */
    let bobAttempt: string;
    let result: string;
    let offer: string;
    let adaNeed: string;
    beforeAll(async () => {
      [{ id: bobAttempt }] = await run.sql<{ id: string }>(
        `INSERT INTO empathy_attempt (session_id, author_user_id, subject_user_id, round, content, status)
         VALUES ($1, $2, $3, 41, 'PROBE_BOB_GUESS', 'AWAITING_SHARING') RETURNING id::text`,
        [session, bob, ada],
      );
      [{ id: result }] = await run.sql<{ id: string }>(
        `INSERT INTO reconciler_result (attempt_id, session_id, author_user_id, subject_user_id, iteration, alignment_score,
                                        alignment_summary, gap_summary, gap_severity, recommended_action, rationale, sharing_would_help)
         VALUES ($1, $2, $3, $4, 1, 50, 's', 'PROBE_GAP', 'MINOR', 'PROCEED', 'r', true) RETURNING id::text`,
        [bobAttempt, session, bob, ada],
      );
      await run.sql(
        `INSERT INTO reconciler_guidance (result_id, session_id, author_user_id, subject_user_id, guidance_type)
         VALUES ($1, $2, $3, $4, 'explore_breadth')`,
        [result, session, bob, ada],
      );
      [{ id: offer }] = await run.sql<{ id: string }>(
        `INSERT INTO context_share_offer (attempt_id, result_id, session_id, subject_user_id, status, suggested_content)
         VALUES ($1, $2, $3, $4, 'OFFERED', 'PROBE_SUGGESTION') RETURNING id::text`,
        [bobAttempt, result, session, ada],
      );
      [{ id: adaNeed }] = await run.sql<{ id: string }>(
        `INSERT INTO need (session_id, user_id, label, category, ai_confidence) VALUES ($1, $2, 'PROBE_NEED', 'SAFETY', 0.5)
         RETURNING id::text`,
        [session, ada],
      );
    });

    it('empathy_attempt: Ada cannot read Bob’s unrevealed attempt about her, only its facts; nobody writes one as Bob', async () => {
      expect(await count('mwf_app', bob, 'empathy_attempt', 'id = $1', [bobAttempt])).toBe(1);
      expect(await count('mwf_app', ada, 'empathy_attempt', 'id = $1', [bobAttempt])).toBe(0);
      expect(await count('mwf_app', carol, 'empathy_attempt')).toBe(0);
      expect(
        await as<{ author_user_id: string }>('mwf_app', ada, `SELECT author_user_id::text FROM app.attempt_meta($1)`, [
          [bobAttempt],
        ]),
      ).toEqual([{ author_user_id: bob }]);
      expect(await as('mwf_app', carol, `SELECT 1 FROM app.attempt_meta($1)`, [[bobAttempt]])).toEqual([]);
      expect(
        await code(
          'mwf_app',
          ada,
          `INSERT INTO empathy_attempt (session_id, author_user_id, subject_user_id, round, content) VALUES ($1, $2, $3, 42, 'forged')`,
          [session, bob, ada],
        ),
      ).toBe('rls');
    });

    it('reconciler_result, reconciler_guidance: the author reads the guidance, never the analysis; Carol neither', async () => {
      expect(await count('mwf_app', ada, 'reconciler_result', 'id = $1', [result])).toBe(1);
      expect(await count('mwf_app', bob, 'reconciler_result', 'id = $1', [result])).toBe(0);
      expect(await count('mwf_app', bob, 'reconciler_guidance', 'result_id = $1', [result])).toBe(1);
      expect(await count('mwf_app', carol, 'reconciler_guidance')).toBe(0);
      expect(await as('mwf_app', carol, `SELECT 1 FROM app.result_facts($1)`, [[result]])).toEqual([]);
    });

    it('context_share_offer: only the subject reads and answers it', async () => {
      expect(await count('mwf_app', ada, 'context_share_offer', 'id = $1', [offer])).toBe(1);
      expect(await count('mwf_app', bob, 'context_share_offer', 'id = $1', [offer])).toBe(0);
      expect(
        await as('mwf_app', bob, `UPDATE context_share_offer SET status = 'DECLINED' WHERE id = $1 RETURNING id`, [
          offer,
        ]),
      ).toEqual([]);
    });

    it('empathy_review: the author reads the subject’s review only once its feedback is sent', async () => {
      await run.sql(`UPDATE empathy_attempt SET status = 'REVEALED', revealed_at = now() WHERE id = $1`, [bobAttempt]);
      const [{ id: review }] = await run.sql<{ id: string }>(
        `INSERT INTO empathy_review (attempt_id, session_id, reviewer_user_id, validated) VALUES ($1, $2, $3, false)
         RETURNING id::text`,
        [bobAttempt, session, ada],
      );
      expect(await count('mwf_app', ada, 'empathy_review', 'id = $1', [review])).toBe(1);
      expect(await count('mwf_app', bob, 'empathy_review', 'id = $1', [review])).toBe(0);
      await run.sql(`UPDATE empathy_review SET feedback = 'PROBE_SENT', feedback_sent_at = now() WHERE id = $1`, [
        review,
      ]);
      expect(await count('mwf_app', bob, 'empathy_review', 'id = $1', [review])).toBe(1);
      expect(await count('mwf_app', carol, 'empathy_review')).toBe(0);
      expect(
        await as('mwf_app', bob, `UPDATE empathy_review SET validated = true WHERE id = $1 RETURNING id`, [review]),
      ).toEqual([]);
    });

    it('need, consent, need_disposition: Bob neither reads Ada’s nor writes in her name', async () => {
      await run.sql(
        `INSERT INTO consent (session_id, user_id, need_id, decision, decided_at) VALUES ($1, $2, $3, 'GRANTED', now())`,
        [session, ada, adaNeed],
      );
      for (const table of ['need', 'consent']) {
        expect(await count('mwf_app', ada, table, 'user_id = $1', [ada])).toBeGreaterThan(0);
        expect(await count('mwf_app', bob, table, 'user_id = $1', [ada])).toBe(0);
      }
      expect(await as('mwf_app', bob, `UPDATE need SET label = 'x' WHERE id = $1 RETURNING id`, [adaNeed])).toEqual([]);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO consent (session_id, user_id, need_id, decision) VALUES ($1, $2, $3, 'DENIED')`,
          [session, ada, adaNeed],
        ),
      ).toBe('23514'); // t_consent_owner (BEFORE, ahead of the policy): "consent target is not yours"
      // A disposition is the partner's of a shared need: Bob's of Ada's, private to Bob.
      await run.sql(
        `INSERT INTO need_share (need_id, session_id, user_id, category, shared_text) VALUES ($1, $2, $3, 'SAFETY', 'PROBE_SHARED')`,
        [adaNeed, session, ada],
      );
      await run.sql(`INSERT INTO need_disposition (session_id, user_id, need_id) VALUES ($1, $2, $3)`, [
        session,
        bob,
        adaNeed,
      ]);
      expect(await count('mwf_app', bob, 'need_disposition', 'user_id = $1', [bob])).toBe(1);
      expect(await count('mwf_app', ada, 'need_disposition', 'user_id = $1', [bob])).toBe(0);
      expect(
        await code('mwf_app', ada, `INSERT INTO need_disposition (session_id, user_id, need_id) VALUES ($1, $2, $3)`, [
          session,
          bob,
          adaNeed,
        ]),
      ).toBe('rls');
    });

    it('need_share: Bob reads Ada’s live share, not a revoked one; Carol none', async () => {
      // (shared in the test above)
      expect(await count('mwf_app', bob, 'need_share', 'need_id = $1', [adaNeed])).toBe(1);
      expect(await count('mwf_app', carol, 'need_share')).toBe(0);
      await run.sql(`UPDATE need_share SET revoked_at = now() WHERE need_id = $1`, [adaNeed]);
      expect(await count('mwf_app', bob, 'need_share', 'need_id = $1', [adaNeed])).toBe(0);
      expect(await count('mwf_app', ada, 'need_share', 'need_id = $1', [adaNeed])).toBe(1);
    });

    it('the content-free definers answer a party of the session only (shares_delivered_to_me, validated_at)', async () => {
      expect(await as('mwf_app', carol, `SELECT 1 FROM app.shares_delivered_to_me($1)`, [session])).toEqual([]);
      expect(await as('mwf_app', carol, `SELECT 1 FROM app.validated_at($1)`, [[bobAttempt]])).toEqual([]);
      // Ada, the subject, learns nothing of Bob's verdicts on his own attempt (it is the author's question)
      expect(await as('mwf_app', ada, `SELECT 1 FROM app.validated_at($1)`, [[bobAttempt]])).toEqual([]);
    });

    it('the AI acting for Carol reads no attempt, result or offer of their session', async () => {
      expect(await count('mwf_ai', bob, 'empathy_attempt', 'id = $1', [bobAttempt], session)).toBe(1);
      for (const table of ['empathy_attempt', 'reconciler_result', 'reconciler_guidance', 'context_share_offer']) {
        expect(await count('mwf_ai', carol, table, 'true', [], session)).toBe(0);
      }
    });
  });

  describe('repair (9g)', () => {
    /** Ada's proposal and Bob's choice on it, an agreement with its parties, a closure and follow-ups (superuser). */
    let proposal: string;
    let agreement: string;
    let shared: string;
    let individual: string;
    beforeAll(async () => {
      [{ id: proposal }] = await run.sql<{ id: string }>(
        `INSERT INTO proposal (session_id, created_by_user_id, description) VALUES ($1, $2, 'PROBE_PROPOSAL') RETURNING id::text`,
        [session, ada],
      );
      await run.sql(
        `INSERT INTO proposal_choice (proposal_id, session_id, user_id, decision) VALUES ($1, $2, $3, 'WILLING'), ($1, $2, $4, 'WILLING')`,
        [proposal, session, ada, bob],
      );
      await run.sql(`ALTER TABLE agreement_party DISABLE TRIGGER USER; ALTER TABLE agreement DISABLE TRIGGER USER`);
      [{ id: agreement }] = await run.sql<{ id: string }>(
        `INSERT INTO agreement (session_id, proposal_id, type, description) VALUES ($1, $2, 'COMMITMENT', 'PROBE_AGREEMENT') RETURNING id::text`,
        [session, proposal],
      );
      await run.sql(
        `INSERT INTO agreement_party (agreement_id, session_id, user_id) VALUES ($1, $2, $3), ($1, $2, $4)`,
        [agreement, session, ada, bob],
      );
      await run.sql(`ALTER TABLE agreement_party ENABLE TRIGGER USER; ALTER TABLE agreement ENABLE TRIGGER USER`);
      await run.sql(
        `INSERT INTO session_closure (session_id, kind, reason, summary) VALUES ($1, 'SHARED_AGREEMENT', 'MUTUAL_SELECTION', 's')`,
        [session],
      );
      [{ id: shared }] = await run.sql<{ id: string }>(
        `INSERT INTO follow_up (session_id, agreement_id, type, scope, status) VALUES ($1, $2, 'SCHEDULED_SHARED_AGREEMENT', 'SHARED', 'OPEN')
         RETURNING id::text`,
        [session, agreement],
      );
      [{ id: individual }] = await run.sql<{ id: string }>(
        `INSERT INTO follow_up (session_id, type, scope, owner_user_id, status) VALUES ($1, 'SCHEDULED_INDIVIDUAL_COMMITMENT', 'INDIVIDUAL', $2, 'OPEN')
         RETURNING id::text`,
        [session, ada],
      );
    });

    it('proposal, proposal_need, proposal_revision: members read them; an individual commitment is its creator’s; a converted one nobody’s', async () => {
      expect(await count('mwf_app', bob, 'proposal', 'id = $1', [proposal])).toBe(1);
      expect(await count('mwf_app', carol, 'proposal')).toBe(0);
      const [{ id: commitment }] = await run.sql<{ id: string }>(
        `INSERT INTO proposal (session_id, created_by_user_id, kind, description)
         VALUES ($1, $2, 'INDIVIDUAL_COMMITMENT', 'PROBE_COMMITMENT') RETURNING id::text`,
        [session, ada],
      );
      // Bob neither edits Ada's commitment nor revises it; Ada cannot hand it to him (work-k5fk.10.9)
      expect(
        await as('mwf_app', bob, `UPDATE proposal SET description = 'rewritten' WHERE id = $1 RETURNING id`, [
          commitment,
        ]),
      ).toEqual([]);
      expect(
        await code('mwf_app', ada, `UPDATE proposal SET created_by_user_id = $2 WHERE id = $1`, [commitment, bob]),
      ).toBe('42501'); // t_proposal_app_moves, before the policy (work-k5fk.10.9)
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action) VALUES ($1, $2, $3, 'REVISED')`,
          [commitment, session, bob],
        ),
      ).toBe('rls');
      // Private until shared (spec §1.4, owner decision 2026-11-25, work-k5fk.32 S1): Bob reads neither Ada's
      // unshared commitment nor anything hung off it — its need link, its revision text, her choice on it (even
      // once her choices are shared).
      const [{ id: need }] = await run.sql<{ id: string }>(
        `INSERT INTO need (label, category, ai_confidence, user_id, session_id)
         VALUES ('PROBE_COMMITMENT_NEED', 'SAFETY', 0.9, $1, $2) RETURNING id::text`,
        [ada, session],
      );
      await run.sql(
        `INSERT INTO need_share (need_id, session_id, user_id, category, shared_text) VALUES ($1, $2, $3, 'SAFETY', 'n')`,
        [need, session, ada],
      );
      await run.sql(`INSERT INTO proposal_need (proposal_id, need_id, session_id) VALUES ($1, $2, $3)`, [
        commitment,
        need,
        session,
      ]);
      await run.sql(
        `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action, after)
         VALUES ($1, $2, $3, 'CREATED', '{"description": "PROBE_COMMITMENT"}')`,
        [commitment, session, ada],
      );
      await run.sql(
        `INSERT INTO proposal_choice (proposal_id, session_id, user_id, decision, note) VALUES ($1, $2, $3, 'WILLING', 'PROBE_NOTE')`,
        [commitment, session, ada],
      );
      await run.sql(
        `INSERT INTO participant_milestone (session_id, user_id, milestone_key) VALUES ($1, $2, 'choices_shared') ON CONFLICT DO NOTHING`,
        [session, ada],
      );
      const bobSees = async () =>
        Promise.all([
          count('mwf_app', bob, 'proposal', 'id = $1', [commitment]),
          count('mwf_app', bob, 'proposal_need', 'proposal_id = $1', [commitment]),
          count('mwf_app', bob, 'proposal_revision', 'proposal_id = $1', [commitment]),
          count('mwf_app', bob, 'proposal_choice', 'proposal_id = $1', [commitment]),
          count('mwf_app', bob, 'v_session_closure_items', 'session_id = $1 AND $2::uuid = ANY (individual_commitment_ids)', [session, commitment]),
        ]);
      expect(await bobSees()).toEqual([0, 0, 0, 0, 0]);
      expect(await count('mwf_app', ada, 'proposal', 'id = $1', [commitment])).toBe(1);
      // The one writer of shared_at is app.proposal_share, and only for its creator: not Bob, not Carol, not the
      // app by an UPDATE (no column grant), not the AI.
      expect(await code('mwf_app', bob, `SELECT app.proposal_share($1)`, [commitment])).toBe('P0002');
      expect(await code('mwf_app', carol, `SELECT app.proposal_share($1)`, [commitment])).toBe('P0002');
      expect(await code('mwf_app', ada, `UPDATE proposal SET shared_at = now() WHERE id = $1`, [commitment])).toBe(
        '42501',
      );
      expect(await code('mwf_ai', ada, `SELECT app.proposal_share($1)`, [commitment], session)).toBe('42501');
      expect(await code('mwf_app', ada, `SELECT app.proposal_share($1)`, [proposal])).toBe('23514'); // a shared proposal
      expect(await bobSees()).toEqual([0, 0, 0, 0, 0]);
      // Ada shares it: from then on Bob reads it and what hangs off it. Once only — a second share stamps nothing.
      expect(await as('mwf_app', ada, `SELECT app.proposal_share($1) AS stamped`, [commitment])).toEqual([
        { stamped: true },
      ]);
      const [{ shared_at: first }] = await run.sql<{ shared_at: Date }>(`SELECT shared_at FROM proposal WHERE id = $1`, [
        commitment,
      ]);
      expect(first).not.toBeNull();
      expect(await as('mwf_app', ada, `SELECT app.proposal_share($1) AS stamped`, [commitment])).toEqual([
        { stamped: false },
      ]);
      expect(await run.sql(`SELECT shared_at FROM proposal WHERE id = $1`, [commitment])).toEqual([{ shared_at: first }]);
      // ... all but its revision history: sharing releases only the current text (work-k5fk.37, owner decision
      // 2026-11-25) — the before/after of a co-participant's commitment are never Bob's to read.
      expect(await bobSees()).toEqual([1, 1, 0, 1, 1]);
      expect(await count('mwf_app', carol, 'proposal', 'id = $1', [commitment])).toBe(0);
      // Creator-only until shared (work-k5fk.10.10 / 10.11, owner decision 2026-11-23): shared_at makes Ada's
      // commitment visible to Bob, never his to edit or revise; her SHARED_PROPOSAL is shared from birth, so Bob may;
      // Ada always may.
      expect(
        await as('mwf_app', bob, `UPDATE proposal SET description = 'rewritten' WHERE id = $1 RETURNING id`, [
          commitment,
        ]),
      ).toEqual([]);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action) VALUES ($1, $2, $3, 'REVISED')`,
          [commitment, session, bob],
        ),
      ).toBe('rls');
      expect(
        await as('mwf_app', ada, `UPDATE proposal SET description = 'PROBE_COMMITMENT' WHERE id = $1 RETURNING id`, [
          commitment,
        ]),
      ).toEqual([{ id: commitment }]);
      expect(
        await as('mwf_app', bob, `UPDATE proposal SET description = 'PROBE_PROPOSAL' WHERE id = $1 RETURNING id`, [
          proposal,
        ]),
      ).toEqual([{ id: proposal }]);
      // Nobody creates a proposal in another's name, nor a revision by another, nor outside their session
      expect(
        await code(
          'mwf_app',
          ada,
          `INSERT INTO proposal (session_id, created_by_user_id, description) VALUES ($1, $2, 'x')`,
          [session, bob],
        ),
      ).toBe('rls');
      expect(
        await code(
          'mwf_app',
          ada,
          `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action) VALUES ($1, $2, $3, 'REVISED')`,
          [proposal, session, bob],
        ),
      ).toBe('rls');
      expect(
        await code(
          'mwf_app',
          carol,
          `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action) VALUES ($1, $2, $3, 'REVISED')`,
          [proposal, session, carol],
        ),
      ).toBe('rls');
      // A converted proposal is the worker's: the app cannot revive it (work-k5fk.10.9)
      await run.sql(`UPDATE proposal SET status = 'CONVERTED_TO_AGREEMENT' WHERE id = $1`, [proposal]);
      expect(
        await as('mwf_app', ada, `UPDATE proposal SET status = 'ACTIVE' WHERE id = $1 RETURNING id`, [proposal]),
      ).toEqual([]);
      expect(await count('mwf_app', carol, 'proposal_need')).toBe(0);
      expect(await count('mwf_app', carol, 'proposal_revision')).toBe(0);
    });

    it('a shared proposal’s creator is fixed: Bob reassigns it to nobody, but may make it his own commitment (work-k5fk.10.9)', async () => {
      const [{ id: shared }] = await run.sql<{ id: string }>(
        `INSERT INTO proposal (session_id, created_by_user_id, kind, description)
         VALUES ($1, $2, 'SHARED_PROPOSAL', 'PROBE_SHARED_PROPOSAL') RETURNING id::text`,
        [session, ada],
      );
      const reassign = `UPDATE proposal SET created_by_user_id = $2 WHERE id = $1`;
      // to Ada's partner Bob (himself), keeping it shared: refused
      expect(await code('mwf_app', bob, reassign, [shared, bob])).toBe('42501');
      // to Ada, after an AI-suggested (creatorless) start: refused too
      await run.sql(`UPDATE proposal SET created_by_user_id = NULL WHERE id = $1`, [shared]);
      expect(await code('mwf_app', bob, reassign, [shared, ada])).toBe('42501');
      expect(await code('mwf_app', bob, reassign, [shared, bob])).toBe('42501');
      expect(await run.sql(`SELECT created_by_user_id FROM proposal WHERE id = $1`, [shared])).toEqual([
        { created_by_user_id: null },
      ]);
      // Bob turning it into his own commitment (Stage 4 capture's one creator move): allowed
      expect(
        await code(
          'mwf_app',
          bob,
          `UPDATE proposal SET created_by_user_id = $2, kind = 'INDIVIDUAL_COMMITMENT' WHERE id = $1`,
          [shared, bob],
        ),
      ).toBe('ok');
      expect(
        await run.sql(`SELECT created_by_user_id::text, kind::text FROM proposal WHERE id = $1`, [shared]),
      ).toEqual([{ created_by_user_id: bob, kind: 'INDIVIDUAL_COMMITMENT' }]);
    });

    it('proposal_choice: Bob’s choice is his until he shares it; nobody chooses for him', async () => {
      expect(await count('mwf_app', bob, 'proposal_choice', 'user_id = $1', [bob])).toBe(1);
      expect(await count('mwf_app', ada, 'proposal_choice', 'user_id = $1', [bob])).toBe(0);
      await run.sql(
        `INSERT INTO participant_milestone (session_id, user_id, milestone_key) VALUES ($1, $2, 'choices_shared') ON CONFLICT DO NOTHING`,
        [session, bob],
      );
      expect(await count('mwf_app', ada, 'proposal_choice', 'user_id = $1', [bob])).toBe(1);
      expect(await count('mwf_app', carol, 'proposal_choice')).toBe(0);
      expect(
        await as(
          'mwf_app',
          ada,
          `UPDATE proposal_choice SET decision = 'NOT_WILLING' WHERE user_id = $1 RETURNING user_id`,
          [bob],
        ),
      ).toEqual([]);
    });

    it('agreement, agreement_party, session_closure: their session’s members read them, Carol none', async () => {
      for (const [table, where, params] of [
        ['agreement', 'id = $1', [agreement]],
        ['agreement_party', 'agreement_id = $1', [agreement]],
        ['session_closure', 'session_id = $1', [session]],
      ] as const) {
        expect(await count('mwf_app', bob, table, where, [...params])).toBeGreaterThan(0);
        expect(await count('mwf_app', carol, table, where, [...params])).toBe(0);
      }
    });

    it('follow_up, follow_up_checkin: a check-in is the partner’s only once both have checked in on a SHARED follow-up; Bob cannot share Ada’s entry', async () => {
      expect(await count('mwf_app', bob, 'follow_up', 'id = $1', [shared])).toBe(1);
      expect(await count('mwf_app', carol, 'follow_up')).toBe(0);
      expect(
        await as('mwf_app', bob, `UPDATE follow_up SET opted_in_shared = true WHERE id = $1 RETURNING id`, [
          individual,
        ]),
      ).toEqual([]);
      await run.sql(
        `INSERT INTO follow_up_checkin (follow_up_id, session_id, user_id, payload) VALUES ($1, $2, $3, '{}')`,
        [shared, session, ada],
      );
      expect(await count('mwf_app', bob, 'follow_up_checkin', 'follow_up_id = $1', [shared])).toBe(0);
      // Owner decision 2026-11-25 (work-k5fk.32 S6): hidden until both have submitted — the follow-up going PARTIAL
      // (Ada checked in) or even COMPLETED does not hand Bob her answers before he gives his own.
      await run.sql(`UPDATE follow_up SET status = 'PARTIAL' WHERE id = $1`, [shared]);
      expect(await count('mwf_app', bob, 'follow_up_checkin', 'follow_up_id = $1', [shared])).toBe(0);
      await run.sql(`UPDATE follow_up SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [shared]);
      expect(await count('mwf_app', bob, 'follow_up_checkin', 'follow_up_id = $1', [shared])).toBe(0);
      expect(await count('mwf_app', bob, 'v_follow_up_cycle', `follow_up_id = $1 AND $2 = ANY (submitted_user_ids)`, [shared, ada])).toBe(0);
      await run.sql(
        `INSERT INTO follow_up_checkin (follow_up_id, session_id, user_id, payload) VALUES ($1, $2, $3, '{}')`,
        [shared, session, bob],
      );
      expect(await count('mwf_app', bob, 'follow_up_checkin', 'follow_up_id = $1', [shared])).toBe(2);
      expect(await count('mwf_app', ada, 'follow_up_checkin', 'follow_up_id = $1', [shared])).toBe(2);
      expect(await count('mwf_app', carol, 'follow_up_checkin', 'follow_up_id = $1', [shared])).toBe(0);
      // An INDIVIDUAL follow-up's check-in stays its owner's, whoever else checked in anywhere.
      await run.sql(
        `INSERT INTO follow_up_checkin (follow_up_id, session_id, user_id, payload) VALUES ($1, $2, $3, '{}')`,
        [individual, session, ada],
      );
      expect(await count('mwf_app', bob, 'follow_up_checkin', 'follow_up_id = $1', [individual])).toBe(0);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO follow_up_checkin (follow_up_id, session_id, user_id, payload) VALUES ($1, $2, $3, '{}')`,
          [individual, session, ada],
        ),
      ).toBe('rls');
    });

    it.each([
      ['follow_up_note', `INSERT INTO follow_up_note (session_id, user_id, content) VALUES ($2, $1, 'PROBE_NOTE')`],
      [
        'reminder',
        `INSERT INTO reminder (user_id, remind_at) SELECT $1, now() + interval '1 day' WHERE $2::uuid IS NOT NULL`,
      ],
    ])('%s: Bob neither reads Ada’s nor writes one for her', async (table, insert) => {
      await run.sql(insert, [ada, session]);
      expect(await count('mwf_app', ada, table, 'user_id = $1', [ada])).toBeGreaterThan(0);
      expect(await count('mwf_app', bob, table, 'user_id = $1', [ada])).toBe(0);
      expect(await code('mwf_app', bob, insert, [ada, session])).toBe('rls');
    });
  });

  /**
   * Review r1 (branch9dg/review-r1.md): one test per finding, on the reviewer's repros. Last in the file: they add
   * rows to Ada and Bob's session. A second session (Dave and Erin) stands for "a session Bob is not in" and for a
   * participant who left.
   */
  describe('review r1', () => {
    let dave: string;
    let erin: string;
    let other: string;
    let otherFollowUp: string;
    beforeAll(async () => {
      dave = randomUuidV7();
      erin = randomUuidV7();
      for (const [id, name] of [
        [dave, 'Dave'],
        [erin, 'Erin'],
      ]) {
        await run.sql(`INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, $3)`, [
          id,
          `${name.toLowerCase()}-${process.pid}@e2e.test`,
          name,
        ]);
      }
      [{ id: other }] = await run.sql<{ id: string }>(
        `INSERT INTO session (status, topic_frame) VALUES ('ACTIVE', 'PROBE_OTHER') RETURNING id::text`,
      );
      await run.sql(`INSERT INTO participant (session_id, user_id, kind) VALUES ($1, $2, 'human')`, [other, dave]);
      await run.sql(
        `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'human', $3)`,
        [other, erin, dave],
      );
      [{ id: otherFollowUp }] = await run.sql<{ id: string }>(
        `INSERT INTO follow_up (session_id, type, scope, status) VALUES ($1, 'SCHEDULED_SHARED_AGREEMENT', 'SHARED', 'OPEN')
         RETURNING id::text`,
        [other],
      );
    });

    it('F1: no definer hands Bob Ada’s need wording — first_need_label is gone (each line is its own participant’s)', async () => {
      expect(await run.sql(`SELECT to_regprocedure('app.first_need_label(uuid, uuid)') AS f`)).toEqual([{ f: null }]);
      await run.sql(
        `INSERT INTO need (session_id, user_id, label, category, ai_confidence, confirmed_at) VALUES ($1, $2, 'PROBE_SECRET_NEED', 'AUTONOMY', 0.9, now())`,
        [session, ada],
      );
      expect(await count('mwf_app', bob, 'need', 'user_id = $1', [ada])).toBe(0);
      // the lazy write's one-boolean probe answers only a party of the session
      expect(await as('mwf_app', carol, `SELECT app.stage4_transition_started($1) AS s`, [session])).toEqual([
        { s: false },
      ]);
    });

    it('F2: v_participant gives Bob none of Ada’s mood or read state, and her activity only as her preference allows', async () => {
      await run.sql(
        `INSERT INTO mood_reading (session_id, user_id, intensity, context) VALUES ($1, $2, 7, 'PROBE_MOOD')`,
        [session, ada],
      );
      await run.sql(
        `INSERT INTO conversation_read_state (session_id, user_id, last_viewed_at, last_active_at, archived_at)
         VALUES ($1, $2, now(), now(), now())
         ON CONFLICT (session_id, user_id) DO UPDATE SET last_viewed_at = now(), last_active_at = now(), archived_at = now()`,
        [session, ada],
      );
      const prefs = (show: boolean) =>
        run.sql(
          `INSERT INTO user_preferences (user_id, doc) VALUES ($1, $2::jsonb)
           ON CONFLICT (user_id) DO UPDATE SET doc = jsonb_set(user_preferences.doc, '{privacy}', ($2::jsonb)->'privacy')`,
          [ada, JSON.stringify({ memory: {}, privacy: { showActivityStatus: show }, notifications: {} })],
        );
      const row = (who: string) =>
        as<Record<string, unknown>>(
          'mwf_app',
          who,
          `SELECT last_mood, last_viewed_at, last_seen_seq, archived_at, last_active_at FROM v_participant
           WHERE session_id = $1 AND user_id = $2`,
          [session, ada],
        );
      await prefs(false);
      expect(await row(bob)).toEqual([
        { last_mood: null, last_viewed_at: null, last_seen_seq: null, archived_at: null, last_active_at: null },
      ]);
      await prefs(true);
      const [shown] = await row(bob);
      expect(shown.last_active_at).not.toBeNull();
      expect(shown.last_mood).toBeNull();
      // Ada's own row keeps all of it
      const [own] = await row(ada);
      expect(own.last_mood).toBe(7);
      expect(own.archived_at).not.toBeNull();
    });

    it('F3: an expired invitation cannot be accepted by back-dating the answer', async () => {
      const [{ id: inv }] = await run.sql<{ id: string }>(
        `INSERT INTO invitation (session_id, invited_by_user_id, expires_at, created_at, invitee_name)
         VALUES ($1, $2, now() - interval '1 hour', now() - interval '2 days', 'x') RETURNING id::text`,
        [session, ada],
      );
      expect(
        await code('mwf_app', carol, `SELECT app.invitation_answer($1, 'ACCEPTED', now() - interval '2 hours')`, [inv]),
      ).toBe('23514');
      expect(await code('mwf_app', carol, `SELECT app.invitation_answer($1, 'ACCEPTED')`, [inv])).toBe('23514');
      expect(await run.sql(`SELECT status::text FROM invitation WHERE id = $1`, [inv])).toEqual([
        { status: 'PENDING' },
      ]);
    });

    it('F4: a participant who left keeps reading but writes nothing, and seats no one', async () => {
      await run.sql(`UPDATE participant SET left_at = now() WHERE session_id = $1 AND user_id = $2`, [other, erin]);
      expect(await count('mwf_app', erin, 'session', 'id = $1', [other])).toBe(1); // still reads
      expect(
        await as(
          'mwf_app',
          erin,
          `UPDATE session SET topic_frame = 'leaver rewrote the topic' WHERE id = $1 RETURNING id`,
          [other],
        ),
      ).toEqual([]);
      expect(
        await code(
          'mwf_app',
          erin,
          `INSERT INTO proposal (session_id, created_by_user_id, kind, description) VALUES ($1, $2, 'SHARED_PROPOSAL', 'leaver')`,
          [other, erin],
        ),
      ).toBe('rls');
      expect(
        await code(
          'mwf_app',
          erin,
          `INSERT INTO invitation (session_id, invited_by_user_id, expires_at, invitee_name) VALUES ($1, $2, now() + interval '1 day', 'x')`,
          [other, erin],
        ),
      ).toBe('rls');
      expect(
        await code(
          'mwf_app',
          erin,
          `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, app.ai_user_id(), 'ai', $2)`,
          [other, erin],
        ),
      ).toBe('23514'); // t_participant_added_by (a BEFORE trigger, ahead of the policy's adder arm)
      // an outsider holding the leaver's invitation is not seated by them either (t_participant_added_by)
      await run.sql(
        `INSERT INTO invitation (session_id, invited_by_user_id, expires_at, status, accepted_by_user_id, accepted_at,
                                 claimed_by_user_id, claimed_at)
         VALUES ($1, $2, now() + interval '1 day', 'ACCEPTED', $3, now(), $3, now())`,
        [other, erin, carol],
      );
      expect(
        await code(
          'mwf_app',
          carol,
          `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'human', $3)`,
          [other, carol, erin],
        ),
      ).toBe('23514');
      // control: Dave, present, still writes
      expect(
        await code(
          'mwf_app',
          dave,
          `INSERT INTO proposal (session_id, created_by_user_id, kind, description) VALUES ($1, $2, 'SHARED_PROPOSAL', 'present')`,
          [other, dave],
        ),
      ).toBe('ok');
    });

    it('F5: Bob neither marks Ada’s shared proposal converted, nor removes it in her name, nor attributes his text to her', async () => {
      const proposalOf = async (creator: string, kind: string) =>
        (
          await run.sql<{ id: string }>(
            `INSERT INTO proposal (session_id, created_by_user_id, kind, description) VALUES ($1, $2, $3, 'PROBE_F5') RETURNING id::text`,
            [session, creator, kind],
          )
        )[0].id;
      const adaShared = await proposalOf(ada, 'SHARED_PROPOSAL');
      const bobOwn = await proposalOf(bob, 'INDIVIDUAL_COMMITMENT');
      expect(
        await code('mwf_app', bob, `UPDATE proposal SET status = 'CONVERTED_TO_AGREEMENT' WHERE id = $1`, [adaShared]),
      ).toBe('42501');
      expect(
        await code(
          'mwf_app',
          bob,
          `UPDATE proposal SET status = 'REMOVED', removed_at = now(), removed_by_user_id = $2 WHERE id = $1`,
          [adaShared, ada],
        ),
      ).toBe('42501');
      expect(
        await code(
          'mwf_app',
          bob,
          `UPDATE proposal SET kind = 'SHARED_PROPOSAL', created_by_user_id = $2, description = 'A never wrote this' WHERE id = $1`,
          [bobOwn, ada],
        ),
      ).toBe('42501');
      // a kind-only change never hands Ada a commitment she did not make (owner decision after r1)
      expect(
        await code('mwf_app', bob, `UPDATE proposal SET kind = 'INDIVIDUAL_COMMITMENT' WHERE id = $1`, [adaShared]),
      ).toBe('42501');
      expect(await run.sql(`SELECT status::text, kind::text FROM proposal WHERE id = $1`, [adaShared])).toEqual([
        { status: 'ACTIVE', kind: 'SHARED_PROPOSAL' },
      ]);
      // control: Bob removes the shared proposal in his own name, and restores it
      expect(
        await code(
          'mwf_app',
          bob,
          `UPDATE proposal SET status = 'REMOVED', removed_at = now(), removed_by_user_id = $2 WHERE id = $1`,
          [adaShared, bob],
        ),
      ).toBe('ok');
      expect(
        await code(
          'mwf_app',
          bob,
          `UPDATE proposal SET status = 'ACTIVE', removed_at = NULL, removed_by_user_id = NULL WHERE id = $1`,
          [adaShared],
        ),
      ).toBe('ok');
    });

    it('F6: the AI acting for no one, or for a non-participant, moves no round and delivers nothing', async () => {
      const [{ id: attempt }] = await run.sql<{ id: string }>(
        `SELECT id::text FROM empathy_attempt WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [session],
      );
      const [{ id: adaMain }] = await run.sql<{ id: string }>(
        `SELECT id::text FROM conversation WHERE session_id = $1 AND user_id = $2 AND kind = 'MAIN'`,
        [session, ada],
      );
      for (const actor of [null, carol]) {
        expect(await code('mwf_ai', actor, `SELECT app.empathy_set_status($1, 'READY')`, [attempt], session)).toBe(
          'P0002',
        );
        expect(await code('mwf_ai', actor, `SELECT app.empathy_mark_delivery($1, 'SEEN')`, [attempt], session)).toBe(
          'P0002',
        );
        expect(
          await code(
            'mwf_ai',
            actor,
            `SELECT * FROM app.deliver_message($1, $2, 'SHARED_CONTEXT', 'x')`,
            [adaMain, bob],
            session,
          ),
        ).toBe('P0002');
      }
    });

    it('F9: Ada cannot review Bob’s attempt about her before it is revealed', async () => {
      const [{ id: attempt }] = await run.sql<{ id: string }>(
        `SELECT id::text FROM empathy_attempt WHERE session_id = $1 AND author_user_id = $2 AND subject_user_id = $3
         ORDER BY round DESC LIMIT 1`,
        [session, bob, ada],
      );
      const [{ revealed_at, status }] = await run.sql<{ revealed_at: Date | null; status: string }>(
        `SELECT revealed_at, status::text FROM empathy_attempt WHERE id = $1`,
        [attempt],
      );
      await run.sql(`DELETE FROM empathy_review WHERE attempt_id = $1`, [attempt]);
      await run.sql(`UPDATE empathy_attempt SET status = 'AWAITING_SHARING', revealed_at = NULL WHERE id = $1`, [
        attempt,
      ]);
      const review = `INSERT INTO empathy_review (attempt_id, session_id, reviewer_user_id, validated, feedback, feedback_sent_at)
                      VALUES ($1, $2, $3, true, 'PROBE_EARLY', now())`;
      expect(await code('mwf_app', ada, review, [attempt, session, ada])).toBe('rls');
      // control: once revealed, the subject reviews it
      await run.sql(`UPDATE empathy_attempt SET status = 'REVEALED', revealed_at = now() WHERE id = $1`, [attempt]);
      expect(await code('mwf_app', ada, review, [attempt, session, ada])).toBe('ok');
      await run.sql(`DELETE FROM empathy_review WHERE attempt_id = $1`, [attempt]);
      await run.sql(`UPDATE empathy_attempt SET status = $2::empathy_status, revealed_at = $3 WHERE id = $1`, [
        attempt,
        status,
        revealed_at,
      ]);
    });

    it('F10: Bob cannot strip or add the need links of Ada’s individual commitment', async () => {
      const [{ id: commitment }] = await run.sql<{ id: string }>(
        `INSERT INTO proposal (session_id, created_by_user_id, kind, description) VALUES ($1, $2, 'INDIVIDUAL_COMMITMENT', 'PROBE_F10')
         RETURNING id::text`,
        [session, ada],
      );
      const [{ id: need }] = await run.sql<{ id: string }>(
        `INSERT INTO need (session_id, user_id, label, category, ai_confidence, confirmed_at) VALUES ($1, $2, 'PROBE_F10_NEED', 'SAFETY', 0.9, now())
         RETURNING id::text`,
        [session, ada],
      );
      await run.sql(
        `INSERT INTO consent (session_id, user_id, need_id, decision, decided_at) VALUES ($1, $2, $3, 'GRANTED', now())`,
        [session, ada, need],
      );
      await run.sql(
        `INSERT INTO need_share (need_id, session_id, user_id, category, shared_text) VALUES ($1, $2, $3, 'SAFETY', 'PROBE_F10_SHARED')`,
        [need, session, ada],
      );
      await run.sql(`INSERT INTO proposal_need (proposal_id, need_id, session_id) VALUES ($1, $2, $3)`, [
        commitment,
        need,
        session,
      ]);
      expect(
        await as('mwf_app', bob, `DELETE FROM proposal_need WHERE proposal_id = $1 RETURNING proposal_id`, [
          commitment,
        ]),
      ).toEqual([]);
      await run.sql(`DELETE FROM proposal_need WHERE proposal_id = $1`, [commitment]);
      expect(
        await code('mwf_app', bob, `INSERT INTO proposal_need (proposal_id, need_id, session_id) VALUES ($1, $2, $3)`, [
          commitment,
          need,
          session,
        ]),
      ).toBe('rls');
      // control: Ada links her own commitment
      expect(
        await code('mwf_app', ada, `INSERT INTO proposal_need (proposal_id, need_id, session_id) VALUES ($1, $2, $3)`, [
          commitment,
          need,
          session,
        ]),
      ).toBe('ok');
    });

    it('F11: Ada’s INDIVIDUAL follow-up is hers until she opts it in; Bob checks in on none of it', async () => {
      const [{ id: mine }] = await run.sql<{ id: string }>(
        `INSERT INTO follow_up (session_id, type, scope, owner_user_id, summary, status)
         VALUES ($1, 'SCHEDULED_SHARED_AGREEMENT', 'INDIVIDUAL', $2, 'PROBE_SECRET_FOLLOWUP', 'OPEN') RETURNING id::text`,
        [session, ada],
      );
      expect(await count('mwf_app', bob, 'follow_up', 'id = $1', [mine])).toBe(0);
      expect(await count('mwf_app', ada, 'follow_up', 'id = $1', [mine])).toBe(1);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO follow_up_checkin (follow_up_id, session_id, user_id, payload) VALUES ($1, $2, $3, '{}')`,
          [mine, session, bob],
        ),
      ).toBe('rls');
      await run.sql(`UPDATE follow_up SET opted_in_shared = true WHERE id = $1`, [mine]);
      expect(await count('mwf_app', bob, 'follow_up', 'id = $1', [mine])).toBe(1);
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO follow_up_checkin (follow_up_id, session_id, user_id, payload) VALUES ($1, $2, $3, '{}')`,
          [mine, session, bob],
        ),
      ).toBe('rls');
    });

    it('F14: Bob’s reminder may point only at a follow-up of a session he is in', async () => {
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO reminder (user_id, remind_at, follow_up_id, session_id) VALUES ($1, now(), $2, $3)`,
          [bob, otherFollowUp, other],
        ),
      ).toBe('rls');
      const [{ id: ours }] = await run.sql<{ id: string }>(
        `INSERT INTO follow_up (session_id, type, scope, status) VALUES ($1, 'SCHEDULED_SHARED_AGREEMENT', 'SHARED', 'OPEN')
         RETURNING id::text`,
        [session],
      );
      expect(
        await code(
          'mwf_app',
          bob,
          `INSERT INTO reminder (user_id, remind_at, follow_up_id, session_id) VALUES ($1, now(), $2, $3)`,
          [bob, ours, session],
        ),
      ).toBe('ok');
    });
  });

  /**
   * Review r2 (branch9dg/review-r2.md): one test per item, on the reviewer's repros. A session of Gil and Hal; Hal
   * leaves it after his rows are seeded.
   */
  describe('review r2', () => {
    let gil: string;
    let hal: string;
    let gh: string;
    let halNeed: string;
    let halAttempt: string;
    let halReflection: string;
    beforeAll(async () => {
      gil = randomUuidV7();
      hal = randomUuidV7();
      for (const [id, name] of [
        [gil, 'Gil'],
        [hal, 'Hal'],
      ]) {
        await run.sql(`INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, $3)`, [
          id,
          `${name.toLowerCase()}-${process.pid}@e2e.test`,
          name,
        ]);
      }
      [{ id: gh }] = await run.sql<{ id: string }>(
        `INSERT INTO session (status, topic_frame) VALUES ('ACTIVE', 'PROBE_R2') RETURNING id::text`,
      );
      await run.sql(`INSERT INTO participant (session_id, user_id, kind) VALUES ($1, $2, 'human')`, [gh, gil]);
      await run.sql(
        `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'human', $3)`,
        [gh, hal, gil],
      );
      [{ id: halNeed }] = await run.sql<{ id: string }>(
        `INSERT INTO need (session_id, user_id, label, category, ai_confidence, confirmed_at) VALUES ($1, $2, 'PROBE_R2_NEED', 'SAFETY', 0.9, now())
         RETURNING id::text`,
        [gh, hal],
      );
      await run.sql(
        `INSERT INTO consent (session_id, user_id, need_id, decision, decided_at) VALUES ($1, $2, $3, 'GRANTED', now())`,
        [gh, hal, halNeed],
      );
      [{ id: halAttempt }] = await run.sql<{ id: string }>(
        `INSERT INTO empathy_attempt (session_id, author_user_id, subject_user_id, round, content, status)
         VALUES ($1, $2, $3, 1, 'PROBE_R2_GUESS', 'HELD') RETURNING id::text`,
        [gh, hal, gil],
      );
      [{ id: halReflection }] = await run.sql<{ id: string }>(
        `INSERT INTO reflection (user_id, title, linked_session_id, linked_at) VALUES ($1, 'PROBE_R2_REFLECTION', $2, now()) RETURNING id::text`,
        [hal, gh],
      );
      await run.sql(`UPDATE participant SET left_at = now() WHERE session_id = $1 AND user_id = $2`, [gh, hal]);
    });

    it('N1: a participant who left shares no need and moves no round through the definers', async () => {
      expect(await code('mwf_app', hal, `SELECT app.need_share($1, 'shared after leaving')`, [halNeed])).toBe('42501');
      expect(await run.sql(`SELECT count(*)::int AS n FROM need_share WHERE need_id = $1`, [halNeed])).toEqual([
        { n: 0 },
      ]);
      expect(await code('mwf_app', hal, `SELECT app.empathy_set_status($1, 'READY')`, [halAttempt])).toBe('P0002');
      expect(
        await code('mwf_app', hal, `SELECT app.empathy_set_status($1, 'SUPERSEDED', 'new round after leaving')`, [
          halAttempt,
        ]),
      ).toBe('P0002');
      expect(await run.sql(`SELECT status::text FROM empathy_attempt WHERE id = $1`, [halAttempt])).toEqual([
        { status: 'HELD' },
      ]);
    });

    it('N2: a leaver keeps editing and unlinking their own reflection, but links nothing new to the left session', async () => {
      expect(
        await as('mwf_app', hal, `UPDATE reflection SET title = 'renamed' WHERE id = $1 RETURNING id`, [halReflection]),
      ).toHaveLength(1);
      expect(
        await as('mwf_app', hal, `UPDATE reflection SET linked_session_id = NULL WHERE id = $1 RETURNING id`, [
          halReflection,
        ]),
      ).toHaveLength(1);
      expect(
        await code('mwf_app', hal, `UPDATE reflection SET linked_session_id = $2 WHERE id = $1`, [halReflection, gh]),
      ).toBe('42501');
      expect(
        await code(
          'mwf_app',
          hal,
          `INSERT INTO reflection (user_id, title, linked_session_id, linked_at) VALUES ($1, 'x', $2, now())`,
          [hal, gh],
        ),
      ).toBe('rls');
    });

    it('N3: no proposal is born converted (or removed)', async () => {
      expect(
        await code(
          'mwf_app',
          gil,
          `INSERT INTO proposal (session_id, created_by_user_id, kind, description, status)
           VALUES ($1, $2, 'SHARED_PROPOSAL', 'born converted', 'CONVERTED_TO_AGREEMENT')`,
          [gh, gil],
        ),
      ).toBe('rls');
      expect(
        await code(
          'mwf_app',
          gil,
          `INSERT INTO proposal (session_id, created_by_user_id, kind, description) VALUES ($1, $2, 'SHARED_PROPOSAL', 'born active')`,
          [gh, gil],
        ),
      ).toBe('ok');
    });

    it('N4: a partner neither strips nor takes over the attribution of a removal', async () => {
      const [{ id: p }] = await run.sql<{ id: string }>(
        `INSERT INTO proposal (session_id, created_by_user_id, kind, description) VALUES ($1, $2, 'SHARED_PROPOSAL', 'PROBE_N4')
         RETURNING id::text`,
        [session, ada],
      );
      expect(
        await code(
          'mwf_app',
          ada,
          `UPDATE proposal SET status = 'REMOVED', removed_at = now(), removed_by_user_id = $2, removal_reason = 'A reason' WHERE id = $1`,
          [p, ada],
        ),
      ).toBe('ok');
      expect(await code('mwf_app', bob, `UPDATE proposal SET removed_by_user_id = NULL WHERE id = $1`, [p])).toBe(
        '42501',
      );
      expect(await code('mwf_app', bob, `UPDATE proposal SET removed_by_user_id = $2 WHERE id = $1`, [p, bob])).toBe(
        '42501',
      );
      expect(await run.sql(`SELECT removed_by_user_id::text AS r FROM proposal WHERE id = $1`, [p])).toEqual([
        { r: ada },
      ]);
      // control: a restore clears it together with the status
      expect(
        await code(
          'mwf_app',
          bob,
          `UPDATE proposal SET status = 'ACTIVE', removed_at = NULL, removed_by_user_id = NULL, removal_reason = NULL WHERE id = $1`,
          [p],
        ),
      ).toBe('ok');
    });
  });

  /**
   * Batch B1 (work-k5fk.32, owner decision 2026-11-25: everything a user writes is private until they share it, and
   * the database enforces that). Its own sessions, so nothing above is disturbed: Fay invited Gus, who accepted;
   * a second session where Hal declined Fay's invitation.
   */
  describe('work-k5fk.32 (B1 privacy)', () => {
    let fay: string;
    let gus: string;
    let hal: string;
    let fg: string;
    let declined: string;
    let declinedInvitation: string;
    beforeAll(async () => {
      [fay, gus, hal] = [randomUuidV7(), randomUuidV7(), randomUuidV7()];
      for (const [id, name] of [
        [fay, 'Fay'],
        [gus, 'Gus'],
        [hal, 'Hal'],
      ]) {
        await run.sql(`INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, $3)`, [
          id,
          `b1-${name.toLowerCase()}-${process.pid}@e2e.test`,
          name,
        ]);
      }
      [{ id: fg }] = await run.sql<{ id: string }>(
        `INSERT INTO session (status, topic_frame) VALUES ('ACTIVE', 'PROBE_B1') RETURNING id::text`,
      );
      await run.sql(`INSERT INTO participant (session_id, user_id, kind) VALUES ($1, $2, 'human')`, [fg, fay]);
      await run.sql(
        `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'human', $3)`,
        [fg, gus, fay],
      );
      await run.sql(
        `INSERT INTO invitation (session_id, invited_by_user_id, accepted_by_user_id, claimed_by_user_id, status,
                                 accepted_at, claimed_at, expires_at)
         VALUES ($1, $2, $3, $3, 'ACCEPTED', now(), now(), now() + interval '7 days')`,
        [fg, fay, gus],
      );
      [{ id: declined }] = await run.sql<{ id: string }>(
        `INSERT INTO session (status, topic_frame) VALUES ('INVITED', 'PROBE_B1_DECLINED') RETURNING id::text`,
      );
      await run.sql(`INSERT INTO participant (session_id, user_id, kind) VALUES ($1, $2, 'human')`, [declined, fay]);
      [{ id: declinedInvitation }] = await run.sql<{ id: string }>(
        `INSERT INTO invitation (session_id, invited_by_user_id, claimed_by_user_id, status, declined_at, claimed_at, expires_at)
         VALUES ($1, $2, $3, 'DECLINED', now(), now(), now() + interval '7 days') RETURNING id::text`,
        [declined, fay, hal],
      );
    });

    const reached = async (user: string, key: string) =>
      (
        await run.sql<{ reached_at: Date }>(
          `SELECT reached_at FROM participant_milestone WHERE session_id = $1 AND user_id = $2 AND milestone_key = $3`,
          [fg, user, key],
        )
      )[0]?.reached_at ?? null;
    const reach = (caller: string, user: string, key: string, instant: string | null = null) =>
      code('mwf_app', caller, `SELECT app.reach_milestone($1, $2, $3, $4::timestamptz)`, [fg, user, key, instant]);

    it('S2: a participant-scoped milestone is reached only for oneself; for the partner only a session key, paused, or the inviter’s invitation_sent', async () => {
      // Gus cannot mark Fay's own progress
      for (const key of ['empathy_submitted', 'empathy_ready', 'repair_walkthrough_started']) {
        expect(await reach(gus, fay, key)).toBe('42501');
        expect(await reached(fay, key)).toBeNull();
      }
      // ...but his own, yes
      expect(await reach(gus, gus, 'repair_walkthrough_started')).toBe('ok');
      // a session-scoped fact, and pausing, are reached for everyone at once
      expect(await reach(gus, fay, 'needs_shared')).toBe('ok');
      expect(await reach(gus, fay, 'paused')).toBe('ok');
      // invitation_sent: Gus accepted Fay's invitation, so he may record hers; Fay accepted nothing of Gus's
      expect(await reach(fay, gus, 'invitation_sent')).toBe('42501');
      expect(await reach(gus, fay, 'invitation_sent')).toBe('ok');
      expect(await reached(fay, 'invitation_sent')).not.toBeNull();
      // Carol, in no session of theirs, reaches nothing
      expect(await reach(carol, fay, 'needs_validated')).toBe('P0002');
    });

    it('S7 (schema): the request path’s instant is clamped to the last ten minutes, never ahead', async () => {
      const before = Date.now();
      expect(await reach(gus, gus, 'empathy_submitted', '2000-01-01T00:00:00Z')).toBe('ok');
      expect(await reach(gus, gus, 'empathy_ready', '2999-01-01T00:00:00Z')).toBe('ok');
      const old = (await reached(gus, 'empathy_submitted'))!.getTime();
      const future = (await reached(gus, 'empathy_ready'))!.getTime();
      expect(old).toBeGreaterThanOrEqual(before - 10 * 60_000 - 5_000);
      expect(future).toBeLessThanOrEqual(Date.now() + 1_000);
    });

    it('S7: only the decliner ends the declined session', async () => {
      for (const caller of [gus, carol]) {
        expect(await code('mwf_app', caller, `SELECT app.session_abandon_declined($1)`, [declinedInvitation])).toBe(
          'P0002',
        );
      }
      expect(await code('mwf_app', fay, `SELECT app.session_abandon_declined($1)`, [declinedInvitation])).toBe('P0002');
      expect(await run.sql(`SELECT status::text FROM session WHERE id = $1`, [declined])).toEqual([
        { status: 'INVITED' },
      ]);
      expect(await code('mwf_app', hal, `SELECT app.session_abandon_declined($1)`, [declinedInvitation])).toBe('ok');
      expect(await run.sql(`SELECT status::text FROM session WHERE id = $1`, [declined])).toEqual([
        { status: 'ABANDONED' },
      ]);
    });

    it('S7: a partner’s share offers expire only once the Stage 2 window has closed for everyone', async () => {
      const expire = (caller: string, subjects: string[]) =>
        code('mwf_app', caller, `SELECT app.share_offers_expire($1, $2::uuid[])`, [fg, subjects]);
      expect(await expire(gus, [gus])).toBe('ok');
      expect(await expire(gus, [fay])).toBe('42501');
      expect(await expire(gus, [gus, fay])).toBe('42501');
      expect(await reach(gus, gus, 'empathy_validated')).toBe('ok');
      expect(await expire(gus, [fay])).toBe('42501'); // Fay's window is still open
      expect(await reach(gus, fay, 'empathy_validated')).toBe('ok');
      expect(await expire(gus, [gus, fay])).toBe('ok');
    });

    it('S7: app.partner_user_id is gone (it had no caller)', async () => {
      expect(await run.sql(`SELECT to_regprocedure('app.partner_user_id(uuid)') AS f`)).toEqual([{ f: null }]);
    });

    it('S4: the AI acts for no leaver — reads nothing and writes nothing in the session as them', async () => {
      const [{ id: fayMain }] = await run.sql<{ id: string }>(
        `INSERT INTO conversation (session_id, user_id, kind) VALUES ($1, $2, 'MAIN') RETURNING id::text`,
        [fg, fay],
      );
      const line = `INSERT INTO message (conversation_id, session_id, role, kind, content) VALUES ($1, $2, 'AI', 'CHAT', 'PROBE_AI_LINE') RETURNING seq`;
      // control: acting for Gus while he is present, the AI reads and writes in its scoped session
      expect(await count('mwf_ai', gus, 'conversation', 'session_id = $1', [fg], fg)).toBe(1);
      expect(await code('mwf_ai', gus, line, [fayMain, fg], fg)).toBe('ok');
      await run.sql(`UPDATE participant SET left_at = now() WHERE session_id = $1 AND user_id = $2`, [fg, gus]);
      expect(await count('mwf_ai', gus, 'conversation', 'session_id = $1', [fg], fg)).toBe(0);
      expect(await count('mwf_ai', gus, 'message', 'session_id = $1', [fg], fg)).toBe(0);
      expect(await code('mwf_ai', gus, line, [fayMain, fg], fg)).toBe('rls');
      // acting for Fay, who is still there: unchanged
      expect(await code('mwf_ai', fay, line, [fayMain, fg], fg)).toBe('ok');
    });
  });

  // work-k5fk.37 (owner decision 2026-11-25): an individual commitment is shared by its own action, and sharing
  // releases only its CURRENT text. Its revision history — the earlier wordings in before/after, and the capturedQuote
  // (the sentence of the author's private chat it was captured from, in its CREATED revision's after) — stays its
  // creator's, in the database.
  describe('work-k5fk.37 (B1b: a shared commitment releases only its current text)', () => {
    const commitmentOf = async (description: string) =>
      (
        await run.sql<{ id: string }>(
          `INSERT INTO proposal (session_id, created_by_user_id, kind, description, duration, measure_of_success)
           VALUES ($1, $2, 'INDIVIDUAL_COMMITMENT', $3, 'PROBE_B1B_DURATION', 'PROBE_B1B_MEASURE') RETURNING id::text`,
          [session, ada, description],
        )
      )[0].id;
    const revisionsTouching = (user: string, text: string) =>
      count('mwf_app', user, 'proposal_revision', `before::text LIKE $1 OR after::text LIKE $1`, [`%${text}%`]);

    it('after the share Bob reads its current description, duration and measure — and none of its revisions, so no earlier wording and no quote', async () => {
      const commitment = await commitmentOf('PROBE_B1B_NOW');
      await run.sql(
        `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action, after)
         VALUES ($1, $2, $3, 'CREATED', '{"description": "PROBE_B1B_FIRST", "capturedQuote": "PROBE_B1B_QUOTE"}')`,
        [commitment, session, ada],
      );
      await run.sql(
        `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action, before, after)
         VALUES ($1, $2, $3, 'REVISED', '{"description": "PROBE_B1B_FIRST"}', '{"description": "PROBE_B1B_NOW"}')`,
        [commitment, session, ada],
      );
      expect(await as('mwf_app', ada, `SELECT app.proposal_share($1) AS stamped`, [commitment])).toEqual([
        { stamped: true },
      ]);
      expect(
        await as('mwf_app', bob, `SELECT description, duration, measure_of_success FROM proposal WHERE id = $1`, [
          commitment,
        ]),
      ).toEqual([
        { description: 'PROBE_B1B_NOW', duration: 'PROBE_B1B_DURATION', measure_of_success: 'PROBE_B1B_MEASURE' },
      ]);
      expect(await count('mwf_app', bob, 'proposal_revision', 'proposal_id = $1', [commitment])).toBe(0);
      expect(await revisionsTouching(bob, 'PROBE_B1B_FIRST')).toBe(0);
      expect(await revisionsTouching(bob, 'PROBE_B1B_QUOTE')).toBe(0);
      // Ada reads her own history, quote included
      expect(await count('mwf_app', ada, 'proposal_revision', 'proposal_id = $1', [commitment])).toBe(2);
      expect(await revisionsTouching(ada, 'PROBE_B1B_QUOTE')).toBe(1);
      // control: a SHARED_PROPOSAL's history is every member's (shared from birth)
      const [{ id: shared }] = await run.sql<{ id: string }>(
        `INSERT INTO proposal (session_id, created_by_user_id, kind, description)
         VALUES ($1, $2, 'SHARED_PROPOSAL', 'PROBE_B1B_SHARED') RETURNING id::text`,
        [session, ada],
      );
      await run.sql(
        `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action, after)
         VALUES ($1, $2, $3, 'CREATED', '{"description": "PROBE_B1B_SHARED"}')`,
        [shared, session, ada],
      );
      expect(await count('mwf_app', bob, 'proposal_revision', 'proposal_id = $1', [shared])).toBe(1);
    });

    it('a commitment never becomes a shared proposal, so no kind change releases its history', async () => {
      const unshared = await commitmentOf('PROBE_B1B_KIND');
      expect(await code('mwf_app', ada, `UPDATE proposal SET kind = 'SHARED_PROPOSAL' WHERE id = $1`, [unshared])).toBe(
        '42501',
      );
      expect(await run.sql(`SELECT kind::text FROM proposal WHERE id = $1`, [unshared])).toEqual([
        { kind: 'INDIVIDUAL_COMMITMENT' },
      ]);
    });

    it('a shared proposal Ada makes her commitment is hidden from Bob, history and all, until she shares it — then only its text', async () => {
      const [{ id: converted }] = await run.sql<{ id: string }>(
        `INSERT INTO proposal (session_id, created_by_user_id, kind, description)
         VALUES ($1, $2, 'SHARED_PROPOSAL', 'PROBE_B1B_WAS_SHARED') RETURNING id::text`,
        [session, ada],
      );
      await run.sql(
        `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action, after)
         VALUES ($1, $2, $3, 'CREATED', '{"description": "PROBE_B1B_WAS_SHARED"}')`,
        [converted, session, ada],
      );
      expect(await count('mwf_app', bob, 'proposal_revision', 'proposal_id = $1', [converted])).toBe(1);
      expect(
        await code(
          'mwf_app',
          ada,
          `UPDATE proposal SET kind = 'INDIVIDUAL_COMMITMENT', description = 'PROBE_B1B_MINE_NOW' WHERE id = $1`,
          [converted],
        ),
      ).toBe('ok');
      expect(await count('mwf_app', bob, 'proposal', 'id = $1', [converted])).toBe(0);
      expect(await count('mwf_app', bob, 'proposal_revision', 'proposal_id = $1', [converted])).toBe(0);
      expect(await as('mwf_app', ada, `SELECT app.proposal_share($1) AS stamped`, [converted])).toEqual([
        { stamped: true },
      ]);
      expect(await as('mwf_app', bob, `SELECT description FROM proposal WHERE id = $1`, [converted])).toEqual([
        { description: 'PROBE_B1B_MINE_NOW' },
      ]);
      expect(await count('mwf_app', bob, 'proposal_revision', 'proposal_id = $1', [converted])).toBe(0);
    });
  });
});
