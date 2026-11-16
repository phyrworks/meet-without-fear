/**
 * work-k5fk.10.4 (design note §6 "Roles — one per kind of actor", §7 row 9a), against a real
 * target run database (a clone of FEEL_HEARD_B, owned by mwf_migrator): grants target NOLOGIN
 * capability roles, every runtime login is a member of exactly one of them, and the SECURITY
 * DEFINER functions belong to the NOLOGIN mwf_definer.
 *
 *   - six capabilities from §6 (app_access, ai_access, worker_access, ops_access, auth_access,
 *     clinician_access) plus job_access, the interim home of mwf_job's grants until §7 row 9b
 *     retires mwf_job: NOLOGIN, no attribute, a member of nothing, owner of nothing;
 *   - each runtime login is LOGIN, no attribute, owns nothing, holds no privilege of its own
 *     (every grant is its capability's), and reaches exactly one role — its capability —
 *     through pg_auth_members, transitively;
 *   - mwf_clinician, ai_access and worker_access hold nothing yet (9a creates them; 9b gives
 *     ai/worker their grants with the call sites; clinicians wait on the consent model, Q18);
 *   - mwf_definer is NOLOGIN, owns every SECURITY DEFINER function in public/app, and no
 *     runtime login can SET ROLE to it.
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

/** login → its one capability (design note §6; mwf_job → job_access until §7 row 9b). */
export const LOGIN_CAPABILITY = {
  mwf_app: 'app_access',
  mwf_ai: 'ai_access',
  mwf_worker: 'worker_access',
  mwf_ops: 'ops_access',
  mwf_auth: 'auth_access',
  mwf_clinician: 'clinician_access',
  mwf_job: 'job_access',
} as const;

const LOGINS = Object.keys(LOGIN_CAPABILITY);
const CAPABILITIES = Object.values(LOGIN_CAPABILITY) as string[];
/** Capabilities that hold no privilege in 9a. */
const EMPTY = ['ai_access', 'worker_access', 'clinician_access'];

