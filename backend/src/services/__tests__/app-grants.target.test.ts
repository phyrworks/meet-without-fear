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
});
