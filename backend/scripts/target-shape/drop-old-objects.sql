-- ============================================================================
-- drop-old-objects.sql — empty a database that is still at the OLD (68-table)
-- shape, so the target_shape_baseline migration can build the target on it
-- (TS-7c; owner decision OD7, 2026-10-26: existing data is demo/test and is
-- NOT preserved).
--
-- OPERATOR-RUN, once per database, as part of the cutover (plan §6):
--   1. back up the database (pg_dump -Fc) — this script destroys every row;
--   2. stop the API (nothing may write while the shape changes);
--   3. run this script:
--        psql -v ON_ERROR_STOP=1 -d <db> -v target_db=<db> \
--             -f backend/scripts/target-shape/drop-old-objects.sql
--      target_db is an allow-list (comma-separated database names); the
--      script refuses unless current_database() is one of them;
--   4. cd backend && DATABASE_URL=<db url> npx prisma migrate deploy
--      (applies the single baseline migration);
--   5. deploy the image; smoke.
--
-- What it drops, in dependency order, in ONE transaction:
--   (a) the 68 old tables (one DROP TABLE statement, so their FKs to each
--       other resolve together; RESTRICT — an unknown dependent object, e.g. a
--       harness view, makes it fail and roll back instead of being swept);
--   (b) the 51 old enum types;
--   (c) TS-1's app schema objects: app.is_member(uuid) and
--       app.partner_user_id(uuid) (as mwf_job, their owner),
--       app.current_user_id(), then schema app
--       (RESTRICT: anything else in it makes the script fail);
--   (d) _prisma_migrations (the old history; the baseline starts a new one).
-- Then it asserts schema public holds no relation and no enum type, and
-- schema app is gone.
--
-- Refuses (and changes nothing) unless BOTH:
--   * current_database() is in the -v target_db allow-list, and
--   * the database HAS the old shape (table public."Session" exists) and does
--     NOT have the target shape (table public.participant absent) — a database
--     already on the target shape is refused.
-- Re-running: the END STATE is idempotent, the script is not. Every DROP is
-- IF EXISTS, so a run over a partial manual clean-up (with "Session" still
-- there) finishes the job; once "Session" is gone, a re-run is REFUSED by the
-- guard (non-zero exit) and changes nothing.
--
-- Run it as the database owner (production: mwf_app today, mwf_migrator after
-- work-a39h.11.19) or a superuser. TS-1's two definer helpers are owned by
-- mwf_job, and the owner holds mwf_job only WITH INHERIT FALSE, SET TRUE
-- (infra/aws/roles.sql). PostgreSQL lets a role DROP an object it owns OR an
-- object in a schema it owns; the migrating role created schema app, so it
-- could drop them anyway (fix round 1 probe) — but only while it owns the
-- schema. The script drops them under SET ROLE mwf_job, their owner, so it
-- does not depend on who created schema app (probe: a mwf_job function in a
-- schema the dropper does not own fails "must be owner" without it).
--
-- Left in place on purpose: the "vector" extension (installed by the old
-- history; the target does not use it; dropping an extension needs its owner
-- or a superuser — an owner may DROP EXTENSION vector afterwards), the roles
-- (cluster-level, infra/aws/roles.sql), and schema public itself.
-- ============================================================================
\set ON_ERROR_STOP on
\if :{?target_db}
\else
\set target_db ''
\endif
SELECT pg_catalog.set_config('drop_old.target_db', :'target_db', false) \g /dev/null

BEGIN;

DO $$
DECLARE
  allow text[] := pg_catalog.string_to_array(pg_catalog.replace(pg_catalog.current_setting('drop_old.target_db'), ' ', ''), ',');
BEGIN
  IF pg_catalog.current_setting('drop_old.target_db') = '' THEN
    RAISE EXCEPTION 'drop-old-objects: refusing — pass the allow-list: -v target_db=<database>[,<database>…]';
  END IF;
  IF NOT (pg_catalog.current_database() = ANY (allow)) THEN
    RAISE EXCEPTION 'drop-old-objects: refusing — database % is not in the allow-list (%)',
      pg_catalog.current_database(), pg_catalog.current_setting('drop_old.target_db');
  END IF;
  IF pg_catalog.to_regclass('public."Session"') IS NULL THEN
    RAISE EXCEPTION 'drop-old-objects: refusing — database % does not have the old shape (no table "Session")',
      pg_catalog.current_database();
  END IF;
  IF pg_catalog.to_regclass('public.participant') IS NOT NULL THEN
    RAISE EXCEPTION 'drop-old-objects: refusing — database % already has the target shape (table participant)',
      pg_catalog.current_database();
  END IF;
  RAISE NOTICE 'drop-old-objects: dropping the old shape of database %', pg_catalog.current_database();
END
$$;

