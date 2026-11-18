#!/usr/bin/env bash
# The operator downloads the S3 artifact using their own read credentials.
#
#   restore.sh /absolute/database.dump target_database [replace-production]
#
# Two archive shapes (work-k5fk.10.6 review F2; told apart by app.json_schema vs public."User", r2):
#   * the target shape: restored AS IT WAS — owners (mwf_migrator for the
#     schema objects, mwf_definer for the definer functions), every grant to the capability roles, the
#     row-level policies and FORCE — by the superuser, with the data loaded triggers off (the rows were
#     valid when dumped; t_message_seq and friends must not renumber them). The database is created
#     OWNED BY mwf_migrator and ownership.sql then gives it its ACL (CONNECT for the capabilities only)
#     and pgaudit. The roles must already exist on this cluster (roles.sql / init-db.sh): a missing
#     one stops the restore before anything is dropped. An archive with no ACL entries (backup.sh
#     before this change dumped --no-acl) cannot carry the grants and is refused.
#   * the old shape (Render-era and pre-cutover dumps, either backup.sh's flags): restored as before, owned by
#     mwf_app, objects created by mwf_app; the archive's grants replayed when it has them (backup.sh since
#     work-k5fk.10.6), after checking that every role they name exists.
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
# The shape, from an object only one of them has (review 9c r2: both have a schema app — the old history's
# phase3_app_schema_helpers created it): the target shape's app.json_schema table vs the old shape's "User".
# Neither or both: refuse, nothing changed.
has_target=0; has_old=0
grep -Eq '^[0-9]+; [0-9]+ [0-9]+ TABLE app json_schema ' "$toc_all" && has_target=1
grep -Eq '^[0-9]+; [0-9]+ [0-9]+ TABLE public User ' "$toc_all" && has_old=1
case "$has_target$has_old" in
  10) shape=target ;;
  01) shape=old ;;
  *) echo "Cannot tell the archive's shape (app.json_schema: $has_target, public.\"User\": $has_old): refusing, nothing changed." >&2; exit 1 ;;
esac
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
  # An old-shape archive from backup.sh since work-k5fk.10.6 carries its grants (mwf_job's, mwf_ops',
  # mwf_auth's): replay them, so the old release's roles work as they did. Every role they name must exist
  # first (the old cluster's roles.sql), or nothing is dropped. An archive without ACLs (--no-acl, the old
  # backup.sh and Render) restores as it always did, owner-only.
  old_acl=--no-acl
  if grep -Eq ' ACL ' "$toc_all"; then
    old_acl=
    grep -E ' ACL ' "$toc_all" > "$toc.acl"
    compose cp "$toc.acl" db:/tmp/mwf-restore-acl.list
    grantees=$(compose exec -T db pg_restore --use-list=/tmp/mwf-restore-acl.list -f - < "$archive" \
      | sed -nE 's/^(GRANT|REVOKE) .* (TO|FROM) ([^;]+);$/\3/p' | tr ',' '\n' | sed 's/^ *//; s/ WITH GRANT OPTION$//; s/"//g' \
      | grep -vx 'PUBLIC' | sort -u | sed "s/.*/'&'/" | paste -sd, -)
    rm -f "$toc.acl"
    if [ -n "$grantees" ]; then
      missing=$(roles_query "$grantees")
      [ -z "$missing" ] || { echo "The archive grants to role(s) this cluster lacks: $missing (apply the old shape's roles.sql first, or restore an archive dumped --no-acl): nothing changed." >&2; exit 1; }
    fi
  fi
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
  compose exec -T db pg_restore -U postgres -d "$target" --role=mwf_app --no-owner $old_acl --exit-on-error --use-list=/tmp/mwf-restore.list < "$archive"
  printf 'GRANT CONNECT ON DATABASE "%s" TO slam_bot_readonly;\nGRANT USAGE ON SCHEMA public TO slam_bot_readonly;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO slam_bot_readonly;\nALTER DEFAULT PRIVILEGES FOR ROLE mwf_app IN SCHEMA public GRANT SELECT ON TABLES TO slam_bot_readonly;\n' "$target" | dbsql "$target"
fi
compose exec -T db psql -X -U postgres -d "$target" -v ON_ERROR_STOP=1 < "$dir/verify.sql"
printf 'Restore (%s shape) completed in %s seconds into %s\n' "$shape" "$(( $(date +%s) - start ))" "$target"
