-- ============================================================================
-- tables.sql — section 1 of the target_shape_baseline migration (work-a39h.11.40).
-- Hand-maintained; backend/scripts/gen-target-migration.ts copies it verbatim
-- after the preamble. It is the source of truth for the 47 tables: read a
-- table here and you have all of it — columns, types, defaults, NOT NULL,
-- generated columns, the primary key, UNIQUE constraints, foreign keys and
-- CHECKs inside its CREATE TABLE, its plain indexes straight after.
--
-- Spec: docs/backend/data-model/schema-target-2026-10.md (§1 tables and Keys
-- lines, §3 domains). Owner decision 2026-11-02: hand-written DDL replaces the
-- `prisma migrate diff --from-empty` output the generator used to emit. The
-- drift gate still proves schema.prisma matches it:
-- backend/scripts/target-shape/check-schema.sh builds a scratch database from
-- this file + sql-only.sql and requires an empty `migrate diff` and a
-- matching `db pull`. So every name, type, default and FK action here is the
-- one Prisma would generate for schema.prisma; change both together.
--
-- Conventions
--  * Names are Prisma's: <table>_pkey, <table>_<cols>_key (UNIQUE),
--    <table>_<col>_fkey, <table>_<cols>_idx; CHECKs are chk_<table>_<rule>.
--    Code and gates use these names — never rename one here alone.
--  * FK actions: ON UPDATE NO ACTION everywhere; ON DELETE as schema.prisma
--    says (CASCADE / SET NULL; RESTRICT for every FK to "user" (P3 D9),
--    need_share → need, agreement → proposal, participant_milestone →
--    milestone).
--  * Tables are in dependency order: each one only references tables above
--    it (or itself: session, need, empathy_attempt). There are no cycles.
--  * NOT here: the sql_ partial / expression indexes (sql-only.sql — `db pull`
--    renders them but schema.prisma deliberately omits them, so the drift
--    gate applies them in a second stage; each table that has one says so in
--    a `-- + sql_…` line), triggers, functions, views, grants (trailer.sql).
--  * The [Pnn] tags on the CHECKs name the TS-7 data-move prechecks that
--    guarded each rule; kept as cross-references.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Domains. Both are invisible to Prisma: a uuid7 column introspects as
-- String @db.Uuid, an intensity column as Int, and `migrate diff` reports
-- nothing (TS-6 probe for intensity, 2026-10-19; work-a39h.11.40 probe for
-- uuid7, 2026-11-02; PG 18.6 / Prisma 7.10).
-- ----------------------------------------------------------------------------

-- Every uuid column (the 33 uuidv7() primary keys and the 95 columns that
-- reference them) is a uuid7: a version-7 UUID, so ids sort by creation time.
-- The CHECK has two NULL traps, both handled explicitly:
--  1. uuid_extract_version() returns NULL for a UUID that is not RFC 9562
--     variant 10xx (e.g. '…-7…-0…' or the nil UUID), and a CHECK that
--     evaluates to NULL PASSES — so coalesce(…, 0) turns "no version" into
--     a failure.
--  2. A domain CHECK runs on NULL too (a nullable uuid7 column hands it
--     NULL), and coalesce(NULL, 0) = 7 is false — so `VALUE IS NULL OR`
--     lets a NULL through; NOT NULL on the column is what refuses one.
-- gen_random_uuid() (v4) values are refused; app code and fixtures must use
-- uuidv7() / a v7 generator. Functions may keep uuid in their signatures
-- (uuid7 → uuid is implicit) — except that a PL/pgSQL RETURN QUERY compares
-- column types exactly: selecting a uuid7 column into RETURNS TABLE (x uuid)
-- fails "Returned type uuid7 does not match expected type uuid"; cast it
-- (x::uuid). SQL-language functions and RETURNING … INTO coerce. Drivers
-- see plain uuid (RowDescription sends the base type, oid 2950).
-- Arrays are NOT coerced: array_agg / ARRAY(SELECT …) over a uuid7 column
-- yields uuid7[], a distinct array type with its own (per-cluster) oid. A
-- view column of that type is reported with that oid, node-postgres has no
-- parser for it, and the app reads the string '{…}' instead of a JS array;
-- `uuid7[] <> uuid[]` has no operator, and a uuid[] function argument does
-- not accept it. Cast every such aggregate back: array_agg(x.id …)::uuid[]
-- (trailer.sql views). Step 20 refuses any column, function argument or
-- result of an array-of-domain type.
CREATE DOMAIN uuid7 AS uuid
  CONSTRAINT uuid7_version CHECK (VALUE IS NULL OR coalesce(uuid_extract_version(VALUE), 0) = 7);

-- spec §3: a 1..10 rating (mood_reading.intensity, regulation_event.intensity_*).
-- The CHECK keeps PostgreSQL's default name, intensity_check.
CREATE DOMAIN intensity AS integer CHECK (VALUE BETWEEN 1 AND 10);

