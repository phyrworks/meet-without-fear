/**
 * work-k5fk.10.2, against a real target run database (owned by mwf_migrator):
 * the request role `mwf_app` holds only the grants tables.sql gives it. It
 * cannot touch key material or telemetry and cannot UPDATE a message —
 * refused by the database, logged in as mwf_app. That it owns nothing is
 * trailer.sql step 20's ("object(s) owned by a runtime login or capability");
 * every privilege it holds, TRUNCATE / REFERENCES / TRIGGER included, is pinned
 * by the privilege-matrix snapshot below.
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
import { Client } from 'pg';
import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, adaAndBob, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

const NO_APP_ACCESS = ['session_key', 'participant_key', 'user_key', 'brain_activity'] as const;

describeTarget('mwf_app grants (target)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;

  beforeAll(async () => {
    run = await openTargetRun('FEEL_HEARD_B', `grants_${process.pid}`);
    ids = await adaAndBob(run);
  });
  afterAll(async () => {
    await run?.drop();
  });

  /** The SQLSTATE a statement as mwf_app (identity: Ada) fails with, or 'ok'. */
  async function asApp(text: string, params: unknown[] = []): Promise<string> {
    try {
      await run.as('mwf_app', ids.adaUser, text, params);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  }

  it.each(NO_APP_ACCESS)('%s: SELECT / UPDATE / DELETE as mwf_app are refused (42501)', async table => {
    expect(await asApp(`SELECT 1 FROM ${table} LIMIT 1`)).toBe('42501');
    expect(await asApp(`UPDATE ${table} SET updated_at = updated_at WHERE false`)).toBe('42501');
    expect(await asApp(`DELETE FROM ${table} WHERE false`)).toBe('42501');
  });

  it('INSERT into the key tables as mwf_app is refused (42501)', async () => {
    expect(
      await asApp(`INSERT INTO session_key (session_id, key_id, wrapped_dek) VALUES ($1, 'k', '\\x00')`, [ids.session]),
    ).toBe('42501');
    expect(
      await asApp(
        `INSERT INTO participant_key (key_id, wrapped_dek, user_id, session_id) VALUES ('k', '\\x00', $1::uuid, $2::uuid)`,
        [ids.adaUser, ids.session],
      ),
    ).toBe('42501');
    expect(
      await asApp(`INSERT INTO user_key (user_id, key_id, wrapped_dek) VALUES ($1, 'k', '\\x00')`, [ids.adaUser]),
    ).toBe('42501');
    expect(
      await asApp(`INSERT INTO brain_activity (session_id, activity_type, model) VALUES ($1, 'LLM_CALL', 'm')`, [
        ids.session,
      ]),
    ).toBe('42501');
  });

  it('mwf_app cannot UPDATE a message — not even its own — and holds UPDATE on no message column', async () => {
    const [own] = await run.sql<{ id: string }>(
      `SELECT m.conversation_id || ':' || m.seq AS id FROM message m WHERE m.session_id = $1 AND m.sender_user_id = $2 ORDER BY m.created_at LIMIT 1`,
      [ids.session, ids.adaUser],
    );
    expect(own).toBeDefined();
    expect(await asApp(`UPDATE message SET content = content WHERE conversation_id || ':' || seq = $1`, [own.id])).toBe(
      '42501',
    );
    expect(await asApp(`UPDATE message SET created_at = created_at WHERE false`)).toBe('42501');
    const [r] = await run.sql<{ upd: boolean }>(
      `SELECT has_any_column_privilege('mwf_app', 'message', 'UPDATE') AS upd`,
    );
    expect(r.upd).toBe(false);
  });

  // Moved from roles-capabilities.target (deleted, test audit 2026-11-17: its catalog checks are step 20's):
  // the one test there of behaviour, that each login's grants reach it through its capability.
  it('the logins work through their capability: mwf_app reads milestone, mwf_auth calls resolve_user, mwf_clinician reads nothing', async () => {
    expect((await run.as('mwf_app', null, `SELECT count(*)::int AS n FROM milestone`))[0]).toEqual({ n: 13 });
    expect((await run.as('mwf_auth', null, `SELECT app.resolve_user('clerk', 'nobody') AS u`))[0]).toEqual({ u: null });
    const [r] = await run.sql<{ any: boolean }>(
      `SELECT bool_or(has_table_privilege('mwf_clinician', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                      OR has_any_column_privilege('mwf_clinician', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')) AS any
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'v', 'm', 'p', 'S')`,
    );
    expect(r.any).toBe(false);
  });

  it('a column outside the grant is refused: mwf_app cannot write user.deleted_at or participant.left_at', async () => {
    expect(await asApp(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [ids.adaUser])).toBe('42501');
    expect(
      await asApp(`UPDATE participant SET left_at = now() WHERE session_id = $1 AND user_id = $2`, [
        ids.session,
        ids.adaUser,
      ]),
    ).toBe('42501');
  });

  describe('message rows mwf_app may write (t_message_app_insert / t_message_app_delete, review M2)', () => {
    let adaConv: string;
    let bobConv: string;
    beforeAll(async () => {
      const convs = await run.sql<{ user_id: string; id: string }>(
        `SELECT user_id, id FROM conversation WHERE session_id = $1 AND user_id IN ($2, $3) AND kind = 'MAIN'`,
        [ids.session, ids.adaUser, ids.bobUser],
      );
      adaConv = convs.find(c => c.user_id === ids.adaUser)!.id;
      bobConv = convs.find(c => c.user_id === ids.bobUser)!.id;
    });
    const insert = (user: string | null, conv: string, sender: string, role: string, kind: string) =>
      run
        .as<{ id: string }>(
          'mwf_app',
          user,
          `INSERT INTO message (conversation_id, role, kind, content, sender_user_id, session_id)
           VALUES ($1::uuid, $3::message_role, $4::message_kind, 'x', $2::uuid, (SELECT x.session_id FROM conversation x WHERE x.id = $1::uuid)) RETURNING conversation_id || ':' || seq AS id`,
          [conv, sender, role, kind],
        )
        .then(
          r => r[0].id,
          (e: { code?: string }) => e.code ?? String(e),
        );
    /** 'ok' (deleted), 'no row' (not the caller's to delete: RLS app_delete leaves it out, work-k5fk.10.7), or the SQLSTATE. */
    const del = (user: string | null, id: string) =>
      run
        .as('mwf_app', user, `DELETE FROM message WHERE conversation_id || ':' || seq = $1 RETURNING 1 AS x`, [id])
        .then(
          r => (r.length ? 'ok' : 'no row'),
          (e: { code?: string }) => e.code ?? String(e),
        );

    it('INSERT: own USER CHAT / EMPATHY_STATEMENT only; never an AI/SYSTEM row or a delivered kind', async () => {
      expect(await insert(ids.adaUser, adaConv, ids.adaUser, 'USER', 'CHAT')).toMatch(/^[0-9a-f-]{36}:[0-9]+$/);
      expect(await insert(ids.adaUser, adaConv, ids.adaUser, 'USER', 'EMPATHY_STATEMENT')).toMatch(
        /^[0-9a-f-]{36}:[0-9]+$/,
      );
      expect(await insert(ids.adaUser, adaConv, ids.adaUser, 'AI', 'CHAT')).toBe('42501');
      expect(await insert(ids.adaUser, adaConv, ids.adaUser, 'USER', 'SHARED_CONTEXT')).toBe('42501');
    });

    it("INSERT: never into the partner's conversation, nor as the partner", async () => {
      expect(await insert(ids.adaUser, bobConv, ids.adaUser, 'USER', 'CHAT')).toBe('42501');
      expect(await insert(ids.adaUser, bobConv, ids.bobUser, 'USER', 'CHAT')).toBe('42501');
      expect(await insert(ids.adaUser, adaConv, ids.bobUser, 'USER', 'CHAT')).toBe('42501');
    });

    it("DELETE: own USER CHAT and a SHARE_SUGGESTION of one's own conversation only", async () => {
      const own = await insert(ids.adaUser, adaConv, ids.adaUser, 'USER', 'CHAT');
      expect(await del(ids.adaUser, own)).toBe('ok');
      const [ai] = await run.sql<{ id: string }>(
        `INSERT INTO message (conversation_id, role, kind, content, session_id) VALUES ($1::uuid, 'AI', 'CHAT', 'x', (SELECT x.session_id FROM conversation x WHERE x.id = $1::uuid)) RETURNING conversation_id || ':' || seq AS id`,
        [adaConv],
      );
      expect(await del(ids.adaUser, ai.id)).toBe('no row');
      const [suggestion] = await run.sql<{ id: string }>(
        `INSERT INTO message (conversation_id, role, kind, content, session_id) VALUES ($1::uuid, 'AI', 'SHARE_SUGGESTION', 'x', (SELECT x.session_id FROM conversation x WHERE x.id = $1::uuid)) RETURNING conversation_id || ':' || seq AS id`,
        [adaConv],
      );
      const [bobsSuggestion] = await run.sql<{ id: string }>(
        `INSERT INTO message (conversation_id, role, kind, content, session_id) VALUES ($1::uuid, 'AI', 'SHARE_SUGGESTION', 'x', (SELECT x.session_id FROM conversation x WHERE x.id = $1::uuid)) RETURNING conversation_id || ':' || seq AS id`,
        [bobConv],
      );
      expect(await del(ids.adaUser, bobsSuggestion.id)).toBe('no row');
      expect(await del(ids.adaUser, suggestion.id)).toBe('ok');
      const bobTurn = await insert(ids.bobUser, bobConv, ids.bobUser, 'USER', 'CHAT');
      expect(await del(ids.adaUser, bobTurn)).toBe('no row');
    });

    it('work-k5fk.10.22: the row checks bind every member of app_access, not only the login named mwf_app', async () => {
      // A second login mapped onto app_access (an IAM user, a split API service) holds mwf_app's grants; before
      // 10.22 the triggers keyed on current_user = 'mwf_app' and let it write an AI line into anyone's thread.
      // Review 9a r2 R2-2: the scratch login and its membership live inside one rolled-back transaction (role
      // catalogs are transactional), so no other session on the cluster ever sees app_access with a second
      // member — step 20's exact-membership check elsewhere cannot race this test. SET ROLE makes it current_user,
      // which is what the trigger reads.
      const login = `rr_app2_${process.pid}`;
      const c = new Client({ connectionString: run.fx.url });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`CREATE ROLE ${login} NOLOGIN`);
        await c.query(`GRANT app_access TO ${login} WITH INHERIT TRUE, SET FALSE`);
        await c.query(`SET LOCAL ROLE ${login}`);
        const forged = await c
          .query(
            `INSERT INTO message (conversation_id, role, kind, content, session_id)
             VALUES ($1::uuid, 'AI', 'CHAT', 'forged', (SELECT x.session_id FROM conversation x WHERE x.id = $1::uuid))`,
            [bobConv],
          )
          .then(
            () => 'ok',
            (e: { code?: string }) => e.code ?? String(e),
          );
        expect(forged).toBe('42501');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      const [{ n }] = await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, [
        login,
      ]);
      expect(n).toBe(0);
    });

    it('work-k5fk.10.7 (closes the FINDING that no identity left only the row shape): with no identity bound, nothing is written', async () => {
      expect(await insert(null, bobConv, ids.bobUser, 'USER', 'CHAT')).toBe('42501');
      expect(await insert(null, bobConv, ids.bobUser, 'AI', 'CHAT')).toBe('42501');
    });
  });

  // M5: the complete privilege matrix of mwf_app's capability app_access (and PUBLIC, which every
  // role inherits): the run database, schemas public and app, their tables, columns and routines —
  // each privilege with WITH GRANT OPTION when grantable — and every default ACL (pg_default_acl,
  // any grantee). Since work-k5fk.10.4 mwf_app holds nothing itself (trailer.sql step 20
  // asserts that); recorded under app_access as a pure re-homing of the mwf_app matrix. Any grant
  // change shows up in the diff of __snapshots__/app-grants.target.test.ts.snap; update it
  // deliberately (jest -u).
  it('the app_access (mwf_app) privilege matrix is exactly the recorded one', async () => {
    const rows = await run.sql<{ line: string }>(PRIVILEGE_MATRIX, [['app_access']]);
    expect(rows.map(r => r.line).join('\n')).toMatchSnapshot();
  });

  // work-k5fk.7: the same matrix for every other role the baseline grants to, plus who owns each
  // routine. Recorded BEFORE the grants of mwf_job, mwf_ops and mwf_auth moved from trailer.sql T7
  // into tables.sql next to each table, so the move is proven a pure move: this snapshot did not
  // change with it. work-k5fk.10.4 re-homed it: mwf_job's grants are job_access's, except those it
  // held only as the definers' owner, now mwf_definer's (with the routines it owns); mwf_ops' are
  // ops_access's, mwf_auth's auth_access's. work-k5fk.10.5 retired job_access: its grants split by call
  // site into ai_access and worker_access (retire-mwf-job.target.test.ts pins those two exactly) and the
  // request-path definers (mwf_definer).
  it('the ai_access / worker_access / ops_access / auth_access / mwf_definer / mwf_migrator privilege matrix is exactly the recorded one', async () => {
    const rows = await run.sql<{ line: string }>(PRIVILEGE_MATRIX, [
      ['ai_access', 'worker_access', 'ops_access', 'auth_access', 'mwf_definer', 'mwf_migrator'],
    ]);
    const owners = await run.sql<{ line: string }>(
      `SELECT 'routine owner ' || p.oid::regprocedure::text || ': ' || pg_get_userbyid(p.proowner) AS line
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'app') ORDER BY line`,
    );
    expect([...rows, ...owners].map(r => r.line).join('\n')).toMatchSnapshot();
  });

  // work-k5fk.10.30: the operations bot's capability — column SELECTs only (trailer T7c). Recorded on its own so
  // the matrices above did not move.
  it('the diag_access (slam_bot_readonly) privilege matrix is exactly the recorded one', async () => {
    const rows = await run.sql<{ line: string }>(PRIVILEGE_MATRIX, [['diag_access']]);
    expect(rows.map(r => r.line).join('\n')).toMatchSnapshot();
  });

  // work-k5fk.10.6 review F3: step 20 proves every grant has a policy, not what the policy says. This pins what
  // each one says — table, name, command, permissive, roles, USING and WITH CHECK — and every table's RLS flags,
  // so a widened predicate (ai_session to USING (true)) or an extra permissive policy shows up as a diff, and the
  // rewrites of rows 9d–9g are reviewed as one. Update deliberately (jest -u).
  it('every row-level policy, and every table’s RLS flags, are exactly the recorded ones', async () => {
    const rows = await run.sql<{ line: string }>(
      `SELECT line FROM (
         SELECT c.oid::regclass::text || ' [rls ' || c.relrowsecurity || ', force ' || c.relforcerowsecurity || ']' AS line
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p')
         UNION ALL
         SELECT pol.polrelid::regclass::text || ' ' || pol.polname || ' FOR '
                || CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                                   WHEN 'd' THEN 'DELETE' ELSE 'ALL' END
                || CASE WHEN pol.polpermissive THEN '' ELSE ' RESTRICTIVE' END
                || ' TO ' || (SELECT string_agg(CASE WHEN x = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END, ',' ORDER BY 1)
                              FROM unnest(pol.polroles) x)
                || ' USING (' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-') || ')'
                || ' CHECK (' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-') || ')'
         FROM pg_policy pol) x ORDER BY line`,
    );
    expect(rows.map(r => r.line).join('\n')).toMatchSnapshot();
  });
});

