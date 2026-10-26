#!/usr/bin/env bash
# ============================================================================
# check-schema.sh — the drift gate for the target shape (TS-6, Ruling R10).
#
# BUILD MODE (default): proves schema.prisma + sql-only.sql are self-consistent.
#   1. creates the scratch database ts6_target on the dev container;
#   2. applies the Prisma DDL (`prisma migrate diff --from-empty --to-schema`)
#      and sql-only.sql §1 (the generated columns);
#   3. (a) `prisma validate`
#      (c) `prisma db pull --print`, normalised (normalize-schema.cjs) and
#          diffed against schema.prisma — must be identical;
#   4. applies sql-only.sql §2 (the sql_ indexes), then
#      (b) `prisma migrate diff --from-config-datasource --to-schema --script`
#          — must print an empty script;
#      (c') `prisma db pull --print` again — every line that differs from the
#          step-3 pull must be an sql_ index or an effect Prisma derives from
#          one (check-pull-delta.cjs), and the sql_ names must be complete:
#          spec §5 list ⊆ sql-only.sql ⊆ pull (+ the expression index, which
#          pull never renders) and pull ⊆ sql-only.sql;
#   5. drops the scratch database (also on failure).
#
# EXISTING-DB MODE (`--db <name>`): pointed at a database the
#   target_shape_baseline migration has already built (run-baseline.sh, TS-7c).
#   Nothing is created, written or dropped.
#   Runs (a), (b), and (c'') = (c') with schema.prisma itself as the reference
#   (there is no pre-index pull of a migrated database), plus the same sql_
#   completeness check. <name> must match ^ts[67]_[a-z0-9_]+$, or be one of
#   the target branch's dev databases mwf_target_dev / mwf_target_test.
#
# Why the pull is staged: Prisma 7.10 `db pull` renders partial indexes (as
# `where: raw(…)`, auto-adding the `partialIndexes` preview feature) and infers
# a 1:1 relation from a single-column partial unique. Spec §5 keeps them out of
# schema.prisma, so a pull of a database with them can never equal it. Never
# refresh schema.prisma from `db pull`. (Verified TS-6, 2026-10-19, PG 18.6.)
#
# The Prisma DDL for consent.target_kind carries a DEFAULT that references
# other columns (the generated expression, as `db pull` renders it), which
# Postgres rejects. Build mode therefore generates the DDL from a copy of
# schema.prisma with that one @default removed; sql-only.sql §1 then drops the
# plain column and re-adds it GENERATED. The baseline generator does the same.
#
# Exits non-zero on any failure. Only ever addresses a database whose name
# matches ^ts[67]_ (build mode: exactly ts6_target), or, read-only, one of
# mwf_target_dev / mwf_target_test.
#
# Usage: backend/scripts/target-shape/check-schema.sh [--db <name>] [out-dir]
#   out-dir (default: fresh mktemp dir) receives the evidence.
# Env: MWF_PG_CONTAINER (mwf-postgres), PGUSER_SU (mwf_user),
#      PGPASSWORD_SU (mwf_password), PGHOST_SU (127.0.0.1), PGPORT_SU (5432).
# ============================================================================
set -euo pipefail

MODE=build
DB=ts6_target
if [ "${1:-}" = "--db" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 [--db <name>] [out-dir]" >&2; exit 2; }
  MODE=existing; DB="$2"; shift 2
fi
OUT_ARG="${1:-}"

# Hard guard: refuse every database outside the scratch prefix, and the named
# real ones even if someone loosens the pattern.
if ! [[ "$DB" =~ ^ts[67]_[a-z0-9_]+$ ]] && ! { [ "$MODE" = existing ] && [[ "$DB" =~ ^mwf_target_(dev|test)$ ]]; }; then
  echo "refusing: database '$DB' does not match ^ts[67]_[a-z0-9_]+\$" >&2; exit 2
fi
case "$DB" in
  meet_without_fear|meet_without_fear_test|meet_without_fear_shadow|mwf_fx_*|mwf_run_*|postgres|template*)
    echo "refusing: '$DB' is a protected database" >&2; exit 2 ;;
esac
if [ "$MODE" = build ] && [ "$DB" != ts6_target ]; then
  echo "refusing: build mode only creates/drops ts6_target" >&2; exit 2
fi

