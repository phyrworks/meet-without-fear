#!/usr/bin/env bash
set -euo pipefail
# Fresh-cluster initialisation (runs once, from docker-entrypoint-initdb.d).
# For an existing cluster, apply the roles with infra/aws/roles.sql, which
# says what each role is for. No mwf_* or *_access role is SUPERUSER or
# BYPASSRLS. work-k5fk.10.4 (design note §6): grants target NOLOGIN capability
# roles; each runtime login is a member of exactly one (INHERIT, no SET/ADMIN);
# mwf_definer (NOLOGIN) owns the SECURITY DEFINER functions. ownership.sql (20-mwf-ownership.sql,
# after this) makes mwf_migrator the owner of the database and schema public (work-k5fk.10.6).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" --set=readonly_password="$READONLY_DB_PASSWORD" \
  --set=migrator_password="$MIGRATOR_DB_PASSWORD" --set=ai_password="$AI_DB_PASSWORD" \
  --set=worker_password="$WORKER_DB_PASSWORD" \
  --set=ops_password="$OPS_DB_PASSWORD" --set=auth_password="$AUTH_DB_PASSWORD" <<'SQL'
CREATE ROLE mwf_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE ROLE mwf_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'migrator_password';
CREATE ROLE mwf_ai LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'ai_password';
CREATE ROLE mwf_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'worker_password';
CREATE ROLE mwf_ops LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'ops_password';
CREATE ROLE mwf_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'auth_password';
-- Reserved login (roles.sql): NOLOGIN, no password, until the clinician portal (Q18) uses it.
-- mwf_job is retired (work-k5fk.10.5): a fresh cluster never has it.
CREATE ROLE mwf_clinician NOLOGIN;
CREATE ROLE app_access NOLOGIN;
CREATE ROLE ai_access NOLOGIN;
CREATE ROLE worker_access NOLOGIN;
CREATE ROLE ops_access NOLOGIN;
CREATE ROLE auth_access NOLOGIN;
CREATE ROLE clinician_access NOLOGIN;
CREATE ROLE mwf_definer NOLOGIN;
GRANT app_access TO mwf_app WITH INHERIT TRUE, SET FALSE;
GRANT ai_access TO mwf_ai WITH INHERIT TRUE, SET FALSE;
GRANT worker_access TO mwf_worker WITH INHERIT TRUE, SET FALSE;
GRANT ops_access TO mwf_ops WITH INHERIT TRUE, SET FALSE;
GRANT auth_access TO mwf_auth WITH INHERIT TRUE, SET FALSE;
GRANT clinician_access TO mwf_clinician WITH INHERIT TRUE, SET FALSE;
-- The target baseline hands its definer helpers to mwf_definer (ALTER FUNCTION
-- ... OWNER TO), which needs SET ROLE mwf_definer; no inheritance.
GRANT mwf_definer TO mwf_migrator WITH INHERIT FALSE, SET TRUE;
CREATE ROLE slam_bot_readonly LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'readonly_password';
CREATE EXTENSION IF NOT EXISTS vector;
-- Ownership (mwf_migrator owns the database and schema public; work-k5fk.10.6, design note §6 layer 1),
-- the database's ACL (CONNECT for the capabilities and slam_bot_readonly only) and pgaudit: ownership.sql,
-- which the entrypoint runs next (20-mwf-ownership.sql) and an existing cluster runs at the cutover.
SQL
