-- ============================================================================
-- tables.sql — section 1 of the target_shape_baseline migration (work-a39h.11.40).
-- Hand-maintained; backend/scripts/gen-target-migration.ts copies it verbatim
-- after the preamble. It is the source of truth for the 49 tables: read a
-- table here and you have all of it — columns, types, defaults, NOT NULL,
-- generated columns, the primary key, UNIQUE constraints, foreign keys and
-- CHECKs inside its CREATE TABLE, its plain indexes straight after, then its
-- grants (every role's) and, for milestone, its seed rows.
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
--    a `-- + sql_…` line), triggers, functions and views (trailer.sql; each
--    view's and each function's grants follow it there).
--  * Grantees are capability roles, never logins (work-k5fk.10.4; design note
--    §6 "Roles — one per kind of actor", Q16): a `-- mwf_app:` label names the
--    actor and its uses, the GRANT goes to that login's one capability —
--    mwf_app → app_access, mwf_ai → ai_access, mwf_worker → worker_access,
--    mwf_ops → ops_access, mwf_auth → auth_access. mwf_job (and its interim
--    job_access) is retired (work-k5fk.10.5, §7 row 9b): its call sites moved
--    to mwf_ai (the AI: the reconciler, the facilitator's AI / SYSTEM lines,
--    the summarizer and classifier, brain telemetry — one session at a time,
--    app.session_scope), mwf_worker (scheduled jobs, notification delivery,
--    the Stage 4 closure's cross-participant decision) and SECURITY DEFINER
--    functions mwf_app calls (the request path's cross-partner writes, trailer
--    T4). Each `-- mwf_ai:` / `-- mwf_worker:` label names the call sites that
--    use the grant, read from the code; nothing was copied from job_access.
--    mwf_definer (NOLOGIN) owns every SECURITY DEFINER function (trailer T4)
--    and holds what their bodies, and the invoker triggers their writes fire,
--    touch (`-- mwf_definer:`). The roles are cluster-level (infra/aws/roles.sql).
--  * Every role's table grants follow each table, in this order: mwf_app,
--    mwf_ai, mwf_worker, mwf_ops (work-k5fk.7 moved mwf_job's and mwf_ops' here from
--    trailer.sql T7 unchanged — app-grants.target.test.ts snapshots the whole
--    privilege matrix, recorded before the move). mwf_auth has none (functions
--    only); slam_bot_readonly's SELECT is a default ACL set by the
--    infrastructure (infra/aws/init-db.sh), not by this migration.
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
--  * mwf_ai's, mwf_worker's and mwf_definer's grants: exactly what their own
--    call sites and the definer helpers read and write. The [TS-n] tags below
--    are history: those grants were mwf_job's until work-k5fk.10.5 split them
--    by call site (the AI's to mwf_ai, the scheduled and Stage 4 closure ones
--    to mwf_worker, the request path's two-party writes into definers).
--    Column lists everywhere a column list exists:
--    SELECT only the id / FK / filter columns a function reads (an UPDATE or
--    DELETE with a WHERE needs SELECT on what it reads), UPDATE only the
--    columns a function writes — never a routing column
--    (participant.user_id/session_id, empathy_attempt.author/subject; Phase 3
--    §4). DELETE cannot be narrowed. Each grant names its caller; a [TS-n]
--    tag says which task added it:
--      [TS-9]  the job connection's own writers in the app (spec §1.1 message
--              "Key per row" — AI/SYSTEM rows and every delivered kind are
--              mwf_job's; participant_milestone — system keys are mwf_job's;
--              ai_memory — "in practice written by mwf_job").
--      [TS-10] the reconciler's and the reveal's job writers (spec §1.2 —
--              reconciler_result "I/U job", reconciler_guidance "I job",
--              context_share_offer "I job … mwf_job for delivery/notification
--              columns"; services/reconciler/*, controllers/notifications.ts).
--      [TS-10 I4] (Ruling R35) the reconciler READER. The reconciler runs as
--              the job: every read of the analysis path
--              (services/reconciler/{analysis,state,sharing,circuit-breaker}.ts,
--              stage2.ts triggerReconcilerAndUpdateStatuses) goes through
--              mwf_job, so the request that triggered an analysis never reads
--              the other participant's private rows on its own connection.
--              These are exactly the analysis inputs; nothing else.
--      [TS-11] the job's writers in needs, repair and follow-up (spec §1.4
--              agreement "I job (the mutual-willingness path)", agreement_party
--              "I job", session_closure "I job", proposal "U … mwf_job (status,
--              shared_at)", proposal_revision "I … job", follow_up "I … job
--              (scheduler) · U … job (status)", reminder "status → DELIVERED by
--              mwf_job"). Every job write is a raw INSERT/UPDATE naming exactly
--              these columns (no client-side defaults).
--      [TS-12] the job's writers and readers in telemetry, notifications,
--              deletion and retention (spec §1.8 brain_activity "mwf_job
--              writes, mwf_ops reads"; R35 — the job is the principal for work
--              that crosses users, the anonymise walk and retention). Every job
--              statement is raw and names exactly these columns.
--  * mwf_ops' grants: SELECT on exactly the columns the Neural Monitor
--    dashboard (routes/brain.ts) reads, directly or through the stage shim —
--    column lists everywhere, and never a ciphertext or jsonb-envelope column
--    (work-k5fk.9: the owner's least privilege, and "close all": the monitor
--    gets telemetry and structure, never text a user or the AI wrote).
--  * The [Pnn] tags on the CHECKs name the TS-7 data-move prechecks that
--    guarded each rule; kept as cross-references.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Domains. All are invisible to Prisma: a uuid7 column introspects as
-- String @db.Uuid, a ts_ms column as DateTime @db.Timestamptz(3), an
-- intensity or ordinal_no column as Int, an email, kek_id or person_name
-- column as String, and `migrate diff` reports nothing (TS-6 probe for
-- intensity, 2026-10-19; work-a39h.11.40 probe for uuid7, 2026-11-02;
-- work-gevt for ts_ms, 2026-11-10; work-k5fk.5 for email, 2026-11-13;
-- work-k5fk.9 for ordinal_no, kek_id and person_name, 2026-11-19 — the drift
-- gate passes with them; PG 18.6 / Prisma 7.10).
-- ----------------------------------------------------------------------------

-- Every uuid column (the uuidv7() primary keys and the columns that reference
-- them; gen-target-migration.ts UUID7_COLUMNS counts them) is a uuid7: a version-7 UUID, so ids sort by creation time.
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
-- REQUIRE_FIELD_ENCRYPTION becomes mandatory. The text[] columns are
-- ciphertext_list (below), not ciphertext[]: an array of a domain has its own
-- type OID, which node-postgres does not parse (step 20). Of the eight jsonb columns in the map,
-- the seven jsonb-envelope ones are typed by a domain per contract whose CHECK is the envelope
-- rule (app.jsonb_envelope_violation, below; brain_activity.input and output since work-k5fk.9,
-- OD-1) and ai_memory.doc (jsonb-leaves) carries the structural t_doc_schema trigger (work-k5fk.8,
-- trailer.sql T5); all eight have a COMMENT starting 'encrypted'.
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
COMMENT ON FUNCTION app.all_ciphertext(text[]) IS 'True when every element is a ciphertext; raises the ciphertext domain error otherwise. The CHECK of the ciphertext_list domain.';

-- Every encrypted text[] column (SENSITIVE_FIELD_MAP, kind text[]) is a
-- ciphertext_list: a text[] whose every element is a ciphertext, so the type
-- says the column is encrypted. A domain over text[], not an array of the
-- ciphertext domain: drivers see the base type (text[], oid 1009) and
-- node-postgres parses it into a string array, where ciphertext[] would have
-- its own oid and arrive as the string '{…}' (step 20 refuses one).
CREATE DOMAIN ciphertext_list AS text[] CHECK (app.all_ciphertext(VALUE));
COMMENT ON DOMAIN ciphertext_list IS 'A text[] whose every element is a ciphertext (the ciphertext domain, checked by app.all_ciphertext): each element encrypted by the app on its own; every encrypted text[] column. Drivers see text[] (oid 1009); Prisma sees String[]. NULL elements and a NULL array pass.';

-- The envelope rule for the seven jsonb-envelope columns: the CHECK of each envelope domain (the
-- jsonb documents section below; brain_activity.input and output since work-k5fk.9). Here, in the
-- prelude, because a domain's CHECK needs its function first (typed domains, 2026-11-23; it was the
-- t_jsonb_envelope trigger's). IMMUTABLE and reads no table, so pg_dump/restore order cannot break it.
-- Lenient exactly as the ciphertext domain is: with no FIELD_ENCRYPTION_KEY
-- (keyless dev/test, and production until REQUIRE_FIELD_ENCRYPTION)
-- sealFieldValue stores the plain document, and follow_up_checkin's DEFAULT
-- writes '{}'; so an object WITHOUT a "$enc" key passes. One WITH it is an
-- envelope and must be well formed: "$enc" its only key, a string, starting
-- enc: (plaintext in the envelope is refused — the domain alone would let it
-- through) and castable to ciphertext (a malformed ciphertext is refused).
-- A non-object is refused too. The strict variant (every document an envelope)
-- lands with the strict ciphertext domain (work-k5fk.11), here, in one place.
-- Returns the reason, never the value; NULL when the document passes. A domain
-- CHECK refusal names the domain and the constraint only (no DETAIL, no value).
CREATE FUNCTION app.jsonb_envelope_violation(doc jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF doc IS NULL THEN RETURN NULL; END IF;
    IF jsonb_typeof(doc) <> 'object' THEN RETURN 'not an object, got ' || jsonb_typeof(doc); END IF;
    IF NOT doc ? '$enc' THEN RETURN NULL; END IF;
    IF doc - '$enc' <> '{}'::jsonb THEN RETURN 'a sealed document has "$enc" as its only key'; END IF;
    IF jsonb_typeof(doc -> '$enc') <> 'string' THEN RETURN '"$enc" is not a string, got ' || jsonb_typeof(doc -> '$enc'); END IF;
    IF doc ->> '$enc' NOT LIKE 'enc:%' THEN RETURN '"$enc" is not a ciphertext (plaintext in an envelope)'; END IF;
    BEGIN
      PERFORM (doc ->> '$enc')::public.ciphertext;
    EXCEPTION WHEN check_violation THEN
      RETURN '"$enc" is a malformed ciphertext';
    END;
    RETURN NULL;
  END
  $$;
COMMENT ON FUNCTION app.jsonb_envelope_violation(jsonb) IS 'Why a jsonb-envelope document is refused, or NULL: a document with "$enc" must be exactly {"$enc": <a v1 ciphertext>}; a non-object is refused; an object without "$enc" passes (keyless plaintext, as the ciphertext domain lets plaintext through). Never quotes the value. The CHECK of every envelope domain (feature_state_json_schema, checkin_payload_json_schema, proposal_snapshot_json_schema, reflection_summary_json_schema, llm_call_input_json_schema, llm_call_output_json_schema).';
-- A domain CHECK runs with the writer's rights, also for a row whose INSERT leaves the column to its default: every
-- role that may INSERT into a table with an envelope column, or UPDATE one, runs it (step 20 asserts it, T8).
-- app_access (mwf_app's: feature_state, follow_up_checkin, proposal_revision, reflection), worker_access (mwf_worker's:
-- proposal_revision INSERT, brain_activity input / output purge), ai_access (mwf_ai's: brain_activity, brain-service
-- start/completeActivity; owner decision OD-1, work-k5fk.9).
REVOKE EXECUTE ON FUNCTION app.jsonb_envelope_violation(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.jsonb_envelope_violation(jsonb) TO app_access;
GRANT EXECUTE ON FUNCTION app.jsonb_envelope_violation(jsonb) TO worker_access;
GRANT EXECUTE ON FUNCTION app.jsonb_envelope_violation(jsonb) TO ai_access;

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

-- work-k5fk.9 (D2): a 1-based ordinal — a message's seq and its conversation's next_seq, the last seen seq,
-- an attempt's round, a result's or an offer's iteration, a draft's version. Not milestone.ordinal (0 = paused).
-- Prisma reads it as Int, like intensity.
CREATE DOMAIN ordinal_no AS integer CHECK (VALUE >= 1);
COMMENT ON DOMAIN ordinal_no IS 'A 1-based ordinal: 1, 2, 3 … (message.seq, conversation.next_seq, conversation_read_state.last_seen_seq, empathy_attempt.round, reconciler_result.iteration, context_share_offer.iteration, draft.version).';

-- work-k5fk.9 (D3): the id of the KMS key (the KEK) that wrapped a DEK (session_key, participant_key, user_key).
-- No format is fixed yet (nothing writes these tables before W13), so only its bounds: 1..2048 characters (an
-- AWS KMS key ARN or alias fits) with no whitespace or control character. The wrapped key itself is a wrapped_dek
-- (below): its format is fixed at W13, and that domain is where it tightens.
CREATE DOMAIN kek_id AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 2048 AND VALUE COLLATE "C" !~ '[[:space:][:cntrl:]]');
COMMENT ON DOMAIN kek_id IS 'The id of the KMS key (the KEK) that wrapped a data key: 1-2048 characters, no whitespace or control character. No format is fixed before W13.';

-- Typed domains (owner, 2026-11-23): a data key (DEK) wrapped by the KMS key named in kek_id — session_key,
-- participant_key and user_key.wrapped_dek. The format is fixed at W13 (nothing writes these tables before it), and
-- this domain is where it tightens; until then only its bounds: 1..6144 bytes, the largest ciphertext blob AWS KMS
-- Encrypt returns. Prisma reads it as Bytes.
CREATE DOMAIN wrapped_dek AS bytea CHECK (octet_length(VALUE) BETWEEN 1 AND 6144);
COMMENT ON DOMAIN wrapped_dek IS 'A data key (DEK) wrapped by a KMS key (the KEK, kek_id): 1-6144 bytes (the AWS KMS ciphertext blob limit). Never an unwrapped key. The format is fixed at W13, which tightens this domain.';

-- Typed domains (owner, 2026-11-23): an install's push token (user_device.push_token), in its provider's format
-- (push_provider; today Expo's ExponentPushToken[…], which Expo.isExpoPushToken checks in the app). Only bounds here,
-- since a new provider brings its own format: 1..512 characters (the API contract's max) with no whitespace or
-- control character (pg_c_utf8: Unicode White_Space and Cc), which no Expo, APNs (hex) or FCM token contains.
CREATE DOMAIN push_token AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 512 AND VALUE COLLATE pg_c_utf8 !~ '[[:space:][:cntrl:]]');
COMMENT ON DOMAIN push_token IS 'A device push token in its provider''s format (user_device.push_provider): 1-512 characters, no whitespace or control character. The app validates the format per provider (push.ts, Expo.isExpoPushToken).';

-- Typed domains (owner, 2026-11-23): the model id an AI call used (brain_activity.model): a Bedrock model or
-- inference-profile id (global.anthropic.claude-haiku-4-5-20251001-v1:0, amazon.titan-embed-text-v2:0;
-- lib/bedrock.ts BEDROCK_*_MODEL_ID) or a pseudo-model of the app's (system-retrieval, context-retriever.ts; test
-- names such as claude-sonnet, test-model). Not an enum or a lookup table: the ids come from environment config and
-- change without a migration. So only the spelling: 1..200 of lower-case letters, digits and . - _ :.
CREATE DOMAIN model_id AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 200 AND VALUE COLLATE "C" ~ '^[a-z0-9._:-]+$');
COMMENT ON DOMAIN model_id IS 'A model id as Bedrock spells it (e.g. global.anthropic.claude-haiku-4-5-20251001-v1:0, amazon.titan-embed-text-v2:0) or an app pseudo-model (system-retrieval): 1-200 lower-case letters, digits and . - _ :. Not a closed set: model ids come from environment config.';

-- Typed domains (owner, 2026-11-23): the id that correlates the AI calls of one request or chat turn
-- (brain_activity.turn_id). Ad hoc today — `${sessionId}-${requestId}` (middleware/request-context.ts),
-- `${sessionId}-${userId}-consent-share`, `${sessionId}:need-share:${Date.now()}`, … — so only bounds: 1..256
-- characters, no whitespace (Unicode White_Space) or control character. A refused value fails only the telemetry write (brain-service
-- logs it; the call goes on).
CREATE DOMAIN turn_id AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 256 AND VALUE COLLATE pg_c_utf8 !~ '[[:space:][:cntrl:]]');
COMMENT ON DOMAIN turn_id IS 'Correlates the AI calls of one request or chat turn: 1-256 characters, no whitespace or control character. Built ad hoc by each call site (e.g. <sessionId>-<userId>-feel-heard); no format.';

