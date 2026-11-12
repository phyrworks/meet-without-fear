/**
 * Startup guard for runtime database connections (work-k5fk.10.3; design note
 * §6 "Authentication per environment", Q15).
 *
 * Every runtime Prisma client (`createPrismaClient`: app, job, ops, auth)
 * refuses its connection — the first query fails, and `server.ts` exits before
 * it listens — when the login role
 *
 *   - is a SUPERUSER, or has BYPASSRLS (either one makes every grant and every
 *     future RLS policy moot);
 *   - can SET ROLE to a role that is either (a member of mwf_user would be a
 *     superuser one statement away);
 *   - owns, or can SET ROLE to the owner of, any object in schemas `public`
 *     and `app` — tables, views, sequences, indexes, functions, types — or the
 *     schemas themselves (the database owner owns `public` through
 *     pg_database_owner). An owner holds every privilege on its objects
 *     regardless of grants, can ALTER them and can turn RLS off.
 *
 * "Can SET ROLE to" is pg_has_role(…, 'MEMBER'): direct or indirect
 * membership, inherited or not — an injected `SET ROLE` needs no inheritance.
 *
 * ONE temporary allowance: the `job` client's login (mwf_job) still OWNS the
 * SECURITY DEFINER functions in schema `app` (trailer T4), so ownership of
 * exactly those, by the login itself, is tolerated for the `job` role only.
 * It goes when the definers move to the NOLOGIN `mwf_definer` (design note §7
 * row 9a, `roles-capabilities`); delete `JOB_OWNS_DEFINERS` then.
 *
 * Exempt, explicitly (nothing else is):
 *   - migrations and the Prisma CLI: they never construct a runtime client
 *     (prisma.config.ts reads DATABASE_URL directly);
 *   - fixture/tooling code on `pg` directly (state factory, golden harness);
 *   - a client created with `roleGuardExemption: '<reason>'` — only the E2E
 *     tooling client (lib/prisma getE2EToolingPrisma, E2E_AUTH_BYPASS only);
 *   - an operator script that calls `exemptProcessFromRoleGuard('<reason>')`
 *     before its first query (scripts/, src/scripts/ — never the API process;
 *     prisma-role-guard.test.ts pins who calls it).
 * The exemption is code, not configuration: no environment variable turns the
 * guard off.
 */
import { Client } from 'pg';
import type { DatabaseRole } from './database-urls';
import { pgSettingsFromUrl, type PgAdapterFactory } from './prisma-pg';

/** Remove with design note §7 row 9a: mwf_job stops owning the definer helpers. */
const JOB_OWNS_DEFINERS = true;

/** What the guard reads about the connected role (one row, one json column). */
export interface RoleFacts {
  role: string;
  superuser: boolean;
  bypassrls: boolean;
  /** Superuser / BYPASSRLS roles this login can SET ROLE to (itself excluded). */
  privilegedRoles: string[];
  /** Objects in public/app owned by this login or a role it can SET ROLE to. */
  owned: Array<{ object: string; owner: string; definerFunction: boolean; ownedBySelf: boolean }>;
}

export const ROLE_GUARD_SQL = `
WITH me AS (
  SELECT oid, rolname, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user
), obj AS (
  SELECT 'schema ' || n.nspname AS object, n.nspowner AS owner, false AS definer
  FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'app')
  UNION ALL
  SELECT 'relation ' || n.nspname || '.' || c.relname, c.relowner, false
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'app')
  UNION ALL
  SELECT 'function ' || n.nspname || '.' || p.proname, p.proowner, p.prosecdef AND n.nspname = 'app'
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'app')
  UNION ALL
  SELECT 'type ' || n.nspname || '.' || t.typname, t.typowner, false
  FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname IN ('public', 'app')
)
SELECT json_build_object(
  'role', me.rolname,
  'superuser', me.rolsuper,
  'bypassrls', me.rolbypassrls,
  'privilegedRoles', ARRAY(
    SELECT r.rolname::text FROM pg_catalog.pg_roles r
    WHERE r.oid <> me.oid AND (r.rolsuper OR r.rolbypassrls) AND pg_catalog.pg_has_role(me.oid, r.oid, 'MEMBER')
    ORDER BY 1),
  'owned', coalesce((
    SELECT json_agg(json_build_object('object', o.object, 'owner', pg_catalog.pg_get_userbyid(o.owner),
                                      'definerFunction', o.definer, 'ownedBySelf', o.owner = me.oid)
                    ORDER BY o.object)
    FROM obj o WHERE pg_catalog.pg_has_role(me.oid, o.owner, 'MEMBER')), '[]'::json)
)::text AS facts
FROM me`;

