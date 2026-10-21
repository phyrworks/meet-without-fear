-- ============================================================================
-- smoke-before.sql — run-target-migration.sh records old-shape facts of the
-- seeded scratch database into schema ts7_smoke (outside public, so the
-- migration's guard ignores it) right before the migration; the after-smoke
-- (smoke-target-migration.sql) compares the target views against them.
-- Scratch-only: refuses anything but a ts7_* database.
-- ============================================================================
DO $$
BEGIN
  IF current_database() !~ '^ts7_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'smoke-before.sql only runs on a ts7_* scratch database, not %', current_database();
  END IF;
END
$$;

DROP SCHEMA IF EXISTS ts7_smoke CASCADE;
CREATE SCHEMA ts7_smoke;

-- Which TargetStage each seeded session is (seed-current-shape.ts emails
-- a.<stage-tag>.<b|nob>@e2e.test for user A).
CREATE TABLE ts7_smoke.seed AS
SELECT s.id AS session_id,
       upper(replace(split_part(u.email, '.', 2), '-', '_')) AS stage,
       split_part(split_part(u.email, '.', 3), '@', 1) AS variant
FROM "Session" s
JOIN "RelationshipMember" m ON m."relationshipId" = s."relationshipId"
JOIN "User" u ON u.id = m."userId"
WHERE u.email ~ '^a\.[a-z0-9-]+\.(b|nob)@e2e\.test$';

-- Old stage per (session, member): the highest StageProgress.stage (the
-- IN_PROGRESS row, or 4 when every stage is complete); 0 without rows.
CREATE TABLE ts7_smoke.old_stage AS
SELECT s.id AS session_id, m."userId" AS user_id,
       CASE WHEN m."userId" = (SELECT i."invitedById" FROM "Invitation" i WHERE i."sessionId" = s.id LIMIT 1) THEN 'A' ELSE 'B' END AS who,
       coalesce((SELECT max(sp.stage) FROM "StageProgress" sp WHERE sp."sessionId" = s.id AND sp."userId" = m."userId"), 0) AS old_stage
FROM "Session" s JOIN "RelationshipMember" m ON m."relationshipId" = s."relationshipId";

-- Old attempts by direction (subject = the other member).
CREATE TABLE ts7_smoke.old_attempt AS
SELECT a.id AS attempt_id, a."sessionId" AS session_id, a."sourceUserId" AS author_user,
       (SELECT m."userId" FROM "RelationshipMember" m JOIN "Session" s ON s."relationshipId" = m."relationshipId"
        WHERE s.id = a."sessionId" AND m."userId" <> a."sourceUserId") AS subject_user,
       CASE a.status::text WHEN 'ANALYZING' THEN 'HELD' WHEN 'NEEDS_WORK' THEN 'AWAITING_SHARING' ELSE a.status::text END AS status,
       a."revealedAt" IS NOT NULL AS revealed
FROM "EmpathyAttempt" a;

-- Old compact gate: every member signed.
CREATE TABLE ts7_smoke.old_compact AS
SELECT s.id AS session_id,
       bool_and(coalesce((SELECT (sp."gatesSatisfied" ->> 'compactSigned')::boolean FROM "StageProgress" sp
                          WHERE sp."sessionId" = s.id AND sp."userId" = m."userId" AND sp.stage = 0), false)) AS all_signed
FROM "Session" s JOIN "RelationshipMember" m ON m."relationshipId" = s."relationshipId"
GROUP BY s.id;

-- Old shared needs per session: active ConsentedContent, plus (TS-7b) the
-- Stage 3 handler's shares — a GRANTED, unrevoked IDENTIFIED_NEED
-- ConsentRecord whose need has no ConsentedContent (session = the need's
-- vessel's session).
CREATE TABLE ts7_smoke.old_shared_need AS
SELECT session_id, count(*) AS n FROM (
  SELECT sv."sessionId" AS session_id
  FROM "ConsentedContent" cc JOIN "SharedVessel" sv ON sv.id = cc."sharedVesselId"
  WHERE cc."consentActive"
  UNION ALL
  SELECT uv."sessionId"
  FROM "ConsentRecord" cr
  JOIN "IdentifiedNeed" n ON n.id::text = cr."targetId"
  JOIN "UserVessel" uv ON uv.id = n."vesselId"
  WHERE cr."targetType" = 'IDENTIFIED_NEED' AND cr.decision = 'GRANTED' AND cr."revokedAt" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "ConsentedContent" cc JOIN "ConsentRecord" c2 ON c2.id = cc."consentRecordId" WHERE c2."targetId" = cr."targetId")
) x
GROUP BY session_id;

SELECT 'smoke-before: recorded', (SELECT count(*) FROM ts7_smoke.seed) AS seeded_sessions,
       (SELECT count(*) FROM ts7_smoke.old_stage) AS members, (SELECT count(*) FROM ts7_smoke.old_attempt) AS attempts;
