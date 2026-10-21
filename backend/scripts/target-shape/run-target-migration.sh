#!/usr/bin/env bash
# ============================================================================
# run-target-migration.sh — repeatable scratch run of the target_shape
# migration (TS-7).
#
#   backend/scripts/target-shape/run-target-migration.sh <ts7_name> [options]
#
# 1. CI-style check: the generator is deterministic (two runs, cmp) and the
#    committed migration.sql equals its output.               (--check-only stops here)
# 2. Builds <ts7_name> at the CURRENT shape: CREATE DATABASE, then
#    `prisma migrate deploy` of the phoenix/base migration history from a
#    checkout of phoenix/base (BASE_DIR, default <repo>/.ts7-base, created with
#    `git worktree add --detach` when missing).
# 3. Seeds every TargetStage, with and without a partner, through the
#    current-shape state factory of that checkout (seed-current-shape.ts);
#    --extras adds seed-extras.sql (rows the fixtures never write: tending,
#    closure, shared needs, sub-chats, wellbeing, a vanished member, …).
# 4. Records verify-style row counts of every table (before.counts).
# 5. Applies fix-data.fixtures.sql (the fix-data template filled in for the
#    fixtures) unless --no-fix; --fix-data <file> applies another file instead.
# 6. Applies the migration with `prisma migrate deploy` (DATABASE_URL pointed
#    at the scratch database; backend/prisma.config.ts), logging to deploy.log.
# 7. Prints the per-step count report (app_migration.row_counts, .report).
# 8. Runs check-schema.sh --db <ts7_name>, then smoke-target-migration.sql.
#
# Never touches anything but ^ts7_[a-z0-9_]+$ databases; refuses the shared
# ones by name even if the pattern were loosened. Never `prisma migrate dev`,
# never `db push`. Evidence goes to --out <dir> (default: a fresh mktemp dir).
#
# Options: --check-only | --no-fix | --fix-data <file> | --extras | --keep-going
#          --skip-seed (reuse an existing current-shape database: only steps 4–8)
#          --out <dir>
# Env: MWF_PG_CONTAINER (mwf-postgres), PGUSER_SU (mwf_user), PGPASSWORD_SU
#      (mwf_password), PGHOST_SU (127.0.0.1), PGPORT_SU (5432), BASE_DIR,
#      BASE_REF (phoenix/base).
# ============================================================================
set -euo pipefail

DB="${1:-}"; shift || true
CHECK_ONLY=0; NO_FIX=0; FIX_FILE=""; EXTRAS=0; KEEP_GOING=0; SKIP_SEED=0; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --no-fix) NO_FIX=1 ;;
    --fix-data) FIX_FILE="$2"; shift ;;
    --extras) EXTRAS=1 ;;
    --keep-going) KEEP_GOING=1 ;;
    --skip-seed) SKIP_SEED=1 ;;
    --out) OUT="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if ! [[ "$DB" =~ ^ts7_[a-z0-9_]+$ ]]; then
  echo "usage: $0 <ts7_name> [options]  — database must match ^ts7_[a-z0-9_]+\$ (got '$DB')" >&2; exit 2
fi
case "$DB" in
  meet_without_fear|meet_without_fear_test|meet_without_fear_shadow|mwf_fx_*|mwf_run_*|mwf_fid_*|ts6_*|postgres|template*)
    echo "refusing: '$DB' is a protected database" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$BACKEND/.." && pwd)"
CONTAINER="${MWF_PG_CONTAINER:-mwf-postgres}"
SU="${PGUSER_SU:-mwf_user}"; SU_PW="${PGPASSWORD_SU:-mwf_password}"
HOST="${PGHOST_SU:-127.0.0.1}"; PORT="${PGPORT_SU:-5432}"
BASE_REF="${BASE_REF:-phoenix/base}"
BASE_DIR="${BASE_DIR:-$REPO/.ts7-base}"
OUT="${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ts7-run.XXXXXX")}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
URL="postgresql://${SU}:${SU_PW}@${HOST}:${PORT}/${DB}"
PRISMA="$REPO/node_modules/.bin/prisma"
TSX="$REPO/node_modules/.bin/tsx"

MIGRATION_DIR="$(ls -d "$BACKEND"/prisma/migrations/*_target_shape 2>/dev/null | tail -1)"
[ -n "$MIGRATION_DIR" ] || { echo "no *_target_shape migration directory" >&2; exit 1; }
MIGRATION="$MIGRATION_DIR/migration.sql"

psql_admin() { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d postgres "$@"; }
psql_db()    { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d "$DB" "$@"; }
step()       { echo; echo "== $*"; }

# --- 1. generator determinism + committed file ---------------------------------
step "1. generator: deterministic, and equal to $(basename "$MIGRATION_DIR")/migration.sql"
( cd "$BACKEND" && "$TSX" scripts/gen-target-migration.ts >"$OUT/gen-1.sql" && "$TSX" scripts/gen-target-migration.ts >"$OUT/gen-2.sql" )
cmp "$OUT/gen-1.sql" "$OUT/gen-2.sql" && echo "   ok: two runs byte-identical ($(wc -c <"$OUT/gen-1.sql") bytes, sha256 $(shasum -a 256 "$OUT/gen-1.sql" | cut -c1-16))"
cmp "$OUT/gen-1.sql" "$MIGRATION" && echo "   ok: committed migration.sql equals the generator output"
( cd "$BACKEND" && "$TSX" scripts/gen-target-migration.ts --fix-data-template >"$OUT/fix-data.template.sql" )
cmp "$OUT/fix-data.template.sql" "$HERE/fix-data.template.sql" && echo "   ok: committed fix-data.template.sql equals the generator output"
[ "$CHECK_ONLY" = 1 ] && { echo "check-only: done"; exit 0; }

