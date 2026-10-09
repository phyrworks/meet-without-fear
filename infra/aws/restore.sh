#!/usr/bin/env bash
# The operator downloads the S3 artifact using their own read credentials.
set -euo pipefail
# shellcheck source=/dev/null
source /opt/mwf/common.sh
archive=${1:?Usage: restore.sh /absolute/database.dump target_database [replace-production]}
target=${2:?Explicit target database required}
[[ "$archive" = /* && "$target" =~ ^[a-z][a-z0-9_]{0,40}$ ]] || exit 2
[ -f "$archive" ] || exit 2
if [ "$target" = mwf ]; then
  [ "${3:-}" = replace-production ] || { echo 'Production replacement requires replace-production argument' >&2; exit 2; }
  [ -z "$(compose ps --status running -q api)" ] || { echo 'Stop API before production restore' >&2; exit 2; }
else
  [[ "$target" == restore_* ]] || { echo 'Disposable targets must start restore_' >&2; exit 2; }
fi
(cd "$(dirname "$archive")" && sha256sum -c SHA256SUMS)
compose exec -T db pg_restore --list < "$archive" >/dev/null
# Check prerequisite roles before any destructive database operation.
[ "$(printf "SELECT count(*) FROM pg_roles WHERE rolname IN ('mwf_app','slam_bot_readonly');\n" | compose exec -T db psql -X -U postgres -d postgres -At)" = 2 ] || { echo 'Initialize required database roles first' >&2; exit 1; }
start=$(date +%s)
printf 'DROP DATABASE IF EXISTS "%s" WITH (FORCE);\nCREATE DATABASE "%s" OWNER mwf_app;\n' "$target" "$target" | dbsql postgres
printf 'CREATE EXTENSION IF NOT EXISTS vector;\n' | dbsql "$target"
# Render owns its standard extensions. Restore data/schema as the app owner,
# leaving extension administration with postgres.
toc=$(mktemp)
trap 'rm -f "$toc"' EXIT
compose exec -T db pg_restore --list < "$archive" | sed '/ EXTENSION /d; / COMMENT - EXTENSION /d' > "$toc"
compose cp "$toc" db:/tmp/mwf-restore.list
compose exec -T db pg_restore -U postgres -d "$target" --role=mwf_app --no-owner --no-acl --exit-on-error --use-list=/tmp/mwf-restore.list < "$archive"
printf 'GRANT CONNECT ON DATABASE "%s" TO slam_bot_readonly;\nGRANT USAGE ON SCHEMA public TO slam_bot_readonly;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO slam_bot_readonly;\nALTER DEFAULT PRIVILEGES FOR ROLE mwf_app IN SCHEMA public GRANT SELECT ON TABLES TO slam_bot_readonly;\n' "$target" | dbsql "$target"
compose exec -T db psql -X -U postgres -d "$target" -v ON_ERROR_STOP=1 < /opt/mwf/verify.sql
printf 'Restore completed in %s seconds into %s\n' "$(( $(date +%s) - start ))" "$target"
