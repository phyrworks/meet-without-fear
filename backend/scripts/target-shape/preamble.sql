-- ============================================================================
-- preamble.sql — section 0 of the target_shape_baseline migration (TS-7c).
-- Hand-maintained; backend/scripts/gen-target-migration.ts copies it verbatim
-- to the head of the migration. It never runs alone.
--
-- Carries what TS-1's migration 20261019173038_phase3_app_schema_helpers did
-- before the table DDL existed (that migration is gone with the old history,
-- OD7): the roles assertion, the SET ROLE mwf_definer check, schema app,
-- app.current_user_id() and app.session_scope() (work-k5fk.10.5). The membership helpers app.is_member and
-- app.partner_user_id are created by the trailer, over participant.
-- ============================================================================

-- Refuse anything but an empty database: the roles the baseline grants to (the
-- capability roles and mwf_definer) and the logins step 20 checks must exist, the
-- migrator must be able to SET ROLE mwf_definer, and schema public must
-- hold no relation but _prisma_migrations. A database still at the old shape
-- (table "Session") is refused with the cutover instruction.
DO $$
DECLARE
  missing text;
  extra   text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r) INTO missing
  FROM unnest(ARRAY['app_access', 'ai_access', 'worker_access', 'ops_access', 'auth_access', 'clinician_access',
                    'diag_access', 'mwf_definer',
                    'mwf_app', 'mwf_ai', 'mwf_worker', 'mwf_ops', 'mwf_auth', 'mwf_clinician',
                    'slam_bot_readonly']) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'target_shape_baseline: database role(s) % do not exist', missing
      USING HINT = 'Roles are cluster-level and created outside Prisma: apply infra/aws/roles.sql '
                   '(docs/development/local-setup.md, "Database roles") and re-run the migration.';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'mwf_definer', 'SET') THEN
    RAISE EXCEPTION 'target_shape_baseline: role % cannot SET ROLE mwf_definer, which it needs to make mwf_definer own the definer helpers', current_user
      USING HINT = 'infra/aws/roles.sql grants it to the database owner and mwf_migrator: re-apply it.';
  END IF;
  IF pg_catalog.to_regclass('public."Session"') IS NOT NULL THEN
    RAISE EXCEPTION 'target_shape_baseline: this database is still at the old shape (table "Session" exists)'
      USING HINT = 'Cutover (plan §6): back up, stop the API, run backend/scripts/target-shape/drop-old-objects.sql, then migrate deploy.';
  END IF;
  IF pg_catalog.to_regnamespace('app') IS NOT NULL THEN
    RAISE EXCEPTION 'target_shape_baseline: schema app already exists'
      USING HINT = 'A database at the old shape must go through backend/scripts/target-shape/drop-old-objects.sql first.';
  END IF;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO extra
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname <> '_prisma_migrations';
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'target_shape_baseline: schema public is not empty: %', extra
      USING HINT = 'The baseline builds the target shape on an empty database (OD7).';
  END IF;
END
$$;

CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
-- The capability roles (work-k5fk.10.4) and mwf_definer, whose definer helpers call
-- app.* functions. clinician_access: nothing yet (Q18).
GRANT USAGE ON SCHEMA app TO app_access, ai_access, worker_access, ops_access, auth_access, mwf_definer;

-- The caller's identity, from the transaction-local setting the request layer
-- writes with set_config('app.current_user_id', <id>, true). NULL when unset
-- or empty, so every policy that compares against it is fail-closed.
-- SECURITY INVOKER: it reads only the caller's own setting.
CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')::uuid $$;
COMMENT ON FUNCTION app.current_user_id() IS 'The caller''s identity: the transaction-local setting app.current_user_id the request layer binds, NULL when unset or empty, so every policy comparing against it fails closed. (work-k5fk.10.16)';

REVOKE EXECUTE ON FUNCTION app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO app_access, ops_access, auth_access, mwf_definer;

-- The one session a transaction of the AI (mwf_ai) or a worker task (mwf_worker) acts on
-- (design note §6 "Session variables", Q20; work-k5fk.10.5), from the transaction-local setting
-- the ai / worker clients write with set_config('app.session_scope', <id>, true)
-- (lib/prisma-identity.ts). NULL when unset or empty, so every check against it fails closed:
-- t_session_scope refuses an AI / worker row outside it, and the definers' AI / worker arms
-- refuse a session other than it. Never set for mwf_app (whose rows follow
-- app.current_user_id) nor for the migrator or the admin.
-- SECURITY INVOKER: it reads only the caller's own setting.
CREATE FUNCTION app.session_scope() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.session_scope', true), '')::uuid $$;
COMMENT ON FUNCTION app.session_scope() IS 'The session the transaction of mwf_ai / mwf_worker acts on (transaction-local setting app.session_scope; NULL when unset, so every check fails closed). Design note §6 Q20.';

-- ai_access, worker_access: t_session_scope (trailer T5, invoker) reads it with the writer's
-- rights. mwf_definer: the definers' AI / worker arms.
REVOKE EXECUTE ON FUNCTION app.session_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_scope() TO ai_access, worker_access, mwf_definer;
