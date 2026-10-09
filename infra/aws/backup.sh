#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source /opt/mwf/common.sh
kind=${1:-nightly}
case "$kind" in nightly|preserved) ;; *) echo 'Expected nightly or preserved' >&2; exit 2;; esac
exec 8>/var/lib/mwf/backup.lock
flock -n 8 || { echo 'Backup already running' >&2; exit 1; }
work=$(mktemp -d /var/lib/mwf/backup.XXXXXX)
trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)
compose exec -T db pg_dump -U postgres -d mwf --format=custom --no-owner --no-acl > "$work/database.dump"
compose exec -T db pg_restore --list < "$work/database.dump" > /dev/null
(cd "$work" && sha256sum database.dump > SHA256SUMS)
version=$(printf 'SHOW server_version;\n' | dbsql | sed -n '3p' | xargs)
release=$(cat /var/lib/mwf/current-release.json 2>/dev/null || echo '{}')
migrations=$(printf 'SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name;\n' | dbsql)
jq -n --arg timestamp "$stamp" --arg version "$version" --arg migrations "$migrations" --argjson release "$release" '{timestamp:$timestamp,postgres:$version,migrations:$migrations,release:$release}' > "$work/metadata.json"
export AWS_SHARED_CREDENTIALS_FILE=/etc/mwf/backup.credentials
key="$kind/$stamp"
for file in database.dump SHA256SUMS metadata.json; do
  aws s3 cp "$work/$file" "s3://$BACKUP_BUCKET/$key/$file" --only-show-errors
 done
# Success is recorded only after every object reaches S3.
printf '%s %s\n' "$(date -u +%s)" "$key" > /var/lib/mwf/backup-last-success.tmp
mv /var/lib/mwf/backup-last-success.tmp /var/lib/mwf/backup-last-success
printf '%s\n' "$key"
