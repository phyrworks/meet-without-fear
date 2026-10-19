-- ============================================================================
-- Golden harness — `old_concept_*` views over the CURRENT (pre-rebuild) shape.
--
-- Owned by the golden harness, not by the application (TS-4 ruling R9). The
-- harness applies this file to each disposable run database after
-- `restoreFixture` and before the first snapshot (`concept-views/index.ts`,
-- `applyConceptViews`). It is never a Prisma migration and never belongs in
-- `backend/prisma/migrations/`.
--
-- WHEN THE DATABASE IS RE-SHAPED, A TARGET-SHAPE VERSION OF THIS FILE
-- (`target-shape.sql`) REPLACES IT: the same view names with the same column
-- sets, defined over the new snake_case tables. The column set of each view is
-- the contract between the two files — a column that cannot be projected from
-- both shapes is left out of both. The normalised baselines
-- (`__golden__/<scenario>.concept.json`) recorded through this file are then
-- compared against runs through the target file under each scenario's
-- allow-list (`allow-lists/<scenario>.ts`), never byte-for-byte.
--
-- What the views present: participant-centred rows in the target vocabulary of
-- docs/backend/data-model/schema-target-2026-10.md (§1 tables, §3 enums), built
-- with the mapping of docs/backend/data-model/schema-migration-plan-2026-10.md
-- §3 (step table and the step-7 gate-key table). Each view's comment names the
-- spec "Absorbs" line and the plan step it follows, and every place it departs
-- from them.
--
-- Conventions used throughout:
--   * Enums are projected as text, so the target's enum types compare equal.
--   * Timestamps stay `timestamp` (the harness selects them `::text`).
--   * Entities the target MINTS (participant, conversation, the share-context
--     draft) have no id in the old shape. Their id here is
--     `md5('<concept>:' || natural key)::uuid` — deterministic from the natural
--     key, uuid-shaped so the normaliser's unresolved-id tripwire still applies,
--     and labelled structurally (`<participant:ada@main>`) from the natural key,
--     never from its value. A uuidv7 cannot be minted in a view.
--   * Text columns that hold user ids without a foreign key (`Message.forUserId`,
--     `ReconcilerResult.guesserId`, …) are cast to uuid only when they are
--     uuid-shaped; anything else drops out of the join and surfaces as a NULL
--     reference, which the harness's checks turn into a failure.
--   * Views named `concept_check_*` are not concepts: they list old-shape
--     states the mapping cannot represent (the plan's prechecks that RAISE).
--     The harness fails a run if any of them returns a row.
--
-- Row identity and ordering keys are declared per view in
-- `concept-views/index.ts` (CONCEPT_VIEWS); every snapshot is
-- `ORDER BY` those natural keys, because a view has no primary key.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- user — spec §1.7 `user`, Absorbs: `User` identity columns. Plan §3 step 1,
-- step 4a (vanished members).
--
-- Tombstone-safe: a user id that the old shape still names (a participant's
-- evidence, see `old_concept_participant`) but whose `User` row was
-- hard-deleted is projected as a tombstone row (`email 'deleted+<id>'`, names
-- and clerk id NULL), so every `participant.user_id` resolves here as it will
-- under the target's RESTRICT foreign key. `deleted_at` is NULL for those rows
-- too: the old shape records no deletion instant (the migration stamps
-- `now()`), so an allow-list for a deletion scenario must name it.
--
-- `name` is the stored `User.name`, not the target's generated
-- `trim(first_name || ' ' || last_name)`: fixtures write `name` with no split
-- names, and the plan's precheck resolves that by writing the split names
-- first.
-- ----------------------------------------------------------------------------
-- (Defined after `old_concept_participant`, whose evidence names the
-- tombstoned ids.)


-- ----------------------------------------------------------------------------
-- session — spec §1.1 `session`, Absorbs: `Session` minus `type`, minus
-- WAITING/PAUSED (→ milestones). Plan §3 step 3: WAITING → ACTIVE, PAUSED →
-- ACTIVE (+ `paused` milestone, see `old_concept_participant_milestone`).
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_session AS
SELECT
  s.id,
  s."relationshipId" AS relationship_id,
  CASE s.status::text WHEN 'WAITING' THEN 'ACTIVE' WHEN 'PAUSED' THEN 'ACTIVE' ELSE s.status::text END AS status,
  s."topicFrame"            AS topic_frame,
  s."topicFrameConfirmedAt" AS topic_frame_confirmed_at,
  s."previousSessionId"     AS previous_session_id,
  s."resolvedAt"            AS resolved_at,
  s."createdAt"             AS created_at,
  s."updatedAt"             AS updated_at
FROM "Session" s;


-- ----------------------------------------------------------------------------
-- participant — spec §1.1 `participant`, Absorbs: new. Plan §3 step 4: one row
-- per distinct (sessionId, userId) in StageProgress ∪ UserVessel ∪
-- EmpathyDraft ∪ Stage4ProposalSelection ∪ TendingCheckin ∪ Message.forUserId
-- ∪ Message.senderId, union RelationshipMember × Session; plus step 4a's
-- vanished-member evidence (ReconcilerResult.guesserId/subjectId,
-- ReconcilerShareOffer.userId, Stage4NeedDeclination.userId,
-- TendingEntry.ownerUserId). Every other (session, user) pair an old row names
-- is added too (EmpathyAttempt, ConsentRecord, EmpathyValidation,
-- ValidationFeedbackDraft, Stage4SubChat, StrategyProposal), because the step-4
-- assertion is that every such pair resolves to exactly one participant.
--
-- id: md5 of the pair (see header). kind: always 'human' (no modeled
-- participants exist today). display_name ← User.name (NULL for a vanished
-- user). joined_at ← RelationshipMember.joinedAt (NULL when the user has no
-- member row — the migration defaults it; not comparable). left_at: NULL —
-- the old shape has no leave instant.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_participant AS
WITH uuid_shaped(re) AS (
  SELECT '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text
),
evidence(session_id, user_id) AS (
            SELECT "sessionId", "userId" FROM "StageProgress"
  UNION     SELECT "sessionId", "userId" FROM "UserVessel"
  UNION     SELECT "sessionId", "userId" FROM "EmpathyDraft"
  UNION     SELECT "sessionId", "userId" FROM "Stage4ProposalSelection"
  UNION     SELECT "sessionId", "userId" FROM "TendingCheckin"
  UNION     SELECT m."sessionId", lower(m."forUserId")::uuid FROM "Message" m, uuid_shaped
            WHERE lower(m."forUserId") ~ uuid_shaped.re
  UNION     SELECT "sessionId", "senderId" FROM "Message" WHERE "senderId" IS NOT NULL
  UNION     SELECT s.id, rm."userId" FROM "Session" s JOIN "RelationshipMember" rm ON rm."relationshipId" = s."relationshipId"
  -- step 4a: vanished-member evidence (text ids, no FK — they survive a hard delete)
  UNION     SELECT r."sessionId", lower(r."guesserId")::uuid FROM "ReconcilerResult" r, uuid_shaped
            WHERE lower(r."guesserId") ~ uuid_shaped.re
  UNION     SELECT r."sessionId", lower(r."subjectId")::uuid FROM "ReconcilerResult" r, uuid_shaped
            WHERE lower(r."subjectId") ~ uuid_shaped.re
  UNION     SELECT r."sessionId", lower(o."userId")::uuid
            FROM "ReconcilerShareOffer" o JOIN "ReconcilerResult" r ON r.id = o."resultId", uuid_shaped
            WHERE lower(o."userId") ~ uuid_shaped.re
  UNION     SELECT d."sessionId", lower(d."userId")::uuid FROM "Stage4NeedDeclination" d, uuid_shaped
            WHERE lower(d."userId") ~ uuid_shaped.re
  UNION     SELECT t."sessionId", lower(t."ownerUserId")::uuid FROM "TendingEntry" t, uuid_shaped
            WHERE lower(t."ownerUserId") ~ uuid_shaped.re
  -- every other old (session, user) pair
  UNION     SELECT "sessionId", "sourceUserId" FROM "EmpathyAttempt" WHERE "sourceUserId" IS NOT NULL
  UNION     SELECT "sessionId", "userId" FROM "ConsentRecord" WHERE "sessionId" IS NOT NULL
  UNION     SELECT "sessionId", "userId" FROM "EmpathyValidation" WHERE "userId" IS NOT NULL
  UNION     SELECT "sessionId", "userId" FROM "ValidationFeedbackDraft"
  UNION     SELECT "sessionId", "userId" FROM "Stage4SubChat"
  UNION     SELECT "sessionId", "createdByUserId" FROM "StrategyProposal" WHERE "createdByUserId" IS NOT NULL
)
SELECT
  md5('participant:' || e.session_id::text || ':' || e.user_id::text)::uuid AS id,
  e.session_id,
  e.user_id,
  'human'::text AS kind,
  u.name        AS display_name,
  rm."joinedAt" AS joined_at,
  NULL::timestamp AS left_at
FROM evidence e
JOIN "Session" s ON s.id = e.session_id
LEFT JOIN "User" u ON u.id = e.user_id
LEFT JOIN "RelationshipMember" rm ON rm."relationshipId" = s."relationshipId" AND rm."userId" = e.user_id;


CREATE VIEW old_concept_user AS
SELECT
  u.id,
  u."clerkId"   AS clerk_id,
  u.email,
  u."firstName" AS first_name,
  u."lastName"  AS last_name,
  u.name,
  NULL::timestamp AS deleted_at,
  u."createdAt" AS created_at,
  u."updatedAt" AS updated_at
FROM "User" u
UNION ALL
SELECT DISTINCT
  p.user_id AS id,
  NULL::text AS clerk_id,
  'deleted+' || p.user_id::text AS email,
  NULL::text AS first_name,
  NULL::text AS last_name,
  NULL::text AS name,
  NULL::timestamp AS deleted_at,
  NULL::timestamp AS created_at,
  NULL::timestamp AS updated_at
FROM old_concept_participant p
WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = p.user_id);


