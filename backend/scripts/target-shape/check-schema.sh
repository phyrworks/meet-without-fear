#!/usr/bin/env bash
# ============================================================================
# check-schema.sh — the TS-6 drift gate for the target shape (Ruling R10).
#
#   1. creates the scratch database ts6_target on the dev container;
#   2. applies the Prisma DDL (`prisma migrate diff --from-empty --to-schema`)
#      and sql-only.sql section 1 (the generated columns);
#   3. (a) `prisma validate`
#      (c) `prisma db pull --print`, normalised (normalize-schema.cjs) and
#          diffed against schema.prisma — must be identical;
#   4. applies sql-only.sql section 2 (the sql_ indexes), then
#      (b) `prisma migrate diff --from-config-datasource --to-schema --script`
#          — must print an empty script;
#      (c') `prisma db pull --print` again — every line that differs from the
#          step-3 pull must be one of the sql_ indexes or a consequence Prisma
#          draws from them (see sql-only.sql §2), and every sql_ name it shows
#          must be one sql-only.sql creates;
#   5. drops the scratch database (also on failure).
#
# Why the pull runs twice: Prisma 7.10 `db pull` renders partial indexes (as
# `where: raw(…)`, auto-adding the `partialIndexes` preview feature) and infers
# a 1:1 relation from a single-column partial unique. The spec (§5) keeps them
# out of schema.prisma, so a pull of the finished database can never equal it;
# the step-3 pull proves everything else equal, step (c') proves the remainder
# is exactly the sql_ objects.
#
# The Prisma DDL for consent.target_kind carries a DEFAULT that references
# other columns (the generated expression, as `db pull` renders it), which
# Postgres rejects. The DDL is therefore generated from a copy of schema.prisma
# with that one @default removed; sql-only.sql §1 then drops the plain column
# and re-adds it GENERATED. TS-7's generator must do the same.
#
# Exits non-zero on any failure. Touches ONLY the database named ts6_target.
#
# Usage: backend/scripts/target-shape/check-schema.sh [out-dir]
#   out-dir (default: fresh mktemp dir) receives the evidence: schema-ddl.prisma,
#   from-empty.sql, validate.txt, pulled-base.prisma, pull-base.diff,
#   pull-base-raw.diff, drift.sql, pulled-full.prisma, pull-full-vs-base.diff.
# Env: MWF_PG_CONTAINER (mwf-postgres), PGUSER_SU (mwf_user),
#      PGPASSWORD_SU (mwf_password), PGHOST_SU (127.0.0.1), PGPORT_SU (5432).
# ============================================================================
set -euo pipefail

SCRATCH_DB=ts6_target
CONTAINER="${MWF_PG_CONTAINER:-mwf-postgres}"
SU="${PGUSER_SU:-mwf_user}"
SU_PW="${PGPASSWORD_SU:-mwf_password}"
HOST="${PGHOST_SU:-127.0.0.1}"
PORT="${PGPORT_SU:-5432}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
SQL_ONLY="$HERE/sql-only.sql"
NORMALIZE="$HERE/normalize-schema.cjs"
OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/ts6-check.XXXXXX")}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# Hard guard: this script only ever addresses the scratch database.
[ "$SCRATCH_DB" = ts6_target ] || { echo "refusing: scratch db must be ts6_target" >&2; exit 2; }

psql_admin()   { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d postgres "$@"; }
psql_scratch() { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d "$SCRATCH_DB" "$@"; }
drop_scratch() { psql_admin -c "DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)" >/dev/null 2>&1 || true; }
trap drop_scratch EXIT

cd "$BACKEND"
export DATABASE_URL="postgresql://${SU}:${SU_PW}@${HOST}:${PORT}/${SCRATCH_DB}"
fail=0

grep -q '^-- @@section: indexes' "$SQL_ONLY" || { echo "sql-only.sql lost its section marker" >&2; exit 2; }
awk '/^-- @@section: indexes/{exit} {print}' "$SQL_ONLY" >"$OUT/sql-only-1-columns.sql"
awk 'f{print} /^-- @@section: indexes/{f=1}' "$SQL_ONLY" >"$OUT/sql-only-2-indexes.sql"

echo "== scratch database ${SCRATCH_DB} (container ${CONTAINER})"
drop_scratch
psql_admin -c "CREATE DATABASE ${SCRATCH_DB}"

