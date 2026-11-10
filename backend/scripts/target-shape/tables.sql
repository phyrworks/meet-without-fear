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
--  * Every table, enum and domain has a COMMENT ON straight after it, and so
--    does every column whose meaning is not obvious from its name; the
--    sql_ indexes are commented in sql-only.sql. They are the catalog's
--    documentation (\d+ in psql); keep them one or two sentences.
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
-- Domains. All are invisible to Prisma: a uuid7 column introspects as
-- String @db.Uuid, a ts_ms column as DateTime @db.Timestamptz(3), an
-- intensity column as Int, and `migrate diff` reports nothing (TS-6 probe for
-- intensity, 2026-10-19; work-a39h.11.40 probe for uuid7, 2026-11-02;
-- work-gevt for ts_ms, 2026-11-10; PG 18.6 / Prisma 7.10).
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
COMMENT ON DOMAIN uuid7 IS 'A version-7 UUID (RFC 9562), so ids sort by creation time; every id column and every column referencing one. NULL passes (the column''s NOT NULL refuses it); a non-v7 value such as gen_random_uuid() is refused.';

-- Every timestamp column is a ts_ms: a timestamptz rounded to milliseconds.
-- A JS Date holds milliseconds, so a microsecond value written by PostgreSQL
-- (now(), a trigger, a default) would not survive the round trip through the
-- app: the value the app reads back is not the stored one. That breaks keyset
-- pagination (the cursor no longer equals the row), forward-only instants
-- (a re-written value can move backwards by < 1 ms) and exact-equality checks.
-- Prisma's own default for DateTime is timestamptz(3). The domain rounds on
-- every write (a default, a trigger's now(), a literal), and drivers see plain
-- timestamptz (RowDescription sends the base type, oid 1184, typmod 3); as with
-- uuid7, an array over it is ts_ms[] and step 20 refuses one.
CREATE DOMAIN ts_ms AS timestamptz(3);
COMMENT ON DOMAIN ts_ms IS 'A timestamptz rounded to milliseconds; every timestamp column. A JS Date holds milliseconds, so a microsecond value would not round-trip, breaking keyset pagination, forward-only instants and exact-equality checks; Prisma''s DateTime default is timestamptz(3).';

-- spec §3: a 1..10 rating (mood_reading.intensity, regulation_event.intensity_*).
CREATE DOMAIN intensity AS integer CHECK (VALUE BETWEEN 1 AND 10);
COMMENT ON DOMAIN intensity IS 'A 1-10 self-rated intensity (mood_reading.intensity, regulation_event.intensity_before/after).';

-- ----------------------------------------------------------------------------
-- Enums, in schema.prisma order.
-- ----------------------------------------------------------------------------
CREATE TYPE session_status AS ENUM ('CREATED', 'INVITED', 'ACTIVE', 'RESOLVED', 'ABANDONED', 'ARCHIVED');
COMMENT ON TYPE session_status IS 'Lifecycle of a session. Written only by app.session_set_status(): CREATED -> INVITED -> ACTIVE -> RESOLVED, any live state -> ABANDONED, RESOLVED/ABANDONED -> ARCHIVED.';
CREATE TYPE participant_kind AS ENUM ('human', 'modeled');
COMMENT ON TYPE participant_kind IS 'human: a participant backed by a user; modeled: an imagined participant with no user row (user_id IS NULL).';
CREATE TYPE conversation_kind AS ENUM ('MAIN', 'SUBCHAT');
COMMENT ON TYPE conversation_kind IS 'MAIN: the participant''s one private thread with the AI guide; SUBCHAT: a Stage-4 side conversation anchored on a topic.';
CREATE TYPE conversation_status AS ENUM ('ACTIVE', 'RESOLVED');
COMMENT ON TYPE conversation_status IS 'Whether a conversation (in practice a Stage-4 sub-chat) is still open.';
CREATE TYPE subchat_anchor AS ENUM ('NEEDS_BRAINSTORM', 'PROPOSAL_REFINEMENT', 'NO_OVERLAP');
COMMENT ON TYPE subchat_anchor IS 'What a Stage-4 sub-chat is about: brainstorming for a need, refining one proposal, or the no-overlap path.';
CREATE TYPE message_role AS ENUM ('USER', 'AI', 'SYSTEM');
COMMENT ON TYPE message_role IS 'Who wrote a line: the human (USER), the AI guide (AI) or the app (SYSTEM). Also used by reflection_message.';
CREATE TYPE message_kind AS ENUM ('CHAT', 'EMPATHY_STATEMENT', 'EMPATHY_REVEAL_INTRO', 'SHARED_CONTEXT', 'VALIDATION_FEEDBACK', 'SHARE_SUGGESTION', 'EMPATHY_VALIDATION_PROMPT');
COMMENT ON TYPE message_kind IS 'CHAT for an ordinary turn; every other member is an item delivered across participants (an empathy statement, shared context, validation feedback, a share suggestion and their prompts).';
CREATE TYPE draft_kind AS ENUM ('EMPATHY', 'VALIDATION_FEEDBACK', 'SHARE_CONTEXT');
COMMENT ON TYPE draft_kind IS 'The sharing point a draft is for; it decides which of draft''s arc columns is set.';
CREATE TYPE milestone_scope AS ENUM ('participant', 'session');
COMMENT ON TYPE milestone_scope IS 'participant: each participant reaches the milestone on their own; session: every present participant must reach it for the session to move on.';
CREATE TYPE ai_memory_kind AS ENUM ('SUMMARY', 'NOTABLE_FACTS', 'GLOBAL_FACTS');
COMMENT ON TYPE ai_memory_kind IS 'SUMMARY and NOTABLE_FACTS belong to a participant (one session); GLOBAL_FACTS belong to a user (across sessions).';
CREATE TYPE regulation_type AS ENUM ('BREATHING_EXERCISE', 'BODY_SCAN', 'GROUNDING', 'PAUSE_SESSION');
COMMENT ON TYPE regulation_type IS 'The emotional-regulation exercise a participant completed.';
CREATE TYPE invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');
COMMENT ON TYPE invitation_status IS 'Lifecycle of an invitation: PENDING until accepted, declined or past expires_at.';
CREATE TYPE relationship_role AS ENUM ('member', 'owner');
COMMENT ON TYPE relationship_role IS 'A member''s role in a relationship: the owner who created it, or a member.';
CREATE TYPE empathy_status AS ENUM ('HELD', 'AWAITING_SHARING', 'REFINING', 'READY', 'REVEALED', 'VALIDATED', 'SUPERSEDED');
COMMENT ON TYPE empathy_status IS 'Lifecycle of an empathy attempt, written only by the app''s transition function: HELD -> (AWAITING_SHARING | REFINING) -> READY -> REVEALED -> VALIDATED, or SUPERSEDED by a newer round.';
CREATE TYPE delivery_status AS ENUM ('PENDING', 'DELIVERED', 'SEEN');
COMMENT ON TYPE delivery_status IS 'Delivery of an item to its recipient: PENDING, DELIVERED (in their conversation), SEEN.';
CREATE TYPE share_offer_status AS ENUM ('PENDING', 'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED');
COMMENT ON TYPE share_offer_status IS 'Lifecycle of a suggestion to the subject to share context: PENDING, OFFERED, then ACCEPTED, DECLINED or EXPIRED.';
CREATE TYPE gap_severity AS ENUM ('NONE', 'MINOR', 'MODERATE', 'SIGNIFICANT');
COMMENT ON TYPE gap_severity IS 'The reconciler''s rating of the gap between an empathy attempt and the subject''s own account.';
CREATE TYPE recommender_action AS ENUM ('PROCEED', 'OFFER_OPTIONAL', 'OFFER_SHARING');
COMMENT ON TYPE recommender_action IS 'The reconciler''s recommendation: proceed to the reveal, or offer the subject the option or a nudge to share context.';
CREATE TYPE consent_target AS ENUM ('NEED', 'EMPATHY_ATTEMPT', 'PROPOSAL', 'SHARE_OFFER', 'REVIEW');
COMMENT ON TYPE consent_target IS 'The kind of thing a consent row decides on; consent.target_kind is generated from which arc column is set.';
CREATE TYPE consent_decision AS ENUM ('GRANTED', 'DENIED', 'REVOKED');
COMMENT ON TYPE consent_decision IS 'A consent decision: GRANTED or DENIED once, then optionally REVOKED (terminal).';
CREATE TYPE need_category AS ENUM ('SAFETY', 'CONNECTION', 'AUTONOMY', 'RECOGNITION', 'MEANING', 'FAIRNESS');
COMMENT ON TYPE need_category IS 'The six need categories the needs mapping uses.';
CREATE TYPE need_disposition_status AS ENUM ('OPEN', 'COVERED', 'PARTIAL', 'SKIPPED', 'DECLINED');
COMMENT ON TYPE need_disposition_status IS 'How a participant dispositions a need during the Stage-4 walkthrough.';
CREATE TYPE proposal_source AS ENUM ('USER_SUBMITTED', 'AI_SUGGESTED', 'CURATED');
COMMENT ON TYPE proposal_source IS 'Where a proposal came from: typed by a participant, suggested by the AI, or from the curated library.';
CREATE TYPE proposal_kind AS ENUM ('SHARED_PROPOSAL', 'INDIVIDUAL_COMMITMENT');
COMMENT ON TYPE proposal_kind IS 'A shared proposal for both participants, or an individual commitment by one.';
CREATE TYPE proposal_status AS ENUM ('ACTIVE', 'REVISED', 'REMOVED', 'CONVERTED_TO_AGREEMENT');
COMMENT ON TYPE proposal_status IS 'Lifecycle of a proposal: ACTIVE, REVISED (superseded by an edit), REMOVED, or CONVERTED_TO_AGREEMENT.';
CREATE TYPE choice_decision AS ENUM ('WILLING', 'NOT_WILLING');
COMMENT ON TYPE choice_decision IS 'A participant''s willingness on a proposal.';
CREATE TYPE revision_action AS ENUM ('CREATED', 'REVISED', 'REMOVED', 'RESTORED', 'CONVERTED', 'CAPTURE_SKIPPED', 'COVERED', 'SUBCHAT_REFINED');
COMMENT ON TYPE revision_action IS 'What a proposal_revision row records.';
CREATE TYPE agreement_type AS ENUM ('MICRO_EXPERIMENT', 'COMMITMENT', 'CHECK_IN', 'HYBRID');
COMMENT ON TYPE agreement_type IS 'The shape of an agreement: a micro-experiment, a commitment, a check-in, or a mix.';
CREATE TYPE agreement_status AS ENUM ('AGREED', 'IN_PROGRESS', 'COMPLETED', 'ABANDONED');
COMMENT ON TYPE agreement_status IS 'Lifecycle of an agreement after it is made.';
CREATE TYPE closure_kind AS ENUM ('SHARED_AGREEMENT', 'NO_SHARED_AGREEMENT');
COMMENT ON TYPE closure_kind IS 'Whether the repair stage ended with a shared agreement or without one.';
CREATE TYPE closure_reason AS ENUM ('MUTUAL_SELECTION', 'NO_OVERLAP', 'BOUNDARY_HONORED', 'USER_STOPPED');
COMMENT ON TYPE closure_reason IS 'Why the repair stage ended.';
CREATE TYPE follow_up_type AS ENUM ('SCHEDULED_SHARED_AGREEMENT', 'SCHEDULED_INDIVIDUAL_COMMITMENT', 'USER_INITIATED_REENTRY');
COMMENT ON TYPE follow_up_type IS 'What a follow-up checks on: a shared agreement, an individual commitment, or a re-entry the user started.';
CREATE TYPE follow_up_scope AS ENUM ('SHARED', 'INDIVIDUAL');
COMMENT ON TYPE follow_up_scope IS 'SHARED: both participants check in; INDIVIDUAL: only owner_participant_id does.';
CREATE TYPE follow_up_status AS ENUM ('SCHEDULED', 'OPEN', 'PARTIAL', 'COMPLETED', 'EXPIRED', 'CANCELLED');
COMMENT ON TYPE follow_up_status IS 'Lifecycle of a follow-up: SCHEDULED until due, OPEN for check-ins, then PARTIAL, COMPLETED, EXPIRED or CANCELLED.';
CREATE TYPE next_action AS ENUM ('FULL_CLOSURE', 'EXTEND', 'ADJUST_COMMITMENT', 'REOPEN_STRATEGY_WORK', 'NEW_PROCESS', 'PARTIAL_CLOSURE');
COMMENT ON TYPE next_action IS 'What a participant chose to do next at a follow-up check-in.';
CREATE TYPE continue_choice AS ENUM ('ANOTHER_ROUND', 'EXTEND', 'NEW_PROCESS', 'PARTIAL_CLOSURE', 'FULL_CLOSURE');
COMMENT ON TYPE continue_choice IS 'How a participant wants to continue after a follow-up check-in.';
CREATE TYPE reminder_scope AS ENUM ('PRIVATE', 'SHARED');
COMMENT ON TYPE reminder_scope IS 'PRIVATE: a reminder only its user sees; SHARED: one tied to a shared follow-up.';
CREATE TYPE reminder_status AS ENUM ('SCHEDULED', 'DELIVERED', 'CANCELLED');
COMMENT ON TYPE reminder_status IS 'Lifecycle of a reminder: SCHEDULED, DELIVERED, or CANCELLED.';
CREATE TYPE reflection_status AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');
COMMENT ON TYPE reflection_status IS 'Lifecycle of an Inner Work reflection thread.';
CREATE TYPE takeaway_source AS ENUM ('AI', 'USER');
COMMENT ON TYPE takeaway_source IS 'Who wrote a takeaway: the AI (distilled) or the user.';
CREATE TYPE takeaway_type AS ENUM ('INSIGHT', 'ACTION_ITEM', 'INTENTION');
COMMENT ON TYPE takeaway_type IS 'What a takeaway is: an insight, an action item, or an intention.';
CREATE TYPE takeaway_link_type AS ENUM ('AI_SEMANTIC', 'USER_MANUAL');
COMMENT ON TYPE takeaway_link_type IS 'How two takeaways were linked: by the AI (semantic similarity) or by the user.';
CREATE TYPE memory_category AS ENUM ('AI_NAME', 'LANGUAGE', 'COMMUNICATION', 'PERSONAL_INFO', 'RELATIONSHIP', 'PREFERENCE');
COMMENT ON TYPE memory_category IS 'The category of a user memory ("things to always remember").';
CREATE TYPE memory_status AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');
COMMENT ON TYPE memory_status IS 'Whether a user memory is in force (ACTIVE), awaiting the user''s approval (PENDING) or REJECTED.';
CREATE TYPE memory_source AS ENUM ('USER_APPROVED', 'USER_CREATED', 'USER_EDITED');
COMMENT ON TYPE memory_source IS 'How a user memory came to be: an AI suggestion the user approved, created by the user, or edited by the user.';
CREATE TYPE device_platform AS ENUM ('ios', 'android', 'web');
COMMENT ON TYPE device_platform IS 'The platform a user device registered from.';
CREATE TYPE activity_type AS ENUM ('LLM_CALL', 'EMBEDDING', 'RETRIEVAL', 'TOOL_USE');
COMMENT ON TYPE activity_type IS 'The kind of call a brain_activity row logs.';
CREATE TYPE activity_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
COMMENT ON TYPE activity_status IS 'Whether a logged call is still running, completed or failed.';
CREATE TYPE brain_call_type AS ENUM ('ORCHESTRATED_RESPONSE', 'RETRIEVAL_PLANNING', 'INTENT_DETECTION', 'BACKGROUND_CLASSIFICATION', 'PARTNER_SESSION_CLASSIFICATION', 'CHAT_ROUTER_RESPONSE', 'REFERENCE_DETECTION', 'PEOPLE_EXTRACTION', 'MEMORY_DETECTION', 'MEMORY_VALIDATION', 'RECONCILER_ANALYSIS', 'SUMMARIZATION', 'NEEDS_EXTRACTION', 'WITNESSING_RESPONSE', 'MEMORY_FORMATTING', 'THEME_EXTRACTION', 'GLOBAL_MEMORY_CONSOLIDATION', 'DISTILLATION', 'CROSS_SESSION_THEME');
COMMENT ON TYPE brain_call_type IS 'Which part of the app made a logged LLM call (the call site), for cost and latency breakdowns.';

-- ----------------------------------------------------------------------------
-- The 47 tables, in dependency order.
-- ----------------------------------------------------------------------------

CREATE TABLE relationship (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE relationship IS 'A durable pairing of users across sessions; its members are relationship_member, its sessions are session.';

CREATE TABLE "user" (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    clerk_id text UNIQUE,
    email text NOT NULL UNIQUE,
    first_name text,
    last_name text,
    deleted_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    name text
        GENERATED ALWAYS AS (nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')) STORED,

    -- §1.7 user — a tombstone is scrubbed (P3 D9)
    CHECK (deleted_at IS NULL OR (clerk_id IS NULL AND email LIKE 'deleted+%'))
);
COMMENT ON TABLE "user" IS 'Identity only: one row per account (Clerk-backed), soft-deleted to a scrubbed tombstone. Every FK to it is RESTRICT; session data hangs off participant, not off user.';
COMMENT ON COLUMN "user".clerk_id IS 'The Clerk user id this account signs in with; NULL on a tombstone.';
COMMENT ON COLUMN "user".email IS 'Sign-in email, unique. A tombstone holds a scrubbed deleted+<id> address.';
COMMENT ON COLUMN "user".name IS 'Generated display name: first_name and last_name joined, NULL when both are empty.';
COMMENT ON COLUMN "user".deleted_at IS 'Soft delete (P3 D9): the row becomes a scrubbed tombstone and is never removed.';

CREATE TABLE relationship_member (
    relationship_id uuid7 NOT NULL REFERENCES relationship ON DELETE CASCADE,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    role relationship_role NOT NULL DEFAULT 'member',
    nickname text,
    joined_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (relationship_id, user_id)
);
CREATE INDEX ON relationship_member (user_id);
COMMENT ON TABLE relationship_member IS 'A user''s membership in a relationship (not in a session).';
COMMENT ON COLUMN relationship_member.nickname IS 'What this member calls the other person in the relationship; plain text, set by the member.';

CREATE TABLE session (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    relationship_id uuid7 NOT NULL REFERENCES relationship ON DELETE CASCADE,
    status session_status NOT NULL DEFAULT 'CREATED',
    topic_frame text,
    topic_frame_confirmed_at ts_ms,
    previous_session_id uuid7 REFERENCES session ON DELETE SET NULL,
    resolved_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 session [P12]
    CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL)
);
CREATE INDEX ON session (relationship_id);
CREATE INDEX ON session (previous_session_id);
-- + sql_session_one_live (sql-only.sql)
COMMENT ON TABLE session IS 'One facilitated process on one topic between the participants of a relationship; at most one live session per relationship.';
COMMENT ON COLUMN session.previous_session_id IS 'The session this one continues (a NEW_PROCESS follow-up).';

CREATE TABLE participant (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    kind participant_kind NOT NULL DEFAULT 'human',
    display_name text,
    joined_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (session_id, user_id),
    -- §1.1 participant
    CHECK ((kind = 'modeled') = (user_id IS NULL))
);
CREATE INDEX ON participant (user_id);
COMMENT ON TABLE participant IS 'One membership of a session, the entity every session-scoped row keys on. A human participant has a user; a modeled one does not.';
COMMENT ON COLUMN participant.display_name IS 'Snapshot of the name shown to co-participants, the only user fact they see; NULL falls back to user.name (v_participant).';
COMMENT ON COLUMN participant.left_at IS 'When the participant left or deleted their account; the row stays.';

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
    removed_at ts_ms,
    removed_by_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    removal_reason text,
    shared_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 proposal [P21]
    CHECK ((status = 'REMOVED') = (removed_at IS NOT NULL)),
    CHECK (kind = 'INDIVIDUAL_COMMITMENT' OR shared_at IS NULL)
);
CREATE INDEX ON proposal (session_id, status);
CREATE INDEX ON proposal (created_by_participant_id);
CREATE INDEX ON proposal (removed_by_participant_id);
COMMENT ON TABLE proposal IS 'A Stage-4 repair idea: a shared proposal for the needs both see, or one participant''s individual commitment.';
COMMENT ON COLUMN proposal.created_by_participant_id IS 'Who wrote it; NULL for an AI or curated proposal.';
COMMENT ON COLUMN proposal.shared_at IS 'INDIVIDUAL_COMMITMENT only: when it was made visible to co-participants.';

CREATE TABLE conversation (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    kind conversation_kind NOT NULL DEFAULT 'MAIN',
    anchor_kind subchat_anchor,
    anchor_proposal_id uuid7 REFERENCES proposal ON DELETE SET NULL,
    status conversation_status NOT NULL DEFAULT 'ACTIVE',
    resolved_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 conversation (anchor columns are SUBCHAT-only)
    CHECK ((kind = 'MAIN') = (anchor_kind IS NULL)),
    CHECK (kind = 'SUBCHAT' OR anchor_proposal_id IS NULL)
);
CREATE INDEX ON conversation (participant_id, kind, status);
CREATE INDEX ON conversation (anchor_proposal_id);
-- + sql_conversation_one_main (sql-only.sql)
COMMENT ON TABLE conversation IS 'A participant''s private thread with the AI guide inside a session (exactly one MAIN), or a Stage-4 sub-chat.';
COMMENT ON COLUMN conversation.anchor_kind IS 'SUBCHAT only: what the sub-chat is about.';
COMMENT ON COLUMN conversation.anchor_proposal_id IS 'SUBCHAT only: the proposal a PROPOSAL_REFINEMENT sub-chat refines.';

CREATE TABLE empathy_attempt (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    author_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    round integer NOT NULL DEFAULT 1,
    supersedes_attempt_id uuid7 REFERENCES empathy_attempt ON DELETE SET NULL,
    content text NOT NULL,
    status empathy_status NOT NULL DEFAULT 'HELD',
    status_version integer NOT NULL DEFAULT 0,
    submitted_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revealed_at ts_ms,
    delivery_status delivery_status NOT NULL DEFAULT 'PENDING',
    delivered_at ts_ms,
    seen_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (author_participant_id, subject_participant_id, round),
    -- §1.2 empathy_attempt [P15b, P15d]
    CHECK (author_participant_id <> subject_participant_id),
    CHECK (status NOT IN ('REVEALED', 'VALIDATED') OR revealed_at IS NOT NULL)
);
CREATE INDEX ON empathy_attempt (subject_participant_id, revealed_at);
CREATE INDEX ON empathy_attempt (supersedes_attempt_id);
-- + sql_attempt_one_live_per_direction (sql-only.sql)
COMMENT ON TABLE empathy_attempt IS 'Stage 2: one participant''s statement of how they imagine the other feels, per direction and round; revealed to the subject once both are READY.';
COMMENT ON COLUMN empathy_attempt.round IS '1 for the first statement in this direction; +1 per resubmission.';
COMMENT ON COLUMN empathy_attempt.status_version IS 'Incremented on every status change, to order status events.';
COMMENT ON COLUMN empathy_attempt.revealed_at IS 'Set once at the reveal and never cleared: the subject''s right to read the attempt hangs on it, not on status.';

CREATE TABLE need (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    label text NOT NULL,
    category need_category NOT NULL,
    evidence text[] DEFAULT ARRAY[]::text[],
    ai_confidence real NOT NULL,
    confirmed_at ts_ms,
    locked_at ts_ms,
    superseded_by_need_id uuid7 REFERENCES need ON DELETE SET NULL,
    deleted_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 need [P30]
    CHECK (ai_confidence BETWEEN 0 AND 1)
);
CREATE INDEX ON need (participant_id);
CREATE INDEX ON need (superseded_by_need_id);
-- + sql_need_live (sql-only.sql)
COMMENT ON TABLE need IS 'A need the AI identified for a participant; owner-only, always. A co-participant sees a need only through need_share.';
COMMENT ON COLUMN need.ai_confidence IS 'The model''s confidence in the need, 0 to 1.';
COMMENT ON COLUMN need.locked_at IS 'When the need was locked against further edits.';
COMMENT ON COLUMN need.superseded_by_need_id IS 'The need that replaced this one after an edit.';

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
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 message [P02] — P3 §6, "humans can't author as the facilitator"
    CHECK (role <> 'USER' OR sender_participant_id IS NOT NULL),
    CHECK (role NOT IN ('AI', 'SYSTEM') OR sender_participant_id IS NULL)
);
CREATE INDEX ON message (conversation_id, created_at);
CREATE INDEX ON message (conversation_id, kind, content_hash);
CREATE INDEX ON message (sender_participant_id);
CREATE INDEX ON message (refining_need_id);
CREATE INDEX ON message (source_attempt_id);
COMMENT ON TABLE message IS 'One line of a conversation: a human turn, an AI or system line, or an item delivered from the other participant. Append-only.';
COMMENT ON COLUMN message.sender_participant_id IS 'The human who wrote a USER line; NULL for AI and SYSTEM lines.';
COMMENT ON COLUMN message.source_attempt_id IS 'Lineage of a delivered item: the empathy attempt it came from.';