-- ----------------------------------------------------------------------------
-- conversation — spec §1.1 `conversation`, Absorbs: `UserVessel`,
-- `Stage4SubChat`. Plan §3 step 6: one MAIN per participant (id minted), and
-- SUBCHAT conversations ← Stage4SubChat (ids kept).
--
-- MAIN: one per participant whether or not a UserVessel exists (the target's
-- partial unique makes it exactly one). id: md5 of the participant pair.
-- SUBCHAT: anchor_proposal_id ← anchorId only where it names a proposal (plan
-- step 17); status/resolved_at carried. created_at is not projected: the
-- target mints MAIN conversations at migration time.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_conversation AS
SELECT
  md5('conversation:MAIN:' || p.session_id::text || ':' || p.user_id::text)::uuid AS id,
  p.id AS participant_id,
  'MAIN'::text AS kind,
  NULL::text AS anchor_kind,
  NULL::uuid AS anchor_proposal_id,
  'ACTIVE'::text AS status,
  NULL::timestamp AS resolved_at
FROM old_concept_participant p
UNION ALL
SELECT
  sc.id,
  p.id AS participant_id,
  'SUBCHAT'::text AS kind,
  sc."anchorKind"::text AS anchor_kind,
  (SELECT sp.id FROM "StrategyProposal" sp WHERE sp.id::text = lower(sc."anchorId")) AS anchor_proposal_id,
  sc.status::text AS status,
  sc."resolvedAt" AS resolved_at
FROM "Stage4SubChat" sc
JOIN old_concept_participant p ON p.session_id = sc."sessionId" AND p.user_id = sc."userId";


