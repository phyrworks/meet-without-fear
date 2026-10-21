/**
 * (0) guard and (2a) the migration workspace: schema app_migration, its
 * bookkeeping tables (kept for TS-8, ruling R14), work tables and helper
 * functions (dropped at the end), step 0's row counts, and the (session, user)
 * pair set every later step resolves participants from.
 */

import { OLD_TABLES, litArr } from './maps';

export function guard(): string {
  return `
-- Refuse to run anywhere but the expected current shape: all 68 old tables,
-- nothing else in public (a stray view over an old table would block the
-- drops in step 19 — e.g. the golden harness's old_concept_* views), the roles
-- the trailer grants to, and the TS-1 app schema.
DO $$
DECLARE
  missing text;
  extra   text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r) INTO missing
  FROM unnest(ARRAY['mwf_app', 'mwf_job', 'mwf_ops', 'mwf_auth']) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'target_shape: database role(s) % do not exist', missing
      USING HINT = 'Apply infra/aws/roles.sql first (see migration 20261019173038_phase3_app_schema_helpers).';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'mwf_job', 'SET') THEN
    RAISE EXCEPTION 'target_shape: role % cannot SET ROLE mwf_job (needed to hand the app.* helpers to mwf_job)', current_user;
  END IF;
  IF to_regnamespace('app') IS NULL THEN
    RAISE EXCEPTION 'target_shape: schema app is missing (migration 20261019173038_phase3_app_schema_helpers not applied)';
  END IF;
  IF to_regnamespace('app_migration') IS NOT NULL THEN
    RAISE EXCEPTION 'target_shape: schema app_migration already exists (a previous run''s verification schema; TS-8 drops it)';
  END IF;
  SELECT string_agg(t, ', ' ORDER BY t) INTO missing
  FROM unnest(${litArr(OLD_TABLES)}) AS t
  WHERE to_regclass(format('public.%I', t)) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'target_shape: not at the expected current shape; missing table(s): %', missing;
  END IF;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO extra
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND c.relname <> ALL (${litArr([...OLD_TABLES, '_prisma_migrations'])});
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'target_shape: unexpected relation(s) in schema public: %', extra
      USING HINT = 'Drop harness views (old_concept_*) and any ad-hoc tables before migrating.';
  END IF;
END
$$;
`;
}

