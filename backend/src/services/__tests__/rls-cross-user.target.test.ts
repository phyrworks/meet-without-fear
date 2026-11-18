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
import { adaAndBob, openTargetRun, randomUuidV7, type RunRole, type TargetRun } from './target-roles';

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
    it('"user": Carol reads only herself (and the AI); Ada reads Bob, her co-participant; Bob cannot rename Ada', async () => {
      expect(await count('mwf_app', carol, '"user"', 'id = ANY($1::uuid[])', [[ada, bob]])).toBe(0);
      expect(await count('mwf_app', carol, '"user"', "kind = 'human'")).toBe(1);
      expect(await count('mwf_app', ada, '"user"', 'id = $1', [bob])).toBe(1);
      expect(await count('mwf_app', ada, '"user"', 'id = $1', [carol])).toBe(0);
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

    it('invitation: Carol cannot read or confirm it; app.invitation_peek shows her its status only', async () => {
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
      const peek = await as<{ status: string; session_id: string }>(
        'mwf_app',
        carol,
        `SELECT status::text, session_id::text FROM app.invitation_peek($1)`,
        [id],
      );
      expect(peek).toEqual([{ status: 'ACCEPTED', session_id: session }]);
      // the answer is the invitee's, once: an accepted invitation is not Carol's to re-answer
      expect(await code('mwf_app', carol, `SELECT app.invitation_answer($1, 'DECLINED')`, [id])).toBe('23514');
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
        `INSERT INTO user_device (user_id, push_token) VALUES ($1, 'ExponentPushToken[ada]')`,
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

    it('the worker clears a push token but never sets one, and never writes a telemetry blob (work-k5fk.10.29 R1, R2)', async () => {
      await run.sql(`INSERT INTO user_device (user_id, push_token) VALUES ($1, 'ExponentPushToken[w]')`, [bob]);
      expect(
        await code(
          'mwf_worker',
          null,
          `UPDATE user_device SET push_token = 'ExponentPushToken[evil]' WHERE user_id = $1`,
          [bob],
        ),
      ).toBe('rls');
      expect(
        await as('mwf_worker', null, `UPDATE user_device SET push_token = NULL WHERE user_id = $1 RETURNING user_id`, [
          bob,
        ]),
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
          `UPDATE brain_activity SET input = NULL, output = NULL, metadata = NULL, structured_output = NULL WHERE session_id = $1`,
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

    it('conversation: Bob sees Ada’s MAIN conversation row (its address) but not her sub-chat, and cannot change it', async () => {
      const adaMain = await mainOf(ada);
      const [{ id: sub }] = await run.sql<{ id: string }>(
        `INSERT INTO conversation (session_id, user_id, kind, anchor_kind) VALUES ($1, $2, 'SUBCHAT', 'NEEDS_BRAINSTORM') RETURNING id::text`,
        [session, ada],
      );
      expect(await count('mwf_app', bob, 'conversation', 'id = $1', [adaMain])).toBe(1);
      expect(await count('mwf_app', bob, 'conversation', 'id = $1', [sub])).toBe(0);
      expect(await count('mwf_app', carol, 'conversation')).toBe(0);
      expect(
        await as('mwf_app', bob, `UPDATE conversation SET status = 'RESOLVED' WHERE id = $1 RETURNING id`, [adaMain]),
      ).toEqual([]);
      expect(
        await code('mwf_app', bob, `INSERT INTO conversation (session_id, user_id, kind, anchor_kind) VALUES ($1, $2, 'SUBCHAT', 'NEEDS_BRAINSTORM')`, [
          session,
          ada,
        ]),
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
        await code('mwf_app', carol, `INSERT INTO reflection (user_id, linked_session_id) VALUES ($1, $2)`, [
          carol,
          session,
        ]),
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
});