-- ----------------------------------------------------------------------------
-- Enums, in schema.prisma order.
-- ----------------------------------------------------------------------------
CREATE TYPE "session_status" AS ENUM ('CREATED', 'INVITED', 'ACTIVE', 'RESOLVED', 'ABANDONED', 'ARCHIVED');
CREATE TYPE "participant_kind" AS ENUM ('human', 'modeled');
CREATE TYPE "conversation_kind" AS ENUM ('MAIN', 'SUBCHAT');
CREATE TYPE "conversation_status" AS ENUM ('ACTIVE', 'RESOLVED');
CREATE TYPE "subchat_anchor" AS ENUM ('NEEDS_BRAINSTORM', 'PROPOSAL_REFINEMENT', 'NO_OVERLAP');
CREATE TYPE "message_role" AS ENUM ('USER', 'AI', 'SYSTEM');
CREATE TYPE "message_kind" AS ENUM ('CHAT', 'EMPATHY_STATEMENT', 'EMPATHY_REVEAL_INTRO', 'SHARED_CONTEXT', 'VALIDATION_FEEDBACK', 'SHARE_SUGGESTION', 'EMPATHY_VALIDATION_PROMPT');
CREATE TYPE "draft_kind" AS ENUM ('EMPATHY', 'VALIDATION_FEEDBACK', 'SHARE_CONTEXT');
CREATE TYPE "milestone_scope" AS ENUM ('participant', 'session');
CREATE TYPE "ai_memory_kind" AS ENUM ('SUMMARY', 'NOTABLE_FACTS', 'GLOBAL_FACTS');
CREATE TYPE "regulation_type" AS ENUM ('BREATHING_EXERCISE', 'BODY_SCAN', 'GROUNDING', 'PAUSE_SESSION');
CREATE TYPE "invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');
CREATE TYPE "relationship_role" AS ENUM ('member', 'owner');
CREATE TYPE "empathy_status" AS ENUM ('HELD', 'AWAITING_SHARING', 'REFINING', 'READY', 'REVEALED', 'VALIDATED', 'SUPERSEDED');
CREATE TYPE "delivery_status" AS ENUM ('PENDING', 'DELIVERED', 'SEEN');
CREATE TYPE "share_offer_status" AS ENUM ('PENDING', 'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED');
CREATE TYPE "gap_severity" AS ENUM ('NONE', 'MINOR', 'MODERATE', 'SIGNIFICANT');
CREATE TYPE "recommender_action" AS ENUM ('PROCEED', 'OFFER_OPTIONAL', 'OFFER_SHARING');
CREATE TYPE "consent_target" AS ENUM ('NEED', 'EMPATHY_ATTEMPT', 'PROPOSAL', 'SHARE_OFFER', 'REVIEW');
CREATE TYPE "consent_decision" AS ENUM ('GRANTED', 'DENIED', 'REVOKED');
CREATE TYPE "need_category" AS ENUM ('SAFETY', 'CONNECTION', 'AUTONOMY', 'RECOGNITION', 'MEANING', 'FAIRNESS');
CREATE TYPE "need_disposition_status" AS ENUM ('OPEN', 'COVERED', 'PARTIAL', 'SKIPPED', 'DECLINED');
CREATE TYPE "proposal_source" AS ENUM ('USER_SUBMITTED', 'AI_SUGGESTED', 'CURATED');
CREATE TYPE "proposal_kind" AS ENUM ('SHARED_PROPOSAL', 'INDIVIDUAL_COMMITMENT');
CREATE TYPE "proposal_status" AS ENUM ('ACTIVE', 'REVISED', 'REMOVED', 'CONVERTED_TO_AGREEMENT');
CREATE TYPE "choice_decision" AS ENUM ('WILLING', 'NOT_WILLING');
CREATE TYPE "revision_action" AS ENUM ('CREATED', 'REVISED', 'REMOVED', 'RESTORED', 'CONVERTED', 'CAPTURE_SKIPPED', 'COVERED', 'SUBCHAT_REFINED');
CREATE TYPE "agreement_type" AS ENUM ('MICRO_EXPERIMENT', 'COMMITMENT', 'CHECK_IN', 'HYBRID');
CREATE TYPE "agreement_status" AS ENUM ('AGREED', 'IN_PROGRESS', 'COMPLETED', 'ABANDONED');
CREATE TYPE "closure_kind" AS ENUM ('SHARED_AGREEMENT', 'NO_SHARED_AGREEMENT');
CREATE TYPE "closure_reason" AS ENUM ('MUTUAL_SELECTION', 'NO_OVERLAP', 'BOUNDARY_HONORED', 'USER_STOPPED');
CREATE TYPE "follow_up_type" AS ENUM ('SCHEDULED_SHARED_AGREEMENT', 'SCHEDULED_INDIVIDUAL_COMMITMENT', 'USER_INITIATED_REENTRY');
CREATE TYPE "follow_up_scope" AS ENUM ('SHARED', 'INDIVIDUAL');
CREATE TYPE "follow_up_status" AS ENUM ('SCHEDULED', 'OPEN', 'PARTIAL', 'COMPLETED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "next_action" AS ENUM ('FULL_CLOSURE', 'EXTEND', 'ADJUST_COMMITMENT', 'REOPEN_STRATEGY_WORK', 'NEW_PROCESS', 'PARTIAL_CLOSURE');
CREATE TYPE "continue_choice" AS ENUM ('ANOTHER_ROUND', 'EXTEND', 'NEW_PROCESS', 'PARTIAL_CLOSURE', 'FULL_CLOSURE');
CREATE TYPE "reminder_scope" AS ENUM ('PRIVATE', 'SHARED');
CREATE TYPE "reminder_status" AS ENUM ('SCHEDULED', 'DELIVERED', 'CANCELLED');
CREATE TYPE "reflection_status" AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "takeaway_source" AS ENUM ('AI', 'USER');
CREATE TYPE "takeaway_type" AS ENUM ('INSIGHT', 'ACTION_ITEM', 'INTENTION');
CREATE TYPE "takeaway_link_type" AS ENUM ('AI_SEMANTIC', 'USER_MANUAL');
CREATE TYPE "memory_category" AS ENUM ('AI_NAME', 'LANGUAGE', 'COMMUNICATION', 'PERSONAL_INFO', 'RELATIONSHIP', 'PREFERENCE');
CREATE TYPE "memory_status" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');
CREATE TYPE "memory_source" AS ENUM ('USER_APPROVED', 'USER_CREATED', 'USER_EDITED');
CREATE TYPE "device_platform" AS ENUM ('ios', 'android', 'web');
CREATE TYPE "activity_type" AS ENUM ('LLM_CALL', 'EMBEDDING', 'RETRIEVAL', 'TOOL_USE');
CREATE TYPE "activity_status" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
CREATE TYPE "brain_call_type" AS ENUM ('ORCHESTRATED_RESPONSE', 'RETRIEVAL_PLANNING', 'INTENT_DETECTION', 'BACKGROUND_CLASSIFICATION', 'PARTNER_SESSION_CLASSIFICATION', 'CHAT_ROUTER_RESPONSE', 'REFERENCE_DETECTION', 'PEOPLE_EXTRACTION', 'MEMORY_DETECTION', 'MEMORY_VALIDATION', 'RECONCILER_ANALYSIS', 'SUMMARIZATION', 'NEEDS_EXTRACTION', 'WITNESSING_RESPONSE', 'MEMORY_FORMATTING', 'THEME_EXTRACTION', 'GLOBAL_MEMORY_CONSOLIDATION', 'DISTILLATION', 'CROSS_SESSION_THEME');

-- ----------------------------------------------------------------------------
-- The 47 tables, in dependency order.
-- ----------------------------------------------------------------------------

CREATE TABLE "relationship" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relationship_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "clerk_id" TEXT,
    "email" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" text
        GENERATED ALWAYS AS (nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')) STORED,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_clerk_id_key" UNIQUE ("clerk_id"),
    CONSTRAINT "user_email_key" UNIQUE ("email"),

    -- §1.7 user — a tombstone is scrubbed (P3 D9)
    CONSTRAINT chk_user_tombstone_scrubbed CHECK (deleted_at IS NULL OR (clerk_id IS NULL AND email LIKE 'deleted+%'))
);

CREATE TABLE "relationship_member" (
    "relationship_id" uuid7 NOT NULL,
    "user_id" uuid7 NOT NULL,
    "role" "relationship_role" NOT NULL DEFAULT 'member',
    "nickname" TEXT,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relationship_member_pkey" PRIMARY KEY ("relationship_id","user_id"),
    CONSTRAINT "relationship_member_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationship"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "relationship_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "relationship_member_user_id_idx" ON "relationship_member"("user_id");

CREATE TABLE "session" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "relationship_id" uuid7 NOT NULL,
    "status" "session_status" NOT NULL DEFAULT 'CREATED',
    "topic_frame" TEXT,
    "topic_frame_confirmed_at" TIMESTAMPTZ(3),
    "previous_session_id" uuid7,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "session_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationship"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "session_previous_session_id_fkey" FOREIGN KEY ("previous_session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE NO ACTION,

    -- §1.1 session [P12]
    CONSTRAINT chk_session_resolved_at CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL)
);
CREATE INDEX "session_relationship_id_idx" ON "session"("relationship_id");
CREATE INDEX "session_previous_session_id_idx" ON "session"("previous_session_id");
-- + sql_session_one_live (sql-only.sql)

CREATE TABLE "participant" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "session_id" uuid7 NOT NULL,
    "user_id" uuid7,
    "kind" "participant_kind" NOT NULL DEFAULT 'human',
    "display_name" TEXT,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "participant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "participant_session_id_user_id_key" UNIQUE ("session_id", "user_id"),
    CONSTRAINT "participant_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "participant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,

    -- §1.1 participant
    CONSTRAINT chk_participant_kind_user CHECK ((kind = 'modeled') = (user_id IS NULL))
);
CREATE INDEX "participant_user_id_idx" ON "participant"("user_id");