export function workspace(): string {
  return `
-- app_migration holds what the after-phase verify script (TS-8) reads —
-- shape_map, row_counts, report — and is dropped by TS-8 as its last step
-- (ruling R14). No grants to mwf_app. The work tables and helper functions are
-- dropped at the end of this migration.
CREATE SCHEMA app_migration;
REVOKE ALL ON SCHEMA app_migration FROM PUBLIC;
COMMENT ON SCHEMA app_migration IS
  'target_shape migration bookkeeping (shape_map, row_counts, report) for verify-target-migration.sql (TS-8), which drops this schema.';

-- Every id the migration minted (plan §3 id policy), keyed by what it replaces.
CREATE TABLE app_migration.shape_map (
  concept text NOT NULL,
  old_key text NOT NULL,
  new_id  uuid NOT NULL,
  PRIMARY KEY (concept, old_key)
);
-- Row counts: phase 'before' = the 68 old tables (step 0), 'after' = the 47 new ones (step 18).
CREATE TABLE app_migration.row_counts (
  phase      text   NOT NULL,
  table_name text   NOT NULL,
  n          bigint NOT NULL,
  PRIMARY KEY (phase, table_name)
);
-- Listed-not-fatal items: dropped rows, added rows, tie-breaks taken, mapping counts.
CREATE TABLE app_migration.report (
  seq    bigserial PRIMARY KEY,
  step   text   NOT NULL,
  item   text   NOT NULL,
  n      bigint NOT NULL,
  detail text
);

-- User-written text the target has no column for (ruling R-c): kept here,
-- never silently dropped, for the owner to decide at TS-14. No grants.
CREATE TABLE app_migration.dropped_content (
  concept    text NOT NULL,
  session_id uuid,
  user_id    uuid,
  text       text NOT NULL,
  written_at timestamptz,
  candidates jsonb            -- R16: the users a row could belong to, when it is not attributable exactly
);

-- Work tables (dropped at the end of the migration).
CREATE TABLE app_migration.precheck (
  check_name text NOT NULL,
  offender   text NOT NULL,
  detail     text
);
CREATE TABLE app_migration.ab_slot (
  session_id     uuid    NOT NULL,
  slot           text    NOT NULL CHECK (slot IN ('A', 'B')),
  participant_id uuid    NOT NULL,
  tied           boolean NOT NULL,
  PRIMARY KEY (session_id, slot)
);
-- Old facts the trailer's view-based assertions compare against (the old tables are gone by then).
CREATE TABLE app_migration.old_closure (
  session_id              uuid PRIMARY KEY,
  shared_agreement_ids    uuid[] NOT NULL,
  individual_proposal_ids uuid[] NOT NULL,
  open_need_ids           uuid[] NOT NULL
);
CREATE TABLE app_migration.old_cycle (
  follow_up_id uuid PRIMARY KEY,
  cycle_id     uuid NOT NULL,
  status       text NOT NULL
);
-- Old (check-in, entry) pairs → new follow_up_checkin rows (step 14).
CREATE TABLE app_migration.checkin_map (
  checkin_id   uuid,            -- NULL for a synthetic check-in (orphan TendingResponse)
  entry_id     uuid NOT NULL,
  user_id      uuid NOT NULL,
  session_id   uuid NOT NULL,
  submitted_at timestamptz NOT NULL,
  is_first     boolean NOT NULL, -- the row that carries the check-in's entry-less children
  new_id       uuid NOT NULL UNIQUE,
  UNIQUE (entry_id, user_id)
);

${helperFns('app_migration')}
-- uuidv7 whose embedded time is ts (as the uuid migration minted ids).
CREATE FUNCTION app_migration.mint(ts timestamptz) RETURNS uuid
  LANGUAGE sql VOLATILE
  AS $$ SELECT uuidv7(coalesce(ts, clock_timestamp()) - clock_timestamp()) $$;

CREATE FUNCTION app_migration.assert(ok boolean, msg text) RETURNS void
  LANGUAGE plpgsql
  AS $$ BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'target_shape: %', msg; END IF; END $$;

-- An enum mapping met a value it has no target for.
CREATE FUNCTION app_migration.unmapped(what text, v text) RETURNS text
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'target_shape: unmapped value % for %', v, what; END $$;

CREATE FUNCTION app_migration.note(p_step text, p_item text, p_n bigint, p_detail text DEFAULT NULL) RETURNS void
  LANGUAGE sql
  AS $$ INSERT INTO app_migration.report (step, item, n, detail) VALUES (p_step, p_item, p_n, p_detail) $$;

${beforeCounts('app_migration')}
${pairSet('app_migration')}
${evidenceSrc('app_migration')}
${ownerlessSrc('app_migration')}
`;
}

/** as_uuid, jnull, ts — shared by the migration (ns app_migration) and the fix-data template (ns pg_temp). */
export function helperFns(ns: string): string {
  return `CREATE FUNCTION ${ns}.as_uuid(v text) RETURNS uuid
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT CASE WHEN v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v::uuid END $$;

-- JSON null (Prisma JsonNull) is SQL NULL in the target.
CREATE FUNCTION ${ns}.jnull(j jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT CASE WHEN jsonb_typeof(j) = 'null' THEN NULL ELSE j END $$;

-- An ISO timestamp inside a gate document; NULL when absent or not a timestamp.
CREATE FUNCTION ${ns}.ts(j jsonb) RETURNS timestamptz
  LANGUAGE sql STABLE
  AS $$ SELECT CASE WHEN jsonb_typeof(j) = 'string' AND pg_input_is_valid(j #>> '{}', 'timestamptz')
                    THEN (j #>> '{}')::timestamptz END $$;
`;
}

/** Step 0: row counts of all 68 old tables into <ns>.row_counts (phase 'before'). */
export function beforeCounts(ns: string): string {
  return `-- Step 0: row counts of all 68 old tables.
DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ${litArr(OLD_TABLES)} LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    INSERT INTO ${ns}.row_counts VALUES ('before', t, n);
  END LOOP;
END
$$;
`;
}

