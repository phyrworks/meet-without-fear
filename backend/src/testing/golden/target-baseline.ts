/**
 * Golden harness — the target-shape baseline as one SQL script (TS-9).
 *
 * The harness builds its target fixture templates (`mwf_tfx_*`) from this
 * (`tools/build-target-db.ts` for a scratch one). The dev databases
 * mwf_target_dev/test/shadow are TS-7c's `run-baseline.sh --dev`, not this.
 *
 * Source of truth, in order of preference:
 *   1. The baseline migration TS-7c produces
 *      (`prisma/migrations/<ts>_target_shape_baseline/migration.sql`): used
 *      verbatim when present — it is exactly what `prisma migrate deploy`
 *      applies.
 *   1b. Before TS-7c is merged into this branch: the same file read from its
 *      branch (`git show phoenix/ts-7c-baseline:…`; `TARGET_BASELINE_REF`
 *      overrides the ref), so templates carry the baseline's grants.
 *   2. Only when neither exists: the same four parts composed here, the way
 *      `backend/scripts/target-shape/check-schema.sh` builds `ts6_target`:
 *      (a) the TS-1 preamble (roles exist; schema `app`; app.current_user_id());
 *      (b) the Prisma DDL from `prisma migrate diff --from-empty`, with the
 *          consent.target_kind @default stripped (Postgres rejects a DEFAULT
 *          that references other columns; sql-only.sql re-adds it GENERATED);
 *      (c) the milestone seed (copied from scripts/target-shape/gen/maps.ts
 *          `MILESTONES`; the data-move generator is being removed by TS-7c);
 *      (d) trailer.sql with sql-only.sql spliced in at its include line, cut
 *          before T8 (its assertions run against migrated rows and use the
 *          data-move schema `app_migration`, which a fresh database has not).
 *
 * Owned by the harness, never a migration: TS-7c's baseline replaces path 2.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DbTarget, createDatabase, dropDatabase, withClient } from './db';

const BACKEND = path.resolve(__dirname, '../../..');
const MIGRATIONS = path.join(BACKEND, 'prisma/migrations');
const TARGET_SHAPE = path.join(BACKEND, 'scripts/target-shape');

/** spec §1.1 milestone seed — scripts/target-shape/gen/maps.ts `MILESTONES` (TS-7). */
export const MILESTONE_SEED: Array<[key: string, ordinal: number, label: string, scope: 'participant' | 'session', selfAssertable: boolean]> = [
  ['paused', 0, 'Paused', 'participant', false],
  ['invitation_sent', 10, 'Getting Started', 'participant', false],
  ['compact_signed', 20, 'Getting Started', 'session', true],
  ['feel_heard', 110, 'Your Story', 'participant', true],
  ['empathy_submitted', 210, 'Walking in Their Shoes', 'participant', false],
  ['empathy_ready', 220, 'Walking in Their Shoes', 'participant', false],
  ['empathy_validated', 230, 'Walking in Their Shoes', 'session', false],
  ['needs_confirmed', 310, 'What Matters Most', 'participant', true],
  ['needs_validated', 320, 'What Matters Most', 'session', false],
  ['needs_shared', 330, 'What Matters Most', 'session', false],
  ['repair_walkthrough_started', 410, 'What Comes Next', 'participant', false],
  ['choices_shared', 420, 'What Comes Next', 'session', true],
  ['closed', 430, 'What Comes Next', 'session', false],
];

const PREAMBLE = `
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r) INTO missing
  FROM unnest(ARRAY['mwf_app', 'mwf_job', 'mwf_ops', 'mwf_auth']) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'target baseline: database role(s) % do not exist (apply infra/aws/roles.sql)', missing;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'mwf_job', 'SET') THEN
    RAISE EXCEPTION 'target baseline: role % cannot SET ROLE mwf_job', current_user;
  END IF;
END
$$;

CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO mwf_app, mwf_job, mwf_ops, mwf_auth;

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
  AS $fn$ SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')::uuid $fn$;
REVOKE EXECUTE ON FUNCTION app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO mwf_app, mwf_job, mwf_ops, mwf_auth;
`;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function milestoneSeedSql(): string {
  const rows = MILESTONE_SEED.map(([k, o, l, s, a]) => `  (${lit(k)}, ${o}, ${lit(l)}, ${lit(s)}, ${a})`);
  return `INSERT INTO milestone (key, ordinal, stage_label, scope, self_assertable) VALUES\n${rows.join(',\n')};\n`;
}

const BASELINE_REF = process.env.TARGET_BASELINE_REF || 'phoenix/ts-7c-baseline';