/** Pure: why `role`'s connection must be refused (empty = accepted). */
export function roleGuardViolations(facts: RoleFacts, role: DatabaseRole): string[] {
  const out: string[] = [];
  if (facts.superuser) out.push(`${facts.role} is a SUPERUSER`);
  if (facts.bypassrls) out.push(`${facts.role} has BYPASSRLS`);
  if (facts.privilegedRoles.length) {
    out.push(`${facts.role} can SET ROLE to superuser/BYPASSRLS role(s): ${facts.privilegedRoles.join(', ')}`);
  }
  const owned = facts.owned.filter(o => !(JOB_OWNS_DEFINERS && role === 'job' && o.definerFunction && o.ownedBySelf));
  if (owned.length) {
    const shown = owned.slice(0, 5).map(o => `${o.object} (owner ${o.owner})`);
    const more = owned.length > shown.length ? ` and ${owned.length - shown.length} more` : '';
    out.push(`${facts.role} owns objects in public/app: ${shown.join(', ')}${more}`);
  }
  return out;
}

export class RuntimeRoleRefusedError extends Error {
  constructor(
    readonly role: DatabaseRole,
    readonly violations: string[],
  ) {
    super(
      `Refusing the ${role} database connection (work-k5fk.10.3): ${violations.join('; ')}. ` +
        'Runtime clients log in as their least-privilege role (mwf_app, mwf_job, mwf_ops, mwf_auth) on a ' +
        'database whose objects mwf_migrator owns; set APP_/JOB_/OPS_/AUTH_DATABASE_URL accordingly.',
    );
    this.name = 'RuntimeRoleRefusedError';
  }
}

/** The application_name of the guard's own connection, so statement traces of the app ignore it. */
export const ROLE_GUARD_APPLICATION = 'mwf_role_guard';

/**
 * Read the facts of the role `databaseUrl` logs in as, on a short-lived
 * connection of its own (same login, application_name mwf_role_guard): the
 * check never spends a pooled connection and never appears in the app's
 * statement trace (golden harness, trace.ts filters by application_name).
 */
export async function readRoleFactsAt(databaseUrl: string): Promise<RoleFacts> {
  const { pool } = pgSettingsFromUrl(databaseUrl);
  const url = new URL(pool.connectionString as string);
  url.searchParams.set('application_name', ROLE_GUARD_APPLICATION);
  const client = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: pool.connectionTimeoutMillis,
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ facts: string }>(ROLE_GUARD_SQL);
    if (!rows[0]) throw new Error('role guard: the guard query returned no row');
    return JSON.parse(rows[0].facts) as RoleFacts;
  } finally {
    await client.end().catch(() => undefined);
  }
}

let processExemption: string | undefined;

/**
 * Operator scripts only (scripts/, src/scripts/): this process may connect
 * with any role — typically the admin DATABASE_URL. Call before the first
 * query. Never called by the API process.
 */
export function exemptProcessFromRoleGuard(reason: string): void {
  if (!reason.trim()) throw new Error('exemptProcessFromRoleGuard: a reason is required');
  processExemption = reason;
}

/** Test hook: drop a process exemption. */
export function resetRoleGuardExemptionForTests(): void {
  processExemption = undefined;
}

/**
 * Wrap an adapter factory so every `connect()` (Prisma connects once per
 * client, and again after a `$disconnect`) checks the role first and hands
 * out no adapter for a refused one. `readFacts` reads the role of the URL the
 * factory connects with; `exemption` (a reason) skips the check for this one
 * client.
 */
export function guardAdapterFactory(
  factory: PgAdapterFactory,
  role: DatabaseRole,
  opts: { readFacts: () => Promise<RoleFacts>; exemption?: string },
): PgAdapterFactory {
  const { exemption, readFacts } = opts;
  if (exemption !== undefined && !exemption.trim()) throw new Error('roleGuardExemption: a reason is required');
  return {
    provider: factory.provider,
    adapterName: factory.adapterName,
    connectToShadowDb: () => factory.connectToShadowDb(),
    connect: async () => {
      if (exemption === undefined && processExemption === undefined) {
        const violations = roleGuardViolations(await readFacts(), role);
        if (violations.length) throw new RuntimeRoleRefusedError(role, violations);
      }
      return factory.connect();
    },
  };
}
