-- Phase 3 W1/W2 on the current shape: schema `app`, the identity GUC reader
-- app.current_user_id(), and the identity-bound SECURITY DEFINER helpers
-- app.is_member(session) and app.partner_user_id(session).
--
-- Design: docs/backend/data-model/phase3-design-summary.md §5; signatures:
-- docs/backend/data-model/schema-target-2026-10.md §4. On the current shape
-- membership is "Session"."relationshipId" -> "RelationshipMember"."userId";
-- the re-shape migration (TS-7) redefines both bodies over `participant` with
-- the same signatures. app.is_co_participant / app.my_participant take a
-- participant id and arrive with the `participant` table.
--
-- Roles are cluster-level and are NOT created here (a CREATE ROLE in a
-- migration breaks the shadow database and every other database in the
-- cluster). Apply infra/aws/roles.sql first; this migration refuses to run
-- without it. Prisma's differ ignores schemas, functions and grants, so
-- `prisma migrate diff` stays empty.

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r) INTO missing
  FROM unnest(ARRAY['mwf_app', 'mwf_job', 'mwf_ops', 'mwf_auth']) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'phase3_app_schema_helpers: database role(s) % do not exist', missing
      USING HINT = 'Roles are cluster-level and created outside Prisma: apply infra/aws/roles.sql '
                   '(docs/development/local-setup.md, "Database roles") and re-run the migration.';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'mwf_job', 'SET') THEN
    RAISE EXCEPTION 'phase3_app_schema_helpers: role % cannot SET ROLE mwf_job, which it needs to make mwf_job own the definer helpers', current_user
      USING HINT = 'infra/aws/roles.sql grants it to the database owner and mwf_migrator: re-apply it.';
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

-- Does the caller belong to this session? Identity-bound: no user argument.
CREATE FUNCTION app.is_member(session uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (
      SELECT 1
      FROM public."Session" s
      JOIN public."RelationshipMember" m ON m."relationshipId" = s."relationshipId"
      WHERE s.id = is_member.session
        AND m."userId" = app.current_user_id()
    )
  $$;

-- The caller's partner in this session: NULL unless the caller is a member,
-- and NULL when the relationship does not have exactly two members (kept for
-- the two-party job paths; v_co_participant replaces it for N-party reads).
CREATE FUNCTION app.partner_user_id(session uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT other."userId"
    FROM public."Session" s
    JOIN public."RelationshipMember" me
      ON me."relationshipId" = s."relationshipId" AND me."userId" = app.current_user_id()
    JOIN public."RelationshipMember" other
      ON other."relationshipId" = s."relationshipId" AND other."userId" <> me."userId"
    WHERE s.id = partner_user_id.session
      AND (SELECT count(*) FROM public."RelationshipMember" c
           WHERE c."relationshipId" = s."relationshipId") = 2
  $$;

-- Ownership first, privileges second, and the privileges granted AS mwf_job.
-- Measured as a non-superuser migrator (mwf_app, as in production): a
-- GRANT/REVOKE issued after the hand-over by the former owner is a silent
-- no-op (PUBLIC kept EXECUTE), and one issued before it is rewritten by
-- ALTER OWNER, which turns the old owner's own entries into the new owner's
-- (mwf_app lost EXECUTE). Granting as the owner is the only order that works
-- for both a superuser and a non-superuser migrator.
--
-- A non-superuser may hand a function to a role only if that role has CREATE
-- on the schema; grant it for the hand-over and take it back at once.
GRANT CREATE ON SCHEMA app TO mwf_job;
ALTER FUNCTION app.is_member(uuid) OWNER TO mwf_job;
ALTER FUNCTION app.partner_user_id(uuid) OWNER TO mwf_job;
REVOKE CREATE ON SCHEMA app FROM mwf_job;

SET ROLE mwf_job;
REVOKE EXECUTE ON FUNCTION app.is_member(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.partner_user_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_member(uuid) TO mwf_app;
GRANT EXECUTE ON FUNCTION app.partner_user_id(uuid) TO mwf_app;
RESET ROLE;

-- What the definer helpers read, granted to their owner (plan §2 step 2).
GRANT USAGE ON SCHEMA public TO mwf_job;
GRANT SELECT ON public."Session", public."RelationshipMember" TO mwf_job;