CREATE TABLE "proposal" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "session_id" uuid7 NOT NULL,
    "created_by_participant_id" uuid7,
    "source" "proposal_source" NOT NULL DEFAULT 'USER_SUBMITTED',
    "kind" "proposal_kind" NOT NULL DEFAULT 'SHARED_PROPOSAL',
    "status" "proposal_status" NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT NOT NULL,
    "duration" TEXT,
    "measure_of_success" TEXT,
    "unresolved_need_labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_participant_id" uuid7,
    "removal_reason" TEXT,
    "shared_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "proposal_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "proposal_created_by_participant_id_fkey" FOREIGN KEY ("created_by_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "proposal_removed_by_participant_id_fkey" FOREIGN KEY ("removed_by_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.4 proposal [P21]
    CONSTRAINT chk_proposal_removed CHECK ((status = 'REMOVED') = (removed_at IS NOT NULL)),
    CONSTRAINT chk_proposal_shared_individual CHECK (kind = 'INDIVIDUAL_COMMITMENT' OR shared_at IS NULL)
);
CREATE INDEX "proposal_session_id_status_idx" ON "proposal"("session_id", "status");
CREATE INDEX "proposal_created_by_participant_id_idx" ON "proposal"("created_by_participant_id");
CREATE INDEX "proposal_removed_by_participant_id_idx" ON "proposal"("removed_by_participant_id");

CREATE TABLE "conversation" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "participant_id" uuid7 NOT NULL,
    "kind" "conversation_kind" NOT NULL DEFAULT 'MAIN',
    "anchor_kind" "subchat_anchor",
    "anchor_proposal_id" uuid7,
    "status" "conversation_status" NOT NULL DEFAULT 'ACTIVE',
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conversation_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "conversation_anchor_proposal_id_fkey" FOREIGN KEY ("anchor_proposal_id") REFERENCES "proposal"("id") ON DELETE SET NULL ON UPDATE NO ACTION,

    -- §1.1 conversation (anchor columns are SUBCHAT-only)
    CONSTRAINT chk_conversation_anchor_kind CHECK ((kind = 'MAIN') = (anchor_kind IS NULL)),
    CONSTRAINT chk_conversation_anchor_proposal CHECK (kind = 'SUBCHAT' OR anchor_proposal_id IS NULL)
);
CREATE INDEX "conversation_participant_id_kind_status_idx" ON "conversation"("participant_id", "kind", "status");
CREATE INDEX "conversation_anchor_proposal_id_idx" ON "conversation"("anchor_proposal_id");
-- + sql_conversation_one_main (sql-only.sql)

CREATE TABLE "empathy_attempt" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "author_participant_id" uuid7 NOT NULL,
    "subject_participant_id" uuid7 NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "supersedes_attempt_id" uuid7,
    "content" TEXT NOT NULL,
    "status" "empathy_status" NOT NULL DEFAULT 'HELD',
    "status_version" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealed_at" TIMESTAMPTZ(3),
    "delivery_status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "delivered_at" TIMESTAMPTZ(3),
    "seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empathy_attempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "empathy_attempt_author_participant_id_subject_participant_i_key" UNIQUE ("author_participant_id", "subject_participant_id", "round"),
    CONSTRAINT "empathy_attempt_author_participant_id_fkey" FOREIGN KEY ("author_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "empathy_attempt_subject_participant_id_fkey" FOREIGN KEY ("subject_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "empathy_attempt_supersedes_attempt_id_fkey" FOREIGN KEY ("supersedes_attempt_id") REFERENCES "empathy_attempt"("id") ON DELETE SET NULL ON UPDATE NO ACTION,

    -- §1.2 empathy_attempt [P15b, P15d]
    CONSTRAINT chk_empathy_attempt_not_self CHECK (author_participant_id <> subject_participant_id),
    CONSTRAINT chk_empathy_attempt_revealed_at CHECK (status NOT IN ('REVEALED', 'VALIDATED') OR revealed_at IS NOT NULL)
);
CREATE INDEX "empathy_attempt_subject_participant_id_revealed_at_idx" ON "empathy_attempt"("subject_participant_id", "revealed_at");
CREATE INDEX "empathy_attempt_supersedes_attempt_id_idx" ON "empathy_attempt"("supersedes_attempt_id");
-- + sql_attempt_one_live_per_direction (sql-only.sql)