-- ----------------------------------------------------------------------------
-- participant_milestone — spec §1.1 `participant_milestone`, Absorbs:
-- `StageProgress` rows + `gatesSatisfied` per plan §3 step 7's key table;
-- `Session.status PAUSED`.
--
-- Decoded gate keys (plan step 7 key table, plus the three FIXTURE-ONLY keys
-- documented in fixture-scenarios/current-shape.ts's header — `empathyExchanged`
-- for `empathyValidated`, `needsIdentified` for `needsConfirmed`, and the
-- `compactSignedAt` companion for `signedAt`):
--   compactSigned                      → compact_signed  @ signedAt | compactSignedAt
--   invitationSent                     → invitation_sent @ StageProgress.startedAt
--   feelHeardConfirmed                 → feel_heard      @ feelHeardConfirmedAt | confirmedAt
--   empathyValidated | empathyExchanged→ empathy_validated @ empathyExchangedAt | completedAt
--   needsConfirmed | needsIdentified   → needs_confirmed
--   needsShared                        → needs_shared
--   needsValidated                     → needs_validated
--   selectionSubmitted                 → choices_shared
--   phase <> 'INVENTORY'               → repair_walkthrough_started @ startedAt
-- plus StageProgress(status COMPLETED, stage n) → the terminal milestone of
-- stage n (0 compact_signed, 1 feel_heard, 2 empathy_validated, 3
-- needs_shared, 4 choices_shared) @ completedAt; and Session.status PAUSED →
-- `paused` for every participant @ Session.updatedAt.
--
-- reached_at for a gate with no instant in the key table: its `<key>At`
-- companion if present, else the row's completedAt, else its startedAt. A
-- milestone reached by more than one route keeps the earliest instant
-- (the PK is (participant_id, milestone_key)).
--
-- DEPARTURE (empathy_validated instant): step 7 says `empathy_validated @
-- StageProgress.completedAt`. Here an `empathyExchangedAt` / `empathyValidatedAt`
-- companion, when present, is preferred over completedAt — the same rule every
-- other gate gets — and the COMPLETED-stage-2 route still contributes
-- completedAt, so with `min()` the earlier of the two wins. In today's fixtures
-- the companion and completedAt are the same instant.
--
-- Dropped keys (step 7: AI hints, ranking, derived): feelHeardCheckOffered,
-- finalEmotionalReading, readyToRank, rankingSubmitted, partnerConsented,
-- partnerValidated, partner, own; fixture-derived strategiesRanked,
-- agreementCreated, agreementConfirmed. currentNeedId/coveredNeedIds/
-- skippedNeedIds → `old_concept_need_disposition`. Any other key is listed by
-- `concept_check_unmapped_gate_key` and fails the run (step 7: "unknown keys
-- RAISE").
--
-- Departure, documented by TS-3: today's fixtures complete stage 4 under the
-- legacy ranking flow, so a COMPLETED stage-4 row decodes here as
-- `choices_shared` (step 7) where the scenario model says `closed`.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_participant_milestone AS
WITH prog AS (
  SELECT p.id AS participant_id, sp.stage, sp.status::text AS status, sp."startedAt", sp."completedAt",
         CASE WHEN jsonb_typeof(sp."gatesSatisfied") = 'object' THEN sp."gatesSatisfied" ELSE '{}'::jsonb END AS g
  FROM "StageProgress" sp
  JOIN old_concept_participant p ON p.session_id = sp."sessionId" AND p.user_id = sp."userId"
),
ts(participant_id, milestone_key, reached_at) AS (
  -- gates
  SELECT participant_id, 'compact_signed',
         coalesce((g->>'signedAt')::timestamptz AT TIME ZONE 'UTC', (g->>'compactSignedAt')::timestamptz AT TIME ZONE 'UTC', "completedAt", "startedAt")
  FROM prog WHERE (g->>'compactSigned')::boolean
  UNION ALL
  SELECT participant_id, 'invitation_sent', "startedAt" FROM prog WHERE (g->>'invitationSent')::boolean
  UNION ALL
  SELECT participant_id, 'feel_heard',
         coalesce((g->>'feelHeardConfirmedAt')::timestamptz AT TIME ZONE 'UTC', (g->>'confirmedAt')::timestamptz AT TIME ZONE 'UTC', "completedAt", "startedAt")
  FROM prog WHERE (g->>'feelHeardConfirmed')::boolean
  UNION ALL
  SELECT participant_id, 'empathy_validated',
         coalesce((g->>'empathyExchangedAt')::timestamptz AT TIME ZONE 'UTC', (g->>'empathyValidatedAt')::timestamptz AT TIME ZONE 'UTC', "completedAt", "startedAt")
  FROM prog WHERE (g->>'empathyValidated')::boolean OR (g->>'empathyExchanged')::boolean
  UNION ALL
  SELECT participant_id, 'needs_confirmed',
         coalesce((g->>'needsConfirmedAt')::timestamptz AT TIME ZONE 'UTC', (g->>'needsIdentifiedAt')::timestamptz AT TIME ZONE 'UTC', "completedAt", "startedAt")
  FROM prog WHERE (g->>'needsConfirmed')::boolean OR (g->>'needsIdentified')::boolean
  UNION ALL
  SELECT participant_id, 'needs_shared',
         coalesce((g->>'needsSharedAt')::timestamptz AT TIME ZONE 'UTC', "completedAt", "startedAt")
  FROM prog WHERE (g->>'needsShared')::boolean
  UNION ALL
  SELECT participant_id, 'needs_validated',
         coalesce((g->>'needsValidatedAt')::timestamptz AT TIME ZONE 'UTC', "completedAt", "startedAt")
  FROM prog WHERE (g->>'needsValidated')::boolean
  UNION ALL
  SELECT participant_id, 'choices_shared',
         coalesce((g->>'selectionSubmittedAt')::timestamptz AT TIME ZONE 'UTC', "completedAt", "startedAt")
  FROM prog WHERE (g->>'selectionSubmitted')::boolean
  UNION ALL
  SELECT participant_id, 'repair_walkthrough_started', "startedAt"
  FROM prog WHERE g ? 'phase' AND g->>'phase' IS NOT NULL AND g->>'phase' <> 'INVENTORY'
  -- COMPLETED rows → the stage's terminal milestone
  UNION ALL
  SELECT participant_id,
         (ARRAY['compact_signed','feel_heard','empathy_validated','needs_shared','choices_shared'])[stage + 1],
         "completedAt"
  FROM prog WHERE status = 'COMPLETED' AND stage BETWEEN 0 AND 4 AND "completedAt" IS NOT NULL
  -- Session PAUSED → paused, for every participant of the session
  UNION ALL
  SELECT p.id, 'paused', s."updatedAt"
  FROM "Session" s JOIN old_concept_participant p ON p.session_id = s.id
  WHERE s.status::text = 'PAUSED'
)
SELECT participant_id, milestone_key, min(reached_at) AS reached_at
FROM ts
GROUP BY participant_id, milestone_key;


-- Plan step 7 / precheck: "every gatesSatisfied key is in the key table".
-- `<key>At` companions of mapped keys are accepted.
CREATE VIEW concept_check_unmapped_gate_key AS
SELECT DISTINCT sp."sessionId" AS session_id, sp."userId" AS user_id, sp.stage, k.key
FROM "StageProgress" sp
CROSS JOIN LATERAL jsonb_object_keys(
  CASE WHEN jsonb_typeof(sp."gatesSatisfied") = 'object' THEN sp."gatesSatisfied" ELSE '{}'::jsonb END
) AS k(key)
WHERE k.key NOT IN (
  -- mapped (step 7) and their instants
  'compactSigned', 'signedAt', 'invitationSent', 'feelHeardConfirmed', 'feelHeardConfirmedAt', 'confirmedAt',
  'empathyValidated', 'empathyValidatedAt', 'needsConfirmed', 'needsConfirmedAt', 'needsShared', 'needsSharedAt',
  'needsValidated', 'needsValidatedAt', 'selectionSubmitted', 'selectionSubmittedAt', 'phase',
  'currentNeedId', 'coveredNeedIds', 'skippedNeedIds',
  -- fixture-only spellings (fixture-scenarios/current-shape.ts header)
  'compactSignedAt', 'empathyExchanged', 'empathyExchangedAt', 'needsIdentified', 'needsIdentifiedAt',
  -- dropped (step 7) and fixture-derived
  'feelHeardCheckOffered', 'finalEmotionalReading', 'readyToRank', 'rankingSubmitted',
  'partnerConsented', 'partnerValidated', 'partner', 'own',
  'strategiesRanked', 'agreementCreated', 'agreementConfirmed'
);


-- ----------------------------------------------------------------------------
-- message — spec §1.1 `message`, Absorbs: `Message` (sessionId+forUserId →
-- conversation_id; senderId → participant; role split; stage dropped;
-- extractedNeeds/Emotions dropped), `Stage4SubChatMessage`. Plan §3 step 9.
--
-- conversation_id: the MAIN conversation of participant (sessionId,
-- coalesce(forUserId, senderId)). A row with neither is the leaver's orphan
-- that step 4a deletes; here it projects with conversation_id NULL, and the
-- normaliser refuses to label a message without a conversation, so its id
-- stays unresolved and the run fails.
-- role/kind (spec §3): USER/AI/SYSTEM keep their role with kind CHAT; the six
-- event roles become kind = the old role, with role USER when a sender is set
-- (a delivered item authored by a participant — spec, T-message-immutable:
-- "delivered items are role USER") and AI otherwise (the CHECK pair
-- role USER ⇔ sender set).
-- source_attempt_id (step 9, "resolved by (sessionId, author)"):
--   EMPATHY_STATEMENT   → the attempt whose sourceUserId is the sender;
--   VALIDATION_FEEDBACK → the attempt being reviewed: the one authored by the
--                         message's RECIPIENT (forUserId) — the feedback is
--                         delivered to the attempt's author, so this is the
--                         step's "(sessionId, author)" literally. (Resolving
--                         by the sender would name the reviewer's own attempt;
--                         "not the sender" breaks on a NULL sender or N>2.)
--   SHARED_CONTEXT and every other kind → NULL (no old link exists).
-- Delivered EMPATHY_STATEMENT copies the migration inserts into the subject's
-- conversation do not exist in the old shape (step 9: "today's data has
-- none"); allow-lists name them as added rows.
-- SUBCHAT messages: conversation = the sub-chat (ids kept), sender = the
-- sub-chat's owner for role USER.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_message AS
SELECT
  m.id,
  c.id AS conversation_id,
  sp.id AS sender_participant_id,
  CASE WHEN m.role::text IN ('USER','AI','SYSTEM') THEN m.role::text
       WHEN m."senderId" IS NOT NULL THEN 'USER'
       ELSE 'AI' END AS role,
  CASE WHEN m.role::text IN ('USER','AI','SYSTEM') THEN 'CHAT' ELSE m.role::text END AS kind,
  m.content,
  m."contentHash"    AS content_hash,
  m."refiningNeedId" AS refining_need_id,
  CASE m.role::text
    WHEN 'EMPATHY_STATEMENT' THEN
      (SELECT a.id FROM "EmpathyAttempt" a WHERE a."sessionId" = m."sessionId" AND a."sourceUserId" = m."senderId")
    WHEN 'VALIDATION_FEEDBACK' THEN
      (SELECT a.id FROM "EmpathyAttempt" a WHERE a."sessionId" = m."sessionId" AND a."sourceUserId"::text = lower(m."forUserId"))
  END AS source_attempt_id,
  m."timestamp" AS created_at
FROM "Message" m
LEFT JOIN old_concept_participant op
  ON op.session_id = m."sessionId"
 AND op.user_id = coalesce(
       CASE WHEN lower(m."forUserId") ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN lower(m."forUserId")::uuid END,
       m."senderId")
LEFT JOIN old_concept_conversation c ON c.participant_id = op.id AND c.kind = 'MAIN'
LEFT JOIN old_concept_participant sp ON sp.session_id = m."sessionId" AND sp.user_id = m."senderId"
UNION ALL
SELECT
  sm.id,
  sc.id AS conversation_id,
  CASE WHEN sm.role::text = 'USER' THEN p.id END AS sender_participant_id,
  CASE WHEN sm.role::text IN ('USER','AI','SYSTEM') THEN sm.role::text ELSE 'AI' END AS role,
  CASE WHEN sm.role::text IN ('USER','AI','SYSTEM') THEN 'CHAT' ELSE sm.role::text END AS kind,
  sm.content,
  NULL::varchar AS content_hash,
  NULL::uuid AS refining_need_id,
  NULL::uuid AS source_attempt_id,
  sm."createdAt" AS created_at
FROM "Stage4SubChatMessage" sm
JOIN "Stage4SubChat" sc ON sc.id = sm."subChatId"
JOIN old_concept_participant p ON p.session_id = sc."sessionId" AND p.user_id = sc."userId";


-- ----------------------------------------------------------------------------
-- empathy_attempt — spec §1.2 `empathy_attempt`, Absorbs: `EmpathyAttempt`
-- (sourceUserId → author; subject made explicit; draftId dropped;
-- revisionCount → rows; consentRecordId dropped). Plan §3 step 11.
--
-- subject: the session's other participant. More than one other participant
-- makes the scalar subquery raise — the step's "RAISE if N≠2" — and none
-- leaves it NULL. A NULL author or subject is listed by
-- `concept_check_attempt_without_direction` (below), which fails the snapshot;
-- the normaliser also refuses to label such an attempt.
-- round ← revisionCount + 1. status (spec §3 empathy_status): ANALYZING →
-- HELD, NEEDS_WORK → AWAITING_SHARING. submitted_at ← sharedAt.
-- supersedes_attempt_id: NULL — the old shape keeps one row per direction.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_empathy_attempt AS
SELECT
  a.id,
  au.id AS author_participant_id,
  (SELECT o.id FROM old_concept_participant o
    WHERE o.session_id = a."sessionId" AND o.user_id IS DISTINCT FROM a."sourceUserId") AS subject_participant_id,
  a."revisionCount" + 1 AS round,
  NULL::uuid AS supersedes_attempt_id,
  a.content,
  CASE a.status::text WHEN 'ANALYZING' THEN 'HELD' WHEN 'NEEDS_WORK' THEN 'AWAITING_SHARING' ELSE a.status::text END AS status,
  a."statusVersion"  AS status_version,
  a."sharedAt"       AS submitted_at,
  a."revealedAt"     AS revealed_at,
  a."deliveryStatus"::text AS delivery_status,
  a."deliveredAt"    AS delivered_at,
  a."seenAt"         AS seen_at
FROM "EmpathyAttempt" a
LEFT JOIN old_concept_participant au ON au.session_id = a."sessionId" AND au.user_id = a."sourceUserId";


-- Plan step 11: every attempt has an author and a subject (target NOT NULL;
-- "RAISE if N≠2"). An attempt the view cannot direct fails the snapshot.
CREATE VIEW concept_check_attempt_without_direction AS
SELECT id, author_participant_id IS NULL AS no_author, subject_participant_id IS NULL AS no_subject
FROM old_concept_empathy_attempt
WHERE author_participant_id IS NULL OR subject_participant_id IS NULL;


-- ----------------------------------------------------------------------------
-- empathy_review — spec §1.2 `empathy_review`, Absorbs: `EmpathyValidation`
-- (feedbackShared → timestamp; unsent feedback text → draft). Plan step 11:
-- feedback kept only where feedbackShared; feedback_sent_at ← validatedAt
-- when shared (the old shape has no separate send instant).
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_empathy_review AS
SELECT
  v.id,
  v."attemptId" AS attempt_id,
  p.id AS reviewer_participant_id,
  v.validated,
  CASE WHEN v."feedbackShared" THEN v.feedback END AS feedback,
  CASE WHEN v."feedbackShared" THEN v."validatedAt" END AS feedback_sent_at
FROM "EmpathyValidation" v
LEFT JOIN old_concept_participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId";


-- ----------------------------------------------------------------------------
-- reconciler_result — spec §1.2 `reconciler_result`, Absorbs:
-- `ReconcilerResult` minus guesserName/subjectName, minus the three guidance
-- columns. Plan step 11: by (sessionId, guesserId, subjectId) → attempt.
-- gap_severity and recommended_action upper-cased (spec §3: was free text).
-- circuit_breaker_tripped ← wasCircuitBreakerTrip.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_reconciler_result AS
SELECT
  r.id,
  (SELECT a.id FROM "EmpathyAttempt" a
    WHERE a."sessionId" = r."sessionId" AND a."sourceUserId"::text = lower(r."guesserId")) AS attempt_id,
  sp.id AS subject_participant_id,
  r.iteration,
  r."alignmentScore"   AS alignment_score,
  r."alignmentSummary" AS alignment_summary,
  r."gapSummary"       AS gap_summary,
  upper(r."gapSeverity") AS gap_severity,
  coalesce(r."correctlyIdentified", '{}') AS correctly_identified,
  coalesce(r."missedFeelings", '{}')      AS missed_feelings,
  coalesce(r.misattributions, '{}')       AS misattributions,
  r."mostImportantGap" AS most_important_gap,
  upper(r."recommendedAction") AS recommended_action,
  r.rationale,
  r."sharingWouldHelp"      AS sharing_would_help,
  r."suggestedShareFocus"   AS suggested_share_focus,
  r."suggestedShareContent" AS suggested_share_content,
  r."suggestedShareReason"  AS suggested_share_reason,
  r."wasCircuitBreakerTrip" AS circuit_breaker_tripped,
  r."supersededAt" AS superseded_at,
  r."createdAt"    AS created_at
FROM "ReconcilerResult" r
LEFT JOIN old_concept_participant sp ON sp.session_id = r."sessionId" AND sp.user_id::text = lower(r."subjectId");


-- ----------------------------------------------------------------------------
-- reconciler_guidance — spec §1.2 `reconciler_guidance`, Absorbs:
-- `ReconcilerResult.{areaHint, guidanceType, promptSeed}`. One row per result
-- that carries any of the three (a result with none has nothing to split out).
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_reconciler_guidance AS
SELECT
  r.id AS result_id,
  gp.id AS author_participant_id,
  sp.id AS subject_participant_id,
  r."areaHint"     AS area_hint,
  r."guidanceType" AS guidance_type,
  r."promptSeed"   AS prompt_seed,
  r."createdAt"    AS created_at
FROM "ReconcilerResult" r
LEFT JOIN old_concept_participant gp ON gp.session_id = r."sessionId" AND gp.user_id::text = lower(r."guesserId")
LEFT JOIN old_concept_participant sp ON sp.session_id = r."sessionId" AND sp.user_id::text = lower(r."subjectId")
WHERE r."areaHint" IS NOT NULL OR r."guidanceType" IS NOT NULL OR r."promptSeed" IS NOT NULL;


-- ----------------------------------------------------------------------------
-- context_share_offer — spec §1.2 `context_share_offer`, Absorbs:
-- `ReconcilerShareOffer` minus skippedAt, refinementChatUsed; refinedContent →
-- draft(SHARE_CONTEXT). Plan step 11: attempt_id via result; status
-- NOT_OFFERED/SKIPPED → EXPIRED. subject ← the offer's userId.
-- offered_at: not projected — the old shape has no offer instant.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_context_share_offer AS
SELECT
  o.id,
  rr.attempt_id,
  o."resultId" AS result_id,
  p.id AS subject_participant_id,
  o.iteration,
  CASE o.status::text WHEN 'NOT_OFFERED' THEN 'EXPIRED' WHEN 'SKIPPED' THEN 'EXPIRED' ELSE o.status::text END AS status,
  o."offerMessage"     AS offer_message,
  o."suggestedContent" AS suggested_content,
  o."suggestedReason"  AS suggested_reason,
  o."sharedContent"    AS shared_content,
  o."sharedAt"   AS shared_at,
  o."declinedAt" AS declined_at,
  o."deliveryStatus"::text AS delivery_status,
  o."deliveredAt" AS delivered_at,
  o."seenAt"      AS seen_at,
  o."lastDeliveryNotifiedAt" AS delivery_notified_at,
  o."lastSeenNotifiedAt"     AS seen_notified_at,
  o."createdAt" AS created_at,
  o."updatedAt" AS updated_at
FROM "ReconcilerShareOffer" o
JOIN "ReconcilerResult" r ON r.id = o."resultId"
LEFT JOIN old_concept_reconciler_result rr ON rr.id = o."resultId"
LEFT JOIN old_concept_participant p ON p.session_id = r."sessionId" AND p.user_id::text = lower(o."userId");


-- ----------------------------------------------------------------------------
-- draft — spec §1.1 `draft`, Absorbs: `EmpathyDraft` (about = the other
-- participant), `ValidationFeedbackDraft` (attempt = the reviewed attempt),
-- `ReconcilerShareOffer.refinedContent` (SHARE_CONTEXT). Plan step 10.
--
-- EMPATHY and VALIDATION_FEEDBACK keep their old ids; the SHARE_CONTEXT draft
-- has no old row of its own, so its id is md5 of the offer id. The old
-- ValidationFeedbackDraft and share-offer edit carry no version → 1, and the
-- share-offer edit no ready flag → false.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_draft AS
SELECT
  d.id,
  p.id AS participant_id,
  'EMPATHY'::text AS kind,
  (SELECT o.id FROM old_concept_participant o
    WHERE o.session_id = d."sessionId" AND o.user_id <> d."userId") AS about_participant_id,
  NULL::uuid AS attempt_id,
  NULL::uuid AS share_offer_id,
  d.content,
  d."readyToShare" AS ready_to_share,
  d.version,
  d."createdAt" AS created_at,
  d."updatedAt" AS updated_at
FROM "EmpathyDraft" d
LEFT JOIN old_concept_participant p ON p.session_id = d."sessionId" AND p.user_id = d."userId"
UNION ALL
SELECT
  f.id,
  p.id,
  'VALIDATION_FEEDBACK'::text,
  NULL::uuid,
  -- The attempt this drafter reviews is the one whose SUBJECT they are (the
  -- old row names no attempt; "not authored by the drafter" picks wrong at N>2).
  (SELECT a.id FROM old_concept_empathy_attempt a WHERE a.subject_participant_id = p.id),
  NULL::uuid,
  f.content,
  f."readyToShare",
  1,
  f."createdAt",
  f."updatedAt"
FROM "ValidationFeedbackDraft" f
LEFT JOIN old_concept_participant p ON p.session_id = f."sessionId" AND p.user_id = f."userId"
UNION ALL
SELECT
  md5('draft:SHARE_CONTEXT:' || o.id::text)::uuid,
  p.id,
  'SHARE_CONTEXT'::text,
  NULL::uuid,
  NULL::uuid,
  o.id,
  o."refinedContent",
  false,
  1,
  o."createdAt",
  o."updatedAt"
FROM "ReconcilerShareOffer" o
JOIN "ReconcilerResult" r ON r.id = o."resultId"
LEFT JOIN old_concept_participant p ON p.session_id = r."sessionId" AND p.user_id::text = lower(o."userId")
WHERE o."refinedContent" IS NOT NULL;


-- ----------------------------------------------------------------------------
-- need — spec §1.4 `need`, Absorbs: `IdentifiedNeed`. participant ← the
-- vessel's (sessionId, userId). label ← need.
-- `confirmed` is projected as a boolean: the old shape has no confirmation
-- instant, so the target view projects `confirmed_at IS NOT NULL` under the
-- same name.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_need AS
SELECT
  n.id,
  p.id AS participant_id,
  n.need AS label,
  n.category::text AS category,
  coalesce(n.evidence, '{}') AS evidence,
  n."aiConfidence" AS ai_confidence,
  n.confirmed,
  n."lockedAt" AS locked_at,
  n."supersededByNeedId" AS superseded_by_need_id,
  n."deletedAt" AS deleted_at,
  n."createdAt" AS created_at
FROM "IdentifiedNeed" n
JOIN "UserVessel" uv ON uv.id = n."vesselId"
LEFT JOIN old_concept_participant p ON p.session_id = uv."sessionId" AND p.user_id = uv."userId";


-- ----------------------------------------------------------------------------
-- need_share — spec §1.4 `need_share`, Absorbs: `ConsentedContent`
-- (transformedContent, consentedAt, consentActive/revokedAt; originalNeedId
-- never written — the need is resolved through consentRecordId →
-- ConsentRecord.targetId; participant_id/session_id from the resolved need).
-- Plan step 12. A need is "shared" exactly when a ConsentedContent row says
-- so. revoked_at: NULL while consentActive; otherwise the row's revokedAt,
-- falling back to the consent record's.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_need_share AS
SELECT
  n.id AS need_id,
  n.participant_id,
  p.session_id,
  n.category,
  cc."transformedContent" AS shared_text,
  cc."consentedAt" AS shared_at,
  CASE WHEN cc."consentActive" THEN NULL ELSE coalesce(cc."revokedAt", cr."revokedAt") END AS revoked_at,
  cc."consentedAt" AS created_at
FROM "ConsentedContent" cc
JOIN "ConsentRecord" cr ON cr.id = cc."consentRecordId"
LEFT JOIN old_concept_need n ON n.id::text = lower(cr."targetId")
LEFT JOIN old_concept_participant p ON p.id = n.participant_id;


-- ----------------------------------------------------------------------------
-- need_disposition — spec §1.4 `need_disposition`, Absorbs:
-- gatesSatisfied.{currentNeedId, coveredNeedIds, skippedNeedIds},
-- Stage4NeedDeclination (→ DECLINED). Plan step 8: only for needs that have a
-- need_share row (dispositions on unshared needs are dropped). One row per
-- (participant, need): DECLINED > SKIPPED > COVERED > OPEN; is_current from
-- currentNeedId. note: NULL (no old source).
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_need_disposition AS
WITH g AS (
  SELECT p.id AS participant_id,
         CASE WHEN jsonb_typeof(sp."gatesSatisfied") = 'object' THEN sp."gatesSatisfied" ELSE '{}'::jsonb END AS g
  FROM "StageProgress" sp
  JOIN old_concept_participant p ON p.session_id = sp."sessionId" AND p.user_id = sp."userId"
),
items(participant_id, need, mark) AS (
  SELECT participant_id, jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'coveredNeedIds') = 'array' THEN g->'coveredNeedIds' ELSE '[]' END), 'COVERED' FROM g
  UNION ALL
  SELECT participant_id, jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'skippedNeedIds') = 'array' THEN g->'skippedNeedIds' ELSE '[]' END), 'SKIPPED' FROM g
  UNION ALL
  SELECT participant_id, g->>'currentNeedId', 'CURRENT' FROM g WHERE g->>'currentNeedId' IS NOT NULL
  UNION ALL
  SELECT p.id, d."needId", 'DECLINED'
  FROM "Stage4NeedDeclination" d
  JOIN old_concept_participant p ON p.session_id = d."sessionId" AND p.user_id::text = lower(d."userId")
)
SELECT
  i.participant_id,
  ns.need_id,
  CASE WHEN bool_or(i.mark = 'DECLINED') THEN 'DECLINED'
       WHEN bool_or(i.mark = 'SKIPPED')  THEN 'SKIPPED'
       WHEN bool_or(i.mark = 'COVERED')  THEN 'COVERED'
       ELSE 'OPEN' END AS status,
  bool_or(i.mark = 'CURRENT') AS is_current,
  NULL::text AS note