CREATE TABLE conversation_read_state (
    participant_id uuid7 NOT NULL PRIMARY KEY REFERENCES participant ON DELETE CASCADE,
    last_viewed_at ts_ms,
    last_seen_message_id uuid7 REFERENCES message ON DELETE SET NULL,
    last_viewed_share_tab_at ts_ms,
    last_active_at ts_ms,
    archived_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON conversation_read_state (last_seen_message_id);
COMMENT ON TABLE conversation_read_state IS 'Per-participant view state: what was last viewed or seen, presence, and whether the session is archived from their list.';
COMMENT ON COLUMN conversation_read_state.last_seen_message_id IS 'The last message this participant has seen: the "new messages" line.';
COMMENT ON COLUMN conversation_read_state.last_viewed_share_tab_at IS 'When the participant last viewed received shared items ("Seen"); the name predates the Share tab''s removal.';
COMMENT ON COLUMN conversation_read_state.last_active_at IS 'Presence; shown to the co-participant only when their privacy preferences allow (v_participant).';
COMMENT ON COLUMN conversation_read_state.archived_at IS 'Set when the participant hid the session from their list.';

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
    superseded_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (attempt_id, iteration),
    -- §1.2 reconciler_result [P17f]
    CHECK (alignment_score BETWEEN 0 AND 100)
);
CREATE INDEX ON reconciler_result (subject_participant_id);
-- + sql_result_one_current (sql-only.sql)
COMMENT ON TABLE reconciler_result IS 'The reconciler''s gap analysis of one empathy attempt against its subject''s account; immutable, one current per attempt (superseded_at). Visible to the subject only.';
COMMENT ON COLUMN reconciler_result.subject_participant_id IS 'The attempt''s subject, copied for the read policy; a trigger keeps it equal to empathy_attempt.subject_participant_id.';
COMMENT ON COLUMN reconciler_result.iteration IS '1 for the first analysis of the attempt; +1 per re-analysis.';
COMMENT ON COLUMN reconciler_result.alignment_score IS 'How well the attempt matches the subject''s account, 0 to 100.';
COMMENT ON COLUMN reconciler_result.circuit_breaker_tripped IS 'Meant to mark a result that ended the refinement loop by its circuit breaker; no writer sets it true today and nothing reads it (spec 1.2).';
COMMENT ON COLUMN reconciler_result.superseded_at IS 'Set when a newer result replaces this one; NULL marks the current result.';

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
    shared_at ts_ms,
    declined_at ts_ms,
    offered_at ts_ms,
    delivery_status delivery_status NOT NULL DEFAULT 'PENDING',
    delivered_at ts_ms,
    seen_at ts_ms,
    delivery_notified_at ts_ms,
    seen_notified_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (attempt_id, iteration),
    -- §1.2 context_share_offer [P18a]
    CHECK ((status = 'ACCEPTED') = (shared_at IS NOT NULL)),
    CHECK ((status = 'DECLINED') = (declined_at IS NOT NULL))
);
CREATE INDEX ON context_share_offer (subject_participant_id, status);
CREATE INDEX ON context_share_offer (result_id);
COMMENT ON TABLE context_share_offer IS 'The suggestion to the subject of an attempt to share context with its author, and what happened to it; the shared text is delivered to the author as a message.';
COMMENT ON COLUMN context_share_offer.subject_participant_id IS 'The subject who is offered the chance to share (the attempt''s subject).';
COMMENT ON COLUMN context_share_offer.delivery_notified_at IS 'When the subject who shared was shown that the shared context was delivered (GET notifications, Sent-tab updates).';
COMMENT ON COLUMN context_share_offer.seen_notified_at IS 'When the subject who shared was shown that the author has seen it.';