-- (a) the 68 old tables
DROP TABLE IF EXISTS
  public."User", public."Relationship", public."RelationshipMember", public."Session", public."InnerWorkSession",
  public."InnerWorkMessage", public."SessionTakeaway", public."TakeawayLink", public."StageProgress", public."UserVessel",
  public."UserEvent", public."EmotionalReading", public."IdentifiedNeed", public."Boundary", public."UserDocument",
  public."SharedVessel", public."ConsentedContent", public."CommonGround", public."Agreement", public."ConsentRecord",
  public."Message", public."PreSessionMessage", public."EmpathyDraft", public."EmpathyAttempt", public."EmpathyValidation",
  public."ReconcilerResult", public."ReconcilerShareOffer", public."RefinementAttemptCounter", public."StrategyProposal",
  public."StrategyProposalNeed", public."Stage4ProposalSelection", public."Stage4ProposalRevision",
  public."Stage4NeedCoverage", public."Stage4NeedDeclination", public."Stage4Closure", public."Stage4SubChat",
  public."Stage4SubChatMessage", public."TendingEntry", public."TendingCheckin", public."TendingCoordinationCycle",
  public."TendingResponse", public."TendingEntryOutcome", public."TendingNeedOutcome", public."TendingReminder",
  public."TendingAdjustment", public."TendingBetweenPeriodNote", public."TendingResponsePartialClosure",
  public."StrategyRanking", public."EmotionalExerciseCompletion", public."GlobalLibraryItem", public."Invitation",
  public."UserMemory", public."Need", public."NeedScore", public."NeedsAssessmentState", public."Person",
  public."PersonMention", public."Insight", public."RecurringTheme", public."GratitudeEntry",
  public."GratitudePreferences", public."MeditationSession", public."MeditationStats", public."MeditationFavorite",
  public."MeditationPreferences", public."SavedMeditation", public."BrainActivity", public."ValidationFeedbackDraft";

-- (b) the 51 old enum types
DROP TYPE IF EXISTS
  public."SessionType", public."SessionStatus", public."InnerWorkStatus", public."TakeawaySource", public."TakeawayType",
  public."TakeawayLinkType", public."StageStatus", public."Attribution", public."NeedCategory", public."AgreementType",
  public."AgreementStatus", public."ConsentContentType", public."ConsentDecision", public."MessageRole",
  public."EmpathyStatus", public."SharedContentDeliveryStatus", public."ReconcilerShareStatus", public."StrategySource",
  public."Stage4ProposalKind", public."Stage4ProposalStatus", public."Stage4SelectionDecision",
  public."Stage4ClosureKind", public."Stage4ClosureReason", public."TendingEntryType", public."TendingEntryStatus",
  public."TendingEntryScope", public."TendingFollowThroughStatus", public."TendingHelpfulnessStatus",
  public."TendingBlockerCategory", public."TendingNeedResolutionStatus", public."TendingNextAction",
  public."TendingReminderScope", public."TendingCoordinationStatus", public."Stage4SubChatAnchor",
  public."Stage4SubChatStatus", public."ContinueChoice", public."PartialClosureResolution", public."ExerciseType",
  public."GlobalLibrarySource", public."InvitationStatus", public."MemoryCategory", public."MemoryStatus",
  public."MemorySource", public."NeedsCategory", public."MentionSourceType", public."InsightType",
  public."MeditationType", public."FavoriteType", public."BrainActivityCallType", public."ActivityType",
  public."ActivityStatus";

-- (c) TS-1's schema app (20261019173038_phase3_app_schema_helpers). The two
-- definer helpers belong to mwf_job: drop them as mwf_job (a non-superuser
-- owner holds mwf_job WITH INHERIT FALSE, SET TRUE, so it must SET ROLE; it
-- does not rely on owning schema app). The rest belongs to the database
-- owner, who created the schema.
SET LOCAL ROLE mwf_job;
DROP FUNCTION IF EXISTS app.is_member(uuid), app.partner_user_id(uuid);
RESET ROLE;
DROP FUNCTION IF EXISTS app.current_user_id();
DROP SCHEMA IF EXISTS app;

-- (d) the old migration history
DROP TABLE IF EXISTS public._prisma_migrations;

-- Post-condition: nothing of the old shape is left for the baseline to trip on.
DO $$
DECLARE
  left_over text;
BEGIN
  SELECT pg_catalog.string_agg(c.relname || ' (' || c.relkind::text || ')', ', ' ORDER BY c.relname) INTO left_over
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S');
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'drop-old-objects: relation(s) left in public: %', left_over;
  END IF;
  SELECT pg_catalog.string_agg(t.typname, ', ' ORDER BY t.typname) INTO left_over
  FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd');
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'drop-old-objects: enum/domain type(s) left in public: %', left_over;
  END IF;
  IF pg_catalog.to_regnamespace('app') IS NOT NULL THEN
    RAISE EXCEPTION 'drop-old-objects: schema app is still there';
  END IF;
  RAISE NOTICE 'drop-old-objects: database % is empty; next: prisma migrate deploy (the target_shape_baseline migration)',
    pg_catalog.current_database();
END
$$;

COMMIT;
