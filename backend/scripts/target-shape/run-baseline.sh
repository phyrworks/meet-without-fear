#!/usr/bin/env bash
# ============================================================================
# run-baseline.sh — build the target shape from the single baseline migration
# and prove it (TS-7c; owner decision OD7, 2026-10-26: no data move).
#
#   run-baseline.sh <ts7_name> [--as-migrator] [--keep] [--out <dir>]
#   run-baseline.sh --cutover <ts7_name> [--keep] [--out <dir>]
#   run-baseline.sh --dev [--out <dir>]
#
# Default mode, on <ts7_name> (must match ^ts7_[a-z0-9_]+$):
#   1. generator: two runs byte-identical, equal to the committed migration,
#      and prisma/migrations holds only the baseline (gen-target-migration.ts --check);
#   2. CREATE DATABASE (dropped first if it exists);
#   3. `prisma migrate deploy` (DATABASE_URL at the scratch database;
#      backend/prisma.config.ts) — with --as-migrator, the database is created
#      OWNED BY mwf_migrator and the deploy logs in as mwf_migrator (password
#      MIGRATOR_PASSWORD, default mwf_migrator_dev);
#   4. check-schema.sh --db (validate / drift empty / pull delta sql_-only /
#      sql_ names complete);
#   5. caller test 18: a second `prisma migrate deploy` is a no-op (no pending
#      migration, one finished _prisma_migrations row, schema dump unchanged);
#   6. seed-target-fixture.sql, then smoke-baseline.sql (every view as mwf_app);
#   7. functions-caller-tests.sql (tests 1–17, as mwf_app / mwf_job logins) on
#      a throwaway clone <ts7_name>_calls, dropped afterwards.
#   The scratch database is dropped at the end unless --keep.
#
# --cutover <ts7_name>: the production cutover path (plan §6), end to end.
#   a. builds <ts7_name> at the OLD shape: `prisma migrate deploy` of the
#      phoenix/base history from a checkout of phoenix/base (BASE_DIR, default
#      <repo>/.ts7-base, `git worktree add --detach` when missing);
#   b. seeds it through that checkout's current-shape state factory (every
#      TargetStage, with and without a partner);
#   c. negative: the baseline deploy is refused while the old shape is there;
#   d. negative: drop-old-objects.sql refuses a database outside its allow-list;
#   e. drop-old-objects.sql -v target_db=<ts7_name>;
#   f. steps 3–7 above on the same database;
#   g. negative: drop-old-objects.sql refuses the database now on the target shape.
#   With --as-migrator the database is OWNED BY mwf_migrator (non-superuser,
#   mwf_job WITH INHERIT FALSE, SET TRUE) and a, c, d, e, f, g run as it.
#
# --dev: creates (if missing) mwf_target_dev, mwf_target_test and
#   mwf_target_shadow — the target branch's development databases
#   (docs/development/local-setup.md, "Working on phoenix/target-shape") —
#   deploys the baseline into mwf_target_dev and mwf_target_test (a no-op when
#   already applied), runs the gate on both, and leaves all three in place.
#   A pre-existing database with tables but no _prisma_migrations fails with
#   Prisma P3005; it is never dropped here (another worktree may be using it).
#   The shadow database stays empty (prisma migrate dev uses it).
#
# Never touches a database outside ^ts7_[a-z0-9_]+$ except the three
# mwf_target_* names in --dev; refuses the shared ones by name. Never
# `prisma migrate dev`, never `db push`. Evidence goes to --out <dir>
# (default: a fresh mktemp dir).
# Env: MWF_PG_CONTAINER (mwf-postgres), PGUSER_SU (mwf_user), PGPASSWORD_SU
#      (mwf_password), PGHOST_SU (127.0.0.1), PGPORT_SU (5432),
#      MIGRATOR_PASSWORD (mwf_migrator_dev), BASE_DIR, BASE_REF (phoenix/base).
# ============================================================================
set -euo pipefail

MODE=baseline; DB=""; AS_MIGRATOR=0; KEEP=0; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cutover) MODE=cutover ;;
    --dev) MODE=dev ;;
    --as-migrator) AS_MIGRATOR=1 ;;
    --keep) KEEP=1 ;;
    --out) OUT="$2"; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$DB" ] || { echo "one database only" >&2; exit 2; }; DB="$1" ;;
  esac
  shift
