-- ============================================================================
-- reconcile-dev-acl.sql — ONE-OFF REPAIR for a hand-built mwf_target_dev /
-- mwf_target_test (TS-7c, 2026-10-26). Not part of any supported path.
--
-- The supported path for the target branch's development databases is
--   backend/scripts/target-shape/run-baseline.sh --dev
-- which deploys the baseline migration with `prisma migrate deploy`.
--
-- Why this exists: both databases were found built by hand before the
-- baseline existed — the 47 target tables, but no _prisma_migrations (so
-- `migrate deploy` failed with P3005) — and a pg_dump --schema-only diff
-- against a fresh baseline showed ONE schema difference: the EXECUTE ACLs of
-- app.is_member / app.partner_user_id (PUBLIC still had EXECUTE; mwf_app had
-- no grant). This file closes that gap, issued AS mwf_job, the owner (TS-1
-- order). It was followed by
--   cd backend && DATABASE_URL=<db> npx prisma migrate resolve --applied 20261026120000_target_shape_baseline
-- and a second dump diff showing both databases identical to a fresh baseline.
--
-- Before reusing it on any other database: diff its dump against a fresh
-- baseline first; if anything else differs, drop the database and run
-- `run-baseline.sh --dev` instead.
--
--   podman exec -i mwf-postgres psql -U mwf_user -d mwf_target_dev < backend/scripts/target-shape/reconcile-dev-acl.sql
-- ============================================================================
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() NOT IN ('mwf_target_dev', 'mwf_target_test') THEN
    RAISE EXCEPTION 'only for mwf_target_dev / mwf_target_test, not %', current_database();
  END IF;
END $$;
BEGIN;
SET ROLE mwf_job;
REVOKE EXECUTE ON FUNCTION app.is_member(uuid), app.partner_user_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_member(uuid), app.partner_user_id(uuid) TO mwf_app;
RESET ROLE;
COMMIT;
