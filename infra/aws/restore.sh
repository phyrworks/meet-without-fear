#!/usr/bin/env bash
# The operator downloads the S3 artifact using their own read credentials.
#
#   restore.sh /absolute/database.dump target_database [replace-production]
#
# Two archive shapes (work-k5fk.10.6 review F2):
#   * the target shape (schema app in the archive): restored AS IT WAS — owners (mwf_migrator for the
#     schema objects, mwf_definer for the definer functions), every grant to the capability roles, the
#     row-level policies and FORCE — by the superuser, with the data loaded triggers off (the rows were
#     valid when dumped; t_message_seq and friends must not renumber them). The database is created
#     OWNED BY mwf_migrator and ownership.sql then gives it its ACL (CONNECT for the capabilities only)
#     and pgaudit. The roles must already exist on this cluster (roles.sql / init-db.sh): a missing
#     one stops the restore before anything is dropped. An archive with no ACL entries (backup.sh
#     before this change dumped --no-acl) cannot carry the grants and is refused.
#   * the old shape (no schema app; Render-era and pre-cutover dumps): restored as before, owned by
#     mwf_app, objects created by mwf_app, no ACLs from the archive.
# MWF_DIR (default /opt/mwf) is where common.sh, verify.sql and ownership.sql live (a rehearsal points it
# at a copy).
set -euo pipefail
dir="${MWF_DIR:-/opt/mwf}"
# shellcheck source=/dev/null
source "$dir/common.sh"
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
toc_all=$(mktemp)
toc=$(mktemp)
trap 'rm -f "$toc" "$toc_all"' EXIT
compose exec -T db pg_restore --list < "$archive" > "$toc_all"
# Render owns its standard extensions, and so does the target cluster's superuser (vector here, pgaudit
# by ownership.sql): extension entries are never replayed from the archive.
sed '/ EXTENSION /d; / COMMENT - EXTENSION /d' "$toc_all" > "$toc"
if grep -Eq '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - app ' "$toc_all"; then shape=target; else shape=old; fi
roles_query() {  # $1 = comma-separated quoted role names; prints the missing ones
  printf "SELECT string_agg(r, ', ') FROM unnest(ARRAY[%s]) r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);\n" "$1" \
    | compose exec -T db psql -X -U postgres -d postgres -At
}
# Check prerequisite roles (and, for the target shape, that the archive carries its grants) before any
# destructive database operation.
if [ "$shape" = target ]; then
  missing=$(roles_query "'mwf_migrator','mwf_definer','app_access','ai_access','worker_access','ops_access','auth_access','clinician_access','diag_access','mwf_app','mwf_ai','mwf_worker','mwf_ops','mwf_auth','mwf_clinician','slam_bot_readonly'")
  [ -z "$missing" ] || { echo "Initialize the database roles first (infra/aws/roles.sql): missing $missing" >&2; exit 1; }
  grep -Eq ' ACL ' "$toc_all" || { echo 'This target-shape archive has no ACL entries (dumped with --no-acl): its grants cannot be restored. Use a backup.sh dump made since work-k5fk.10.6.' >&2; exit 1; }
else
  missing=$(roles_query "'mwf_app','slam_bot_readonly'")
  [ -z "$missing" ] || { echo "Initialize required database roles first: missing $missing" >&2; exit 1; }
fi
start=$(date +%s)
compose cp "$toc" db:/tmp/mwf-restore.list
if [ "$shape" = target ]; then
  printf 'DROP DATABASE IF EXISTS "%s" WITH (FORCE);\nCREATE DATABASE "%s" OWNER mwf_migrator;\n' "$target" "$target" | dbsql postgres
  printf 'CREATE EXTENSION IF NOT EXISTS vector;\n' | dbsql "$target"
  # As the superuser, keeping the archive's owners and ACLs (no --no-owner / --no-acl / --role).
  compose exec -T db pg_restore -U postgres -d "$target" --exit-on-error --disable-triggers \
    --use-list=/tmp/mwf-restore.list < "$archive"
  # The database itself (owner set above): its ACL, the bot's old grants withdrawn, pgaudit.
  compose exec -T db psql -X -U postgres -d "$target" -v ON_ERROR_STOP=1 < "$dir/ownership.sql"
else
  printf 'DROP DATABASE IF EXISTS "%s" WITH (FORCE);\nCREATE DATABASE "%s" OWNER mwf_app;\n' "$target" "$target" | dbsql postgres
  printf 'CREATE EXTENSION IF NOT EXISTS vector;\n' | dbsql "$target"
  # Restore data/schema as the app owner, leaving extension administration with postgres.
  compose exec -T db pg_restore -U postgres -d "$target" --role=mwf_app --no-owner --no-acl --exit-on-error --use-list=/tmp/mwf-restore.list < "$archive"
  printf 'GRANT CONNECT ON DATABASE "%s" TO slam_bot_readonly;\nGRANT USAGE ON SCHEMA public TO slam_bot_readonly;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO slam_bot_readonly;\nALTER DEFAULT PRIVILEGES FOR ROLE mwf_app IN SCHEMA public GRANT SELECT ON TABLES TO slam_bot_readonly;\n' "$target" | dbsql "$target"
fi
compose exec -T db psql -X -U postgres -d "$target" -v ON_ERROR_STOP=1 < "$dir/verify.sql"
printf 'Restore (%s shape) completed in %s seconds into %s\n' "$shape" "$(( $(date +%s) - start ))" "$target"