FROM items i
JOIN old_concept_need_share ns ON ns.need_id::text = lower(i.need)
GROUP BY i.participant_id, ns.need_id;


-- ----------------------------------------------------------------------------
-- proposal — spec §1.4 `proposal`, Absorbs: `StrategyProposal` minus
-- needsAddressed[] (→ proposal_need), parentProposalId, coverageSummary,
-- consentRecordId, capturedFromMessageId. Plan step 13.
-- unresolved_need_labels: the needsAddressed[] entries that match no SHARED
-- need of the session by label (case-insensitive), in array order.
-- shared_at: NULL — the old shape never recorded a commitment being shared.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_proposal AS
SELECT
  sp.id,
  sp."sessionId" AS session_id,
  cp.id AS created_by_participant_id,
  sp.source::text AS source,
  sp.kind::text   AS kind,
  sp.status::text AS status,
  sp.description,
  sp.duration,
  sp."measureOfSuccess" AS measure_of_success,
  coalesce((
    SELECT array_agg(lbl ORDER BY ord)
    FROM unnest(coalesce(sp."needsAddressed", '{}')) WITH ORDINALITY AS x(lbl, ord)
    WHERE NOT EXISTS (
      SELECT 1 FROM old_concept_need_share ns JOIN old_concept_need n ON n.id = ns.need_id
      WHERE ns.session_id = sp."sessionId" AND lower(n.label) = lower(x.lbl))
  ), '{}') AS unresolved_need_labels,
  sp."removedAt" AS removed_at,
  rp.id AS removed_by_participant_id,
  sp."removalReason" AS removal_reason,
  NULL::timestamp AS shared_at,
  sp."createdAt" AS created_at,
  sp."updatedAt" AS updated_at
