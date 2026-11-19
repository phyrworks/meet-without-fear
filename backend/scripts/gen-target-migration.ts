/**
 * Generator for the `target_shape_baseline` migration (TS-7c, work-a39h.11.24).
 *
 *   npx tsx backend/scripts/gen-target-migration.ts            # writes the migration
 *   npx tsx backend/scripts/gen-target-migration.ts --stdout   # prints it
 *   npx tsx backend/scripts/gen-target-migration.ts --check    # two runs equal, and equal to the committed file
 *
 * Owner decision OD7 (2026-10-26): existing data is demo/test and is not
 * preserved. The cutover to the 49-table target shape of
 * docs/backend/data-model/schema-target-2026-10.md is ONE fresh baseline
 * migration that builds the target on an empty database; there is no data
 * move. (TS-7/TS-7b's data-move generator — prechecks, copies, fix-data — is
 * in git history, up to phoenix/target-shape 3cf611cb.)
 *
 * Output, in order (plan §3, baseline build order):
 *   0  scripts/target-shape/preamble.sql — refuse a non-empty database; the
 *      roles assertion and the SET ROLE mwf_definer check; schema app;
 *      app.current_user_id();
 *   1  scripts/target-shape/tables.sql — the domains (uuid7, ciphertext, ts_ms, intensity, ordinal_no, kek_id, email,
 *      milestone_key), the
 *      enums and the 49 tables, hand-written, each table complete in its
 *      CREATE TABLE (PK, UNIQUE, FK, CHECK, generated columns) in dependency
 *      order (owner decision 2026-11-02, work-a39h.11.40: it replaced the
 *      `prisma migrate diff --from-empty` DDL; check-schema.sh proves
 *      schema.prisma still matches it), and the milestone seed straight after
 *      the milestone table (work-k5fk.6);
 *   2  scripts/target-shape/trailer.sql, with scripts/target-shape/sql-only.sql
 *      spliced in verbatim at its `-- @@include sql-only.sql` line.
 *
 * Deterministic: it reads only repository files (no Prisma, no database),
 * so two runs are byte-identical.
 */

import * as fs from 'fs';
import * as path from 'path';
import { section } from './target-shape/gen/maps';

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
 * two cannot drift. 135 since work-k5fk.2: relationship.id, relationship_member's
 * two and session.relationship_id went (−4); user_contact's two,
 * live_session_pair's three and participant.added_by_user_id came (+6).
 * 189 since work-k5fk.3 (6a): every child of participant carries session_id and
 * the user id of each participant it names (+54), next to the participant ids
 * that 6b drops.
 * 156 since work-k5fk.3 (6b): participant.id and the 33 *_participant_id columns
 * went (-34), ai_memory.session_id came (+1).
 * 155 since work-k5fk.4: message.id and conversation_read_state.last_seen_message_id
 * went (-2), conversation_read_state.last_seen_conversation_id came (+1); message's
 * key is (conversation_id, seq) and seq is an integer.
 * 156 since work-k5fk.9 (C9): reconciler_result.author_user_id came (+1).
 */
export const UUID7_COLUMNS = 156;
const UUID7_PLACEHOLDER = '@@UUID7_COLUMNS@@';

/**
 * The encrypted columns of SENSITIVE_FIELD_MAP (lib/prisma-encryption-middleware.ts)
 * as tables.sql types them: CIPHERTEXT_COLUMNS text columns typed ciphertext,
 * CIPHERTEXT_ARRAYS text[] columns with CHECK (app.all_ciphertext(col)). Like
 * UUID7_COLUMNS, checkTables() counts them and the trailer's step-20 assertion
 * gets the numbers; encryption-at-rest-schema.target.test.ts ties the catalog
 * to the map itself, in both directions.
 * 43 since work-k5fk.9 (Q9): need_disposition.note went (-1).
 */
export const CIPHERTEXT_COLUMNS = 43;
export const CIPHERTEXT_ARRAYS = 5;
const CIPHERTEXT_PLACEHOLDER = '@@CIPHERTEXT_COLUMNS@@';
const CIPHERTEXT_ARRAYS_PLACEHOLDER = '@@CIPHERTEXT_ARRAYS@@';

/**
 * The jsonb-envelope columns of SENSITIVE_FIELD_MAP, each guarded by the
 * t_jsonb_envelope trigger (trailer.sql T5; work-k5fk.8 — a trigger, not a
 * CHECK, so a refusal never echoes the row). Step 20 ties the triggers to the
 * columns whose COMMENT says 'jsonb envelope' and requires this many;
 * encryption-at-rest-schema.target.test.ts ties them to the map.
 */
export const JSONB_ENVELOPES = 5;
const JSONB_ENVELOPES_PLACEHOLDER = '@@JSONB_ENVELOPES@@';

