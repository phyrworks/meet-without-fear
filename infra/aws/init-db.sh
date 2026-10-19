#!/usr/bin/env bash
set -euo pipefail
# Fresh-cluster initialisation (runs once, from docker-entrypoint-initdb.d).
# For an existing cluster, apply the Phase 3 roles with infra/aws/roles.sql.
# mwf_migrator, mwf_job, mwf_ops and mwf_auth are the Phase 3 W1 roles; see
# roles.sql for what each is for. No mwf_* role is SUPERUSER or BYPASSRLS.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" --set=readonly_password="$READONLY_DB_PASSWORD" \
  --set=migrator_password="$MIGRATOR_DB_PASSWORD" --set=job_password="$JOB_DB_PASSWORD" \
  --set=ops_password="$OPS_DB_PASSWORD" --set=auth_password="$AUTH_DB_PASSWORD" <<'SQL'
CREATE ROLE mwf_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE ROLE mwf_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'migrator_password';
CREATE ROLE mwf_job LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'job_password';
CREATE ROLE mwf_ops LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'ops_password';
CREATE ROLE mwf_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'auth_password';
-- Migrations (run as the database owner, mwf_app, until W10 moves them to
-- mwf_migrator) make mwf_job own the SECURITY DEFINER helpers, which needs
-- SET ROLE mwf_job. No inheritance: mwf_app gains none of mwf_job's grants.
GRANT mwf_job TO mwf_app WITH INHERIT FALSE, SET TRUE;
GRANT mwf_job TO mwf_migrator WITH INHERIT FALSE, SET TRUE;
CREATE ROLE slam_bot_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'readonly_password';
ALTER DATABASE mwf OWNER TO mwf_app;
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO mwf_app;
GRANT CONNECT ON DATABASE mwf TO slam_bot_readonly;
GRANT USAGE ON SCHEMA public TO slam_bot_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE mwf_app IN SCHEMA public GRANT SELECT ON TABLES TO slam_bot_readonly;
SQL