FROM "StrategyProposal" sp
LEFT JOIN old_concept_participant cp ON cp.session_id = sp."sessionId" AND cp.user_id = sp."createdByUserId"
LEFT JOIN old_concept_participant rp ON rp.session_id = sp."sessionId" AND rp.user_id = sp."removedByUserId";


-- ----------------------------------------------------------------------------
-- proposal_need — spec §1.4 `proposal_need`, Absorbs: StrategyProposalNeed +
-- resolvable needsAddressed[] labels, both filtered to SHARED needs. Plan step
-- 13. created_at: the junction row's, or the proposal's for a label match.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_proposal_need AS
SELECT proposal_id, need_id, min(created_at) AS created_at
FROM (
  SELECT spn."proposalId" AS proposal_id, spn."needId" AS need_id, spn."createdAt" AS created_at
  FROM "StrategyProposalNeed" spn
  JOIN old_concept_need_share ns ON ns.need_id = spn."needId"
  UNION ALL
  SELECT sp.id, ns.need_id, sp."createdAt"
  FROM "StrategyProposal" sp
  CROSS JOIN LATERAL unnest(coalesce(sp."needsAddressed", '{}')) AS x(lbl)
  JOIN old_concept_need_share ns ON ns.session_id = sp."sessionId"
  JOIN old_concept_need n ON n.id = ns.need_id AND lower(n.label) = lower(x.lbl)
) u
GROUP BY proposal_id, need_id;


