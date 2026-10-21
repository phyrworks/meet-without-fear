#!/usr/bin/env bash
# ============================================================================
# run-negative-tests.sh — the target_shape migration must RAISE, and leave the
# database at the old shape, on doctored data (TS-7 acceptance c).
#
#   backend/scripts/target-shape/run-negative-tests.sh <ts7_base> [out-dir]
#
# <ts7_base> is a seeded current-shape scratch database that the migration
# would apply to cleanly (run-target-migration.sh <ts7_base> --extras
# --no-migrate builds one). For each case: CREATE DATABASE ts7_neg_<n>
# TEMPLATE <ts7_base>, apply the doctoring SQL, `prisma migrate deploy`, and
# expect (1) a non-zero exit whose log contains the expected RAISE text,
# (2) all 68 old tables still there with their row counts unchanged, (3) no
# target table, enum type, or schema app_migration, and (4) the
# _prisma_migrations row Prisma leaves for the failed attempt (reported).
# Each case database is dropped afterwards. Only ts7_* databases are touched.
# ============================================================================
set -euo pipefail

BASE="${1:-}"
if ! [[ "$BASE" =~ ^ts7_[a-z0-9_]+$ ]]; then echo "usage: $0 <ts7_base> [out-dir]" >&2; exit 2; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$BACKEND/.." && pwd)"
CONTAINER="${MWF_PG_CONTAINER:-mwf-postgres}"
SU="${PGUSER_SU:-mwf_user}"; SU_PW="${PGPASSWORD_SU:-mwf_password}"
HOST="${PGHOST_SU:-127.0.0.1}"; PORT="${PGPORT_SU:-5432}"
OUT="${2:-$(mktemp -d "${TMPDIR:-/tmp}/ts7-neg.XXXXXX")}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
PRISMA="$REPO/node_modules/.bin/prisma"