/** The (session, user) pair set (<ns>.su) and the views pair / vanished over it. */
export function pairSet(ns: string): string {
  return `CREATE TABLE ${ns}.su (
  session_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  source     text NOT NULL
);
-- Every (session, user) pair any old row names (plan step 4: the participant
-- set; the plan's union, extended to every old userId + sessionId pair so its
-- assertion "every pair resolves to exactly one participant" can hold). Text
-- ids that are not uuid-shaped drop out here and are reported by the step-17
-- precheck. Users with no "User" row are the vanished members (step 4a).
INSERT INTO ${ns}.su (session_id, user_id, source)
SELECT DISTINCT session_id, user_id, source FROM (
  SELECT "sessionId" AS session_id, "userId" AS user_id, 'StageProgress' AS source FROM "StageProgress"
  UNION ALL SELECT "sessionId", "userId", 'UserVessel' FROM "UserVessel"
  UNION ALL SELECT "sessionId", "userId", 'EmpathyDraft' FROM "EmpathyDraft"
  UNION ALL SELECT "sessionId", "userId", 'Stage4ProposalSelection' FROM "Stage4ProposalSelection"
  UNION ALL SELECT "sessionId", "userId", 'TendingCheckin' FROM "TendingCheckin"
  UNION ALL SELECT "sessionId", ${ns}.as_uuid("forUserId"), 'Message.forUserId' FROM "Message"
  UNION ALL SELECT "sessionId", "senderId", 'Message.senderId' FROM "Message"
  UNION ALL SELECT s.id, m."userId", 'RelationshipMember'
    FROM "Session" s JOIN "RelationshipMember" m ON m."relationshipId" = s."relationshipId"
  UNION ALL SELECT "sessionId", "sourceUserId", 'EmpathyAttempt' FROM "EmpathyAttempt"
  UNION ALL SELECT "sessionId", "userId", 'EmpathyValidation' FROM "EmpathyValidation"
  UNION ALL SELECT "sessionId", ${ns}.as_uuid("guesserId"), 'ReconcilerResult.guesserId' FROM "ReconcilerResult"
  UNION ALL SELECT "sessionId", ${ns}.as_uuid("subjectId"), 'ReconcilerResult.subjectId' FROM "ReconcilerResult"
  UNION ALL SELECT r."sessionId", ${ns}.as_uuid(o."userId"), 'ReconcilerShareOffer.userId'
    FROM "ReconcilerShareOffer" o JOIN "ReconcilerResult" r ON r.id = o."resultId"
  UNION ALL SELECT "sessionId", "userId", 'ConsentRecord.userId' FROM "ConsentRecord"
  UNION ALL SELECT "sessionId", "requestedByUserId", 'ConsentRecord.requestedByUserId' FROM "ConsentRecord"
  UNION ALL SELECT "sessionId", "createdByUserId", 'StrategyProposal.createdByUserId' FROM "StrategyProposal"
  UNION ALL SELECT "sessionId", "removedByUserId", 'StrategyProposal.removedByUserId' FROM "StrategyProposal"
  UNION ALL SELECT "sessionId", "userId", 'StrategyRanking' FROM "StrategyRanking"
  UNION ALL SELECT p."sessionId", ${ns}.as_uuid(r."actorUserId"), 'Stage4ProposalRevision.actorUserId'
    FROM "Stage4ProposalRevision" r JOIN "StrategyProposal" p ON p.id = r."proposalId"
  UNION ALL SELECT "sessionId", ${ns}.as_uuid("userId"), 'Stage4NeedDeclination.userId' FROM "Stage4NeedDeclination"
  UNION ALL SELECT "sessionId", ${ns}.as_uuid("closedByUserId"), 'Stage4Closure.closedByUserId' FROM "Stage4Closure"
  UNION ALL SELECT "sessionId", "userId", 'Stage4SubChat' FROM "Stage4SubChat"
  UNION ALL SELECT "sessionId", ${ns}.as_uuid("ownerUserId"), 'TendingEntry.ownerUserId' FROM "TendingEntry"
  UNION ALL SELECT e."sessionId", r."userId", 'TendingResponse'
    FROM "TendingResponse" r JOIN "TendingEntry" e ON e.id = r."tendingEntryId"
  UNION ALL SELECT e."sessionId", o."userId", 'TendingEntryOutcome'
    FROM "TendingEntryOutcome" o JOIN "TendingEntry" e ON e.id = o."tendingEntryId"
  UNION ALL SELECT "sessionId", ${ns}.as_uuid("sourceUserId"), 'TendingNeedOutcome.sourceUserId' FROM "TendingNeedOutcome"
  UNION ALL SELECT "sessionId", "userId", 'TendingReminder' FROM "TendingReminder"
  UNION ALL SELECT "sessionId", "userId", 'TendingAdjustment' FROM "TendingAdjustment"
  UNION ALL SELECT "sessionId", "userId", 'TendingBetweenPeriodNote' FROM "TendingBetweenPeriodNote"
  UNION ALL SELECT "sessionId", "createdByUserId", 'TendingCoordinationCycle.createdByUserId' FROM "TendingCoordinationCycle"
  UNION ALL SELECT "sessionId", "userId", 'EmotionalExerciseCompletion' FROM "EmotionalExerciseCompletion"
  UNION ALL SELECT "sessionId", "userId", 'ValidationFeedbackDraft' FROM "ValidationFeedbackDraft"
  UNION ALL SELECT "sessionId", "invitedById", 'Invitation.invitedById' FROM "Invitation"
  UNION ALL SELECT v."sessionId", v."userId", 'EmotionalReading'
    FROM "EmotionalReading" e JOIN "UserVessel" v ON v.id = e."vesselId"
) x
WHERE session_id IS NOT NULL AND user_id IS NOT NULL;
CREATE INDEX ON ${ns}.su (session_id, user_id);

-- The distinct pairs, and the vanished users among them (no "User" row).
CREATE VIEW ${ns}.pair AS
  SELECT DISTINCT session_id, user_id FROM ${ns}.su;
CREATE VIEW ${ns}.vanished AS
  SELECT DISTINCT su.user_id FROM ${ns}.su
  WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = su.user_id);
`;
}