-- ----------------------------------------------------------------------------
-- proposal_choice — spec §1.4 `proposal_choice`, Absorbs:
-- `Stage4ProposalSelection` (StrategyRanking is not absorbed). Plan step 13.
-- created_at ← selectedAt.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_proposal_choice AS
SELECT
  s."proposalId" AS proposal_id,
  p.id AS participant_id,
  s.decision::text AS decision,
  s.note,
  s."selectedAt" AS created_at,
  s."updatedAt"  AS updated_at
FROM "Stage4ProposalSelection" s
LEFT JOIN old_concept_participant p ON p.session_id = s."sessionId" AND p.user_id = s."userId";


-- ----------------------------------------------------------------------------
-- agreement — spec §1.4 `agreement`, Absorbs: `Agreement` minus
-- agreedByA/B/agreedAt (→ agreement_party), minus sharedVesselId. Plan §3
-- precheck + step 13: session via SharedVessel; PROPOSED with both parties
-- agreed → AGREED, any other PROPOSED row is dropped (an agreement nobody
-- accepted is just its proposal). follow_up_at ← followUpDate.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_agreement AS
SELECT
  a.id,
  sv."sessionId" AS session_id,
  a."proposalId" AS proposal_id,
  a.type::text AS type,
  CASE WHEN a.status::text = 'PROPOSED' THEN 'AGREED' ELSE a.status::text END AS status,
  a.description,
  a.duration,
  a."measureOfSuccess" AS measure_of_success,
  a."followUpDate" AS follow_up_at,
  a."completedAt"  AS completed_at