CREATE TABLE "need" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "participant_id" uuid7 NOT NULL,
    "label" TEXT NOT NULL,
    "category" "need_category" NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ai_confidence" REAL NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "superseded_by_need_id" uuid7,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "need_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "need_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "need_superseded_by_need_id_fkey" FOREIGN KEY ("superseded_by_need_id") REFERENCES "need"("id") ON DELETE SET NULL ON UPDATE NO ACTION,

    -- §1.4 need [P30]
    CONSTRAINT chk_need_confidence CHECK (ai_confidence BETWEEN 0 AND 1)
);
CREATE INDEX "need_participant_id_idx" ON "need"("participant_id");
CREATE INDEX "need_superseded_by_need_id_idx" ON "need"("superseded_by_need_id");
-- + sql_need_live (sql-only.sql)

CREATE TABLE "message" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "conversation_id" uuid7 NOT NULL,
    "sender_participant_id" uuid7,
    "role" "message_role" NOT NULL,
    "kind" "message_kind" NOT NULL DEFAULT 'CHAT',
    "content" TEXT NOT NULL,
    "content_hash" VARCHAR(64),
    "refining_need_id" uuid7,
    "source_attempt_id" uuid7,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "message_sender_participant_id_fkey" FOREIGN KEY ("sender_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "message_refining_need_id_fkey" FOREIGN KEY ("refining_need_id") REFERENCES "need"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "message_source_attempt_id_fkey" FOREIGN KEY ("source_attempt_id") REFERENCES "empathy_attempt"("id") ON DELETE SET NULL ON UPDATE NO ACTION,

    -- §1.1 message [P02] — P3 §6, "humans can't author as the facilitator"
    CONSTRAINT chk_message_user_has_sender CHECK (role <> 'USER' OR sender_participant_id IS NOT NULL),
    CONSTRAINT chk_message_ai_has_no_sender CHECK (role NOT IN ('AI', 'SYSTEM') OR sender_participant_id IS NULL)
);
CREATE INDEX "message_conversation_id_created_at_idx" ON "message"("conversation_id", "created_at");
CREATE INDEX "message_conversation_id_kind_content_hash_idx" ON "message"("conversation_id", "kind", "content_hash");
CREATE INDEX "message_sender_participant_id_idx" ON "message"("sender_participant_id");
CREATE INDEX "message_refining_need_id_idx" ON "message"("refining_need_id");
CREATE INDEX "message_source_attempt_id_idx" ON "message"("source_attempt_id");

CREATE TABLE "conversation_read_state" (
    "participant_id" uuid7 NOT NULL,
    "last_viewed_at" TIMESTAMPTZ(3),
    "last_seen_message_id" uuid7,
    "last_viewed_share_tab_at" TIMESTAMPTZ(3),
    "last_active_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_read_state_pkey" PRIMARY KEY ("participant_id"),
    CONSTRAINT "conversation_read_state_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "conversation_read_state_last_seen_message_id_fkey" FOREIGN KEY ("last_seen_message_id") REFERENCES "message"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE INDEX "conversation_read_state_last_seen_message_id_idx" ON "conversation_read_state"("last_seen_message_id");

CREATE TABLE "reconciler_result" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "attempt_id" uuid7 NOT NULL,
    "subject_participant_id" uuid7 NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 1,
    "alignment_score" INTEGER NOT NULL,
    "alignment_summary" TEXT NOT NULL,
    "gap_summary" TEXT NOT NULL,
    "gap_severity" "gap_severity" NOT NULL,
    "correctly_identified" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missed_feelings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "misattributions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "most_important_gap" TEXT,
    "recommended_action" "recommender_action" NOT NULL,
    "rationale" TEXT NOT NULL,
    "sharing_would_help" BOOLEAN NOT NULL,
    "suggested_share_focus" TEXT,
    "suggested_share_content" TEXT,
    "suggested_share_reason" TEXT,
    "circuit_breaker_tripped" BOOLEAN NOT NULL DEFAULT false,
    "superseded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciler_result_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reconciler_result_attempt_id_iteration_key" UNIQUE ("attempt_id", "iteration"),
    CONSTRAINT "reconciler_result_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "empathy_attempt"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reconciler_result_subject_participant_id_fkey" FOREIGN KEY ("subject_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.2 reconciler_result [P17f]
    CONSTRAINT chk_reconciler_result_score CHECK (alignment_score BETWEEN 0 AND 100)
);
CREATE INDEX "reconciler_result_subject_participant_id_idx" ON "reconciler_result"("subject_participant_id");
-- + sql_result_one_current (sql-only.sql)

CREATE TABLE "context_share_offer" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "attempt_id" uuid7 NOT NULL,
    "result_id" uuid7 NOT NULL,
    "subject_participant_id" uuid7 NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 1,
    "status" "share_offer_status" NOT NULL DEFAULT 'PENDING',
    "offer_message" TEXT,
    "suggested_content" TEXT,
    "suggested_reason" TEXT,
    "shared_content" TEXT,
    "shared_at" TIMESTAMPTZ(3),
    "declined_at" TIMESTAMPTZ(3),
    "offered_at" TIMESTAMPTZ(3),
    "delivery_status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "delivered_at" TIMESTAMPTZ(3),
    "seen_at" TIMESTAMPTZ(3),
    "delivery_notified_at" TIMESTAMPTZ(3),
    "seen_notified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_share_offer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "context_share_offer_attempt_id_iteration_key" UNIQUE ("attempt_id", "iteration"),
    CONSTRAINT "context_share_offer_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "empathy_attempt"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "context_share_offer_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "reconciler_result"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "context_share_offer_subject_participant_id_fkey" FOREIGN KEY ("subject_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.2 context_share_offer [P18a]
    CONSTRAINT chk_context_share_offer_accepted CHECK ((status = 'ACCEPTED') = (shared_at IS NOT NULL)),
    CONSTRAINT chk_context_share_offer_declined CHECK ((status = 'DECLINED') = (declined_at IS NOT NULL))
);
CREATE INDEX "context_share_offer_subject_participant_id_status_idx" ON "context_share_offer"("subject_participant_id", "status");
CREATE INDEX "context_share_offer_result_id_idx" ON "context_share_offer"("result_id");

CREATE TABLE "draft" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "participant_id" uuid7 NOT NULL,
    "kind" "draft_kind" NOT NULL,
    "about_participant_id" uuid7,
    "attempt_id" uuid7,
    "share_offer_id" uuid7,
    "content" TEXT NOT NULL,
    "ready_to_share" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "draft_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "draft_about_participant_id_fkey" FOREIGN KEY ("about_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "draft_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "empathy_attempt"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "draft_share_offer_id_fkey" FOREIGN KEY ("share_offer_id") REFERENCES "context_share_offer"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.1 draft — exclusive arc, and the arm matches the kind
    CONSTRAINT chk_draft_one_arc CHECK (num_nonnulls(about_participant_id, attempt_id, share_offer_id) = 1),
    CONSTRAINT chk_draft_arc_matches_kind CHECK (
            (kind = 'EMPATHY') = (about_participant_id IS NOT NULL)
        AND (kind = 'VALIDATION_FEEDBACK') = (attempt_id IS NOT NULL)
        AND (kind = 'SHARE_CONTEXT') = (share_offer_id IS NOT NULL))
);
CREATE INDEX "draft_about_participant_id_idx" ON "draft"("about_participant_id");
CREATE INDEX "draft_attempt_id_idx" ON "draft"("attempt_id");
CREATE INDEX "draft_share_offer_id_idx" ON "draft"("share_offer_id");
-- + sql_draft_one_per_point (sql-only.sql)

