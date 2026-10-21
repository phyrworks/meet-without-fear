/**
 * Generator for the one-shot `target_shape` migration (TS-7, work-a39h.11.8).
 *
 *   cd backend
 *   npx tsx scripts/gen-target-migration.ts > prisma/migrations/<ts>_target_shape/migration.sql
 *   npx tsx scripts/gen-target-migration.ts --fix-data-template > scripts/target-shape/fix-data.template.sql
 *
 * Moves the database from the 68-table Prisma shape to the 47-table target
 * shape of docs/backend/data-model/schema-target-2026-10.md, following the
 * build order of docs/backend/data-model/schema-migration-plan-2026-10.md §3.
 * Deterministic: it reads only repository files (schema.prisma, the trailer,
 * sql-only.sql, the mapping tables in scripts/target-shape/gen/) and runs
 * `prisma migrate diff --from-empty` (no database), so two runs are
 * byte-identical; run-target-migration.sh --check compares a fresh run with
 * the committed migration.sql.
 *
 * Output sections (plan §3):
 *   (0) guard — refuse unless the database is at the expected current shape;
 *   (1) enums and the 47 new tables — Prisma's DDL from a copy of
 *       schema.prisma without the consent.target_kind @default (sql-only.sql's
 *       trap). New snake_case names cannot collide with old "PascalCase" ones:
 *       every new name starts lower-case (checked here);
 *   (2) the migration workspace (schema app_migration) and the prechecks
 *       (step 0b) — all failures RAISE together, with ids;
 *   (3) the copies, steps 1–18 in FK order, each with its assertions;
 *   (4) step 19 — drop the 68 old tables and 51 old enum types;
 *   (5) scripts/target-shape/trailer.sql, with scripts/target-shape/sql-only.sql
 *       spliced in verbatim at its `-- @@include sql-only.sql` line.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OLD_ENUMS, OLD_TABLES, section } from './target-shape/gen/maps';
import { guard, workspace } from './target-shape/gen/workspace';
import { prechecks } from './target-shape/gen/prechecks';
import { stepConversations, stepMilestones, stepNeeds, stepParticipants, stepUsers } from './target-shape/gen/copies-core';
import { stepDraftsConsent, stepEmpathy, stepMessages } from './target-shape/gen/copies-empathy';
import { stepFollowUp, stepProposals } from './target-shape/gen/copies-repair';
import { stepDrop, stepReflection, stepRenames, stepTelemetryAndAudit } from './target-shape/gen/copies-user';
import { fixDataTemplate } from './target-shape/gen/fix-template';

const BACKEND = path.resolve(__dirname, '..');
const SCHEMA = path.join(BACKEND, 'prisma', 'schema.prisma');
const TRAILER = path.join(BACKEND, 'scripts', 'target-shape', 'trailer.sql');
const SQL_ONLY = path.join(BACKEND, 'scripts', 'target-shape', 'sql-only.sql');
const INCLUDE = '-- @@include sql-only.sql';

/** Prisma's DDL for the target, from a copy of schema.prisma without the target_kind @default. */
function prismaDdl(): string {
  const schema = fs.readFileSync(SCHEMA, 'utf8');
  const stripped = schema.replace(/(\n\s*targetKind\s+ConsentTarget\s+)@default\(dbgenerated\("\\nCASE[\s\S]*?END"\)\)\s*/, '$1');
  if (stripped === schema) throw new Error('could not strip the consent.target_kind @default (sql-only.sql trap)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts7-gen-'));
  try {
    const copy = path.join(tmp, 'schema.prisma');
    fs.writeFileSync(copy, stripped);
    return execFileSync('npx', ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema', copy, '--script'], {
      cwd: BACKEND,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every name the DDL creates starts lower-case, so none can equal an old quoted PascalCase name. */
function checkNoCollision(ddl: string): number {
  const names = new Set<string>();
  for (const m of ddl.matchAll(/CREATE (?:TYPE|TABLE|UNIQUE INDEX|INDEX) "([^"]+)"/g)) names.add(m[1]);
  for (const m of ddl.matchAll(/CONSTRAINT "([^"]+)"/g)) names.add(m[1]);
  const bad = [...names].filter((n) => !/^[a-z_]/.test(n));
  if (bad.length) throw new Error(`target DDL creates names that could collide with old objects: ${bad.join(', ')}`);
  const old = new Set([...OLD_TABLES, ...OLD_ENUMS]);
  const clash = [...names].filter((n) => old.has(n));
  if (clash.length) throw new Error(`target DDL reuses old names: ${clash.join(', ')}`);
  const tables = (ddl.match(/^CREATE TABLE /gm) ?? []).length;
  if (tables !== 47) throw new Error(`target DDL creates ${tables} tables, expected 47`);
  return names.size;
}

function trailer(): string {
  const t = fs.readFileSync(TRAILER, 'utf8');
  const lines = t.split('\n');
  const at = lines.indexOf(INCLUDE);
  if (at < 0 || lines.lastIndexOf(INCLUDE) !== at) throw new Error(`trailer.sql must contain exactly one "${INCLUDE}" line`);
  const sqlOnly = fs.readFileSync(SQL_ONLY, 'utf8').replace(/\n$/, '');
  return [...lines.slice(0, at), sqlOnly, ...lines.slice(at + 1)].join('\n');
}

const HEADER = `-- ============================================================================
-- target_shape — the one-shot re-shape to the 47-table target (TS-7)
--
-- GENERATED by backend/scripts/gen-target-migration.ts; do not edit by hand.
-- Regenerate: cd backend && npx tsx scripts/gen-target-migration.ts > <this file>
-- Spec: docs/backend/data-model/schema-target-2026-10.md
-- Plan: docs/backend/data-model/schema-migration-plan-2026-10.md §3 (build
--       order), §6 (rollout)
--
-- OPERATOR NOTES
--  * One file, one transaction: prisma migrate deploy wraps this file in a
--    single transaction on PostgreSQL. A RAISE anywhere — a precheck, an
--    assertion, a constraint — rolls back every statement, and the database is
--    left at the old shape. Nothing here forces a commit: no CREATE INDEX
--    CONCURRENTLY, no ALTER TYPE … ADD VALUE, no VACUUM, no COMMIT. Prisma
--    still records the attempt as a failed row in _prisma_migrations; clear it
--    with \`prisma migrate resolve --rolled-back <this migration>\` before a
--    retry.
--  * Prechecks (section 2) report EVERY offending row at once, by check name.
--    Each name has a block in backend/scripts/target-shape/fix-data.template.sql
--    (the query that lists offenders and the corrective statement an operator
--    fills in). Rehearse on a restored copy (plan §6.3): run, read the RAISE,
--    fix with the template, re-run until it applies.
--  * Run as the database owner with infra/aws/roles.sql applied; the owner must
--    be able to SET ROLE mwf_job (it hands the app.* helpers to mwf_job).
--  * Leaves schema app_migration (shape_map, row_counts, report) for the
--    after-phase verify script (TS-8), which drops it (ruling R14). Read the
--    report: SELECT step, item, n, detail FROM app_migration.report ORDER BY seq;
--  * User-written text the target has no column for (gatesSatisfied.skipReason
--    and the feel-heard feedback, Stage4NeedCoverage.note, superseded unsent
--    review feedback, a differing cycle resultSummary, dropped PROPOSED
--    agreement descriptions, a vanished leaver's ownerless messages) is kept
--    in app_migration.dropped_content for the owner to decide at TS-14.
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
--   0  guard
--   1  enums and tables (Prisma DDL)
--   2  workspace (app_migration) and prechecks (plan step 0b)
--   3  copies with assertions, plan steps 1–18, in FK order:
--      1 user · 2 relationship · 3 session · 4/4a participant · 5 A/B slots ·
--      6 conversation + ai_memory · milestone seed · 7 participant_milestone ·
--      need · 12a need_share · 8 need_disposition · 13a proposal · 6b sub-chats ·
--      11 empathy · 9 message (+ delivered copies) · read state · 10 draft ·
--      12 consent · 13 proposal children, agreement, closure · 14 follow-up ·
--      renames (invitation, mood, regulation, memory) · 15 reflection ·
--      16 feature_state · 17 text-id audit · 18 brain_activity
--   4  step 19: drop the old tables and enum types
--   5  trailer: domain, sql-only.sql, CHECKs, functions, triggers, views,
--      grants, catalog and invariant assertions (backend/scripts/target-shape/trailer.sql)
-- ============================================================================
`;

function main(): void {
  if (process.argv[2] === '--fix-data-template') {
    process.stdout.write(fixDataTemplate().replace(/[ \t]+$/gm, ''));
    return;
  }
  if (process.argv[2] !== undefined) throw new Error(`unknown argument ${process.argv[2]} (only --fix-data-template)`);
  const ddl = prismaDdl();
  const nNames = checkNoCollision(ddl);
  const out = [
    HEADER,
    section('0. Guard', guard()),
    section(`1. Enums and the 47 target tables — prisma migrate diff --from-empty (${nNames} named objects, all lower-case)`, ddl),
    section('2a. Migration workspace (schema app_migration) and step 0 row counts', workspace()),
    section('2b. Prechecks (plan step 0b)', prechecks()),
    section('3a. Steps 1–3: user, relationship, session', stepUsers()),
    section('3b. Steps 4, 4a, 5: participant, vanished members, A/B slots', stepParticipants()),
    section('3c. Step 6: conversation, ai_memory', stepConversations()),
    section('3d. Milestone seed and step 7: participant_milestone', stepMilestones()),
    section('3e. need, need_share (12), need_disposition (8), proposal (13), sub-chats (6)', stepNeeds()),
    section('3f. Step 11: empathy attempts, reconciler, reviews', stepEmpathy()),
    section('3g. Step 9: messages, delivered copies, read state', stepMessages()),
    section('3h. Steps 10, 12: drafts, consent', stepDraftsConsent()),
    section('3i. Step 13: proposal children, agreements, closure', stepProposals()),
    section('3j. Step 14: follow-up', stepFollowUp()),
    section('3k. Renames: invitation, mood_reading, regulation_event, user_memory', stepRenames()),
    section('3l. Steps 15–16: reflection, feature_state', stepReflection()),
    section('3m. Steps 17–18: text-id audit, brain_activity, after-counts', stepTelemetryAndAudit()),
    section('4. Step 19: drop the old shape', stepDrop()),
    section('5. Trailer (backend/scripts/target-shape/trailer.sql, sql-only.sql spliced in)', trailer()),
  ].join('\n');
  process.stdout.write(out.replace(/[ \t]+$/gm, ''));
}

main();