CONTAINER="${MWF_PG_CONTAINER:-mwf-postgres}"
SU="${PGUSER_SU:-mwf_user}"
SU_PW="${PGPASSWORD_SU:-mwf_password}"
HOST="${PGHOST_SU:-127.0.0.1}"
PORT="${PGPORT_SU:-5432}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
SQL_ONLY="$HERE/sql-only.sql"
NORMALIZE="$HERE/normalize-schema.cjs"
DELTA="$HERE/check-pull-delta.cjs"
OUT="${OUT_ARG:-$(mktemp -d "${TMPDIR:-/tmp}/ts6-check.XXXXXX")}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# Spec §5 "Lives only in migration SQL" list (sql_*_key_live expanded), plus
# the expression index this task added (spec §1.1 draft Keys line).
SPEC_SQL_NAMES="sql_session_one_live sql_conversation_one_main sql_attempt_one_live_per_direction
sql_result_one_current sql_disposition_one_current sql_user_device_token sql_session_key_live
sql_participant_key_live sql_user_key_live sql_follow_up_due sql_reminder_due sql_need_live"
EXPRESSION_ONLY="sql_draft_one_per_point"   # db pull never renders expression indexes

psql_admin()   { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d postgres "$@"; }
psql_db()      { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d "$DB" "$@"; }
drop_scratch() { psql_admin -c "DROP DATABASE IF EXISTS ts6_target WITH (FORCE)" >/dev/null 2>&1 || true; }

cd "$BACKEND"
export DATABASE_URL="postgresql://${SU}:${SU_PW}@${HOST}:${PORT}/${DB}"
fail=0

# --- sql_ completeness: spec ⊆ file ⊆ pull ∪ expression-only, pull ⊆ file -----
check_sql_names() {  # $1 = pulled schema
  local in_file in_pull missing
  in_file="$(grep -oE '"sql_[a-z0-9_]+"' "$SQL_ONLY" | tr -d '"' | sort -u)"
  in_pull="$(grep -oE '"sql_[a-z0-9_]+"' "$1" | tr -d '"' | sort -u)"
  missing="$(comm -23 <(echo "$SPEC_SQL_NAMES" | tr ' ' '\n' | grep . | sort -u) <(echo "$in_file"))"
  [ -z "$missing" ] || { echo "   FAIL: spec §5 sql_ names missing from sql-only.sql: $missing"; return 1; }
  missing="$(comm -23 <(echo "$in_file") <( (echo "$in_pull"; echo "$EXPRESSION_ONLY") | sort -u))"
  [ -z "$missing" ] || { echo "   FAIL: sql_ names in sql-only.sql missing from the database pull: $missing"; return 1; }
  missing="$(comm -13 <(echo "$in_file") <(echo "$in_pull"))"
  [ -z "$missing" ] || { echo "   FAIL: sql_ names in the pull that sql-only.sql does not create: $missing"; return 1; }
  # the expression index is invisible to pull: check the catalog instead
  [ "$(psql_db -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='$EXPRESSION_ONLY'")" = 1 ] \
    || { echo "   FAIL: $EXPRESSION_ONLY not found in pg_indexes"; return 1; }
  echo "   ok: sql_ names complete — $(echo "$in_pull" | grep -c .) rendered by db pull + $EXPRESSION_ONLY in pg_indexes"
}

check_delta() {  # $1 = reference schema, $2 = pulled schema, $3 = evidence basename
  node "$NORMALIZE" "$1" >"$OUT/$3.ref.norm"
  node "$NORMALIZE" "$2" >"$OUT/$3.pull.norm"
  diff -u "$OUT/$3.ref.norm" "$OUT/$3.pull.norm" >"$OUT/$3.diff" || true
  if node "$DELTA" "$OUT/$3.ref.norm" "$OUT/$3.pull.norm" >"$OUT/$3.unexplained"; then
    echo "   ok: every difference is an sql_ index or its derived effect ($(grep -c '^[-+][^-+]' "$OUT/$3.diff" || true) diff lines)"
  else
    echo "   FAIL: unexplained differences:"; cat "$OUT/$3.unexplained"; return 1
  fi
}

check_drift() {
  npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script >"$OUT/drift.sql"
  # Prisma prints exactly "-- This is an empty migration." when there is nothing to do.
  if grep -v -e '^[[:space:]]*$' -e '^-- This is an empty migration\.$' "$OUT/drift.sql" >/dev/null; then
    echo "   FAIL: drift script is not empty:"; cat "$OUT/drift.sql"; return 1
  fi
  echo "   ok: $(tr '\n' ' ' <"$OUT/drift.sql")"
}