/**
 * EmpathyAttempt / EmpathyValidation with the author / reviewer a vanished
 * member's deletion nulled (SetNull) recovered from surviving evidence
 * (review D2): a NULL-author attempt belongs to the session's one vanished
 * member who has no other attempt there (when the session has exactly one
 * such attempt and one such member); a NULL reviewer is the attempt's one
 * other participant. Every later step reads these instead of the raw tables;
 * what stays NULL is refused by P15a / P16a.
 */
export function evidenceSrc(ns: string): string {
  return `CREATE TABLE ${ns}.empathy_attempt_src AS
SELECT a.id, a."draftId", a."sessionId",
       coalesce(a."sourceUserId",
         CASE WHEN (SELECT count(*) FROM "EmpathyAttempt" o WHERE o."sessionId" = a."sessionId" AND o."sourceUserId" IS NULL) = 1
              THEN (SELECT CASE WHEN count(*) = 1 THEN min(v.user_id::text)::uuid END
                    FROM ${ns}.vanished v JOIN ${ns}.pair p ON p.user_id = v.user_id AND p.session_id = a."sessionId"
                    WHERE NOT EXISTS (SELECT 1 FROM "EmpathyAttempt" o WHERE o."sessionId" = a."sessionId" AND o."sourceUserId" = v.user_id))
         END) AS "sourceUserId",
       (a."sourceUserId" IS NULL) AS author_recovered,
       a.content, a."sharedAt", a."consentRecordId", a.status, a."statusVersion", a."revealedAt", a."revisionCount",
       a."deliveryStatus", a."deliveredAt", a."seenAt"
FROM "EmpathyAttempt" a;
CREATE TABLE ${ns}.empathy_validation_src AS
SELECT v.id, v."attemptId", v."sessionId",
       coalesce(v."userId",
         (SELECT CASE WHEN count(DISTINCT p.user_id) = 1 THEN min(p.user_id::text)::uuid END
          FROM ${ns}.pair p JOIN ${ns}.empathy_attempt_src a ON a.id = v."attemptId"
          WHERE p.session_id = v."sessionId" AND p.user_id IS DISTINCT FROM a."sourceUserId")) AS "userId",
       (v."userId" IS NULL) AS reviewer_recovered,
       v.validated, v.feedback, v."feedbackShared", v."validatedAt"
FROM "EmpathyValidation" v;
`;
}

