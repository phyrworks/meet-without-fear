-- ============================================================================
-- sql-only.sql — target shape, October 2026 (TS-6)
--
-- Spec: docs/backend/data-model/schema-target-2026-10.md (§1 Keys lines, §5).
--
-- The objects `prisma migrate diff` cannot create but `prisma db pull` CAN
-- see, so they must be created exactly this way for backend/prisma/schema.prisma
-- to stay equal to a `db pull` of the migrated database:
--   1. the two generated columns (user.name, consent.target_kind);
--   2. the `sql_`-prefixed partial / expression indexes (spec §5 "Lives only in
--      migration SQL"; never give a Prisma index one of these names).
--
-- INPUT TO TS-7: the migration generator appends this file, verbatim, to the
-- trailer of the one-shot migration, after the tables exist. It runs AFTER the
-- Prisma-generated DDL (`migrate diff --from-empty --to-schema`), which creates
-- user.name and consent.target_kind as plain columns; section 1 replaces them.
-- The data migration must not write either column (they are GENERATED).
--
-- TS-7, one trap: schema.prisma declares consent.target_kind with
-- @default(dbgenerated("\nCASE … END")) because that is how `db pull` renders
-- the generated column; `migrate diff --from-empty` turns it into a column
-- DEFAULT that references other columns, which Postgres rejects. Generate the
-- CREATE TABLE DDL from a copy of schema.prisma with that one @default removed
-- (check-schema.sh shows the exact perl one-liner); section 1 below then
-- replaces the plain column.
--
-- Verified on PG 18.6 / Prisma 7.10 (TS-6 probe, 2026-10-19): the `intensity` domain
-- and CHECK constraints are invisible to both `migrate diff` and `db pull`
-- (a domain column introspects as plain Int), so they stay in TS-7's trailer.
--
-- NOT here (also SQL-only, but invisible to `db pull` and owned by TS-7's
-- trailer): RLS + policies, triggers, CHECK constraints (incl. jsonb_typeof,
-- exclusive arcs), the `intensity` domain, views, `app.*` functions, roles,
-- grants, the `milestone` seed.
--
-- Gate: backend/scripts/target-shape/check-schema.sh applies the Prisma DDL
-- then this file to a scratch database and proves the drift diff is empty.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Generated columns (DROP the plain column Prisma created, ADD it GENERATED;
--    PG cannot convert a plain column in place). Both end up as the table's
--    last column, which is where schema.prisma declares them.
-- ----------------------------------------------------------------------------

-- §1.7 user.name
ALTER TABLE "user" DROP COLUMN "name";
ALTER TABLE "user" ADD COLUMN "name" text
  GENERATED ALWAYS AS (nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')) STORED;

-- §1.3 consent.target_kind — one arm per arc column, in arc order. NOT NULL per
-- the §1.3 column table (the exclusive-arc CHECK guarantees exactly one arm).
ALTER TABLE "consent" DROP COLUMN "target_kind";
ALTER TABLE "consent" ADD COLUMN "target_kind" consent_target NOT NULL
  GENERATED ALWAYS AS (
    CASE
      WHEN need_id IS NOT NULL THEN 'NEED'::consent_target
      WHEN empathy_attempt_id IS NOT NULL THEN 'EMPATHY_ATTEMPT'::consent_target
      WHEN proposal_id IS NOT NULL THEN 'PROPOSAL'::consent_target
      WHEN share_offer_id IS NOT NULL THEN 'SHARE_OFFER'::consent_target
      WHEN review_id IS NOT NULL THEN 'REVIEW'::consent_target
    END
  ) STORED;

-- @@section: indexes  (check-schema.sh splits the file here; keep this line)
-- ----------------------------------------------------------------------------
-- 2. sql_-prefixed partial unique / partial / expression indexes
--
-- `migrate diff` ignores these (gate step b), but Prisma 7.10 `db pull` DOES
-- render them — as `@unique(map: "sql_…", where: raw(…))` / `@@index(…, where:)`
-- plus `previewFeatures = [… "partialIndexes"]`, and it turns the back-relation
-- of every single-column one into a 1:1 (`Conversation?` instead of
-- `Conversation[]`). schema.prisma deliberately does not declare them
-- (spec §5); NEVER run `prisma db pull` to refresh schema.prisma.
-- ----------------------------------------------------------------------------

-- §1.1 session — A-Q3: one live session per relationship
CREATE UNIQUE INDEX "sql_session_one_live" ON "session" ("relationship_id")
  WHERE status NOT IN ('RESOLVED', 'ABANDONED', 'ARCHIVED');

-- §1.1 conversation — exactly one MAIN thread per participant
CREATE UNIQUE INDEX "sql_conversation_one_main" ON "conversation" ("participant_id")
  WHERE kind = 'MAIN';

-- §1.1 draft — one draft per sharing point (adversarial P1-5). An expression
-- index, so it cannot be a Prisma @@unique; not in §5's list by name.
CREATE UNIQUE INDEX "sql_draft_one_per_point" ON "draft"
  ("participant_id", "kind", (coalesce(about_participant_id, attempt_id, share_offer_id)));

-- §1.1 session_key / participant_key, §1.7 user_key — one live key per owner
CREATE UNIQUE INDEX "sql_session_key_live" ON "session_key" ("session_id")
  WHERE destroyed_at IS NULL;
CREATE UNIQUE INDEX "sql_participant_key_live" ON "participant_key" ("participant_id")
  WHERE destroyed_at IS NULL;
CREATE UNIQUE INDEX "sql_user_key_live" ON "user_key" ("user_id")
  WHERE destroyed_at IS NULL;

-- §1.2 empathy_attempt — one live attempt per direction
CREATE UNIQUE INDEX "sql_attempt_one_live_per_direction" ON "empathy_attempt"
  ("author_participant_id", "subject_participant_id")
  WHERE status NOT IN ('SUPERSEDED', 'VALIDATED');

-- §1.2 reconciler_result — one current result per attempt
CREATE UNIQUE INDEX "sql_result_one_current" ON "reconciler_result" ("attempt_id")
  WHERE superseded_at IS NULL;

-- §1.4 need — live needs per participant
CREATE INDEX "sql_need_live" ON "need" ("participant_id")
  WHERE deleted_at IS NULL;

-- §1.4 need_disposition — one current need per walkthrough
CREATE UNIQUE INDEX "sql_disposition_one_current" ON "need_disposition" ("participant_id")
  WHERE is_current;

-- §1.5 follow_up — the open-due job
CREATE INDEX "sql_follow_up_due" ON "follow_up" ("scheduled_for")
  WHERE status = 'SCHEDULED';

-- §1.5 reminder — the delivery job
CREATE INDEX "sql_reminder_due" ON "reminder" ("remind_at")
  WHERE status = 'SCHEDULED';

-- §1.7 user_device — Expo tokens are per install (adversarial P2)
CREATE UNIQUE INDEX "sql_user_device_token" ON "user_device" ("user_id", "push_token")
  WHERE push_token IS NOT NULL;
