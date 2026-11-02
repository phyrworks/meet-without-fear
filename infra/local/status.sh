#!/usr/bin/env bash
# Show the local replica's containers, published ports, health and schema.
# Exit 0 only when db and api are healthy, caddy runs and /health answers.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
rc=0
step "containers (project $PROJECT)"
compose ps -a --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
step "health"
for s in db api caddy; do
  h="$(health_of "$s")"
  echo "   $s: $h"
  case "$h" in healthy | running) ;; *) rc=1 ;; esac
done
if curl --fail --silent --max-time 5 "$ORIGIN/health" >/dev/null; then
  echo "   $ORIGIN/health: ok"
else
  echo "   $ORIGIN/health: FAILED"
  rc=1
fi
if [ "$(health_of db)" = healthy ]; then
  step "schema"
  psql_db -Atc "SELECT '   _prisma_migrations: ' || coalesce(string_agg(migration_name || CASE WHEN finished_at IS NULL THEN ' (UNFINISHED)' ELSE '' END, ', '), 'none') FROM _prisma_migrations" 2>/dev/null \
    || echo "   no _prisma_migrations table"
  psql_db -Atc "SELECT '   database owner: ' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'mwf'"
fi
exit $rc
