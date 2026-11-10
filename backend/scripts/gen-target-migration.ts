/**
 * Generator for the `target_shape_baseline` migration (TS-7c, work-a39h.11.24).
 *
 *   npx tsx backend/scripts/gen-target-migration.ts            # writes the migration
 *   npx tsx backend/scripts/gen-target-migration.ts --stdout   # prints it
 *   npx tsx backend/scripts/gen-target-migration.ts --check    # two runs equal, and equal to the committed file
 *
 * Owner decision OD7 (2026-10-26): existing data is demo/test and is not
 * preserved. The cutover to the 47-table target shape of
 * docs/backend/data-model/schema-target-2026-10.md is ONE fresh baseline
 * migration that builds the target on an empty database; there is no data
 * move. (TS-7/TS-7b's data-move generator — prechecks, copies, fix-data — is
 * in git history, up to phoenix/target-shape 3cf611cb.)
 *
 * Output, in order (plan §3, baseline build order):
 *   0  scripts/target-shape/preamble.sql — refuse a non-empty database; the
 *      roles assertion and the SET ROLE mwf_job check; schema app;
 *      app.current_user_id();
 *   1  scripts/target-shape/tables.sql — the domains (uuid7, ts_ms, intensity, sha256_hex), the
 *      enums and the 47 tables, hand-written, each table complete in its
 *      CREATE TABLE (PK, UNIQUE, FK, CHECK, generated columns) in dependency
 *      order (owner decision 2026-11-02, work-a39h.11.40: it replaced the
 *      `prisma migrate diff --from-empty` DDL; check-schema.sh proves
 *      schema.prisma still matches it);
 *   2  the milestone seed (gen/maps.ts MILESTONES);
 *   3  scripts/target-shape/trailer.sql, with scripts/target-shape/sql-only.sql
 *      spliced in verbatim at its `-- @@include sql-only.sql` line.
 *
 * Deterministic: it reads only repository files (no Prisma, no database),
 * so two runs are byte-identical.
 */

import * as fs from 'fs';
import * as path from 'path';
import { milestoneSeed, section } from './target-shape/gen/maps';

export const MIGRATION_NAME = '20261026120000_target_shape_baseline';

const BACKEND = path.resolve(__dirname, '..');
const DIR = path.join(BACKEND, 'scripts', 'target-shape');
const PREAMBLE = path.join(DIR, 'preamble.sql');
const TABLES = path.join(DIR, 'tables.sql');
const TRAILER = path.join(DIR, 'trailer.sql');
const SQL_ONLY = path.join(DIR, 'sql-only.sql');
const OUT = path.join(BACKEND, 'prisma', 'migrations', MIGRATION_NAME, 'migration.sql');
const INCLUDE = '-- @@include sql-only.sql';

/**
 * The number of uuid7 columns tables.sql must declare. Defined once: checkTables()
 * throws unless the count equals it, and trailer() substitutes it for the
 * `@@UUID7_COLUMNS@@` placeholders in the trailer's step-20 assertion, so the
 * two cannot drift.
 */
export const UUID7_COLUMNS = 129;
const UUID7_PLACEHOLDER = '@@UUID7_COLUMNS@@';

/**
 * tables.sql creates exactly the 47 target tables, every name lower-case, and
 * types every uuid column uuid7. Returns the counts for the section title.
 */
export function checkTables(sql: string): { names: number; uuid7: number } {
  const names = new Set<string>();
  // Identifiers are unquoted except the reserved word "user" (tables.sql
  // conventions); indexes and most constraints are unnamed (`CREATE INDEX ON t`).
  for (const m of sql.matchAll(/CREATE (?:DOMAIN|TYPE|TABLE|UNIQUE INDEX|INDEX) (?!ON )"?([A-Za-z0-9_]+)"?/g)) names.add(m[1]);
  for (const m of sql.matchAll(/CONSTRAINT "?([A-Za-z0-9_]+)"?/g)) names.add(m[1]);
  const bad = [...names].filter(n => !/^[a-z_][a-z0-9_]*$/.test(n));
  if (bad.length) throw new Error(`tables.sql creates names that are not lower-case: ${bad.join(', ')}`);
  const tables = (sql.match(/^CREATE TABLE /gm) ?? []).length;
  if (tables !== 47) throw new Error(`tables.sql creates ${tables} tables, expected 47`);
  // A column line is `    name <type>…` inside a CREATE TABLE.
  const plainUuid = [...sql.matchAll(/^ {4}"?([a-z0-9_]+)"? uuid\b/gim)].map(m => m[1]);
  if (plainUuid.length) throw new Error(`tables.sql has uuid columns not typed uuid7: ${plainUuid.join(', ')}`);
  const uuid7 = (sql.match(/^ {4}"?[a-z0-9_]+"? uuid7\b/gm) ?? []).length;
  if (uuid7 !== UUID7_COLUMNS) throw new Error(`tables.sql has ${uuid7} uuid7 columns, expected ${UUID7_COLUMNS}`);
  return { names: names.size, uuid7 };
}

function trailer(): string {
  const t = fs.readFileSync(TRAILER, 'utf8');
  const lines = t.split('\n');
  const at = lines.indexOf(INCLUDE);
  if (at < 0 || lines.lastIndexOf(INCLUDE) !== at)
    throw new Error(`trailer.sql must contain exactly one "${INCLUDE}" line`);
  const sqlOnly = fs.readFileSync(SQL_ONLY, 'utf8').replace(/\n$/, '');
  const joined = [...lines.slice(0, at), sqlOnly, ...lines.slice(at + 1)].join('\n');
  if (!joined.includes(UUID7_PLACEHOLDER)) throw new Error(`trailer.sql has no ${UUID7_PLACEHOLDER} placeholder`);
  return joined.split(UUID7_PLACEHOLDER).join(String(UUID7_COLUMNS));
}

