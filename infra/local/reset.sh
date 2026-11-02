#!/usr/bin/env bash
# Drop the local replica's database and bring it back on a fresh baseline:
# down, remove volume mwf_local_postgres (this project's only), up.sh.
#
#   infra/local/reset.sh --yes
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[ "${1:-}" = --yes ] || die "reset deletes every row in the local replica's database; re-run with --yes"
step "reset: down, drop $DB_VOLUME, up"
if [ -f "$LOCAL/release.env" ]; then compose down --remove-orphans; fi
case "$DB_VOLUME" in mwf_local_*) ;; *) die "refusing to remove volume '$DB_VOLUME'" ;; esac
if podman volume exists "$DB_VOLUME"; then
  podman volume rm "$DB_VOLUME"
else
  echo "   $DB_VOLUME did not exist"
fi
exec "$HERE/up.sh"