FROM "Agreement" a
JOIN "SharedVessel" sv ON sv.id = a."sharedVesselId"
WHERE a.status::text <> 'PROPOSED' OR (a."agreedByA" AND a."agreedByB");


-- ----------------------------------------------------------------------------
-- agreement_party — spec §1.4 `agreement_party`, Absorbs:
-- Agreement.agreedByA/agreedByB/agreedAt. Plan step 5 (_ab_slot): slot A is
-- the first RelationshipMember of the session's relationship by joinedAt,
-- ties broken by ctid (physical order — what Prisma returned to getUserSlot on
-- a tie); slot B the second. agreed_at ← Agreement.agreedAt.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_agreement_party AS
WITH slot AS (
  SELECT s.id AS session_id, rm."userId" AS user_id,
         row_number() OVER (PARTITION BY s.id ORDER BY rm."joinedAt", rm.ctid) AS n
  FROM "Session" s JOIN "RelationshipMember" rm ON rm."relationshipId" = s."relationshipId"
)
SELECT ag.id AS agreement_id, p.id AS participant_id, a."agreedAt" AS agreed_at
FROM old_concept_agreement ag
JOIN "Agreement" a ON a.id = ag.id
JOIN slot ON slot.session_id = ag.session_id
         AND ((slot.n = 1 AND a."agreedByA") OR (slot.n = 2 AND a."agreedByB"))
JOIN old_concept_participant p ON p.session_id = ag.session_id AND p.user_id = slot.user_id;


