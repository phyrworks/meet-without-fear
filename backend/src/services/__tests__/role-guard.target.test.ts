/**
 * work-k5fk.10.3, against a real target run database (a clone of the
 * FEEL_HEARD_B fixture, owned by mwf_migrator): a runtime Prisma client
 * refuses a superuser login (mwf_user) and the owner (mwf_migrator), and
 * accepts the least-privilege logins (mwf_app in app_access, mwf_ai in
 * ai_access, mwf_worker in worker_access: one capability each, owning nothing —
 * work-k5fk.10.4, .10.5).
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
import { aiUrlFor, appUrlFor, workerUrlFor } from '../../testing/golden/driver';
import { restoreFixture, type RestoredFixture } from '../../testing/golden/fixtures';
import { isTargetShape } from '../../testing/golden/shape';
import { migratorTarget } from '../../testing/golden/target-baseline';
import { toDbUrl, withClient } from '../../testing/golden/db';
import { BASE_URL } from './target-roles';
import { createPrismaClient } from '../../lib/prisma';
import { Client } from 'pg';
import {
  RuntimeRoleRefusedError,
  ROLE_GUARD_SQL,
  roleGuardViolations,
  type RoleFacts,
} from '../../lib/prisma-role-guard';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('runtime role guard (target)', () => {
  let fx: RestoredFixture;

  beforeAll(async () => {
    fx = await restoreFixture({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `guard_${process.pid}` });
  });
  afterAll(async () => {
    await fx?.drop();
  });

  async function firstQuery(url: string, role: 'app' | 'ai' | 'worker' = 'app'): Promise<unknown> {
    const client = createPrismaClient({ url, role });
    try {
      return await client.$queryRaw`SELECT current_user::text AS who`;
    } catch (e) {
      return e;
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
  }

  it('refuses the superuser (mwf_user): SUPERUSER and BYPASSRLS', async () => {
    const r = await firstQuery(fx.url);
    expect(r).toBeInstanceOf(RuntimeRoleRefusedError);
    expect((r as Error).message).toMatch(/is a SUPERUSER/);
    expect((r as Error).message).toMatch(/has BYPASSRLS/);
  });

  it('refuses the owner (mwf_migrator): it owns the tables, and can SET ROLE mwf_definer', async () => {
    const r = await firstQuery(toDbUrl({ ...migratorTarget(fx.target), database: fx.database }), 'worker');
    expect(r).toBeInstanceOf(RuntimeRoleRefusedError);
    expect((r as Error).message).toMatch(/mwf_migrator owns objects in public\/app: .*\(owner mwf_migrator\)/);
  });

  it('accepts mwf_app', async () => {
    expect(await firstQuery(appUrlFor(fx.target, fx.database))).toEqual([{ who: 'mwf_app' }]);
  });

  it('accepts mwf_ai as the AI and mwf_worker as the worker (work-k5fk.10.5), and refuses each as another client', async () => {
    expect(await firstQuery(aiUrlFor(fx.target, fx.database), 'ai')).toEqual([{ who: 'mwf_ai' }]);
    expect(await firstQuery(workerUrlFor(fx.target, fx.database), 'worker')).toEqual([{ who: 'mwf_worker' }]);
    const aiAsApp = await firstQuery(aiUrlFor(fx.target, fx.database), 'app');
    expect(aiAsApp).toBeInstanceOf(RuntimeRoleRefusedError);
    expect((aiAsApp as Error).message).toMatch(
      /mwf_ai reaches role\(s\) ai_access .*the app login may reach app_access only/,
    );
    expect((aiAsApp as Error).message).not.toMatch(/owns objects/);
    const workerAsAi = await firstQuery(workerUrlFor(fx.target, fx.database), 'ai');
    expect((workerAsAi as Error).message).toMatch(
      /mwf_worker reaches role\(s\) worker_access .*the ai login may reach ai_access only/,
    );
  });

  it('H1: refuses a superuser login whose session starts as mwf_app (options=-c role=mwf_app)', async () => {
    const url = new URL(fx.url);
    url.searchParams.set('options', '-c role=mwf_app');
    const r = await firstQuery(url.toString());
    expect(r).toBeInstanceOf(RuntimeRoleRefusedError);
    expect((r as Error).message).toMatch(/the login mwf_user runs as mwf_app \(session_user <> current_user/);
    expect((r as Error).message).toMatch(/mwf_user is a SUPERUSER/);
  });

  describe('H2, live: a scratch login, changed one way at a time', () => {
    // Cluster-level scratch roles, unique to this process, dropped in afterAll.
    const login = `rr_guard_${process.pid}`;
    const empty = `rr_guard_empty_${process.pid}`;
    const pw = 'rr_guard_pw';
    const admin = (sql: string, database?: string) =>
      withClient(fx.target, c => c.query(sql), database ?? fx.database).then(() => undefined);
    const loginUrl = () => `postgresql://${login}:${pw}@${fx.target.host}:${fx.target.port}/${fx.database}`;
    const refusal = async (): Promise<string> => {
      const r = await firstQuery(loginUrl());
      return r instanceof RuntimeRoleRefusedError ? r.message : `accepted: ${JSON.stringify(r)}`;
    };

    beforeAll(async () => {
      await admin(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
      await admin(`CREATE ROLE ${empty} NOLOGIN`);
    });
    afterAll(async () => {
      // Undo every cluster- or database-level change a failed test may have left, each tolerant
      // of "already gone", before the roles go: a parameter ACL (cluster-wide) would otherwise
      // block DROP ROLE and leak the role.
      const tolerant = (sql: string, database?: string) => admin(sql, database).catch(() => undefined);
      await tolerant(`REVOKE SET ON PARAMETER session_replication_role FROM ${login}`, 'postgres');
      await tolerant(`ALTER DATABASE "${fx.database}" OWNER TO mwf_migrator`, 'postgres');
      await tolerant(`ALTER SCHEMA public OWNER TO pg_database_owner`);
      await tolerant(`REVOKE CREATE ON DATABASE "${fx.database}" FROM ${login}`);
      await tolerant(`REVOKE ${empty}, mwf_ai, mwf_user FROM ${login}`, 'postgres');
      await tolerant(`REVOKE mwf_ai FROM ${empty}`, 'postgres');
      await admin(`DROP OWNED BY ${login}`).catch(() => undefined);
      await admin(`DROP ROLE IF EXISTS ${login}`, 'postgres');
      await admin(`DROP ROLE IF EXISTS ${empty}`, 'postgres');
    });

    it('a plain login with nothing is accepted', async () => {
      expect(await refusal()).toBe(`accepted: [{"who":"${login}"}]`);
    });

    it('membership only (in a role that owns and grants nothing) is refused', async () => {
      await admin(`GRANT ${empty} TO ${login}`);
      try {
        const m = await refusal();
        expect(m).toContain(`${login} reaches role(s) ${empty} (directly or through another role`);
        expect(m).not.toMatch(/owns objects|SUPERUSER|SET ROLE to superuser/);
      } finally {
        await admin(`REVOKE ${empty} FROM ${login}`);
      }
    });

    it("membership in another login (as production's mwf_job TO mwf_app WITH SET was) is refused", async () => {
      await admin(`GRANT mwf_ai TO ${login} WITH INHERIT FALSE, SET TRUE`);
      try {
        expect(await refusal()).toContain(`${login} reaches role(s) ai_access, mwf_ai (`); // mwf_ai is in ai_access
      } finally {
        await admin(`REVOKE mwf_ai FROM ${login}`);
      }
    });

    // Review 9a r2 R2-2: a membership in app_access is never committed here. step 20 asserts app_access has
    // exactly one member (mwf_app), and role catalogs are cluster-wide, so a committed scratch member would
    // break a baseline deploy in any other session on the cluster while this test runs. These cases grant
    // inside one transaction, become the scratch login with SET LOCAL SESSION AUTHORIZATION (session_user is
    // what ROLE_GUARD_SQL reads), read the facts and roll back: no other session ever sees the grant.
    async function refusalInTx(grants: string[]): Promise<string> {
      const c = new Client({ connectionString: fx.url });
      await c.connect();
      try {
        await c.query('BEGIN');
        for (const g of grants) await c.query(g);
        await c.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
        const { rows } = await c.query<{ facts: string }>(ROLE_GUARD_SQL);
        const v = roleGuardViolations(JSON.parse(rows[0].facts) as RoleFacts, 'app');
        return v.length ? v.join('; ') : 'accepted';
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    }

    it('work-k5fk.10.4: the app capability alone is accepted; a second role beside it is refused', async () => {
      expect(await refusalInTx([`GRANT app_access TO ${login} WITH INHERIT TRUE, SET FALSE`])).toBe('accepted');
      expect(
        await refusalInTx([`GRANT app_access TO ${login} WITH INHERIT TRUE, SET FALSE`, `GRANT ${empty} TO ${login}`]),
      ).toContain(`${login} reaches role(s) ${empty}`);
      const [{ n }] = (
        await withClient(
          fx.target,
          c => c.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE roleid = 'app_access'::regrole`),
          fx.database,
        )
      ).rows as Array<{ n: number }>;
      expect(n).toBe(1); // only mwf_app: nothing was committed
    });

    it('work-k5fk.10.4: a role reached only through another role is refused (transitive), naming it', async () => {
      await admin(`GRANT mwf_ai TO ${empty}`);
      await admin(`GRANT ${empty} TO ${login}`);
      try {
        const m = await refusal();
        expect(m).toContain(`${login} reaches role(s) ai_access, mwf_ai, ${empty} (directly or through another role`);
      } finally {
        await admin(`REVOKE ${empty} FROM ${login}`);
        await admin(`REVOKE mwf_ai FROM ${empty}`);
      }
    });

    it('review 9a F1: the capability held WITH SET (PG16+ default of a plain GRANT) is refused', async () => {
      expect(await refusalInTx([`GRANT app_access TO ${login}`])).toContain(`${login} can SET ROLE to app_access`);
    });

    it('work-k5fk.10.4: the capability held WITH ADMIN OPTION is refused', async () => {
      expect(await refusalInTx([`GRANT app_access TO ${login} WITH ADMIN TRUE, SET FALSE`])).toContain(
        `${login} holds role(s) app_access WITH ADMIN OPTION`,
      );
    });

    it('the privilegedRoles arm: a login that can SET ROLE to the superuser is refused', async () => {
      await admin(`GRANT mwf_user TO ${login} WITH INHERIT FALSE, SET TRUE`);
      try {
        expect(await refusal()).toContain(`${login} can SET ROLE to superuser/BYPASSRLS role(s): mwf_user`);
      } finally {
        await admin(`REVOKE mwf_user FROM ${login}`);
      }
    });

    it('pg_database_owner: the owner of the database owns schema public and is refused', async () => {
      await admin(`ALTER DATABASE "${fx.database}" OWNER TO ${login}`, 'postgres');
      try {
        expect(await refusal()).toContain(
          `${login} owns objects in public/app: schema public (owner pg_database_owner)`,
        );
      } finally {
        await admin(`ALTER DATABASE "${fx.database}" OWNER TO mwf_migrator`, 'postgres');
      }
    });

    it('CREATEROLE, CREATEDB and CREATE on schema app are each refused', async () => {
      await admin(`ALTER ROLE ${login} CREATEDB CREATEROLE`);
      try {
        const m = await refusal();
        expect(m).toContain(`${login} has CREATEROLE`);
        expect(m).toContain(`${login} has CREATEDB`);
      } finally {
        await admin(`ALTER ROLE ${login} NOCREATEDB NOCREATEROLE`);
      }
      await admin(`GRANT CREATE ON SCHEMA app TO ${login}`);
      try {
        expect(await refusal()).toContain(`${login} may CREATE in schema(s) app`);
      } finally {
        await admin(`REVOKE CREATE ON SCHEMA app FROM ${login}`);
      }
    });

    it('the database owner is refused even when schema public belongs to mwf_migrator (init-db-owner.sh / row 9c)', async () => {
      await admin(`ALTER SCHEMA public OWNER TO mwf_migrator`);
      await admin(`ALTER DATABASE "${fx.database}" OWNER TO ${login}`, 'postgres');
      try {
        const m = await refusal();
        expect(m).toContain(`${login} owns the database (owner ${login})`);
        expect(m).toContain(`${login} may CREATE in the database`);
        expect(m).not.toContain('schema public');
      } finally {
        await admin(`ALTER DATABASE "${fx.database}" OWNER TO mwf_migrator`, 'postgres');
        await admin(`ALTER SCHEMA public OWNER TO pg_database_owner`);
      }
    });

    it('CREATE on the database alone is refused', async () => {
      await admin(`GRANT CREATE ON DATABASE "${fx.database}" TO ${login}`);
      try {
        const m = await refusal();
        expect(m).toContain(`${login} may CREATE in the database`);
        expect(m).not.toContain('owns the database');
      } finally {
        await admin(`REVOKE CREATE ON DATABASE "${fx.database}" FROM ${login}`);
      }
    });

    it('SET on session_replication_role (a SET ON PARAMETER grant) is refused', async () => {
      await admin(`GRANT SET ON PARAMETER session_replication_role TO ${login}`, 'postgres');
      try {
        expect(await refusal()).toContain(`${login} may SET session_replication_role (turns triggers off)`);
      } finally {
        await admin(`REVOKE SET ON PARAMETER session_replication_role FROM ${login}`, 'postgres');
      }
    });
  });
});
