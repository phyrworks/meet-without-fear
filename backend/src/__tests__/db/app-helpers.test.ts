/**
 * Phase 3 W2 — app.current_user_id() and the identity-bound definer helpers,
 * exercised against a real, migrated database.
 *
 * Runs when DB_TEST_URL is set (locally: the migrated
 * meet_without_fear_test database, see docs/development/local-setup.md) or in
 * CI, which migrates DATABASE_URL before the tests. Elsewhere it is skipped.
 * Connects as a superuser and drops to the role under test with SET ROLE, so
 * every privilege check is real. Everything runs in one transaction that is
 * rolled back: the database is left untouched.
 */
import { Client } from 'pg';

const url = process.env.DB_TEST_URL ?? (process.env.CI ? process.env.DATABASE_URL : undefined);
const describeDb = url ? describe : describe.skip;

describeDb('app.* helpers (database)', () => {
  let client: Client;
  const ids: Record<string, string> = {};

  async function asRole(role: string, userId: string | null): Promise<void> {
    await client.query('RESET ROLE');
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId ?? '']);
    await client.query(`SET LOCAL ROLE ${role}`);
  }

  /** Expect a permission error without aborting the fixture transaction. */
  async function expectDenied(sql: string, params: unknown[] = []): Promise<void> {
    await client.query('SAVEPOINT denied');
    await expect(client.query(sql, params)).rejects.toThrow(/permission denied/);
    await client.query('ROLLBACK TO SAVEPOINT denied');
  }

  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await client.query(sql, params);
    return Object.values(rows[0])[0] as T;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    const user = async (tag: string) =>
      scalar<string>(
        `INSERT INTO "User" (email, "updatedAt") VALUES ($1, now()) RETURNING id`,
        [`ts1-${tag}-${Date.now()}@example.test`]
      );
    ids.alice = await user('alice');
    ids.bob = await user('bob');
    ids.carol = await user('carol');
    ids.dave = await user('dave');

    const relationship = async (members: string[]) => {
      const rel = await scalar<string>(`INSERT INTO "Relationship" ("updatedAt") VALUES (now()) RETURNING id`);
      for (const m of members) {
        await client.query(`INSERT INTO "RelationshipMember" ("relationshipId", "userId") VALUES ($1, $2)`, [rel, m]);
      }
      return scalar<string>(
        `INSERT INTO "Session" ("relationshipId", "updatedAt") VALUES ($1, now()) RETURNING id`,
        [rel]
      );
    };
    ids.pairSession = await relationship([ids.alice, ids.bob]);
    ids.trioSession = await relationship([ids.alice, ids.bob, ids.dave]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  describe('app.current_user_id()', () => {
    it('is NULL when the setting was never set in this session', async () => {
      const fresh = new Client({ connectionString: url });
      await fresh.connect();
      try {
        const { rows } = await fresh.query('SELECT app.current_user_id() AS id');
        expect(rows[0].id).toBeNull();
      } finally {
        await fresh.end();
      }
    });

    it('is NULL when set to the empty string, and the uuid when set', async () => {
      await asRole('mwf_app', null);
      expect(await scalar('SELECT app.current_user_id()')).toBeNull();
      await asRole('mwf_app', ids.alice);
      expect(await scalar('SELECT app.current_user_id()')).toBe(ids.alice);
    });

    it('is callable by mwf_job (the owner of the definer helpers)', async () => {
      await asRole('mwf_job', ids.bob);
      expect(await scalar('SELECT app.current_user_id()')).toBe(ids.bob);
    });

    it('is SECURITY INVOKER and STABLE', async () => {
      await client.query('RESET ROLE');
      const { rows } = await client.query(
        `SELECT prosecdef, provolatile FROM pg_proc WHERE oid = 'app.current_user_id()'::regprocedure`
      );
      expect(rows[0]).toEqual({ prosecdef: false, provolatile: 's' });
    });
  });

  describe('app.is_member(session uuid)', () => {
    it('is true for a member, as mwf_app (which cannot read the tables itself)', async () => {
      await asRole('mwf_app', ids.alice);
      expect(await scalar('SELECT app.is_member($1)', [ids.pairSession])).toBe(true);
      await expectDenied('SELECT 1 FROM "RelationshipMember" LIMIT 1');
    });

    it('is false for a non-member', async () => {
      await asRole('mwf_app', ids.carol);
      expect(await scalar('SELECT app.is_member($1)', [ids.pairSession])).toBe(false);
    });

    it('is false (never an error) with no identity set', async () => {
      await asRole('mwf_app', null);
      expect(await scalar('SELECT app.is_member($1)', [ids.pairSession])).toBe(false);
    });

    it('is false for an unknown session', async () => {
      await asRole('mwf_app', ids.alice);
      expect(await scalar('SELECT app.is_member($1)', ['00000000-0000-7000-8000-000000000000'])).toBe(false);
    });

    it('is not executable by roles it was not granted to', async () => {
      await asRole('mwf_ops', ids.alice);
      await expectDenied('SELECT app.is_member($1)', [ids.pairSession]);
      await asRole('mwf_ops', ids.alice);
      await expectDenied('SELECT app.partner_user_id($1)', [ids.pairSession]);
    });
  });

  describe('app.partner_user_id(session uuid)', () => {
    it("returns the other member's id to each member of a two-member relationship", async () => {
      await asRole('mwf_app', ids.alice);
      expect(await scalar('SELECT app.partner_user_id($1)', [ids.pairSession])).toBe(ids.bob);
      await asRole('mwf_app', ids.bob);
      expect(await scalar('SELECT app.partner_user_id($1)', [ids.pairSession])).toBe(ids.alice);
    });

    it('is NULL for a non-member and with no identity', async () => {
      await asRole('mwf_app', ids.carol);
      expect(await scalar('SELECT app.partner_user_id($1)', [ids.pairSession])).toBeNull();
      await asRole('mwf_app', null);
      expect(await scalar('SELECT app.partner_user_id($1)', [ids.pairSession])).toBeNull();
    });

    it('is NULL when the relationship does not have exactly two members', async () => {
      await asRole('mwf_app', ids.alice);
      expect(await scalar('SELECT app.is_member($1)', [ids.trioSession])).toBe(true);
      expect(await scalar('SELECT app.partner_user_id($1)', [ids.trioSession])).toBeNull();
    });
  });

  describe('definer helper shape', () => {
    it('both helpers are SECURITY DEFINER, owned by mwf_job, search_path pinned, not executable by PUBLIC', async () => {
      await client.query('RESET ROLE');
      const { rows } = await client.query(`
        SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
               has_function_privilege('mwf_app', p.oid, 'EXECUTE') AS app_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname IN ('is_member', 'partner_user_id')
        ORDER BY p.proname`);
      expect(rows).toEqual([
        { proname: 'is_member', prosecdef: true, owner: 'mwf_job', proconfig: ['search_path=pg_catalog, public'], public_exec: false, app_exec: true },
        { proname: 'partner_user_id', prosecdef: true, owner: 'mwf_job', proconfig: ['search_path=pg_catalog, public'], public_exec: false, app_exec: true },
      ]);
    });

    it('mwf_job holds exactly the grants the helpers need: SELECT on Session and RelationshipMember', async () => {
      await client.query('RESET ROLE');
      const { rows } = await client.query(`
        SELECT has_table_privilege('mwf_job', '"Session"', 'SELECT') AS session,
               has_table_privilege('mwf_job', '"RelationshipMember"', 'SELECT') AS member,
               has_table_privilege('mwf_job', '"Message"', 'SELECT') AS message,
               has_function_privilege('mwf_job', 'app.current_user_id()', 'EXECUTE') AS cuid`);
      expect(rows[0]).toEqual({ session: true, member: true, message: false, cuid: true });
    });
  });
});