/**
 * tables.sql creates exactly the 49 target tables in schema public (plus the
 * app.json_schema reference table, which is not one of them), every name lower-case, and
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
  const tables = (sql.match(/^CREATE TABLE (?!app\.)/gm) ?? []).length;
  if (tables !== 49) throw new Error(`tables.sql creates ${tables} tables, expected 49`);
  const appTables = (sql.match(/^CREATE TABLE app\.[a-z_]+ /gm) ?? []).length;
  if (appTables !== 1) throw new Error(`tables.sql creates ${appTables} tables in schema app, expected 1 (app.json_schema)`);
  // A column line is `    name <type>…` inside a CREATE TABLE.
  const plainUuid = [...sql.matchAll(/^ {4}"?([a-z0-9_]+)"? uuid\b/gim)].map(m => m[1]);
  if (plainUuid.length) throw new Error(`tables.sql has uuid columns not typed uuid7: ${plainUuid.join(', ')}`);
  const uuid7 = (sql.match(/^ {4}"?[a-z0-9_]+"? uuid7\b/gm) ?? []).length;
  if (uuid7 !== UUID7_COLUMNS) throw new Error(`tables.sql has ${uuid7} uuid7 columns, expected ${UUID7_COLUMNS}`);
  const ct = (sql.match(/^ {4}[a-z0-9_]+ ciphertext\b/gm) ?? []).length;
  if (ct !== CIPHERTEXT_COLUMNS) throw new Error(`tables.sql has ${ct} ciphertext columns, expected ${CIPHERTEXT_COLUMNS}`);
  const ca = (sql.match(/^ {4}CHECK \(app\.all_ciphertext\([a-z0-9_]+\)\)/gm) ?? []).length;
  if (ca !== CIPHERTEXT_ARRAYS) throw new Error(`tables.sql has ${ca} all_ciphertext CHECKs, expected ${CIPHERTEXT_ARRAYS}`);
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
  for (const p of [CIPHERTEXT_PLACEHOLDER, CIPHERTEXT_ARRAYS_PLACEHOLDER, JSONB_ENVELOPES_PLACEHOLDER])
    if (!joined.includes(p)) throw new Error(`trailer.sql has no ${p} placeholder`);
  return joined
    .split(UUID7_PLACEHOLDER)
    .join(String(UUID7_COLUMNS))
    .split(CIPHERTEXT_PLACEHOLDER)
    .join(String(CIPHERTEXT_COLUMNS))
    .split(CIPHERTEXT_ARRAYS_PLACEHOLDER)
    .join(String(CIPHERTEXT_ARRAYS))
    .split(JSONB_ENVELOPES_PLACEHOLDER)
    .join(String(JSONB_ENVELOPES));
}

const HEADER = `-- ============================================================================
-- target_shape_baseline — the 49-table target shape, built on an EMPTY database
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
--    applied; the migrating role must be able to SET ROLE mwf_definer (it hands
--    the app.* helpers to mwf_definer).
--  * The app.* definers decide by capability (session_user's app_access,
--    ai_access, worker_access; the AI and worker arms only within
--    app.session_scope) or mwf_migrator; mwf_job is retired (work-k5fk.10.5).
--  * Does NOT enable RLS or create policies (TS-16).
--  * TS-16 (v_participant): under owner-only RLS a co-participant reads NULL
--    last_active_at / last_mood / read state and is_tombstone = false through
--    this security_invoker view, and coalesce(showActivityStatus, true) would
--    default to true over a user_preferences row it cannot see. The
--    partner-facing columns need a SECURITY DEFINER table function (owned by
--    mwf_definer, identity-bound) returning participant_id + the masked
--    last_active_at, with no default-true over an invisible row.
--
-- SECTIONS
--   0  preamble: empty-database guard, roles, schema app, app.current_user_id(), app.session_scope()
--      (backend/scripts/target-shape/preamble.sql)
--   1  domains (uuid7, ciphertext, ts_ms, intensity, email, milestone_key, schema_version),
--      the jsonb validators' reference table app.json_schema and its seed, enums and the 49
--      tables, hand-written, each table complete in its CREATE TABLE (and its grants) in
--      dependency order, the milestone seed after its table
--      (backend/scripts/target-shape/tables.sql)
--   2  trailer: sql-only.sql (sql_ indexes), app.* functions,
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
      `1. Domains, enums and the 49 target tables (backend/scripts/target-shape/tables.sql; ${n.names} named objects, all lower-case; ${n.uuid7} uuid7 columns)`,
      tables,
    ),
    section('2. Trailer (backend/scripts/target-shape/trailer.sql, sql-only.sql spliced in)', trailer()),
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
