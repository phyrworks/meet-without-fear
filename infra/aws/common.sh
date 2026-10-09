#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/mwf
set -a
# Root-owned shell configuration contains non-secret bucket/image identifiers.
# shellcheck source=/dev/null
source /etc/mwf/operations.env
set +a
compose() { docker compose --env-file /etc/mwf/release.env -f /opt/mwf/compose.yaml "$@"; }
dbsql() { compose exec -T db psql -X -U postgres -d "${1:-mwf}" -v ON_ERROR_STOP=1; }