CREATE TABLE "milestone" (
    "key" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "stage_label" TEXT NOT NULL,
    "scope" "milestone_scope" NOT NULL DEFAULT 'participant',
    "self_assertable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestone_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "milestone_ordinal_key" UNIQUE ("ordinal")
);

CREATE TABLE "participant_milestone" (
    "participant_id" uuid7 NOT NULL,
    "milestone_key" TEXT NOT NULL,
    "reached_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "participant_milestone_pkey" PRIMARY KEY ("participant_id","milestone_key"),
    CONSTRAINT "participant_milestone_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "participant_milestone_milestone_key_fkey" FOREIGN KEY ("milestone_key") REFERENCES "milestone"("key") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "participant_milestone_milestone_key_reached_at_idx" ON "participant_milestone"("milestone_key", "reached_at");

CREATE TABLE "ai_memory" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "participant_id" uuid7,
    "user_id" uuid7,
    "kind" "ai_memory_kind" NOT NULL,
    "doc" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_memory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_memory_participant_id_kind_key" UNIQUE ("participant_id", "kind"),
    CONSTRAINT "ai_memory_user_id_kind_key" UNIQUE ("user_id", "kind"),
    CONSTRAINT "ai_memory_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "ai_memory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,

    -- §1.1 ai_memory [P28a, P28b]
    CONSTRAINT chk_ai_memory_one_owner CHECK (num_nonnulls(participant_id, user_id) = 1),
    CONSTRAINT chk_ai_memory_global_is_user CHECK ((kind = 'GLOBAL_FACTS') = (user_id IS NOT NULL)),
    CONSTRAINT chk_ai_memory_doc_object CHECK (jsonb_typeof(doc) = 'object'),
    CONSTRAINT chk_ai_memory_doc_keys CHECK (
        CASE kind WHEN 'SUMMARY' THEN doc ?& ARRAY['text', 'messageCount', 'generatedAt']
                  ELSE jsonb_typeof(doc -> 'facts') = 'array' END)
);

CREATE TABLE "mood_reading" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "participant_id" uuid7 NOT NULL,
    "intensity" intensity NOT NULL,
    "context" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mood_reading_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mood_reading_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "mood_reading_participant_id_recorded_at_idx" ON "mood_reading"("participant_id", "recorded_at");

CREATE TABLE "regulation_event" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "participant_id" uuid7 NOT NULL,
    "type" "regulation_type" NOT NULL,
    "intensity_before" intensity,
    "intensity_after" intensity,
    "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regulation_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "regulation_event_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "regulation_event_participant_id_completed_at_idx" ON "regulation_event"("participant_id", "completed_at");

CREATE TABLE "invitation" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "session_id" uuid7 NOT NULL,
    "invited_by_participant_id" uuid7 NOT NULL,
    "accepted_by_user_id" uuid7,
    "name" TEXT,
    "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
    "message_confirmed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "declined_at" TIMESTAMPTZ(3),
    "decline_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invitation_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "invitation_invited_by_participant_id_fkey" FOREIGN KEY ("invited_by_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "invitation_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,

    -- §1.1 invitation [P14a, P14b] — P3 §6
    CONSTRAINT chk_invitation_accepted CHECK (
      status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL))
);
CREATE INDEX "invitation_session_id_idx" ON "invitation"("session_id");
CREATE INDEX "invitation_invited_by_participant_id_idx" ON "invitation"("invited_by_participant_id");
CREATE INDEX "invitation_status_expires_at_idx" ON "invitation"("status", "expires_at");
CREATE INDEX "invitation_accepted_by_user_id_idx" ON "invitation"("accepted_by_user_id");

CREATE TABLE "session_key" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "session_id" uuid7 NOT NULL,
    "key_id" TEXT NOT NULL,
    "wrapped_dek" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destroyed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_key_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "session_key_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "session_key_session_id_idx" ON "session_key"("session_id");
-- + sql_session_key_live (sql-only.sql)

CREATE TABLE "participant_key" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "participant_id" uuid7 NOT NULL,
    "key_id" TEXT NOT NULL,
    "wrapped_dek" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destroyed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "participant_key_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "participant_key_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "participant_key_participant_id_idx" ON "participant_key"("participant_id");
-- + sql_participant_key_live (sql-only.sql)

CREATE TABLE "empathy_review" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "attempt_id" uuid7 NOT NULL,
    "reviewer_participant_id" uuid7 NOT NULL,
    "validated" BOOLEAN NOT NULL,
    "feedback" TEXT,
    "feedback_sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empathy_review_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "empathy_review_attempt_id_reviewer_participant_id_key" UNIQUE ("attempt_id", "reviewer_participant_id"),
    CONSTRAINT "empathy_review_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "empathy_attempt"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "empathy_review_reviewer_participant_id_fkey" FOREIGN KEY ("reviewer_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.2 empathy_review
    CONSTRAINT chk_empathy_review_feedback_sent CHECK (feedback IS NULL OR feedback_sent_at IS NOT NULL)
);
CREATE INDEX "empathy_review_reviewer_participant_id_idx" ON "empathy_review"("reviewer_participant_id");

