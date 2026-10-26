-- ============================================================================
-- preamble.sql — section 0 of the target_shape_baseline migration (TS-7c).
-- Hand-maintained; backend/scripts/gen-target-migration.ts copies it verbatim
-- to the head of the migration. It never runs alone.
--
-- Carries what TS-1's migration 20261019173038_phase3_app_schema_helpers did
-- before the table DDL existed (that migration is gone with the old history,
-- OD7): the roles assertion, the SET ROLE mwf_job check, schema app and
-- app.current_user_id(). The membership helpers app.is_member and
-- app.partner_user_id are created by the trailer, over participant.
-- ============================================================================

-- Refuse anything but an empty database: the roles the trailer grants to must
-- exist, the migrator must be able to SET ROLE mwf_job, and schema public must
-- hold no relation but _prisma_migrations. A database still at the old shape
-- (table "Session") is refused with the cutover instruction.
DO $$
DECLARE
  missing text;
  extra   text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r) INTO missing
  FROM unnest(ARRAY['mwf_app', 'mwf_job', 'mwf_ops', 'mwf_auth']) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'target_shape_baseline: database role(s) % do not exist', missing
      USING HINT = 'Roles are cluster-level and created outside Prisma: apply infra/aws/roles.sql '
                   '(docs/development/local-setup.md, "Database roles") and re-run the migration.';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'mwf_job', 'SET') THEN
    RAISE EXCEPTION 'target_shape_baseline: role % cannot SET ROLE mwf_job, which it needs to make mwf_job own the definer helpers', current_user
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
GRANT USAGE ON SCHEMA app TO mwf_app, mwf_job, mwf_ops, mwf_auth;

-- The caller's identity, from the transaction-local setting the request layer
-- writes with set_config('app.current_user_id', <id>, true). NULL when unset
-- or empty, so every policy that compares against it is fail-closed.
-- SECURITY INVOKER: it reads only the caller's own setting.
CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')::uuid $$;

REVOKE EXECUTE ON FUNCTION app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO mwf_app, mwf_job, mwf_ops, mwf_auth;