const HEADER = `-- ============================================================================
-- target_shape_baseline — the 47-table target shape, built on an EMPTY database
-- (TS-7c; owner decision OD7, 2026-10-26: existing data is demo/test and is
-- not preserved, so there is no data move)
--
-- GENERATED by backend/scripts/gen-target-migration.ts; do not edit by hand.
-- Regenerate: npx tsx backend/scripts/gen-target-migration.ts
-- Check:      npx tsx backend/scripts/gen-target-migration.ts --check
-- Spec: docs/backend/data-model/schema-target-2026-10.md
-- Plan: docs/backend/data-model/schema-migration-plan-2026-10.md §3 (baseline
--       build order), §6 (cutover)
--
-- OPERATOR NOTES
--  * This is the ONLY migration in prisma/migrations. A database that still
--    has the old shape — and the old _prisma_migrations rows — must FIRST be
--    emptied with backend/scripts/target-shape/drop-old-objects.sql (plan §6:
--    backup → stop the API → drop-old-objects.sql → prisma migrate deploy →
--    deploy the image → smoke). Section 0 refuses a database that still has
--    table "Session", schema app, or any relation in public.
--  * One file, one transaction: prisma migrate deploy sends the file as one
--    multi-statement simple query, and PostgreSQL runs such a query string in
--    a single implicit transaction (the file has no BEGIN/COMMIT of its own);
--    a RAISE anywhere rolls everything back. Prisma still records the attempt
--    as a failed _prisma_migrations row; clear it with
--    \`prisma migrate resolve --rolled-back ${MIGRATION_NAME}\`.
--    Nothing here forces a commit (no CONCURRENTLY, no ALTER TYPE … ADD VALUE,
--    no VACUUM, no COMMIT), so nothing breaks the implicit transaction.
--  * Run as the database owner (or mwf_migrator) with infra/aws/roles.sql
--    applied; the migrating role must be able to SET ROLE mwf_job (it hands
--    the app.* helpers to mwf_job).
--  * The app.* functions treat a caller as the job only when it logged in as
--    mwf_job or mwf_migrator (session_user); a superuser is not the job.
--  * Does NOT enable RLS or create policies (TS-16).
--  * TS-16 (v_participant): under owner-only RLS a co-participant reads NULL
--    last_active_at / last_mood / read state and is_tombstone = false through
--    this security_invoker view, and coalesce(showActivityStatus, true) would
--    default to true over a user_preferences row it cannot see. The
--    partner-facing columns need a SECURITY DEFINER table function (owned by
--    mwf_job, identity-bound) returning participant_id + the masked
--    last_active_at, with no default-true over an invisible row.
--
-- SECTIONS
--   0  preamble: empty-database guard, roles, schema app, app.current_user_id()
--      (backend/scripts/target-shape/preamble.sql)
--   1  domains (uuid7, ts_ms, intensity, sha256_hex), enums and the 47 tables, hand-written,
--      each table complete in its CREATE TABLE, in dependency order
--      (backend/scripts/target-shape/tables.sql)
--   2  milestone seed (reference data)
--   3  trailer: sql-only.sql (sql_ indexes), app.* functions,
--      triggers, views, grants, catalog assertions
--      (backend/scripts/target-shape/trailer.sql)
-- ============================================================================
`;

export function generate(): string {
  const tables = fs.readFileSync(TABLES, 'utf8');
  const n = checkTables(tables);
  const out = [
    HEADER,
    section('0. Preamble (backend/scripts/target-shape/preamble.sql)', fs.readFileSync(PREAMBLE, 'utf8')),
    section(
      `1. Domains, enums and the 47 target tables (backend/scripts/target-shape/tables.sql; ${n.names} named objects, all lower-case; ${n.uuid7} uuid7 columns)`,
      tables,
    ),
    section('2. Milestone seed (backend/scripts/target-shape/gen/maps.ts)', milestoneSeed()),
    section('3. Trailer (backend/scripts/target-shape/trailer.sql, sql-only.sql spliced in)', trailer()),
  ].join('\n');
  return out.replace(/[ \t]+$/gm, '');
}

function main(): void {
  const arg = process.argv[2];
  if (arg === undefined) {
    const sql = generate();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, sql);
    process.stderr.write(`wrote ${path.relative(process.cwd(), OUT)} (${Buffer.byteLength(sql)} bytes)\n`);
  } else if (arg === '--stdout') {
    process.stdout.write(generate());
  } else if (arg === '--check') {
    const a = generate();
    const b = generate();
    if (a !== b) throw new Error('generator is not deterministic: two runs differ');
    const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (committed !== a) throw new Error(`${OUT} differs from the generator output: regenerate it`);
    const others = fs
      .readdirSync(path.dirname(path.dirname(OUT)), { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== MIGRATION_NAME)
      .map(d => d.name);
    if (others.length) throw new Error(`prisma/migrations holds more than the baseline: ${others.join(', ')}`);
    process.stdout.write(
      `ok: two runs byte-identical and equal to ${MIGRATION_NAME}/migration.sql (${Buffer.byteLength(a)} bytes)\n`,
    );
  } else {
    throw new Error(`unknown argument ${arg} (use --stdout or --check)`);
  }
}

if (require.main === module) main();
