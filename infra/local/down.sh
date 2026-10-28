#!/usr/bin/env bash
# Stop and remove the local replica's containers and networks. Keeps the
# database volume (mwf_local_postgres); infra/local/reset.sh drops it.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
step "down: project $PROJECT (volumes kept)"
compose down --remove-orphans