CREATE TABLE milestone (
    key text NOT NULL PRIMARY KEY,
    ordinal integer NOT NULL UNIQUE,
    stage_label text NOT NULL,
    scope milestone_scope NOT NULL DEFAULT 'participant',
    self_assertable boolean NOT NULL DEFAULT false,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE milestone IS 'Reference data: the journey milestones, in order. The only place a stage exists, as data; seeded by the baseline migration.';
COMMENT ON COLUMN milestone.key IS 'Stable identifier of the milestone, e.g. feel_heard; code and participant_milestone refer to it.';
COMMENT ON COLUMN milestone.ordinal IS 'Position along the journey.';
COMMENT ON COLUMN milestone.stage_label IS 'UI label of the stage this milestone belongs to, e.g. Your Story; display text owned by this table.';
COMMENT ON COLUMN milestone.self_assertable IS 'Whether a participant may record the milestone themselves (a CTA) or only the job (a system fact).';

CREATE TABLE participant_milestone (
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    milestone_key text NOT NULL REFERENCES milestone ON DELETE RESTRICT,
    reached_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (participant_id, milestone_key)
);
CREATE INDEX ON participant_milestone (milestone_key, reached_at);
COMMENT ON TABLE participant_milestone IS 'Event: a participant reached a milestone at reached_at. Append-only; current stage and readiness are derived from these rows (v_current_stage, v_session_readiness).';

CREATE TABLE ai_memory (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    kind ai_memory_kind NOT NULL,
    doc jsonb NOT NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

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
COMMENT ON TABLE ai_memory IS 'The AI''s working memory as documents: a participant''s rolling SUMMARY and NOTABLE_FACTS in one session, and a user''s GLOBAL_FACTS across sessions.';
COMMENT ON COLUMN ai_memory.kind IS 'SUMMARY and NOTABLE_FACTS have participant_id; GLOBAL_FACTS has user_id.';

CREATE TABLE mood_reading (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    intensity intensity NOT NULL,
    context text,
    recorded_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON mood_reading (participant_id, recorded_at);
COMMENT ON TABLE mood_reading IS 'A participant''s barometer reading (1-10) with optional context. Append-only time series.';

CREATE TABLE regulation_event (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    type regulation_type NOT NULL,
    intensity_before intensity,
    intensity_after intensity,
    completed_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON regulation_event (participant_id, completed_at);
COMMENT ON TABLE regulation_event IS 'A completed emotional-regulation exercise, with the intensity before and after. Append-only.';

CREATE TABLE invitation (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    invited_by_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    accepted_by_user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    name text,
    status invitation_status NOT NULL DEFAULT 'PENDING',
    message_confirmed_at ts_ms,
    expires_at ts_ms NOT NULL,
    accepted_at ts_ms,
    declined_at ts_ms,
    decline_reason text,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 invitation [P14a, P14b] — P3 §6
    CHECK (
      status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL))
);
CREATE INDEX ON invitation (session_id);
CREATE INDEX ON invitation (invited_by_participant_id);
CREATE INDEX ON invitation (status, expires_at);
CREATE INDEX ON invitation (accepted_by_user_id);
COMMENT ON TABLE invitation IS 'An invitation from a participant to someone not yet in the session; accepting it creates the invitee''s participant.';
COMMENT ON COLUMN invitation.accepted_by_user_id IS 'The user who accepted; set with accepted_at.';
COMMENT ON COLUMN invitation.message_confirmed_at IS 'When the inviter confirmed the invitation message.';

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
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reopened_at ts_ms,

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
COMMENT ON TABLE draft IS 'A participant''s working text for one sharing point (empathy statement, validation feedback, shared context) before any consent.';
COMMENT ON COLUMN draft.about_participant_id IS 'EMPATHY: the participant the draft imagines.';
COMMENT ON COLUMN draft.attempt_id IS 'VALIDATION_FEEDBACK: the attempt being reviewed.';
COMMENT ON COLUMN draft.share_offer_id IS 'SHARE_CONTEXT: the offer being edited.';
COMMENT ON COLUMN draft.invitation_id IS 'EMPATHY before the subject has joined: the pending invitation that will become them; re-pointed to about_participant_id at accept.';
COMMENT ON COLUMN draft.reopened_at IS 'Set when the author chose Edit first on a pre-join draft after the join; cleared by the next draft write (work-9309).';

CREATE TABLE session_key (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    key_id text NOT NULL,
    wrapped_dek bytea NOT NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    destroyed_at ts_ms,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON session_key (session_id);
-- + sql_session_key_live (sql-only.sql)
COMMENT ON TABLE session_key IS 'Envelope-encryption key per session (P3 D5, W13): the session''s data key wrapped by a KMS key; destroyed_at shreds it. Designed for W13: nothing writes a key row yet.';
COMMENT ON COLUMN session_key.key_id IS 'The id of the KMS key (the KEK) that wrapped this row''s DEK: the same <keyId> the planned enc:v2:<keyId>:... envelope prefix will carry (P3 8.6). No format is fixed yet; nothing writes these tables before W13.';
COMMENT ON COLUMN session_key.wrapped_dek IS 'The AES-256 data key (DEK) for this owner''s encrypted columns, encrypted (wrapped) by the KMS key named in key_id. Never stored unwrapped.';
COMMENT ON COLUMN session_key.destroyed_at IS 'The crypto-shred: once set, the wrapped DEK is never unwrapped again, so every value under it is unreadable.';

CREATE TABLE participant_key (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    key_id text NOT NULL,
    wrapped_dek bytea NOT NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    destroyed_at ts_ms,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON participant_key (participant_id);
-- + sql_participant_key_live (sql-only.sql)
COMMENT ON TABLE participant_key IS 'Envelope-encryption key per participant (P3 D5, W13): the participant''s data key wrapped by a KMS key; destroyed_at shreds it. Designed for W13: nothing writes a key row yet; account deletion already sets destroyed_at.';
COMMENT ON COLUMN participant_key.key_id IS 'The id of the KMS key (the KEK) that wrapped this row''s DEK: the same <keyId> the planned enc:v2:<keyId>:... envelope prefix will carry (P3 8.6). No format is fixed yet; nothing writes these tables before W13.';
COMMENT ON COLUMN participant_key.wrapped_dek IS 'The AES-256 data key (DEK) for this owner''s encrypted columns, encrypted (wrapped) by the KMS key named in key_id. Never stored unwrapped.';
COMMENT ON COLUMN participant_key.destroyed_at IS 'The crypto-shred: once set, the wrapped DEK is never unwrapped again, so every value under it is unreadable.';

CREATE TABLE empathy_review (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    reviewer_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    validated boolean NOT NULL,
    feedback text,
    feedback_sent_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (attempt_id, reviewer_participant_id),
    -- §1.2 empathy_review
    CHECK (feedback IS NULL OR feedback_sent_at IS NOT NULL)
);
CREATE INDEX ON empathy_review (reviewer_participant_id);
COMMENT ON TABLE empathy_review IS 'The subject''s verdict on an attempt revealed to them (validated or not), with the feedback they chose to send.';
COMMENT ON COLUMN empathy_review.reviewer_participant_id IS 'The attempt''s subject (trigger-checked).';
COMMENT ON COLUMN empathy_review.feedback_sent_at IS 'When the reviewer explicitly sent the feedback; feedback is set only with it.';

CREATE TABLE reconciler_guidance (
    result_id uuid7 NOT NULL PRIMARY KEY REFERENCES reconciler_result ON DELETE CASCADE,
    author_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    area_hint text,
    guidance_type text,
    prompt_seed text,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON reconciler_guidance (author_participant_id);
CREATE INDEX ON reconciler_guidance (subject_participant_id);
COMMENT ON TABLE reconciler_guidance IS 'The abstract hints from a reconciler result that the author may see (P3 D8a split from reconciler_result, which only the subject sees).';
COMMENT ON COLUMN reconciler_guidance.author_participant_id IS 'The attempt''s author, who may read this row.';

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
    decided_at ts_ms,
    revoked_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
COMMENT ON TABLE consent IS 'One explicit decision by a participant to let something cross the boundary to the other participant; exactly one target arc.';
COMMENT ON COLUMN consent.participant_id IS 'The participant who decides.';
COMMENT ON COLUMN consent.requested_by_participant_id IS 'Who asked, for audit only; it grants no read right.';
COMMENT ON COLUMN consent.target_kind IS 'Generated from which arc column is set.';

CREATE TABLE need_share (
    need_id uuid7 NOT NULL PRIMARY KEY REFERENCES need ON DELETE RESTRICT,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    category need_category NOT NULL,
    shared_text text NOT NULL,
    shared_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 need_share [P20c]
    CHECK (revoked_at IS NULL OR revoked_at >= shared_at)
);
CREATE INDEX ON need_share (session_id, revoked_at);
CREATE INDEX ON need_share (participant_id);
COMMENT ON TABLE need_share IS 'The consented, transformed version of a need that co-participants may see. Reads of a partner''s needs touch this table only, never need.';
COMMENT ON COLUMN need_share.participant_id IS 'The need''s owner, copied from need by app.need_share so the shared projection needs no join to need (pass 2 N-1); trigger-checked.';
COMMENT ON COLUMN need_share.session_id IS 'The owner''s session, copied by app.need_share for the membership read arm; trigger-checked.';
COMMENT ON COLUMN need_share.category IS 'The need''s category, copied at share time: the partner sees the category, never need.label.';

CREATE TABLE need_disposition (
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    need_id uuid7 NOT NULL REFERENCES need_share ON DELETE CASCADE,
    status need_disposition_status NOT NULL DEFAULT 'OPEN',
    is_current boolean NOT NULL DEFAULT false,
    note text,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (participant_id, need_id)
);
CREATE INDEX ON need_disposition (need_id);
-- + sql_disposition_one_current (sql-only.sql)
COMMENT ON TABLE need_disposition IS 'How a participant dispositions a shared need during the Stage-4 walkthrough (their own or the other''s); one current need per walkthrough.';
COMMENT ON COLUMN need_disposition.is_current IS 'The need the walkthrough is on (at most one per participant).';

CREATE TABLE proposal_need (
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    need_id uuid7 NOT NULL REFERENCES need_share ON DELETE CASCADE,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (proposal_id, need_id)
);
CREATE INDEX ON proposal_need (need_id);
COMMENT ON TABLE proposal_need IS 'Which shared needs a proposal addresses.';

CREATE TABLE proposal_choice (
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    decision choice_decision NOT NULL,
    note text,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (proposal_id, participant_id)
);
CREATE INDEX ON proposal_choice (participant_id);
COMMENT ON TABLE proposal_choice IS 'A participant''s willingness on a proposal; private until the choices_shared milestone.';

CREATE TABLE proposal_revision (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    actor_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    action revision_action NOT NULL,
    before jsonb,
    after jsonb,
    reason text,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 proposal_revision [P23c]
    CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
    CHECK (after IS NULL OR jsonb_typeof(after) = 'object')
);
CREATE INDEX ON proposal_revision (proposal_id, created_at);
CREATE INDEX ON proposal_revision (actor_participant_id);
COMMENT ON TABLE proposal_revision IS 'Append-only audit of proposal changes, with before/after snapshots.';
COMMENT ON COLUMN proposal_revision.actor_participant_id IS 'Who made the change; NULL for the AI or the app.';

CREATE TABLE agreement (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    proposal_id uuid7 NOT NULL UNIQUE REFERENCES proposal ON DELETE RESTRICT,
    type agreement_type NOT NULL,
    status agreement_status NOT NULL DEFAULT 'AGREED',
    description text NOT NULL,
    duration text,
    measure_of_success text,
    follow_up_at ts_ms,
    completed_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON agreement (session_id, status);
COMMENT ON TABLE agreement IS 'A proposal every willing party accepted; at most one per proposal.';
COMMENT ON COLUMN agreement.session_id IS 'The proposal''s session, kept for the agreement''s own read policy and session queries.';

CREATE TABLE agreement_party (
    agreement_id uuid7 NOT NULL REFERENCES agreement ON DELETE CASCADE,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    agreed_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (agreement_id, participant_id)
);
CREATE INDEX ON agreement_party (participant_id);
COMMENT ON TABLE agreement_party IS 'Who is party to an agreement.';

CREATE TABLE session_closure (
    session_id uuid7 NOT NULL PRIMARY KEY REFERENCES session ON DELETE CASCADE,
    kind closure_kind NOT NULL,
    reason closure_reason NOT NULL,
    summary text NOT NULL,
    closed_by_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    check_in_at ts_ms,
    closed_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON session_closure (closed_by_participant_id);
COMMENT ON TABLE session_closure IS 'How the repair stage of a session ended, one row per closed session.';
COMMENT ON COLUMN session_closure.closed_by_participant_id IS 'Who closed it; NULL for an automatic closure.';

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
    scheduled_for ts_ms,
    response_deadline_at ts_ms,
    opened_at ts_ms,
    completed_at ts_ms,
    summary text,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.5 follow_up [P24a]
    CHECK ((scope = 'INDIVIDUAL') = (owner_participant_id IS NOT NULL)),
    CHECK (num_nonnulls(agreement_id, proposal_id) <= 1)
);
CREATE INDEX ON follow_up (session_id, status);
CREATE INDEX ON follow_up (agreement_id);
CREATE INDEX ON follow_up (proposal_id);
CREATE INDEX ON follow_up (owner_participant_id);
-- + sql_follow_up_due (sql-only.sql)
COMMENT ON TABLE follow_up IS 'A scheduled or user-initiated check-in on an agreement or an individual commitment.';
COMMENT ON COLUMN follow_up.proposal_id IS 'An individual commitment''s proposal, when there is no agreement.';
COMMENT ON COLUMN follow_up.owner_participant_id IS 'INDIVIDUAL scope only: whose follow-up it is.';
COMMENT ON COLUMN follow_up.response_deadline_at IS 'When an OPEN follow-up stops accepting check-ins.';

CREATE TABLE follow_up_checkin (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    follow_up_id uuid7 NOT NULL REFERENCES follow_up ON DELETE CASCADE,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    next_action next_action,
    continue_choice continue_choice,
    reflection_summary text,
    payload jsonb NOT NULL DEFAULT '{}',
    submitted_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (follow_up_id, participant_id),
    -- §1.5 follow_up_checkin
    CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX ON follow_up_checkin (participant_id, submitted_at);
COMMENT ON TABLE follow_up_checkin IS 'One participant''s answers to a follow-up, one per participant; the structured answers are a document (payload).';

CREATE TABLE follow_up_note (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    content text NOT NULL,
    carry_forward boolean NOT NULL DEFAULT false,
    carried_into_checkin_id uuid7 REFERENCES follow_up_checkin ON DELETE SET NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON follow_up_note (participant_id, created_at);
CREATE INDEX ON follow_up_note (carried_into_checkin_id);
COMMENT ON TABLE follow_up_note IS 'A private between-period note; it can be carried into a later check-in.';
COMMENT ON COLUMN follow_up_note.carried_into_checkin_id IS 'The check-in this note was copied into (payload.carriedNotes).';

CREATE TABLE reminder (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    follow_up_id uuid7 REFERENCES follow_up ON DELETE CASCADE,
    scope reminder_scope NOT NULL DEFAULT 'PRIVATE',
    remind_at ts_ms NOT NULL,
    cadence text,
    note text,
    status reminder_status NOT NULL DEFAULT 'SCHEDULED',
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON reminder (user_id, remind_at);
CREATE INDEX ON reminder (follow_up_id);
-- + sql_reminder_due (sql-only.sql)
COMMENT ON TABLE reminder IS 'A scheduled nudge for one user, optionally tied to a follow-up; the job delivers due ones.';

CREATE TABLE reflection (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    title text,
    theme text,
    status reflection_status NOT NULL DEFAULT 'ACTIVE',
    summary text,
    summary_doc jsonb,
    linked_session_id uuid7 REFERENCES session ON DELETE SET NULL,
    linked_at ts_ms,
    context_snapshot text,
    distilled_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.6 reflection, takeaway_link [P31]
    CHECK (summary_doc IS NULL OR jsonb_typeof(summary_doc) = 'object')
);
CREATE INDEX ON reflection (user_id, updated_at);
CREATE INDEX ON reflection (linked_session_id);
CREATE INDEX ON reflection (user_id, theme);
COMMENT ON TABLE reflection IS 'A private Inner Work reflection thread, outside any session (user-scoped); optionally linked to a session.';
COMMENT ON COLUMN reflection.linked_session_id IS 'A session the reflection is about, for context only; it grants no visibility either way.';
COMMENT ON COLUMN reflection.distilled_at IS 'When takeaways were last distilled from the thread.';

CREATE TABLE reflection_message (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    reflection_id uuid7 NOT NULL REFERENCES reflection ON DELETE CASCADE,
    role message_role NOT NULL,
    content text NOT NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON reflection_message (reflection_id, created_at);
COMMENT ON TABLE reflection_message IS 'One line of a reflection thread.';

CREATE TABLE takeaway (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    reflection_id uuid7 NOT NULL REFERENCES reflection ON DELETE CASCADE,
    content text NOT NULL,
    theme text,
    source takeaway_source NOT NULL DEFAULT 'AI',
    type takeaway_type NOT NULL DEFAULT 'INSIGHT',
    position integer NOT NULL DEFAULT 0,
    resolved_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON takeaway (reflection_id, position);
COMMENT ON TABLE takeaway IS 'A distilled insight, action item or intention from a reflection, in the user''s order.';
COMMENT ON COLUMN takeaway.position IS 'The user''s order within the reflection.';

CREATE TABLE takeaway_link (
    source_id uuid7 NOT NULL REFERENCES takeaway ON DELETE CASCADE,
    target_id uuid7 NOT NULL REFERENCES takeaway ON DELETE CASCADE,
    link_type takeaway_link_type NOT NULL,
    similarity real,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (source_id, target_id),
    CHECK (source_id <> target_id)
);
CREATE INDEX ON takeaway_link (target_id);
COMMENT ON TABLE takeaway_link IS 'A directed link between two takeaways, by AI similarity or by the user.';
COMMENT ON COLUMN takeaway_link.similarity IS 'AI_SEMANTIC links: the similarity score that made the link.';

CREATE TABLE user_device (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    push_token text,
    platform device_platform,
    biometric_enabled boolean NOT NULL DEFAULT false,
    biometric_enrolled_at ts_ms,
    last_seen_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON user_device (user_id);
-- + sql_user_device_token (sql-only.sql)
COMMENT ON TABLE user_device IS 'A device a user registered: its push token and biometric enrolment.';
COMMENT ON COLUMN user_device.push_token IS 'The Expo push token of this install; NULL until registered.';

CREATE TABLE user_preferences (
    user_id uuid7 NOT NULL PRIMARY KEY REFERENCES "user" ON DELETE RESTRICT,
    doc jsonb NOT NULL DEFAULT '{}',
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.7 user_preferences
    CHECK (
      jsonb_typeof(doc) = 'object' AND doc ?& ARRAY['memory', 'notifications', 'privacy'])
);
COMMENT ON TABLE user_preferences IS 'The user''s preference documents (memory, notifications, privacy), one row per user.';

CREATE TABLE user_memory (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    session_id uuid7 REFERENCES session ON DELETE CASCADE,
    content text NOT NULL,
    category memory_category NOT NULL,
    status memory_status NOT NULL DEFAULT 'ACTIVE',
    source memory_source NOT NULL DEFAULT 'USER_APPROVED',
    suggested_text text,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON user_memory (user_id, status);
CREATE INDEX ON user_memory (session_id);
COMMENT ON TABLE user_memory IS '"Things to always remember": standing instructions the user approved or wrote, optionally scoped to a session.';
COMMENT ON COLUMN user_memory.session_id IS 'NULL for a memory that applies everywhere; set for one scoped to a session.';

CREATE TABLE feature_state (
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    feature text NOT NULL,
    doc jsonb NOT NULL DEFAULT '{}',
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, feature),
    -- §1.7 feature_state
    CHECK (feature IN ('meditation', 'gratitude', 'needs_assessment', 'people')),
    CHECK (jsonb_typeof(doc) = 'object')
);
COMMENT ON TABLE feature_state IS 'One document per wellbeing feature per user (meditation, gratitude, needs assessment, people).';

CREATE TABLE user_key (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    key_id text NOT NULL,
    wrapped_dek bytea NOT NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    destroyed_at ts_ms,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON user_key (user_id);
-- + sql_user_key_live (sql-only.sql)
COMMENT ON TABLE user_key IS 'Envelope-encryption key per user (P3 8.6, W13): the user''s data key wrapped by a KMS key; destroyed_at shreds it at account deletion. Designed for W13: nothing writes a key row yet.';
COMMENT ON COLUMN user_key.key_id IS 'The id of the KMS key (the KEK) that wrapped this row''s DEK: the same <keyId> the planned enc:v2:<keyId>:... envelope prefix will carry (P3 8.6). No format is fixed yet; nothing writes these tables before W13.';
COMMENT ON COLUMN user_key.wrapped_dek IS 'The AES-256 data key (DEK) for this owner''s encrypted columns, encrypted (wrapped) by the KMS key named in key_id. Never stored unwrapped.';
COMMENT ON COLUMN user_key.destroyed_at IS 'The crypto-shred: once set, the wrapped DEK is never unwrapped again, so every value under it is unreadable.';

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
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at ts_ms,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

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
COMMENT ON TABLE brain_activity IS 'Telemetry: one row per LLM, embedding, retrieval or tool call, with its prompt, output, tokens, cost and timing.';
COMMENT ON COLUMN brain_activity.turn_id IS 'Correlates the calls of one request or chat turn.';
COMMENT ON COLUMN brain_activity.model IS 'The model id the call used (a Bedrock model id, or the embedding model).';
COMMENT ON COLUMN brain_activity.cost IS 'Estimated cost of the call in US dollars, from the per-model token prices in lib/bedrock.ts.';
