/**
 * Golden harness — the target-shape baseline (TS-9).
 *
 * The harness builds its target fixture templates (`mwf_tfx_*`) from the
 * single baseline migration TS-7c produced
 * (`prisma/migrations/<ts>_target_shape_baseline/migration.sql`), applied
 * verbatim — exactly what `prisma migrate deploy` applies (no
 * `_prisma_migrations` row: a template is never deployed to again). There is
 * no fallback: a branch without the baseline fails loudly (fix round 1: the
 * composed and git-ref fallbacks were dead code that could silently build a
 * different schema). The dev databases mwf_target_dev/test/shadow are TS-7c's
 * `run-baseline.sh --dev`, not this.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DbTarget, createDatabase, dropDatabase, withClient } from './db';

const BACKEND = path.resolve(__dirname, '../../..');
const MIGRATIONS = path.join(BACKEND, 'prisma/migrations');

/** The committed baseline migration. Throws when the branch has none. */
export function baselineMigrationPath(): string {
  const dirs = fs.existsSync(MIGRATIONS)
    ? fs.readdirSync(MIGRATIONS).filter(d => /_target_shape_baseline$/.test(d))
    : [];
  if (dirs.length !== 1) {
    throw new Error(
      `target-baseline: expected exactly one *_target_shape_baseline migration in ${MIGRATIONS}, found ${dirs.length} ` +
        `(${dirs.join(', ') || 'none'}). The target harness builds only from TS-7c's baseline.`,
    );
  }
  return path.join(MIGRATIONS, dirs[0], 'migration.sql');
}

/** The whole target baseline as one script, and where it came from. */
export function targetBaselineSql(): { source: string; sql: string } {
  const p = baselineMigrationPath();
  return { source: path.relative(BACKEND, p), sql: fs.readFileSync(p, 'utf8') };
}

/**
 * Names a target build may create or replace; everything else is refused.
 * The dev databases (mwf_target_dev/test/shadow) are NOT here: they are built
 * and recorded by TS-7c's `run-baseline.sh --dev`, never by hand.
 */
const BUILDABLE = /^(mwf_tfx_[a-z0-9_]+|mwf_trun_[a-z0-9_]+)$/;

/**
 * (Re)create `database` and apply the target baseline in one transaction.
 * Refuses any name outside the target prefixes (never meet_without_fear*,
 * mwf_fx_*, mwf_run_*, ts6_*, ts7_*).
 */
export async function buildTargetDatabase(t: DbTarget, database: string): Promise<{ source: string }> {
  if (!BUILDABLE.test(database)) {
    throw new Error(
      `buildTargetDatabase: refusing "${database}" (allowed: mwf_tfx_*, mwf_trun_*; dev databases come from run-baseline.sh --dev)`,
    );
  }
  const { source, sql } = targetBaselineSql();
  await dropDatabase(t, database);
  await createDatabase(t, database);
  try {
    await withClient(
      t,
      async c => {
        await c.query('BEGIN');
        try {
          await c.query(sql);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
      },
      database,
    );
  } catch (e) {
    await dropDatabase(t, database);
    throw new Error(`Applying the target baseline to ${database} failed: ${(e as Error).message}`);
  }
  return { source };
}
