#!/usr/bin/env bash
set -euo pipefail
# Fresh-cluster initialisation (runs once, from docker-entrypoint-initdb.d).
# For an existing cluster, apply the roles with infra/aws/roles.sql, which
# says what each role is for. No mwf_* or *_access role is SUPERUSER or
# BYPASSRLS. work-k5fk.10.4 (design note §6): grants target NOLOGIN capability
# roles; each runtime login is a member of exactly one (INHERIT, no SET/ADMIN);
# mwf_definer (NOLOGIN) owns the SECURITY DEFINER functions.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" --set=readonly_password="$READONLY_DB_PASSWORD" \
  --set=migrator_password="$MIGRATOR_DB_PASSWORD" --set=job_password="$JOB_DB_PASSWORD" \
  --set=ops_password="$OPS_DB_PASSWORD" --set=auth_password="$AUTH_DB_PASSWORD" \
  --set=ai_password="$AI_DB_PASSWORD" --set=worker_password="$WORKER_DB_PASSWORD" <<'SQL'
CREATE ROLE mwf_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE ROLE mwf_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'migrator_password';
CREATE ROLE mwf_job LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'job_password';
CREATE ROLE mwf_ops LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'ops_password';
CREATE ROLE mwf_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'auth_password';
CREATE ROLE mwf_ai LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'ai_password';
CREATE ROLE mwf_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'worker_password';
-- Reserved, no password until the clinician portal exists (design note Q18).
CREATE ROLE mwf_clinician LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE app_access NOLOGIN;
CREATE ROLE ai_access NOLOGIN;
CREATE ROLE worker_access NOLOGIN;
CREATE ROLE ops_access NOLOGIN;
CREATE ROLE auth_access NOLOGIN;
CREATE ROLE clinician_access NOLOGIN;
-- INTERIM: mwf_job's grants until design note §7 row 9b retires mwf_job.
CREATE ROLE job_access NOLOGIN;
CREATE ROLE mwf_definer NOLOGIN;
GRANT app_access TO mwf_app WITH INHERIT TRUE, SET FALSE;
GRANT ai_access TO mwf_ai WITH INHERIT TRUE, SET FALSE;
GRANT worker_access TO mwf_worker WITH INHERIT TRUE, SET FALSE;
GRANT ops_access TO mwf_ops WITH INHERIT TRUE, SET FALSE;
GRANT auth_access TO mwf_auth WITH INHERIT TRUE, SET FALSE;
GRANT clinician_access TO mwf_clinician WITH INHERIT TRUE, SET FALSE;
GRANT job_access TO mwf_job WITH INHERIT TRUE, SET FALSE;
-- The target baseline hands its definer helpers to mwf_definer (ALTER FUNCTION
-- ... OWNER TO), which needs SET ROLE mwf_definer; no inheritance.
GRANT mwf_definer TO mwf_migrator WITH INHERIT FALSE, SET TRUE;
-- Migrations (run as the database owner, mwf_app, until they move to
-- mwf_migrator) make mwf_job own the SECURITY DEFINER helpers, which needs
-- SET ROLE mwf_job. No inheritance: mwf_app gains none of mwf_job's grants.
-- INTERIM EXCEPTION to security-catalogue assertion 9 ("mwf_app is a member
-- of no role"): revoke mwf_app's membership before W1a/W4a (the first grant
-- or policy that gives mwf_job more than SELECT on Session/RelationshipMember)
-- and before any RLS is forced on mwf_app (W8); coupled to moving migrations
-- to mwf_migrator. Tracked as work-a39h.11.19.
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