describeTarget('capability roles and mwf_definer (target)', () => {
  let run: TargetRun;

  beforeAll(async () => {
    run = await openTargetRun('FEEL_HEARD_B', `caps_${process.pid}`);
  });
  afterAll(async () => {
    await run?.drop();
  });

  /** Every ACL entry in the run database (database, schemas public/app, their relations, columns, routines, types) granted to one of $1. */
  const ACL_OF = `
    WITH g AS (SELECT oid, rolname FROM pg_roles WHERE rolname = ANY($1::text[]))
    SELECT g.rolname::text AS grantee, x.object
    FROM g JOIN (
      SELECT a.grantee, 'database' AS object FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = current_database()
      UNION ALL
      SELECT a.grantee, 'schema ' || n.nspname FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname IN ('public', 'app')
      UNION ALL
      SELECT a.grantee, 'relation ' || c.oid::regclass::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
      WHERE n.nspname IN ('public', 'app')
      UNION ALL
      SELECT a.grantee, 'column ' || c.oid::regclass::text || '.' || att.attname
      FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(att.attacl) a
      WHERE n.nspname IN ('public', 'app')
      UNION ALL
      SELECT a.grantee, 'routine ' || p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a
      WHERE n.nspname IN ('public', 'app')
      UNION ALL
      SELECT a.grantee, 'type ' || t.oid::regtype::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace, aclexplode(t.typacl) a
      WHERE n.nspname IN ('public', 'app')
    ) x ON x.grantee = g.oid
    ORDER BY 1, 2`;

  /** Objects in public/app (and the schemas, and the database) owned by one of $1. */
  const OWNED_BY = `
    WITH g AS (SELECT oid, rolname FROM pg_roles WHERE rolname = ANY($1::text[]))
    SELECT g.rolname::text AS owner, x.object
    FROM g JOIN (
      SELECT d.datdba AS owner, 'database' AS object FROM pg_database d WHERE d.datname = current_database()
      UNION ALL SELECT n.nspowner, 'schema ' || n.nspname FROM pg_namespace n WHERE n.nspname IN ('public', 'app')
      UNION ALL SELECT c.relowner, 'relation ' || c.oid::regclass::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname IN ('public', 'app')
      UNION ALL SELECT p.proowner, 'routine ' || p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname IN ('public', 'app')
      UNION ALL SELECT t.typowner, 'type ' || t.oid::regtype::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname IN ('public', 'app')
    ) x ON x.owner = g.oid
    ORDER BY 1, 2`;

  it('every capability role and mwf_definer exists: NOLOGIN, NOSUPERUSER, NOBYPASSRLS, no CREATEROLE/CREATEDB/REPLICATION', async () => {
    const rows = await run.sql<{ rolname: string; attrs: string }>(
      `SELECT r.rolname::text,
              concat_ws(',', CASE WHEN r.rolcanlogin THEN 'LOGIN' END, CASE WHEN r.rolsuper THEN 'SUPERUSER' END,
                        CASE WHEN r.rolbypassrls THEN 'BYPASSRLS' END, CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
                        CASE WHEN r.rolcreatedb THEN 'CREATEDB' END, CASE WHEN r.rolreplication THEN 'REPLICATION' END) AS attrs
       FROM pg_roles r WHERE r.rolname = ANY($1::text[]) ORDER BY 1`,
      [[...CAPABILITIES, 'mwf_definer']],
    );
    expect(rows).toEqual([...CAPABILITIES, 'mwf_definer'].sort().map(rolname => ({ rolname, attrs: '' })));
  });

  it('every runtime login exists: LOGIN and nothing else', async () => {
    const rows = await run.sql<{ rolname: string; attrs: string }>(
      `SELECT r.rolname::text,
              concat_ws(',', CASE WHEN r.rolcanlogin THEN 'LOGIN' END, CASE WHEN r.rolsuper THEN 'SUPERUSER' END,
                        CASE WHEN r.rolbypassrls THEN 'BYPASSRLS' END, CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
                        CASE WHEN r.rolcreatedb THEN 'CREATEDB' END, CASE WHEN r.rolreplication THEN 'REPLICATION' END) AS attrs
       FROM pg_roles r WHERE r.rolname = ANY($1::text[]) ORDER BY 1`,
      [LOGINS],
    );
    expect(rows).toEqual([...LOGINS].sort().map(rolname => ({ rolname, attrs: 'LOGIN' })));
  });

  it('each runtime login reaches exactly one role, transitively — its capability — with INHERIT and without ADMIN', async () => {
    const rows = await run.sql<{ login: string; reaches: string[]; direct: string[] }>(
      `SELECT l.rolname::text AS login,
              ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid <> l.oid AND pg_has_role(l.oid, r.oid, 'MEMBER') ORDER BY 1) AS reaches,
              ARRAY(SELECT r.rolname || CASE WHEN m.inherit_option THEN ' inherit' ELSE '' END
                                     || CASE WHEN m.admin_option THEN ' admin' ELSE '' END
                    FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = l.oid ORDER BY 1) AS direct
       FROM pg_roles l WHERE l.rolname = ANY($1::text[]) ORDER BY 1`,
      [LOGINS],
    );
    expect(rows).toEqual(
      [...LOGINS].sort().map(login => {
        const cap = LOGIN_CAPABILITY[login as keyof typeof LOGIN_CAPABILITY];
        return { login, reaches: [cap], direct: [`${cap} inherit`] };
      }),
    );
  });

  it('a capability role is a member of no role, and no capability is a member of another', async () => {
    const rows = await run.sql<{ member: string; role: string }>(
      `SELECT mr.rolname::text AS member, r.rolname::text AS role
       FROM pg_auth_members m JOIN pg_roles mr ON mr.oid = m.member JOIN pg_roles r ON r.oid = m.roleid
       WHERE mr.rolname = ANY($1::text[]) ORDER BY 1, 2`,
      [[...CAPABILITIES, 'mwf_definer']],
    );
    expect(rows).toEqual([]);
  });

  it('no runtime login, capability or mwf_definer owns the database, a schema, or any object outside the definer functions', async () => {
    const logins = await run.sql(OWNED_BY, [[...LOGINS, ...CAPABILITIES]]);
    expect(logins).toEqual([]);
    const definer = await run.sql<{ object: string }>(OWNED_BY, [['mwf_definer']]);
    const nonDefiner = await run.sql<{ object: string }>(
      `SELECT 'routine ' || p.oid::regprocedure::text AS object FROM pg_proc p
       WHERE p.proowner = 'mwf_definer'::regrole AND NOT p.prosecdef`,
    );
    expect(nonDefiner).toEqual([]);
    expect(definer.every(d => d.object.startsWith('routine app.'))).toBe(true);
  });

  it('every SECURITY DEFINER function in public/app is owned by mwf_definer', async () => {
    const rows = await run.sql<{ fn: string; owner: string }>(
      `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner)::text AS owner
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'app') AND p.prosecdef ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(17);
    expect(rows.filter(r => r.owner !== 'mwf_definer')).toEqual([]);
  });

  it('no runtime login can SET ROLE to mwf_definer or to another login', async () => {
    const rows = await run.sql<{ login: string; reaches: string }>(
      `SELECT l.rolname::text AS login, r.rolname::text AS reaches
       FROM pg_roles l, pg_roles r
       WHERE l.rolname = ANY($1::text[]) AND r.oid <> l.oid AND pg_has_role(l.oid, r.oid, 'MEMBER')
         AND (r.rolname = 'mwf_definer' OR r.rolcanlogin) ORDER BY 1, 2`,
      [LOGINS],
    );
    expect(rows).toEqual([]);
  });

  it('a runtime login holds no privilege of its own: every grant is its capability role’s', async () => {
    expect(await run.sql(ACL_OF, [LOGINS])).toEqual([]);
  });

  it('ai_access, worker_access and clinician_access hold nothing yet (9b, Q18)', async () => {
    expect(await run.sql(ACL_OF, [EMPTY])).toEqual([]);
  });

  it('app_access, job_access, ops_access and auth_access hold their logins’ grants', async () => {
    const rows = await run.sql<{ grantee: string }>(ACL_OF, [['app_access', 'job_access', 'ops_access', 'auth_access']]);
    const by = (g: string) => rows.filter(r => r.grantee === g).length;
    expect(by('app_access')).toBeGreaterThan(0);
    expect(by('job_access')).toBeGreaterThan(0);
    expect(by('ops_access')).toBeGreaterThan(0);
    expect(by('auth_access')).toBeGreaterThan(0);
  });

  it('the logins work through their capability: mwf_app reads milestone, mwf_auth calls resolve_user, mwf_clinician reads nothing', async () => {
    expect((await run.as('mwf_app', null, `SELECT count(*)::int AS n FROM milestone`))[0]).toEqual({ n: 13 });
    expect(
      (await run.as('mwf_auth', null, `SELECT app.resolve_user('clerk', 'nobody') AS u`))[0],
    ).toEqual({ u: null });
    const [r] = await run.sql<{ any: boolean }>(
      `SELECT bool_or(has_table_privilege('mwf_clinician', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                      OR has_any_column_privilege('mwf_clinician', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')) AS any
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'v', 'm', 'p', 'S')`,
    );
    expect(r.any).toBe(false);
  });
});
