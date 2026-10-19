-- Phase 3 D0 check (docs/backend/data-model/phase3-design-summary.md §1, "D0 check").
--
--   podman exec -i mwf-postgres psql -U mwf_user -d meet_without_fear < backend/scripts/d0-check.sql
--
-- Expected: rolsuper = false for EVERY mwf_* role, except the local
-- development superuser mwf_user (dev container only; it does not exist in
-- production, where the superuser is `postgres`). rolbypassrls = false for
-- every mwf_* role except mwf_user: Branch A grants BYPASSRLS to nobody.
--
--   rolname      | rolsuper | rolbypassrls
--   mwf_app      | f        | f
--   mwf_auth     | f        | f
--   mwf_job      | f        | f
--   mwf_migrator | f        | f
--   mwf_ops      | f        | f
--   mwf_user     | t        | t      <- dev container only
--
-- A true rolsuper on any other row means FORCE ROW LEVEL SECURITY does not
-- bind that role: stop and fix the role before W8. The last query returns
-- the offending rows only, so an empty result is the pass condition.
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'mwf_%' ORDER BY rolname;

SELECT rolname AS d0_violation, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname LIKE 'mwf_%' AND rolname <> 'mwf_user' AND (rolsuper OR rolbypassrls)
ORDER BY rolname;