done

refuse_protected() {
  case "$1" in
    meet_without_fear*|mwf_fx_*|mwf_tfx_*|mwf_run_*|mwf_trun_*|mwf_fid_*|ts6_*|postgres|template*)
      echo "refusing: '$1' is a protected database" >&2; exit 2 ;;
  esac
}
if [ "$MODE" = dev ]; then
  [ -z "$DB" ] || { echo "--dev takes no database name" >&2; exit 2; }
else
  if ! [[ "$DB" =~ ^ts7_[a-z0-9_]+$ ]]; then
    echo "usage: $0 <ts7_name> [...] — database must match ^ts7_[a-z0-9_]+\$ (got '$DB')" >&2; exit 2
  fi
  case "$DB" in mwf_target_*) echo "refusing: '$DB'" >&2; exit 2 ;; esac
  refuse_protected "$DB"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$BACKEND/.." && pwd)"
CONTAINER="${MWF_PG_CONTAINER:-mwf-postgres}"
SU="${PGUSER_SU:-mwf_user}"; SU_PW="${PGPASSWORD_SU:-mwf_password}"
HOST="${PGHOST_SU:-127.0.0.1}"; PORT="${PGPORT_SU:-5432}"
MIG_PW="${MIGRATOR_PASSWORD:-mwf_migrator_dev}"
BASE_REF="${BASE_REF:-phoenix/base}"
BASE_DIR="${BASE_DIR:-$REPO/.ts7-base}"
OUT="${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ts7c-run.XXXXXX")}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
PRISMA="$REPO/node_modules/.bin/prisma"
TSX="$REPO/node_modules/.bin/tsx"

su_url()     { echo "postgresql://${SU}:${SU_PW}@${HOST}:${PORT}/$1"; }
mig_url()    { echo "postgresql://mwf_migrator:${MIG_PW}@${HOST}:${PORT}/$1"; }
psql_admin() { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d postgres "$@"; }
psql_on()    { local d="$1"; shift; podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d "$d" "$@"; }
db_exists()  { [ "$(psql_admin -Atc "SELECT count(*) FROM pg_database WHERE datname = '$1'")" = 1 ]; }
step()       { echo; echo "== $*"; }
deploy()     { ( cd "$BACKEND" && DATABASE_URL="$1" "$PRISMA" migrate deploy ); }
schema_md5() { podman exec "$CONTAINER" pg_dump -U "$SU" -d "$1" --schema-only --no-owner | grep -v '^\\\(un\)\?restrict ' | shasum -a 256 | cut -c1-16; }

# --- 1. generator ----------------------------------------------------------------
step "1. generator: deterministic, equal to the committed baseline, the only migration"
( cd "$REPO" && "$TSX" backend/scripts/gen-target-migration.ts --check ) | sed 's/^/   /'
MIGRATION_NAME="$(ls "$BACKEND/prisma/migrations" | grep -v '\.toml$')"
echo "   migrations: $MIGRATION_NAME"

