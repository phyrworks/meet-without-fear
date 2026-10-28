#!/usr/bin/env bash
# Smoke the running local replica (docs/deployment/local-replica.md):
# infra/local/smoke.cjs through the origin, then field encryption at rest
# (the smoke message is NOT stored as plaintext), then E2E cleanup.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need_node20
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
step "smoke.cjs against $ORIGIN"
NODE_PATH="$REPO/node_modules" MWF_LOCAL_ORIGIN="$ORIGIN" node "$HERE/smoke.cjs" | tee "$out" | sed 's/^/   /'
[ "${PIPESTATUS[0]}" = 0 ] || die "smoke.cjs failed"
marker="$(tail -1 "$out" | sed -n 's/.*"marker":"\([^"]*\)".*/\1/p')"
[ -n "$marker" ] || die "no marker from smoke.cjs"

step "encryption at rest"
plain="$(psql_db -Atc "SELECT count(*) FROM message WHERE content LIKE '%$marker%'")"
total="$(psql_db -Atc "SELECT count(*) FROM message")"
echo "   message rows: $total; rows holding the smoke text in plaintext: $plain"
[ "$plain" = 0 ] || die "the smoke message is stored in plaintext (FIELD_ENCRYPTION_KEY not applied?)"

step "cleanup (POST /api/e2e/cleanup)"
curl --fail --silent --show-error -X POST "$ORIGIN/api/e2e/cleanup" | sed 's/^/   /'
echo
echo "SMOKE PASSED"
