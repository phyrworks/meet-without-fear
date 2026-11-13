/**
 * work-k5fk.10.2, against a real target run database (owned by mwf_migrator):
 * the request role `mwf_app` holds only the grants tables.sql gives it. It
 * cannot touch key material or telemetry, cannot UPDATE a message, owns
 * nothing, and holds no TRUNCATE / REFERENCES / TRIGGER anywhere — refused by
 * the database, logged in as mwf_app.
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
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

  it('the run database and every object in it belong to mwf_migrator; mwf_app owns nothing', async () => {
    const [r] = await run.sql<{ db_owner: string; owners: string[]; app_owns: string }>(
      `SELECT pg_get_userbyid(d.datdba) AS db_owner,
              ARRAY(SELECT DISTINCT pg_get_userbyid(c.relowner)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname IN ('public', 'app')) AS owners,
              (SELECT count(*) FROM pg_class c WHERE c.relowner = 'mwf_app'::regrole)
                + (SELECT count(*) FROM pg_proc p WHERE p.proowner = 'mwf_app'::regrole)
                + (SELECT count(*) FROM pg_type t WHERE t.typowner = 'mwf_app'::regrole) AS app_owns
       FROM pg_database d WHERE d.datname = current_database()`,
    );
    expect(r.db_owner).toBe('mwf_migrator');
    expect(r.owners).toEqual(['mwf_migrator']);
    expect(Number(r.app_owns)).toBe(0);
  });

  it.each(NO_APP_ACCESS)('%s: mwf_app holds no privilege at all, table or column', async table => {
    const [r] = await run.sql<{ any_table: boolean; any_column: boolean }>(
      `SELECT has_table_privilege('mwf_app', $1, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS any_table,
              has_any_column_privilege('mwf_app', $1, 'SELECT, INSERT, UPDATE, REFERENCES') AS any_column`,
      [table],
    );
    expect(r).toEqual({ any_table: false, any_column: false });
  });

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
      await asApp(`INSERT INTO participant_key (participant_id, key_id, wrapped_dek) VALUES ($1, 'k', '\\x00')`, [
        ids.ada,
      ]),
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
      `SELECT m.id FROM message m WHERE m.sender_participant_id = $1 ORDER BY m.created_at LIMIT 1`,
      [ids.ada],
    );
    expect(own).toBeDefined();
    expect(await asApp(`UPDATE message SET content = content WHERE id = $1`, [own.id])).toBe('42501');
    expect(await asApp(`UPDATE message SET created_at = created_at WHERE false`)).toBe('42501');
    const [r] = await run.sql<{ upd: boolean }>(
      `SELECT has_any_column_privilege('mwf_app', 'message', 'UPDATE') AS upd`,
    );
    expect(r.upd).toBe(false);
  });

  it('mwf_app holds no TRUNCATE, REFERENCES or TRIGGER on any table', async () => {
    const rows = await run.sql<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND has_table_privilege('mwf_app', c.oid, 'TRUNCATE, REFERENCES, TRIGGER')`,
    );
    expect(rows).toEqual([]);
  });

  it('a column outside the grant is refused: mwf_app cannot write user.deleted_at or participant.left_at', async () => {
    expect(await asApp(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [ids.adaUser])).toBe('42501');
    expect(await asApp(`UPDATE participant SET left_at = now() WHERE id = $1`, [ids.ada])).toBe('42501');
  });

  describe('message rows mwf_app may write (t_message_app_insert / t_message_app_delete, review M2)', () => {
    let adaConv: string;
    let bobConv: string;
    beforeAll(async () => {
      const convs = await run.sql<{ participant_id: string; id: string }>(
        `SELECT participant_id, id FROM conversation WHERE participant_id IN ($1, $2) AND kind = 'MAIN'`,
        [ids.ada, ids.bob],
      );
      adaConv = convs.find(c => c.participant_id === ids.ada)!.id;
      bobConv = convs.find(c => c.participant_id === ids.bob)!.id;
    });
    const insert = (user: string | null, conv: string, sender: string, role: string, kind: string) =>
      run
        .as<{ id: string }>(
          'mwf_app',
          user,
          `INSERT INTO message (conversation_id, sender_participant_id, role, kind, content)
           VALUES ($1, $2, $3::message_role, $4::message_kind, 'x') RETURNING id`,
          [conv, sender, role, kind],
        )
        .then(
          r => r[0].id,
          (e: { code?: string }) => e.code ?? String(e),
        );
    const del = (user: string | null, id: string) =>
      run.as('mwf_app', user, `DELETE FROM message WHERE id = $1`, [id]).then(
        () => 'ok',
        (e: { code?: string }) => e.code ?? String(e),
      );

    it('INSERT: own USER CHAT / EMPATHY_STATEMENT only; never an AI/SYSTEM row or a delivered kind', async () => {
      expect(await insert(ids.adaUser, adaConv, ids.ada, 'USER', 'CHAT')).toMatch(/^[0-9a-f-]{36}$/);
      expect(await insert(ids.adaUser, adaConv, ids.ada, 'USER', 'EMPATHY_STATEMENT')).toMatch(/^[0-9a-f-]{36}$/);
      expect(await insert(ids.adaUser, adaConv, ids.ada, 'AI', 'CHAT')).toBe('42501');
      expect(await insert(ids.adaUser, adaConv, ids.ada, 'USER', 'SHARED_CONTEXT')).toBe('42501');
    });

    it("INSERT: never into the partner's conversation, nor as the partner", async () => {
      expect(await insert(ids.adaUser, bobConv, ids.ada, 'USER', 'CHAT')).toBe('42501');
      expect(await insert(ids.adaUser, bobConv, ids.bob, 'USER', 'CHAT')).toBe('42501');
      expect(await insert(ids.adaUser, adaConv, ids.bob, 'USER', 'CHAT')).toBe('42501');
    });

    it("DELETE: own USER CHAT and a SHARE_SUGGESTION of one's own conversation only", async () => {
      const own = await insert(ids.adaUser, adaConv, ids.ada, 'USER', 'CHAT');
      expect(await del(ids.adaUser, own)).toBe('ok');
      const [ai] = await run.sql<{ id: string }>(
        `INSERT INTO message (conversation_id, role, kind, content) VALUES ($1, 'AI', 'CHAT', 'x') RETURNING id`,
        [adaConv],
      );
      expect(await del(ids.adaUser, ai.id)).toBe('42501');
      const [suggestion] = await run.sql<{ id: string }>(
        `INSERT INTO message (conversation_id, role, kind, content) VALUES ($1, 'AI', 'SHARE_SUGGESTION', 'x') RETURNING id`,
        [adaConv],
      );
      const [bobsSuggestion] = await run.sql<{ id: string }>(
        `INSERT INTO message (conversation_id, role, kind, content) VALUES ($1, 'AI', 'SHARE_SUGGESTION', 'x') RETURNING id`,
        [bobConv],
      );
      expect(await del(ids.adaUser, bobsSuggestion.id)).toBe('42501');
      expect(await del(ids.adaUser, suggestion.id)).toBe('ok');
      const bobTurn = await insert(ids.bobUser, bobConv, ids.bob, 'USER', 'CHAT');
      expect(await del(ids.adaUser, bobTurn)).toBe('42501');
    });

    it('FINDING: with no identity bound, whose conversation it is cannot be checked — only the row shape', async () => {
      expect(await insert(null, bobConv, ids.bob, 'USER', 'CHAT')).toMatch(/^[0-9a-f-]{36}$/);
      expect(await insert(null, bobConv, ids.bob, 'AI', 'CHAT')).toBe('42501');
    });
  });

  // M5: the complete privilege matrix of mwf_app (and PUBLIC, which it inherits): the run
  // database, schemas public and app, their tables, columns and routines — each privilege with
  // WITH GRANT OPTION when grantable — and every default ACL (pg_default_acl, any grantee). Any
  // grant change shows up in the diff of __snapshots__/app-grants.target.test.ts.snap; update it
  // deliberately (jest -u).
  it('the mwf_app privilege matrix is exactly the recorded one', async () => {
    const rows = await run.sql<{ line: string }>(
      `WITH g AS (SELECT oid, CASE WHEN oid = 0 THEN 'PUBLIC' ELSE rolname END AS name
                  FROM (SELECT oid, rolname FROM pg_roles WHERE rolname = 'mwf_app' UNION ALL SELECT 0, 'PUBLIC') r)
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
       ) m ORDER BY line`,
    );
    expect(rows.map(r => r.line).join('\n')).toMatchSnapshot();
  });
});
