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
--     -v migrator_password=... -v app_password=... -v ai_password=... \
--     -v worker_password=... -v ops_password=... -v auth_password=... \
--     -f infra/aws/roles.sql
--
-- A missing -v stops the script with a message naming it, before any change.
--
-- Passwords are applied only when a role is CREATED — or, for mwf_ai and
-- mwf_worker, when it has none (they existed NOLOGIN without one before §7 row
-- 9b); an existing password is kept (so re-running never rotates mwf_app's
-- production password).
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
--   mwf_ai         ai_access          the AI: the reconciler, the facilitator's lines, summaries,
--                                     telemetry — one session at a time (app.session_scope)
--   mwf_worker     worker_access      retention, reminders, notification delivery, the Stage 4
--                                     closure's cross-participant decision
--   mwf_ops        ops_access         /api/brain/* (SELECT only)
--   mwf_auth       auth_access        sign-in lookup and first-login creation (functions only)
--   mwf_clinician  clinician_access   RESERVED for the clinician portal: NOLOGIN, no password, no
--                                     grants until the two-person consent model exists (Q18)
--   slam_bot_readonly diag_access     the operations bot's diagnostics (work-k5fk.10.30, owner
--                                     decision 2026-11-17: "diagnostics, no content"): SELECT on
--                                     ids, statuses, stages, counts, timestamps and job state only
--                                     (trailer T7c). Created here NOLOGIN when missing and no
--                                     -v readonly_password is given (a development cluster has no
--                                     bot); production's was created by init-db.sh with its password.
--
-- Retired (work-k5fk.10.5, §7 row 9b): mwf_job and its interim capability
-- job_access — once the AI's writer, the two-party writer and the definer owner
-- at once. The end of this script drops them (see there for when it cannot).
-- Not runtime roles:
--   mwf_migrator  owner of the database, schema public and every table, view,
--                 type and invoker function; runs migrations, nothing else
--                 (ownership.sql hands it the database at the cutover, §7 row
--                 9c / work-k5fk.10.6; deploy.sh migrates as it). FORCE ROW
--                 LEVEL SECURITY gives it no row by default, but as the owner it
--                 can lift that (NO FORCE, SET ROLE mwf_definer): the controls
--                 are pg_hba.conf (the deploy step only) and pgaudit (every
--                 statement it runs is logged; ownership.sql).
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
\if :{?ai_password} \else \set missing ai_password \endif
\if :{?worker_password} \else \set missing worker_password \endif
\if :{?ops_password} \else \set missing ops_password \endif
\if :{?auth_password} \else \set missing auth_password \endif
-- Optional: readonly_password, used only when slam_bot_readonly does not exist yet.
\if :{?readonly_password} \else \set readonly_password '' \endif
\if :{?missing}
\echo 'roles.sql: -v ' :missing '=... is required (each of migrator_password, app_password, ai_password, worker_password, ops_password, auth_password); nothing was changed'
DO $$ BEGIN RAISE EXCEPTION 'roles.sql: a required -v password variable is missing (see the line above)'; END $$;
\endif
-- An empty -v (e.g. -v app_password=) is refused too: CREATE ROLE … PASSWORD '' sets no usable
-- password, and nothing would say so.
SELECT (:'migrator_password' = '' OR :'app_password' = '' OR :'ai_password' = '' OR :'worker_password' = ''
        OR :'ops_password' = '' OR :'auth_password' = '') AS empty_password \gset
\if :empty_password
DO $$ BEGIN RAISE EXCEPTION 'roles.sql: a -v password variable is empty; give every one of migrator_password, app_password, ai_password, worker_password, ops_password, auth_password a value (nothing was changed)'; END $$;
\endif

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', r.name, r.password)
FROM (VALUES
  ('mwf_migrator', :'migrator_password'),
  ('mwf_app',      :'app_password'),
  ('mwf_ai',       :'ai_password'),
  ('mwf_worker',   :'worker_password'),
  ('mwf_ops',      :'ops_password'),
  ('mwf_auth',     :'auth_password')
) AS r(name, password)
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.name)
\gexec

SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION', r.name)
FROM (VALUES ('mwf_migrator'), ('mwf_app'), ('mwf_ai'), ('mwf_worker'), ('mwf_ops'), ('mwf_auth')) AS r(name)
\gexec

-- mwf_ai / mwf_worker created NOLOGIN by an earlier run (work-k5fk.10.4, no password): give them theirs now.
-- pg_authid is readable here (a superuser runs this script); an existing password is never replaced.
SELECT format('ALTER ROLE %I PASSWORD %L', r.name, r.password)
FROM (VALUES ('mwf_ai', :'ai_password'), ('mwf_worker', :'worker_password')) AS r(name, password)
JOIN pg_catalog.pg_authid a ON a.rolname = r.name
WHERE a.rolpassword IS NULL
\gexec

-- Reserved login (review 9a F4, least privilege): it exists so its capability and membership
-- are in place, but cannot log in and holds no password until the clinician portal (Q18) uses
-- it. Re-running re-asserts NOLOGIN and drops any password. (mwf_ai and mwf_worker were reserved
-- the same way until §7 row 9b gave them their call sites.)
SELECT format('CREATE ROLE %I NOLOGIN', r.name)
FROM (VALUES ('mwf_clinician')) AS r(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.name)
\gexec

SELECT format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD NULL', r.name)
FROM (VALUES ('mwf_clinician')) AS r(name)
\gexec

-- The operations bot (diag_access). LOGIN with -v readonly_password, NOLOGIN without one; an existing role keeps
-- its LOGIN state and password. Attributes re-asserted (no SUPERUSER / BYPASSRLS: under FORCE ROW LEVEL SECURITY
-- its diag_read policies are the only rows it reaches).
SELECT CASE WHEN :'readonly_password' = '' THEN 'CREATE ROLE slam_bot_readonly NOLOGIN'
            ELSE format('CREATE ROLE slam_bot_readonly LOGIN PASSWORD %L', :'readonly_password') END
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'slam_bot_readonly')
\gexec
ALTER ROLE slam_bot_readonly NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

-- The NOLOGIN roles: the capabilities and the definer owner.
SELECT format('CREATE ROLE %I NOLOGIN', r.name)
FROM (VALUES ('app_access'), ('ai_access'), ('worker_access'), ('ops_access'), ('auth_access'),
             ('clinician_access'), ('diag_access'), ('mwf_definer')) AS r(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.name)
\gexec

SELECT format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION', r.name)
FROM (VALUES ('app_access'), ('ai_access'), ('worker_access'), ('ops_access'), ('auth_access'),
             ('clinician_access'), ('diag_access'), ('mwf_definer')) AS r(name)
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
  ('slam_bot_readonly', 'diag_access')
) AS m(login, capability)
\gexec

COMMENT ON ROLE app_access IS 'Capability (NOLOGIN): what a user''s request may do. Its one login is mwf_app. Design note §6.';
COMMENT ON ROLE ai_access IS 'Capability (NOLOGIN): the AI, one session at a time (app.session_scope). Login mwf_ai. Design note §6, §7 row 9b.';
COMMENT ON ROLE worker_access IS 'Capability (NOLOGIN): system jobs (retention, reminders, notification delivery, the Stage 4 closure). Login mwf_worker. Design note §6, §7 row 9b.';
COMMENT ON ROLE ops_access IS 'Capability (NOLOGIN): the ops dashboard, SELECT only. Login mwf_ops.';
COMMENT ON ROLE auth_access IS 'Capability (NOLOGIN): sign-in lookup and first-login creation, through functions only. Login mwf_auth.';
COMMENT ON ROLE clinician_access IS 'Capability (NOLOGIN), reserved: therapists / counselors. Login mwf_clinician. No grants until the two-person consent model exists (design note Q18).';
COMMENT ON ROLE mwf_definer IS 'NOLOGIN owner of every SECURITY DEFINER function (design note §6 layer 4). Nobody logs in as it; mwf_migrator may SET ROLE to it to hand a function over.';
COMMENT ON ROLE diag_access IS 'Capability (NOLOGIN): the operations bot''s diagnostics — ids, statuses, stages, counts, timestamps, job state; no content, names, emails, keys or push tokens (trailer T7c). Login slam_bot_readonly. work-k5fk.10.30.';
COMMENT ON ROLE slam_bot_readonly IS 'Login: the operations bot (SSH tunnel, read-only). Member of diag_access only; NOLOGIN on a cluster without the bot.';
COMMENT ON ROLE mwf_app IS 'Login: the API''s request path. Member of app_access only.';
COMMENT ON ROLE mwf_ai IS 'Login: the AI (AI_DATABASE_URL), one session per transaction (app.session_scope). Member of ai_access only.';
COMMENT ON ROLE mwf_worker IS 'Login: background jobs and notification delivery (WORKER_DATABASE_URL). Member of worker_access only.';
COMMENT ON ROLE mwf_ops IS 'Login: the ops dashboard. Member of ops_access only.';
COMMENT ON ROLE mwf_auth IS 'Login: sign-in and first-login creation. Member of auth_access only.';
COMMENT ON ROLE mwf_clinician IS 'Reserved login (NOLOGIN, no password until the clinician portal, design note Q18). Member of clinician_access only.';
COMMENT ON ROLE mwf_migrator IS 'Login: owns the schema objects and runs migrations; never a runtime client. May SET ROLE mwf_definer (no inheritance).';

-- The baseline migration makes mwf_definer own the definer helpers (ALTER
-- FUNCTION ... OWNER TO mwf_definer), which (PG16+) requires the migrating
-- role to be able to SET ROLE mwf_definer. Without inheritance: the migrator
-- gains none of the definer's grants (it owns the tables anyway).
GRANT mwf_definer TO mwf_migrator WITH INHERIT FALSE, SET TRUE;

-- Retire mwf_job and its interim capability job_access (work-k5fk.10.5, design note
-- §6 Q13, §7 row 9b): their call sites moved to mwf_ai, mwf_worker and definer
-- functions; the baseline's step 20 refuses a cluster where either still exists.
-- Idempotent: nothing happens once both are gone. A role cannot be dropped while
-- it owns an object or holds a privilege in ANY database of the cluster, and this
-- script reaches only the one it runs in, so:
--   1. if either still OWNS an object anywhere (a database at the old shape:
--      phoenix/base makes mwf_job own its definer helpers), the script stops,
--      changing nothing — run backend/scripts/target-shape/drop-old-objects.sql there first;
--   2. every membership in either role is revoked (GRANT mwf_job TO mwf_migrator,
--      and to a non-superuser database owner, from the pre-9b script);
--   3. their privileges in THIS database are dropped (DROP OWNED: they own
--      nothing, so it only revokes);
--   4. if another database still grants them something, the script stops and
--      names it — there, as a superuser: DROP OWNED BY job_access, mwf_job; (or
--      drop that database), then re-run;
--   5. both roles are dropped.
SELECT count(*) > 0 AS legacy_roles FROM pg_catalog.pg_roles WHERE rolname IN ('mwf_job', 'job_access') \gset
\if :legacy_roles
SELECT coalesce(string_agg(DISTINCT coalesce(d.datname, '(cluster)'), ', '), '') AS retired_owner_dbs,
       count(*) > 0 AS retired_owns
FROM pg_catalog.pg_shdepend s LEFT JOIN pg_catalog.pg_database d ON d.oid = s.dbid
WHERE s.refclassid = 'pg_catalog.pg_authid'::regclass AND s.deptype = 'o'
  AND s.refobjid IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('mwf_job', 'job_access')) \gset
\if :retired_owns
\echo 'roles.sql: mwf_job / job_access still OWN objects in: ' :retired_owner_dbs ' — run backend/scripts/target-shape/drop-old-objects.sql there first (work-k5fk.10.5); the roles above were applied, the retirement was not'
DO $$ BEGIN RAISE EXCEPTION 'roles.sql: a retired role still owns objects (see the line above)'; END $$;
\endif

-- Ownership checked first (review F9): only now are the memberships revoked, so a run refused there changes nothing.
SELECT format('REVOKE %I FROM %I', r.rolname, m.rolname)
FROM pg_catalog.pg_auth_members am
JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
JOIN pg_catalog.pg_roles m ON m.oid = am.member
WHERE r.rolname IN ('mwf_job', 'job_access') AND m.rolname NOT IN ('mwf_job', 'job_access')
\gexec

SELECT format('DROP OWNED BY %I', rolname) FROM pg_catalog.pg_roles WHERE rolname IN ('mwf_job', 'job_access') ORDER BY rolname
\gexec

SELECT coalesce(string_agg(DISTINCT coalesce(d.datname, '(cluster)'), ', '), '') AS retired_grant_dbs,
       count(*) > 0 AS retired_grants
FROM pg_catalog.pg_shdepend s LEFT JOIN pg_catalog.pg_database d ON d.oid = s.dbid
WHERE s.refclassid = 'pg_catalog.pg_authid'::regclass
  AND s.refobjid IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('mwf_job', 'job_access')) \gset
\if :retired_grants
\echo 'roles.sql: job_access / mwf_job still hold privileges in: ' :retired_grant_dbs ' — in each, as a superuser: DROP OWNED BY job_access, mwf_job; (or drop the database), then re-run this script (work-k5fk.10.5)'
DO $$ BEGIN RAISE EXCEPTION 'roles.sql: a retired role still holds privileges in another database (see the line above)'; END $$;
\endif

SELECT format('DROP ROLE %I', rolname) FROM pg_catalog.pg_roles WHERE rolname IN ('mwf_job', 'job_access') ORDER BY rolname
\gexec
\endif