/**
 * The privilege matrix of the roles in $1 (text[]) and PUBLIC: database, schemas public and app,
 * their tables, columns and routines, and every default ACL. One line per grantee and object.
 */
const PRIVILEGE_MATRIX = `WITH g AS (SELECT oid, CASE WHEN oid = 0 THEN 'PUBLIC' ELSE rolname END AS name
                  FROM (SELECT oid, rolname FROM pg_roles WHERE rolname = ANY($1::text[]) UNION ALL SELECT 0, 'PUBLIC') r)
       SELECT line FROM (
         SELECT 'database: ' || string_agg(a.privilege_type || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END,
                                           ', ' ORDER BY a.privilege_type) || ' (' || g.name || ')' AS line
         FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a JOIN g ON g.oid = a.grantee
         WHERE d.datname = current_database()
         GROUP BY g.name
         UNION ALL
         SELECT 'schema ' || n.nspname || ': ' || a.privilege_type
                || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END || ' (' || g.name || ')'
         FROM pg_namespace n, aclexplode(n.nspacl) a JOIN g ON g.oid = a.grantee
         WHERE n.nspname IN ('public', 'app')
         UNION ALL
         SELECT 'table ' || n.nspname || '.' || c.relname || ': '
                || string_agg(a.privilege_type || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END,
                              ', ' ORDER BY a.privilege_type) || ' (' || g.name || ')'
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a JOIN g ON g.oid = a.grantee
         WHERE n.nspname IN ('public', 'app')
         GROUP BY n.nspname, c.relname, g.name
         UNION ALL
         SELECT 'column ' || n.nspname || '.' || c.relname || ' ' || a.privilege_type
                || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END || ': '
                || string_agg(att.attname, ', ' ORDER BY att.attnum) || ' (' || g.name || ')'
         FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
              aclexplode(att.attacl) a JOIN g ON g.oid = a.grantee
         WHERE n.nspname IN ('public', 'app') AND att.attnum > 0 AND NOT att.attisdropped
         GROUP BY n.nspname, c.relname, a.privilege_type, a.is_grantable, g.name
         UNION ALL
         SELECT 'routine ' || p.oid::regprocedure::text || ': ' || a.privilege_type
                || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END || ' (' || g.name || ')'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
              aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a JOIN g ON g.oid = a.grantee
         WHERE n.nspname IN ('public', 'app')
         UNION ALL
         SELECT 'default acl for ' || pg_get_userbyid(da.defaclrole)
                || coalesce(' in schema ' || n.nspname, '') || ' on ' || da.defaclobjtype::text || ': '
                || a.privilege_type || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
                || ' (' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ')'
         FROM pg_default_acl da LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace, aclexplode(da.defaclacl) a
         UNION ALL
         SELECT 'default acl rows: ' || count(*) FROM pg_default_acl
       ) m ORDER BY line`;
