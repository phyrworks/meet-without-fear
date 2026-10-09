#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source /opt/mwf/common.sh
[ ! -f /etc/mwf/deploy-paused ] || exit 0
exec 7>/var/lib/mwf/release-poll.lock
flock -n 7 || exit 0
export AWS_SHARED_CREDENTIALS_FILE=/etc/mwf/release.credentials
work=$(mktemp -d /var/lib/mwf/release.XXXXXX)
trap 'rm -rf "$work"' EXIT
aws s3 cp "s3://$BACKUP_BUCKET/releases/control/desired.json" "$work/manifest.json" --only-show-errors
if [ -f /var/lib/mwf/current-release.json ] && cmp -s "$work/manifest.json" /var/lib/mwf/current-release.json; then exit 0; fi
id=$(jq -er '.id | select(test("^[a-zA-Z0-9_.-]{1,100}$"))' "$work/manifest.json")
image=$(jq -er '.image | select(test("^mwf-api:[a-zA-Z0-9_.-]+$"))' "$work/manifest.json")
key=$(jq -er '.key | select(test("^releases/artifacts/[a-zA-Z0-9_.-]+/image.tar.gz$"))' "$work/manifest.json")
checksum=$(jq -er '.sha256 | select(test("^[a-f0-9]{64}$"))' "$work/manifest.json")
# A failed release is attempted once. A new unique ID explicitly retries it.
[ "$(cat /var/lib/mwf/last-attempt 2>/dev/null || true)" != "$id" ] || exit 0
printf '%s\n' "$id" > /var/lib/mwf/last-attempt
report() {
  jq -n --arg id "$id" --arg status "$1" --arg time "$(date -u +%FT%TZ)" '{id:$id,status:$status,time:$time}' > "$work/status.json"
  aws s3 cp "$work/status.json" "s3://$BACKUP_BUCKET/releases/status/$id.json" --only-show-errors
}
trap 'report failed || true; rm -rf "$work"' ERR
aws s3 cp "s3://$BACKUP_BUCKET/$key" "$work/image.tar.gz" --only-show-errors
printf '%s  %s\n' "$checksum" "$work/image.tar.gz" | sha256sum -c -
gzip -dc "$work/image.tar.gz" | docker load
docker image inspect "$image" >/dev/null
runtime_checksum=$(jq -er '.runtimeSha256 | select(test("^[a-f0-9]{64}$"))' "$work/manifest.json")
aws s3 cp "s3://$BACKUP_BUCKET/releases/artifacts/$id/runtime.tar.gz" "$work/runtime.tar.gz" --only-show-errors
printf '%s  %s\n' "$runtime_checksum" "$work/runtime.tar.gz" | sha256sum -c -
mkdir "$work/runtime"
# Only the fixed, reviewed runtime file set can be installed; no archive paths escape it.
expected='Caddyfile compose.yaml common.sh init-db.sh backup.sh restore.sh verify.sql fingerprint.sql deploy.sh release-poll.sh install-services.sh ops-health.sh'
for file in $expected; do
  tar -xOf "$work/runtime.tar.gz" "$file" > "$work/runtime/$file"
done
for file in $expected; do
  install -m 700 "$work/runtime/$file" "/opt/mwf/$file.next"
  mv "/opt/mwf/$file.next" "/opt/mwf/$file"
done
chmod 755 /opt/mwf/init-db.sh
/opt/mwf/install-services.sh
/opt/mwf/deploy.sh "$image" "$work/manifest.json"
report healthy
