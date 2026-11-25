/**
 * app.current_user_id() and the identity-bound definer helper app.is_member (app.partner_user_id is gone,
 * work-k5fk.32 S7), as the
 * logins production uses see them (work-k5fk.10.19: ported from the old shape's Phase 3 W2 suite).
 *
 * On a clone of the CREATED target fixture, seeded through the target tables ("user", session, participant):
 * a two-human session (Alice, Bob), a three-human one (Alice, Dave, Erin), and Carol, who is in neither. Every
 * call runs as a real login (mwf_app, mwf_ai, mwf_worker, mwf_ops, mwf_auth) with the identity bound as
 * lib/prisma-identity binds it, so every privilege check is the baseline's own. (app.my_participant went with
 * participant.id in work-k5fk.3: the caller's seat is (session_id, app.current_user_id()), so there is nothing
 * left to test.)
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build CREATED
 */
import { Client } from 'pg';
import { isTargetShape } from '../../testing/golden/shape';
import {
  appUrlFor,
  openTargetRun,
  randomUuidV7,
  type RunRole,
  type TargetRun,
} from '../../services/__tests__/target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('app.* identity helpers (database, target shape)', () => {
  let run: TargetRun;
  const alice = randomUuidV7();
  const bob = randomUuidV7();
  const carol = randomUuidV7();
  const dave = randomUuidV7();
  const erin = randomUuidV7();
  let pair: string;
  let trio: string;

  /** The one value `sql` returns, as `role` acting for `user` (null: no identity bound). */
  const scalar = async (role: RunRole, user: string | null, sql: string, params: unknown[] = []) =>
    Object.values((await run.as(role, user, sql, params))[0])[0];

  /** How a call as `role` ends: 'ok', or its SQLSTATE (42501: permission denied). */
  const code = async (role: RunRole, sql: string, params: unknown[] = []) => {
    try {
      await run.as(role, alice, sql, params);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `app_helpers_${process.pid}`);
    for (const [id, name] of [
      [alice, 'Alice'],
      [bob, 'Bob'],
      [carol, 'Carol'],
      [dave, 'Dave'],
      [erin, 'Erin'],
    ]) {
      await run.sql(`INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, $3)`, [
        id,
        `helpers-${name.toLowerCase()}-${process.pid}@e2e.test`,
        name,
      ]);
    }
    /** A session started by the first user, every other one added by them. */
    const session = async (initiator: string, ...others: string[]) => {
      const [{ id }] = await run.sql<{ id: string }>(
        `INSERT INTO session (status) VALUES ('ACTIVE') RETURNING id::text`,
      );
      await run.sql(`INSERT INTO participant (session_id, user_id) VALUES ($1, $2)`, [id, initiator]);
      for (const o of others) {
        await run.sql(`INSERT INTO participant (session_id, user_id, added_by_user_id) VALUES ($1, $2, $3)`, [
          id,
          o,
          initiator,
        ]);
      }
      return id;
    };
    pair = await session(alice, bob);
    // Two humans per session is today's cap (work-k5fk.10.38, app.session_human_limit), not these helpers': they are
    // N-safe for when it lifts, so the trio is seated with the cap's trigger off in this run's own database.
    await run.sql(`ALTER TABLE participant DISABLE TRIGGER t_human_limit`);
    trio = await session(alice, dave, erin);
    await run.sql(`ALTER TABLE participant ENABLE TRIGGER t_human_limit`);
  });
  afterAll(async () => {
    await run?.drop();
  });

  describe('app.current_user_id()', () => {
    it('is NULL when the setting was never set, and the bound id when it is', async () => {
      expect(await scalar('mwf_app', null, 'SELECT app.current_user_id()')).toBeNull();
      expect(await scalar('mwf_app', alice, 'SELECT app.current_user_id()')).toBe(alice);
    });

    it('is NULL when the setting is the empty string (fail-closed, not a cast error)', async () => {
      const c = new Client({ connectionString: appUrlFor(run.fx.target, run.fx.database) });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.current_user_id', '', true)`);
        expect((await c.query('SELECT app.current_user_id() AS id')).rows[0].id).toBeNull();
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    });

    it('is callable by the request, dashboard and auth logins, and by no other', async () => {
      expect(await code('mwf_app', 'SELECT app.current_user_id()')).toBe('ok');
      expect(await code('mwf_ops', 'SELECT app.current_user_id()')).toBe('ok');
      expect(await code('mwf_auth', 'SELECT app.current_user_id()')).toBe('ok');
      expect(await code('mwf_ai', 'SELECT app.current_user_id()')).toBe('42501');
      expect(await code('mwf_worker', 'SELECT app.current_user_id()')).toBe('42501');
    });
  });

  describe('app.is_member(session)', () => {
    it('is true for each member and false for a non-member', async () => {
      expect(await scalar('mwf_app', alice, 'SELECT app.is_member($1)', [pair])).toBe(true);
      expect(await scalar('mwf_app', bob, 'SELECT app.is_member($1)', [pair])).toBe(true);
      expect(await scalar('mwf_app', dave, 'SELECT app.is_member($1)', [trio])).toBe(true);
      expect(await scalar('mwf_app', carol, 'SELECT app.is_member($1)', [pair])).toBe(false);
      expect(await scalar('mwf_app', dave, 'SELECT app.is_member($1)', [pair])).toBe(false);
    });

    it('is false (never an error) with no identity, and for an unknown session', async () => {
      expect(await scalar('mwf_app', null, 'SELECT app.is_member($1)', [pair])).toBe(false);
      expect(await scalar('mwf_app', alice, 'SELECT app.is_member($1)', [randomUuidV7()])).toBe(false);
    });
  });

  it('app.partner_user_id is gone: it had no caller (work-k5fk.32 S7)', async () => {
    expect(await run.sql(`SELECT to_regprocedure('app.partner_user_id(uuid)') AS f`)).toEqual([{ f: null }]);
  });

  describe('who may call the definer helpers', () => {
    it.each<RunRole>(['mwf_ai', 'mwf_worker', 'mwf_ops', 'mwf_auth'])(
      '%s, which holds no grant on it, cannot EXECUTE app.is_member',
      async role => {
        expect(await code(role, 'SELECT app.is_member($1)', [pair])).toBe('42501');
      },
    );

    it('they run as mwf_definer with a pinned search_path, PUBLIC holds no EXECUTE, and current_user_id is an invoker', async () => {
      const rows = await run.sql(`
        SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname IN ('current_user_id', 'is_member')
        ORDER BY p.proname`);
      const definer = {
        prosecdef: true,
        owner: 'mwf_definer',
        proconfig: ['search_path=pg_catalog, public, pg_temp'],
        public_exec: false,
      };
      expect(rows).toEqual([
        {
          proname: 'current_user_id',
          prosecdef: false,
          owner: expect.any(String),
          proconfig: null,
          public_exec: false,
        },
        { proname: 'is_member', ...definer },
      ]);
    });
  });
});
