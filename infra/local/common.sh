# Shared by infra/local/*.sh (sourced, not executed). Local replica only.
# shellcheck shell=bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LOCAL="$HERE/.local"            # git-ignored: env files, build context, web export
PROJECT=mwf-local               # compose project; never "mwf" (production)
MWF_LOCAL_PORT="${MWF_LOCAL_PORT:-18180}"
MWF_LOCAL_DB_PORT="${MWF_LOCAL_DB_PORT:-15433}"
ORIGIN="http://127.0.0.1:${MWF_LOCAL_PORT}"
DB_VOLUME=mwf_local_postgres

step() { printf '\n== %s\n' "$*"; }
die()  { echo "error: $*" >&2; exit 1; }

compose() {
  [ -f "$LOCAL/release.env" ] || die "$LOCAL/release.env missing: run infra/local/up.sh"
  podman compose --ansi never --env-file "$LOCAL/release.env" -f "$HERE/compose.yaml" -p "$PROJECT" "$@" 2> >(grep -v '^>>>\|Executing external compose provider\|^$' >&2)
}

# Container id of a service, empty when it does not exist.
service_id() { compose ps -a -q "$1" 2>/dev/null | head -1; }

health_of() {  # $1 = service
  local id; id="$(service_id "$1")"
  [ -n "$id" ] || { echo missing; return; }
  podman inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"
}

wait_healthy() {  # $1 = service, $2 = attempts (3 s apart)
  local s
  for _ in $(seq 1 "${2:-40}"); do
    s="$(health_of "$1")"
    [ "$s" = healthy ] && return 0
    sleep 3
  done
  echo "$1 is $s" >&2
  return 1
}

psql_db() { compose exec -T db psql -X -v ON_ERROR_STOP=1 -U postgres -d mwf "$@"; }

need_node20() {
  local fnm="$HOME/.local/share/fnm/node-versions/v20.20.2/installation/bin"
  if ! node -v 2>/dev/null | grep -q '^v20\.'; then
    [ -x "$fnm/node" ] && export PATH="$fnm:$PATH"
  fi
  node -v 2>/dev/null | grep -q '^v20\.' || die "Node 20 is required (repo engines: 20.x)"
}
