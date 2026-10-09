#!/usr/bin/env bash
# The AWS DB role is provisioned with init-db.sh and reached through a restricted
# SSH tunnel. Credentials are delivered separately; never fetch an admin Render URL.
set -euo pipefail
ssh slam-bot 'sudo systemctl restart mwf-db-tunnel.service && sudo systemctl is-active mwf-db-tunnel.service'
echo 'Readonly tunnel restarted. Configure READONLY_DATABASE_URL securely from the AWS runbook.'