# --- 2–3. current-shape scratch database, seeded -------------------------------
if [ "$SKIP_SEED" = 0 ]; then
  step "2. current shape: $DB from $BASE_REF ($BASE_DIR)"
  if [ ! -d "$BASE_DIR/backend" ]; then
    git -C "$REPO" worktree add --detach "$BASE_DIR" "$BASE_REF"
  fi
  echo "   base checkout at $(git -C "$BASE_DIR" log -1 --format='%h %s' | cut -c1-90)"
  ( cd "$BASE_DIR/backend" && "$PRISMA" generate >/dev/null 2>&1 )
  psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
  ( cd "$BASE_DIR/backend" && DATABASE_URL="$URL" "$PRISMA" migrate deploy >"$OUT/base-deploy.log" 2>&1 ) \
    || { cat "$OUT/base-deploy.log"; exit 1; }
  echo "   $(grep -c '' <(ls "$BASE_DIR/backend/prisma/migrations" | grep -v toml)) migrations applied"

  step "3. seed every TargetStage × {with partner, without}"
  ( cd "$BASE_DIR/backend" && BASE_BACKEND="$BASE_DIR/backend" DATABASE_URL="$URL" NODE_ENV=test \
      "$TSX" "$HERE/seed-current-shape.ts" >"$OUT/seed.jsonl" )
  echo "   $(wc -l <"$OUT/seed.jsonl" | tr -d ' ') sessions seeded"
  if [ "$EXTRAS" = 1 ]; then
    psql_db -1 -f - <"$HERE/seed-extras.sql" >"$OUT/extras.log"
    echo "   extras: seed-extras.sql applied"
  fi
fi

# --- 4. verify-style row counts ---------------------------------------------------
step "4. row counts before (every public table)"
psql_db -At -F ' ' >"$OUT/before.counts" <<'SQL'
SELECT format('SELECT %L, count(*) FROM public.%I', tablename, tablename) FROM pg_tables
WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename
\gexec
SQL
echo "   $(wc -l <"$OUT/before.counts" | tr -d ' ') tables, $(awk '{s+=$2} END {print s}' "$OUT/before.counts") rows"

# --- 5. fix-data ----------------------------------------------------------------
if [ "$NO_FIX" = 0 ]; then
  FIX="${FIX_FILE:-$HERE/fix-data.fixtures.sql}"
  step "5. fix-data: $(basename "$FIX")"
  psql_db -1 -f - <"$FIX" >"$OUT/fix-data.log"
  echo "   applied"
fi
psql_db -f - <"$HERE/smoke-before.sql" >"$OUT/smoke-before.txt"
echo "   old-shape facts recorded in schema ts7_smoke: $(grep 'smoke-before' "$OUT/smoke-before.txt" | tr -s ' ')"

# --- 6. the migration -----------------------------------------------------------
step "6. prisma migrate deploy → $DB"
set +e
( cd "$BACKEND" && DATABASE_URL="$URL" "$PRISMA" migrate deploy ) >"$OUT/deploy.log" 2>&1
DEPLOY_RC=$?
set -e
tail -n 25 "$OUT/deploy.log"
if [ "$DEPLOY_RC" -ne 0 ]; then
  echo "   migrate deploy FAILED (exit $DEPLOY_RC)"
  psql_db -At -c "SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
                  FROM _prisma_migrations WHERE migration_name LIKE '%target_shape'" | sed 's/^/   _prisma_migrations: /'
  [ "$KEEP_GOING" = 1 ] || exit 1
  exit 1
fi

# --- 7. count report -------------------------------------------------------------
step "7. per-step count report (app_migration)"
psql_db >"$OUT/report.txt" <<'SQL'
\pset pager off
SELECT phase, table_name, n FROM app_migration.row_counts ORDER BY phase DESC, table_name;
SELECT step, item, n, left(coalesce(detail, ''), 160) AS detail FROM app_migration.report ORDER BY seq;
SQL
sed 's/^/   /' "$OUT/report.txt"

# --- 8. schema gate, smoke --------------------------------------------------------
step "8a. check-schema.sh --db $DB"
bash "$HERE/check-schema.sh" --db "$DB" "$OUT/check-schema" >"$OUT/check-schema.log" 2>&1 \
  && grep -E '^(==|   ok|   FAIL|GATE)' "$OUT/check-schema.log" | sed 's/^/   /' \
  || { cat "$OUT/check-schema.log"; exit 1; }

step "8b. smoke-target-migration.sql"
psql_db -f - <"$HERE/smoke-target-migration.sql" >"$OUT/smoke.txt" 2>&1 || { cat "$OUT/smoke.txt"; exit 1; }
sed 's/^/   /' "$OUT/smoke.txt"

echo
echo "== evidence in $OUT"
echo "RUN PASSED"