# --- the checks every built database gets (steps 4–7) ------------------------------
verify_target() {  # $1 = database, $2 = deploy url
  local d="$1" url="$2" before after out18 n
  step "4. check-schema.sh --db $d"
  bash "$HERE/check-schema.sh" --db "$d" "$OUT/check-schema-$d" >"$OUT/check-schema-$d.log" 2>&1 \
    && grep -E '^(==|   ok|   FAIL|GATE)' "$OUT/check-schema-$d.log" | sed 's/^/   /' \
    || { cat "$OUT/check-schema-$d.log"; exit 1; }

  step "5. caller test 18: a second migrate deploy is a no-op"
  before="$(schema_md5 "$d")"
  out18="$(deploy "$url" 2>&1)" || { echo "$out18"; exit 1; }
  echo "$out18" >"$OUT/deploy-2-$d.log"
  after="$(schema_md5 "$d")"
  n="$(psql_on "$d" -Atc "SELECT count(*) || ' row(s), ' || count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || ' finished: ' || string_agg(migration_name, ',') FROM _prisma_migrations")"
  echo "   second deploy: $(echo "$out18" | grep -E 'No pending migrations|applied' | tr -s ' ' | head -1)"
  echo "   _prisma_migrations: $n"
  echo "   schema dump sha256: before $before, after $after"
  if echo "$out18" | grep -q 'No pending migrations to apply' && [ "$before" = "$after" ] \
     && [ "$n" = "1 row(s), 1 finished: $MIGRATION_NAME" ]; then
    echo "   PASS 18 second migrate deploy is a no-op"
  else
    echo "   TEST FAILED 18"; exit 1
  fi

  if [ "$MODE" = dev ]; then return 0; fi

  step "6a. seed-target-fixture.sql"
  psql_on "$d" -1 -At -f - <"$HERE/seed-target-fixture.sql" | sed 's/^/   /'
  step "6b. smoke-baseline.sql (as mwf_app)"
  psql_on "$d" -f - <"$HERE/smoke-baseline.sql" >"$OUT/smoke-$d.txt" 2>&1 || { cat "$OUT/smoke-$d.txt"; exit 1; }
  grep -E 'smoke ok|smoke-baseline' "$OUT/smoke-$d.txt" | sed 's/^psql:<stdin>:[0-9]*: //; s/^NOTICE:  //; s/^ *//; s/^/   /'

  step "7. functions-caller-tests.sql — as mwf_app and mwf_job (logins, not the superuser), on a throwaway clone"
  local ct="${d:0:56}_calls"
  psql_admin -c "DROP DATABASE IF EXISTS $ct WITH (FORCE)" -c "CREATE DATABASE $ct TEMPLATE $d" >/dev/null
  podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d "$ct" <"$HERE/functions-caller-tests.sql" >"$OUT/caller-tests-$d.txt" 2>&1 \
    || { cat "$OUT/caller-tests-$d.txt"; psql_admin -c "DROP DATABASE IF EXISTS $ct WITH (FORCE)" >/dev/null; exit 1; }
  psql_admin -c "DROP DATABASE IF EXISTS $ct WITH (FORCE)" >/dev/null
  grep -E 'PASS|connected as|ALL PASSED' "$OUT/caller-tests-$d.txt" | sed 's/^NOTICE:  /   /; s/^ /   /'
  local tests
  tests="$( (grep -oE 'PASS [0-9]+' "$OUT/caller-tests-$d.txt"; echo 'PASS 18') | sort -u | wc -l | tr -d ' ')"
  echo "   caller tests: $tests/18 passed (1–17 SQL, 18 the second deploy)"
  [ "$tests" = 18 ] || { echo "   expected 18"; exit 1; }
}

drop_db() { psql_admin -c "DROP DATABASE IF EXISTS $1 WITH (FORCE)" >/dev/null; echo "   dropped $1"; }