-- ----------------------------------------------------------------------------
-- consent — spec §1.3 `consent`, Absorbs: `ConsentRecord` (polymorphic
-- targetType/targetId → arc; metadata dropped), ConsentedContent's
-- consentActive/revokedAt (→ need_share). Plan step 12.
--
-- target_kind (spec §3 consent_target): IDENTIFIED_NEED → NEED,
-- EMPATHY_ATTEMPT/EMPATHY_DRAFT → EMPATHY_ATTEMPT, STRATEGY_PROPOSAL →
-- PROPOSAL. EVENT_SUMMARY/EMOTIONAL_PATTERN/BOUNDARY have no target (the
-- plan's precheck expects none) and project with target_kind NULL and an
-- empty arc rather than being dropped, and `concept_check_consent_unresolved_arc`
-- fails the snapshot on them (and on any targetId that does not resolve).
-- Arc resolution ("targetId text → uuid resolved against the target table"):
--   NEED            → the IdentifiedNeed with that id;
--   EMPATHY_ATTEMPT → the EmpathyAttempt with that id; for EMPATHY_DRAFT (the
--                     target id names a draft) the attempt submitted from it
--                     (draftId), else the draft author's attempt in the
--                     session (old @@unique(sessionId, sourceUserId));
--   PROPOSAL        → the StrategyProposal with that id.
-- participant: (sessionId, userId); a NULL sessionId is taken from the
-- resolved target. requested_by kept only for NEED/PROPOSAL/EMPATHY_ATTEMPT —
-- which, after the mapping above, is every kind with a target.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_consent AS
WITH c AS (
  SELECT cr.*,
         CASE cr."targetType"::text
           WHEN 'IDENTIFIED_NEED'   THEN 'NEED'
           WHEN 'EMPATHY_ATTEMPT'   THEN 'EMPATHY_ATTEMPT'
           WHEN 'EMPATHY_DRAFT'     THEN 'EMPATHY_ATTEMPT'
           WHEN 'STRATEGY_PROPOSAL' THEN 'PROPOSAL'
         END AS target_kind,
         lower(cr."targetId") AS tid
  FROM "ConsentRecord" cr
),
arc AS (
  SELECT c.*,
         CASE WHEN c.target_kind = 'NEED' THEN
           (SELECT n.id FROM "IdentifiedNeed" n WHERE n.id::text = c.tid) END AS need_id,
         CASE WHEN c.target_kind = 'EMPATHY_ATTEMPT' THEN coalesce(
           (SELECT a.id FROM "EmpathyAttempt" a WHERE a.id::text = c.tid),
           (SELECT a.id FROM "EmpathyAttempt" a WHERE a."draftId"::text = c.tid),
           (SELECT a.id FROM "EmpathyDraft" d JOIN "EmpathyAttempt" a
              ON a."sessionId" = d."sessionId" AND a."sourceUserId" = d."userId"
             WHERE d.id::text = c.tid)) END AS empathy_attempt_id,
         CASE WHEN c.target_kind = 'PROPOSAL' THEN
           (SELECT sp.id FROM "StrategyProposal" sp WHERE sp.id::text = c.tid) END AS proposal_id
  FROM c
),
sess AS (
  SELECT arc.*,
         coalesce(arc."sessionId",
           (SELECT uv."sessionId" FROM "IdentifiedNeed" n JOIN "UserVessel" uv ON uv.id = n."vesselId" WHERE n.id = arc.need_id),
           (SELECT a."sessionId" FROM "EmpathyAttempt" a WHERE a.id = arc.empathy_attempt_id),
           (SELECT d."sessionId" FROM "EmpathyDraft" d WHERE d.id::text = arc.tid),
           (SELECT sp."sessionId" FROM "StrategyProposal" sp WHERE sp.id = arc.proposal_id)) AS session_id
  FROM arc
)
SELECT
  s.id,
  p.id AS participant_id,
  CASE WHEN s.target_kind IN ('NEED','PROPOSAL','EMPATHY_ATTEMPT') THEN rp.id END AS requested_by_participant_id,
  s.need_id,
  s.empathy_attempt_id,
  s.proposal_id,
  NULL::uuid AS share_offer_id,
  NULL::uuid AS review_id,
  s.target_kind,
  s.decision::text AS decision,
  s."decidedAt" AS decided_at,
  s."revokedAt" AS revoked_at,
  s."createdAt" AS created_at
FROM sess s
LEFT JOIN old_concept_participant p  ON p.session_id  = s.session_id AND p.user_id  = s."userId"
LEFT JOIN old_concept_participant rp ON rp.session_id = s.session_id AND rp.user_id = s."requestedByUserId";


-- Plan §3 precheck: "every ConsentRecord.targetType ∈ {IDENTIFIED_NEED,
-- EMPATHY_ATTEMPT, EMPATHY_DRAFT, STRATEGY_PROPOSAL} and targetId resolves",
-- i.e. the target's `num_nonnulls(arc) = 1`. A consent with no target kind or
-- an all-NULL arc (the normaliser would otherwise rank it `#n`) fails the
-- snapshot; so does a consent with no deciding participant.
CREATE VIEW concept_check_consent_unresolved_arc AS
SELECT id, target_kind, participant_id IS NULL AS no_participant
FROM old_concept_consent
WHERE target_kind IS NULL
   OR participant_id IS NULL
   OR num_nonnulls(need_id, empathy_attempt_id, proposal_id, share_offer_id, review_id) <> 1;


-- ----------------------------------------------------------------------------
-- reflection — spec §1.6 `reflection`, Absorbs: `InnerWorkSession` minus
-- linkedAtStage, linkedTrigger, contentEmbedding, linkedAtMessageId. Plan step
-- 15: summary_doc parsed from conversationSummary (NULL where it is not a JSON
-- object — the migration RAISEs instead); linked_at ← updatedAt of the
-- linking row; context_snapshot ← contextSummarySnapshot.
-- ----------------------------------------------------------------------------
CREATE VIEW old_concept_reflection AS
SELECT
  w.id,
  w."userId" AS user_id,
  w.title,
  w.theme,
  w.status::text AS status,
  w.summary,
  CASE WHEN w."conversationSummary" IS JSON OBJECT THEN w."conversationSummary"::jsonb END AS summary_doc,
  w."linkedPartnerSessionId" AS linked_session_id,
  CASE WHEN w."linkedPartnerSessionId" IS NOT NULL THEN w."updatedAt" END AS linked_at,
  w."contextSummarySnapshot" AS context_snapshot,
  w."distilledAt" AS distilled_at,
  w."createdAt" AS created_at,
  w."updatedAt" AS updated_at
FROM "InnerWorkSession" w;


-- reflection_message — spec §1.6, Absorbs: `InnerWorkMessage` (never `message`).
CREATE VIEW old_concept_reflection_message AS
SELECT m.id, m."sessionId" AS reflection_id, m.role::text AS role, m.content, m."timestamp" AS created_at
FROM "InnerWorkMessage" m;


-- takeaway — spec §1.6, Absorbs: `SessionTakeaway` minus embedding (its
-- sessionId is the InnerWorkSession). `resolved` is folded into resolved_at.
CREATE VIEW old_concept_takeaway AS
SELECT
  t.id,
  t."sessionId" AS reflection_id,
  t.content,
  t.theme,
  t.source::text AS source,
  t.type::text AS type,
  t.position,
  t."resolvedAt" AS resolved_at,
  t."createdAt" AS created_at,
  t."updatedAt" AS updated_at
FROM "SessionTakeaway" t;


-- takeaway_link — spec §1.6, Absorbs: `TakeawayLink` (surrogate id dropped).
CREATE VIEW old_concept_takeaway_link AS
SELECT l."sourceId" AS source_id, l."targetId" AS target_id, l."linkType"::text AS link_type, l.similarity, l."createdAt" AS created_at
FROM "TakeawayLink" l;
