/**
 * Deploy preflight (work-k5fk.10.3, review round 1 H4): run the runtime role
 * guard (lib/prisma-role-guard.ts) against every runtime role URL BEFORE
 * `prisma migrate deploy`, and exit 1 — loudly — if any login would be
 * refused. Without it a deploy migrates first and the API then crash-loops on
 * its startup check.
 *
 *   node dist/backend/src/scripts/role-guard-preflight.js   (in the API image)
 *   npx tsx src/scripts/role-guard-preflight.ts              (from backend/)
 *
 * Checks the URL each runtime client would use (database-urls.ts): app and job
 * (each falling back to DATABASE_URL, so a privileged DATABASE_URL fallback is
 * refused too), and ops and auth when their own variable is set. There is no switch to skip it.
 */
import { DATABASE_URL_VARS, databaseUrlFor, type DatabaseRole } from '../lib/database-urls';
import { readRoleFactsAt, roleGuardViolations } from '../lib/prisma-role-guard';

const ALWAYS: DatabaseRole[] = ['app', 'job'];
const WHEN_SET: DatabaseRole[] = ['ops', 'auth'];

export async function preflight(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const failures: string[] = [];
  for (const role of [...ALWAYS, ...WHEN_SET]) {
    // ops and auth: only their own variable (ops never falls back; no runtime auth client exists yet).
    if (WHEN_SET.includes(role) && !env[DATABASE_URL_VARS[role]]) continue;
    const url = databaseUrlFor(role, env);
    if (!url) {
      if (ALWAYS.includes(role)) failures.push(`${role}: neither ${DATABASE_URL_VARS[role]} nor DATABASE_URL is set`);
      continue;
    }
    try {
      const facts = await readRoleFactsAt(url);
      const violations = roleGuardViolations(facts, role);
      if (violations.length) failures.push(`${role} (${facts.role}): ${violations.join('; ')}`);
      else console.log(`role-guard preflight: ${role} ok (${facts.role})`);
    } catch (e) {
      failures.push(`${role}: could not check the login: ${(e as Error).message}`);
    }
  }
  return failures;
}

if (require.main === module) {
  preflight().then(
    failures => {
      if (failures.length === 0) return;
      console.error('ROLE GUARD PREFLIGHT FAILED — not migrating, not starting the API:');
      for (const f of failures) console.error(`  - ${f}`);
      if (failures.some(f => /owns objects|member of role/.test(f))) {
        console.error(
          '  A runtime login owns the schema or is a member of another role. This release needs the\n' +
            '  ownership move of design note §7 row 9c (work-k5fk): the database and every object owned by\n' +
            '  mwf_migrator, no runtime login a member of any role (REVOKE mwf_job FROM mwf_app), and\n' +
            '  migrations run as mwf_migrator. Do that cutover first; nothing here switches the check off.',
        );
      }
      process.exit(1);
    },
    e => {
      console.error('ROLE GUARD PREFLIGHT FAILED:', e);
      process.exit(1);
    },
  );
}