echo "== apply: Prisma DDL (--from-empty), then sql-only.sql §1 (generated columns)"
perl -0pe 's/(\n\s*targetKind\s+ConsentTarget\s+)\@default\(dbgenerated\("\\nCASE.*?END"\)\)\s*/$1/s' \
  prisma/schema.prisma >"$OUT/schema-ddl.prisma"
[ "$(diff prisma/schema.prisma "$OUT/schema-ddl.prisma" | grep -c '^>')" = 1 ] \
  || { echo "could not strip the target_kind default for the DDL (expected exactly one changed line)" >&2; exit 1; }
npx prisma migrate diff --from-empty --to-schema "$OUT/schema-ddl.prisma" --script >"$OUT/from-empty.sql"
psql_scratch -1 -f - <"$OUT/from-empty.sql"
psql_scratch -1 -f - <"$OUT/sql-only-1-columns.sql"
echo "   tables: $(psql_scratch -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"

echo "== (a) prisma validate"
if npx prisma validate >"$OUT/validate.txt" 2>&1; then
  echo "   ok"
else
  echo "   FAIL"; cat "$OUT/validate.txt"; fail=1
fi

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
psql_scratch -1 -f - <"$OUT/sql-only-2-indexes.sql"

echo "== (b) migrate diff --from-config-datasource --to-schema (must be empty)"
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script >"$OUT/drift.sql"
# Prisma prints exactly "-- This is an empty migration." when there is nothing to do.
if grep -v -e '^[[:space:]]*$' -e '^-- This is an empty migration\.$' "$OUT/drift.sql" >/dev/null; then
  echo "   FAIL: drift script is not empty:"; cat "$OUT/drift.sql"; fail=1
else
  echo "   ok: $(tr '\n' ' ' <"$OUT/drift.sql")"
fi

echo "== (c') db pull --print after the sql_ indexes: the difference must be the sql_ objects only"
npx prisma db pull --print >"$OUT/pulled-full.prisma"
diff -u <(node "$NORMALIZE" "$OUT/pulled-base.prisma") <(node "$NORMALIZE" "$OUT/pulled-full.prisma") \
  >"$OUT/pull-full-vs-base.diff" || true
# Allowed changed lines: anything naming an sql_ index; a removed line whose
# replacement is the same line plus `@unique(map: "sql_…", where: …)`; the
# generator's previewFeatures line; a bare back-relation field (no attributes,
# or only a relation name) — the []→? cardinality Prisma infers from a
# single-column partial unique.
grep -E '^\+[^+]' "$OUT/pull-full-vs-base.diff" \
  | sed -E 's/ @unique\(map: "sql_[a-z0-9_]+", where: raw\("([^"\\]|\\.)*"\)\)//; s/^\+/-/' \
  >"$OUT/.plus-without-sql.txt"
unexpected="$(grep -E '^[-+][^-+]' "$OUT/pull-full-vs-base.diff" \
  | grep -v -E 'sql_' \
  | grep -v -x -F -f "$OUT/.plus-without-sql.txt" \
  | grep -v -E '^[-+] *previewFeatures = ' \
  | grep -v -E '^[-+] *[A-Za-z0-9_]+ [A-Z][A-Za-z0-9_]*(\?|\[\])( @relation\("[^"]+"\))?$' || true)"
in_file="$(grep -oE '"sql_[a-z0-9_]+"' "$SQL_ONLY" | sort -u)"
in_pull="$(grep -oE '"sql_[a-z0-9_]+"' "$OUT/pulled-full.prisma" | sort -u)"
foreign="$(comm -13 <(echo "$in_file") <(echo "$in_pull"))"
not_rendered="$(comm -23 <(echo "$in_file") <(echo "$in_pull") | tr '\n' ' ')"
if [ -n "$unexpected" ] || [ -n "$foreign" ]; then
  echo "   FAIL: unexpected difference beyond the sql_ objects:"
  [ -n "$unexpected" ] && echo "$unexpected"
  [ -n "$foreign" ] && echo "   sql_ names in the pull that sql-only.sql does not create: $foreign"
  fail=1
else
  echo "   ok: $(echo "$in_pull" | grep -c . ) sql_ indexes rendered by db pull, nothing else changed"
  echo "   not rendered by db pull (expression index): ${not_rendered:-none}"
fi

echo "== evidence in $OUT"
if [ "$fail" -ne 0 ]; then echo "GATE FAILED"; exit 1; fi
echo "GATE PASSED"