check_validate() {
  if npx prisma validate >"$OUT/validate.txt" 2>&1; then echo "   ok"
  else echo "   FAIL"; cat "$OUT/validate.txt"; return 1; fi
}

if [ "$MODE" = existing ]; then
  echo "== existing database ${DB} (container ${CONTAINER}) — read-only"
  [ "$(psql_admin -Atc "SELECT count(*) FROM pg_database WHERE datname = '${DB}'")" = 1 ] \
    || { echo "no such database: $DB" >&2; exit 2; }
  echo "== (a) prisma validate";                 check_validate || fail=1
  echo "== (b) migrate diff (must be empty)";    check_drift || fail=1
  echo "== (c'') db pull vs schema.prisma: only sql_ objects may differ"
  npx prisma db pull --print >"$OUT/pulled-full.prisma"
  check_delta prisma/schema.prisma "$OUT/pulled-full.prisma" pull-full-vs-schema || fail=1
  check_sql_names "$OUT/pulled-full.prisma" || fail=1
else
  trap drop_scratch EXIT
  grep -q '^-- @@section: indexes' "$SQL_ONLY" || { echo "sql-only.sql lost its section marker" >&2; exit 2; }
  awk '/^-- @@section: indexes/{exit} {print}' "$SQL_ONLY" >"$OUT/sql-only-1-columns.sql"
  awk 'f{print} /^-- @@section: indexes/{f=1}' "$SQL_ONLY" >"$OUT/sql-only-2-indexes.sql"

  echo "== scratch database ${DB} (container ${CONTAINER})"
  drop_scratch
  psql_admin -c "CREATE DATABASE ts6_target"

  echo "== apply: Prisma DDL (--from-empty), then sql-only.sql §1 (generated columns)"
  perl -0pe 's/(\n\s*targetKind\s+ConsentTarget\s+)\@default\(dbgenerated\("\\nCASE.*?END"\)\)\s*/$1/s' \
    prisma/schema.prisma >"$OUT/schema-ddl.prisma"
  [ "$(diff prisma/schema.prisma "$OUT/schema-ddl.prisma" | grep -c '^>')" = 1 ] \
    || { echo "could not strip the target_kind default for the DDL (expected exactly one changed line)" >&2; exit 1; }
  npx prisma migrate diff --from-empty --to-schema "$OUT/schema-ddl.prisma" --script >"$OUT/from-empty.sql"
  psql_db -1 -f - <"$OUT/from-empty.sql"
  psql_db -1 -f - <"$OUT/sql-only-1-columns.sql"
  echo "   tables: $(psql_db -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"

  echo "== (a) prisma validate"; check_validate || fail=1

  echo "== (c) db pull --print vs schema.prisma (before the sql_ indexes)"
  npx prisma db pull --print >"$OUT/pulled-base.prisma"
  diff -u prisma/schema.prisma "$OUT/pulled-base.prisma" >"$OUT/pull-base-raw.diff" || true
  if diff -u <(node "$NORMALIZE" prisma/schema.prisma) <(node "$NORMALIZE" "$OUT/pulled-base.prisma") \
       >"$OUT/pull-base.diff"; then
    echo "   ok: identical after normalisation"
  else
    echo "   FAIL: db pull differs from schema.prisma:"; cat "$OUT/pull-base.diff"; fail=1
  fi

  echo "== apply: sql-only.sql §2 (sql_ indexes)"
  psql_db -1 -f - <"$OUT/sql-only-2-indexes.sql"

  echo "== (b) migrate diff --from-config-datasource --to-schema (must be empty)"; check_drift || fail=1

  echo "== (c') db pull after the sql_ indexes: only the sql_ objects may differ"
  npx prisma db pull --print >"$OUT/pulled-full.prisma"
  check_delta "$OUT/pulled-base.prisma" "$OUT/pulled-full.prisma" pull-full-vs-base || fail=1
  check_sql_names "$OUT/pulled-full.prisma" || fail=1
fi

echo "== evidence in $OUT"
if [ "$fail" -ne 0 ]; then echo "GATE FAILED"; exit 1; fi
echo "GATE PASSED"
