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
--    a `-- + sql_…` line), triggers, functions, views, and the grants of the
--    other roles (trailer.sql).
--  * mwf_app's grants (work-k5fk.10.2) follow each table: exactly the commands,
--    and for INSERT / UPDATE the columns, the request path uses — a Prisma
--    create sends every column schema.prisma gives a @default (timestamps and
--    static values alike) and an update sends @updatedAt, so they are listed.
--    No database object is owned by a runtime role (mwf_migrator owns them),
--    so these are mwf_app's whole table privileges. A table with no mwf_app
--    grant says so. FINDING lines mark writes that need more than they should
--    (another user's row, a status outside its function); RLS and definer
--    functions take them over (design note §6, §7 rows 9a–9g).
--  * SELECT is table-wide on every table the app reads: a request may read
--    any row, its partner's and strangers' alike. That is the expected gap
--    until RLS (design note §6, rows 9d–9g) narrows it to rows; grants
--    narrow commands and columns, never rows.
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

-- Every uuid column (the 33 uuidv7() primary keys and the 96 columns that
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

-- Every column the app encrypts (SENSITIVE_FIELD_MAP, kind text, in
-- lib/prisma-encryption-middleware.ts) is a ciphertext, so a reader of the
-- schema sees it is encrypted. The stored format is utils/field-encryption.ts
-- encrypt(): enc:v1:<iv>:<tag>:<ct>, AES-256-GCM, every segment standard
-- base64 — a 12-byte IV (16 chars, no padding), a 16-byte tag (24 chars,
-- always ending ==), the ciphertext (any length, possibly empty). The CHECK is
-- deliberately lenient: with no FIELD_ENCRYPTION_KEY (keyless dev/test) the
-- app stores plaintext, so a value that does not start with enc: passes;
-- anything that does must be a well-formed v1 envelope. There is no v2 arm:
-- no code writes enc:v2 yet (W13 will, with a key id; add the arm with it).
-- A strict variant (every value an envelope) is planned for when
-- REQUIRE_FIELD_ENCRYPTION becomes mandatory. The text[] columns cannot be
-- ciphertext[] (an array of a domain: step 20, node-postgres); each carries
-- CHECK (app.all_ciphertext(col)) instead. The six jsonb columns in the map
-- carry only a COMMENT starting 'encrypted'.
CREATE DOMAIN ciphertext AS text
  CHECK (VALUE IS NULL OR VALUE !~ '^enc:'
         OR VALUE ~ '^enc:v1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$');
COMMENT ON DOMAIN ciphertext IS 'Encrypted by the app (utils/field-encryption.ts, through the SENSITIVE_FIELD_MAP extension in lib/prisma-encryption-middleware.ts): enc:v1:<iv>:<tag>:<ct>, AES-256-GCM, base64 segments. Never compare or search by value (random IV). Plaintext passes for keyless dev/test; a strict variant is planned for when REQUIRE_FIELD_ENCRYPTION becomes mandatory.';

-- Every element of an encrypted text[] column is a ciphertext (NULL elements
-- and a NULL array pass). The cast to ciphertext[] runs the domain CHECK on
-- each element and raises on a malformed one; the array type appears only
-- inside the body, never as a column, argument or result (step 20).
CREATE FUNCTION app.all_ciphertext(v text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN v IS NULL OR (v::public.ciphertext[]) IS NOT NULL;
COMMENT ON FUNCTION app.all_ciphertext(text[]) IS 'True when every element is a ciphertext; raises the ciphertext domain error otherwise. The CHECK on each encrypted text[] column.';

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
CREATE TYPE message_dedupe_key AS ENUM ('STAGE2_VALIDATED_WAIT', 'STAGE4_HANDOFF_BRIDGE');
COMMENT ON TYPE message_dedupe_key IS 'The app-generated facilitator lines written at most once per conversation (work-fdc1): STAGE2_VALIDATED_WAIT, the hold-here note after a participant validates the partner''s empathy (controllers/stage2.ts); STAGE4_HANDOFF_BRIDGE, the hand-off line after the first Stage 4 share (controllers/stage4.ts). A closed set: no value is derived from message content.';
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
CREATE TYPE guidance_type AS ENUM ('challenge_assumptions', 'explore_breadth', 'explore_deeper_feelings');
COMMENT ON TYPE guidance_type IS 'The refinement guidance the reconciler picked for the author, from the gap''s shape (generateAbstractGuidance in services/reconciler/analysis.ts).';
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
CREATE TYPE proposal_revision_reason AS ENUM ('LEGACY_PROPOSED', 'LEGACY_CONFIRMED', 'MUTUAL_CLOSURE', 'EVERY_PARTY_CONFIRMED');
COMMENT ON TYPE proposal_revision_reason IS 'The app markers a proposal_revision may carry (services/proposal-revision-reasons.ts, ruling R47); controllers/stage4.ts filters revisions by them. Free text explaining a revision goes in the encrypted after/before, never here.';
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
CREATE TYPE reminder_cadence AS ENUM ('ONCE', 'WEEKLY', 'MONTHLY', 'EVERY_COUPLE_MONTHS');
COMMENT ON TYPE reminder_cadence IS 'How often a reminder repeats, as chosen in the check-in (ONCE or a named period); a recurrence choice, not an interval. nextReminderDate (services/tending.service.ts) maps it to the next remind_at.';
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
CREATE TYPE wellbeing_feature AS ENUM ('meditation', 'gratitude', 'needs_assessment', 'people');
COMMENT ON TYPE wellbeing_feature IS 'The wellbeing features that keep a feature_state document (shared/src/dto/feature-state.ts FEATURES).';
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
-- mwf_app: invitations.ts createSession reads the relationship and creates one with its two members (nested create: Prisma sends the timestamps).
GRANT SELECT ON relationship TO mwf_app;
GRANT INSERT (created_at, updated_at) ON relationship TO mwf_app;

CREATE TABLE "user" (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    clerk_id text UNIQUE,
    email text NOT NULL UNIQUE CHECK (char_length(email) <= 254),
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
-- mwf_app: every request reads its user (auth middleware, by clerk_id/email) and its partner's names; first login creates the
-- row and a Clerk race reconciles it (middleware/auth.ts — FINDING: this is mwf_auth's app.create_user_for_clerk on paper);
-- the profile edit sets the names (controllers/auth.ts). Never id, deleted_at (tombstone is app.anonymize_user_account).
GRANT SELECT ON "user" TO mwf_app;
GRANT INSERT (clerk_id, email, first_name, last_name, created_at, updated_at) ON "user" TO mwf_app;
GRANT UPDATE (clerk_id, email, first_name, last_name, updated_at) ON "user" TO mwf_app;
-- FINDING (work-jv9y, a live production bug, not fixed here): UPDATE (clerk_id, email) is what lets
-- middleware/auth.ts's P2002 path re-bind an EXISTING user's row — found by the email a new Clerk
-- identity presents (emailAddresses[0], not checked verified or primary) — to that new identity: an
-- account takeover. The grant is the app's today; the fix (and this grant) is the owner's call.

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
-- mwf_app: createSession adds both members (the invitee's row too — FINDING: a write of another user's row), accept adds the
-- invitee, the nickname edit sets the caller's nickname.
GRANT SELECT ON relationship_member TO mwf_app;
GRANT INSERT (relationship_id, user_id, role, nickname, joined_at, created_at, updated_at) ON relationship_member TO mwf_app;
GRANT UPDATE (nickname, updated_at) ON relationship_member TO mwf_app;

CREATE TABLE session (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    relationship_id uuid7 NOT NULL REFERENCES relationship ON DELETE CASCADE,
    status session_status NOT NULL DEFAULT 'CREATED',
    topic_frame ciphertext,
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
COMMENT ON COLUMN session.topic_frame IS 'encrypted (session): the AI''s short neutral topic phrase for the session (max 20 words by prompt), confirmed by the participants.';
-- mwf_app: createSession and tending startLinkedProcess create a session; the topic frame and its confirmation; the realtime
-- touch (updated_at). status: ONLY archiveSession (controllers/invitations.ts) — FINDING: it writes status directly,
-- bypassing app.session_set_status, and from CREATED/INVITED, which the function refuses; every other status move is the function.
GRANT SELECT ON session TO mwf_app;
GRANT INSERT (relationship_id, status, previous_session_id, topic_frame, created_at, updated_at) ON session TO mwf_app;
GRANT UPDATE (topic_frame, topic_frame_confirmed_at, status, updated_at) ON session TO mwf_app;

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
-- mwf_app: the inviter's participant at createSession, the invitee's at accept, the caller's in a linked process. Never an
-- UPDATE: display_name / left_at move only through app.anonymize_user_in_session.
GRANT SELECT ON participant TO mwf_app;
GRANT INSERT (session_id, user_id, kind, display_name, joined_at, created_at, updated_at) ON participant TO mwf_app;

CREATE TABLE proposal (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    created_by_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    source proposal_source NOT NULL DEFAULT 'USER_SUBMITTED',
    kind proposal_kind NOT NULL DEFAULT 'SHARED_PROPOSAL',
    status proposal_status NOT NULL DEFAULT 'ACTIVE',
    description ciphertext NOT NULL,
    duration ciphertext,
    measure_of_success ciphertext,
    unresolved_need_labels text[] DEFAULT ARRAY[]::text[],
    removed_at ts_ms,
    removed_by_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    removal_reason ciphertext,
    shared_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 proposal [P21]
    CHECK ((status = 'REMOVED') = (removed_at IS NOT NULL)),
    CHECK (kind = 'INDIVIDUAL_COMMITMENT' OR shared_at IS NULL),
    -- every element is ciphertext (the ciphertext domain; an array of it is refused by step 20)
    CHECK (app.all_ciphertext(unresolved_need_labels))
);
CREATE INDEX ON proposal (session_id, status);
CREATE INDEX ON proposal (created_by_participant_id);
CREATE INDEX ON proposal (removed_by_participant_id);
COMMENT ON TABLE proposal IS 'A Stage-4 repair idea: a shared proposal for the needs both see, or one participant''s individual commitment.';
COMMENT ON COLUMN proposal.created_by_participant_id IS 'Who wrote it; NULL for an AI or curated proposal.';
COMMENT ON COLUMN proposal.shared_at IS 'INDIVIDUAL_COMMITMENT only: when it was made visible to co-participants.';
COMMENT ON COLUMN proposal.description IS 'encrypted (session): what the proposal is, AI-proposed or typed (POST /strategies: 10 to 1000).';
COMMENT ON COLUMN proposal.duration IS 'encrypted (session): free text for how long, e.g. 3 days or 10 minutes, once this week (AI or user; max 100 on POST /strategies). NOT a true interval: nothing parses it.';
COMMENT ON COLUMN proposal.measure_of_success IS 'encrypted (session): free text: how the participants will know it worked (max 500 on POST /strategies).';
COMMENT ON COLUMN proposal.removal_reason IS 'encrypted (session): why it was removed: the AI''s REMOVE reason or the participant''s chat text.';
COMMENT ON COLUMN proposal.unresolved_need_labels IS 'encrypted (session): text[], each element encrypted: need labels the proposal addresses that matched no need_share, as given by the AI or the participant.';
-- mwf_app: Stage 4 capture, the sub-chat and the shared-proposal routes create and edit proposals and their need labels
-- (stage4-capture.service.ts, stage4-subchat.service.ts, controllers/stage4.ts). FINDING: capture can set and re-assign
-- created_by_participant_id to the PARTNER (from model output) and edit a partner's proposal. shared_at and the
-- CONVERTED_TO_AGREEMENT move stay the job's.
GRANT SELECT ON proposal TO mwf_app;
GRANT INSERT (session_id, created_by_participant_id, source, kind, status, description, duration, measure_of_success,
              unresolved_need_labels, created_at, updated_at) ON proposal TO mwf_app;
GRANT UPDATE (description, duration, measure_of_success, kind, status, created_by_participant_id, unresolved_need_labels,
              removed_at, removed_by_participant_id, removal_reason, updated_at) ON proposal TO mwf_app;

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
-- mwf_app: the caller's MAIN conversation at createSession / accept / linked process, a Stage 4 sub-chat and its resolution.
GRANT SELECT ON conversation TO mwf_app;
GRANT INSERT (participant_id, kind, anchor_kind, anchor_proposal_id, status, created_at, updated_at) ON conversation TO mwf_app;
GRANT UPDATE (status, resolved_at, updated_at) ON conversation TO mwf_app;

CREATE TABLE empathy_attempt (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    author_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    round integer NOT NULL DEFAULT 1,
    supersedes_attempt_id uuid7 REFERENCES empathy_attempt ON DELETE SET NULL,
    content ciphertext NOT NULL,
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
COMMENT ON COLUMN empathy_attempt.content IS 'encrypted (per-row): the author''s empathy statement; participant (author) key until revealed, then re-encrypted under the session key. The plaintext never changes.';
-- mwf_app: the author submits round 1 (empathy-store submitAttempt); every later move is app.empathy_set_status, and the
-- delivery stamps are the job's.
GRANT SELECT ON empathy_attempt TO mwf_app;
GRANT INSERT (author_participant_id, subject_participant_id, round, content, status, status_version, delivery_status, submitted_at,
              created_at, updated_at)
  ON empathy_attempt TO mwf_app;

CREATE TABLE need (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    label ciphertext NOT NULL,
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
    CHECK (ai_confidence BETWEEN 0 AND 1),
    -- every element is ciphertext (the ciphertext domain; an array of it is refused by step 20)
    CHECK (app.all_ciphertext(evidence))
);
CREATE INDEX ON need (participant_id);
CREATE INDEX ON need (superseded_by_need_id);
-- + sql_need_live (sql-only.sql)
COMMENT ON TABLE need IS 'A need the AI identified for a participant; owner-only, always. A co-participant sees a need only through need_share.';
COMMENT ON COLUMN need.ai_confidence IS 'The model''s confidence in the need, 0 to 1.';
COMMENT ON COLUMN need.locked_at IS 'When the need was locked against further edits.';
COMMENT ON COLUMN need.superseded_by_need_id IS 'The need that replaced this one after an edit.';
COMMENT ON COLUMN need.label IS 'encrypted (participant): the need statement in the participant''s words (AI-identified or typed); free text, not a taxonomy (category is the classification).';
COMMENT ON COLUMN need.evidence IS 'encrypted (participant): text[], each element encrypted: short quotes of what the participant said; never copied to need_share.';
-- mwf_app: the caller's needs — extraction, edits, confirm / lock, supersede and soft delete (needs.ts,
-- needs-edit-applier.service.ts, controllers/stage3.ts). Never a DELETE.
GRANT SELECT ON need TO mwf_app;
GRANT INSERT (participant_id, label, category, evidence, ai_confidence, confirmed_at, created_at, updated_at) ON need TO mwf_app;
GRANT UPDATE (label, category, confirmed_at, locked_at, superseded_by_need_id, deleted_at, updated_at) ON need TO mwf_app;

CREATE TABLE message (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    conversation_id uuid7 NOT NULL REFERENCES conversation ON DELETE CASCADE,
    sender_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    role message_role NOT NULL,
    kind message_kind NOT NULL DEFAULT 'CHAT',
    content ciphertext NOT NULL,
    dedupe_key message_dedupe_key,
    refining_need_id uuid7 REFERENCES need ON DELETE SET NULL,
    source_attempt_id uuid7 REFERENCES empathy_attempt ON DELETE SET NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 message [P02] — P3 §6, "humans can't author as the facilitator"
    CHECK (role <> 'USER' OR sender_participant_id IS NOT NULL),
    CHECK (role NOT IN ('AI', 'SYSTEM') OR sender_participant_id IS NULL),
    -- work-fdc1: a once-only key marks a facilitator line, never a human's
    CHECK (dedupe_key IS NULL OR role IN ('AI', 'SYSTEM'))
);
CREATE INDEX ON message (conversation_id, created_at);
-- + sql_message_once (sql-only.sql)
CREATE INDEX ON message (sender_participant_id);
CREATE INDEX ON message (refining_need_id);
CREATE INDEX ON message (source_attempt_id);
COMMENT ON TABLE message IS 'One line of a conversation: a human turn, an AI or system line, or an item delivered from the other participant. Append-only.';
COMMENT ON COLUMN message.sender_participant_id IS 'The human who wrote a USER line; NULL for AI and SYSTEM lines.';
COMMENT ON COLUMN message.source_attempt_id IS 'Lineage of a delivered item: the empathy attempt it came from.';
COMMENT ON COLUMN message.dedupe_key IS 'Set only on an app-generated AI or SYSTEM line that is written at most once per conversation; sql_message_once makes a second insert conflict. NULL on every other line. Nothing about the content is stored outside the ciphertext.';
COMMENT ON COLUMN message.content IS 'encrypted (per-row): the line''s text: the owner''s turn and the AI''s replies under the participant key, every delivered kind under the session key.';
-- mwf_app: the caller's own turns in their own conversation (message-store createParticipantMessage) and their own copy of
-- an empathy statement (empathy-messages.ts). Never an UPDATE (t_message_immutable; delivered and AI rows are the job's).
-- DELETE: a failed stream turn's USER row (stream-turn-persistence.ts) and — FINDING — the job-written SHARE_SUGGESTION
-- rows of the caller's MAIN conversation when the share offer is declined or accepted (reconciler/sharing.ts).
GRANT SELECT ON message TO mwf_app;
GRANT INSERT (conversation_id, sender_participant_id, role, kind, content, refining_need_id, source_attempt_id, created_at)
  ON message TO mwf_app;
GRANT DELETE ON message TO mwf_app;

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
-- mwf_app: the caller's read state — created with the participant, then viewed / active / seen / share-tab stamps.
GRANT SELECT ON conversation_read_state TO mwf_app;
GRANT INSERT (participant_id, last_viewed_at, last_active_at, last_seen_message_id, last_viewed_share_tab_at, created_at, updated_at)
  ON conversation_read_state TO mwf_app;
GRANT UPDATE (last_viewed_at, last_active_at, last_seen_message_id, last_viewed_share_tab_at, updated_at)
  ON conversation_read_state TO mwf_app;

CREATE TABLE reconciler_result (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    iteration integer NOT NULL DEFAULT 1,
    alignment_score integer NOT NULL,
    alignment_summary ciphertext NOT NULL,
    gap_summary ciphertext NOT NULL,
    gap_severity gap_severity NOT NULL,
    correctly_identified text[] DEFAULT ARRAY[]::text[],
    missed_feelings text[] DEFAULT ARRAY[]::text[],
    misattributions text[] DEFAULT ARRAY[]::text[],
    most_important_gap ciphertext,
    recommended_action recommender_action NOT NULL,
    rationale ciphertext NOT NULL,
    sharing_would_help boolean NOT NULL,
    suggested_share_focus ciphertext,
    suggested_share_content ciphertext,
    suggested_share_reason ciphertext,
    circuit_breaker_tripped boolean NOT NULL DEFAULT false,
    superseded_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (attempt_id, iteration),
    -- §1.2 reconciler_result [P17f]
    CHECK (alignment_score BETWEEN 0 AND 100),
    -- every element is ciphertext (the ciphertext domain; an array of it is refused by step 20)
    CHECK (app.all_ciphertext(correctly_identified)),
    CHECK (app.all_ciphertext(missed_feelings)),
    CHECK (app.all_ciphertext(misattributions))
);
CREATE INDEX ON reconciler_result (subject_participant_id);
-- + sql_result_one_current (sql-only.sql)
COMMENT ON TABLE reconciler_result IS 'The reconciler''s gap analysis of one empathy attempt against its subject''s account; immutable, one current per attempt (superseded_at). Visible to the subject only.';
COMMENT ON COLUMN reconciler_result.subject_participant_id IS 'The attempt''s subject, copied for the read policy; a trigger keeps it equal to empathy_attempt.subject_participant_id.';
COMMENT ON COLUMN reconciler_result.iteration IS '1 for the first analysis of the attempt; +1 per re-analysis.';
COMMENT ON COLUMN reconciler_result.alignment_score IS 'How well the attempt matches the subject''s account, 0 to 100.';
COMMENT ON COLUMN reconciler_result.circuit_breaker_tripped IS 'Meant to mark a result that ended the refinement loop by its circuit breaker; no writer sets it true today and nothing reads it (spec 1.2).';
COMMENT ON COLUMN reconciler_result.superseded_at IS 'Set when a newer result replaces this one; NULL marks the current result.';
COMMENT ON COLUMN reconciler_result.alignment_summary IS 'encrypted (participant): the reconciler''s 1-2 sentence summary of what the attempt got right.';
COMMENT ON COLUMN reconciler_result.gap_summary IS 'encrypted (participant): the reconciler''s 1-2 sentence summary of what it missed.';
COMMENT ON COLUMN reconciler_result.correctly_identified IS 'encrypted (participant): text[], each element encrypted: the feelings the attempt identified, LLM output.';
COMMENT ON COLUMN reconciler_result.missed_feelings IS 'encrypted (participant): text[], each element encrypted: the feelings the attempt missed, LLM output.';
COMMENT ON COLUMN reconciler_result.misattributions IS 'encrypted (participant): text[], each element encrypted: what the attempt attributed wrongly, LLM output.';
COMMENT ON COLUMN reconciler_result.most_important_gap IS 'encrypted (participant): the single most important gap, LLM output, or NULL.';
COMMENT ON COLUMN reconciler_result.rationale IS 'encrypted (participant): why the reconciler recommends its action, LLM output.';
COMMENT ON COLUMN reconciler_result.suggested_share_focus IS 'encrypted (participant): what the subject might share, LLM output, or NULL.';
COMMENT ON COLUMN reconciler_result.suggested_share_content IS 'encrypted (participant): a 1-3 sentence suggestion of what the subject could say, LLM output.';
COMMENT ON COLUMN reconciler_result.suggested_share_reason IS 'encrypted (participant): one sentence on why sharing would help, LLM output.';
-- mwf_app: read only (the share offer's result, the reconciler state the subject sees); every write is the job's.
GRANT SELECT ON reconciler_result TO mwf_app;

CREATE TABLE context_share_offer (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    result_id uuid7 NOT NULL REFERENCES reconciler_result ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    iteration integer NOT NULL DEFAULT 1,
    status share_offer_status NOT NULL DEFAULT 'PENDING',
    offer_message ciphertext,
    suggested_content ciphertext,
    suggested_reason ciphertext,
    shared_content ciphertext,
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
COMMENT ON COLUMN context_share_offer.offer_message IS 'encrypted (participant): the AI''s 2-3 sentence message offering the subject the chance to share.';
COMMENT ON COLUMN context_share_offer.suggested_content IS 'encrypted (participant): the suggested text to share, LLM output or the subject''s AI-assisted draft.';
COMMENT ON COLUMN context_share_offer.suggested_reason IS 'encrypted (participant): why sharing it would help, LLM output.';
COMMENT ON COLUMN context_share_offer.shared_content IS 'encrypted (session): the exact text the subject approved; copied into the author''s SHARED_CONTEXT message at delivery.';
-- mwf_app: the SUBJECT acts on their own offer (reconciler/sharing.ts, controllers/reconciler.ts): view (OFFERED), edit the
-- suggestion, decline, accept with the shared text. Creation and delivery are the job's.
GRANT SELECT ON context_share_offer TO mwf_app;
GRANT UPDATE (status, offered_at, suggested_content, declined_at, shared_content, shared_at, updated_at) ON context_share_offer TO mwf_app;

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
-- mwf_app: reference data (P3 §1.1 pattern), read only.
GRANT SELECT ON milestone TO mwf_app;

CREATE TABLE participant_milestone (
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    milestone_key text NOT NULL REFERENCES milestone ON DELETE RESTRICT,
    reached_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (participant_id, milestone_key)
);
CREATE INDEX ON participant_milestone (milestone_key, reached_at);
COMMENT ON TABLE participant_milestone IS 'Event: a participant reached a milestone at reached_at. Append-only; current stage and readiness are derived from these rows (v_current_stage, v_session_readiness).';
-- mwf_app: the caller reaches the self-assertable keys (milestone-writer reachMilestone: compact_signed, feel_heard,
-- needs_confirmed, choices_shared; the key check is RLS's, step 9); every other key, and un-reaching, is the job's.
GRANT SELECT ON participant_milestone TO mwf_app;
GRANT INSERT (participant_id, milestone_key, reached_at) ON participant_milestone TO mwf_app;
-- Holds only because reachMilestone is raw SQL (INSERT … ON CONFLICT DO NOTHING naming these three
-- columns): a Prisma create would also send created_at.

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
COMMENT ON COLUMN ai_memory.doc IS 'encrypted (per-row): jsonb with every string leaf encrypted (participant key for SUMMARY / NOTABLE_FACTS, user key for GLOBAL_FACTS); the key-presence CHECKs see the plaintext structure.';
-- mwf_app: read the session summary / facts for prompts; FINDING: global-memory.ts writes the user's GLOBAL_FACTS document
-- on the request path (spec: ai_memory is the AI's).
GRANT SELECT ON ai_memory TO mwf_app;
GRANT INSERT (user_id, kind, doc, created_at, updated_at) ON ai_memory TO mwf_app;
GRANT UPDATE (doc, updated_at) ON ai_memory TO mwf_app;

CREATE TABLE mood_reading (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    intensity intensity NOT NULL,
    context ciphertext,
    recorded_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON mood_reading (participant_id, recorded_at);
COMMENT ON TABLE mood_reading IS 'A participant''s barometer reading (1-10) with optional context. Append-only time series.';
COMMENT ON COLUMN mood_reading.context IS 'encrypted (participant): the participant''s optional note on the reading (max 500).';
-- mwf_app: the caller's own mood check-ins (controllers/emotions.ts, user-settings.ts).
GRANT SELECT ON mood_reading TO mwf_app;
GRANT INSERT (participant_id, intensity, context, recorded_at, created_at) ON mood_reading TO mwf_app;

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
-- mwf_app: the caller's own completed regulation exercise (controllers/emotions.ts).
GRANT SELECT ON regulation_event TO mwf_app;
GRANT INSERT (participant_id, type, intensity_before, intensity_after, completed_at, created_at) ON regulation_event TO mwf_app;

CREATE TABLE invitation (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    invited_by_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    accepted_by_user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    invitee_name ciphertext,
    status invitation_status NOT NULL DEFAULT 'PENDING',
    message_confirmed_at ts_ms,
    expires_at ts_ms NOT NULL,
    accepted_at ts_ms,
    declined_at ts_ms,
    decline_reason ciphertext,
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
COMMENT ON COLUMN invitation.invitee_name IS 'encrypted (session): the name the inviter gave the person they invite, typed at session creation (or their nickname / last display name for a known person), because the invitee has no user row yet. Not a copy of user.name; the AI uses it for the partner until they join.';
COMMENT ON COLUMN invitation.decline_reason IS 'encrypted (session): the invitee''s optional reason for declining, free text.';
-- mwf_app: the inviter creates it and confirms its message; the INVITEE accepts / declines / expires it and locks it
-- (FOR UPDATE / FOR SHARE need UPDATE) — FINDING: a write of the inviter's row, a definer function's job later.
GRANT SELECT ON invitation TO mwf_app;
GRANT INSERT (session_id, invited_by_participant_id, invitee_name, status, expires_at, created_at, updated_at) ON invitation TO mwf_app;
GRANT UPDATE (status, accepted_by_user_id, accepted_at, declined_at, decline_reason, message_confirmed_at, updated_at)
  ON invitation TO mwf_app;

CREATE TABLE draft (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    kind draft_kind NOT NULL,
    about_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    attempt_id uuid7 REFERENCES empathy_attempt ON DELETE CASCADE,
    share_offer_id uuid7 REFERENCES context_share_offer ON DELETE CASCADE,
    invitation_id uuid7 REFERENCES invitation ON DELETE CASCADE,
    content ciphertext NOT NULL,
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
COMMENT ON COLUMN draft.content IS 'encrypted (participant): the draft text, AI-proposed or written by the participant.';
-- mwf_app: the caller's drafts (empathy-store upsertDraft, reconciler/sharing.ts, empathy-draft-save reopen, delete).
-- id and created_at: ONLY repointInvitationDrafts — FINDING: at accept the INVITEE's request deletes and re-inserts the
-- INVITER's pre-join drafts (same id, timestamps) to re-point them at the new participant.
GRANT SELECT ON draft TO mwf_app;
GRANT INSERT (id, participant_id, kind, about_participant_id, invitation_id, attempt_id, share_offer_id, content, ready_to_share,
              version, reopened_at, created_at, updated_at) ON draft TO mwf_app;
GRANT UPDATE (content, ready_to_share, version, reopened_at) ON draft TO mwf_app;
-- UPDATE holds without updated_at only because every draft update is raw SQL (upsertDraft's
-- ON CONFLICT DO UPDATE, the reopen stamp; touch_updated_at sets it): a Prisma update would send it.
GRANT DELETE ON draft TO mwf_app;

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
-- mwf_app: none. Key material is never the request path's (work-k5fk.10.2; target-roles negative test).

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
-- mwf_app: none. Key material is never the request path's (work-k5fk.10.2; target-roles negative test).

CREATE TABLE empathy_review (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    reviewer_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    validated boolean NOT NULL,
    feedback ciphertext,
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
COMMENT ON COLUMN empathy_review.feedback IS 'encrypted (session): the subject''s feedback on the attempt, sent explicitly (max 500).';
-- mwf_app: the reviewer's own review of the partner's attempt (empathy-store recordReview).
GRANT SELECT ON empathy_review TO mwf_app;
GRANT INSERT (attempt_id, reviewer_participant_id, validated, feedback, feedback_sent_at, created_at, updated_at) ON empathy_review TO mwf_app;
GRANT UPDATE (validated, feedback, feedback_sent_at, updated_at) ON empathy_review TO mwf_app;

CREATE TABLE reconciler_guidance (
    result_id uuid7 NOT NULL PRIMARY KEY REFERENCES reconciler_result ON DELETE CASCADE,
    author_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    subject_participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    area_hint ciphertext,
    guidance_type guidance_type,
    prompt_seed ciphertext,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON reconciler_guidance (author_participant_id);
CREATE INDEX ON reconciler_guidance (subject_participant_id);
COMMENT ON TABLE reconciler_guidance IS 'The abstract hints from a reconciler result that the author may see (P3 D8a split from reconciler_result, which only the subject sees).';
COMMENT ON COLUMN reconciler_guidance.author_participant_id IS 'The attempt''s author, who may read this row.';
COMMENT ON COLUMN reconciler_guidance.area_hint IS 'encrypted (participant): a coarse area for the author to explore (one of six code phrases in generateAbstractGuidance).';
COMMENT ON COLUMN reconciler_guidance.prompt_seed IS 'encrypted (participant): the refinement prompt''s seed phrase (one of three code phrases, by guidance_type).';
-- mwf_app: read only (the author's abstract hints); written by the job.
GRANT SELECT ON reconciler_guidance TO mwf_app;

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
-- mwf_app: the caller's own decisions — on their attempt, a review, a share offer, a need — and their revocation.
GRANT SELECT ON consent TO mwf_app;
GRANT INSERT (participant_id, requested_by_participant_id, empathy_attempt_id, need_id, share_offer_id, review_id, decision, decided_at,
              created_at, updated_at) ON consent TO mwf_app;
GRANT UPDATE (decision, decided_at, revoked_at, updated_at) ON consent TO mwf_app;

CREATE TABLE need_share (
    need_id uuid7 NOT NULL PRIMARY KEY REFERENCES need ON DELETE RESTRICT,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    category need_category NOT NULL,
    shared_text ciphertext NOT NULL,
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
COMMENT ON COLUMN need_share.shared_text IS 'encrypted (session): the heat-removed sentence the partner sees (one short first-person sentence written by the job, or a fixed per-category fallback).';
-- mwf_app: read only (v_need_shared and the tending reads); app.need_share / app.need_revoke_share are the writers.
GRANT SELECT ON need_share TO mwf_app;

CREATE TABLE need_disposition (
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    need_id uuid7 NOT NULL REFERENCES need_share ON DELETE CASCADE,
    status need_disposition_status NOT NULL DEFAULT 'OPEN',
    is_current boolean NOT NULL DEFAULT false,
    note ciphertext,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (participant_id, need_id)
);
CREATE INDEX ON need_disposition (need_id);
-- + sql_disposition_one_current (sql-only.sql)
COMMENT ON TABLE need_disposition IS 'How a participant dispositions a shared need during the Stage-4 walkthrough (their own or the other''s); one current need per walkthrough.';
COMMENT ON COLUMN need_disposition.is_current IS 'The need the walkthrough is on (at most one per participant).';
COMMENT ON COLUMN need_disposition.note IS 'encrypted (participant): a note on the disposition; no writer sets it today.';
-- mwf_app: the caller's Stage 4 walkthrough dispositions (stage4-walkthrough.ts), including un-declining (DELETE).
GRANT SELECT ON need_disposition TO mwf_app;
GRANT INSERT (participant_id, need_id, status, is_current, created_at, updated_at) ON need_disposition TO mwf_app;
GRANT UPDATE (status, is_current, updated_at) ON need_disposition TO mwf_app;
GRANT DELETE ON need_disposition TO mwf_app;

CREATE TABLE proposal_need (
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    need_id uuid7 NOT NULL REFERENCES need_share ON DELETE CASCADE,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (proposal_id, need_id)
);
CREATE INDEX ON proposal_need (need_id);
COMMENT ON TABLE proposal_need IS 'Which shared needs a proposal addresses.';
-- mwf_app: setProposalNeeds re-points a proposal's needs (stage4-store.ts).
GRANT SELECT ON proposal_need TO mwf_app;
GRANT INSERT (proposal_id, need_id, created_at) ON proposal_need TO mwf_app;
GRANT DELETE ON proposal_need TO mwf_app;

CREATE TABLE proposal_choice (
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    decision choice_decision NOT NULL,
    note ciphertext,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (proposal_id, participant_id)
);
CREATE INDEX ON proposal_choice (participant_id);
COMMENT ON TABLE proposal_choice IS 'A participant''s willingness on a proposal; private until the choices_shared milestone.';
COMMENT ON COLUMN proposal_choice.note IS 'encrypted (session): the participant''s note on their choice (route max 1000), or their chat message when the choice was inferred.';
-- mwf_app: the caller's own choice (stage4-store upsertChoice). created_at in UPDATE: upsertChoice's
-- ON CONFLICT DO UPDATE re-stamps it.
GRANT SELECT ON proposal_choice TO mwf_app;
GRANT INSERT (proposal_id, participant_id, decision, note, created_at, updated_at) ON proposal_choice TO mwf_app;
GRANT UPDATE (decision, note, created_at) ON proposal_choice TO mwf_app;
-- No DELETE: withdrawChoice (stage4-store.ts) has no caller (review round 1, M4).

CREATE TABLE proposal_revision (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    actor_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    action revision_action NOT NULL,
    before jsonb,
    after jsonb,
    reason proposal_revision_reason,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 proposal_revision [P23c]
    CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
    CHECK (after IS NULL OR jsonb_typeof(after) = 'object')
);
CREATE INDEX ON proposal_revision (proposal_id, created_at);
CREATE INDEX ON proposal_revision (actor_participant_id);
COMMENT ON TABLE proposal_revision IS 'Append-only audit of proposal changes, with before/after snapshots.';
COMMENT ON COLUMN proposal_revision.actor_participant_id IS 'Who made the change; NULL for the AI or the app.';
COMMENT ON COLUMN proposal_revision.reason IS 'An app marker or NULL; never user or model text (R47).';
COMMENT ON COLUMN proposal_revision.before IS 'encrypted (session): jsonb envelope {"$enc": ...}: the proposal fields before the change.';
COMMENT ON COLUMN proposal_revision.after IS 'encrypted (session): jsonb envelope {"$enc": ...}: the proposal fields after the change, and any text explaining it.';
-- mwf_app: the audit row of a caller's edit (controllers/stage4.ts, stage4-capture, stage4-subchat). Append-only.
GRANT SELECT ON proposal_revision TO mwf_app;
GRANT INSERT (proposal_id, actor_participant_id, action, before, after, reason, created_at) ON proposal_revision TO mwf_app;

CREATE TABLE agreement (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    proposal_id uuid7 NOT NULL UNIQUE REFERENCES proposal ON DELETE RESTRICT,
    type agreement_type NOT NULL,
    status agreement_status NOT NULL DEFAULT 'AGREED',
    description ciphertext NOT NULL,
    duration ciphertext,
    measure_of_success ciphertext,
    follow_up_at ts_ms,
    completed_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON agreement (session_id, status);
COMMENT ON TABLE agreement IS 'A proposal every willing party accepted; at most one per proposal.';
COMMENT ON COLUMN agreement.session_id IS 'The proposal''s session, kept for the agreement''s own read policy and session queries.';
COMMENT ON COLUMN agreement.description IS 'encrypted (session): the proposal''s description, copied at conversion.';
COMMENT ON COLUMN agreement.duration IS 'encrypted (session): the proposal''s free-text duration, copied at conversion. NOT a true interval.';
COMMENT ON COLUMN agreement.measure_of_success IS 'encrypted (session): the proposal''s measure of success, copied at conversion.';
-- mwf_app: read only; agreements are created and moved by the job.
GRANT SELECT ON agreement TO mwf_app;

CREATE TABLE agreement_party (
    agreement_id uuid7 NOT NULL REFERENCES agreement ON DELETE CASCADE,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    agreed_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (agreement_id, participant_id)
);
CREATE INDEX ON agreement_party (participant_id);
COMMENT ON TABLE agreement_party IS 'Who is party to an agreement.';
-- mwf_app: read only (an agreement's parties).
GRANT SELECT ON agreement_party TO mwf_app;

CREATE TABLE session_closure (
    session_id uuid7 NOT NULL PRIMARY KEY REFERENCES session ON DELETE CASCADE,
    kind closure_kind NOT NULL,
    reason closure_reason NOT NULL,
    summary ciphertext NOT NULL,
    closed_by_participant_id uuid7 REFERENCES participant ON DELETE CASCADE,
    check_in_at ts_ms,
    closed_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON session_closure (closed_by_participant_id);
COMMENT ON TABLE session_closure IS 'How the repair stage of a session ended, one row per closed session.';
COMMENT ON COLUMN session_closure.closed_by_participant_id IS 'Who closed it; NULL for an automatic closure.';
COMMENT ON COLUMN session_closure.summary IS 'encrypted (session): how the repair stage ended, from the participant (max 2000) or a code template.';
-- mwf_app: read only; the closure is the job's.
GRANT SELECT ON session_closure TO mwf_app;

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
    summary ciphertext,
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
COMMENT ON COLUMN follow_up.summary IS 'encrypted (session): a code-templated line naming what is checked on, with the agreement or commitment text.';
-- mwf_app: the owner's share opt-in and a user-initiated re-entry (tending.service.ts); scheduling and cycle moves are the job's.
GRANT SELECT ON follow_up TO mwf_app;
GRANT INSERT (session_id, type, scope, owner_participant_id, opted_in_shared, status, opened_at, summary, created_at, updated_at)
  ON follow_up TO mwf_app;
GRANT UPDATE (opted_in_shared, updated_at) ON follow_up TO mwf_app;

CREATE TABLE follow_up_checkin (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    follow_up_id uuid7 NOT NULL REFERENCES follow_up ON DELETE CASCADE,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    next_action next_action,
    continue_choice continue_choice,
    reflection_summary ciphertext,
    payload jsonb NOT NULL DEFAULT '{}',
    submitted_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (follow_up_id, participant_id),
    -- §1.5 follow_up_checkin
    CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX ON follow_up_checkin (participant_id, submitted_at);
COMMENT ON TABLE follow_up_checkin IS 'One participant''s answers to a follow-up, one per participant; the structured answers are a document (payload).';
COMMENT ON COLUMN follow_up_checkin.reflection_summary IS 'encrypted (session): the participant''s reflection at the check-in (max 4000).';
COMMENT ON COLUMN follow_up_checkin.payload IS 'encrypted (session): jsonb envelope {"$enc": ...}: the structured answers (FollowUpCheckinPayload).';
-- mwf_app: the caller's own check-in (tending insertCheckin). Append-only.
GRANT SELECT ON follow_up_checkin TO mwf_app;
GRANT INSERT (follow_up_id, participant_id, next_action, continue_choice, reflection_summary, payload, submitted_at, created_at)
  ON follow_up_checkin TO mwf_app;

CREATE TABLE follow_up_note (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    participant_id uuid7 NOT NULL REFERENCES participant ON DELETE CASCADE,
    content ciphertext NOT NULL,
    carry_forward boolean NOT NULL DEFAULT false,
    carried_into_checkin_id uuid7 REFERENCES follow_up_checkin ON DELETE SET NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON follow_up_note (participant_id, created_at);
CREATE INDEX ON follow_up_note (carried_into_checkin_id);
COMMENT ON TABLE follow_up_note IS 'A private between-period note; it can be carried into a later check-in.';
COMMENT ON COLUMN follow_up_note.carried_into_checkin_id IS 'The check-in this note was copied into (payload.carriedNotes).';
COMMENT ON COLUMN follow_up_note.content IS 'encrypted (participant): the note text (max 4000).';
-- mwf_app: the caller's between-period notes and their carry-forward into a check-in.
GRANT SELECT ON follow_up_note TO mwf_app;
GRANT INSERT (participant_id, content, carry_forward, created_at, updated_at) ON follow_up_note TO mwf_app;
GRANT UPDATE (carry_forward, carried_into_checkin_id, updated_at) ON follow_up_note TO mwf_app;

CREATE TABLE reminder (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    follow_up_id uuid7 REFERENCES follow_up ON DELETE CASCADE,
    scope reminder_scope NOT NULL DEFAULT 'PRIVATE',
    remind_at ts_ms NOT NULL,
    cadence reminder_cadence,
    note ciphertext,
    status reminder_status NOT NULL DEFAULT 'SCHEDULED',
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON reminder (user_id, remind_at);
CREATE INDEX ON reminder (follow_up_id);
-- + sql_reminder_due (sql-only.sql)
COMMENT ON TABLE reminder IS 'A scheduled nudge for one user, optionally tied to a follow-up; the job delivers due ones.';
COMMENT ON COLUMN reminder.cadence IS 'How often the reminder repeats; NULL and ONCE are one-shot.';
COMMENT ON COLUMN reminder.note IS 'encrypted (user): the reminder''s note (max 1000); the app sends a fixed label today.';
-- mwf_app: the caller's own reminder at check-in; delivery and the next instant are the job's.
GRANT SELECT ON reminder TO mwf_app;
GRANT INSERT (user_id, follow_up_id, scope, remind_at, cadence, note, status, created_at, updated_at) ON reminder TO mwf_app;

CREATE TABLE reflection (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    title ciphertext,
    theme text,
    status reflection_status NOT NULL DEFAULT 'ACTIVE',
    summary ciphertext,
    summary_doc jsonb,
    linked_session_id uuid7 REFERENCES session ON DELETE SET NULL,
    linked_at ts_ms,
    context_snapshot ciphertext,
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
COMMENT ON COLUMN reflection.theme IS 'Free LLM text ("a single word or short phrase", e.g. anxiety), not a taxonomy; v_reflection_theme groups by the exact string.';
COMMENT ON COLUMN reflection.title IS 'encrypted (user): the reflection''s title, typed (max 200) or AI-generated (3-6 words).';
COMMENT ON COLUMN reflection.summary IS 'encrypted (user): a one-sentence AI summary of the reflection.';
COMMENT ON COLUMN reflection.summary_doc IS 'encrypted (user): jsonb envelope {"$enc": ...}: the rolling conversation summary.';
COMMENT ON COLUMN reflection.context_snapshot IS 'encrypted (user): the AI''s 2-3 sentence context summary captured when the reflection started a session.';
-- mwf_app: the caller's Inner Thoughts reflections (controllers/inner-work.ts, distillation, summarizer, classifier, and the
-- link to a session at createSession).
GRANT SELECT ON reflection TO mwf_app;
GRANT INSERT (user_id, title, status, linked_session_id, linked_at, created_at, updated_at) ON reflection TO mwf_app;
GRANT UPDATE (title, summary, theme, status, linked_session_id, linked_at, context_snapshot, summary_doc, distilled_at, updated_at)
  ON reflection TO mwf_app;

CREATE TABLE reflection_message (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    reflection_id uuid7 NOT NULL REFERENCES reflection ON DELETE CASCADE,
    role message_role NOT NULL,
    content ciphertext NOT NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON reflection_message (reflection_id, created_at);
COMMENT ON TABLE reflection_message IS 'One line of a reflection thread.';
COMMENT ON COLUMN reflection_message.content IS 'encrypted (user): the line''s text (max 10000 for a user turn).';
-- mwf_app: the turns of the caller's reflection (both the user's and the AI reply, written on the request path). Append-only.
GRANT SELECT ON reflection_message TO mwf_app;
GRANT INSERT (reflection_id, role, content, created_at) ON reflection_message TO mwf_app;

CREATE TABLE takeaway (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    reflection_id uuid7 NOT NULL REFERENCES reflection ON DELETE CASCADE,
    content ciphertext NOT NULL,
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
COMMENT ON COLUMN takeaway.theme IS 'Free LLM text, optional; not a taxonomy.';
COMMENT ON COLUMN takeaway.content IS 'encrypted (user): one sentence: the insight, action item or intention (AI-distilled or edited by the user).';
-- mwf_app: distillation replaces the AI takeaways; the caller edits, resolves and deletes their own.
GRANT SELECT ON takeaway TO mwf_app;
GRANT INSERT (reflection_id, content, theme, source, type, position, created_at, updated_at) ON takeaway TO mwf_app;
GRANT UPDATE (content, source, resolved_at, updated_at) ON takeaway TO mwf_app;
GRANT DELETE ON takeaway TO mwf_app;

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
-- mwf_app: the caller's manual links between their takeaways.
GRANT SELECT ON takeaway_link TO mwf_app;
GRANT INSERT (source_id, target_id, link_type, created_at) ON takeaway_link TO mwf_app;
GRANT DELETE ON takeaway_link TO mwf_app;

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
-- mwf_app: the caller's push token registration / clearing and biometric setting (user-settings.ts); other users' tokens are
-- read by the job (push.ts).
GRANT SELECT ON user_device TO mwf_app;
GRANT INSERT (user_id, push_token, platform, last_seen_at, biometric_enabled, biometric_enrolled_at, created_at, updated_at)
  ON user_device TO mwf_app;
GRANT UPDATE (push_token, platform, last_seen_at, biometric_enabled, biometric_enrolled_at, updated_at) ON user_device TO mwf_app;

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
-- mwf_app: the caller's settings document (user-settings.ts; FOR UPDATE needs UPDATE).
GRANT SELECT ON user_preferences TO mwf_app;
GRANT INSERT (user_id, doc) ON user_preferences TO mwf_app;
-- INSERT holds without the timestamps only because the row is created by raw SQL
-- (user-settings.ts INSERT … ON CONFLICT DO NOTHING); a Prisma create would send them.
GRANT UPDATE (doc, updated_at) ON user_preferences TO mwf_app;

CREATE TABLE user_memory (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    session_id uuid7 REFERENCES session ON DELETE CASCADE,
    content ciphertext NOT NULL,
    category memory_category NOT NULL,
    status memory_status NOT NULL DEFAULT 'ACTIVE',
    source memory_source NOT NULL DEFAULT 'USER_APPROVED',
    suggested_text ciphertext,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON user_memory (user_id, status);
CREATE INDEX ON user_memory (session_id);
COMMENT ON TABLE user_memory IS '"Things to always remember": standing instructions the user approved or wrote, optionally scoped to a session.';
COMMENT ON COLUMN user_memory.session_id IS 'NULL for a memory that applies everywhere; set for one scoped to a session.';
COMMENT ON COLUMN user_memory.content IS 'encrypted (user): the standing instruction (2 to 500 characters).';
COMMENT ON COLUMN user_memory.suggested_text IS 'encrypted (user): the AI''s original text when the user edited it before approving, or the pre-edit text.';
-- mwf_app: the caller's memories (controllers/memories.ts, memory-service.ts), including deleting one.
GRANT SELECT ON user_memory TO mwf_app;
GRANT INSERT (user_id, session_id, content, category, status, source, suggested_text, created_at, updated_at) ON user_memory TO mwf_app;
GRANT UPDATE (session_id, content, category, status, source, suggested_text, updated_at) ON user_memory TO mwf_app;
GRANT DELETE ON user_memory TO mwf_app;

CREATE TABLE feature_state (
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    feature wellbeing_feature NOT NULL,
    doc jsonb NOT NULL DEFAULT '{}',
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, feature),
    -- §1.7 feature_state
    CHECK (jsonb_typeof(doc) = 'object')
);
COMMENT ON TABLE feature_state IS 'One document per wellbeing feature per user (meditation, gratitude, needs assessment, people).';
COMMENT ON COLUMN feature_state.feature IS 'Which wellbeing feature this document belongs to.';
COMMENT ON COLUMN feature_state.doc IS 'encrypted (user): jsonb envelope {"$enc": ...}: the feature''s document (one zod contract per feature, shared/src/dto/feature-state.ts).';
-- mwf_app: the caller's per-feature state document (feature-state.ts; FOR UPDATE needs UPDATE).
GRANT SELECT ON feature_state TO mwf_app;
GRANT INSERT (user_id, feature, doc) ON feature_state TO mwf_app;
-- INSERT holds without the timestamps only because the row is created by raw SQL
-- (feature-state.ts INSERT … ON CONFLICT DO NOTHING); a Prisma create would send them.
GRANT UPDATE (doc, updated_at) ON feature_state TO mwf_app;

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
-- mwf_app: none. Key material is never the request path's (work-k5fk.10.2; target-roles negative test).

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
-- mwf_app: none. LLM prompts and outputs are written by the job and read by mwf_ops only (TS-12).