-- work-k5fk.9 (D1): a person's name as a person typed it, or a sign-in provider sent it: "user".first_name and
-- last_name, user_contact.nickname. At most 100 characters and never blank; NULL, not '', is "no name" (the app
-- trims, and clamps a longer Clerk name to 100: utils/person-name.ts). participant.display_name snapshots
-- "user".name — two of these joined — so it carries its own bound of 201 instead.
-- "Not blank" is one set on both sides (review r1 F9, r2 R2-4): Unicode White_Space — pg_c_utf8's [[:space:]] here,
-- \p{White_Space} in utils/person-name.ts (not JavaScript's trim(), which differs on U+0085 and U+FEFF).
CREATE DOMAIN person_name AS text
  CHECK (char_length(VALUE) BETWEEN 1 AND 100 AND VALUE COLLATE pg_c_utf8 !~ '^[[:space:]]*$');
COMMENT ON DOMAIN person_name IS 'A person''s name or a nickname: 1-100 characters, not blank. NULL, never '''', means none (the app trims and clamps: utils/person-name.ts).';

-- work-k5fk.6: a milestone key (milestone.key, participant_milestone.milestone_key):
-- a lower-case identifier such as feel_heard. A domain, not an enum: the keys
-- are a closed set, but that set is the milestone table's rows (seeded below
-- it), and an enum would make every new milestone an ALTER TYPE … ADD VALUE,
-- which cannot be used in the transaction that also inserts its seed row
-- (the baseline is one transaction). The FK to milestone closes the set;
-- the domain fixes the spelling. As with uuid7: array_agg over it yields
-- milestone_key[], which node-postgres returns as the string '{…}' — cast
-- (array_agg(milestone_key::text …)); a row comparison against it needs
-- ::milestone_key on the other side, not ::text.
CREATE DOMAIN milestone_key AS text
  CHECK (char_length(VALUE) <= 64 AND VALUE ~ '^[a-z][a-z0-9_]*$');
COMMENT ON DOMAIN milestone_key IS 'A milestone key: a lower-case identifier of at most 64 characters (e.g. feel_heard). The set of keys is the milestone table (FK); a domain rather than an enum so a new milestone is one seed row, not ALTER TYPE ADD VALUE.';

-- work-k5fk.5: an email address is stored in ONE canonical form and compared
-- exactly (owner decision, review round 2: drop the ICU collation). The
-- canonical form is the whole address trimmed, lowercased, final sigma
-- folded and then NFC-normalized — shared/src/utils/email.ts canonicalEmail()
-- (= foldEmail(s.trim()): toLowerCase, ς → σ, normalize('NFC')), which every
-- writer and lookup uses. NFC comes last because lowercasing an NFC string
-- can un-normalize it: 'J̌' lowercases to j + U+030C, whose NFC is U+01F0. The database never
-- rewrites a value: email_canonical refuses one that is not canonical, so a
-- writer that forgot to canonicalize fails closed instead of creating a
-- second row for the same mailbox. The UNIQUE on "user".email then compares
-- bytes (the default collation is deterministic), and = / LIKE / ~ / ILIKE
-- all work on the column.
--
-- Case is the only equivalence, as Gmail and most providers treat it; the
-- RFCs leave the local part case-sensitive in principle, which no mainstream
-- provider uses. Nothing else folds: a plus-address ('a+1@x.test'), Gmail's
-- dots, an accent, ß (never ss), a fullwidth form ('ａ@x.test' is a
-- different, valid address), another script's digit ('a١@x.test' is not
-- 'a1@x.test') and kana ('あ' is not 'ア') stay distinct. NFC, not NFKC:
-- RFC 6532 §3.1 says NFC SHOULD be used and NFKC SHOULD NOT (it loses
-- information needed to spell names); combining marks stay legal (Indic
-- scripts need them in NFC).
--
-- lower() is pinned to the builtin collation pg_unicode_fast (full Unicode
-- case mapping, the same as JavaScript's toLowerCase: 'İ' → 'i̇', U+0069
-- U+0307). Final sigma: Σ, σ and ς are case forms of one letter, and
-- lower() writes ς at the end of a word ('ΑΣ' → 'ας' but 'ασ' stays), so
-- the fold maps ς to σ and email_no_final_sigma refuses ς: one address,
-- one row. Under the database's default libc
-- collation lower('İ') is 'i' (locale-dependent), which would disagree with
-- canonicalEmail(); email-domain.target.test.ts pins both.
CREATE DOMAIN email AS text
  CONSTRAINT email_length CHECK (char_length(VALUE) <= 254)
  CONSTRAINT email_shape CHECK (VALUE COLLATE "C" ~ '^[^@]+@[^@]+$')
  CONSTRAINT email_canonical CHECK (VALUE = lower(VALUE COLLATE pg_unicode_fast))
  CONSTRAINT email_nfc CHECK (VALUE IS NFC NORMALIZED)
  CONSTRAINT email_no_final_sigma CHECK (strpos(VALUE, U&'\03C2') = 0)
  CONSTRAINT email_assigned CHECK (unicode_assigned(VALUE))
  CONSTRAINT email_no_space_control CHECK (VALUE COLLATE pg_c_utf8 !~ '[[:space:][:cntrl:]]')
  CONSTRAINT email_no_format CHECK (VALUE COLLATE "C" !~
    '[\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF]');
COMMENT ON DOMAIN email IS 'An email address in its one canonical form (trimmed, lowercased, ς folded to σ, NFC: shared canonicalEmail()), compared exactly. Case is the only equivalence and it is removed before storage; a plus-address, an accent, ß, a fullwidth form, another script''s digit stay distinct. The database refuses a non-canonical value rather than rewriting it.';
COMMENT ON CONSTRAINT email_length ON DOMAIN email IS 'At most 254 characters (the RFC 5321 path limit).';
COMMENT ON CONSTRAINT email_shape ON DOMAIN email IS 'Exactly one @, with a non-empty local part and a non-empty domain. The tombstone deleted+<id>@invalid has this shape.';
COMMENT ON CONSTRAINT email_canonical ON DOMAIN email IS 'Canonical case: lowercase by full Unicode case mapping (lower() under pg_unicode_fast, equal to JavaScript toLowerCase). Writers canonicalize with canonicalEmail(); a value that is not canonical is refused, never rewritten.';
COMMENT ON CONSTRAINT email_nfc ON DOMAIN email IS 'NFC-normalized (RFC 6532 §3.1: NFC SHOULD be used, NFKC SHOULD NOT). Combining marks stay legal; a fullwidth form or a ligature is a different, valid address. Part of the canonical form canonicalEmail() produces (NFC after lowercasing).';
COMMENT ON CONSTRAINT email_no_final_sigma ON DOMAIN email IS 'No U+03C2 GREEK SMALL LETTER FINAL SIGMA: Σ, σ and ς are case forms of one letter, and lower() writes ς only at a word end, so canonicalEmail() folds ς to σ and this CHECK refuses an unfolded value (one address, one row).';
COMMENT ON CONSTRAINT email_assigned ON DOMAIN email IS 'Every code point assigned in PostgreSQL''s Unicode version.';
COMMENT ON CONSTRAINT email_no_space_control ON DOMAIN email IS 'No whitespace (Unicode White_Space) and no control character (Cc), by pg_c_utf8''s Unicode character classes.';
COMMENT ON CONSTRAINT email_no_format ON DOMAIN email IS 'No format character (Cf: soft hyphen, zero-width space/joiners, bidi controls, …) and no other default-ignorable code point (variation selectors, Hangul fillers, tags): invisible characters that would make two addresses look identical. Code-point ranges under "C": exactly Cf ∪ Default_Ignorable_Code_Point of PostgreSQL 18''s Unicode 16 (email-domain.target.test.ts compares it with JavaScript''s \p{Cf} and \p{Default_Ignorable_Code_Point}); re-derive on a PostgreSQL major upgrade (infra/aws/README.md).';

-- ----------------------------------------------------------------------------
-- jsonb documents (work-k5fk.8). The shapes, their writers and why each column
-- is validated the way it is: docs/backend/data-model/jsonb-shapes-2026-11.md.
-- Typed domains (owner, 2026-11-23): every jsonb column is typed by a domain
-- named for its app contract, so the schema says what the document is, and each
-- rule lives in one place (step 20 refuses a plain jsonb column).
--  * The seven jsonb-envelope columns (SENSITIVE_FIELD_MAP): one domain per
--    contract, each with the envelope rule as its CHECK, constraint
--    jsonb_envelope (app.jsonb_envelope_violation, above): a sealed document is
--    exactly {"$enc": <a v1 ciphertext>}. A domain CHECK, not a table CHECK: a
--    table CHECK refusal's DETAIL ("Failing row contains …") would echo the row
--    — the very plaintext the rule exists to catch — to the client and the log;
--    a domain CHECK refusal names the domain and the constraint only. Their
--    plaintext is opaque to the database; the app validates it (zod) before
--    sealing. Each domain is over jsonb, not over a shared jsonb_envelope
--    domain: Prisma reads a domain over a domain as Unsupported("<base>"), not
--    Json (prisma db pull, 7.x), so the shared part is the function.
--  * The two plaintext app documents — user_preferences.doc and the structure
--    of ai_memory.doc (its string leaves are encrypted; its keys, numbers and
--    arrays are not) — are validated by a BEFORE trigger (trailer.sql T5)
--    against app.json_schema, by the row's doc_schema_version. Their domains
--    (preferences_json_schema, ai_memory_json_schema) hold the static part only: a domain CHECK
--    cannot see doc_schema_version or kind, and must not read a table (pg_dump
--    restores data after the domain, in no promised order).
--  * brain_activity.metadata is an activity_metadata_json_schema: telemetry, written by the
--    AI only, read by the ops dashboard, so its keys and value types are the
--    privacy whitelist of types/turn-trace.ts (app.activity_metadata_violation).
--    brain_activity.input and output are jsonb envelopes (owner decision OD-1
--    and its follow-up, work-k5fk.9).
-- ----------------------------------------------------------------------------

-- The envelope domains, one per app contract. Prisma reads each as Json.
CREATE DOMAIN feature_state_json_schema AS jsonb
  CONSTRAINT jsonb_envelope CHECK (app.jsonb_envelope_violation(VALUE) IS NULL);
COMMENT ON DOMAIN feature_state_json_schema IS 'feature_state.doc: a jsonb envelope sealing one wellbeing feature''s document — the zod schema FEATURE_DOC_SCHEMAS[feature] (meditationDocSchema, gratitudeDocSchema, needsAssessmentDocSchema, peopleDocSchema) in shared/src/dto/feature-state.ts, written by services/feature-state.ts. The plain document passes for keyless dev/test.';
COMMENT ON CONSTRAINT jsonb_envelope ON DOMAIN feature_state_json_schema IS 'A well-formed envelope {"$enc": <a v1 ciphertext>} or keyless plaintext (an object without "$enc"): app.jsonb_envelope_violation.';
CREATE DOMAIN checkin_payload_json_schema AS jsonb
  CONSTRAINT jsonb_envelope CHECK (app.jsonb_envelope_violation(VALUE) IS NULL);
COMMENT ON DOMAIN checkin_payload_json_schema IS 'follow_up_checkin.payload: a jsonb envelope sealing a FollowUpCheckinPayload — the zod schema followUpCheckinPayloadSchema in shared/src/contracts/stages.ts, checked by services/tending.service.ts validateCheckinPayload before sealing. The plain document passes for keyless dev/test.';
COMMENT ON CONSTRAINT jsonb_envelope ON DOMAIN checkin_payload_json_schema IS 'A well-formed envelope {"$enc": <a v1 ciphertext>} or keyless plaintext (an object without "$enc"): app.jsonb_envelope_violation.';
CREATE DOMAIN proposal_snapshot_json_schema AS jsonb
  CONSTRAINT jsonb_envelope CHECK (app.jsonb_envelope_violation(VALUE) IS NULL);
COMMENT ON DOMAIN proposal_snapshot_json_schema IS 'proposal_revision.before and .after: a jsonb envelope sealing a snapshot of a proposal''s fields — services/stage4-capture.service.ts proposalSnapshot() (plus the capture lineage), controllers/stage4.ts, services/stage4-subchat.service.ts and stage4-store.ts; an untyped Record<string, unknown>, no zod schema. The plain document passes for keyless dev/test.';
COMMENT ON CONSTRAINT jsonb_envelope ON DOMAIN proposal_snapshot_json_schema IS 'A well-formed envelope {"$enc": <a v1 ciphertext>} or keyless plaintext (an object without "$enc"): app.jsonb_envelope_violation.';
CREATE DOMAIN reflection_summary_json_schema AS jsonb
  CONSTRAINT jsonb_envelope CHECK (app.jsonb_envelope_violation(VALUE) IS NULL);
COMMENT ON DOMAIN reflection_summary_json_schema IS 'reflection.summary_doc: a jsonb envelope sealing an inner-thoughts rolling summary — services/conversation-summarizer.ts updateInnerThoughtsSummary (ConversationSummary plus keyThemes, emotionalJourney, unresolvedTopics; no zod schema). The plain document passes for keyless dev/test.';
COMMENT ON CONSTRAINT jsonb_envelope ON DOMAIN reflection_summary_json_schema IS 'A well-formed envelope {"$enc": <a v1 ciphertext>} or keyless plaintext (an object without "$enc"): app.jsonb_envelope_violation.';
CREATE DOMAIN llm_call_input_json_schema AS jsonb
  CONSTRAINT jsonb_envelope CHECK (app.jsonb_envelope_violation(VALUE) IS NULL);
COMMENT ON DOMAIN llm_call_input_json_schema IS 'brain_activity.input: a jsonb envelope sealing what an AI call was given — services/brain-service.ts ActivityInput.input (unknown; lib/bedrock.ts { operation, messageCount, systemPromptLength } / { textLength }, context-retriever.ts a retrieval''s queries). The plain document passes for keyless dev/test.';
COMMENT ON CONSTRAINT jsonb_envelope ON DOMAIN llm_call_input_json_schema IS 'A well-formed envelope {"$enc": <a v1 ciphertext>} or keyless plaintext (an object without "$enc"): app.jsonb_envelope_violation.';
CREATE DOMAIN llm_call_output_json_schema AS jsonb
  CONSTRAINT jsonb_envelope CHECK (app.jsonb_envelope_violation(VALUE) IS NULL);
COMMENT ON DOMAIN llm_call_output_json_schema IS 'brain_activity.output: a jsonb envelope sealing an AI call''s outcome — services/brain-service.ts completeActivity result.output (unknown; lib/bedrock.ts { text, stopReason } / { success }, context-retriever.ts a retrieval''s matches). The plain document passes for keyless dev/test.';
COMMENT ON CONSTRAINT jsonb_envelope ON DOMAIN llm_call_output_json_schema IS 'A well-formed envelope {"$enc": <a v1 ciphertext>} or keyless plaintext (an object without "$enc"): app.jsonb_envelope_violation.';

-- The two plaintext app documents: the static part of their shape (the versioned schema is t_doc_schema's).
CREATE DOMAIN preferences_json_schema AS jsonb
  CHECK (jsonb_typeof(VALUE) = 'object' AND VALUE ?& ARRAY['memory', 'notifications', 'privacy']);
COMMENT ON DOMAIN preferences_json_schema IS 'user_preferences.doc: the user''s plaintext settings, services/user-settings.ts PreferencesDoc — an object with memory, notifications and privacy. The full, versioned shape is the t_doc_schema trigger''s (app.json_schema user_preferences, by doc_schema_version).';
CREATE DOMAIN ai_memory_json_schema AS jsonb CHECK (jsonb_typeof(VALUE) = 'object');
COMMENT ON DOMAIN ai_memory_json_schema IS 'ai_memory.doc: an object whose string leaves are encrypted (jsonb-leaves) — conversation-summarizer.ts (SUMMARY), partner-session-classifier.ts (NOTABLE_FACTS), global-memory.ts (GLOBAL_FACTS). The kind-dependent keys are table CHECKs; the versioned shape is the t_doc_schema trigger''s (app.json_schema ai_memory.<kind>).';

-- brain_activity.metadata, the DB-side mirror of the ops-telemetry privacy whitelist (review r2 R2-2): the keys
-- types/turn-trace.ts lets through, with their value types — sanitizeActivityMetadata (maxTokens, toolCount,
-- queryCount, cacheReadInputTokens, cacheWriteInputTokens: numbers; toolInvocations: [{ name }]; contextSizes: four
-- numbers), sanitizeTurnTrace (turnTrace, merged by brain-service mergeTurnTrace) and errorClass (error, failActivity).
-- Closed-set strings (a tool name, a model alias, an error class, a step's type and status) are pinned to their
-- form, so no sentence fits; step names and results are template strings, checked by the app only. An object: the
-- old CHECK's 'array' arm (spec §1.8, from the legacy column) had no writer. A function, not inline CHECKs: arrays of
-- objects need iteration, which a CHECK expression cannot do. Keep it in step with turn-trace.ts (its comment points
-- here). Reports the first violation, by key (structure), never a value.
CREATE FUNCTION app.activity_metadata_violation(doc jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE
    ident CONSTANT text := '^[A-Za-z][A-Za-z0-9_]*$';
    k text;
    v jsonb;
    e jsonb;
    i bigint;
  BEGIN
    IF doc IS NULL THEN RETURN NULL; END IF;
    IF jsonb_typeof(doc) <> 'object' THEN RETURN 'not an object, got ' || jsonb_typeof(doc); END IF;
    FOR k, v IN SELECT d.key, d.value FROM jsonb_each(doc) d ORDER BY d.key LOOP
      CASE
        WHEN k IN ('maxTokens', 'toolCount', 'queryCount', 'cacheReadInputTokens', 'cacheWriteInputTokens') THEN
          IF jsonb_typeof(v) <> 'number' THEN RETURN format('%s: expected number, got %s', k, jsonb_typeof(v)); END IF;
        WHEN k = 'toolInvocations' THEN
          IF jsonb_typeof(v) <> 'array' THEN RETURN format('%s: expected array, got %s', k, jsonb_typeof(v)); END IF;
          FOR e, i IN SELECT a.value, a.ordinality - 1 FROM jsonb_array_elements(v) WITH ORDINALITY a(value, ordinality) LOOP
            IF jsonb_typeof(e) <> 'object' OR e - 'name' <> '{}'::jsonb OR jsonb_typeof(e -> 'name') IS DISTINCT FROM 'string'
               OR NOT e ->> 'name' ~ ident THEN
              RETURN format('%s[%s]: expected {name: <identifier>}', k, i);
            END IF;
          END LOOP;
        WHEN k = 'contextSizes' THEN
          IF jsonb_typeof(v) <> 'object' THEN RETURN format('%s: expected object, got %s', k, jsonb_typeof(v)); END IF;
          IF v - ARRAY['pinnedTokens', 'summaryTokens', 'recentTokens', 'ragTokens'] <> '{}'::jsonb
             OR EXISTS (SELECT 1 FROM jsonb_each(v) c WHERE jsonb_typeof(c.value) <> 'number') THEN
            RETURN format('%s: expected {pinnedTokens, summaryTokens, recentTokens, ragTokens: number}', k);
          END IF;
        WHEN k = 'turnTrace' THEN
          IF jsonb_typeof(v) <> 'object' THEN RETURN format('%s: expected object, got %s', k, jsonb_typeof(v)); END IF;
          IF v - ARRAY['totalDurationMs', 'modelUsed', 'usedMock', 'steps'] <> '{}'::jsonb
             OR coalesce(jsonb_typeof(v -> 'totalDurationMs'), 'number') <> 'number'
             OR coalesce(jsonb_typeof(v -> 'usedMock'), 'boolean') <> 'boolean'
             OR coalesce(jsonb_typeof(v -> 'modelUsed'), 'string') <> 'string'
             OR NOT coalesce(v ->> 'modelUsed', 'unknown') ~ ident
             OR coalesce(jsonb_typeof(v -> 'steps'), 'array') <> 'array' THEN
            RETURN format('%s: expected {totalDurationMs: number, modelUsed: <identifier>, usedMock: boolean, steps: array}', k);
          END IF;
          FOR e, i IN SELECT a.value, a.ordinality - 1
                      FROM jsonb_array_elements(coalesce(v -> 'steps', '[]'::jsonb)) WITH ORDINALITY a(value, ordinality) LOOP
            IF jsonb_typeof(e) <> 'object'
               OR e - ARRAY['name', 'type', 'startMs', 'durationMs', 'result', 'status'] <> '{}'::jsonb
               OR coalesce(jsonb_typeof(e -> 'name'), 'string') <> 'string'
               OR coalesce(jsonb_typeof(e -> 'result'), 'string') <> 'string'
               OR coalesce(jsonb_typeof(e -> 'startMs'), 'number') <> 'number'
               OR coalesce(jsonb_typeof(e -> 'durationMs'), 'number') <> 'number'
               OR coalesce(e -> 'type', '"decision"') NOT IN ('"decision"', '"llm_call"', '"retrieval"', '"parsing"', '"dispatch"')
               OR coalesce(e -> 'status', '"success"') NOT IN ('"success"', '"error"', '"skipped"') THEN
              RETURN format('%s.steps[%s]: expected a TraceStep {name, type, startMs, durationMs, result, status}', k, i);
            END IF;
          END LOOP;
        WHEN k = 'error' THEN
          IF jsonb_typeof(v) <> 'string' OR NOT v #>> '{}' ~ ident THEN
            RETURN format('%s: expected an error class (an identifier)', k);
          END IF;
        ELSE
          RETURN format('unexpected key %s', k);
      END CASE;
    END LOOP;
    RETURN NULL;
  END
  $$;
COMMENT ON FUNCTION app.activity_metadata_violation(jsonb) IS 'Why a brain_activity.metadata document is refused, or NULL: an object whose keys are the whitelist of types/turn-trace.ts (ActivityMetadata, turnTrace, error), each with its value type. Names the key, never the value. The CHECK of the activity_metadata_json_schema domain.';
-- A domain CHECK runs with the writer's rights (step 20, T8): ai_access (mwf_ai's: brain-service startActivity INSERT,
-- complete/failActivity and mergeTurnTrace UPDATE), worker_access (mwf_worker's: the retention purge sets it NULL).
REVOKE EXECUTE ON FUNCTION app.activity_metadata_violation(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.activity_metadata_violation(jsonb) TO ai_access;
GRANT EXECUTE ON FUNCTION app.activity_metadata_violation(jsonb) TO worker_access;
CREATE DOMAIN activity_metadata_json_schema AS jsonb
  CONSTRAINT activity_metadata_whitelist CHECK (app.activity_metadata_violation(VALUE) IS NULL);
COMMENT ON DOMAIN activity_metadata_json_schema IS 'brain_activity.metadata: ops-readable telemetry, so exactly the privacy whitelist of backend/src/types/turn-trace.ts — ActivityMetadata (sanitizeActivityMetadata), turnTrace (sanitizeTurnTrace) and error (errorClass) — as an object, each value of its type (app.activity_metadata_violation).';
COMMENT ON CONSTRAINT activity_metadata_whitelist ON DOMAIN activity_metadata_json_schema IS 'Only whitelisted keys, each with its type; closed-set strings are identifiers or their enum (app.activity_metadata_violation).';

-- A JSON-schema version: 1, 2, … per schema name.
CREATE DOMAIN schema_version AS smallint CHECK (VALUE >= 1);
COMMENT ON DOMAIN schema_version IS 'The version of a JSON schema (app.json_schema.version) and of a document that conforms to it (doc_schema_version): 1, 2, …; a new shape is a new row, never an edit of a seeded one.';

-- Is this a schema the validator implements? The subset (owner decision Q11,
-- 2026-11-12: PL/pgSQL, not plv8; pg_jsonschema is not on the RDS list):
-- type (a name or a list of: object, array, string, number, integer, boolean,
-- null), required (a list of key names), properties (key → schema),
-- additionalProperties (false, true or a schema), enum (a non-empty list of
-- values), items (one schema for every element); description and $comment
-- are annotations. Anything else — minimum, pattern, $ref, oneOf, tuple
-- items — is refused here, so a seeded schema can never carry a keyword the
-- validator would silently ignore.
CREATE FUNCTION app.json_schema_wellformed(schema jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE
    types CONSTANT text[] := ARRAY['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
    k text;
    v jsonb;
  BEGIN
    IF jsonb_typeof(schema) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    FOR k, v IN SELECT * FROM jsonb_each(schema) LOOP
      CASE k
        WHEN 'type' THEN
          IF NOT (CASE jsonb_typeof(v)
                    WHEN 'string' THEN v #>> '{}' = ANY (types)
                    WHEN 'array' THEN jsonb_array_length(v) > 0
                      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) t
                                      WHERE jsonb_typeof(t) <> 'string' OR NOT t #>> '{}' = ANY (types))
                    ELSE false END) THEN
            RETURN false;
          END IF;
        WHEN 'required' THEN
          IF jsonb_typeof(v) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(v) r WHERE jsonb_typeof(r) <> 'string') THEN
            RETURN false;
          END IF;
        WHEN 'properties' THEN
          IF jsonb_typeof(v) <> 'object'
             OR EXISTS (SELECT 1 FROM jsonb_each(v) p WHERE NOT app.json_schema_wellformed(p.value)) THEN
            RETURN false;
          END IF;
        WHEN 'additionalProperties' THEN
          IF jsonb_typeof(v) <> 'boolean' AND NOT app.json_schema_wellformed(v) THEN RETURN false; END IF;
        WHEN 'enum' THEN
          IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) = 0 THEN RETURN false; END IF;
        WHEN 'items' THEN
          IF NOT app.json_schema_wellformed(v) THEN RETURN false; END IF;
        WHEN 'description', '$comment' THEN
          IF jsonb_typeof(v) <> 'string' THEN RETURN false; END IF;
        ELSE
          RETURN false;
      END CASE;
    END LOOP;
    RETURN true;
  END
  $$;
COMMENT ON FUNCTION app.json_schema_wellformed(jsonb) IS 'True when a JSON schema uses only the subset app.jsonb_schema_violation implements (type, required, properties, additionalProperties, enum, items; description and $comment as annotations), with well-formed values, at every depth. The CHECK on app.json_schema.schema.';

-- The schemas the validation triggers check documents against. Reference
-- data, like milestone: seeded right here by the baseline, read-only to every
-- runtime role; a new shape is a new (name, version) row added by a
-- migration, and a writer moves to it by writing doc_schema_version.
-- In schema app, not public: the app never reads it (it validates with zod in
-- shared/), so it has no Prisma model and is not one of the 49 tables; it
-- sits with the functions that read it.
CREATE TABLE app.json_schema (
    name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$'),
    version schema_version NOT NULL,
    schema jsonb NOT NULL CHECK (app.json_schema_wellformed(schema)),
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (name, version)
);
COMMENT ON TABLE app.json_schema IS 'Reference data: the JSON schemas (a subset, app.json_schema_wellformed) the BEFORE triggers on user_preferences.doc and ai_memory.doc validate documents against, by name and doc_schema_version. Seeded by the baseline migration; read-only to every runtime role.';
COMMENT ON COLUMN app.json_schema.name IS 'The document the schema describes: a table (user_preferences) or table.kind (ai_memory.summary, ai_memory.notable_facts, ai_memory.global_facts).';
COMMENT ON COLUMN app.json_schema.version IS 'The schema version a row''s doc_schema_version names. Rows are never edited: a new shape is a new version.';
COMMENT ON COLUMN app.json_schema.schema IS 'The JSON schema, in the subset the validator implements; refused at INSERT if it uses anything else.';
COMMENT ON COLUMN app.json_schema.created_at IS 'When the schema was seeded (by the migration that added it).';
COMMENT ON CONSTRAINT json_schema_name_check ON app.json_schema IS 'A lower-case identifier, optionally .kind: a table, or table.kind for a table whose kind picks the schema.';
COMMENT ON CONSTRAINT json_schema_schema_check ON app.json_schema IS 'Only the subset app.jsonb_schema_violation implements (app.json_schema_wellformed), so no keyword is ever silently ignored.';
-- mwf_app, mwf_ai: the validation triggers run with the writer's rights (trailer.sql T5: invoker rights
-- throughout), so the roles whose writes fire them read the schemas. Read only: no runtime role writes a
-- schema. A schema is not secret — it restates the contract shared/src/dto already publishes — so SELECT
-- is harmless, and a SECURITY DEFINER lookup would add an owner hop for nothing. mwf_ops, mwf_auth: none
-- (no reader, and no write of theirs fires a trigger). Whoever is granted a write that fires t_doc_schema needs
-- this and the validator's EXECUTE (and a writer of a column whose domain CHECK calls an app.* function needs that
-- function's): trailer T8 refuses the baseline when a role may write a validated column without them
-- (work-k5fk.10.4.1). mwf_ai: the summarizer's / classifier's ai_memory.doc (t_doc_schema). mwf_worker writes only
-- enveloped columns (proposal_revision; an envelope domain needs no schema).
GRANT SELECT ON app.json_schema TO app_access;
GRANT SELECT ON app.json_schema TO ai_access;

-- The seed: version 1 of each validated document, derived from what the app
-- writes today (docs/backend/data-model/jsonb-shapes-2026-11.md §2).
-- user_preferences v1: services/user-settings.ts PreferencesDoc — the three
-- shared/src/dto/auth.ts DTOs. Every member is optional (an older document
-- missing one reads its default: withDefaults); no other key is allowed, at
-- either level (the controllers pass the zod-parsed DTO keys only).
INSERT INTO app.json_schema (name, version, schema) VALUES ('user_preferences', 1, $json$
{
  "$comment": "services/user-settings.ts PreferencesDoc; shared/src/dto/auth.ts Memory/Notification/PrivacyPreferencesDTO",
  "type": "object",
  "required": ["memory", "notifications", "privacy"],
  "additionalProperties": false,
  "properties": {
    "memory": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessionContinuity": {"type": "boolean"},
        "crossSessionRecall": {"type": "boolean"},
        "patternInsights": {"type": "boolean"},
        "rememberAgreements": {"type": "boolean"}
      }
    },
    "notifications": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "pushEnabled": {"type": "boolean"},
        "emailEnabled": {"type": "boolean"},
        "newInvitations": {"type": "boolean"},
        "partnerActions": {"type": "boolean"},
        "followUpReminders": {"type": "boolean"}
      }
    },
    "privacy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "showActivityStatus": {"type": "boolean"},
        "allowSessionInvites": {"type": "boolean"},
        "analyticsOptOut": {"type": "boolean"}
      }
    }
  }
}
$json$);
-- ai_memory.*: the STRUCTURE of a leaf-encrypted document. With a key every
-- string leaf is a ciphertext, so a string stays a string but its value is
-- opaque: never an enum or a format on a string leaf. Keys, numbers,
-- booleans, nulls and array shapes are plaintext and are checked.
-- ai_memory.summary v1: conversation-summarizer.ts updateSessionSummary —
-- ConversationSummary (timestamps as ISO strings) plus the model's
-- SummarizationResult fields. The model's output is stored without
-- normalisation, so its fields admit null (getSessionSummary defaults them:
-- `|| []`, `|| ''`); the keys are closed (the writer names each one).
INSERT INTO app.json_schema (name, version, schema) VALUES ('ai_memory.summary', 1, $json$
{
  "$comment": "conversation-summarizer.ts updateSessionSummary / getSessionSummary",
  "type": "object",
  "required": ["text", "messageCount", "generatedAt"],
  "additionalProperties": false,
  "properties": {
    "text": {"type": "string"},
    "messageCount": {"type": "integer"},
    "oldestMessageAt": {"type": "string"},
    "newestMessageAt": {"type": "string"},
    "tokenCount": {"type": "integer"},
    "generatedAt": {"type": "string"},
    "keyThemes": {"type": ["array", "null"], "items": {"type": "string"}},
    "emotionalJourney": {"type": ["string", "null"]},
    "unresolvedTopics": {"type": ["array", "null"], "items": {"type": "string"}},
    "agreedFacts": {"type": ["array", "null"], "items": {"type": "string"}},
    "userNeeds": {"type": ["array", "null"], "items": {"type": "string"}},
    "partnerNeeds": {"type": ["array", "null"], "items": {"type": "string"}},
    "openQuestions": {"type": ["array", "null"], "items": {"type": "string"}},
    "agreements": {"type": ["array", "null"], "items": {"type": "string"}},
    "lastUnresolvedThread": {"type": ["string", "null"]}
  }
}
$json$);
-- ai_memory.notable_facts v1: partner-session-classifier.ts — { facts:
-- CategorizedFactWithId[] }. A fact needs category and fact; id is a uuidv7
-- string (ensureFactIds). A fact object stays open (the legacy path spreads
-- the model's fact object); the document does not.
INSERT INTO app.json_schema (name, version, schema) VALUES ('ai_memory.notable_facts', 1, $json$
{
  "$comment": "partner-session-classifier.ts (INSERT ... ON CONFLICT DO UPDATE as mwf_ai)",
  "type": "object",
  "required": ["facts"],
  "additionalProperties": false,
  "properties": {
    "facts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["category", "fact"],
        "properties": {
          "id": {"type": "string"},
          "category": {"type": "string"},
          "fact": {"type": "string"}
        }
      }
    }
  }
}
$json$);
-- ai_memory.global_facts v1: global-memory.ts consolidateGlobalFacts —
-- GlobalFacts { facts: CategorizedFact[], consolidatedAt, sessionCount }.
-- A fact object stays open (normalizeConsolidationResult filters the model's
-- objects; it does not rebuild them).
INSERT INTO app.json_schema (name, version, schema) VALUES ('ai_memory.global_facts', 1, $json$
{
  "$comment": "global-memory.ts consolidateGlobalFacts (a Prisma upsert as mwf_app)",
  "type": "object",
  "required": ["facts"],
  "additionalProperties": false,
  "properties": {
    "facts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["category", "fact"],
        "properties": {
          "category": {"type": "string"},
          "fact": {"type": "string"}
        }
      }
    },
    "consolidatedAt": {"type": "string"},
    "sessionCount": {"type": "integer"}
  }
}
$json$);

-- ----------------------------------------------------------------------------
-- Enums, in schema.prisma order.
-- ----------------------------------------------------------------------------
CREATE TYPE session_status AS ENUM ('CREATED', 'INVITED', 'ACTIVE', 'RESOLVED', 'ABANDONED', 'ARCHIVED');
COMMENT ON TYPE session_status IS 'Lifecycle of a session. Written only by app.session_set_status() and app.session_archive(): CREATED -> INVITED -> ACTIVE -> RESOLVED, any live state -> ABANDONED; -> ARCHIVED from CREATED, INVITED, RESOLVED or ABANDONED by a current participant (app.session_archive), from RESOLVED or ABANDONED by the job (app.session_set_status, retention).';
CREATE TYPE user_kind AS ENUM ('human', 'ai', 'persona');
COMMENT ON TYPE user_kind IS 'What a user row is (work-k5fk.1/.3): human, a person who signs in (an email, a user_identity); ai, the one AI principal (seeded, app.ai_user_id()); persona, a modeled person a human created (persona row: its owner). Only a human has an email or an identity.';
CREATE TYPE identity_provider AS ENUM ('clerk', 'e2e');
COMMENT ON TYPE identity_provider IS 'Who vouches for a user_identity: clerk, the production sign-in (a verified JWT sub); e2e, the E2E auth bypass (E2E_AUTH_BYPASS with NODE_ENV test, development or e2e only, lib/e2e-bypass.ts; never production).';
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
CREATE TYPE message_dedupe_key AS ENUM ('STAGE2_VALIDATED_WAIT', 'STAGE4_HANDOFF_BRIDGE', 'STAGE4_TRANSITION');
COMMENT ON TYPE message_dedupe_key IS 'The app-generated facilitator lines written at most once per conversation (work-fdc1): STAGE2_VALIDATED_WAIT, the hold-here note after a participant validates the partner''s empathy (controllers/stage2.ts); STAGE4_HANDOFF_BRIDGE, the hand-off line after the first Stage 4 share (controllers/stage4.ts); STAGE4_TRANSITION, each participant''s Stage 4 transition line, written from their own request (services/stage4-transition.ts). A closed set: no value is derived from message content.';
CREATE TYPE draft_kind AS ENUM ('EMPATHY', 'VALIDATION_FEEDBACK', 'SHARE_CONTEXT');
COMMENT ON TYPE draft_kind IS 'The sharing point a draft is for; it decides which of draft''s arc columns is set.';
CREATE TYPE milestone_scope AS ENUM ('participant', 'session');
COMMENT ON TYPE milestone_scope IS 'participant: each participant reaches the milestone on their own; session: every present participant must reach it for the session to move on.';
CREATE TYPE ai_memory_kind AS ENUM ('SUMMARY', 'NOTABLE_FACTS', 'GLOBAL_FACTS');
COMMENT ON TYPE ai_memory_kind IS 'SUMMARY and NOTABLE_FACTS belong to a participant (one session); GLOBAL_FACTS belong to a user (across sessions).';
CREATE TYPE regulation_type AS ENUM ('BREATHING_EXERCISE', 'BODY_SCAN', 'GROUNDING', 'PAUSE_SESSION');
COMMENT ON TYPE regulation_type IS 'The emotional-regulation exercise a participant completed.';
CREATE TYPE invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');
COMMENT ON TYPE invitation_status IS 'Lifecycle of an invitation: PENDING until accepted, declined, past expires_at, or withdrawn by archiving its session before anyone joined (EXPIRED either way; app.session_archive).';
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
-- work-k5fk.9 (Q4): the area the author is pointed at; the app maps each label to its phrase (reconciler/guidance-phrases.ts)
CREATE TYPE guidance_area AS ENUM ('work_effort', 'connection_closeness', 'safety_security', 'heard_understood', 'respect_value', 'deeper_emotions');
COMMENT ON TYPE guidance_area IS 'The coarse area the reconciler points the author at, from the feelings their attempt missed (generateAbstractGuidance); a code constant, never user content, so not encrypted (work-k5fk.9, Q4). The phrase shown is the app''s (GUIDANCE_AREA_PHRASES).';
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
COMMENT ON TYPE follow_up_scope IS 'SHARED: both participants check in; INDIVIDUAL: only owner_user_id does.';
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
-- work-k5fk.9 (V1): who delivers to a push token; a new provider is a new label, not a token-format guess
CREATE TYPE push_provider AS ENUM ('expo');
COMMENT ON TYPE push_provider IS 'The push service a device''s token belongs to: expo (Expo push, today the only one). The token''s format is the provider''s; the app checks it (push.ts, Expo.isExpoPushToken), the database only bounds it (work-k5fk.9, V1).';
CREATE TYPE wellbeing_feature AS ENUM ('meditation', 'gratitude', 'needs_assessment', 'people');
COMMENT ON TYPE wellbeing_feature IS 'The wellbeing features that keep a feature_state document (shared/src/dto/feature-state.ts FEATURES).';
CREATE TYPE activity_type AS ENUM ('LLM_CALL', 'EMBEDDING', 'RETRIEVAL', 'TOOL_USE');
COMMENT ON TYPE activity_type IS 'The kind of call a brain_activity row logs.';
CREATE TYPE activity_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
COMMENT ON TYPE activity_status IS 'Whether a logged call is still running, completed or failed.';
CREATE TYPE brain_call_type AS ENUM ('ORCHESTRATED_RESPONSE', 'RETRIEVAL_PLANNING', 'INTENT_DETECTION', 'BACKGROUND_CLASSIFICATION', 'PARTNER_SESSION_CLASSIFICATION', 'CHAT_ROUTER_RESPONSE', 'REFERENCE_DETECTION', 'PEOPLE_EXTRACTION', 'MEMORY_DETECTION', 'MEMORY_VALIDATION', 'RECONCILER_ANALYSIS', 'SUMMARIZATION', 'NEEDS_EXTRACTION', 'WITNESSING_RESPONSE', 'MEMORY_FORMATTING', 'THEME_EXTRACTION', 'GLOBAL_MEMORY_CONSOLIDATION', 'DISTILLATION', 'CROSS_SESSION_THEME');
COMMENT ON TYPE brain_call_type IS 'Which part of the app made a logged LLM call (the call site), for cost and latency breakdowns.';

-- ----------------------------------------------------------------------------
-- Schema public: USAGE for the roles that read or write its tables directly
-- (mwf_app relies on PUBLIC's USAGE, PostgreSQL 15+'s default). Schema app's
-- grants are in preamble.sql, next to CREATE SCHEMA app.
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO ai_access, worker_access, mwf_definer;
GRANT USAGE ON SCHEMA public TO ops_access;

-- ----------------------------------------------------------------------------
-- The 49 tables, in dependency order.
-- ----------------------------------------------------------------------------

CREATE TABLE "user" (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    kind user_kind NOT NULL DEFAULT 'human',
    email email UNIQUE,
    first_name person_name,
    last_name person_name,
    deleted_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    name text
        GENERATED ALWAYS AS (nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')) STORED,

    -- Pattern K (design note §1): the target of every kind-carrying FK. A
    -- child copies the kind into a one-value CHECK column and references
    -- (id, kind), so "this points at a human" (user_identity, persona's
    -- owner) or "at a persona" (persona) is a key, not a trigger.
    UNIQUE (id, kind),
    -- Only a human has an email (the AI and personas never sign in).
    CHECK ((kind = 'human') = (email IS NOT NULL)),
    -- §1.7 user — a human tombstone is scrubbed (P3 D9) to deleted+<id>@invalid
    -- (.invalid is reserved, RFC 2606: never a real address; the uuid text
    -- is lowercase, so the value is canonical). app.anonymize_user_account
    -- writes exactly 'deleted+' || id || '@invalid' and deletes the user's
    -- user_identity rows. An equivalence for a human (review L1): a live
    -- account can never hold a deleted+…@invalid address either (one did, and
    -- blocked the victim's own tombstone through the UNIQUE). A scrubbed
    -- persona has no email to scrub.
    CONSTRAINT user_tombstone CHECK (kind <> 'human' OR (deleted_at IS NOT NULL) = (email COLLATE "C" LIKE 'deleted+%@invalid')),
    -- The AI principal is a constant: never deleted, never named.
    CONSTRAINT user_ai_constant CHECK (kind <> 'ai' OR (deleted_at IS NULL AND first_name IS NULL AND last_name IS NULL))
);
COMMENT ON TABLE "user" IS 'Identity only: one row per principal — a human account (signs in through user_identity), the one AI row, or a persona (persona table) — soft-deleted to a scrubbed tombstone. Every FK to it is RESTRICT; session data hangs off participant, not off user.';
COMMENT ON COLUMN "user".kind IS 'human, ai or persona (user_kind). A child that must point at one kind references (id, kind) (pattern K).';
COMMENT ON COLUMN "user".email IS 'Sign-in email in canonical form (domain email: trimmed, NFC, lowercase), unique: a case variant is the same canonical value, a plus-address a different one. Set exactly for a human, NULL for ai and persona. A tombstone holds the scrubbed address deleted+<id>@invalid.';
COMMENT ON COLUMN "user".name IS 'Generated display name: first_name and last_name joined, NULL when both are empty.';
COMMENT ON CONSTRAINT user_tombstone ON "user" IS 'A human is deleted exactly when its email is the scrubbed deleted+<id>@invalid: a live account cannot hold such an address, a tombstone cannot keep a real one.';
COMMENT ON CONSTRAINT user_ai_constant ON "user" IS 'The AI principal is never deleted and has no name: its row is a constant the baseline seeds (app.ai_user_id()).';
COMMENT ON COLUMN "user".deleted_at IS 'Soft delete (P3 D9): the row becomes a scrubbed tombstone and is never removed.';
-- mwf_app: every request reads its user (auth middleware, by id after mwf_auth's app.resolve_user; RLS: its own row, the AI and its personas — a partner's name comes from app.session_parties, review F7)
-- The profile edit sets the names (controllers/auth.ts). No INSERT, and never id, kind, email or deleted_at
-- (work-bp5m): a first login creates the row through mwf_auth's app.create_user, so no request can write an email or
-- re-bind an account (the work-jv9y takeover needed mwf_app's UPDATE (clerk_id, email)); the tombstone is
-- app.anonymize_user_account.
GRANT SELECT ON "user" TO app_access;
GRANT UPDATE (first_name, last_name, updated_at) ON "user" TO app_access;
-- mwf_definer: create_user (INSERT … RETURNING id; the email-holder check), anonymize_user_account (existence, the tombstone,
-- the persona scrub)
-- participant_presence, session_parties (review F7: the name a co-participant is called by)
GRANT SELECT (id, kind, email, deleted_at, first_name, name) ON "user" TO mwf_definer;
GRANT INSERT (email, first_name, last_name) ON "user" TO mwf_definer;
GRANT UPDATE (email, first_name, last_name, deleted_at) ON "user" TO mwf_definer;
-- mwf_ai: empathy-store sessionParties (the reconciler's A/B order and the names in its prompts; id and kind:
-- Prisma's relation join key, participant (user_id, kind) -> user (id, kind) — measured: denied without kind)
GRANT SELECT (id, kind, first_name, name) ON "user" TO ai_access;
-- mwf_ops (work-k5fk.9, least privilege): exactly the columns the Neural Monitor reads (routes/brain.ts, the stage
-- shim), never a ciphertext or envelope column — the participant labels and the sessions search (name, email; kind and id:
-- Prisma's relation join key from participant), tombstones (deleted_at).
GRANT SELECT (id, kind, email, name, deleted_at) ON "user" TO ops_access;

-- The AI principal (work-k5fk.3): exactly one row of kind ai (sql_user_one_ai,
-- sql-only.sql), at a fixed version-7 id so code and fixtures name it without
-- a lookup (app.ai_user_id()). No email, no name, no identity; it becomes a
-- participant only when a session's humans invite it (design note §3).
INSERT INTO "user" (id, kind) VALUES ('00000000-0000-7000-8000-000000000001', 'ai');
CREATE FUNCTION app.ai_user_id() RETURNS uuid
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN '00000000-0000-7000-8000-000000000001'::uuid;
COMMENT ON FUNCTION app.ai_user_id() IS 'The id of the one AI user row, seeded by the baseline next to the "user" table. A constant: the seed and this function change together.';
-- mwf_app: the session paths that will seat the AI (design note §3) name it through this; a constant, no data.
REVOKE EXECUTE ON FUNCTION app.ai_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_user_id() TO app_access;

CREATE TABLE user_identity (
    provider identity_provider NOT NULL,
    subject text NOT NULL,
    user_id uuid7 NOT NULL,
    user_kind user_kind NOT NULL DEFAULT 'human' CHECK (user_kind = 'human'),
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (provider, subject),
    -- One identity per provider per user: a second Clerk account can never be
    -- attached to an existing user (work-jv9y: no re-bind).
    UNIQUE (user_id, provider),
    FOREIGN KEY (user_id, user_kind) REFERENCES "user" (id, kind) ON DELETE RESTRICT,
    -- Clerk issues user_ + a KSUID (27 base62 characters; clerk.com blog
    -- "Generating sortable Stripe-like IDs with Segment's KSUIDs", 2021), but
    -- its API reference promises no format (its examples say user_123): pin
    -- the prefix and the alphabet, bound the length, do not pin the 27.
    CONSTRAINT user_identity_clerk_subject CHECK (provider <> 'clerk' OR subject COLLATE "C" ~ '^user_[A-Za-z0-9]{1,64}$'),
    -- The E2E bypass's subjects: e2e_<user id> (middleware/auth.ts) and the
    -- seed routes' e2e_<ms>_<random> / e2e_inner_<ms>_<random> (routes/e2e.ts).
    CONSTRAINT user_identity_e2e_subject CHECK (provider <> 'e2e' OR subject COLLATE "C" ~ '^e2e_[a-z0-9_-]{1,64}$')
);
COMMENT ON TABLE user_identity IS 'How a human signs in (work-k5fk.1): one row per (provider, subject), the provider''s own user id, pointing at exactly one human user (pattern K) and at most one per provider. Written only by app.create_user (first login) and deleted by app.anonymize_user_account; mwf_app holds no privilege on it.';
COMMENT ON COLUMN user_identity.subject IS 'The provider''s user id: for clerk the verified JWT sub (user_…), for e2e the bypass''s e2e_… id.';
COMMENT ON COLUMN user_identity.user_kind IS 'Always human: pins the FK (user_id, user_kind) to a human user row (pattern K).';
COMMENT ON COLUMN user_identity.provider IS 'Who vouches for the subject (identity_provider): clerk in production; e2e only for the E2E bypass, written by the tooling connection (never app.create_user, which takes clerk only).';
COMMENT ON COLUMN user_identity.user_id IS 'The human this identity signs in as; at most one identity per provider per user (UNIQUE (user_id, provider)).';
COMMENT ON CONSTRAINT user_identity_clerk_subject ON user_identity IS 'A Clerk subject is user_ and 1-64 base62 characters. Clerk issues user_ + a 27-character KSUID, but its API reference does not promise that length, so it is bounded, not pinned.';
COMMENT ON CONSTRAINT user_identity_e2e_subject ON user_identity IS 'An E2E-bypass subject is e2e_ and 1-64 of [a-z0-9_-] (e2e_<uuid>, e2e_<ms>_<random>). The e2e provider is never used in production (lib/e2e-bypass.ts).';
-- mwf_app: nothing (work-bp5m). A request resolves its subject through mwf_auth's app.resolve_user and never reads,
-- writes or re-binds an identity.
-- mwf_definer: create_user (INSERT), anonymize_user_account (the identities go with the tombstone), app.identity_subject
-- (account-deletion.ts: the caller's own Clerk subject to delete at Clerk, read before the walk).
GRANT SELECT (provider, subject, user_id) ON user_identity TO mwf_definer;
GRANT INSERT (provider, subject, user_id) ON user_identity TO mwf_definer;
GRANT DELETE ON user_identity TO mwf_definer;

CREATE TABLE persona (
    user_id uuid7 NOT NULL,
    kind user_kind NOT NULL DEFAULT 'persona' CHECK (kind = 'persona'),
    owner_user_id uuid7 NOT NULL,
    owner_kind user_kind NOT NULL DEFAULT 'human' CHECK (owner_kind = 'human'),
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- The key is the FK's own columns, not user_id alone (design note §1 had
    -- PRIMARY KEY (user_id)): kind is CHECK-pinned to one value, so the two
    -- are the same rule, and Prisma models a one-to-one relation only when
    -- the defining side's FK columns are themselves unique (P1012 on a
    -- user_id key). One index either way.
    PRIMARY KEY (user_id, kind),
    FOREIGN KEY (user_id, kind) REFERENCES "user" (id, kind) ON DELETE RESTRICT,
    FOREIGN KEY (owner_user_id, owner_kind) REFERENCES "user" (id, kind) ON DELETE RESTRICT
);
CREATE INDEX ON persona (owner_user_id);
COMMENT ON TABLE persona IS 'A modeled person (work-k5fk.3; owner decision Q2: a table, so "user" stays identity-only): the persona''s user row (kind persona) and the human who created it, both ends pinned by kind (pattern K). The owner''s account deletion scrubs it (app.anonymize_user_account).';
COMMENT ON COLUMN persona.user_id IS 'The persona''s own user row (kind persona): the principal that is seated in a session.';
COMMENT ON COLUMN persona.owner_user_id IS 'The human who created the persona; its account deletion scrubs the persona.';
COMMENT ON COLUMN persona.kind IS 'Always persona: pins the FK (user_id, kind) to a persona user row (pattern K).';
COMMENT ON COLUMN persona.owner_kind IS 'Always human: pins the FK (owner_user_id, owner_kind) to a human user row (pattern K).';
-- mwf_app: nothing yet — no request creates or reads a persona until the modeled-participant paths move onto it (design note §3).
-- mwf_definer: anonymize_user_account finds the owner's personas to scrub.
GRANT SELECT (user_id, owner_user_id) ON persona TO mwf_definer;

CREATE TABLE user_contact (
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    contact_user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    nickname person_name,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, contact_user_id),
    CHECK (user_id <> contact_user_id)
);
CREATE INDEX ON user_contact (contact_user_id);
COMMENT ON TABLE user_contact IS 'What one user calls another, like a phone''s contact list (work-k5fk.2, replacing relationship_member.nickname): an attribute of the ordered pair, private to user_id and never shown to the contact. Not a membership: who shares a session is participant.';
COMMENT ON COLUMN user_contact.user_id IS 'The owner of the entry: the user who chose the nickname, and the only one who reads it.';
COMMENT ON COLUMN user_contact.contact_user_id IS 'The person the entry names.';
COMMENT ON COLUMN user_contact.nickname IS 'What user_id calls contact_user_id (at most 100 characters, not blank; the invite name for a known person or PATCH /contacts/:userId/nickname); NULL clears it, and a cleared entry is authoritative (the app shows the display name, never an old invite name). Plain text, set by the owner.';
COMMENT ON CONSTRAINT user_contact_check ON user_contact IS 'Nobody is their own contact.';
COMMENT ON INDEX user_contact_contact_user_id_idx IS 'The FK index of contact_user_id (the RESTRICT check on a user row).';
-- mwf_app: the caller's own entries only — createSession records the invite name for a known person, PATCH
-- /contacts/:userId/nickname edits it; every partner name reads the caller's own entry (a link invitee's name is
-- resolved from the caller's own invitation.invitee_name at read time, never written into a row: review round 1, Q1).
GRANT SELECT ON user_contact TO app_access;
GRANT INSERT (user_id, contact_user_id, nickname, created_at, updated_at) ON user_contact TO app_access;
GRANT UPDATE (nickname, updated_at) ON user_contact TO app_access;
-- mwf_definer: anonymize_user_account deletes the leaver's own entries (U-class: their words about others).
GRANT SELECT (user_id) ON user_contact TO mwf_definer;
-- mwf_definer: actor_name_for (a push names its actor by the recipient's own nickname for them)
GRANT SELECT (contact_user_id, nickname) ON user_contact TO mwf_definer;
GRANT DELETE ON user_contact TO mwf_definer;
-- mwf_ops: nothing — a nickname is its owner's alone (no dashboard reads one).

CREATE TABLE session (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    status session_status NOT NULL DEFAULT 'CREATED',
    topic_frame ciphertext,
    topic_frame_confirmed_at ts_ms,
    previous_session_id uuid7 REFERENCES session ON DELETE SET NULL,
    resolved_at ts_ms,
    archived_at ts_ms,
    archived_by_user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 session [P12]
    CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL),
    -- work-k5fk.10.12: an archived session says when; only an archived one has an archiver
    CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL)),
    CHECK (archived_by_user_id IS NULL OR archived_at IS NOT NULL)
);
CREATE INDEX ON session (previous_session_id);
CREATE INDEX ON session (archived_by_user_id);
COMMENT ON TABLE session IS 'One facilitated process on one topic between its participants (work-k5fk.2: no relationship row; who is in it is participant, the initiator the participant with no adder). At most one live session per pair of humans: live_session_pair.';
COMMENT ON COLUMN session.previous_session_id IS 'The session this one continues (a NEW_PROCESS follow-up).';
COMMENT ON COLUMN session.archived_at IS 'When the session was archived (status ARCHIVED); written with the status by app.session_archive or, for the retention job, app.session_set_status.';
COMMENT ON COLUMN session.archived_by_user_id IS 'The user who archived the session, a current participant of it at the time (app.session_archive checks it); NULL when the retention job archived it. A user, not a participant id: session precedes participant and tables.sql has no FK cycles.';
COMMENT ON CONSTRAINT session_check1 ON session IS 'An ARCHIVED session has archived_at, and only an ARCHIVED one does (work-k5fk.10.12).';
COMMENT ON CONSTRAINT session_check2 ON session IS 'An archiver only on an archived session (work-k5fk.10.12).';
COMMENT ON INDEX session_archived_by_user_id_idx IS 'The FK index of archived_by_user_id (the RESTRICT check on a user row).';
COMMENT ON COLUMN session.topic_frame IS 'encrypted (session): the AI''s short neutral topic phrase for the session (max 20 words by prompt), confirmed by the participants.';
-- mwf_app: createSession and tending startLinkedProcess create a session; the topic frame and its confirmation; the realtime
-- touch (updated_at). No UPDATE of status or the archive columns (work-k5fk.10.12): archiveSession goes through
-- app.session_archive, every other status move through app.session_set_status.
GRANT SELECT ON session TO app_access;
GRANT INSERT (status, previous_session_id, topic_frame, created_at, updated_at) ON session TO app_access;
GRANT UPDATE (topic_frame, topic_frame_confirmed_at, updated_at) ON session TO app_access;
-- mwf_definer: session_set_status, empathy_set_status (row lock), anonymize step 1, session_abandon_declined.
GRANT SELECT (id, status, resolved_at) ON session TO mwf_definer;
GRANT UPDATE (status, resolved_at) ON session TO mwf_definer;
-- mwf_ai: its own SELECT … FOR NO KEY UPDATE of the session row (empathy-store jobMoveIfUnchanged, reconciler/sharing.ts
-- deliverAcceptedShare: the reveal lock order) needs UPDATE on one column: updated_at, which touch_updated_at
-- rewrites anyway, and t_session_scope keeps to the AI's own session. Never status (app.session_set_status).
GRANT SELECT (id) ON session TO ai_access;
GRANT UPDATE (updated_at) ON session TO ai_access;
-- mwf_definer: session_archive and session_set_status (→ ARCHIVED), as their owner (work-k5fk.10.12)
GRANT SELECT (archived_at, archived_by_user_id) ON session TO mwf_definer;
GRANT UPDATE (archived_at, archived_by_user_id) ON session TO mwf_definer;
-- mwf_definer: invitation_peek (is the topic frame set and confirmed — never its text)
GRANT SELECT (topic_frame, topic_frame_confirmed_at) ON session TO mwf_definer;
-- mwf_worker: session-retention: the ACTIVE candidates, staleness of an ACTIVE session and the purge window of an
-- ARCHIVED one (status moves through app.session_set_status)
GRANT SELECT (id, status, updated_at) ON session TO worker_access;
-- mwf_worker: session-retention: an ARCHIVED session past the purge window is hard-deleted (every child
-- FKs session ON DELETE CASCADE; spec Conventions "retention hard-deletes whole sessions")
GRANT DELETE ON session TO worker_access;
-- mwf_ops (work-k5fk.9, least privilege): exactly the columns the Neural Monitor reads (routes/brain.ts, the stage
-- shim), never a ciphertext or envelope column — the session list, detail and filters.
GRANT SELECT (id, status, created_at, updated_at) ON session TO ops_access;

CREATE TABLE participant (
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    user_id uuid7 NOT NULL,
    kind user_kind NOT NULL DEFAULT 'human',
    added_by_user_id uuid7,
    -- work-k5fk.9 (D1): a snapshot of "user".name, which joins two person_name values: at most 100 + 1 + 100
    display_name text CHECK (char_length(display_name) <= 201),
    joined_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.3: a participant is a user in a session; every child references it by (session_id, x_user_id)
    PRIMARY KEY (session_id, user_id),
    -- work-k5fk.3 (pattern K): participant.kind is the user's kind, pinned by key (replaces t_participant_kind and the
    -- participant_kind enum): every present-humans rule filters kind = 'human' with no join to "user", which RLS
    -- will make own-row only.
    FOREIGN KEY (user_id, kind) REFERENCES "user" (id, kind) ON DELETE RESTRICT,
    -- work-k5fk.2: whoever brought this participant in is a participant of the same session (a self-reference, so not a
    -- cycle); the initiator is the row with no adder (sql_participant_one_initiator: at most one). No ON DELETE action:
    -- deleting an initiator must not delete everyone they added (review round 1, F6).
    FOREIGN KEY (session_id, added_by_user_id) REFERENCES participant (session_id, user_id),
    -- work-k5fk.2: only a human starts a session; the AI or a persona is always brought in
    CHECK (kind = 'human' OR added_by_user_id IS NOT NULL),
    CHECK (added_by_user_id IS DISTINCT FROM user_id)
);
CREATE INDEX ON participant (user_id, kind);
CREATE INDEX ON participant (session_id, added_by_user_id);
-- + sql_participant_one_initiator (sql-only.sql)
COMMENT ON TABLE participant IS 'One user''s seat in a session, keyed (session_id, user_id): every session-scoped row names its participants by that pair (work-k5fk.3). A seat is a human, the AI or a persona (participant.kind). Inserting a second human maintains live_session_pair (app.t_live_session_pair).';
COMMENT ON COLUMN participant.kind IS 'The user''s kind, pinned by FOREIGN KEY (user_id, kind) REFERENCES "user" (id, kind) (work-k5fk.3); every present-humans rule (readiness, the reveal gate, agreement parties, the pair rule) counts only human rows.';
COMMENT ON INDEX participant_user_id_kind_idx IS 'The FK index of (user_id, kind) → "user": a user''s seats (the session list) and the RESTRICT check when a user row goes.';
COMMENT ON COLUMN participant.added_by_user_id IS 'Who brought this participant into the session (work-k5fk.2): the inviter for an invitee, the human who seated the AI or their own persona; NULL for the session''s initiator (at most one such row, sql_participant_one_initiator). Replaces relationship_member.role = owner.';
COMMENT ON CONSTRAINT participant_check ON participant IS 'Only a human can be the initiator: the AI or a persona always has an adder.';
COMMENT ON CONSTRAINT participant_check1 ON participant IS 'Nobody adds themself: the initiator has no adder, everyone else was added by another participant.';
COMMENT ON INDEX participant_session_id_added_by_user_id_idx IS 'The FK index of (session_id, added_by_user_id): the NO ACTION check when an adder''s row is deleted (a participant who added others cannot be deleted on its own; the session''s CASCADE takes all of them).';
COMMENT ON COLUMN participant.display_name IS 'Snapshot of the name shown to co-participants, the only user fact they see; NULL falls back to the user''s first name, else user.name (v_participant, app.session_parties; review F7).';
COMMENT ON CONSTRAINT participant_display_name_check ON participant IS 'At most 201 characters: a snapshot of "user".name, two person_name values (each at most 100) joined by a space (work-k5fk.9, D1).';
COMMENT ON COLUMN participant.left_at IS 'When the participant left or deleted their account; the row stays.';
-- mwf_app: the inviter's participant at createSession (no adder: the initiator), the invitee's at accept (added by the
-- inviter), the caller's in a linked process. Never an UPDATE: display_name / left_at move only through
-- app.anonymize_user_in_session.
GRANT SELECT ON participant TO app_access;
GRANT INSERT (session_id, user_id, kind, added_by_user_id, display_name, joined_at, created_at, updated_at) ON participant TO app_access;
-- mwf_definer: is_member, every self/membership test, T-cardinality-*, reveal gate
GRANT SELECT (session_id, user_id, kind, left_at) ON participant TO mwf_definer;
-- mwf_definer: t_live_session_pair, t_participant_added_by (definer trigger functions it owns)
GRANT SELECT (added_by_user_id) ON participant TO mwf_definer;
-- mwf_definer: invitation_peek (the inviter's display name, as the invitee sees it)
GRANT SELECT (display_name) ON participant TO mwf_definer;
-- mwf_definer: session_parties (review F7: the parties of the caller's sessions, in join order)
GRANT SELECT (joined_at) ON participant TO mwf_definer;
-- mwf_definer: anonymize_user_in_session step 2
GRANT UPDATE (display_name, left_at) ON participant TO mwf_definer;
-- mwf_ai: empathy-store sessionParties (the reconciler's A/B order and the names in its prompts), brain-service
-- participantUserFor (whose turn a telemetry row is), partner-session-classifier (the participant it remembers for)
GRANT SELECT (session_id, user_id, kind, left_at, joined_at, display_name) ON participant TO ai_access;
-- mwf_worker: stage4-closure closureInputsAsJob / stage4.ts agreeIfEveryoneWilling: the present humans the closure
-- decides for
GRANT SELECT (session_id, user_id, kind, left_at) ON participant TO worker_access;
-- mwf_ops (work-k5fk.9, least privilege): exactly the columns the Neural Monitor reads (routes/brain.ts, the stage
-- shim), never a ciphertext or envelope column — labels, stages (v_current_stage) and the context route.
GRANT SELECT (session_id, user_id, kind, display_name, joined_at) ON participant TO ops_access;

CREATE TABLE live_session_pair (
    user_a uuid7 NOT NULL,
    user_b uuid7 NOT NULL,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,

    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b),
    FOREIGN KEY (session_id, user_a) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_b) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON live_session_pair (session_id, user_a);
CREATE INDEX ON live_session_pair (session_id, user_b);
COMMENT ON TABLE live_session_pair IS 'The rule "at most one live session per pair of humans" (A-Q3, work-k5fk.2) as a key, not a trigger search: one row per unordered pair of human participants of a live session, maintained by triggers only (app.t_live_session_pair on participant INSERT, app.t_live_session_pair_leave when a participant leaves (left_at set; work-k5fk.18), app.t_live_session_pair_end when the session goes RESOLVED, ABANDONED or ARCHIVED). A second live session for the same pair fails with unique_violation (23505, live_session_pair_pkey) at the moment its second human joins. The AI and personas are not human participants and never appear.';
COMMENT ON COLUMN live_session_pair.user_a IS 'The lesser of the two human user ids (CHECK user_a < user_b), so the pair is unordered.';
COMMENT ON COLUMN live_session_pair.user_b IS 'The greater of the two human user ids.';
COMMENT ON COLUMN live_session_pair.session_id IS 'The live session the pair shares; both users are its participants (two FKs to participant).';
COMMENT ON CONSTRAINT live_session_pair_check ON live_session_pair IS 'The pair is stored in one order only, so (a, b) and (b, a) are one key.';
COMMENT ON INDEX live_session_pair_session_id_user_a_idx IS 'The FK index of (session_id, user_a); the end-of-session DELETE uses its session_id prefix.';
COMMENT ON INDEX live_session_pair_session_id_user_b_idx IS 'The FK index of (session_id, user_b).';
-- mwf_app: createSession's pre-check (is the caller already in a live session with this person?), a read of the pair
-- table only. Never a write: the trigger functions own it.
GRANT SELECT ON live_session_pair TO app_access;
-- mwf_definer: owner of the two definer trigger functions that maintain it.
GRANT SELECT, INSERT, DELETE ON live_session_pair TO mwf_definer;

CREATE TABLE proposal (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    created_by_user_id uuid7,
    source proposal_source NOT NULL DEFAULT 'USER_SUBMITTED',
    kind proposal_kind NOT NULL DEFAULT 'SHARED_PROPOSAL',
    status proposal_status NOT NULL DEFAULT 'ACTIVE',
    description ciphertext NOT NULL,
    duration ciphertext,
    measure_of_success ciphertext,
    unresolved_need_labels ciphertext_list DEFAULT '{}'::ciphertext_list,
    removed_at ts_ms,
    removed_by_user_id uuid7,
    removal_reason ciphertext,
    shared_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 proposal [P21]
    CHECK ((status = 'REMOVED') = (removed_at IS NOT NULL)),
    CHECK (kind = 'INDIVIDUAL_COMMITMENT' OR shared_at IS NULL),
    -- work-k5fk.3: creator and remover are participants of the proposal's own session
    UNIQUE (id, session_id),
    FOREIGN KEY (session_id, created_by_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, removed_by_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON proposal (session_id, status);
CREATE INDEX ON proposal (session_id, created_by_user_id);
CREATE INDEX ON proposal (session_id, removed_by_user_id);
COMMENT ON TABLE proposal IS 'A Stage-4 repair idea: a shared proposal for the needs both see, or one participant''s individual commitment.';
COMMENT ON COLUMN proposal.created_by_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, created_by_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN proposal.removed_by_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, removed_by_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN proposal.shared_at IS 'INDIVIDUAL_COMMITMENT only: when its creator shared it with the co-participants (until then it is the creator''s alone: proposal app_select), by its own action (POST /stage4/commitments/:proposalId/share; work-k5fk.37). Releases its current text only — its revisions stay the creator''s (proposal_revision app_select). Written once, by app.proposal_share only; never cleared (work-k5fk.32 S1).';
COMMENT ON COLUMN proposal.description IS 'encrypted (session): what the proposal is, AI-proposed or typed (POST /strategies: 10 to 1000).';
COMMENT ON COLUMN proposal.duration IS 'encrypted (session): free text for how long, e.g. 3 days or 10 minutes, once this week (AI or user; max 100 on POST /strategies). NOT a true interval: nothing parses it.';
COMMENT ON COLUMN proposal.measure_of_success IS 'encrypted (session): free text: how the participants will know it worked (max 500 on POST /strategies).';
COMMENT ON COLUMN proposal.removal_reason IS 'encrypted (session): why it was removed: the AI''s REMOVE reason. Never the participant''s chat text — every member who sees the proposal reads it (work-k5fk.32).';
COMMENT ON COLUMN proposal.unresolved_need_labels IS 'encrypted (session): ciphertext_list, each element encrypted: need labels the proposal addresses that matched no need_share, as given by the AI or the participant.';
-- mwf_app: Stage 4 capture, the sub-chat and the shared-proposal routes create and edit proposals and their need labels
-- (stage4-capture.service.ts, stage4-subchat.service.ts, controllers/stage4.ts). FINDING: capture can set and re-assign
-- created_by_user_id to the PARTNER (from model output) and edit a partner's proposal. shared_at is
-- app.proposal_share's alone (work-k5fk.32 S1); the CONVERTED_TO_AGREEMENT move stays the worker's.
GRANT SELECT ON proposal TO app_access;
GRANT INSERT (session_id, created_by_user_id, source, kind, status, description, duration, measure_of_success,
              unresolved_need_labels, created_at, updated_at) ON proposal TO app_access;
GRANT UPDATE (description, duration, measure_of_success, kind, status, created_by_user_id,
              unresolved_need_labels, removed_at, removed_by_user_id, removal_reason, updated_at)
  ON proposal TO app_access;
-- mwf_definer: T-consent-owner (owner of a proposal / share offer / review target), fired by need_revoke_share;
-- app.proposal_share (the creator's commitment, its kind and status, and the one write of shared_at)
GRANT SELECT (id, session_id, created_by_user_id, kind, status, shared_at) ON proposal TO mwf_definer;
GRANT UPDATE (shared_at) ON proposal TO mwf_definer;
-- mwf_worker: stage4-closure closureInputsAsJob (fix round 1) and stage4.ts agreeIfEveryoneWilling: the closure decides
-- across every participant — the proposals it converts / schedules (snapshot text for the agreement and follow-up)
GRANT SELECT (id, session_id, created_by_user_id, kind, status, description, duration, measure_of_success, shared_at)
  ON proposal TO worker_access;
-- mwf_worker: stage4-store insertAgreementsTx: ACTIVE/REVISED → CONVERTED_TO_AGREEMENT
GRANT UPDATE (status) ON proposal TO worker_access;

CREATE TABLE conversation (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    kind conversation_kind NOT NULL DEFAULT 'MAIN',
    anchor_kind subchat_anchor,
    anchor_proposal_id uuid7,
    status conversation_status NOT NULL DEFAULT 'ACTIVE',
    resolved_at ts_ms,
    next_seq ordinal_no NOT NULL DEFAULT 1,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 conversation (anchor columns are SUBCHAT-only)
    CHECK ((kind = 'MAIN') = (anchor_kind IS NULL)),
    CHECK (kind = 'SUBCHAT' OR anchor_proposal_id IS NULL),
    -- work-k5fk.3: the target of message's (conversation_id, session_id)
    UNIQUE (id, session_id),
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    -- work-k5fk.9 (C1): a sub-chat refines a proposal of its own session; deleting the proposal nulls the anchor
    -- alone (PG15 SET NULL (col); step 20 pins the column list)
    FOREIGN KEY (anchor_proposal_id, session_id) REFERENCES proposal (id, session_id) ON DELETE SET NULL (anchor_proposal_id)
);
CREATE INDEX ON conversation (session_id, user_id, kind, status);
CREATE INDEX ON conversation (anchor_proposal_id);
-- + sql_conversation_one_main (sql-only.sql)
COMMENT ON TABLE conversation IS 'A participant''s private thread with the AI guide inside a session (exactly one MAIN), or a Stage-4 sub-chat.';
COMMENT ON COLUMN conversation.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN conversation.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN conversation.anchor_kind IS 'SUBCHAT only: what the sub-chat is about.';
COMMENT ON COLUMN conversation.anchor_proposal_id IS 'SUBCHAT only: the proposal a PROPOSAL_REFINEMENT sub-chat refines.';
COMMENT ON COLUMN conversation.next_seq IS 'The seq the next message of this conversation takes (work-k5fk.4). Advanced only by app.next_message_seq (through t_message_seq) under this row''s lock; 1 on a new conversation (t_conversation_seq_start).';
-- mwf_app: the caller's MAIN conversation at createSession / accept / linked process, a Stage 4 sub-chat and its resolution.
GRANT SELECT ON conversation TO app_access;
-- next_seq: a Prisma create sends its @default(1); t_conversation_seq_start pins it to 1 whatever is sent (work-k5fk.4).
GRANT INSERT (session_id, user_id, kind, anchor_kind, anchor_proposal_id, status, next_seq, created_at, updated_at)
  ON conversation TO app_access;
GRANT UPDATE (status, resolved_at, updated_at) ON conversation TO app_access;
-- mwf_definer: empathy_set_status: the subject's MAIN conversation; anonymize step 3; deliver_message (the recipient)
GRANT SELECT (id, session_id, user_id, kind) ON conversation TO mwf_definer;
-- mwf_ai: a facilitator line reads its conversation's session into message.session_id (message-store insert, work-k5fk.3);
-- sessionParties: each party's MAIN conversation
GRANT SELECT (id, session_id, user_id, kind) ON conversation TO ai_access;
-- mwf_definer: app.next_message_seq (SECURITY DEFINER, owned by mwf_definer; work-k5fk.4) takes the next number. Only
-- the NOLOGIN owner holds it (work-k5fk.10.4 moved it off mwf_job): no runtime login can move the counter directly.
GRANT SELECT (next_seq) ON conversation TO mwf_definer;
GRANT UPDATE (next_seq) ON conversation TO mwf_definer;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5)
GRANT DELETE ON conversation TO mwf_definer;
-- mwf_ops (work-k5fk.9, least privilege): exactly the columns the Neural Monitor reads (routes/brain.ts, the stage
-- shim), never a ciphertext or envelope column — the user-turn count joins MAIN conversations.
GRANT SELECT (id, session_id, user_id, kind) ON conversation TO ops_access;

CREATE TABLE empathy_attempt (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL,
    author_user_id uuid7 NOT NULL,
    subject_user_id uuid7 NOT NULL,
    round ordinal_no NOT NULL DEFAULT 1,
    supersedes_attempt_id uuid7,
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

    UNIQUE (session_id, author_user_id, subject_user_id, round),
    -- §1.2 empathy_attempt [P15b, P15d]
    CHECK (author_user_id <> subject_user_id),
    CHECK (status NOT IN ('REVEALED', 'VALIDATED') OR revealed_at IS NOT NULL),
    -- work-k5fk.3: author and subject on the one session_id: same-session is this key, not a trigger (retires
    -- t_same_session); the UNIQUEs are what reviews, results, offers, drafts, consents and messages pin to
    UNIQUE (id, session_id),
    UNIQUE (id, session_id, subject_user_id),
    -- work-k5fk.9 (C2, C9): the whole direction — what a superseding round and a reconciler result pin to
    UNIQUE (id, session_id, author_user_id, subject_user_id),
    FOREIGN KEY (session_id, author_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, subject_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    -- work-k5fk.9 (C2): a round supersedes a round of the same direction (same session, author and subject);
    -- deleting it nulls the link alone (PG15 SET NULL (col); step 20 pins the column list)
    FOREIGN KEY (supersedes_attempt_id, session_id, author_user_id, subject_user_id)
      REFERENCES empathy_attempt (id, session_id, author_user_id, subject_user_id) ON DELETE SET NULL (supersedes_attempt_id),
    -- work-k5fk.9 (D4): the delivery group (delivery_status, delivered_at, seen_at) agrees with itself; the same three
    -- CHECKs as context_share_offer's. Seen implies delivered: PENDING → SEEN directly stamps delivered_at too
    -- (app.empathy_mark_delivery).
    CHECK ((delivery_status = 'SEEN') = (seen_at IS NOT NULL)),
    CHECK (delivery_status = 'PENDING' OR delivered_at IS NOT NULL),
    CHECK (delivery_status <> 'PENDING' OR (delivered_at IS NULL AND seen_at IS NULL))
);
CREATE INDEX ON empathy_attempt (session_id, subject_user_id, revealed_at);
CREATE INDEX ON empathy_attempt (supersedes_attempt_id);
-- + sql_attempt_one_live_per_direction (sql-only.sql)
COMMENT ON TABLE empathy_attempt IS 'Stage 2: one participant''s statement of how they imagine the other feels, per direction and round; revealed to the subject once both are READY.';
COMMENT ON CONSTRAINT empathy_attempt_check2 ON empathy_attempt IS 'Delivery group (work-k5fk.9, D4): seen_at is set exactly when the item is SEEN.';
COMMENT ON CONSTRAINT empathy_attempt_check3 ON empathy_attempt IS 'Delivery group (work-k5fk.9, D4): a DELIVERED or SEEN item has its delivered_at — seen implies delivered (PENDING straight to SEEN stamps both).';
COMMENT ON CONSTRAINT empathy_attempt_check4 ON empathy_attempt IS 'Delivery group (work-k5fk.9, D4): a PENDING item has neither delivery stamp.';
COMMENT ON COLUMN empathy_attempt.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN empathy_attempt.author_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, author_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN empathy_attempt.subject_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, subject_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN empathy_attempt.round IS '1 for the first statement in this direction; +1 per resubmission.';
COMMENT ON COLUMN empathy_attempt.status_version IS 'Incremented on every status change, to order status events.';
COMMENT ON COLUMN empathy_attempt.revealed_at IS 'Set once at the reveal and never cleared: the subject''s right to read the attempt hangs on it, not on status.';
COMMENT ON COLUMN empathy_attempt.content IS 'encrypted (per-row): the author''s empathy statement; participant (author) key until revealed, then re-encrypted under the session key. The plaintext never changes.';
-- mwf_app: the author submits round 1 (empathy-store submitAttempt); every later move is app.empathy_set_status, and the
-- delivery stamps are the job's.
GRANT SELECT ON empathy_attempt TO app_access;
GRANT INSERT (session_id, author_user_id, subject_user_id, round, content, status, status_version, delivery_status,
              submitted_at, created_at, updated_at)
  ON empathy_attempt TO app_access;
-- mwf_definer: empathy_set_status reads the row (%ROWTYPE) and RETURNING id; empathy_direction_status; T-consent-owner;
-- anonymize (revealed_at filter); empathy_mark_delivery
GRANT SELECT ON empathy_attempt TO mwf_definer;
-- mwf_definer: empathy_set_status's status moves and reveal stamp; empathy_mark_delivery's stamps
GRANT UPDATE (status, status_version, revealed_at, delivery_status, delivered_at, seen_at) ON empathy_attempt TO mwf_definer;
-- mwf_ai: the reconciler reads every column of an attempt (empathy-store ATTEMPT_SELECT: the guess is its prompt);
-- jobMoveIfUnchanged locks the row FOR NO KEY UPDATE, which needs UPDATE on one column: updated_at (touch_updated_at
-- rewrites it; t_session_scope keeps it to the AI's session). Status moves through app.empathy_set_status, delivery
-- stamps through app.empathy_mark_delivery.
GRANT SELECT ON empathy_attempt TO ai_access;
GRANT UPDATE (updated_at) ON empathy_attempt TO ai_access;
-- mwf_definer: empathy_set_status: round n+1 on resubmission
GRANT INSERT (session_id, author_user_id, subject_user_id, round, supersedes_attempt_id, content, status) ON empathy_attempt TO mwf_definer;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5)
GRANT DELETE ON empathy_attempt TO mwf_definer;

CREATE TABLE need (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    label ciphertext NOT NULL,
    category need_category NOT NULL,
    evidence ciphertext_list DEFAULT '{}'::ciphertext_list,
    ai_confidence real NOT NULL,
    confirmed_at ts_ms,
    locked_at ts_ms,
    superseded_by_need_id uuid7,
    deleted_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 need [P30]
    CHECK (ai_confidence BETWEEN 0 AND 1),
    -- work-k5fk.3: what consent and need_share pin to (a share is its owner's, by key)
    UNIQUE (id, session_id),
    UNIQUE (id, session_id, user_id),
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    -- work-k5fk.9 (C3): a need is superseded only by its owner's own need of the same session; deleting the newer one
    -- nulls the link alone (PG15 SET NULL (col); step 20 pins the column list)
    FOREIGN KEY (superseded_by_need_id, session_id, user_id) REFERENCES need (id, session_id, user_id)
      ON DELETE SET NULL (superseded_by_need_id)
);
CREATE INDEX ON need (session_id, user_id);
CREATE INDEX ON need (superseded_by_need_id);
-- + sql_need_live (sql-only.sql)
COMMENT ON TABLE need IS 'A need the AI identified for a participant; owner-only, always. A co-participant sees a need only through need_share.';
COMMENT ON COLUMN need.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN need.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN need.ai_confidence IS 'The model''s confidence in the need, 0 to 1.';
COMMENT ON COLUMN need.locked_at IS 'When the need was locked against further edits.';
COMMENT ON COLUMN need.superseded_by_need_id IS 'The need that replaced this one after an edit.';
COMMENT ON COLUMN need.label IS 'encrypted (participant): the need statement in the participant''s words (AI-identified or typed); free text, not a taxonomy (category is the classification).';
COMMENT ON COLUMN need.evidence IS 'encrypted (participant): ciphertext_list, each element encrypted: short quotes of what the participant said; never copied to need_share.';
-- mwf_app: the caller's needs — extraction, edits, confirm / lock, supersede and soft delete (needs.ts,
-- needs-edit-applier.service.ts, controllers/stage3.ts). Never a DELETE.
GRANT SELECT ON need TO app_access;
GRANT INSERT (session_id, user_id, label, category, evidence, ai_confidence, confirmed_at, created_at, updated_at)
  ON need TO app_access;
GRANT UPDATE (label, category, confirmed_at, locked_at, superseded_by_need_id, deleted_at, updated_at) ON need TO app_access;
-- mwf_definer: need_share (owner, category, live), need_revoke_share (owner), T-consent-owner, anonymize step 3
GRANT SELECT (id, session_id, user_id, category, deleted_at, superseded_by_need_id) ON need TO mwf_definer;
-- mwf_definer: need_share copies the need's session and user into the share (work-k5fk.3, 6a)
GRANT SELECT (session_id, user_id) ON need TO mwf_definer;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5)
GRANT DELETE ON need TO mwf_definer;

CREATE TABLE message (
    conversation_id uuid7 NOT NULL,
    seq ordinal_no NOT NULL,
    session_id uuid7 NOT NULL,
    sender_user_id uuid7,
    role message_role NOT NULL,
    kind message_kind NOT NULL DEFAULT 'CHAT',
    content ciphertext NOT NULL,
    dedupe_key message_dedupe_key,
    refining_need_id uuid7,
    source_attempt_id uuid7,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.4: the line is its conversation's seq-th; t_message_seq numbers it (trailer.sql). The key is the chat order.
    PRIMARY KEY (conversation_id, seq),
    -- work-k5fk.4: what conversation_read_state's seen-message key pins to (the seen line is of the reader's session)
    UNIQUE (conversation_id, seq, session_id),
    -- §1.1 message [P02] — P3 §6, "humans can't author as the facilitator": a participant's line has a sender,
    -- the facilitator's (AI / SYSTEM) none (the two CHECKs of 6b, folded)
    CHECK ((role = 'USER') = (sender_user_id IS NOT NULL)),
    -- work-fdc1: a once-only key marks a facilitator line, never a human's
    CHECK (dedupe_key IS NULL OR role IN ('AI', 'SYSTEM')),
    -- work-k5fk.3: the conversation, the sender, the refined need and the cited attempt are all of the one session.
    -- work-k5fk.4 (k5fk.21, k5fk.23): each pin is the only key to its table, and deleting the need / attempt nulls
    -- the id column alone (PG15 SET NULL (col)), never session_id. Prisma renders that as onDelete: SetNull (it reads
    -- confdeltype, not confdelsetcols), so the drift gate cannot see the column list: step 20 pins it (trailer.sql).
    FOREIGN KEY (conversation_id, session_id) REFERENCES conversation (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, sender_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (refining_need_id, session_id) REFERENCES need (id, session_id) ON DELETE SET NULL (refining_need_id),
    FOREIGN KEY (source_attempt_id, session_id) REFERENCES empathy_attempt (id, session_id)
      ON DELETE SET NULL (source_attempt_id)
);
-- + sql_message_once (sql-only.sql)
CREATE INDEX ON message (session_id, sender_user_id);
CREATE INDEX ON message (refining_need_id);
CREATE INDEX ON message (source_attempt_id);
COMMENT ON TABLE message IS 'One line of a conversation: a human turn, an AI or system line, or an item delivered from the other participant. Append-only. Keyed by its conversation and its place in it (work-k5fk.4).';
COMMENT ON COLUMN message.seq IS 'The line''s place in its conversation, 1, 2, 3 … in insertion order (work-k5fk.4): t_message_seq takes it from conversation.next_seq when an INSERT leaves it NULL, under the conversation row''s lock. A rolled-back insert takes none; a deleted line, or a once-only line that met its duplicate, leaves a hole. The API''s message id is "<conversation_id>:<seq>".';
COMMENT ON COLUMN message.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN message.sender_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, sender_user_id) references participant (session_id, user_id). Set exactly on a participant''s line (role USER); NULL on the facilitator''s.';
COMMENT ON COLUMN message.refining_need_id IS 'The participant''s need a Stage 3 refinement turn is about: (refining_need_id, session_id) references need (id, session_id).';
COMMENT ON COLUMN message.source_attempt_id IS 'Lineage of a delivered item: the empathy attempt it came from: (source_attempt_id, session_id) references empathy_attempt (id, session_id).';
COMMENT ON COLUMN message.dedupe_key IS 'Set only on an app-generated AI or SYSTEM line that is written at most once per conversation; sql_message_once makes a second insert conflict. NULL on every other line. Nothing about the content is stored outside the ciphertext.';
COMMENT ON COLUMN message.content IS 'encrypted (per-row): the line''s text: the owner''s turn and the AI''s replies under the participant key, every delivered kind under the session key.';
-- mwf_app: the caller's own turns in their own conversation (message-store createParticipantMessage) and their own copy of
-- an empathy statement (empathy-messages.ts). Never an UPDATE (t_message_immutable; delivered and AI rows are the job's).
-- Never seq: t_message_seq numbers every row.
-- DELETE: a failed stream turn's USER row (stream-turn-persistence.ts) and — FINDING — the job-written SHARE_SUGGESTION
-- rows of the caller's MAIN conversation when the share offer is declined or accepted (reconciler/sharing.ts).
GRANT SELECT ON message TO app_access;
GRANT INSERT (conversation_id, session_id, sender_user_id, role, kind, content, refining_need_id, source_attempt_id,
              created_at)
  ON message TO app_access;
GRANT DELETE ON message TO app_access;
-- mwf_definer: empathy_set_status: the delivered copy, and its duplicate probe; deliver_message: the delivered copy with
-- its instant, RETURNING seq, created_at
GRANT SELECT (conversation_id, source_attempt_id, kind, seq, created_at) ON message TO mwf_definer;
-- mwf_definer: stage4_transition_started (whether a party's Stage 4 transition line exists: its key, never content)
GRANT SELECT (dedupe_key) ON message TO mwf_definer;
-- mwf_definer: co_participant_presence (a co-participant's last turn: the instant of their latest USER CHAT line)
GRANT SELECT (session_id, sender_user_id, role) ON message TO mwf_definer;
GRANT INSERT (conversation_id, session_id, sender_user_id, role, kind, content, source_attempt_id, created_at) ON message TO mwf_definer;
-- mwf_ai: message-store createFacilitatorMessage / createFacilitatorMessageOnce: the AI / SYSTEM line (sender_user_id
-- is sent as NULL; t_session_scope refuses any other role), a once-only line's dedupe_key (work-fdc1, sql_message_once),
-- the refining need a facilitator reply answers, the attempt it is about, and an explicit instant (fixtures, replays).
-- A delivered (USER) row is never the AI's: app.deliver_message.
GRANT INSERT (conversation_id, session_id, sender_user_id, role, kind, content, refining_need_id, source_attempt_id,
              dedupe_key, created_at)
  ON message TO ai_access;
-- mwf_ai: insert() returns the written row's key and instant (INSERT … RETURNING seq, created_at); getInitialMessage's
-- Serializable idempotency probe asks whether the conversation holds a line (work-k5fk.4); analysis.ts stagedChat
-- (witnessing content, the subject's recent Stage 2 turns) and state.ts markEmpathyReady's de-dup guard (lastAiNote):
-- the text and speaker of the MAIN-conversation CHAT rows of the two parties. Never dedupe_key.
GRANT SELECT (conversation_id, seq, session_id, sender_user_id, role, kind, content, source_attempt_id, created_at)
  ON message TO ai_access;
-- mwf_worker: session-retention: the latest message of a stale candidate (max(created_at) by session_id). Never content.
GRANT SELECT (session_id, created_at) ON message TO worker_access;
-- mwf_ops: the Neural Monitor dashboard (routes/brain.ts, directly or through the stage shim) reads it — never content
-- (owner decision OD-1, work-k5fk.9: the transcript panel is gone; the dashboard counts turns and reads their keys).
-- work-k5fk.9 (least privilege): exactly the columns its turn counts read (seq with conversation_id: the key a Prisma
-- count selects).
GRANT SELECT (conversation_id, seq, session_id, sender_user_id, role, kind) ON message TO ops_access;

CREATE TABLE conversation_read_state (
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    last_viewed_at ts_ms,
    last_seen_conversation_id uuid7,
    last_seen_seq ordinal_no,
    last_viewed_share_tab_at ts_ms,
    last_active_at ts_ms,
    archived_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.3: one read state per participant, keyed by it
    PRIMARY KEY (session_id, user_id),
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    -- work-k5fk.4 (owner Q6; k5fk.23): the seen message by its key, of the reader's session; both or neither.
    -- Deleting it nulls the two columns, never session_id (PG15 SET NULL (cols); Prisma reads it as SetNull).
    CHECK ((last_seen_conversation_id IS NULL) = (last_seen_seq IS NULL)),
    FOREIGN KEY (last_seen_conversation_id, last_seen_seq, session_id) REFERENCES message (conversation_id, seq, session_id)
      ON DELETE SET NULL (last_seen_conversation_id, last_seen_seq)
);
CREATE INDEX ON conversation_read_state (last_seen_conversation_id, last_seen_seq, session_id);
COMMENT ON TABLE conversation_read_state IS 'Per-participant view state: what was last viewed or seen, presence, and whether the session is archived from their list.';
COMMENT ON COLUMN conversation_read_state.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN conversation_read_state.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN conversation_read_state.last_seen_conversation_id IS 'With last_seen_seq, the last message this participant has seen: the "new messages" line (work-k5fk.4). Both NULL when there is none or it was deleted.';
COMMENT ON COLUMN conversation_read_state.last_seen_seq IS 'With last_seen_conversation_id, the seen message''s seq: (last_seen_conversation_id, last_seen_seq, session_id) references message (conversation_id, seq, session_id).';
COMMENT ON COLUMN conversation_read_state.last_viewed_share_tab_at IS 'When the participant last viewed received shared items ("Seen"); the name predates the Share tab''s removal.';
COMMENT ON COLUMN conversation_read_state.last_active_at IS 'Presence; shown to the co-participant only when their privacy preferences allow (v_participant).';
COMMENT ON COLUMN conversation_read_state.archived_at IS 'Set when the participant hid the session from their list.';
-- mwf_app: the caller's read state — created with the participant, then viewed / active / seen / share-tab stamps.
GRANT SELECT ON conversation_read_state TO app_access;
GRANT INSERT (session_id, user_id, last_viewed_at, last_active_at, last_seen_conversation_id, last_seen_seq,
              last_viewed_share_tab_at, created_at, updated_at)
  ON conversation_read_state TO app_access;
GRANT UPDATE (last_viewed_at, last_active_at, last_seen_conversation_id, last_seen_seq, last_viewed_share_tab_at,
              updated_at)
  ON conversation_read_state TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (session_id, user_id) ON conversation_read_state TO mwf_definer;
-- mwf_definer: participant_presence (v_participant: the caller's own read state; a co-participant's shared-frame instant and last activity, review F2)
GRANT SELECT (last_viewed_at, last_seen_conversation_id, last_seen_seq, last_viewed_share_tab_at, last_active_at, archived_at)
  ON conversation_read_state TO mwf_definer;
GRANT DELETE ON conversation_read_state TO mwf_definer;

CREATE TABLE reconciler_result (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    author_user_id uuid7 NOT NULL,
    subject_user_id uuid7 NOT NULL,
    iteration ordinal_no NOT NULL DEFAULT 1,
    alignment_score integer NOT NULL,
    alignment_summary ciphertext NOT NULL,
    gap_summary ciphertext NOT NULL,
    gap_severity gap_severity NOT NULL,
    correctly_identified ciphertext_list DEFAULT '{}'::ciphertext_list,
    missed_feelings ciphertext_list DEFAULT '{}'::ciphertext_list,
    misattributions ciphertext_list DEFAULT '{}'::ciphertext_list,
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
    -- work-k5fk.3: the result's subject is its attempt's subject, by key (the subject half of t_result_live_attempt);
    -- work-k5fk.9 (C9): and its author the attempt's author, so the guidance cut from it names the right author
    UNIQUE (id, session_id),
    UNIQUE (id, session_id, author_user_id, subject_user_id),
    -- work-k5fk.9 (C10): what an offer's result key pins to (the offer cites a result of its own attempt)
    UNIQUE (id, attempt_id),
    FOREIGN KEY (attempt_id, session_id, author_user_id, subject_user_id)
      REFERENCES empathy_attempt (id, session_id, author_user_id, subject_user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, subject_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON reconciler_result (session_id, subject_user_id);
-- + sql_result_one_current (sql-only.sql)
COMMENT ON TABLE reconciler_result IS 'The reconciler''s gap analysis of one empathy attempt against its subject''s account; immutable, one current per attempt (superseded_at). Visible to the subject only.';
COMMENT ON COLUMN reconciler_result.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN reconciler_result.author_user_id IS 'The analysed attempt''s author (work-k5fk.9, C9): (attempt_id, session_id, author_user_id, subject_user_id) references empathy_attempt, so the guidance keyed to this result can only name that author. Never read by the subject''s policy.';
COMMENT ON COLUMN reconciler_result.subject_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, subject_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN reconciler_result.iteration IS '1 for the first analysis of the attempt; +1 per re-analysis.';
COMMENT ON COLUMN reconciler_result.alignment_score IS 'How well the attempt matches the subject''s account, 0 to 100.';
COMMENT ON COLUMN reconciler_result.circuit_breaker_tripped IS 'Meant to mark a result that ended the refinement loop by its circuit breaker; no writer sets it true today and nothing reads it (spec 1.2).';
COMMENT ON COLUMN reconciler_result.superseded_at IS 'Set when a newer result replaces this one; NULL marks the current result.';
COMMENT ON COLUMN reconciler_result.alignment_summary IS 'encrypted (participant): the reconciler''s 1-2 sentence summary of what the attempt got right.';
COMMENT ON COLUMN reconciler_result.gap_summary IS 'encrypted (participant): the reconciler''s 1-2 sentence summary of what it missed.';
COMMENT ON COLUMN reconciler_result.correctly_identified IS 'encrypted (participant): ciphertext_list, each element encrypted: the feelings the attempt identified, LLM output.';
COMMENT ON COLUMN reconciler_result.missed_feelings IS 'encrypted (participant): ciphertext_list, each element encrypted: the feelings the attempt missed, LLM output.';
COMMENT ON COLUMN reconciler_result.misattributions IS 'encrypted (participant): ciphertext_list, each element encrypted: what the attempt attributed wrongly, LLM output.';
COMMENT ON COLUMN reconciler_result.most_important_gap IS 'encrypted (participant): the single most important gap, LLM output, or NULL.';
COMMENT ON COLUMN reconciler_result.rationale IS 'encrypted (participant): why the reconciler recommends its action, LLM output.';
COMMENT ON COLUMN reconciler_result.suggested_share_focus IS 'encrypted (participant): what the subject might share, LLM output, or NULL.';
COMMENT ON COLUMN reconciler_result.suggested_share_content IS 'encrypted (participant): a 1-3 sentence suggestion of what the subject could say, LLM output.';
COMMENT ON COLUMN reconciler_result.suggested_share_reason IS 'encrypted (participant): one sentence on why sharing would help, LLM output.';
-- mwf_app: read only (the share offer's result, the reconciler state the subject sees); every write is the job's.
GRANT SELECT ON reconciler_result TO app_access;
-- mwf_definer: result_facts (which attempt a result analysed, its iteration and supersession — never the analysis)
GRANT SELECT (id, attempt_id, subject_user_id, iteration, superseded_at) ON reconciler_result TO mwf_definer;
-- mwf_ai: reconciler/analysis.ts persistAnalysis: one current result per attempt — the next
-- iteration (max(iteration) of the attempt), RETURNING id, and the re-analysis
-- supersede (WHERE attempt_id … AND superseded_at IS NULL).
GRANT SELECT (id, attempt_id, iteration, superseded_at) ON reconciler_result TO ai_access;
-- mwf_ai: persistAnalysis: the analysis row itself (id, created_at, updated_at are column defaults)
GRANT INSERT (attempt_id, session_id, author_user_id, subject_user_id, iteration, alignment_score, alignment_summary, gap_summary,
              gap_severity, correctly_identified, missed_feelings, misattributions, most_important_gap,
              recommended_action, rationale, sharing_would_help, suggested_share_focus, suggested_share_content,
              suggested_share_reason, circuit_breaker_tripped) ON reconciler_result TO ai_access;
-- mwf_ai: persistAnalysis: re-analysis of the same attempt retires the current result
GRANT UPDATE (superseded_at) ON reconciler_result TO ai_access;
-- mwf_ai: analysis.ts currentResultFor / analyzeEmpathyGap's cached result, sharing.ts generateShareOffer,
-- state.ts reveal quality note: the stored analysis an analysis reuses (RESULT_SELECT)
GRANT SELECT (session_id, subject_user_id, alignment_score, alignment_summary, correctly_identified, gap_severity,
              gap_summary, missed_feelings, misattributions, most_important_gap, recommended_action, rationale,
              sharing_would_help, suggested_share_focus, suggested_share_content, suggested_share_reason, created_at)
  ON reconciler_result TO ai_access;

CREATE TABLE context_share_offer (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    result_id uuid7 NOT NULL REFERENCES reconciler_result ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    subject_user_id uuid7 NOT NULL,
    iteration ordinal_no NOT NULL DEFAULT 1,
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
    CHECK ((status = 'DECLINED') = (declined_at IS NOT NULL)),
    -- work-k5fk.3: the offer goes to its attempt's subject; work-k5fk.9 (C10): about a result of that same attempt
    -- (not another attempt's, nor another round's), so of the same session too
    UNIQUE (id, session_id),
    -- work-k5fk.9 (C11): what a SHARE_CONTEXT draft pins to (its owner is the offer's subject)
    UNIQUE (id, session_id, subject_user_id),
    FOREIGN KEY (attempt_id, session_id, subject_user_id) REFERENCES empathy_attempt (id, session_id, subject_user_id) ON DELETE CASCADE,
    FOREIGN KEY (result_id, attempt_id) REFERENCES reconciler_result (id, attempt_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, subject_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    -- work-k5fk.9 (D4): the delivery group agrees with itself (the same three CHECKs as empathy_attempt's)
    CHECK ((delivery_status = 'SEEN') = (seen_at IS NOT NULL)),
    CHECK (delivery_status = 'PENDING' OR delivered_at IS NOT NULL),
    CHECK (delivery_status <> 'PENDING' OR (delivered_at IS NULL AND seen_at IS NULL))
);
CREATE INDEX ON context_share_offer (session_id, subject_user_id, status);
CREATE INDEX ON context_share_offer (result_id);
COMMENT ON TABLE context_share_offer IS 'The suggestion to the subject of an attempt to share context with its author, and what happened to it; the shared text is delivered to the author as a message.';
COMMENT ON CONSTRAINT context_share_offer_check2 ON context_share_offer IS 'Delivery group (work-k5fk.9, D4): seen_at is set exactly when the item is SEEN.';
COMMENT ON CONSTRAINT context_share_offer_check3 ON context_share_offer IS 'Delivery group (work-k5fk.9, D4): a DELIVERED or SEEN item has its delivered_at — seen implies delivered (PENDING straight to SEEN stamps both).';
COMMENT ON CONSTRAINT context_share_offer_check4 ON context_share_offer IS 'Delivery group (work-k5fk.9, D4): a PENDING item has neither delivery stamp.';
COMMENT ON COLUMN context_share_offer.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN context_share_offer.subject_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, subject_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN context_share_offer.delivery_notified_at IS 'When the subject who shared was shown that the shared context was delivered (GET notifications, Sent-tab updates).';
COMMENT ON COLUMN context_share_offer.seen_notified_at IS 'When the subject who shared was shown that the author has seen it.';
COMMENT ON COLUMN context_share_offer.offer_message IS 'encrypted (participant): the AI''s 2-3 sentence message offering the subject the chance to share.';
COMMENT ON COLUMN context_share_offer.suggested_content IS 'encrypted (participant): the suggested text to share, LLM output or the subject''s AI-assisted draft.';
COMMENT ON COLUMN context_share_offer.suggested_reason IS 'encrypted (participant): why sharing it would help, LLM output.';
COMMENT ON COLUMN context_share_offer.shared_content IS 'encrypted (session): the exact text the subject approved; copied into the author''s SHARED_CONTEXT message at delivery.';
-- mwf_app: the SUBJECT acts on their own offer (reconciler/sharing.ts, controllers/reconciler.ts): view (OFFERED), edit the
-- suggestion, decline, accept with the shared text. Creation and delivery are the job's.
GRANT SELECT ON context_share_offer TO app_access;
GRANT UPDATE (status, offered_at, suggested_content, declined_at, shared_content, shared_at, updated_at) ON context_share_offer TO app_access;
-- mwf_definer: T-consent-owner (owner of a proposal / share offer / review target), fired by need_revoke_share;
-- share_offers_expire (stage2.ts triggerStage3Transition: open offers expire when the Stage 2 sharing window closes)
-- and share_offers_mark_notified (notifications.ts getPendingActionsHandler: the subject's own notification stamps)
-- (attempt_id, delivery_status: deliver_message's AI arm ties a SHARED_CONTEXT to the sender's ACCEPTED, undelivered
-- offer on the recipient's round, review F3)
GRANT SELECT (id, session_id, subject_user_id, status, attempt_id, delivery_status) ON context_share_offer TO mwf_definer;
-- mwf_definer: shares_delivered_to_me (the author's delivered shared text — never the offer)
GRANT SELECT (shared_content, shared_at, delivered_at) ON context_share_offer TO mwf_definer;
GRANT UPDATE (status, delivery_notified_at, seen_notified_at) ON context_share_offer TO mwf_definer;
-- mwf_ai: reconciler/sharing.ts insertOffer: the next iteration of an attempt's offers (max(iteration)), RETURNING id;
-- generateShareSuggestion(ForDirection) / generateShareOffer: does this result already have an (open) offer (with a
-- suggestion)?; deliverAcceptedShare (fix1 I2): the delivery is idempotent — it locks the offer (SELECT … FOR UPDATE)
-- and delivers only while delivery_status is PENDING. Never the shared text.
GRANT SELECT (id, session_id, subject_user_id, attempt_id, result_id, iteration, status, delivery_status, suggested_content)
  ON context_share_offer TO ai_access;
-- mwf_ai: insertOffer: the subject's offer (PENDING from the reconciler; OFFERED with offered_at from the share-offer fallback)
GRANT INSERT (attempt_id, result_id, session_id, subject_user_id, iteration, status, offer_message, suggested_content,
              suggested_reason, offered_at) ON context_share_offer TO ai_access;
-- mwf_ai: deliverAcceptedShare: the delivery stamp of the shared text
GRANT UPDATE (delivery_status, delivered_at) ON context_share_offer TO ai_access;

CREATE TABLE milestone (
    key milestone_key NOT NULL PRIMARY KEY,
    ordinal integer NOT NULL UNIQUE,
    stage_label text NOT NULL,
    scope milestone_scope NOT NULL DEFAULT 'participant',
    self_assertable boolean NOT NULL DEFAULT false,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE milestone IS 'Reference data: the journey milestones, in order. The only place a stage exists, as data; seeded right here by the baseline migration and read-only to every runtime role.';
COMMENT ON COLUMN milestone.key IS 'Stable identifier of the milestone, e.g. feel_heard (domain milestone_key); code (shared MILESTONE_KEYS) and participant_milestone refer to it.';
COMMENT ON COLUMN milestone.ordinal IS 'Position along the journey: stage * 100 + position, so floor(ordinal / 100) is the stage number; 0 (paused) is off the journey.';
COMMENT ON COLUMN milestone.stage_label IS 'UI label of the stage this milestone belongs to, e.g. Your Story; display text owned by this table. Plain text, not an enum or a domain: its closed set is these rows (no runtime role can write here), and a copy edit is an UPDATE, not a type change.';
COMMENT ON COLUMN milestone.self_assertable IS 'Whether a participant may record the milestone themselves (a CTA) or only the job (a system fact).';
-- mwf_app: reference data (P3 §1.1 pattern), read only.
GRANT SELECT ON milestone TO app_access;
-- mwf_definer: reach_milestone refuses a self-assertable key (the participant's own, through mwf_app's INSERT), and
-- a participant-scoped key for anyone but the caller (scope; work-k5fk.32 S2).
GRANT SELECT (key, self_assertable, scope) ON milestone TO mwf_definer;
-- mwf_ops (work-k5fk.9, least privilege): exactly the columns the Neural Monitor reads (routes/brain.ts, the stage
-- shim), never a ciphertext or envelope column — stages (v_current_stage, stage-shim loadCurrentStages).
GRANT SELECT (key, ordinal, stage_label) ON milestone TO ops_access;

-- The seed (work-k5fk.6; was generated from gen/maps.ts MILESTONES). Keys are
-- shared/src/dto/milestones.ts MILESTONE_KEYS in ordinal order, and the
-- self_assertable rows are milestone-writer.ts SELF_ASSERTABLE_MILESTONES
-- (milestone-keys.test.ts pins both). ordinal = stage * 100 + position, in
-- today's stage order; stage_label = shared/src/enums.ts STAGE_FRIENDLY_NAMES.
-- scope 'session': written for every participant only once it holds for the
-- whole session (v_session_readiness). Step 20 asserts 13 rows.
INSERT INTO milestone (key, ordinal, stage_label, scope, self_assertable) VALUES
  ('paused', 0, 'Paused', 'participant', false),                                       -- the session is paused (sessions.ts): off the journey, v_current_stage ignores it, and resume deletes it (job)
  ('invitation_sent', 10, 'Getting Started', 'participant', false),                    -- the inviter's invitation went out (job)
  ('compact_signed', 20, 'Getting Started', 'session', true),                          -- the participant signed the compact (CTA), the session waits for everyone's
  ('feel_heard', 110, 'Your Story', 'participant', true),                              -- Stage 1: the participant confirms they feel heard (CTA)
  ('empathy_submitted', 210, 'Walking in Their Shoes', 'participant', false),          -- Stage 2: the participant submitted their empathy attempt (job)
  ('empathy_ready', 220, 'Walking in Their Shoes', 'participant', false),              -- Stage 2: that attempt is ready to reveal (job, reconciler)
  ('empathy_validated', 230, 'Walking in Their Shoes', 'session', false),              -- Stage 2: the empathy in both directions is validated (job)
  ('needs_confirmed', 310, 'What Matters Most', 'participant', true),                  -- Stage 3: the participant confirmed their needs (CTA)
  ('needs_validated', 320, 'What Matters Most', 'session', false),                     -- Stage 3: the shared needs are validated (job)
  ('needs_shared', 330, 'What Matters Most', 'session', false),                        -- Stage 3: everyone has shared their needs (job), not "I shared"
  ('repair_walkthrough_started', 410, 'What Comes Next', 'participant', false),        -- Stage 4: the participant began the need walkthrough (job)
  ('choices_shared', 420, 'What Comes Next', 'session', true),                         -- Stage 4: the participant shared their proposal choices (CTA), partners see choices from here
  ('closed', 430, 'What Comes Next', 'session', false);                                -- Stage 4: the session closed, with or without a shared agreement (job)

CREATE TABLE participant_milestone (
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    milestone_key milestone_key NOT NULL REFERENCES milestone ON DELETE RESTRICT,
    reached_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (session_id, user_id, milestone_key),
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON participant_milestone (milestone_key, reached_at);
COMMENT ON TABLE participant_milestone IS 'Event: a participant reached a milestone at reached_at. Append-only; current stage and readiness are derived from these rows (v_current_stage, v_session_readiness).';
COMMENT ON COLUMN participant_milestone.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN participant_milestone.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
-- mwf_app: the caller reaches the self-assertable keys (milestone-writer reachMilestone: compact_signed, feel_heard,
-- needs_confirmed, choices_shared; the key check is RLS's, step 9); every other key, and un-reaching, is the job's.
GRANT SELECT ON participant_milestone TO app_access;
GRANT INSERT (session_id, user_id, milestone_key, reached_at) ON participant_milestone TO app_access;
-- Holds only because reachMilestone is raw SQL (INSERT … ON CONFLICT DO NOTHING naming these three
-- columns): a Prisma create would also send created_at.
-- mwf_definer: anonymize_user_in_session step 3: unshared choices (choices_shared milestone), INDIVIDUAL check-ins;
-- reach_milestone (milestone-writer reachMilestone: the system keys — invitation_sent, empathy_*, needs_shared, closed,
-- paused …), session_resume (un-reaching `paused`, spec §1.1) and choices_unshare (stage4-store unshareChoices)
GRANT SELECT (session_id, user_id, milestone_key) ON participant_milestone TO mwf_definer;
GRANT INSERT (session_id, user_id, milestone_key, reached_at) ON participant_milestone TO mwf_definer;
GRANT DELETE ON participant_milestone TO mwf_definer;
-- mwf_ai: analysis.ts milestonesOf: when each milestone was reached — the stage each chat row was written in
GRANT SELECT (session_id, user_id, milestone_key, reached_at) ON participant_milestone TO ai_access;
-- mwf_worker: stage4-closure closureInputsAsJob: who has shared their choices (choices_shared)
GRANT SELECT (session_id, user_id, milestone_key) ON participant_milestone TO worker_access;
-- mwf_ops (work-k5fk.9, least privilege): exactly the columns the Neural Monitor reads (routes/brain.ts, the stage
-- shim), never a ciphertext or envelope column — stages (v_current_stage, stage-shim loadMilestones).
GRANT SELECT (session_id, user_id, milestone_key, reached_at) ON participant_milestone TO ops_access;

CREATE TABLE ai_memory (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    kind ai_memory_kind NOT NULL,
    doc ai_memory_json_schema NOT NULL,
    doc_schema_version schema_version NOT NULL DEFAULT 1,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.3: SUMMARY and NOTABLE_FACTS are a participant's (session_id, user_id); GLOBAL_FACTS is the user's
    -- (session_id NULL: MATCH SIMPLE skips the participant FK, the user FK still holds). One document per (user,
    -- session, kind): sql_ai_memory_one_per_participant and sql_ai_memory_one_global (sql-only.sql).
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    CHECK ((kind = 'GLOBAL_FACTS') = (session_id IS NULL)),
    -- doc is an object (ai_memory_json_schema); the keys depend on kind, which a domain cannot see
    CHECK (
        CASE kind WHEN 'SUMMARY' THEN doc ?& ARRAY['text', 'messageCount', 'generatedAt']
                  ELSE jsonb_typeof(doc -> 'facts') = 'array' END)
);
COMMENT ON TABLE ai_memory IS 'The AI''s working memory as documents: a participant''s rolling SUMMARY and NOTABLE_FACTS in one session, and a user''s GLOBAL_FACTS across sessions.';
COMMENT ON COLUMN ai_memory.kind IS 'SUMMARY and NOTABLE_FACTS are a participant''s (session_id set); GLOBAL_FACTS is the user''s across sessions (session_id NULL).';
COMMENT ON COLUMN ai_memory.session_id IS 'The session of a participant''s document (with user_id, a participant: FK to participant (session_id, user_id)); NULL for GLOBAL_FACTS.';
COMMENT ON COLUMN ai_memory.doc IS 'encrypted (per-row): jsonb with every string leaf encrypted (participant key for SUMMARY / NOTABLE_FACTS, user key for GLOBAL_FACTS); the key-presence CHECKs see the plaintext structure, and the t_doc_schema trigger validates it against app.json_schema ai_memory.<kind>.';
COMMENT ON COLUMN ai_memory.doc_schema_version IS 'The version of the app.json_schema ai_memory.<kind> document doc conforms to (validated by the t_doc_schema trigger; an unknown version is refused).';
-- mwf_app: read the session summary / facts for prompts; FINDING: global-memory.ts writes the user's GLOBAL_FACTS document
-- on the request path (spec: ai_memory is the AI's).
GRANT SELECT ON ai_memory TO app_access;
-- (doc_schema_version: the Prisma upsert's create sends its @default.)
GRANT INSERT (user_id, kind, doc, doc_schema_version, created_at, updated_at) ON ai_memory TO app_access;
GRANT UPDATE (doc, updated_at) ON ai_memory TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (session_id, user_id) ON ai_memory TO mwf_definer;
GRANT DELETE ON ai_memory TO mwf_definer;
-- mwf_ai: conversation-summarizer updateSessionSummary and partner-session-classifier: the participant's SUMMARY /
-- NOTABLE_FACTS document (INSERT … ON CONFLICT DO UPDATE, whose arbiter reads session_id, user_id, kind)
GRANT INSERT (session_id, user_id, kind, doc) ON ai_memory TO ai_access;
GRANT UPDATE (doc) ON ai_memory TO ai_access;
-- mwf_ai: analysis.ts loadSubjectFacts: the subject's NOTABLE_FACTS document (id because a Prisma model read always
-- selects the primary key — measured: denied without it)
GRANT SELECT (id, session_id, user_id, kind, doc) ON ai_memory TO ai_access;
-- mwf_ops: nothing (owner decision, work-k5fk.9 follow-up): the Neural Monitor no longer shows a participant's notable
-- facts or summary — its memory is theirs, not the operator's.

CREATE TABLE mood_reading (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    intensity intensity NOT NULL,
    context ciphertext,
    recorded_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON mood_reading (session_id, user_id, recorded_at);
COMMENT ON TABLE mood_reading IS 'A participant''s barometer reading (1-10) with optional context. Append-only time series.';
COMMENT ON COLUMN mood_reading.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN mood_reading.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN mood_reading.context IS 'encrypted (participant): the participant''s optional note on the reading (max 500).';
-- mwf_app: the caller's own mood check-ins (controllers/emotions.ts, user-settings.ts).
GRANT SELECT ON mood_reading TO app_access;
GRANT INSERT (session_id, user_id, intensity, context, recorded_at, created_at) ON mood_reading TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (session_id, user_id) ON mood_reading TO mwf_definer;
-- mwf_definer: participant_presence (v_participant: the caller's own latest mood — never a co-participant's, review F2)
GRANT SELECT (id, intensity, recorded_at) ON mood_reading TO mwf_definer;
GRANT DELETE ON mood_reading TO mwf_definer;
-- mwf_ops (work-k5fk.9, least privilege): exactly the columns the Neural Monitor reads (routes/brain.ts, the stage
-- shim), never a ciphertext or envelope column — the context route's latest intensity (memory intent).
GRANT SELECT (id, session_id, user_id, intensity, recorded_at) ON mood_reading TO ops_access;

CREATE TABLE regulation_event (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    type regulation_type NOT NULL,
    intensity_before intensity,
    intensity_after intensity,
    completed_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON regulation_event (session_id, user_id, completed_at);
COMMENT ON TABLE regulation_event IS 'A completed emotional-regulation exercise, with the intensity before and after. Append-only.';
COMMENT ON COLUMN regulation_event.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN regulation_event.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
-- mwf_app: the caller's own completed regulation exercise (controllers/emotions.ts).
GRANT SELECT ON regulation_event TO app_access;
GRANT INSERT (session_id, user_id, type, intensity_before, intensity_after, completed_at, created_at)
  ON regulation_event TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (session_id, user_id) ON regulation_event TO mwf_definer;
GRANT DELETE ON regulation_event TO mwf_definer;

CREATE TABLE invitation (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    invited_by_user_id uuid7 NOT NULL,
    accepted_by_user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    claimed_by_user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    invitee_name ciphertext,
    status invitation_status NOT NULL DEFAULT 'PENDING',
    message_confirmed_at ts_ms,
    expires_at ts_ms NOT NULL,
    accepted_at ts_ms,
    declined_at ts_ms,
    decline_reason ciphertext,
    claimed_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.1 invitation [P14a, P14b] — P3 §6
    CHECK (
      status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)),
    -- work-k5fk.10.8 (owner decision 2026-11-23, first opener claims): a claim names who and when, never the
    -- inviter; whoever accepts is the claimer.
    CHECK ((claimed_by_user_id IS NULL) = (claimed_at IS NULL)),
    CHECK (claimed_by_user_id <> invited_by_user_id),
    CHECK (accepted_by_user_id IS NULL OR accepted_by_user_id = claimed_by_user_id),
    -- work-k5fk.3: the inviter is a participant of the invitation's session; drafts pin to (id, session_id)
    UNIQUE (id, session_id),
    -- work-k5fk.9 (C11): what an EMPATHY draft written before the partner joins pins to (its owner is the inviter)
    UNIQUE (id, session_id, invited_by_user_id),
    FOREIGN KEY (session_id, invited_by_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON invitation (session_id);
CREATE INDEX ON invitation (session_id, invited_by_user_id);
CREATE INDEX ON invitation (status, expires_at);
CREATE INDEX ON invitation (accepted_by_user_id);
CREATE INDEX ON invitation (claimed_by_user_id);
COMMENT ON TABLE invitation IS 'An invitation from a participant to someone not yet in the session; accepting it creates the invitee''s participant.';
COMMENT ON COLUMN invitation.invited_by_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, invited_by_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN invitation.accepted_by_user_id IS 'The user who accepted; set with accepted_at. Always the claimer (claimed_by_user_id).';
COMMENT ON COLUMN invitation.claimed_by_user_id IS 'The invitee: the first signed-in user other than the inviter to open the invitation (app.invitation_claim, or the answer itself); set with claimed_at, once. Only they read its details, accept or decline it (work-k5fk.10.8).';
COMMENT ON COLUMN invitation.claimed_at IS 'When claimed_by_user_id opened the invitation and claimed it (work-k5fk.10.8).';
COMMENT ON CONSTRAINT invitation_check1 ON invitation IS 'A claim names who and when, together (work-k5fk.10.8).';
COMMENT ON CONSTRAINT invitation_check2 ON invitation IS 'The inviter never claims their own invitation (work-k5fk.10.8).';
COMMENT ON CONSTRAINT invitation_check3 ON invitation IS 'Whoever accepts is the claimer: only the first opener can become the invitee (work-k5fk.10.8).';
COMMENT ON COLUMN invitation.message_confirmed_at IS 'When the inviter confirmed the invitation message.';
COMMENT ON COLUMN invitation.invitee_name IS 'encrypted (session): the name the inviter gave the person they invite, typed at session creation (or their nickname / last display name for a known person), because the invitee has no user row yet. Not a copy of user.name; the AI uses it for the partner until they join.';
COMMENT ON COLUMN invitation.decline_reason IS 'encrypted (session): the invitee''s optional reason for declining, free text.';
-- mwf_app: the inviter creates it and confirms its message (and locks it FOR SHARE for a pre-join draft save, which
-- needs an UPDATE grant). The INVITEE's accept / decline / expire is app.invitation_answer, its pre-membership read
-- app.invitation_peek (work-k5fk.10.7: the inviter's row, written by the invitee, is a definer's job).
GRANT SELECT ON invitation TO app_access;
GRANT INSERT (session_id, invited_by_user_id, invitee_name, status, expires_at, created_at, updated_at)
  ON invitation TO app_access;
GRANT UPDATE (message_confirmed_at, updated_at) ON invitation TO app_access;
-- mwf_definer: session_abandon_declined (invitations.ts declineInvitation: the decliner is no participant, so the
-- declined invitation is what lets the session end); invitation_peek, invitation_claim, invitation_answer,
-- session_invitee_access
GRANT SELECT (id, session_id, invited_by_user_id, status, accepted_by_user_id, claimed_by_user_id, claimed_at,
              invitee_name, message_confirmed_at, expires_at, created_at) ON invitation TO mwf_definer;
GRANT UPDATE (status, accepted_by_user_id, accepted_at, declined_at, decline_reason, claimed_by_user_id, claimed_at)
  ON invitation TO mwf_definer;
-- mwf_ops: the Neural Monitor dashboard (routes/brain.ts, directly or through the stage shim) reads it.
GRANT SELECT (session_id, invited_by_user_id) ON invitation TO ops_access;

CREATE TABLE draft (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    kind draft_kind NOT NULL,
    about_user_id uuid7,
    attempt_id uuid7 REFERENCES empathy_attempt ON DELETE CASCADE,
    share_offer_id uuid7 REFERENCES context_share_offer ON DELETE CASCADE,
    invitation_id uuid7 REFERENCES invitation ON DELETE CASCADE,
    content ciphertext NOT NULL,
    ready_to_share boolean NOT NULL DEFAULT false,
    version ordinal_no NOT NULL DEFAULT 1,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reopened_at ts_ms,

    -- §1.1 draft — exclusive arc, and the arm matches the kind. An EMPATHY
    -- draft is about the partner's participant, or — written before the
    -- partner has joined — about the pending invitation; accepting the
    -- invitation re-points it to the new participant (work-99k2).
    CHECK (num_nonnulls(about_user_id, invitation_id, attempt_id, share_offer_id) = 1),
    CHECK (
            (kind = 'EMPATHY') = (about_user_id IS NOT NULL OR invitation_id IS NOT NULL)
        AND (kind = 'VALIDATION_FEEDBACK') = (attempt_id IS NOT NULL)
        AND (kind = 'SHARE_CONTEXT') = (share_offer_id IS NOT NULL)),
    -- work-9309: reopened_at marks an EMPATHY draft the author chose to "Edit
    -- first" after the partner joined, until the next draft write (the AI's
    -- proposal or the author's save) clears it.
    CHECK (reopened_at IS NULL OR kind = 'EMPATHY'),
    -- work-k5fk.3: owner, about, attempt, share offer and invitation are all of the draft's one session.
    -- work-k5fk.9 (C11): and the owner is the arc's party: the subject of the attempt their feedback answers, the
    -- subject of the offer they share on, the inviter of the invitation they write about; never about themselves.
    CHECK (about_user_id <> user_id),
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, about_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (attempt_id, session_id, user_id) REFERENCES empathy_attempt (id, session_id, subject_user_id) ON DELETE CASCADE,
    FOREIGN KEY (share_offer_id, session_id, user_id) REFERENCES context_share_offer (id, session_id, subject_user_id)
      ON DELETE CASCADE,
    FOREIGN KEY (invitation_id, session_id, user_id) REFERENCES invitation (id, session_id, invited_by_user_id)
      ON DELETE CASCADE
);
CREATE INDEX ON draft (session_id, about_user_id);
CREATE INDEX ON draft (attempt_id);
CREATE INDEX ON draft (share_offer_id);
CREATE INDEX ON draft (invitation_id);
-- + sql_draft_one_per_point (sql-only.sql)
COMMENT ON TABLE draft IS 'A participant''s working text for one sharing point (empathy statement, validation feedback, shared context) before any consent.';
COMMENT ON CONSTRAINT draft_check3 ON draft IS 'Nobody writes an EMPATHY draft about themselves (work-k5fk.9, C11).';
COMMENT ON COLUMN draft.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN draft.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN draft.about_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, about_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN draft.attempt_id IS 'VALIDATION_FEEDBACK: the attempt being reviewed.';
COMMENT ON COLUMN draft.share_offer_id IS 'SHARE_CONTEXT: the offer being edited.';
COMMENT ON COLUMN draft.invitation_id IS 'EMPATHY before the subject has joined: the pending invitation that will become them; re-pointed to about_user_id at accept.';
COMMENT ON COLUMN draft.reopened_at IS 'Set when the author chose Edit first on a pre-join draft after the join; cleared by the next draft write (work-9309).';
COMMENT ON COLUMN draft.content IS 'encrypted (participant): the draft text, AI-proposed or written by the participant.';
-- mwf_app: the caller's drafts (empathy-store upsertDraft, reconciler/sharing.ts, empathy-draft-save reopen, delete).
-- No id, created_at or updated_at: the accept's move of the INVITER's pre-join drafts to the invitee (same id,
-- timestamps) is app.invitation_repoint_drafts (work-k5fk.10.7; was the invitee's request writing the inviter's rows).
GRANT SELECT ON draft TO app_access;
GRANT INSERT (session_id, user_id, kind, about_user_id, invitation_id, attempt_id, share_offer_id, content,
              ready_to_share, version, reopened_at) ON draft TO app_access;
GRANT UPDATE (content, ready_to_share, version, reopened_at) ON draft TO app_access;
-- UPDATE holds without updated_at only because every draft update is raw SQL (upsertDraft's
-- ON CONFLICT DO UPDATE, the reopen stamp; touch_updated_at sets it): a Prisma update would send it.
GRANT DELETE ON draft TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads;
-- invitation_repoint_drafts: the whole row, moved with its id and timestamps (work-k5fk.10.7)
GRANT SELECT ON draft TO mwf_definer;
GRANT DELETE ON draft TO mwf_definer;
GRANT INSERT (id, session_id, user_id, kind, about_user_id, content, ready_to_share, version, created_at, updated_at,
              reopened_at) ON draft TO mwf_definer;

CREATE TABLE session_key (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    key_id kek_id NOT NULL,
    wrapped_dek wrapped_dek NOT NULL,
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
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    key_id kek_id NOT NULL,
    wrapped_dek wrapped_dek NOT NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    destroyed_at ts_ms,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON participant_key (session_id, user_id);
-- + sql_participant_key_live (sql-only.sql)
COMMENT ON TABLE participant_key IS 'Envelope-encryption key per participant (P3 D5, W13): the participant''s data key wrapped by a KMS key; destroyed_at shreds it. Designed for W13: nothing writes a key row yet; account deletion already sets destroyed_at.';
COMMENT ON COLUMN participant_key.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN participant_key.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN participant_key.key_id IS 'The id of the KMS key (the KEK) that wrapped this row''s DEK: the same <keyId> the planned enc:v2:<keyId>:... envelope prefix will carry (P3 8.6). No format is fixed yet; nothing writes these tables before W13.';
COMMENT ON COLUMN participant_key.wrapped_dek IS 'The AES-256 data key (DEK) for this owner''s encrypted columns, encrypted (wrapped) by the KMS key named in key_id. Never stored unwrapped.';
COMMENT ON COLUMN participant_key.destroyed_at IS 'The crypto-shred: once set, the wrapped DEK is never unwrapped again, so every value under it is unreadable.';
-- mwf_app: none. Key material is never the request path's (work-k5fk.10.2; target-roles negative test).
-- mwf_definer: anonymize step 7: the crypto-shred
GRANT SELECT (session_id, user_id, destroyed_at) ON participant_key TO mwf_definer;
GRANT UPDATE (destroyed_at) ON participant_key TO mwf_definer;

CREATE TABLE empathy_review (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    attempt_id uuid7 NOT NULL REFERENCES empathy_attempt ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    reviewer_user_id uuid7 NOT NULL,
    validated boolean NOT NULL,
    feedback ciphertext,
    feedback_sent_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- one review per attempt: its subject's (the FK below pins the reviewer to the attempt's subject); the exact
    -- columns of that FK, so Prisma models the 1:1 it implies
    UNIQUE (attempt_id, session_id, reviewer_user_id),
    -- §1.2 empathy_review
    CHECK (feedback IS NULL OR feedback_sent_at IS NOT NULL),
    -- work-k5fk.3: the reviewer is the attempt's subject, by key (retires t_review_subject); consents pin to (id, session_id)
    UNIQUE (id, session_id),
    FOREIGN KEY (attempt_id, session_id, reviewer_user_id) REFERENCES empathy_attempt (id, session_id, subject_user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, reviewer_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON empathy_review (session_id, reviewer_user_id);
COMMENT ON TABLE empathy_review IS 'The subject''s verdict on an attempt revealed to them (validated or not), with the feedback they chose to send.';
COMMENT ON COLUMN empathy_review.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN empathy_review.reviewer_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, reviewer_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN empathy_review.feedback_sent_at IS 'When the reviewer explicitly sent the feedback; feedback is set only with it.';
COMMENT ON COLUMN empathy_review.feedback IS 'encrypted (session): the subject''s feedback on the attempt, sent explicitly (max 500).';
-- mwf_app: the reviewer's own review of the partner's attempt (empathy-store recordReview).
GRANT SELECT ON empathy_review TO app_access;
GRANT INSERT (attempt_id, session_id, reviewer_user_id, validated, feedback, feedback_sent_at, created_at, updated_at) ON empathy_review TO app_access;
GRANT UPDATE (validated, feedback, feedback_sent_at, updated_at) ON empathy_review TO app_access;
-- mwf_definer: T-consent-owner (owner of a proposal / share offer / review target), fired by need_revoke_share
GRANT SELECT (id, session_id, reviewer_user_id) ON empathy_review TO mwf_definer;
-- mwf_definer: validated_at (when the author's attempt was first validated — nothing else of the review)
GRANT SELECT (attempt_id, validated, created_at) ON empathy_review TO mwf_definer;

CREATE TABLE reconciler_guidance (
    result_id uuid7 NOT NULL PRIMARY KEY REFERENCES reconciler_result ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    author_user_id uuid7 NOT NULL,
    subject_user_id uuid7 NOT NULL,
    area_hint guidance_area,
    guidance_type guidance_type,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.3: the subject is the result's (so the attempt's) subject; work-k5fk.9 (C9): and the author is the
    -- result's (so the attempt's) author — the author's RLS (app_select) reads the row, so a guidance naming anyone
    -- else would leak the hint to a third party in an N-party session.
    -- Prisma models an FK whose columns hold a unique column as 1:1 and then needs those exact columns UNIQUE (P1012)
    UNIQUE (result_id, session_id, author_user_id, subject_user_id),
    FOREIGN KEY (result_id, session_id, author_user_id, subject_user_id)
      REFERENCES reconciler_result (id, session_id, author_user_id, subject_user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, author_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, subject_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON reconciler_guidance (session_id, author_user_id);
CREATE INDEX ON reconciler_guidance (session_id, subject_user_id);
COMMENT ON TABLE reconciler_guidance IS 'The abstract hints from a reconciler result that the author may see (P3 D8a split from reconciler_result, which only the subject sees).';
COMMENT ON COLUMN reconciler_guidance.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN reconciler_guidance.author_user_id IS 'The result''s attempt''s author (work-k5fk.9, C9): (result_id, session_id, author_user_id, subject_user_id) references reconciler_result; the author''s policy reads the row.';
COMMENT ON COLUMN reconciler_guidance.subject_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, subject_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN reconciler_guidance.area_hint IS 'A coarse area for the author to explore (guidance_area; work-k5fk.9, Q4). The refinement prompt''s seed phrase is not stored: it is a function of guidance_type (reconciler/guidance-phrases.ts).';
-- mwf_app: read only (the author's abstract hints); written by the job.
GRANT SELECT ON reconciler_guidance TO app_access;
-- mwf_ai: persistAnalysis: the author-visible abstract hints of a result (P3 D8a split)
GRANT INSERT (result_id, session_id, author_user_id, subject_user_id, area_hint, guidance_type)
  ON reconciler_guidance TO ai_access;
-- mwf_ai: analysis.ts guidanceFor: the guidance of a cached result
GRANT SELECT (result_id, area_hint, guidance_type) ON reconciler_guidance TO ai_access;

CREATE TABLE consent (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    requested_by_user_id uuid7,
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
    CONSTRAINT chk_consent_requester CHECK (requested_by_user_id IS NULL OR target_kind IN ('NEED', 'PROPOSAL', 'EMPATHY_ATTEMPT')),
    -- work-k5fk.3: decider, requester and the arc's target are all of the consent's one session
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, requested_by_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (need_id, session_id) REFERENCES need (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (empathy_attempt_id, session_id) REFERENCES empathy_attempt (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (proposal_id, session_id) REFERENCES proposal (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (share_offer_id, session_id) REFERENCES context_share_offer (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (review_id, session_id) REFERENCES empathy_review (id, session_id) ON DELETE CASCADE
);
CREATE INDEX ON consent (session_id, requested_by_user_id);
CREATE INDEX ON consent (need_id);
CREATE INDEX ON consent (empathy_attempt_id);
CREATE INDEX ON consent (proposal_id);
CREATE INDEX ON consent (share_offer_id);
CREATE INDEX ON consent (review_id);
CREATE INDEX ON consent (session_id, user_id, decided_at);
COMMENT ON TABLE consent IS 'One explicit decision by a participant to let something cross the boundary to the other participant; exactly one target arc.';
COMMENT ON COLUMN consent.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN consent.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN consent.requested_by_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, requested_by_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN consent.target_kind IS 'Generated from which arc column is set.';
-- mwf_app: the caller's own decisions — on their attempt, a review, a share offer, a need — and their revocation.
GRANT SELECT ON consent TO app_access;
GRANT INSERT (session_id, user_id, requested_by_user_id, empathy_attempt_id, need_id, share_offer_id, review_id,
              decision, decided_at, created_at, updated_at) ON consent TO app_access;
GRANT UPDATE (decision, decided_at, revoked_at, updated_at) ON consent TO app_access;
-- mwf_definer: need_share (the owner's GRANTED consent), need_revoke_share (→ REVOKED)
GRANT SELECT (need_id, session_id, user_id, decision) ON consent TO mwf_definer;
GRANT UPDATE (decision, revoked_at) ON consent TO mwf_definer;

CREATE TABLE need_share (
    need_id uuid7 NOT NULL PRIMARY KEY REFERENCES need ON DELETE RESTRICT,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    user_id uuid7 NOT NULL,
    category need_category NOT NULL,
    shared_text ciphertext NOT NULL,
    shared_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 need_share [P20c]
    CHECK (revoked_at IS NULL OR revoked_at >= shared_at),
    -- work-k5fk.3: a share carries its need owner's participant and session, by key (retires t_need_share_owner);
    -- proposal_need and need_disposition pin to (need_id, session_id)
    UNIQUE (need_id, session_id),
    -- Prisma models an FK whose columns hold a unique column as 1:1 and then needs those exact columns UNIQUE (P1012)
    UNIQUE (need_id, session_id, user_id),
    FOREIGN KEY (need_id, session_id, user_id) REFERENCES need (id, session_id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON need_share (session_id, revoked_at);
CREATE INDEX ON need_share (session_id, user_id);
COMMENT ON TABLE need_share IS 'The consented, transformed version of a need that co-participants may see. Reads of a partner''s needs touch this table only, never need.';
COMMENT ON COLUMN need_share.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN need_share.session_id IS 'The owner''s session, copied by app.need_share for the membership read arm; trigger-checked.';
COMMENT ON COLUMN need_share.category IS 'The need''s category, copied at share time: the partner sees the category, never need.label.';
COMMENT ON COLUMN need_share.shared_text IS 'encrypted (session): the heat-removed sentence the partner sees (one short first-person sentence written by the job, or a fixed per-category fallback).';
-- mwf_app: read only (v_need_shared and the tending reads); app.need_share / app.need_revoke_share are the writers.
GRANT SELECT ON need_share TO app_access;
-- mwf_definer: need_share (the only writer), need_revoke_share, anonymize step 3 (shared needs survive)
GRANT SELECT (need_id, revoked_at) ON need_share TO mwf_definer;
GRANT INSERT (need_id, session_id, user_id, category, shared_text) ON need_share TO mwf_definer;
GRANT UPDATE (revoked_at) ON need_share TO mwf_definer;

CREATE TABLE need_disposition (
    need_id uuid7 NOT NULL REFERENCES need_share ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    status need_disposition_status NOT NULL DEFAULT 'OPEN',
    is_current boolean NOT NULL DEFAULT false,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (session_id, user_id, need_id),
    -- work-k5fk.3: a disposition is a participant's, of a need shared in that participant's session
    FOREIGN KEY (need_id, session_id) REFERENCES need_share (need_id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON need_disposition (need_id);
-- + sql_disposition_one_current (sql-only.sql)
COMMENT ON TABLE need_disposition IS 'How a participant dispositions a shared need during the Stage-4 walkthrough (their own or the other''s); one current need per walkthrough.';
COMMENT ON COLUMN need_disposition.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN need_disposition.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN need_disposition.is_current IS 'The need the walkthrough is on (at most one per participant).';
-- mwf_app: the caller's Stage 4 walkthrough dispositions (stage4-walkthrough.ts), including un-declining (DELETE).
GRANT SELECT ON need_disposition TO app_access;
GRANT INSERT (session_id, user_id, need_id, status, is_current, created_at, updated_at) ON need_disposition TO app_access;
GRANT UPDATE (status, is_current, updated_at) ON need_disposition TO app_access;
GRANT DELETE ON need_disposition TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (session_id, user_id) ON need_disposition TO mwf_definer;
GRANT DELETE ON need_disposition TO mwf_definer;

CREATE TABLE proposal_need (
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    need_id uuid7 NOT NULL REFERENCES need_share ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (proposal_id, need_id),
    -- work-k5fk.3: a proposal addresses only a need shared in its own session
    FOREIGN KEY (proposal_id, session_id) REFERENCES proposal (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (need_id, session_id) REFERENCES need_share (need_id, session_id) ON DELETE CASCADE
);
CREATE INDEX ON proposal_need (need_id);
COMMENT ON TABLE proposal_need IS 'Which shared needs a proposal addresses.';
COMMENT ON COLUMN proposal_need.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
-- mwf_app: setProposalNeeds re-points a proposal's needs (stage4-store.ts).
GRANT SELECT ON proposal_need TO app_access;
GRANT INSERT (proposal_id, need_id, session_id, created_at) ON proposal_need TO app_access;
GRANT DELETE ON proposal_need TO app_access;

CREATE TABLE proposal_choice (
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    decision choice_decision NOT NULL,
    note ciphertext,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (proposal_id, session_id, user_id),
    -- work-k5fk.3: a choice is by a participant of the proposal's session
    FOREIGN KEY (proposal_id, session_id) REFERENCES proposal (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON proposal_choice (session_id, user_id);
COMMENT ON TABLE proposal_choice IS 'A participant''s willingness on a proposal; private until the choices_shared milestone.';
COMMENT ON COLUMN proposal_choice.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN proposal_choice.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN proposal_choice.note IS 'encrypted (session): the participant''s note on their choice (route max 1000), or their chat message when the choice was inferred.';
-- mwf_app: the caller's own choice (stage4-store upsertChoice). created_at in UPDATE: upsertChoice's
-- ON CONFLICT DO UPDATE re-stamps it.
GRANT SELECT ON proposal_choice TO app_access;
GRANT INSERT (proposal_id, session_id, user_id, decision, note, created_at, updated_at) ON proposal_choice TO app_access;
GRANT UPDATE (decision, note, created_at) ON proposal_choice TO app_access;
-- No DELETE: withdrawChoice (stage4-store.ts) has no caller (review round 1, M4).
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (session_id, user_id) ON proposal_choice TO mwf_definer;
-- mwf_definer: t_agreement_parties (every party WILLING on the proposal)
GRANT SELECT (proposal_id, decision) ON proposal_choice TO mwf_definer;
GRANT DELETE ON proposal_choice TO mwf_definer;
-- mwf_worker: closureInputsAsJob / agreeIfEveryoneWilling (every present human WILLING) and T-agreement-parties
-- (deferred, invoker = the agreement's writer): every party WILLING on the proposal
GRANT SELECT (proposal_id, session_id, user_id, decision) ON proposal_choice TO worker_access;

CREATE TABLE proposal_revision (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    proposal_id uuid7 NOT NULL REFERENCES proposal ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    actor_user_id uuid7,
    action revision_action NOT NULL,
    before proposal_snapshot_json_schema,
    after proposal_snapshot_json_schema,
    reason proposal_revision_reason,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.4 proposal_revision [P23c]
    -- before / after: a well-formed envelope or keyless plaintext object (the proposal_snapshot_json_schema domain)
    -- work-k5fk.3: the actor is a participant of the proposal's session
    FOREIGN KEY (proposal_id, session_id) REFERENCES proposal (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, actor_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON proposal_revision (proposal_id, created_at);
CREATE INDEX ON proposal_revision (session_id, actor_user_id);
COMMENT ON TABLE proposal_revision IS 'Append-only audit of proposal changes, with before/after snapshots.';
COMMENT ON COLUMN proposal_revision.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN proposal_revision.actor_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, actor_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN proposal_revision.reason IS 'An app marker or NULL; never user or model text (R47).';
COMMENT ON COLUMN proposal_revision.before IS 'encrypted (session): jsonb envelope {"$enc": ...}: the proposal fields before the change.';
COMMENT ON COLUMN proposal_revision.after IS 'encrypted (session): jsonb envelope {"$enc": ...}: the proposal fields after the change, and any text explaining it. A CREATED revision of an INDIVIDUAL_COMMITMENT captured from chat carries capturedQuote, the sentence of its creator''s private chat — readable by its creator alone (proposal_revision app_select; work-k5fk.37).';
-- mwf_app: the audit row of a caller's edit (controllers/stage4.ts, stage4-capture, stage4-subchat). Append-only.
GRANT SELECT ON proposal_revision TO app_access;
GRANT INSERT (proposal_id, session_id, actor_user_id, action, before, after, reason, created_at)
  ON proposal_revision TO app_access;
-- mwf_worker: stage4-store insertAgreementsTx: the conversion's audit row (append-only; no message id, lineage in before/after)
GRANT INSERT (proposal_id, session_id, actor_user_id, action, before, after, reason) ON proposal_revision TO worker_access;

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
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.3: agreement.session_id is its proposal's (type review Q8: no longer an unguarded copy); parties pin to (id, session_id)
    UNIQUE (id, session_id),
    -- Prisma models an FK whose columns hold a unique column as 1:1 and then needs those exact columns UNIQUE (P1012)
    UNIQUE (proposal_id, session_id),
    FOREIGN KEY (proposal_id, session_id) REFERENCES proposal (id, session_id) ON DELETE RESTRICT
);
CREATE INDEX ON agreement (session_id, status);
COMMENT ON TABLE agreement IS 'A proposal every willing party accepted; at most one per proposal.';
COMMENT ON COLUMN agreement.session_id IS 'The proposal''s session, kept for the agreement''s own read policy and session queries.';
COMMENT ON COLUMN agreement.description IS 'encrypted (session): the proposal''s description, copied at conversion.';
COMMENT ON COLUMN agreement.duration IS 'encrypted (session): the proposal''s free-text duration, copied at conversion. NOT a true interval.';
COMMENT ON COLUMN agreement.measure_of_success IS 'encrypted (session): the proposal''s measure of success, copied at conversion.';
-- mwf_app: read only; agreements are created and moved by the job.
GRANT SELECT ON agreement TO app_access;
-- mwf_definer: t_agreement_parties (the agreement whose parties it checks)
GRANT SELECT (id, session_id, proposal_id, created_at) ON agreement TO mwf_definer;
-- mwf_worker: stage4-store createAgreementsAsJob / insertAgreementsTx: the agreement row (snapshot of the proposal) and its
-- id (RETURNING id)
GRANT INSERT (session_id, proposal_id, type, status, description, duration, measure_of_success, follow_up_at) ON agreement TO worker_access;
-- mwf_worker: RETURNING id; T-agreement-parties (invoker = mwf_worker) reads the agreement's session, proposal and instant;
-- tending: the agreement a follow-up is about (status moves)
GRANT SELECT (id, session_id, proposal_id, status, created_at) ON agreement TO worker_access;
-- mwf_worker: tending resolve/closure paths: an agreement moves AGREED → IN_PROGRESS → COMPLETED | ABANDONED
GRANT UPDATE (status, completed_at) ON agreement TO worker_access;

CREATE TABLE agreement_party (
    agreement_id uuid7 NOT NULL REFERENCES agreement ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    agreed_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (agreement_id, session_id, user_id),
    -- work-k5fk.3: a party is a participant of the agreement's session (the set itself is t_agreement_parties)
    FOREIGN KEY (agreement_id, session_id) REFERENCES agreement (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON agreement_party (session_id, user_id);
COMMENT ON TABLE agreement_party IS 'Who is party to an agreement.';
COMMENT ON COLUMN agreement_party.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN agreement_party.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
-- mwf_app: read only (an agreement's parties).
GRANT SELECT ON agreement_party TO app_access;
-- mwf_definer: t_agreement_parties (the parties)
GRANT SELECT (agreement_id, user_id) ON agreement_party TO mwf_definer;
-- mwf_worker: stage4-store insertAgreementsTx: one party row per present human
GRANT INSERT (agreement_id, session_id, user_id, agreed_at) ON agreement_party TO worker_access;
-- mwf_worker: T-agreement-parties (deferred, invoker = mwf_worker): the party set
GRANT SELECT (agreement_id, session_id, user_id) ON agreement_party TO worker_access;

CREATE TABLE session_closure (
    session_id uuid7 NOT NULL PRIMARY KEY REFERENCES session ON DELETE CASCADE,
    kind closure_kind NOT NULL,
    reason closure_reason NOT NULL,
    summary ciphertext NOT NULL,
    closed_by_user_id uuid7,
    check_in_at ts_ms,
    closed_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.3: whoever closed it is a participant of this session
    -- Prisma models an FK whose columns hold a unique column as 1:1 and then needs those exact columns UNIQUE (P1012)
    UNIQUE (session_id, closed_by_user_id),
    FOREIGN KEY (session_id, closed_by_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON session_closure (session_id, closed_by_user_id);
COMMENT ON TABLE session_closure IS 'How the repair stage of a session ended, one row per closed session.';
COMMENT ON COLUMN session_closure.closed_by_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, closed_by_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN session_closure.summary IS 'encrypted (session): how the repair stage ended, from the participant (max 2000) or a code template.';
-- mwf_app: read only; the closure is the job's.
GRANT SELECT ON session_closure TO app_access;
-- mwf_worker: stage4-store closeSessionAsJob / insertClosureTx: how the repair stage ended (the three id arrays are
-- v_session_closure_items)
GRANT INSERT (session_id, kind, reason, summary, closed_by_user_id, check_in_at, closed_at)
  ON session_closure TO worker_access;

CREATE TABLE follow_up (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL REFERENCES session ON DELETE CASCADE,
    agreement_id uuid7,
    proposal_id uuid7,
    type follow_up_type NOT NULL,
    scope follow_up_scope NOT NULL DEFAULT 'SHARED',
    owner_user_id uuid7,
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
    CHECK ((scope = 'INDIVIDUAL') = (owner_user_id IS NOT NULL)),
    CHECK (num_nonnulls(agreement_id, proposal_id) <= 1),
    -- work-k5fk.3: the owner is a participant of the follow-up's session; check-ins pin to (id, session_id)
    UNIQUE (id, session_id),
    FOREIGN KEY (session_id, owner_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    -- work-k5fk.9 (C4): the agreement or commitment checked on is of the follow-up's own session
    FOREIGN KEY (agreement_id, session_id) REFERENCES agreement (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (proposal_id, session_id) REFERENCES proposal (id, session_id) ON DELETE CASCADE
);
CREATE INDEX ON follow_up (session_id, status);
CREATE INDEX ON follow_up (agreement_id);
CREATE INDEX ON follow_up (proposal_id);
CREATE INDEX ON follow_up (session_id, owner_user_id);
-- + sql_follow_up_due (sql-only.sql)
COMMENT ON TABLE follow_up IS 'A scheduled or user-initiated check-in on an agreement or an individual commitment.';
COMMENT ON COLUMN follow_up.owner_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, owner_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN follow_up.proposal_id IS 'An individual commitment''s proposal, when there is no agreement.';
COMMENT ON COLUMN follow_up.response_deadline_at IS 'When an OPEN follow-up stops accepting check-ins.';
COMMENT ON COLUMN follow_up.summary IS 'encrypted (session): a code-templated line naming what is checked on, with the agreement or commitment text.';
-- mwf_app: the owner's share opt-in and a user-initiated re-entry (tending.service.ts); scheduling and cycle moves are the job's.
GRANT SELECT ON follow_up TO app_access;
GRANT INSERT (session_id, type, scope, owner_user_id, opted_in_shared, status, opened_at, summary, created_at, updated_at)
  ON follow_up TO app_access;
GRANT UPDATE (opted_in_shared, updated_at) ON follow_up TO app_access;
-- mwf_definer: anonymize_user_in_session step 3: unshared choices (choices_shared milestone), INDIVIDUAL check-ins
GRANT SELECT (id, scope) ON follow_up TO mwf_definer;
-- mwf_worker: tending insertFollowUpAsJob: SHARED agreements and INDIVIDUAL commitments scheduled at closure, and the
-- next round a check-in schedules (EXTEND / PARTIAL_CLOSURE continuing: a follow-up is one cycle) (RETURNING id)
GRANT INSERT (session_id, agreement_id, proposal_id, type, scope, owner_user_id, opted_in_shared, status, scheduled_for,
              response_deadline_at, summary) ON follow_up TO worker_access;
-- mwf_worker: open-due-tending-entries: find due SCHEDULED rows (sql_follow_up_due), whom to notify, the cycle columns it moves
GRANT SELECT (id, session_id, agreement_id, type, scope, owner_user_id, status, scheduled_for, response_deadline_at)
  ON follow_up TO worker_access;
-- mwf_worker: open-due / cycle resolution / a check-in's progress: SCHEDULED → OPEN (opened_at, the response deadline),
-- OPEN/PARTIAL → COMPLETED | EXPIRED
GRANT UPDATE (status, opened_at, completed_at, response_deadline_at) ON follow_up TO worker_access;

CREATE TABLE follow_up_checkin (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    follow_up_id uuid7 NOT NULL REFERENCES follow_up ON DELETE CASCADE,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    next_action next_action,
    continue_choice continue_choice,
    reflection_summary ciphertext,
    payload checkin_payload_json_schema NOT NULL DEFAULT '{}'::checkin_payload_json_schema,
    submitted_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (follow_up_id, session_id, user_id),
    -- work-k5fk.9 (C5): what follow_up_note's carried-into key pins to (a note goes into its owner's own check-in)
    UNIQUE (id, session_id, user_id),
    -- §1.5 follow_up_checkin: payload is a well-formed envelope or keyless plaintext object (checkin_payload_json_schema)
    -- work-k5fk.3: a check-in is by a participant of the follow-up's session
    FOREIGN KEY (follow_up_id, session_id) REFERENCES follow_up (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON follow_up_checkin (session_id, user_id, submitted_at);
COMMENT ON TABLE follow_up_checkin IS 'One participant''s answers to a follow-up, one per participant; the structured answers are a document (payload).';
COMMENT ON COLUMN follow_up_checkin.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN follow_up_checkin.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN follow_up_checkin.reflection_summary IS 'encrypted (session): the participant''s reflection at the check-in (max 4000).';
COMMENT ON COLUMN follow_up_checkin.payload IS 'encrypted (session): jsonb envelope {"$enc": ...}: the structured answers (FollowUpCheckinPayload).';
-- mwf_app: the caller's own check-in (tending insertCheckin). Append-only.
GRANT SELECT ON follow_up_checkin TO app_access;
GRANT INSERT (follow_up_id, session_id, user_id, next_action, continue_choice, reflection_summary, payload,
              submitted_at, created_at)
  ON follow_up_checkin TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (follow_up_id, session_id, user_id) ON follow_up_checkin TO mwf_definer;
GRANT DELETE ON follow_up_checkin TO mwf_definer;

CREATE TABLE follow_up_note (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 NOT NULL,
    user_id uuid7 NOT NULL,
    content ciphertext NOT NULL,
    carry_forward boolean NOT NULL DEFAULT false,
    carried_into_checkin_id uuid7,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    -- work-k5fk.9 (C5): a note is carried only into its owner's own check-in of the same session; deleting the
    -- check-in nulls the link alone (PG15 SET NULL (col); step 20 pins the column list)
    FOREIGN KEY (carried_into_checkin_id, session_id, user_id) REFERENCES follow_up_checkin (id, session_id, user_id)
      ON DELETE SET NULL (carried_into_checkin_id)
);
CREATE INDEX ON follow_up_note (session_id, user_id, created_at);
CREATE INDEX ON follow_up_note (carried_into_checkin_id);
COMMENT ON TABLE follow_up_note IS 'A private between-period note; it can be carried into a later check-in.';
COMMENT ON COLUMN follow_up_note.session_id IS 'The session of every participant the row names (work-k5fk.3): each participant reference and each parent it hangs off is keyed with it, so they are all of this one session.';
COMMENT ON COLUMN follow_up_note.user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN follow_up_note.carried_into_checkin_id IS 'The check-in this note was copied into (payload.carriedNotes).';
COMMENT ON COLUMN follow_up_note.content IS 'encrypted (participant): the note text (max 4000).';
-- mwf_app: the caller's between-period notes and their carry-forward into a check-in.
GRANT SELECT ON follow_up_note TO app_access;
GRANT INSERT (session_id, user_id, content, carry_forward, created_at, updated_at) ON follow_up_note TO app_access;
GRANT UPDATE (carry_forward, carried_into_checkin_id, updated_at) ON follow_up_note TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (session_id, user_id) ON follow_up_note TO mwf_definer;
GRANT DELETE ON follow_up_note TO mwf_definer;

CREATE TABLE reminder (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    follow_up_id uuid7,
    session_id uuid7,
    scope reminder_scope NOT NULL DEFAULT 'PRIVATE',
    remind_at ts_ms NOT NULL,
    cadence reminder_cadence,
    note ciphertext,
    status reminder_status NOT NULL DEFAULT 'SCHEDULED',
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.9 (C8; review F14): a reminder on a follow-up is its owner's, in that follow-up's session, for every
    -- role (the app_access RLS already says so for mwf_app). session_id is set exactly with follow_up_id: MATCH
    -- SIMPLE skips a key with a NULL in it, so the CHECK is what makes both keys hold.
    CHECK ((follow_up_id IS NULL) = (session_id IS NULL)),
    FOREIGN KEY (follow_up_id, session_id) REFERENCES follow_up (id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON reminder (user_id, remind_at);
CREATE INDEX ON reminder (session_id, user_id);
CREATE INDEX ON reminder (follow_up_id);
-- + sql_reminder_due (sql-only.sql)
COMMENT ON TABLE reminder IS 'A scheduled nudge for one user, optionally tied to a follow-up; the job delivers due ones.';
COMMENT ON COLUMN reminder.cadence IS 'How often the reminder repeats; NULL and ONCE are one-shot.';
COMMENT ON COLUMN reminder.session_id IS 'The session of the follow-up the reminder is on, NULL with follow_up_id (work-k5fk.9, C8): (follow_up_id, session_id) references follow_up and (session_id, user_id) participant, so the owner sits in that session.';
COMMENT ON CONSTRAINT reminder_check ON reminder IS 'session_id is set exactly when follow_up_id is (work-k5fk.9, C8).';
COMMENT ON INDEX reminder_session_id_user_id_idx IS 'The FK index of (session_id, user_id) (the participant cascade).';
COMMENT ON COLUMN reminder.note IS 'encrypted (user): the reminder''s note (max 1000); the app sends a fixed label today.';
-- mwf_app: the caller's own reminder at check-in; delivery and the next instant are the worker's. DELETE:
-- session-deletion.ts deleteSessionForUser — the leaver's own reminders on the session's follow-ups go with the leave
-- (the caller's rows: the request moved off mwf_job in work-k5fk.10.5; RLS, §7 rows 9d–9g, binds user_id).
GRANT SELECT ON reminder TO app_access;
GRANT INSERT (user_id, follow_up_id, session_id, scope, remind_at, cadence, note, status, created_at, updated_at)
  ON reminder TO app_access;
GRANT DELETE ON reminder TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (user_id) ON reminder TO mwf_definer;
GRANT DELETE ON reminder TO mwf_definer;
-- mwf_worker: processDueTendingReminders: due SCHEDULED reminders (sql_reminder_due) → DELIVERED, or the next remind_at
-- for a cadence; whom to notify (user_id)
GRANT SELECT (id, user_id, follow_up_id, scope, remind_at, cadence, status) ON reminder TO worker_access;
GRANT UPDATE (status, remind_at) ON reminder TO worker_access;

CREATE TABLE reflection (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    title ciphertext,
    theme text,
    status reflection_status NOT NULL DEFAULT 'ACTIVE',
    summary ciphertext,
    summary_doc reflection_summary_json_schema,
    linked_session_id uuid7,
    linked_at ts_ms,
    context_snapshot ciphertext,
    distilled_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.6 reflection, takeaway_link [P31]
    -- summary_doc: a well-formed envelope or keyless plaintext object (reflection_summary_json_schema)
    -- work-k5fk.9 (C6): the linked session is one the owner is a participant of, for every role (the app_access RLS
    -- WITH CHECK says so for mwf_app only); deleting the participant (the session cascade) nulls the link alone
    -- (PG15 SET NULL (col); step 20 pins the column list). An FK out of reflection, never into it.
    FOREIGN KEY (linked_session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE SET NULL (linked_session_id),
    -- review r1 F8: linked_at is the link's instant, so it is set exactly with linked_session_id; the writers set both,
    -- and t_reflection_unlink (trailer.sql) clears it when the FK's SET NULL (col) clears the link
    CHECK ((linked_session_id IS NULL) = (linked_at IS NULL))
);
CREATE INDEX ON reflection (user_id, updated_at);
CREATE INDEX ON reflection (linked_session_id);
CREATE INDEX ON reflection (user_id, theme);
COMMENT ON TABLE reflection IS 'A private Inner Work reflection thread, outside any session (user-scoped); optionally linked to a session.';
COMMENT ON COLUMN reflection.linked_session_id IS 'A session the reflection is about, for context only; it grants no visibility either way. One its owner is a participant of: (linked_session_id, user_id) references participant (session_id, user_id).';
COMMENT ON CONSTRAINT reflection_check ON reflection IS 'linked_at is set exactly when linked_session_id is: the instant of the link (review r1 F8).';
COMMENT ON COLUMN reflection.distilled_at IS 'When takeaways were last distilled from the thread.';
COMMENT ON COLUMN reflection.theme IS 'Free LLM text ("a single word or short phrase", e.g. anxiety), not a taxonomy; v_reflection_theme groups by the exact string.';
COMMENT ON COLUMN reflection.title IS 'encrypted (user): the reflection''s title, typed (max 200) or AI-generated (3-6 words).';
COMMENT ON COLUMN reflection.summary IS 'encrypted (user): a one-sentence AI summary of the reflection.';
COMMENT ON COLUMN reflection.summary_doc IS 'encrypted (user): jsonb envelope {"$enc": ...}: the rolling conversation summary.';
COMMENT ON COLUMN reflection.context_snapshot IS 'encrypted (user): the AI''s 2-3 sentence context summary captured when the reflection started a session.';
-- mwf_app: the caller's Inner Thoughts reflections (controllers/inner-work.ts, distillation, summarizer, classifier, and the
-- link to a session at createSession).
GRANT SELECT ON reflection TO app_access;
GRANT INSERT (user_id, title, status, linked_session_id, linked_at, created_at, updated_at) ON reflection TO app_access;
GRANT UPDATE (title, summary, theme, status, linked_session_id, linked_at, context_snapshot, summary_doc, distilled_at, updated_at)
  ON reflection TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (id, user_id) ON reflection TO mwf_definer;
GRANT DELETE ON reflection TO mwf_definer;
-- mwf_ops (work-k5fk.9, least privilege): exactly the columns the Neural Monitor reads (routes/brain.ts, the stage
-- shim), never a ciphertext or envelope column — the inner-work list, detail and filters (never the title).
GRANT SELECT (id, user_id, status, created_at, updated_at) ON reflection TO ops_access;

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
GRANT SELECT ON reflection_message TO app_access;
GRANT INSERT (reflection_id, role, content, created_at) ON reflection_message TO app_access;
-- mwf_ops: the Neural Monitor dashboard (routes/brain.ts) counts a reflection's turns — never content (owner decision
-- OD-1, work-k5fk.9).
GRANT SELECT (id, reflection_id, role) ON reflection_message TO ops_access;

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
GRANT SELECT ON takeaway TO app_access;
GRANT INSERT (reflection_id, content, theme, source, type, position, created_at, updated_at) ON takeaway TO app_access;
GRANT UPDATE (content, source, resolved_at, updated_at) ON takeaway TO app_access;
GRANT DELETE ON takeaway TO app_access;

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
GRANT SELECT ON takeaway_link TO app_access;
GRANT INSERT (source_id, target_id, link_type, created_at) ON takeaway_link TO app_access;
GRANT DELETE ON takeaway_link TO app_access;

CREATE TABLE user_device (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    push_token push_token,
    push_provider push_provider,
    platform device_platform,
    biometric_enabled boolean NOT NULL DEFAULT false,
    biometric_enrolled_at ts_ms,
    last_seen_at ts_ms,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.9 (V1): a token always names its provider, and a cleared token clears it
    CHECK ((push_token IS NULL) = (push_provider IS NULL))
);
CREATE INDEX ON user_device (user_id);
-- + sql_user_device_token (sql-only.sql)
COMMENT ON TABLE user_device IS 'A device a user registered: its push token and biometric enrolment.';
COMMENT ON COLUMN user_device.push_token IS 'The push token of this install, in its provider''s format (push_provider); NULL until registered or once cleared. A push_token: 1-512 characters, no whitespace or control character; no format CHECK (the app validates it for its provider).';
COMMENT ON COLUMN user_device.push_provider IS 'The push service push_token belongs to (work-k5fk.9, V1); set exactly when push_token is.';
COMMENT ON CONSTRAINT user_device_check ON user_device IS 'A push token and its provider are set and cleared together (work-k5fk.9, V1).';
-- mwf_app: the caller's push token registration / clearing and biometric setting (user-settings.ts); other users' tokens are
-- read by the job (push.ts).
GRANT SELECT ON user_device TO app_access;
GRANT INSERT (user_id, push_token, push_provider, platform, last_seen_at, biometric_enabled, biometric_enrolled_at,
              created_at, updated_at)
  ON user_device TO app_access;
GRANT UPDATE (push_token, push_provider, platform, last_seen_at, biometric_enabled, biometric_enrolled_at, updated_at)
  ON user_device TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (user_id) ON user_device TO mwf_definer;
GRANT DELETE ON user_device TO mwf_definer;
-- mwf_worker: push.ts sendPushNotification (notification delivery): the recipient's devices — another user than the
-- caller, so the worker reads them (user_device RLS is user_id = me); newest device first (last_seen_at); Expo's only
-- (push_provider)
GRANT SELECT (user_id, push_token, push_provider, last_seen_at) ON user_device TO worker_access;
-- mwf_worker: push.ts: a token Expo reports as unregistered is cleared with its provider (WHERE user_id = … AND push_token = …)
GRANT UPDATE (push_token, push_provider) ON user_device TO worker_access;

CREATE TABLE user_preferences (
    user_id uuid7 NOT NULL PRIMARY KEY REFERENCES "user" ON DELETE RESTRICT,
    doc preferences_json_schema NOT NULL DEFAULT '{}'::preferences_json_schema,
    doc_schema_version schema_version NOT NULL DEFAULT 1,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP
    -- §1.7 user_preferences: doc is an object with memory, notifications and privacy (preferences_json_schema)
);
COMMENT ON TABLE user_preferences IS 'The user''s preference documents (memory, notifications, privacy), one row per user.';
COMMENT ON COLUMN user_preferences.doc IS 'Plaintext settings (read by SQL jsonb operators); validated by the t_doc_schema trigger against app.json_schema user_preferences.';
COMMENT ON COLUMN user_preferences.doc_schema_version IS 'The version of the app.json_schema user_preferences document doc conforms to (validated by the t_doc_schema trigger; an unknown version is refused).';
-- mwf_app: the caller's settings document (user-settings.ts; FOR UPDATE needs UPDATE).
GRANT SELECT ON user_preferences TO app_access;
GRANT INSERT (user_id, doc) ON user_preferences TO app_access;
-- INSERT holds without the timestamps only because the row is created by raw SQL
-- (user-settings.ts INSERT … ON CONFLICT DO NOTHING); a Prisma create would send them.
GRANT UPDATE (doc, updated_at) ON user_preferences TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (user_id) ON user_preferences TO mwf_definer;
-- mwf_definer: participant_presence (v_participant: whether a co-participant shows their activity status)
GRANT SELECT (doc) ON user_preferences TO mwf_definer;
GRANT DELETE ON user_preferences TO mwf_definer;

CREATE TABLE user_memory (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    session_id uuid7,
    content ciphertext NOT NULL,
    category memory_category NOT NULL,
    status memory_status NOT NULL DEFAULT 'ACTIVE',
    source memory_source NOT NULL DEFAULT 'USER_APPROVED',
    suggested_text ciphertext,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- work-k5fk.9 (C7): a memory scoped to a session is scoped to one its owner is a participant of
    FOREIGN KEY (session_id, user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON user_memory (user_id, status);
CREATE INDEX ON user_memory (session_id);
COMMENT ON TABLE user_memory IS '"Things to always remember": standing instructions the user approved or wrote, optionally scoped to a session.';
COMMENT ON COLUMN user_memory.session_id IS 'NULL for a memory that applies everywhere; set for one scoped to a session its owner is a participant of ((session_id, user_id) references participant).';
COMMENT ON COLUMN user_memory.content IS 'encrypted (user): the standing instruction (2 to 500 characters).';
COMMENT ON COLUMN user_memory.suggested_text IS 'encrypted (user): the AI''s original text when the user edited it before approving, or the pre-edit text.';
-- mwf_app: the caller's memories (controllers/memories.ts, memory-service.ts), including deleting one.
GRANT SELECT ON user_memory TO app_access;
GRANT INSERT (user_id, session_id, content, category, status, source, suggested_text, created_at, updated_at) ON user_memory TO app_access;
GRANT UPDATE (session_id, content, category, status, source, suggested_text, updated_at) ON user_memory TO app_access;
GRANT DELETE ON user_memory TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (user_id) ON user_memory TO mwf_definer;
GRANT DELETE ON user_memory TO mwf_definer;

CREATE TABLE feature_state (
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    feature wellbeing_feature NOT NULL,
    doc feature_state_json_schema NOT NULL DEFAULT '{}'::feature_state_json_schema,
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.7 feature_state: doc is a well-formed envelope or keyless plaintext object (feature_state_json_schema)
    PRIMARY KEY (user_id, feature)
);
COMMENT ON TABLE feature_state IS 'One document per wellbeing feature per user (meditation, gratitude, needs assessment, people).';
COMMENT ON COLUMN feature_state.feature IS 'Which wellbeing feature this document belongs to.';
COMMENT ON COLUMN feature_state.doc IS 'encrypted (user): jsonb envelope {"$enc": ...}: the feature''s document (one zod contract per feature, shared/src/dto/feature-state.ts).';
-- mwf_app: the caller's per-feature state document (feature-state.ts; FOR UPDATE needs UPDATE).
GRANT SELECT ON feature_state TO app_access;
GRANT INSERT (user_id, feature, doc) ON feature_state TO app_access;
-- INSERT holds without the timestamps only because the row is created by raw SQL
-- (feature-state.ts INSERT … ON CONFLICT DO NOTHING); a Prisma create would send them.
GRANT UPDATE (doc, updated_at) ON feature_state TO app_access;
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (user_id) ON feature_state TO mwf_definer;
GRANT DELETE ON feature_state TO mwf_definer;

CREATE TABLE user_key (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    user_id uuid7 NOT NULL REFERENCES "user" ON DELETE RESTRICT,
    key_id kek_id NOT NULL,
    wrapped_dek wrapped_dek NOT NULL,
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
-- mwf_definer: anonymize step 7: the crypto-shred
GRANT SELECT (user_id, destroyed_at) ON user_key TO mwf_definer;
GRANT UPDATE (destroyed_at) ON user_key TO mwf_definer;

CREATE TABLE brain_activity (
    id uuid7 NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    session_id uuid7 REFERENCES session ON DELETE CASCADE,
    reflection_id uuid7 REFERENCES reflection ON DELETE CASCADE,
    participant_user_id uuid7,
    user_id uuid7 REFERENCES "user" ON DELETE RESTRICT,
    turn_id turn_id,
    activity_type activity_type NOT NULL,
    call_type brain_call_type,
    model model_id NOT NULL,
    input llm_call_input_json_schema,
    output llm_call_output_json_schema,
    metadata activity_metadata_json_schema,
    token_count_input integer NOT NULL DEFAULT 0,
    token_count_output integer NOT NULL DEFAULT 0,
    duration_ms integer NOT NULL DEFAULT 0,
    cost numeric(10,6) NOT NULL DEFAULT 0,
    status activity_status NOT NULL DEFAULT 'PENDING',
    created_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at ts_ms,
    updated_at ts_ms NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- §1.8 brain_activity [P28c]
    -- input / output are jsonb envelopes, always objects (llm_call_input_json_schema, llm_call_output_json_schema; review r1 F6); metadata is
    -- the telemetry whitelist (activity_metadata_json_schema)
    -- work-k5fk.3: an attributed row's participant is of its session. MATCH SIMPLE skips a key with a NULL in it,
    -- so the CHECK refuses a participant_user_id without a session_id.
    FOREIGN KEY (session_id, participant_user_id) REFERENCES participant (session_id, user_id) ON DELETE CASCADE,
    CHECK (participant_user_id IS NULL OR session_id IS NOT NULL),
    -- work-k5fk.10.35: a call of neither a session nor a reflection is owned by its acting user, and only such a call
    -- (a session's or a reflection's row is owned through them)
    CHECK ((user_id IS NOT NULL) = (session_id IS NULL AND reflection_id IS NULL))
);
CREATE INDEX ON brain_activity (session_id);
CREATE INDEX ON brain_activity (reflection_id);
CREATE INDEX ON brain_activity (user_id);
COMMENT ON CONSTRAINT brain_activity_check1 ON brain_activity IS 'work-k5fk.10.35: user_id is set exactly on a call of neither a session nor a reflection — every row has an owner its RLS can name.';
CREATE INDEX ON brain_activity (session_id, participant_user_id);
CREATE INDEX ON brain_activity (turn_id);
CREATE INDEX ON brain_activity (created_at);
COMMENT ON TABLE brain_activity IS 'Telemetry: one row per LLM, embedding, retrieval or tool call, with its prompt, output, tokens, cost and timing.';
COMMENT ON COLUMN brain_activity.participant_user_id IS 'A participant of the row''s session, by user (work-k5fk.3): (session_id, participant_user_id) references participant (session_id, user_id).';
COMMENT ON COLUMN brain_activity.user_id IS 'The acting user of a call of neither a session nor a reflection (gratitude, meditation, memory formatting and validation, people extraction): the row''s owner, the only user whose AI transaction reads or completes it (policy ai_own_call), and whose account deletion removes it. NULL on a session''s or a reflection''s row (work-k5fk.10.35).';
COMMENT ON COLUMN brain_activity.turn_id IS 'Correlates the calls of one request or chat turn (a turn_id: bounded, no format).';
COMMENT ON COLUMN brain_activity.model IS 'The model id the call used (a model_id: a Bedrock model id, the embedding model, or an app pseudo-model such as system-retrieval).';
COMMENT ON COLUMN brain_activity.input IS 'encrypted (per-row): jsonb envelope {"$enc": ...}: what the call was given — sizes and options, a retrieval''s search queries and detected references; the same key as output (owner decision, work-k5fk.9 follow-up). Timings, tokens, cost, status and call type are plain columns.';
COMMENT ON COLUMN brain_activity.output IS 'encrypted (per-row): jsonb envelope {"$enc": ...}: the call''s outcome — the model''s text and stop reason, a retrieval''s matches; the participant key when attributed, the session key for a call over both parties, the user key for a reflection''s (owner decision OD-1, work-k5fk.9). Nothing on the ops path reads it: mwf_ops holds no grant on it, and the key never enters the database.';
COMMENT ON COLUMN brain_activity.metadata IS 'Ops-readable telemetry (the Neural Monitor reads it in plain): call options, cache and tool counts, context sizes, the sanitized turn trace, an error class — never content. An activity_metadata_json_schema: exactly the whitelist of types/turn-trace.ts.';
COMMENT ON COLUMN brain_activity.cost IS 'Estimated cost of the call in US dollars, from the per-model token prices in lib/bedrock.ts.';
-- mwf_app: none. LLM prompts and outputs are written by the job and read by mwf_ops only (TS-12).
-- mwf_definer: anonymize_*: a private-row delete (steps 3–5) and the filter columns it reads
GRANT SELECT (session_id, participant_user_id, reflection_id, user_id) ON brain_activity TO mwf_definer;  -- session_id: R17 (step 4, NULL-participant history)
GRANT DELETE ON brain_activity TO mwf_definer;
-- mwf_ai: brain-service startActivity: the telemetry row of an AI call, attributed at capture (participant_user_id,
-- reflection_id; a sessionless row is an inner-work call's, which t_session_scope lets through); id / created_at are
-- column defaults returned by RETURNING; user_id: the acting user of a call of neither (work-k5fk.10.35)
GRANT INSERT (session_id, reflection_id, participant_user_id, user_id, turn_id, activity_type, call_type, model, input, metadata,
              status)
  ON brain_activity TO ai_access;
-- mwf_ai: startActivity RETURNING id, created_at; completeActivity / failActivity WHERE id = …; mergeTurnTrace
-- (ai-orchestrator storeTurnTrace): find the turn's latest ORCHESTRATED_RESPONSE row of the session and merge the
-- pipeline trace into its metadata (metadata holds cache/tool/trace telemetry, never a prompt). Never input / output.
GRANT SELECT (id, session_id, turn_id, call_type, metadata, created_at) ON brain_activity TO ai_access;
-- mwf_ai: completeActivity / failActivity: the outcome of the call
GRANT UPDATE (output, token_count_input, token_count_output, cost, duration_ms, status, completed_at, metadata)
  ON brain_activity TO ai_access;
-- mwf_worker: data-retention: the purge and delete windows (WHERE created_at < …, session_id IS NULL); the short-retention
-- purge sets the three blobs NULL (spec §1.8); records past the delete window go. Never a blob read.
GRANT SELECT (session_id, created_at) ON brain_activity TO worker_access;
GRANT UPDATE (input, output, metadata) ON brain_activity TO worker_access;
GRANT DELETE ON brain_activity TO worker_access;
-- mwf_ops (work-k5fk.9, least privilege): exactly the columns the Neural Monitor reads (routes/brain.ts, the stage
-- shim), never a ciphertext or envelope column — the telemetry and its metadata; never input or output.
GRANT SELECT (id, session_id, reflection_id, participant_user_id, turn_id, activity_type, call_type, model, metadata,
              token_count_input, token_count_output, duration_ms, cost, status, created_at, completed_at, updated_at)
  ON brain_activity TO ops_access;