case "$MODE" in
baseline)
  step "2. CREATE DATABASE $DB$([ "$AS_MIGRATOR" = 1 ] && echo ' OWNER mwf_migrator')"
  psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" \
             -c "CREATE DATABASE $DB$([ "$AS_MIGRATOR" = 1 ] && echo ' OWNER mwf_migrator')"
  URL="$(su_url "$DB")"; [ "$AS_MIGRATOR" = 1 ] && URL="$(mig_url "$DB")"
  step "3. prisma migrate deploy → $DB (as $([ "$AS_MIGRATOR" = 1 ] && echo mwf_migrator || echo "$SU"))"
  deploy "$URL" >"$OUT/deploy-$DB.log" 2>&1 || { cat "$OUT/deploy-$DB.log"; exit 1; }
  grep -E 'applied|Applying|migration' "$OUT/deploy-$DB.log" | sed 's/^/   /'
  psql_on "$DB" -Atc "SELECT 'tables ' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations')
                      || ', views ' || (SELECT count(*) FROM pg_views WHERE schemaname = 'public')
                      || ', app functions ' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app')
                      || ', table owner ' || (SELECT tableowner FROM pg_tables WHERE tablename = 'session')
                      || ', definer owner ' || (SELECT string_agg(DISTINCT pg_get_userbyid(proowner), ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.prosecdef)" | sed 's/^/   /'
  verify_target "$DB" "$URL"
  ;;

cutover)
  # --as-migrator: the whole path runs as the NON-superuser owner mwf_migrator
  # (it holds mwf_job WITH INHERIT FALSE, SET TRUE, as production's owner does):
  # old history deploy, drop-old-objects.sql, baseline deploy. Only the vector
  # extension is pre-created by the superuser (an untrusted extension; in
  # production it already exists), so the old migration's CREATE EXTENSION IF
  # NOT EXISTS is a no-op.
  URL="$(su_url "$DB")"; OWNER_ROLE="$SU"
  if [ "$AS_MIGRATOR" = 1 ]; then URL="$(mig_url "$DB")"; OWNER_ROLE=mwf_migrator; fi
  psql_owner() { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$OWNER_ROLE" -d "$DB" "$@"; }
  step "a. old shape: $DB from $BASE_REF ($BASE_DIR), owned by and deployed as $OWNER_ROLE"
  if [ ! -d "$BASE_DIR/backend" ]; then
    git -C "$REPO" worktree add --detach "$BASE_DIR" "$BASE_REF" >/dev/null 2>&1
  fi
  echo "   base checkout at $(git -C "$BASE_DIR" log -1 --format='%h %s' | cut -c1-90)"
  ( cd "$BASE_DIR/backend" && "$PRISMA" generate >/dev/null 2>&1 )
  psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB OWNER $OWNER_ROLE"
  if [ "$AS_MIGRATOR" = 1 ]; then
    psql_on "$DB" -c "CREATE EXTENSION IF NOT EXISTS vector"
    echo "   owner: $(psql_admin -Atc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$DB'"); rolsuper=$(psql_admin -Atc "SELECT rolsuper FROM pg_roles WHERE rolname = 'mwf_migrator'"); membership in mwf_job: $(psql_admin -Atc "SELECT 'inherit=' || inherit_option || ' set=' || set_option FROM pg_auth_members WHERE roleid = 'mwf_job'::regrole AND member = 'mwf_migrator'::regrole"); vector pre-created by $SU"
  fi
  ( cd "$BASE_DIR/backend" && DATABASE_URL="$URL" "$PRISMA" migrate deploy >"$OUT/base-deploy.log" 2>&1 ) \
    || { cat "$OUT/base-deploy.log"; exit 1; }
  echo "   $(psql_on "$DB" -Atc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL") old migrations applied"

  step "b. seed every TargetStage × {with partner, without} through the current-shape state factory"
  cat >"$OUT/seed-old.ts" <<'TS'
