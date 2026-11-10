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
-- Conventions (owner review 2026-11-10, work-gevt)
--  * Identifiers are unquoted. The one exception is "user", a reserved word
--    (pg_get_keywords() catcode R); renaming the table was judged more costly
--    than the quotes are worth.
--  * A single-column PRIMARY KEY, UNIQUE or FOREIGN KEY is written on its
--    column; a multi-column one is a table constraint.
--  * Constraints and indexes are unnamed: PostgreSQL's default names
--    (<table>_pkey, <table>_<cols>_key, <table>_<col>_fkey, <table>_<cols>_idx)
--    are exactly the names Prisma expects, and the drift gate proves it. A
--    CHECK's default name is <table>_<col>_check. An explicit name means
--    something references it; each one says what.
--  * FK actions: ON UPDATE is the default NO ACTION everywhere; ON DELETE as
--    schema.prisma says (CASCADE / SET NULL; RESTRICT for every FK to "user" (P3 D9),
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
  CHECK (VALUE IS NULL OR coalesce(uuid_extract_version(VALUE), 0) = 7);

-- spec §3: a 1..10 rating (mood_reading.intensity, regulation_event.intensity_*).
CREATE DOMAIN intensity AS integer CHECK (VALUE BETWEEN 1 AND 10);

-- ----------------------------------------------------------------------------
-- Enums, in schema.prisma order.
-- ----------------------------------------------------------------------------
CREATE TYPE session_status AS ENUM ('CREATED', 'INVITED', 'ACTIVE', 'RESOLVED', 'ABANDONED', 'ARCHIVED');
CREATE TYPE participant_kind AS ENUM ('human', 'modeled');
CREATE TYPE conversation_kind AS ENUM ('MAIN', 'SUBCHAT');
CREATE TYPE conversation_status AS ENUM ('ACTIVE', 'RESOLVED');
CREATE TYPE subchat_anchor AS ENUM ('NEEDS_BRAINSTORM', 'PROPOSAL_REFINEMENT', 'NO_OVERLAP');
CREATE TYPE message_role AS ENUM ('USER', 'AI', 'SYSTEM');
CREATE TYPE message_kind AS ENUM ('CHAT', 'EMPATHY_STATEMENT', 'EMPATHY_REVEAL_INTRO', 'SHARED_CONTEXT', 'VALIDATION_FEEDBACK', 'SHARE_SUGGESTION', 'EMPATHY_VALIDATION_PROMPT');
CREATE TYPE draft_kind AS ENUM ('EMPATHY', 'VALIDATION_FEEDBACK', 'SHARE_CONTEXT');
CREATE TYPE milestone_scope AS ENUM ('participant', 'session');
CREATE TYPE ai_memory_kind AS ENUM ('SUMMARY', 'NOTABLE_FACTS', 'GLOBAL_FACTS');
CREATE TYPE regulation_type AS ENUM ('BREATHING_EXERCISE', 'BODY_SCAN', 'GROUNDING', 'PAUSE_SESSION');
CREATE TYPE invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');
CREATE TYPE relationship_role AS ENUM ('member', 'owner');
CREATE TYPE empathy_status AS ENUM ('HELD', 'AWAITING_SHARING', 'REFINING', 'READY', 'REVEALED', 'VALIDATED', 'SUPERSEDED');
CREATE TYPE delivery_status AS ENUM ('PENDING', 'DELIVERED', 'SEEN');
CREATE TYPE share_offer_status AS ENUM ('PENDING', 'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED');
CREATE TYPE gap_severity AS ENUM ('NONE', 'MINOR', 'MODERATE', 'SIGNIFICANT');
CREATE TYPE recommender_action AS ENUM ('PROCEED', 'OFFER_OPTIONAL', 'OFFER_SHARING');
CREATE TYPE consent_target AS ENUM ('NEED', 'EMPATHY_ATTEMPT', 'PROPOSAL', 'SHARE_OFFER', 'REVIEW');
CREATE TYPE consent_decision AS ENUM ('GRANTED', 'DENIED', 'REVOKED');
CREATE TYPE need_category AS ENUM ('SAFETY', 'CONNECTION', 'AUTONOMY', 'RECOGNITION', 'MEANING', 'FAIRNESS');
CREATE TYPE need_disposition_status AS ENUM ('OPEN', 'COVERED', 'PARTIAL', 'SKIPPED', 'DECLINED');
CREATE TYPE proposal_source AS ENUM ('USER_SUBMITTED', 'AI_SUGGESTED', 'CURATED');
CREATE TYPE proposal_kind AS ENUM ('SHARED_PROPOSAL', 'INDIVIDUAL_COMMITMENT');
CREATE TYPE proposal_status AS ENUM ('ACTIVE', 'REVISED', 'REMOVED', 'CONVERTED_TO_AGREEMENT');
CREATE TYPE choice_decision AS ENUM ('WILLING', 'NOT_WILLING');
CREATE TYPE revision_action AS ENUM ('CREATED', 'REVISED', 'REMOVED', 'RESTORED', 'CONVERTED', 'CAPTURE_SKIPPED', 'COVERED', 'SUBCHAT_REFINED');
CREATE TYPE agreement_type AS ENUM ('MICRO_EXPERIMENT', 'COMMITMENT', 'CHECK_IN', 'HYBRID');
CREATE TYPE agreement_status AS ENUM ('AGREED', 'IN_PROGRESS', 'COMPLETED', 'ABANDONED');
CREATE TYPE closure_kind AS ENUM ('SHARED_AGREEMENT', 'NO_SHARED_AGREEMENT');
CREATE TYPE closure_reason AS ENUM ('MUTUAL_SELECTION', 'NO_OVERLAP', 'BOUNDARY_HONORED', 'USER_STOPPED');
CREATE TYPE follow_up_type AS ENUM ('SCHEDULED_SHARED_AGREEMENT', 'SCHEDULED_INDIVIDUAL_COMMITMENT', 'USER_INITIATED_REENTRY');
CREATE TYPE follow_up_scope AS ENUM ('SHARED', 'INDIVIDUAL');
CREATE TYPE follow_up_status AS ENUM ('SCHEDULED', 'OPEN', 'PARTIAL', 'COMPLETED', 'EXPIRED', 'CANCELLED');
CREATE TYPE next_action AS ENUM ('FULL_CLOSURE', 'EXTEND', 'ADJUST_COMMITMENT', 'REOPEN_STRATEGY_WORK', 'NEW_PROCESS', 'PARTIAL_CLOSURE');
CREATE TYPE continue_choice AS ENUM ('ANOTHER_ROUND', 'EXTEND', 'NEW_PROCESS', 'PARTIAL_CLOSURE', 'FULL_CLOSURE');
CREATE TYPE reminder_scope AS ENUM ('PRIVATE', 'SHARED');
CREATE TYPE reminder_status AS ENUM ('SCHEDULED', 'DELIVERED', 'CANCELLED');
CREATE TYPE reflection_status AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');
CREATE TYPE takeaway_source AS ENUM ('AI', 'USER');
CREATE TYPE takeaway_type AS ENUM ('INSIGHT', 'ACTION_ITEM', 'INTENTION');
CREATE TYPE takeaway_link_type AS ENUM ('AI_SEMANTIC', 'USER_MANUAL');
CREATE TYPE memory_category AS ENUM ('AI_NAME', 'LANGUAGE', 'COMMUNICATION', 'PERSONAL_INFO', 'RELATIONSHIP', 'PREFERENCE');
CREATE TYPE memory_status AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');
CREATE TYPE memory_source AS ENUM ('USER_APPROVED', 'USER_CREATED', 'USER_EDITED');
CREATE TYPE device_platform AS ENUM ('ios', 'android', 'web');
CREATE TYPE activity_type AS ENUM ('LLM_CALL', 'EMBEDDING', 'RETRIEVAL', 'TOOL_USE');
CREATE TYPE activity_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
CREATE TYPE brain_call_type AS ENUM ('ORCHESTRATED_RESPONSE', 'RETRIEVAL_PLANNING', 'INTENT_DETECTION', 'BACKGROUND_CLASSIFICATION', 'PARTNER_SESSION_CLASSIFICATION', 'CHAT_ROUTER_RESPONSE', 'REFERENCE_DETECTION', 'PEOPLE_EXTRACTION', 'MEMORY_DETECTION', 'MEMORY_VALIDATION', 'RECONCILER_ANALYSIS', 'SUMMARIZATION', 'NEEDS_EXTRACTION', 'WITNESSING_RESPONSE', 'MEMORY_FORMATTING', 'THEME_EXTRACTION', 'GLOBAL_MEMORY_CONSOLIDATION', 'DISTILLATION', 'CROSS_SESSION_THEME');

-- ----------------------------------------------------------------------------
-- The 47 tables, in dependency order.
-- ----------------------------------------------------------------------------

CREATE TABLE relationship (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "user" (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    clerk_id text UNIQUE,
    email text NOT NULL UNIQUE,
    first_name text,
    last_name text,
    deleted_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    name text
        GENERATED ALWAYS AS (nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')) STORED,

    -- §1.7 user — a tombstone is scrubbed (P3 D9)
    CHECK (deleted_at IS NULL OR (clerk_id IS NULL AND email LIKE 'deleted+%'))
);

CREATE TABLE relationship_member (
    relationship_id uuid7 NOT NULL REFERENCES relationship ON DELETE CASCADE,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    role relationship_role NOT NULL DEFAULT 'member',
    nickname text,
    joined_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (relationship_id, user_id)
);
CREATE INDEX ON relationship_member (user_id);

CREATE TABLE session (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    relationship_id uuid7 NOT NULL REFERENCES relationship ON DELETE CASCADE,
    status session_status NOT NULL DEFAULT 'CREATED',
    topic_frame text,
    topic_frame_confirmed_at timestamptz(3),
    previous_session_id uuid7 REFERENCES session ON DELETE SET NULL,
    resolved_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 session [P12]
    CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL)
);
CREATE INDEX ON session (relationship_id);
CREATE INDEX ON session (previous_session_id);
-- + sql_session_one_live (sql-only.sql)

CREATE TABLE participant (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    kind participant_kind NOT NULL DEFAULT 'human',
    display_name text,
    joined_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (session_id, user_id),
    -- §1.1 participant
    CHECK ((kind = 'modeled') = (user_id IS NULL))
);
CREATE INDEX ON participant (user_id);

CREATE TABLE proposal (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    created_by_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    source proposal_source NOT NULL DEFAULT 'USER_SUBMITTED',
    kind proposal_kind NOT NULL DEFAULT 'SHARED_PROPOSAL',
    status proposal_status NOT NULL DEFAULT 'ACTIVE',
    description text NOT NULL,
    duration text,
    measure_of_success text,
    unresolved_need_labels text[] DEFAULT ARRAY[]::text[],
    removed_at timestamptz(3),
    removed_by_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    removal_reason text,
    shared_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 proposal [P21]
    CHECK ((status = 'REMOVED') = (removed_at IS NOT NULL)),
    CHECK (kind = 'INDIVIDUAL_COMMITMENT' OR shared_at IS NULL)
);
CREATE INDEX ON proposal (session_id, status);
CREATE INDEX ON proposal (created_by_participant_id);
CREATE INDEX ON proposal (removed_by_participant_id);

CREATE TABLE conversation (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    kind conversation_kind NOT NULL DEFAULT 'MAIN',
    anchor_kind subchat_anchor,
    anchor_proposal_id uuid7 REFERENCES proposal ON DELETE SET NULL,
    status conversation_status NOT NULL DEFAULT 'ACTIVE',
    resolved_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 conversation (anchor columns are SUBCHAT-only)
    CHECK ((kind = 'MAIN') = (anchor_kind IS NULL)),
    CHECK (kind = 'SUBCHAT' OR anchor_proposal_id IS NULL)
);
CREATE INDEX ON conversation (participant_id, kind, status);
CREATE INDEX ON conversation (anchor_proposal_id);
-- + sql_conversation_one_main (sql-only.sql)

CREATE TABLE empathy_attempt (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    author_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    round integer NOT NULL DEFAULT 1,
    supersedes_attempt_id uuid7 REFERENCES empathy_attempt ON DELETE SET NULL,
    content text NOT NULL,
    status empathy_status NOT NULL DEFAULT 'HELD',
    status_version integer NOT NULL DEFAULT 0,
    submitted_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revealed_at timestamptz(3),
    delivery_status delivery_status NOT NULL DEFAULT 'PENDING',
    delivered_at timestamptz(3),
    seen_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (author_participant_id, subject_participant_id, round),
    -- §1.2 empathy_attempt [P15b, P15d]
    CHECK (author_participant_id <> subject_participant_id),
    CHECK (status NOT IN ('REVEALED', 'VALIDATED') OR revealed_at IS NOT NULL)
);
CREATE INDEX ON empathy_attempt (subject_participant_id, revealed_at);
CREATE INDEX ON empathy_attempt (supersedes_attempt_id);
-- + sql_attempt_one_live_per_direction (sql-only.sql)

CREATE TABLE need (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    label text NOT NULL,
    category need_category NOT NULL,
    evidence text[] DEFAULT ARRAY[]::text[],
    ai_confidence real NOT NULL,
    confirmed_at timestamptz(3),
    locked_at timestamptz(3),
    superseded_by_need_id uuid7 REFERENCES need ON DELETE SET NULL,
    deleted_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 need [P30]
    CHECK (ai_confidence BETWEEN 0 AND 1)
);
CREATE INDEX ON need (participant_id);
CREATE INDEX ON need (superseded_by_need_id);
-- + sql_need_live (sql-only.sql)

CREATE TABLE message (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    conversation_id uuid7 NOT NULL REFERENCES conversation ON DELETE CASCADE,
    sender_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    role message_role NOT NULL,
    kind message_kind NOT NULL DEFAULT 'CHAT',
    content text NOT NULL,
    content_hash varchar(64),
    refining_need_id uuid7 REFERENCES need ON DELETE SET NULL,
    source_attempt_id uuid7 REFERENCES empathy_attempt ON DELETE SET NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 message [P02] — P3 §6, "humans can't author as the facilitator"
    CHECK (role <> 'USER' OR sender_participant_id IS NOT NULL),
    CHECK (role NOT IN ('AI', 'SYSTEM') OR sender_participant_id IS NULL)
);
CREATE INDEX ON message (conversation_id, created_at);
CREATE INDEX ON message (conversation_id, kind, content_hash);
CREATE INDEX ON message (sender_participant_id);
CREATE INDEX ON message (refining_need_id);
CREATE INDEX ON message (source_attempt_id);

CREATE TABLE conversation_read_state (
    participant_id uuid7 NOT NULL PRIMARY KEY REFERENCES participant ON DELETE CASCADE,
    last_viewed_at timestamptz(3),
    last_seen_message_id uuid7 REFERENCES message ON DELETE SET NULL,
    last_viewed_share_tab_at timestamptz(3),
    last_active_at timestamptz(3),
    archived_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON conversation_read_state (last_seen_message_id);

CREATE TABLE reconciler_result (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    iteration integer NOT NULL DEFAULT 1,
    alignment_score integer NOT NULL,
    alignment_summary text NOT NULL,
    gap_summary text NOT NULL,
    gap_severity gap_severity NOT NULL,
    correctly_identified text[] DEFAULT ARRAY[]::text[],
    missed_feelings text[] DEFAULT ARRAY[]::text[],
    misattributions text[] DEFAULT ARRAY[]::text[],
    most_important_gap text,
    recommended_action recommender_action NOT NULL,
    rationale text NOT NULL,
    sharing_would_help boolean NOT NULL,
    suggested_share_focus text,
    suggested_share_content text,
    suggested_share_reason text,
    circuit_breaker_tripped boolean NOT NULL DEFAULT false,
    superseded_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (attempt_id, iteration),
    -- §1.2 reconciler_result [P17f]
    CHECK (alignment_score BETWEEN 0 AND 100)
);
CREATE INDEX ON reconciler_result (subject_participant_id);
-- + sql_result_one_current (sql-only.sql)

CREATE TABLE context_share_offer (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    result_id uuid7 NOT NULL REFERENCES reconciler_result ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    iteration integer NOT NULL DEFAULT 1,
    status share_offer_status NOT NULL DEFAULT 'PENDING',
    offer_message text,
    suggested_content text,
    suggested_reason text,
    shared_content text,
    shared_at timestamptz(3),
    declined_at timestamptz(3),
    offered_at timestamptz(3),
    delivery_status delivery_status NOT NULL DEFAULT 'PENDING',
    delivered_at timestamptz(3),
    seen_at timestamptz(3),
    delivery_notified_at timestamptz(3),
    seen_notified_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (attempt_id, iteration),
    -- §1.2 context_share_offer [P18a]
    CHECK ((status = 'ACCEPTED') = (shared_at IS NOT NULL)),
    CHECK ((status = 'DECLINED') = (declined_at IS NOT NULL))
);
CREATE INDEX ON context_share_offer (subject_participant_id, status);
CREATE INDEX ON context_share_offer (result_id);

CREATE TABLE milestone (
    key text NOT NULL PRIMARY KEY,
    ordinal integer NOT NULL UNIQUE,
    stage_label text NOT NULL,
    scope milestone_scope NOT NULL DEFAULT 'participant',
    self_assertable boolean NOT NULL DEFAULT false,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE participant_milestone (
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    milestone_key text NOT NULL REFERENCES milestone ON DELETE RESTRICT,
    reached_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (participant_id, milestone_key)
);
CREATE INDEX ON participant_milestone (milestone_key, reached_at);

CREATE TABLE ai_memory (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    kind ai_memory_kind NOT NULL,
    doc jsonb NOT NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (participant_id, kind),
    UNIQUE (user_id, kind),
    -- §1.1 ai_memory [P28a, P28b]
    CHECK (num_nonnulls(participant_id, user_id) = 1),
    CHECK ((kind = 'GLOBAL_FACTS') = (user_id IS NOT NULL)),
    CHECK (jsonb_typeof(doc) = 'object'),
    CHECK (
        CASE kind WHEN 'SUMMARY' THEN doc ?& ARRAY['text', 'messageCount', 'generatedAt']
                  ELSE jsonb_typeof(doc -> 'facts') = 'array' END)
);

CREATE TABLE mood_reading (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    intensity intensity NOT NULL,
    context text,
    recorded_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON mood_reading (participant_id, recorded_at);

CREATE TABLE regulation_event (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    type regulation_type NOT NULL,
    intensity_before intensity,
    intensity_after intensity,
    completed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON regulation_event (participant_id, completed_at);

CREATE TABLE invitation (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    invited_by_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    accepted_by_user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    name text,
    status invitation_status NOT NULL DEFAULT 'PENDING',
    message_confirmed_at timestamptz(3),
    expires_at timestamptz(3) NOT NULL,
    accepted_at timestamptz(3),
    declined_at timestamptz(3),
    decline_reason text,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 invitation [P14a, P14b] — P3 §6
    CHECK (
      status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL))
);
CREATE INDEX ON invitation (session_id);
CREATE INDEX ON invitation (invited_by_participant_id);
CREATE INDEX ON invitation (status, expires_at);
CREATE INDEX ON invitation (accepted_by_user_id);

CREATE TABLE draft (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    kind draft_kind NOT NULL,
    about_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    attempt_id uuid7 REFERENCES empathy_attempt ON DELETE CASCADE,
    share_offer_id uuid7 REFERENCES context_share_offer ON DELETE CASCADE,
    invitation_id uuid7 REFERENCES invitation ON DELETE CASCADE,
    content text NOT NULL,
    ready_to_share boolean NOT NULL DEFAULT false,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reopened_at timestamptz(3),

    -- §1.1 draft — exclusive arc, and the arm matches the kind. An EMPATHY
    -- draft is about the partner's participant, or — written before the
    -- partner has joined — about the pending invitation; accepting the
    -- invitation re-points it to the new participant (work-99k2).
    CHECK (num_nonnulls(about_participant_id, invitation_id, attempt_id, share_offer_id) = 1),
    CHECK (
            (kind = 'EMPATHY') = (about_participant_id IS NOT NULL OR invitation_id IS NOT NULL)
        AND (kind = 'VALIDATION_FEEDBACK') = (attempt_id IS NOT NULL)
        AND (kind = 'SHARE_CONTEXT') = (share_offer_id IS NOT NULL)),
    -- work-9309: reopened_at marks an EMPATHY draft the author chose to "Edit
    -- first" after the partner joined, until the next draft write (the AI's
    -- proposal or the author's save) clears it.
    CHECK (reopened_at IS NULL OR kind = 'EMPATHY')
);
CREATE INDEX ON draft (about_participant_id);
CREATE INDEX ON draft (attempt_id);
CREATE INDEX ON draft (share_offer_id);
CREATE INDEX ON draft (invitation_id);
-- + sql_draft_one_per_point (sql-only.sql)

CREATE TABLE session_key (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    key_id text NOT NULL,
    wrapped_dek bytea NOT NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    destroyed_at timestamptz(3),
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON session_key (session_id);
-- + sql_session_key_live (sql-only.sql)

CREATE TABLE participant_key (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    key_id text NOT NULL,
    wrapped_dek bytea NOT NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    destroyed_at timestamptz(3),
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON participant_key (participant_id);
-- + sql_participant_key_live (sql-only.sql)

CREATE TABLE empathy_review (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    reviewer_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    validated boolean NOT NULL,
    feedback text,
    feedback_sent_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (attempt_id, reviewer_participant_id),
    -- §1.2 empathy_review
    CHECK (feedback IS NULL OR feedback_sent_at IS NOT NULL)
);
CREATE INDEX ON empathy_review (reviewer_participant_id);

CREATE TABLE reconciler_guidance (
    result_id uuid7 NOT NULL PRIMARY KEY REFERENCES reconciler_result ON DELETE CASCADE,
    author_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    area_hint text,
    guidance_type text,
    prompt_seed text,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON reconciler_guidance (author_participant_id);
CREATE INDEX ON reconciler_guidance (subject_participant_id);

CREATE TABLE consent (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    requested_by_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    need_id uuid7 REFERENCES need ON DELETE CASCADE,
    empathy_attempt_id uuid7 REFERENCES empathy_attempt ON DELETE CASCADE,
    proposal_id uuid7 REFERENCES proposal ON DELETE CASCADE,
    share_offer_id uuid7 REFERENCES context_share_offer ON DELETE CASCADE,
    review_id uuid7 REFERENCES empathy_review ON DELETE CASCADE,
    decision consent_decision,
    decided_at timestamptz(3),
    revoked_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    target_kind consent_target NOT NULL
        GENERATED ALWAYS AS (
          CASE
            WHEN need_id IS NOT NULL THEN 'NEED'::consent_target
            WHEN empathy_attempt_id IS NOT NULL THEN 'EMPATHY_ATTEMPT'::consent_target
            WHEN proposal_id IS NOT NULL THEN 'PROPOSAL'::consent_target
            WHEN share_offer_id IS NOT NULL THEN 'SHARE_OFFER'::consent_target
            WHEN review_id IS NOT NULL THEN 'REVIEW'::consent_target
          END
        ) STORED,

    -- §1.3 consent [P07, P19] — exclusive arc; dated decisions (P3 §6); terminal
    -- revocation; a share-offer or feedback consent has no requester (P1-4)
    CHECK (num_nonnulls(need_id, empathy_attempt_id, proposal_id, share_offer_id, review_id) = 1),
    CHECK ((decision IS NULL) = (decided_at IS NULL)),
    CHECK (revoked_at IS NULL OR decision = 'REVOKED'),
    -- Named: consent-arc.target.test.ts asserts this name in the error.
    CONSTRAINT chk_consent_requester CHECK (requested_by_participant_id IS NULL OR target_kind IN ('NEED', 'PROPOSAL', 'EMPATHY_ATTEMPT'))
);
CREATE INDEX ON consent (requested_by_participant_id);
CREATE INDEX ON consent (need_id);
CREATE INDEX ON consent (empathy_attempt_id);
CREATE INDEX ON consent (proposal_id);
CREATE INDEX ON consent (share_offer_id);
CREATE INDEX ON consent (review_id);
CREATE INDEX ON consent (participant_id, decided_at);

CREATE TABLE need_share (
    need_id uuid7 NOT NULL PRIMARY KEY REFERENCES need ON DELETE RESTRICT,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    category need_category NOT NULL,
    shared_text text NOT NULL,
    shared_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 need_share [P20c]
    CHECK (revoked_at IS NULL OR revoked_at >= shared_at)
);
CREATE INDEX ON need_share (session_id, revoked_at);
CREATE INDEX ON need_share (participant_id);

CREATE TABLE need_disposition (
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    need_id uuid7 NOT NULL REFERENCES need_share ON DELETE CASCADE,
    status need_disposition_status NOT NULL DEFAULT 'OPEN',
    is_current boolean NOT NULL DEFAULT false,
    note text,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (participant_id, need_id)
);
CREATE INDEX ON need_disposition (need_id);
-- + sql_disposition_one_current (sql-only.sql)

CREATE TABLE proposal_need (
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    need_id uuid7 NOT NULL REFERENCES need_share ON DELETE CASCADE,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (proposal_id, need_id)
);
CREATE INDEX ON proposal_need (need_id);

CREATE TABLE proposal_choice (
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    decision choice_decision NOT NULL,
    note text,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (proposal_id, participant_id)
);
CREATE INDEX ON proposal_choice (participant_id);

CREATE TABLE proposal_revision (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    actor_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    action revision_action NOT NULL,
    before jsonb,
    after jsonb,
    reason text,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 proposal_revision [P23c]
    CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
    CHECK (after IS NULL OR jsonb_typeof(after) = 'object')
);
CREATE INDEX ON proposal_revision (proposal_id, created_at);
CREATE INDEX ON proposal_revision (actor_participant_id);

CREATE TABLE agreement (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    proposal_id uuid7 NOT NULL UNIQUE REFERENCES proposal ON DELETE RESTRICT,
    type agreement_type NOT NULL,
    status agreement_status NOT NULL DEFAULT 'AGREED',
    description text NOT NULL,
    duration text,
    measure_of_success text,
    follow_up_at timestamptz(3),
    completed_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON agreement (session_id, status);

CREATE TABLE agreement_party (
    agreement_id uuid7 NOT NULL REFERENCES agreement ON DELETE CASCADE,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    agreed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (agreement_id, participant_id)
);
CREATE INDEX ON agreement_party (participant_id);

CREATE TABLE session_closure (
    session_id uuid7 NOT NULL PRIMARY KEY REFERENCES session ON DELETE CASCADE,
    kind closure_kind NOT NULL,
    reason closure_reason NOT NULL,
    summary text NOT NULL,
    closed_by_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    check_in_at timestamptz(3),
    closed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON session_closure (closed_by_participant_id);

CREATE TABLE follow_up (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    agreement_id uuid7 REFERENCES agreement ON DELETE CASCADE,
    proposal_id uuid7 REFERENCES proposal ON DELETE CASCADE,
    type follow_up_type NOT NULL,
    scope follow_up_scope NOT NULL DEFAULT 'SHARED',
    owner_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    opted_in_shared boolean NOT NULL DEFAULT false,
    status follow_up_status NOT NULL DEFAULT 'SCHEDULED',
    scheduled_for timestamptz(3),
    response_deadline_at timestamptz(3),
    opened_at timestamptz(3),
    completed_at timestamptz(3),
    summary text,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.5 follow_up [P24a]
    CHECK ((scope = 'INDIVIDUAL') = (owner_participant_id IS NOT NULL)),
    CHECK (num_nonnulls(agreement_id, proposal_id) <= 1)
);
CREATE INDEX ON follow_up (session_id, status);
CREATE INDEX ON follow_up (agreement_id);
CREATE INDEX ON follow_up (proposal_id);
CREATE INDEX ON follow_up (owner_participant_id);
-- + sql_follow_up_due (sql-only.sql)

CREATE TABLE follow_up_checkin (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    follow_up_id uuid7 NOT NULL REFERENCES follow_up ON DELETE CASCADE,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    next_action next_action,
    continue_choice continue_choice,
    reflection_summary text,
    payload jsonb NOT NULL DEFAULT '{}',
    submitted_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (follow_up_id, participant_id),
    -- §1.5 follow_up_checkin
    CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX ON follow_up_checkin (participant_id, submitted_at);

CREATE TABLE follow_up_note (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    content text NOT NULL,
    carry_forward boolean NOT NULL DEFAULT false,
    carried_into_checkin_id uuid7 REFERENCES follow_up_checkin ON DELETE SET NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON follow_up_note (participant_id, created_at);
CREATE INDEX ON follow_up_note (carried_into_checkin_id);

CREATE TABLE reminder (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    follow_up_id uuid7 REFERENCES follow_up ON DELETE CASCADE,
    scope reminder_scope NOT NULL DEFAULT 'PRIVATE',
    remind_at timestamptz(3) NOT NULL,
    cadence text,
    note text,
    status reminder_status NOT NULL DEFAULT 'SCHEDULED',
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON reminder (user_id, remind_at);
CREATE INDEX ON reminder (follow_up_id);
-- + sql_reminder_due (sql-only.sql)

CREATE TABLE reflection (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    title text,
    theme text,
    status reflection_status NOT NULL DEFAULT 'ACTIVE',
    summary text,
    summary_doc jsonb,
    linked_session_id uuid7 REFERENCES session ON DELETE SET NULL,
    linked_at timestamptz(3),
    context_snapshot text,
    distilled_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.6 reflection, takeaway_link [P31]
    CHECK (summary_doc IS NULL OR jsonb_typeof(summary_doc) = 'object')
);
CREATE INDEX ON reflection (user_id, updated_at);
CREATE INDEX ON reflection (linked_session_id);
CREATE INDEX ON reflection (user_id, theme);

CREATE TABLE reflection_message (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    reflection_id uuid7 NOT NULL REFERENCES reflection ON DELETE CASCADE,
    role message_role NOT NULL,
    content text NOT NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON reflection_message (reflection_id, created_at);

CREATE TABLE takeaway (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    reflection_id uuid7 NOT NULL REFERENCES reflection ON DELETE CASCADE,
    content text NOT NULL,
    theme text,
    source takeaway_source NOT NULL DEFAULT 'AI',
    type takeaway_type NOT NULL DEFAULT 'INSIGHT',
    position integer NOT NULL DEFAULT 0,
    resolved_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON takeaway (reflection_id, position);

CREATE TABLE takeaway_link (
    source_id uuid7 NOT NULL REFERENCES takeaway ON DELETE CASCADE,
    target_id uuid7 NOT NULL REFERENCES takeaway ON DELETE CASCADE,
    link_type takeaway_link_type NOT NULL,
    similarity real,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (source_id, target_id),
    CHECK (source_id <> target_id)
);
CREATE INDEX ON takeaway_link (target_id);

CREATE TABLE user_device (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    push_token text,
    platform device_platform,
    biometric_enabled boolean NOT NULL DEFAULT false,
    biometric_enrolled_at timestamptz(3),
    last_seen_at timestamptz(3),
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON user_device (user_id);
-- + sql_user_device_token (sql-only.sql)

CREATE TABLE user_preferences (
    user_id uuid7 NOT NULL PRIMARY KEY REFERENCES "user" ON DELETE RESTRICT,
    doc jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.7 user_preferences
    CHECK (
      jsonb_typeof(doc) = 'object' AND doc ?& ARRAY['memory', 'notifications', 'privacy'])
);

CREATE TABLE user_memory (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    session_id uuid7 REFERENCES session ON DELETE CASCADE,
    content text NOT NULL,
    category memory_category NOT NULL,
    status memory_status NOT NULL DEFAULT 'ACTIVE',
    source memory_source NOT NULL DEFAULT 'USER_APPROVED',
    suggested_text text,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON user_memory (user_id, status);
CREATE INDEX ON user_memory (session_id);

CREATE TABLE feature_state (
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    feature text NOT NULL,
    doc jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, feature),
    -- §1.7 feature_state
    CHECK (feature IN ('meditation', 'gratitude', 'needs_assessment', 'people')),
    CHECK (jsonb_typeof(doc) = 'object')
);

CREATE TABLE user_key (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    key_id text NOT NULL,
    wrapped_dek bytea NOT NULL,
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    destroyed_at timestamptz(3),
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON user_key (user_id);
-- + sql_user_key_live (sql-only.sql)

CREATE TABLE brain_activity (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 REFERENCES session ON DELETE CASCADE,
    reflection_id uuid7 REFERENCES reflection ON DELETE CASCADE,
    participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    turn_id text,
    activity_type activity_type NOT NULL,
    call_type brain_call_type,
    model text NOT NULL,
    input jsonb,
    output jsonb,
    metadata jsonb,
    structured_output jsonb,
    token_count_input integer NOT NULL DEFAULT 0,
    token_count_output integer NOT NULL DEFAULT 0,
    duration_ms integer NOT NULL DEFAULT 0,
    cost numeric(10,6) NOT NULL DEFAULT 0,
    status activity_status NOT NULL DEFAULT 'PENDING',
    created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamptz(3),
    updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.8 brain_activity [P28c]
    CHECK (input IS NULL OR jsonb_typeof(input) IN ('object', 'array')),
    CHECK (output IS NULL OR jsonb_typeof(output) IN ('object', 'array')),
    CHECK (metadata IS NULL OR jsonb_typeof(metadata) IN ('object', 'array')),
    CHECK (structured_output IS NULL OR jsonb_typeof(structured_output) IN ('object', 'array'))
);
CREATE INDEX ON brain_activity (session_id);
CREATE INDEX ON brain_activity (reflection_id);
CREATE INDEX ON brain_activity (participant_id);
CREATE INDEX ON brain_activity (turn_id);
CREATE INDEX ON brain_activity (created_at);
