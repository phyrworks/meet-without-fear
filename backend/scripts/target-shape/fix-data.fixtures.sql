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

-- The no-partner seeds (user A a.<stage>.nob@e2e.test): the only sessions the
-- next two blocks may touch — every other session is real-shaped (and the
-- extras' vanished-member sessions must reach the migration as they are).
CREATE TEMP TABLE nob_session AS
SELECT s.id FROM "Session" s
JOIN "RelationshipMember" m ON m."relationshipId" = s."relationshipId"
JOIN "User" u ON u.id = m."userId"
WHERE u.email ~ '^a\.[a-z0-9-]+\.nob@e2e\.test$';

-- session_without_two_participants (P13) and
-- invitation_accepted_without_unique_acceptor (P14b) — without a partner
-- account the factory still marks partner-required stages ACTIVE with an
-- ACCEPTED invitation that nobody accepted (scenarios.ts PARTNER_REQUIRED).
-- The true state is "invited, not yet accepted".
UPDATE "Invitation" i SET status = 'PENDING', "acceptedAt" = NULL
WHERE i.status = 'ACCEPTED' AND i."sessionId" IN (SELECT id FROM nob_session);
UPDATE "Session" s SET status = 'INVITED'
WHERE s.status IN ('ACTIVE', 'WAITING', 'PAUSED') AND s.id IN (SELECT id FROM nob_session);

-- attempt_without_unique_subject (P15b) and empathy_draft_without_unique_subject
-- (P15c) — EMPATHY_SHARED_A without a partner: an empathy attempt (and its
-- draft and EMPATHY_DRAFT consent) about nobody. The target cannot hold an
-- attempt without a subject; the statement itself stays in the author's chat
-- (the EMPATHY_STATEMENT message, whose source_attempt_id becomes NULL).
DELETE FROM "ConsentRecord" c
USING "EmpathyDraft" d
WHERE c."targetType" = 'EMPATHY_DRAFT' AND c."targetId" = d.id::text AND d."sessionId" IN (SELECT id FROM nob_session);
DELETE FROM "EmpathyAttempt" a WHERE a."sessionId" IN (SELECT id FROM nob_session);
DELETE FROM "EmpathyDraft" d WHERE d."sessionId" IN (SELECT id FROM nob_session);

-- message_without_owner (P33) — seed-extras.sql's pre-2026-style AI row in a
-- live session (forUserId arrived 2026-01-02 without a backfill). The
-- template's rule: the sender of the nearest earlier USER message with a
-- sender in the session, else the nearest later one.
UPDATE "Message" m SET "forUserId" = coalesce(
    (SELECT u."senderId" FROM "Message" u WHERE u."sessionId" = m."sessionId" AND u.role = 'USER' AND u."senderId" IS NOT NULL
       AND (u.timestamp, u.id) < (m.timestamp, m.id) ORDER BY u.timestamp DESC, u.id DESC LIMIT 1),
    (SELECT u."senderId" FROM "Message" u WHERE u."sessionId" = m."sessionId" AND u.role = 'USER' AND u."senderId" IS NOT NULL
       AND (u.timestamp, u.id) > (m.timestamp, m.id) ORDER BY u.timestamp, u.id LIMIT 1))::text
WHERE m."forUserId" IS NULL AND m."senderId" IS NULL
  -- not in a session with a vanished member (there the row is the leaver's, dropped by plan 4a)
  AND NOT EXISTS (SELECT 1 FROM "Message" x
                  WHERE x."sessionId" = m."sessionId" AND x."forUserId" IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id::text = x."forUserId"));
