#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ]
chmod 700 /opt/mwf/*.sh
# The postgres container runs its initialization as an unprivileged UID.
chmod 755 /opt/mwf/init-db.sh
cat > /etc/systemd/system/mwf-backup.service <<'UNIT'
[Unit]
Description=Meet Without Fear verified S3 database backup
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/opt/mwf/backup.sh nightly
TimeoutStartSec=30min
UMask=0077
UNIT
cat > /etc/systemd/system/mwf-backup.timer <<'UNIT'
[Unit]
Description=Nightly Meet Without Fear backup
[Timer]
OnCalendar=*-*-* 10:00:00 UTC
Persistent=true
RandomizedDelaySec=10min
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/mwf-release.service <<'UNIT'
[Unit]
Description=Apply requested Meet Without Fear release
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/opt/mwf/release-poll.sh
TimeoutStartSec=30min
UMask=0077
UNIT
cat > /etc/systemd/system/mwf-release.timer <<'UNIT'
[Unit]
Description=Check for a new CI release
[Timer]
OnBootSec=90s
OnUnitInactiveSec=60s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now mwf-backup.timer mwf-release.timer