/**
 * Messages with neither forUserId nor senderId (ruling R16: an AI/SYSTEM row
 * is private material of the user whose turn produced it; attribution is
 * exact or nothing). The old Message model has no turn or thread key
 * (verified on phoenix/base: id, sessionId, senderId, forUserId, role,
 * content, contentHash, stage, timestamp, refiningNeedId, extracted*;
 * turnId exists only on BrainActivity, from 2026-01-12). So an AI/SYSTEM row
 * is attributed only when exactly one user could have had the turn: the
 * session's users, minus every non-inviter before the session's invitation
 * was accepted (the invitee cannot chat before joining). A human-authored row
 * (USER or an event role) whose sender was nulled belongs to a deleted user:
 * its candidates are the session's vanished users, and it is never
 * attributed. exact_user is the one candidate of an attributable AI/SYSTEM row.
 *
 * Exactness rests on precheck P13 session_without_two_participants. The
 * candidates come from the pair set, i.e. from the users the old rows still
 * name. A member who left no trace there is invisible, and their session
 * would show a single candidate: an AI reply that was theirs would be
 * attributed, wrongly, to the one visible user. P13 RAISEs for every live or
 * resolved session (ACTIVE, WAITING, PAUSED, RESOLVED) with fewer than two
 * distinct users in the pair set. A non-terminal session with a vanished
 * member is exempt, because the vanished member is in the pair set by
 * definition. So in those sessions a single candidate means a one-user
 * session or a pre-acceptance row, never a hidden partner. If P13 is relaxed
 * or bypassed (for example a fix-data file that deletes its offenders'
 * evidence instead of repairing it), this attribution stops being exact.
 * CREATED/INVITED/ABANDONED/ARCHIVED sessions are outside P13. Their single
 * candidate is the only user the data knows, and for CREATED/INVITED that is
 * the inviter.
 */
export function ownerlessSrc(ns: string): string {
  return `CREATE TABLE ${ns}.ownerless AS
WITH m AS (
  SELECT id, "sessionId" AS session_id, role::text AS role, "timestamp" AS ts
  FROM "Message" WHERE "forUserId" IS NULL AND "senderId" IS NULL
), inv AS (
  SELECT DISTINCT ON (i."sessionId") i."sessionId" AS session_id, i."invitedById" AS inviter,
         (SELECT min(j."acceptedAt") FROM "Invitation" j WHERE j."sessionId" = i."sessionId" AND j.status = 'ACCEPTED') AS accepted_at
  FROM "Invitation" i ORDER BY i."sessionId", i."createdAt", i.id
)
SELECT m.id AS message_id, m.session_id, m.role, m.ts, c.candidates,
       CASE WHEN m.role IN ('AI', 'SYSTEM') AND cardinality(c.candidates) = 1 THEN c.candidates[1] END AS exact_user,
       EXISTS (SELECT 1 FROM ${ns}.pair p JOIN ${ns}.vanished v USING (user_id) WHERE p.session_id = m.session_id) AS vanished_session
FROM m
LEFT JOIN inv ON inv.session_id = m.session_id
CROSS JOIN LATERAL (
  SELECT coalesce(array_agg(u.user_id ORDER BY u.user_id), '{}') AS candidates
  FROM (SELECT DISTINCT p.user_id FROM ${ns}.pair p WHERE p.session_id = m.session_id) u
  WHERE CASE WHEN m.role IN ('AI', 'SYSTEM')
             THEN NOT (inv.inviter IS NOT NULL AND u.user_id <> inv.inviter AND (inv.accepted_at IS NULL OR m.ts < inv.accepted_at))
             ELSE u.user_id IN (SELECT v.user_id FROM ${ns}.vanished v)
        END
) c;
`;
}