psql_admin() { podman exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d postgres "$@"; }
psql_on()    { local db="$1"; shift; podman exec -i "$CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U "$SU" -d "$db" "$@"; }

# name | expected text in the RAISE | doctoring SQL
CASES=(
"n1_second_live_session|live_sessions_per_relationship|INSERT INTO \"Session\" (id, \"relationshipId\", status, \"updatedAt\") VALUES ('00000000-0000-7e00-8000-00000000ffe1', '00000000-0000-7e00-8000-0000000000a1', 'ACTIVE', now());"
"n2_ai_message_with_sender|ai_message_with_sender|UPDATE \"Message\" SET \"senderId\" = '00000000-0000-7e00-8000-0000000000c1' WHERE id = '00000000-0000-7e00-8000-00000000e5c2';"
"n3_agreement_without_proposal|agreement_without_proposal|UPDATE \"Agreement\" SET \"proposalId\" = NULL WHERE id = '00000000-0000-7e00-8000-0000000a9e01';"
"n4_unknown_gate_key|unknown_gate_key|UPDATE \"StageProgress\" SET \"gatesSatisfied\" = \"gatesSatisfied\" || '{\"mysteryFlag\": true}' WHERE \"sessionId\" = '00000000-0000-7e00-8000-0000000005e1' AND stage = 4;"
"n5_consent_target_unresolved|consent_target_unresolved|UPDATE \"ConsentRecord\" SET \"targetId\" = '00000000-0000-7e00-8000-00000000dead' WHERE id = '00000000-0000-7e00-8000-000000000cc1';"
"n6_vanished_member_no_evidence|session_without_two_participants|UPDATE \"Message\" SET \"forUserId\" = NULL WHERE \"forUserId\" = (SELECT id::text FROM \"User\" WHERE email = 'b.empathy-revealed@e2e.test'); DELETE FROM \"User\" WHERE email = 'b.empathy-revealed@e2e.test';"
"n7_consent_owner|T-consent-owner|UPDATE \"ConsentRecord\" SET \"targetId\" = '00000000-0000-7e00-8000-00000000a7d1' WHERE id = '00000000-0000-7e00-8000-000000000cc5';"
"n8_closure_items|v_session_closure_items differs|UPDATE \"Stage4Closure\" SET \"individualProposalIds\" = '{}' WHERE \"sessionId\" = '00000000-0000-7e00-8000-0000000005e1';"
"n9_message_without_owner|message_without_owner|UPDATE \"Message\" SET \"forUserId\" = NULL WHERE id = '00000000-0000-7e00-8000-00000000e5c2';"
"n10_attempt_author_unrecoverable|attempt_without_author|UPDATE \"EmpathyAttempt\" SET \"sourceUserId\" = NULL WHERE id = '00000000-0000-7e00-8000-00000000a7c5';"
"n11_acceptor_unrecoverable|invitation_accepted_without_unique_acceptor|UPDATE \"Message\" SET \"forUserId\" = NULL WHERE \"forUserId\" = '00000000-0000-7e00-8000-0000000000ef'; DELETE FROM \"ReconcilerResult\" WHERE id = '00000000-0000-7e00-8000-00000000e5e5';"
"n12_need_consent_unresolved|need_consent_unresolved|UPDATE \"ConsentRecord\" SET \"targetId\" = '00000000-0000-7e00-8000-00000000beef' WHERE id = '00000000-0000-7e00-8000-000000006cc1';"
"n13_closure_unexplained_coverage|5e6:open_needs(view-only 00000000-0000-7e00-8000-0000000006e4)|UPDATE \"Stage4NeedCoverage\" SET \"coverageStatus\" = 'COVERED', \"coveringProposalIds\" = '{}' WHERE id = '00000000-0000-7e00-8000-0000000006a4'; UPDATE \"Stage4Closure\" SET \"openNeedIds\" = '{00000000-0000-7e00-8000-0000000006e3,00000000-0000-7e00-8000-0000000006e6}' WHERE id = '00000000-0000-7e00-8000-0000000c105f';"
)

OLD_TABLES_SQL="SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^[A-Z]'"
NEW_TABLES_SQL="SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^[a-z]' AND tablename <> '_prisma_migrations'"
NEW_TYPES_SQL="SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') AND t.typname ~ '^[a-z]'"
COUNTS_SQL="SELECT string_agg(format('%s=%s', relname, n_live_tup), ',' ORDER BY relname) FROM pg_stat_user_tables WHERE schemaname = 'public'"
fail=0
echo "base: $BASE ($(psql_on "$BASE" -c "$OLD_TABLES_SQL") old tables)" | tee "$OUT/negative.log"
for c in "${CASES[@]}"; do
  IFS='|' read -r name expect sql <<<"$c"
  db="ts7_neg_${name}"
  psql_admin -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db TEMPLATE $BASE" >/dev/null
  psql_on "$db" -c "$sql" >/dev/null
  # Exact per-table row counts before (pg_stat is not transactional: count for real).
  before="$(psql_on "$db" -c "SELECT string_agg(format('%s=%s', t, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t), false, true, '')))[1]::text), ',' ORDER BY t) FROM (SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations') x")"
  set +e
  ( cd "$BACKEND" && DATABASE_URL="postgresql://${SU}:${SU_PW}@${HOST}:${PORT}/${db}" "$PRISMA" migrate deploy ) >"$OUT/${name}.log" 2>&1
  rc=$?
  set -e
  after="$(psql_on "$db" -c "SELECT string_agg(format('%s=%s', t, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t), false, true, '')))[1]::text), ',' ORDER BY t) FROM (SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations') x")"
  old_n="$(psql_on "$db" -c "$OLD_TABLES_SQL")"
  new_n="$(psql_on "$db" -c "$NEW_TABLES_SQL")"
  types_n="$(psql_on "$db" -c "$NEW_TYPES_SQL")"
  schema_n="$(psql_on "$db" -c "SELECT count(*) FROM pg_namespace WHERE nspname = 'app_migration'")"
  pm="$(psql_on "$db" -c "SELECT coalesce(string_agg(format('finished_at=%s rolled_back_at=%s applied_steps=%s', coalesce(finished_at::text, 'NULL'), coalesce(rolled_back_at::text, 'NULL'), applied_steps_count), '; '), 'no row') FROM _prisma_migrations WHERE migration_name LIKE '%target_shape'")"
  raise="$(grep -m1 -o "target_shape: [^\"]*" "$OUT/${name}.log" | cut -c1-220 || true)"
  verdict=PASS
  [ "$rc" -ne 0 ] || verdict=FAIL
  grep -q -- "$expect" "$OUT/${name}.log" || verdict=FAIL
  [ "$old_n" = 68 ] && [ "$new_n" = 0 ] && [ "$types_n" = 0 ] && [ "$schema_n" = 0 ] && [ "$before" = "$after" ] || verdict=FAIL
  {
    echo
    echo "== $name: $verdict"
    echo "   doctor:   $sql"
    echo "   deploy:   exit $rc; expected '$expect' $(grep -q -- "$expect" "$OUT/${name}.log" && echo found || echo MISSING)"
    echo "   raise:    $raise"
    echo "   rollback: old tables $old_n/68, target tables $new_n, target types $types_n, app_migration schemas $schema_n, row counts unchanged: $([ "$before" = "$after" ] && echo yes || echo NO)"
    echo "   _prisma_migrations (target_shape): $pm"
  } | tee -a "$OUT/negative.log"
  [ "$verdict" = PASS ] || fail=1
  psql_admin -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null
done
echo
if [ "$fail" -ne 0 ]; then echo "NEGATIVE TESTS FAILED" | tee -a "$OUT/negative.log"; exit 1; fi
echo "NEGATIVE TESTS PASSED (${#CASES[@]} cases) — evidence in $OUT" | tee -a "$OUT/negative.log"