CREATE TABLE "reconciler_guidance" (
    "result_id" uuid7 NOT NULL,
    "author_participant_id" uuid7 NOT NULL,
    "subject_participant_id" uuid7 NOT NULL,
    "area_hint" TEXT,
    "guidance_type" TEXT,
    "prompt_seed" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciler_guidance_pkey" PRIMARY KEY ("result_id"),
    CONSTRAINT "reconciler_guidance_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "reconciler_result"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reconciler_guidance_author_participant_id_fkey" FOREIGN KEY ("author_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reconciler_guidance_subject_participant_id_fkey" FOREIGN KEY ("subject_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "reconciler_guidance_author_participant_id_idx" ON "reconciler_guidance"("author_participant_id");
CREATE INDEX "reconciler_guidance_subject_participant_id_idx" ON "reconciler_guidance"("subject_participant_id");

CREATE TABLE "consent" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "participant_id" uuid7 NOT NULL,
    "requested_by_participant_id" uuid7,
    "need_id" uuid7,
    "empathy_attempt_id" uuid7,
    "proposal_id" uuid7,
    "share_offer_id" uuid7,
    "review_id" uuid7,
    "decision" "consent_decision",
    "decided_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "target_kind" consent_target NOT NULL
        GENERATED ALWAYS AS (
          CASE
            WHEN need_id IS NOT NULL THEN 'NEED'::consent_target
            WHEN empathy_attempt_id IS NOT NULL THEN 'EMPATHY_ATTEMPT'::consent_target
            WHEN proposal_id IS NOT NULL THEN 'PROPOSAL'::consent_target
            WHEN share_offer_id IS NOT NULL THEN 'SHARE_OFFER'::consent_target
            WHEN review_id IS NOT NULL THEN 'REVIEW'::consent_target
          END
        ) STORED,

    CONSTRAINT "consent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consent_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "consent_requested_by_participant_id_fkey" FOREIGN KEY ("requested_by_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "consent_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "need"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "consent_empathy_attempt_id_fkey" FOREIGN KEY ("empathy_attempt_id") REFERENCES "empathy_attempt"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "consent_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "consent_share_offer_id_fkey" FOREIGN KEY ("share_offer_id") REFERENCES "context_share_offer"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "consent_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "empathy_review"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.3 consent [P07, P19] — exclusive arc; dated decisions (P3 §6); terminal
    -- revocation; a share-offer or feedback consent has no requester (P1-4)
    CONSTRAINT chk_consent_one_target CHECK (num_nonnulls(need_id, empathy_attempt_id, proposal_id, share_offer_id, review_id) = 1),
    CONSTRAINT chk_consent_decision_dated CHECK ((decision IS NULL) = (decided_at IS NULL)),
    CONSTRAINT chk_consent_revoked CHECK (revoked_at IS NULL OR decision = 'REVOKED'),
    CONSTRAINT chk_consent_requester CHECK (requested_by_participant_id IS NULL OR target_kind IN ('NEED', 'PROPOSAL', 'EMPATHY_ATTEMPT'))
);
CREATE INDEX "consent_requested_by_participant_id_idx" ON "consent"("requested_by_participant_id");
CREATE INDEX "consent_need_id_idx" ON "consent"("need_id");
CREATE INDEX "consent_empathy_attempt_id_idx" ON "consent"("empathy_attempt_id");
CREATE INDEX "consent_proposal_id_idx" ON "consent"("proposal_id");
CREATE INDEX "consent_share_offer_id_idx" ON "consent"("share_offer_id");
CREATE INDEX "consent_review_id_idx" ON "consent"("review_id");
CREATE INDEX "consent_participant_id_decided_at_idx" ON "consent"("participant_id", "decided_at");

CREATE TABLE "need_share" (
    "need_id" uuid7 NOT NULL,
    "participant_id" uuid7 NOT NULL,
    "session_id" uuid7 NOT NULL,
    "category" "need_category" NOT NULL,
    "shared_text" TEXT NOT NULL,
    "shared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "need_share_pkey" PRIMARY KEY ("need_id"),
    CONSTRAINT "need_share_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "need"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "need_share_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "need_share_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.4 need_share [P20c]
    CONSTRAINT chk_need_share_revoked_after_shared CHECK (revoked_at IS NULL OR revoked_at >= shared_at)
);
CREATE INDEX "need_share_session_id_revoked_at_idx" ON "need_share"("session_id", "revoked_at");
CREATE INDEX "need_share_participant_id_idx" ON "need_share"("participant_id");

CREATE TABLE "need_disposition" (
    "participant_id" uuid7 NOT NULL,
    "need_id" uuid7 NOT NULL,
    "status" "need_disposition_status" NOT NULL DEFAULT 'OPEN',
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "need_disposition_pkey" PRIMARY KEY ("participant_id","need_id"),
    CONSTRAINT "need_disposition_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "need_disposition_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "need_share"("need_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "need_disposition_need_id_idx" ON "need_disposition"("need_id");
-- + sql_disposition_one_current (sql-only.sql)

CREATE TABLE "proposal_need" (
    "proposal_id" uuid7 NOT NULL,
    "need_id" uuid7 NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_need_pkey" PRIMARY KEY ("proposal_id","need_id"),
    CONSTRAINT "proposal_need_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "proposal_need_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "need_share"("need_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "proposal_need_need_id_idx" ON "proposal_need"("need_id");

CREATE TABLE "proposal_choice" (
    "proposal_id" uuid7 NOT NULL,
    "participant_id" uuid7 NOT NULL,
    "decision" "choice_decision" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_choice_pkey" PRIMARY KEY ("proposal_id","participant_id"),
    CONSTRAINT "proposal_choice_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "proposal_choice_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "proposal_choice_participant_id_idx" ON "proposal_choice"("participant_id");

CREATE TABLE "proposal_revision" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "proposal_id" uuid7 NOT NULL,
    "actor_participant_id" uuid7,
    "action" "revision_action" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "proposal_revision_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "proposal_revision_actor_participant_id_fkey" FOREIGN KEY ("actor_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.4 proposal_revision [P23c]
    CONSTRAINT chk_proposal_revision_before_object CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
    CONSTRAINT chk_proposal_revision_after_object CHECK (after IS NULL OR jsonb_typeof(after) = 'object')
);
CREATE INDEX "proposal_revision_proposal_id_created_at_idx" ON "proposal_revision"("proposal_id", "created_at");
CREATE INDEX "proposal_revision_actor_participant_id_idx" ON "proposal_revision"("actor_participant_id");

CREATE TABLE "agreement" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "session_id" uuid7 NOT NULL,
    "proposal_id" uuid7 NOT NULL,
    "type" "agreement_type" NOT NULL,
    "status" "agreement_status" NOT NULL DEFAULT 'AGREED',
    "description" TEXT NOT NULL,
    "duration" TEXT,
    "measure_of_success" TEXT,
    "follow_up_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agreement_proposal_id_key" UNIQUE ("proposal_id"),
    CONSTRAINT "agreement_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "agreement_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "agreement_session_id_status_idx" ON "agreement"("session_id", "status");

CREATE TABLE "agreement_party" (
    "agreement_id" uuid7 NOT NULL,
    "participant_id" uuid7 NOT NULL,
    "agreed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_party_pkey" PRIMARY KEY ("agreement_id","participant_id"),
    CONSTRAINT "agreement_party_agreement_id_fkey" FOREIGN KEY ("agreement_id") REFERENCES "agreement"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "agreement_party_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "agreement_party_participant_id_idx" ON "agreement_party"("participant_id");

CREATE TABLE "session_closure" (
    "session_id" uuid7 NOT NULL,
    "kind" "closure_kind" NOT NULL,
    "reason" "closure_reason" NOT NULL,
    "summary" TEXT NOT NULL,
    "closed_by_participant_id" uuid7,
    "check_in_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_closure_pkey" PRIMARY KEY ("session_id"),
    CONSTRAINT "session_closure_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "session_closure_closed_by_participant_id_fkey" FOREIGN KEY ("closed_by_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "session_closure_closed_by_participant_id_idx" ON "session_closure"("closed_by_participant_id");

CREATE TABLE "follow_up" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "session_id" uuid7 NOT NULL,
    "agreement_id" uuid7,
    "proposal_id" uuid7,
    "type" "follow_up_type" NOT NULL,
    "scope" "follow_up_scope" NOT NULL DEFAULT 'SHARED',
    "owner_participant_id" uuid7,
    "opted_in_shared" BOOLEAN NOT NULL DEFAULT false,
    "status" "follow_up_status" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_for" TIMESTAMPTZ(3),
    "response_deadline_at" TIMESTAMPTZ(3),
    "opened_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "summary" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "follow_up_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "follow_up_agreement_id_fkey" FOREIGN KEY ("agreement_id") REFERENCES "agreement"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "follow_up_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "follow_up_owner_participant_id_fkey" FOREIGN KEY ("owner_participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.5 follow_up [P24a]
    CONSTRAINT chk_follow_up_individual_owner CHECK ((scope = 'INDIVIDUAL') = (owner_participant_id IS NOT NULL)),
    CONSTRAINT chk_follow_up_one_subject CHECK (num_nonnulls(agreement_id, proposal_id) <= 1)
);
CREATE INDEX "follow_up_session_id_status_idx" ON "follow_up"("session_id", "status");
CREATE INDEX "follow_up_agreement_id_idx" ON "follow_up"("agreement_id");
CREATE INDEX "follow_up_proposal_id_idx" ON "follow_up"("proposal_id");
CREATE INDEX "follow_up_owner_participant_id_idx" ON "follow_up"("owner_participant_id");
-- + sql_follow_up_due (sql-only.sql)

CREATE TABLE "follow_up_checkin" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "follow_up_id" uuid7 NOT NULL,
    "participant_id" uuid7 NOT NULL,
    "next_action" "next_action",
    "continue_choice" "continue_choice",
    "reflection_summary" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_checkin_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "follow_up_checkin_follow_up_id_participant_id_key" UNIQUE ("follow_up_id", "participant_id"),
    CONSTRAINT "follow_up_checkin_follow_up_id_fkey" FOREIGN KEY ("follow_up_id") REFERENCES "follow_up"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "follow_up_checkin_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.5 follow_up_checkin
    CONSTRAINT chk_follow_up_checkin_payload_object CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX "follow_up_checkin_participant_id_submitted_at_idx" ON "follow_up_checkin"("participant_id", "submitted_at");

CREATE TABLE "follow_up_note" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "participant_id" uuid7 NOT NULL,
    "content" TEXT NOT NULL,
    "carry_forward" BOOLEAN NOT NULL DEFAULT false,
    "carried_into_checkin_id" uuid7,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_up_note_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "follow_up_note_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "follow_up_note_carried_into_checkin_id_fkey" FOREIGN KEY ("carried_into_checkin_id") REFERENCES "follow_up_checkin"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE INDEX "follow_up_note_participant_id_created_at_idx" ON "follow_up_note"("participant_id", "created_at");
CREATE INDEX "follow_up_note_carried_into_checkin_id_idx" ON "follow_up_note"("carried_into_checkin_id");

CREATE TABLE "reminder" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "user_id" uuid7 NOT NULL,
    "follow_up_id" uuid7,
    "scope" "reminder_scope" NOT NULL DEFAULT 'PRIVATE',
    "remind_at" TIMESTAMPTZ(3) NOT NULL,
    "cadence" TEXT,
    "note" TEXT,
    "status" "reminder_status" NOT NULL DEFAULT 'SCHEDULED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reminder_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "reminder_follow_up_id_fkey" FOREIGN KEY ("follow_up_id") REFERENCES "follow_up"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "reminder_user_id_remind_at_idx" ON "reminder"("user_id", "remind_at");
CREATE INDEX "reminder_follow_up_id_idx" ON "reminder"("follow_up_id");
-- + sql_reminder_due (sql-only.sql)

CREATE TABLE "reflection" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "user_id" uuid7 NOT NULL,
    "title" TEXT,
    "theme" TEXT,
    "status" "reflection_status" NOT NULL DEFAULT 'ACTIVE',
    "summary" TEXT,
    "summary_doc" JSONB,
    "linked_session_id" uuid7,
    "linked_at" TIMESTAMPTZ(3),
    "context_snapshot" TEXT,
    "distilled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reflection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reflection_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "reflection_linked_session_id_fkey" FOREIGN KEY ("linked_session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE NO ACTION,

    -- §1.6 reflection, takeaway_link [P31]
    CONSTRAINT chk_reflection_summary_doc_object CHECK (summary_doc IS NULL OR jsonb_typeof(summary_doc) = 'object')
);
CREATE INDEX "reflection_user_id_updated_at_idx" ON "reflection"("user_id", "updated_at");
CREATE INDEX "reflection_linked_session_id_idx" ON "reflection"("linked_session_id");
CREATE INDEX "reflection_user_id_theme_idx" ON "reflection"("user_id", "theme");

CREATE TABLE "reflection_message" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "reflection_id" uuid7 NOT NULL,
    "role" "message_role" NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reflection_message_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reflection_message_reflection_id_fkey" FOREIGN KEY ("reflection_id") REFERENCES "reflection"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "reflection_message_reflection_id_created_at_idx" ON "reflection_message"("reflection_id", "created_at");

CREATE TABLE "takeaway" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "reflection_id" uuid7 NOT NULL,
    "content" TEXT NOT NULL,
    "theme" TEXT,
    "source" "takeaway_source" NOT NULL DEFAULT 'AI',
    "type" "takeaway_type" NOT NULL DEFAULT 'INSIGHT',
    "position" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "takeaway_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "takeaway_reflection_id_fkey" FOREIGN KEY ("reflection_id") REFERENCES "reflection"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "takeaway_reflection_id_position_idx" ON "takeaway"("reflection_id", "position");

CREATE TABLE "takeaway_link" (
    "source_id" uuid7 NOT NULL,
    "target_id" uuid7 NOT NULL,
    "link_type" "takeaway_link_type" NOT NULL,
    "similarity" REAL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "takeaway_link_pkey" PRIMARY KEY ("source_id","target_id"),
    CONSTRAINT "takeaway_link_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "takeaway"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "takeaway_link_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "takeaway"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    CONSTRAINT chk_takeaway_link_not_self CHECK (source_id <> target_id)
);
CREATE INDEX "takeaway_link_target_id_idx" ON "takeaway_link"("target_id");

CREATE TABLE "user_device" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "user_id" uuid7 NOT NULL,
    "push_token" TEXT,
    "platform" "device_platform",
    "biometric_enabled" BOOLEAN NOT NULL DEFAULT false,
    "biometric_enrolled_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_device_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "user_device_user_id_idx" ON "user_device"("user_id");
-- + sql_user_device_token (sql-only.sql)

CREATE TABLE "user_preferences" (
    "user_id" uuid7 NOT NULL,
    "doc" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,

    -- §1.7 user_preferences
    CONSTRAINT chk_user_preferences_doc CHECK (
      jsonb_typeof(doc) = 'object' AND doc ?& ARRAY['memory', 'notifications', 'privacy'])
);

CREATE TABLE "user_memory" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "user_id" uuid7 NOT NULL,
    "session_id" uuid7,
    "content" TEXT NOT NULL,
    "category" "memory_category" NOT NULL,
    "status" "memory_status" NOT NULL DEFAULT 'ACTIVE',
    "source" "memory_source" NOT NULL DEFAULT 'USER_APPROVED',
    "suggested_text" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_memory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_memory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "user_memory_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "user_memory_user_id_status_idx" ON "user_memory"("user_id", "status");
CREATE INDEX "user_memory_session_id_idx" ON "user_memory"("session_id");

CREATE TABLE "feature_state" (
    "user_id" uuid7 NOT NULL,
    "feature" TEXT NOT NULL,
    "doc" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_state_pkey" PRIMARY KEY ("user_id","feature"),
    CONSTRAINT "feature_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,

    -- §1.7 feature_state
    CONSTRAINT chk_feature_state_feature CHECK (feature IN ('meditation', 'gratitude', 'needs_assessment', 'people')),
    CONSTRAINT chk_feature_state_doc_object CHECK (jsonb_typeof(doc) = 'object')
);

CREATE TABLE "user_key" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "user_id" uuid7 NOT NULL,
    "key_id" TEXT NOT NULL,
    "wrapped_dek" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destroyed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_key_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_key_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "user_key_user_id_idx" ON "user_key"("user_id");
-- + sql_user_key_live (sql-only.sql)

CREATE TABLE "brain_activity" (
    "id" uuid7 NOT NULL DEFAULT uuidv7(),
    "session_id" uuid7,
    "reflection_id" uuid7,
    "participant_id" uuid7,
    "turn_id" TEXT,
    "activity_type" "activity_type" NOT NULL,
    "call_type" "brain_call_type",
    "model" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "metadata" JSONB,
    "structured_output" JSONB,
    "token_count_input" INTEGER NOT NULL DEFAULT 0,
    "token_count_output" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "status" "activity_status" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brain_activity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "brain_activity_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "brain_activity_reflection_id_fkey" FOREIGN KEY ("reflection_id") REFERENCES "reflection"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "brain_activity_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participant"("id") ON DELETE CASCADE ON UPDATE NO ACTION,

    -- §1.8 brain_activity [P28c]
    CONSTRAINT chk_brain_activity_input_json CHECK (input IS NULL OR jsonb_typeof(input) IN ('object', 'array')),
    CONSTRAINT chk_brain_activity_output_json CHECK (output IS NULL OR jsonb_typeof(output) IN ('object', 'array')),
    CONSTRAINT chk_brain_activity_metadata_json CHECK (metadata IS NULL OR jsonb_typeof(metadata) IN ('object', 'array')),
    CONSTRAINT chk_brain_activity_structured_output_json CHECK (structured_output IS NULL OR jsonb_typeof(structured_output) IN ('object', 'array'))
);
CREATE INDEX "brain_activity_session_id_idx" ON "brain_activity"("session_id");
CREATE INDEX "brain_activity_reflection_id_idx" ON "brain_activity"("reflection_id");
CREATE INDEX "brain_activity_participant_id_idx" ON "brain_activity"("participant_id");
CREATE INDEX "brain_activity_turn_id_idx" ON "brain_activity"("turn_id");
CREATE INDEX "brain_activity_created_at_idx" ON "brain_activity"("created_at");
