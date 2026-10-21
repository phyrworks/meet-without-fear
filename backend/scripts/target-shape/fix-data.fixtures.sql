-- ============================================================================
-- fix-data.fixtures.sql — the fix-data template FILLED IN for the scratch
-- database run-target-migration.sh seeds from the current-shape state
-- factory (all 13 TargetStages, with and without a partner). NEVER for
-- production: it refuses to run outside a ts7_* database.
--
-- Each block answers one precheck that fires on the seeded fixtures — the
-- fixtures are not production, and these are the states only the fixture
-- writer produces (see backend/src/testing/fixture-scenarios/current-shape.ts
-- and scenarios.ts on phoenix/base). The template
-- (fix-data.template.sql) has a block for every precheck; this file fills in
-- the five that fire here, so the migration can then apply with zero RAISE.
-- ============================================================================

DO $$
BEGIN
  IF current_database() !~ '^ts7_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'fix-data.fixtures.sql only runs on a ts7_* scratch database, not %', current_database();
  END IF;
END
$$;

-- user_name_mismatch (P05) — the factory writes User.name and leaves
-- firstName/lastName NULL (current-shape.ts:344 upsert). Write the split names
-- (plan step 1: "mismatches are fixed by writing the split names first"):
-- first word → firstName, the rest → lastName.
UPDATE "User"
SET "firstName" = split_part(trim(name), ' ', 1),
    "lastName"  = nullif(trim(substr(trim(name), length(split_part(trim(name), ' ', 1)) + 1)), '')
WHERE name IS DISTINCT FROM nullif(trim(coalesce("firstName", '') || ' ' || coalesce("lastName", '')), '')
  AND name IS NOT NULL;

-- attempt_revealed_without_revealed_at (P15d) — the factory marks attempts
-- VALIDATED without stamping revealedAt (EMPATHY_REVEALED and later stages).
-- A validated attempt was revealed no later than its validation: use the
-- subject's validation time, else its delivery time, else its submission.
UPDATE "EmpathyAttempt" a
SET "revealedAt" = coalesce(
      (SELECT min(v."validatedAt") FROM "EmpathyValidation" v WHERE v."attemptId" = a.id),
      a."deliveredAt",
      a."sharedAt")
WHERE a.status IN ('REVEALED', 'VALIDATED') AND a."revealedAt" IS NULL;

-- session_without_two_participants (P13) and
-- invitation_accepted_without_unique_acceptor (P14b) — without a partner
-- account the factory still marks partner-required stages ACTIVE with an
-- ACCEPTED invitation that nobody accepted (scenarios.ts PARTNER_REQUIRED).
-- The true state is "invited, not yet accepted".
UPDATE "Invitation" i
SET status = 'PENDING', "acceptedAt" = NULL
FROM "Session" s
WHERE s.id = i."sessionId" AND i.status = 'ACCEPTED'
  AND (SELECT count(*) FROM "RelationshipMember" m WHERE m."relationshipId" = s."relationshipId" AND m."userId" <> i."invitedById") = 0;
UPDATE "Session" s
SET status = 'INVITED'
WHERE s.status IN ('ACTIVE', 'WAITING', 'PAUSED')
  AND (SELECT count(*) FROM "RelationshipMember" m WHERE m."relationshipId" = s."relationshipId") < 2
  AND NOT EXISTS (SELECT 1 FROM "StageProgress" sp WHERE sp."sessionId" = s.id AND sp."userId" NOT IN
                  (SELECT m."userId" FROM "RelationshipMember" m WHERE m."relationshipId" = s."relationshipId"));

-- attempt_without_unique_subject (P15b) and empathy_draft_without_unique_subject
-- (P15c) — EMPATHY_SHARED_A without a partner: an empathy attempt (and its
-- draft and EMPATHY_DRAFT consent) about nobody. The target cannot hold an
-- attempt without a subject; the statement itself stays in the author's chat
-- (the EMPATHY_STATEMENT message, whose source_attempt_id becomes NULL).
DELETE FROM "ConsentRecord" c
USING "EmpathyDraft" d
WHERE c."targetType" = 'EMPATHY_DRAFT' AND c."targetId" = d.id::text
  AND NOT EXISTS (SELECT 1 FROM "RelationshipMember" m JOIN "Session" s ON s."relationshipId" = m."relationshipId"
                  WHERE s.id = d."sessionId" AND m."userId" <> d."userId");
DELETE FROM "EmpathyAttempt" a
WHERE NOT EXISTS (SELECT 1 FROM "RelationshipMember" m JOIN "Session" s ON s."relationshipId" = m."relationshipId"
                  WHERE s.id = a."sessionId" AND m."userId" <> a."sourceUserId");
DELETE FROM "EmpathyDraft" d
WHERE NOT EXISTS (SELECT 1 FROM "RelationshipMember" m JOIN "Session" s ON s."relationshipId" = m."relationshipId"
                  WHERE s.id = d."sessionId" AND m."userId" <> d."userId");
