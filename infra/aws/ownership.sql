-- Ownership, the database's ACL and pgaudit for the application database (design note §6 layers
-- 1–2 and "Authentication per environment", owner decisions Q8 and Q17; §7 row 9c, work-k5fk.10.6).
-- Idempotent; run as a superuser IN the application database, after the roles exist:
--   * a fresh cluster: docker-entrypoint-initdb.d runs it after init-db.sh (compose.yaml mounts it
--     as 20-mwf-ownership.sql);
--   * an existing cluster: once, at the cutover, with the API stopped (README "Cutover to the
--     target shape"), after infra/aws/roles.sql:
--       psql -X -v ON_ERROR_STOP=1 -U postgres -d mwf -f /opt/mwf/ownership.sql
--     Re-running it later changes nothing.
--
-- What it makes true:
--   1. mwf_migrator owns the database, schema public and every object a runtime login or capability
--      owned here (REASSIGN OWNED — on the old shape the API's mwf_app owned all of it); migrations
--      then run as mwf_migrator (deploy.sh) and create everything as it. mwf_definer keeps the
--      definer functions. No runtime login owns anything (the role guard and step 20 refuse it).
--   2. Nobody may create in schema public but its owner.
--   3. PUBLIC may not connect or create temporary objects; the active capabilities may connect (their
--      logins inherit it). The baseline migration asserts the same (trailer T7a, step 20).
--      slam_bot_readonly, when it exists, keeps its own CONNECT and SELECT on what mwf_migrator creates.
--   4. pgaudit (shared_preload_libraries in compose.yaml) logs every statement of mwf_migrator, of the
--      superuser running this script (the admin) and of mwf_clinician; nothing for the runtime logins.
\set ON_ERROR_STOP on

DO $$
DECLARE
  missing text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'ownership.sql: run it as a superuser (it reassigns ownership and alters roles)';
  END IF;
  SELECT string_agg(r, ', ' ORDER BY r) INTO missing
  FROM unnest(ARRAY['mwf_migrator', 'mwf_definer', 'mwf_app', 'mwf_ai', 'mwf_worker', 'mwf_ops', 'mwf_auth',
                    'mwf_clinician', 'app_access', 'ai_access', 'worker_access', 'ops_access', 'auth_access',
                    'clinician_access']) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ownership.sql: role(s) % do not exist: apply infra/aws/roles.sql (or init-db.sh) first', missing;
  END IF;
  IF current_database() IN ('postgres', 'template0', 'template1') THEN
    RAISE EXCEPTION 'ownership.sql: run it in the application database, not %', current_database();
  END IF;
END
$$;

-- 1. Ownership. REASSIGN OWNED moves what these roles own in THIS database, and any database they own.
SELECT format('REASSIGN OWNED BY %s TO mwf_migrator',
              string_agg(quote_ident(rolname), ', ' ORDER BY rolname))
FROM pg_catalog.pg_roles
WHERE rolname IN ('mwf_app', 'mwf_ai', 'mwf_worker', 'mwf_ops', 'mwf_auth', 'mwf_clinician',
                  'app_access', 'ai_access', 'worker_access', 'ops_access', 'auth_access', 'clinician_access')
\gexec
SELECT format('ALTER DATABASE %I OWNER TO mwf_migrator', current_database())
WHERE (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = current_database())
      <> 'mwf_migrator'
\gexec
ALTER SCHEMA public OWNER TO mwf_migrator;

-- 2. Only the owner creates in public (PostgreSQL 15+ default, re-asserted).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 3. Who may connect.
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO app_access, ai_access, worker_access, ops_access, auth_access',
              current_database()) \gexec
SELECT count(*) = 1 AS has_bot FROM pg_catalog.pg_roles WHERE rolname = 'slam_bot_readonly' \gset
\if :has_bot
SELECT format('GRANT CONNECT ON DATABASE %I TO slam_bot_readonly', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO slam_bot_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE mwf_migrator IN SCHEMA public GRANT SELECT ON TABLES TO slam_bot_readonly;
-- The old shape's default (init-db.sh before work-k5fk.10.6): mwf_app creates nothing any more.
ALTER DEFAULT PRIVILEGES FOR ROLE mwf_app IN SCHEMA public REVOKE SELECT ON TABLES FROM slam_bot_readonly;
\endif

-- 4. pgaudit, in its own schema (it is relocatable; its two SECURITY DEFINER event-trigger functions
-- must not land in public, where step 20 requires every definer function to be mwf_definer's).
SELECT count(*) = 1 AS pgaudit_loaded
FROM pg_catalog.pg_settings WHERE name = 'shared_preload_libraries' AND setting ~ '(^|[ ,])pgaudit([ ,]|$)' \gset
\if :pgaudit_loaded
\else
DO $$ BEGIN RAISE EXCEPTION 'ownership.sql: pgaudit is not in shared_preload_libraries (compose.yaml db command; image from build-db-image.sh)'; END $$;
\endif
CREATE SCHEMA IF NOT EXISTS pgaudit;
REVOKE ALL ON SCHEMA pgaudit FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgaudit SCHEMA pgaudit;
ALTER ROLE mwf_migrator SET pgaudit.log = 'all';
ALTER ROLE mwf_clinician SET pgaudit.log = 'all';
SELECT format('ALTER ROLE %I SET pgaudit.log = %L', current_user, 'all') \gexec
COMMENT ON SCHEMA pgaudit IS 'pgaudit''s event-trigger functions (ownership.sql, work-k5fk.10.6). Not the application''s.';
