-- Phase 3 W1 database roles for an EXISTING cluster (idempotent; safe to re-run).
--
-- Roles are cluster-level, so they are created here and never inside a Prisma
-- migration: a CREATE ROLE in a migration breaks the shadow database and every
-- second database in the cluster, and passwords never belong in migrations.
-- A fresh production cluster gets the same roles from init-db.sh.
--
-- Run as a superuser (or a CREATEROLE role) against the application database:
--
--   psql -v ON_ERROR_STOP=1 -d <db> \
--     -v migrator_password=... -v app_password=... -v job_password=... \
--     -v ops_password=... -v auth_password=... \
--     -f infra/aws/roles.sql
--
-- Passwords are applied only when a role is CREATED; an existing role keeps
-- its password (so re-running never rotates mwf_app's production password).
-- Attributes are re-asserted on every run: no mwf_* role is ever SUPERUSER or
-- BYPASSRLS (Phase 3 D0, Branch A). psql does not substitute :'vars' inside a
-- DO body, so the "IF NOT EXISTS" checks are written as SELECT ... \gexec.
--
-- What the roles are for (docs/backend/data-model/phase3-design-summary.md §1):
--   mwf_migrator  owner, runs migrations (not yet used: migrations still run
--                 as the database owner -- mwf_app in production)
--   mwf_app       HTTP requests; the RLS subject
--   mwf_job       background jobs; owner of the SECURITY DEFINER app.* helpers
--   mwf_ops       /api/brain/* (SELECT only; grants come with W10)
--   mwf_auth      first-login user creation only (grants come with W10)
-- Per-database grants (schema app, function EXECUTE, mwf_job's SELECTs) live
-- in the Prisma migration that creates the app.* objects, not here.

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', r.name, r.password)
FROM (VALUES
  ('mwf_migrator', :'migrator_password'),
  ('mwf_app',      :'app_password'),
  ('mwf_job',      :'job_password'),
  ('mwf_ops',      :'ops_password'),
  ('mwf_auth',     :'auth_password')
) AS r(name, password)
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.name)
\gexec

SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION', r.name)
FROM (VALUES ('mwf_migrator'), ('mwf_app'), ('mwf_job'), ('mwf_ops'), ('mwf_auth')) AS r(name)
\gexec

-- The migration that creates the definer helpers runs ALTER FUNCTION ... OWNER
-- TO mwf_job, which (PG16+) requires the migrating role to be able to SET ROLE
-- mwf_job. Grant that, without inheritance, to mwf_migrator and to this
-- database's owner when the owner is not a superuser (production: mwf_app,
-- which runs migrations today). While mwf_app owns every table this widens
-- nothing -- mwf_job holds strictly less than the owner. Revoke it from
-- mwf_app when migrations move to mwf_migrator (W10).
SELECT format('GRANT mwf_job TO %I WITH INHERIT FALSE, SET TRUE', g.grantee)
FROM (
  SELECT 'mwf_migrator'::name AS grantee
  UNION
  SELECT r.rolname
  FROM pg_catalog.pg_database d
  JOIN pg_catalog.pg_roles r ON r.oid = d.datdba
  WHERE d.datname = pg_catalog.current_database() AND NOT r.rolsuper AND r.rolname <> 'mwf_job'
) AS g
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_auth_members m
  WHERE m.roleid = 'mwf_job'::regrole AND m.member = g.grantee::regrole
)
\gexec