/* eslint-disable @typescript-eslint/no-var-requires */
const base = process.env.BASE_BACKEND as string;
if (!/\/ts7_[a-z0-9_]+(\?.*)?$/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing DATABASE_URL outside ts7_*');
const { stateFactory, TargetStage } = require(`${base}/src/testing/state-factory`);
const { prisma } = require(`${base}/src/lib/prisma`);
const STAGES = ['CREATED', 'INVITATION_READY', 'EMPATHY_SHARED_A', 'FEEL_HEARD_B', 'RECONCILER_SHOWN_B', 'CONTEXT_SHARED_B',
  'EMPATHY_REVEALED', 'NEED_MAPPING_COMPLETE', 'STRATEGIC_REPAIR_COMPLETE', 'STAGE4_REDESIGN_INVENTORY',
  'STAGE4_REDESIGN_SHARED_SELECTIONS', 'STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS', 'STAGE4_REDESIGN_PARTNER_INACTIVE'];
(async () => {
  for (const variant of ['b', 'nob']) {
    for (const stage of STAGES) {
      const tag = stage.toLowerCase().replace(/_/g, '-');
      const r = await stateFactory.createSessionAtStage({
        userA: { email: `a.${tag}.${variant}@e2e.test`, name: 'Ada Lovelace' },
        userB: variant === 'b' ? { email: `b.${tag}@e2e.test`, name: 'Bob Ross' } : undefined,
        targetStage: TargetStage[stage],
      });
      process.stdout.write(JSON.stringify({ stage, variant, sessionId: r.session.id }) + '\n');
    }
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
TS
  ( cd "$BASE_DIR/backend" && BASE_BACKEND="$BASE_DIR/backend" DATABASE_URL="$URL" NODE_ENV=test \
      "$TSX" "$OUT/seed-old.ts" >"$OUT/seed-old.jsonl" )
  echo "   $(wc -l <"$OUT/seed-old.jsonl" | tr -d ' ') sessions seeded"
  psql_on "$DB" -At -F ' ' >"$OUT/old-counts.txt" <<'SQL'
SELECT format('SELECT %L, count(*) FROM public.%I', tablename, tablename) FROM pg_tables
WHERE schemaname = 'public' ORDER BY tablename
\gexec
SQL
  echo "   old shape: $(grep -vc '^_prisma' "$OUT/old-counts.txt") tables, $(awk '$1 != "_prisma_migrations" {s+=$2} END {print s}' "$OUT/old-counts.txt") rows"

  step "c. negative: the baseline deploy is refused while the old shape is there"
  set +e; deploy "$URL" >"$OUT/deploy-on-old.log" 2>&1; rc=$?; set -e
  if [ "$rc" -ne 0 ] && grep -q 'still at the old shape' "$OUT/deploy-on-old.log"; then
    echo "   PASS refused (exit $rc): $(grep -o 'target_shape_baseline: this database is still at the old shape.*' "$OUT/deploy-on-old.log" | head -1)"
  else
    echo "   FAIL: deploy on the old shape was not refused as expected (exit $rc)"; cat "$OUT/deploy-on-old.log"; exit 1
  fi
  echo "   old tables still there: $(psql_on "$DB" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'")"

  step "d. negative: drop-old-objects.sql outside its allow-list, and without one"
  for args in "-v target_db=some_other_db" ""; do
    set +e; psql_owner $args -f - <"$HERE/drop-old-objects.sql" >"$OUT/drop-refused.log" 2>&1; rc=$?; set -e
    if [ "$rc" -ne 0 ] && grep -q 'refusing' "$OUT/drop-refused.log"; then
      echo "   PASS refused ($([ -n "$args" ] && echo "$args" || echo 'no -v target_db')): $(grep -o 'drop-old-objects: refusing[^$]*' "$OUT/drop-refused.log" | head -1)"
    else
      echo "   FAIL: not refused"; cat "$OUT/drop-refused.log"; exit 1
    fi
  done

  step "e. drop-old-objects.sql -v target_db=$DB (as $OWNER_ROLE)"
  psql_owner -v target_db="$DB" -f - <"$HERE/drop-old-objects.sql" 2>&1 | sed 's/^NOTICE:  /   /'
  echo "   left in public: $(psql_on "$DB" -Atc "SELECT count(*) || ' relations, ' || (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e') || ' enums' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','S','p','f')"); extensions: $(psql_on "$DB" -Atc "SELECT string_agg(extname, ',') FROM pg_extension")"

  step "3. prisma migrate deploy → $DB (the baseline, after the drop)"
  deploy "$URL" >"$OUT/deploy-$DB.log" 2>&1 || { cat "$OUT/deploy-$DB.log"; exit 1; }
  grep -E 'applied|Applying|migration' "$OUT/deploy-$DB.log" | sed 's/^/   /'
  verify_target "$DB" "$URL"

  step "g. negative: drop-old-objects.sql refuses the database now on the target shape"
  set +e; psql_owner -v target_db="$DB" -f - <"$HERE/drop-old-objects.sql" >"$OUT/drop-on-target.log" 2>&1; rc=$?; set -e
  if [ "$rc" -ne 0 ] && grep -q 'does not have the old shape' "$OUT/drop-on-target.log"; then
    echo "   PASS refused: $(grep -o 'drop-old-objects: refusing[^$]*' "$OUT/drop-on-target.log" | head -1)"
  else
    echo "   FAIL: not refused"; cat "$OUT/drop-on-target.log"; exit 1
  fi
  ;;

dev)
  for d in mwf_target_dev mwf_target_test mwf_target_shadow; do
    if db_exists "$d"; then echo "   $d exists"; else psql_admin -c "CREATE DATABASE $d" >/dev/null; echo "   created $d"; fi
  done
  for d in mwf_target_dev mwf_target_test; do
    step "3. prisma migrate deploy → $d"
    deploy "$(su_url "$d")" >"$OUT/deploy-$d.log" 2>&1 || { cat "$OUT/deploy-$d.log"; exit 1; }
    grep -E 'applied|Applying|No pending' "$OUT/deploy-$d.log" | sed 's/^/   /'
    verify_target "$d" "$(su_url "$d")"
  done
  echo; echo "== dev databases left in place: mwf_target_dev, mwf_target_test, mwf_target_shadow (empty)"
  ;;
esac

if [ "$MODE" != dev ]; then
  echo
  if [ "$KEEP" = 1 ]; then echo "== kept $DB"; else step "cleanup"; drop_db "$DB"; fi
fi
echo
echo "== evidence in $OUT"
echo "RUN PASSED"
