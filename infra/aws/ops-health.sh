#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source /opt/mwf/common.sh
compose ps
compose exec -T api node /app/infra/aws/healthcheck.cjs
last=$(awk '{print $1}' /var/lib/mwf/backup-last-success)
[ "$(( $(date +%s) - last ))" -lt 93600 ] || { echo 'Backup is older than 26 hours' >&2; exit 1; }
systemctl is-active mwf-backup.timer mwf-release.timer
df -h /
free -m
docker stats --no-stream
