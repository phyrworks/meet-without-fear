-- Database roles for an EXISTING cluster (idempotent; safe to re-run).
--
-- Roles are cluster-level, so they are created here and never inside a Prisma
-- migration: a CREATE ROLE in a migration breaks the shadow database and every
-- second database in the cluster, and passwords never belong in migrations.
-- A fresh production cluster gets the same roles from init-db.sh.
--
-- Run as a superuser (ALTER ROLE ... NOSUPERUSER NOBYPASSRLS requires one)
-- against the application database:
--
--   psql -v ON_ERROR_STOP=1 -d <db> \
--     -v migrator_password=... -v app_password=... -v job_password=... \
--     -v ops_password=... -v auth_password=... \
--     -f infra/aws/roles.sql
--
-- A missing -v stops the script with a message naming it, before any change.
--
-- Passwords are applied only when a role is CREATED; an existing role keeps
-- its password (so re-running never rotates mwf_app's production password).
-- Attributes are re-asserted on every run: no mwf_* or *_access role is ever
-- SUPERUSER or BYPASSRLS (Phase 3 D0, Branch A). psql does not substitute
-- :'vars' inside a DO body, so the "IF NOT EXISTS" checks are written as
-- SELECT ... \gexec.
--
-- The shape (design note §6 "Roles — one per kind of actor", work-k5fk.10.4):
-- grants and (later) RLS policies target NOLOGIN CAPABILITY roles; every
-- runtime LOGIN is a member of exactly one capability, with INHERIT (it uses
-- the grants) and without SET or ADMIN (it cannot become the capability or
-- hand it on). A new service or an IAM user maps onto a login, never onto a
-- copy of the grants. The baseline migration's step 20 (trailer.sql T8) and
-- the runtime role guard (backend/src/lib/prisma-role-guard.ts) refuse any
-- other membership.
--
--   login          capability         what for
--   mwf_app        app_access         HTTP requests; the RLS subject
--   mwf_ai         ai_access          the AI's writes, one session at a time. RESERVED: NOLOGIN, no
--                                     password, no grants until §7 row 9b gives it call sites
--   mwf_worker     worker_access      retention, reminders, notification delivery. RESERVED as mwf_ai
--   mwf_ops        ops_access         /api/brain/* (SELECT only)
--   mwf_auth       auth_access        sign-in lookup and first-login creation (functions only)
--   mwf_clinician  clinician_access   RESERVED for the clinician portal: NOLOGIN, no password, no
--                                     grants until the two-person consent model exists (Q18)
--   mwf_job        job_access         INTERIM: background jobs and the two-party paths, until §7 row 9b
--                                     re-homes its call sites onto mwf_ai / mwf_worker and retires both
--
-- Not runtime roles:
--   mwf_migrator  owner of every table, view, type and invoker function; runs
--                 migrations (production reaches this at §7 row 9c: until
--                 then migrations run as the database owner, mwf_app)
--   mwf_definer   NOLOGIN owner of every SECURITY DEFINER function; nobody
--                 logs in as it. mwf_migrator may SET ROLE to it (no
--                 inheritance) so a migration can hand a definer over.
-- Per-database grants live in the baseline migration next to each object,
-- not here.

\set ON_ERROR_STOP on

-- Every -v the script substitutes, checked first: psql would otherwise stop on the first
-- :'var' it cannot substitute with a syntax error that does not name the variable.
\if :{?migrator_password} \else \set missing migrator_password \endif
\if :{?app_password} \else \set missing app_password \endif
\if :{?job_password} \else \set missing job_password \endif
\if :{?ops_password} \else \set missing ops_password \endif
\if :{?auth_password} \else \set missing auth_password \endif
\if :{?missing}
\echo 'roles.sql: -v ' :missing '=... is required (each of migrator_password, app_password, job_password, ops_password, auth_password); nothing was changed'
DO $$ BEGIN RAISE EXCEPTION 'roles.sql: a required -v password variable is missing (see the line above)'; END $$;
\endif
-- An empty -v (e.g. -v app_password=) is refused too: CREATE ROLE … PASSWORD '' sets no usable
-- password, and nothing would say so.
SELECT (:'migrator_password' = '' OR :'app_password' = '' OR :'job_password' = '' OR :'ops_password' = ''
        OR :'auth_password' = '') AS empty_password \gset
\if :empty_password
DO $$ BEGIN RAISE EXCEPTION 'roles.sql: a -v password variable is empty; give every one of migrator_password, app_password, job_password, ops_password, auth_password a value (nothing was changed)'; END $$;
\endif

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

-- Reserved logins (review 9a F4, least privilege): they exist so their capability and
-- membership are in place, but cannot log in and hold no password until something uses
-- them — §7 row 9b makes mwf_ai / mwf_worker LOGIN with a password here, the clinician
-- portal (Q18) mwf_clinician. Re-running re-asserts NOLOGIN and drops any password.
SELECT format('CREATE ROLE %I NOLOGIN', r.name)
FROM (VALUES ('mwf_ai'), ('mwf_worker'), ('mwf_clinician')) AS r(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.name)
\gexec

SELECT format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD NULL', r.name)
FROM (VALUES ('mwf_ai'), ('mwf_worker'), ('mwf_clinician')) AS r(name)
\gexec

-- The NOLOGIN roles: the capabilities and the definer owner.
SELECT format('CREATE ROLE %I NOLOGIN', r.name)
FROM (VALUES ('app_access'), ('ai_access'), ('worker_access'), ('ops_access'), ('auth_access'),
             ('clinician_access'), ('job_access'), ('mwf_definer')) AS r(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.name)
\gexec

SELECT format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION', r.name)
FROM (VALUES ('app_access'), ('ai_access'), ('worker_access'), ('ops_access'), ('auth_access'),
             ('clinician_access'), ('job_access'), ('mwf_definer')) AS r(name)
\gexec

-- Each login's one capability. Issued unconditionally: on PG16+ re-granting an
-- existing membership updates its options. A membership outside this list is
-- never revoked here (an operator decision); step 20 and the role guard refuse it.
SELECT format('GRANT %I TO %I WITH INHERIT TRUE, SET FALSE', m.capability, m.login)
FROM (VALUES
  ('mwf_app',       'app_access'),
  ('mwf_ai',        'ai_access'),
  ('mwf_worker',    'worker_access'),
  ('mwf_ops',       'ops_access'),
  ('mwf_auth',      'auth_access'),
  ('mwf_clinician', 'clinician_access'),
  ('mwf_job',       'job_access')
) AS m(login, capability)
\gexec

COMMENT ON ROLE app_access IS 'Capability (NOLOGIN): what a user''s request may do. Its one login is mwf_app. Design note §6.';
COMMENT ON ROLE ai_access IS 'Capability (NOLOGIN): the AI, one session at a time (app.session_scope). Login mwf_ai. No grants until design note §7 row 9b.';
COMMENT ON ROLE worker_access IS 'Capability (NOLOGIN): system jobs (retention, reminders, notification delivery). Login mwf_worker. No grants until design note §7 row 9b.';
COMMENT ON ROLE ops_access IS 'Capability (NOLOGIN): the ops dashboard, SELECT only. Login mwf_ops.';
COMMENT ON ROLE auth_access IS 'Capability (NOLOGIN): sign-in lookup and first-login creation, through functions only. Login mwf_auth.';
COMMENT ON ROLE clinician_access IS 'Capability (NOLOGIN), reserved: therapists / counselors. Login mwf_clinician. No grants until the two-person consent model exists (design note Q18).';
COMMENT ON ROLE job_access IS 'INTERIM capability (NOLOGIN): mwf_job''s grants, until design note §7 row 9b re-homes its call sites onto ai_access / worker_access and drops this role and mwf_job.';
COMMENT ON ROLE mwf_definer IS 'NOLOGIN owner of every SECURITY DEFINER function (design note §6 layer 4). Nobody logs in as it; mwf_migrator may SET ROLE to it to hand a function over.';
COMMENT ON ROLE mwf_app IS 'Login: the API''s request path. Member of app_access only.';
COMMENT ON ROLE mwf_ai IS 'Reserved login (NOLOGIN, no password until design note §7 row 9b): the AI worker. Member of ai_access only.';
COMMENT ON ROLE mwf_worker IS 'Reserved login (NOLOGIN, no password until design note §7 row 9b): background jobs. Member of worker_access only.';
COMMENT ON ROLE mwf_ops IS 'Login: the ops dashboard. Member of ops_access only.';
COMMENT ON ROLE mwf_auth IS 'Login: sign-in and first-login creation. Member of auth_access only.';
COMMENT ON ROLE mwf_clinician IS 'Reserved login (NOLOGIN, no password until the clinician portal, design note Q18). Member of clinician_access only.';
COMMENT ON ROLE mwf_job IS 'Login, INTERIM: background jobs and two-party writes. Member of job_access only; retired by design note §7 row 9b.';
COMMENT ON ROLE mwf_migrator IS 'Login: owns the schema objects and runs migrations; never a runtime client. May SET ROLE mwf_definer (no inheritance).';

-- The baseline migration makes mwf_definer own the definer helpers (ALTER
-- FUNCTION ... OWNER TO mwf_definer), which (PG16+) requires the migrating
-- role to be able to SET ROLE mwf_definer. Without inheritance: the migrator
-- gains none of the definer's grants (it owns the tables anyway).
GRANT mwf_definer TO mwf_migrator WITH INHERIT FALSE, SET TRUE;

-- The pre-target migrations (phoenix/base) make mwf_job own their definer
-- helpers, the same way. Grant that, without inheritance, to mwf_migrator and
-- to this database's owner when the owner is not a superuser (production:
-- mwf_app, which runs migrations until §7 row 9c). The target baseline no
-- longer needs it; it goes with mwf_job (row 9b) and the ownership move (9c).
-- INTERIM EXCEPTION to security-catalogue assertion 9 ("mwf_app is a member
-- of no role"); the runtime role guard refuses mwf_app while it holds it.
-- Tracked as work-a39h.11.19.
-- Issued unconditionally: on PG16+ re-granting an existing membership updates
-- its options, so a membership that exists WITH INHERIT TRUE is corrected.
SELECT format('GRANT mwf_job TO %I WITH INHERIT FALSE, SET TRUE', g.grantee)
FROM (
  SELECT 'mwf_migrator'::name AS grantee
  UNION
  SELECT r.rolname
  FROM pg_catalog.pg_database d
  JOIN pg_catalog.pg_roles r ON r.oid = d.datdba
  WHERE d.datname = pg_catalog.current_database() AND NOT r.rolsuper AND r.rolname <> 'mwf_job'
) AS g
\gexec