/** The TS-7c baseline migration from its branch, before it is merged here. */
function baselineFromRef(): { source: string; sql: string } | null {
  try {
    // --full-tree: ls-tree filters by the working directory otherwise.
    const listing = execFileSync('git', ['ls-tree', '--full-tree', '--name-only', `${BASELINE_REF}:backend/prisma/migrations`], {
      cwd: BACKEND,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const dir = listing.split('\n').find(d => /_target_shape_baseline$/.test(d.trim()));
    if (!dir) return null;
    const file = `backend/prisma/migrations/${dir.trim()}/migration.sql`;
    const sql = execFileSync('git', ['show', `${BASELINE_REF}:${file}`], {
      cwd: BACKEND,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { source: `${BASELINE_REF}:${file}`, sql };
  } catch {
    return null;
  }
}

/**
 * The composed path's one known gap against the baseline (found by TS-7c,
 * 2026-10-26): TS-1 revoked PUBLIC's EXECUTE on the two membership helpers and
 * granted it to mwf_app; the trailer creates them afresh here, so restate
 * that, as their owner.
 */
const HELPER_GRANTS = `
SET ROLE mwf_job;
REVOKE EXECUTE ON FUNCTION app.is_member(uuid), app.partner_user_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_member(uuid), app.partner_user_id(uuid) TO mwf_app;
RESET ROLE;
`;

/** The committed TS-7c baseline migration, if this branch has it. */
export function baselineMigrationPath(): string | null {
  if (!fs.existsSync(MIGRATIONS)) return null;
  const dir = fs.readdirSync(MIGRATIONS).find(d => /_target_shape_baseline$/.test(d));
  return dir ? path.join(MIGRATIONS, dir, 'migration.sql') : null;
}

function prismaDdl(): string {
  const schema = fs.readFileSync(path.join(BACKEND, 'prisma/schema.prisma'), 'utf8');
  const stripped = schema.replace(
    /(\n\s*targetKind\s+ConsentTarget\s+)@default\(dbgenerated\("\\nCASE[\s\S]*?END"\)\)\s*/,
    '$1',
  );
  if (stripped === schema) throw new Error('target-baseline: could not strip the consent.target_kind @default');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwf-target-ddl-'));
  try {
    const p = path.join(tmp, 'schema.prisma');
    fs.writeFileSync(p, stripped);
    return execFileSync('npx', ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema', p, '--script'], {
      cwd: BACKEND,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function trailerWithoutT8(): string {
  const trailer = fs.readFileSync(path.join(TARGET_SHAPE, 'trailer.sql'), 'utf8');
  const sqlOnly = fs.readFileSync(path.join(TARGET_SHAPE, 'sql-only.sql'), 'utf8');
  const include = '-- @@include sql-only.sql';
  // The include is a line of its own; the header comment also quotes it.
  const tLines = trailer.split('\n');
  const at = tLines.findIndex(l => l.trim() === include);
  if (at < 0) throw new Error('target-baseline: trailer.sql lost its include line');
  const lines = [...tLines.slice(0, at), ...sqlOnly.split('\n'), ...tLines.slice(at + 1)];
  const t8 = lines.findIndex(l => /^-- T8\. /.test(l));
  if (t8 < 1) throw new Error('target-baseline: trailer.sql has no T8 section');
  // The dashed rule above the T8 heading starts the section.
  return lines.slice(0, t8 - 1).join('\n') + '\n';
}

let cached: { source: string; sql: string } | null = null;

/** The whole target baseline as one script, and where it came from. */
export function targetBaselineSql(): { source: string; sql: string } {
  if (cached) return cached;
  const migration = baselineMigrationPath();
  if (migration) {
    cached = { source: path.relative(BACKEND, migration), sql: fs.readFileSync(migration, 'utf8') };
    return cached;
  }
  const fromRef = baselineFromRef();
  if (fromRef) {
    cached = fromRef;
    return cached;
  }
  cached = {
    source:
      'composed: TS-1 preamble + prisma migrate diff --from-empty + milestone seed + trailer.sql (sql-only spliced, T8 cut) + helper grants',
    sql: [PREAMBLE, prismaDdl(), milestoneSeedSql(), trailerWithoutT8(), HELPER_GRANTS].join('\n'),
  };
  return cached;
}

/**
 * Names a target build may create or replace; everything else is refused.
 * The dev databases (mwf_target_dev/test/shadow) are NOT here: they are built
 * and recorded by TS-7c's `run-baseline.sh --dev` (with a _prisma_migrations
 * row), never by hand.
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
