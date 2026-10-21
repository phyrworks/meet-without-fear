/**
 * (3a) Copies, plan §3 steps 1–8 and the tables they depend on, in FK order:
 * user · relationship · session · participant (+4a tombstones) · A/B slots ·
 * conversation (MAIN) + ai_memory · milestone seed + participant_milestone ·
 * need · need_share (step 12's half that step 8 needs) · need_disposition ·
 * proposal (step 13's half that sub-chats, consent and choices need).
 *
 * Every step ends with its plan assertion as app_migration.assert(…), which
 * RAISEs with the counts; the transaction then rolls everything back.
 */

import {
  DEFAULT_MEMORY_PREFERENCES,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_PRIVACY_PREFERENCES,
} from '../../../../shared/src/dto/auth';
import {
  DROPPED_KEYS,
  MILESTONES,
  MILESTONE_RULES,
  TERMINAL_MILESTONE,
  atExpr,
  jsonLit,
  lit,
  litArr,
  needConsentGranted,
  needHasNoConsentedContent,
} from './maps';

const terminalArr = `ARRAY[${TERMINAL_MILESTONE.map(lit).join(', ')}]`;

export function stepUsers(): string {
  return `
-- ---- Step 1: user (identity), user_device, user_preferences, ai_memory(GLOBAL_FACTS)
-- user.name is still the plain column Prisma created; the trailer replaces it
-- with the GENERATED one (sql-only.sql §1), which the P05 precheck proved equal.
INSERT INTO "user" (id, clerk_id, email, first_name, last_name, deleted_at, created_at, updated_at)
SELECT id, "clerkId", email, "firstName", "lastName", NULL, "createdAt", "updatedAt"
FROM "User";

-- One device row per user that has a push token or biometric enrolment (a user
-- with neither has no device to record). platform is unknown → NULL.
WITH ins AS (
  INSERT INTO user_device (id, user_id, push_token, platform, biometric_enabled, biometric_enrolled_at, last_seen_at, created_at, updated_at)
  SELECT app_migration.mint(u."createdAt"), u.id, u."pushToken", NULL, u."biometricEnabled", u."biometricEnrolledAt", NULL, u."createdAt", u."updatedAt"
  FROM "User" u
  WHERE u."pushToken" IS NOT NULL OR u."biometricEnabled" OR u."biometricEnrolledAt" IS NOT NULL
  ORDER BY u."createdAt", u.id
  RETURNING id, user_id
)
INSERT INTO app_migration.shape_map SELECT 'user_device', user_id::text, id FROM ins;

-- Defaults (shared/src/dto/auth.ts DEFAULT_*_PREFERENCES) under the stored keys.
INSERT INTO user_preferences (user_id, doc, created_at, updated_at)
SELECT u.id,
       jsonb_build_object(
         'memory',        ${jsonLit(DEFAULT_MEMORY_PREFERENCES)} || coalesce(app_migration.jnull(u."memoryPreferences"), '{}'::jsonb),
         'notifications', ${jsonLit(DEFAULT_NOTIFICATION_PREFERENCES)} || coalesce(app_migration.jnull(u."notificationPreferences"), '{}'::jsonb),
         'privacy',       ${jsonLit(DEFAULT_PRIVACY_PREFERENCES)} || coalesce(app_migration.jnull(u."privacyPreferences"), '{}'::jsonb)),
       u."createdAt", u."updatedAt"
FROM "User" u;

-- globalFacts: the object shape {facts, consolidatedAt, sessionCount} wins
-- (spec §1.1 ai_memory); a bare array is wrapped as {facts}.
WITH ins AS (
  INSERT INTO ai_memory (id, participant_id, user_id, kind, doc, created_at, updated_at)
  SELECT app_migration.mint(u."updatedAt"), NULL, u.id, 'GLOBAL_FACTS',
         CASE WHEN jsonb_typeof(u."globalFacts") = 'array' THEN jsonb_build_object('facts', u."globalFacts") ELSE u."globalFacts" END,
         u."updatedAt", u."updatedAt"
  FROM "User" u
  WHERE app_migration.jnull(u."globalFacts") IS NOT NULL
  ORDER BY u."updatedAt", u.id
  RETURNING id, user_id
)
INSERT INTO app_migration.shape_map SELECT 'ai_memory:GLOBAL_FACTS', user_id::text, id FROM ins;

SELECT app_migration.assert(a = b, format('step 1: %s user rows for %s "User" rows', a, b))
FROM (SELECT (SELECT count(*) FROM "user") AS a, (SELECT count(*) FROM "User") AS b) x;
SELECT app_migration.assert(a = b, format('step 1: %s user_preferences rows for %s users', a, b))
FROM (SELECT (SELECT count(*) FROM user_preferences) AS a, (SELECT count(*) FROM "user") AS b) x;
SELECT app_migration.assert(a = b, format('step 1: %s GLOBAL_FACTS rows for %s users with globalFacts', a, b))
FROM (SELECT (SELECT count(*) FROM ai_memory WHERE kind = 'GLOBAL_FACTS') AS a,
             (SELECT count(*) FROM "User" WHERE app_migration.jnull("globalFacts") IS NOT NULL) AS b) x;
SELECT app_migration.note('1', 'User.lastMoodIntensity dropped (becomes v_participant.last_mood)', count(*))
FROM "User" WHERE "lastMoodIntensity" IS NOT NULL;

-- ---- Step 2: relationship, relationship_member (role text → enum; P11 checked the values)
INSERT INTO relationship (id, created_at, updated_at)
SELECT id, "createdAt", "updatedAt" FROM "Relationship";

INSERT INTO relationship_member (relationship_id, user_id, role, nickname, joined_at, created_at, updated_at)
SELECT "relationshipId", "userId", role::relationship_role, nickname, "joinedAt", "joinedAt", "joinedAt"
FROM "RelationshipMember";

SELECT app_migration.assert(a = b AND c = d, format('step 2: relationship %s/%s, relationship_member %s/%s', a, b, c, d))
FROM (SELECT (SELECT count(*) FROM relationship) AS a, (SELECT count(*) FROM "Relationship") AS b,
             (SELECT count(*) FROM relationship_member) AS c, (SELECT count(*) FROM "RelationshipMember") AS d) x;

-- ---- Step 3: session (WAITING → ACTIVE; PAUSED → ACTIVE + the paused milestone in step 7; type dropped)
INSERT INTO session (id, relationship_id, status, topic_frame, topic_frame_confirmed_at, previous_session_id, resolved_at, created_at, updated_at)
SELECT id, "relationshipId",
       (CASE status::text WHEN 'WAITING' THEN 'ACTIVE' WHEN 'PAUSED' THEN 'ACTIVE' ELSE status::text END)::session_status,
       "topicFrame", "topicFrameConfirmedAt", NULL, "resolvedAt", "createdAt", "updatedAt"
FROM "Session";
UPDATE session s SET previous_session_id = o."previousSessionId"
FROM "Session" o
WHERE o.id = s.id AND o."previousSessionId" IS NOT NULL;

SELECT app_migration.note('3', 'Session.status ' || status::text || ' → ACTIVE', count(*))
FROM "Session" WHERE status IN ('WAITING', 'PAUSED') GROUP BY status;
SELECT app_migration.note('3', 'Session.type ' || type::text || ' (column dropped)', count(*))
FROM "Session" WHERE type <> 'CONFLICT_RESOLUTION' GROUP BY type;
SELECT app_migration.assert(a = b, format('step 3: %s session rows for %s "Session" rows', a, b))
FROM (SELECT (SELECT count(*) FROM session) AS a, (SELECT count(*) FROM "Session") AS b) x;
`;
}

export function stepParticipants(): string {
  return `
-- ---- Step 4a: vanished members (users hard-deleted under today's user.delete,
-- account-deletion.ts:160): each id named by a session's evidence with no
-- "User" row becomes a tombstone user with THE SAME id (so every text id that
-- named it still resolves) and a participant with left_at set.
WITH ins AS (
  INSERT INTO "user" (id, clerk_id, email, first_name, last_name, deleted_at, created_at, updated_at)
  SELECT v.user_id, NULL, 'deleted+' || v.user_id::text, NULL, NULL, now(), now(), now()
  FROM app_migration.vanished v
  ORDER BY v.user_id
  RETURNING id
)
INSERT INTO app_migration.shape_map SELECT 'tombstone_user', id::text, id FROM ins;
SELECT app_migration.note('4a', 'vanished member → tombstone user', count(*), string_agg(user_id::text, ', ' ORDER BY user_id))
FROM app_migration.vanished;

-- ---- Step 4: participant — one per distinct (session, user) any old row names.
-- joined_at = RelationshipMember.joinedAt, else the session's createdAt;
-- display_name = User.name (NULL for a tombstone).
WITH src AS (
  SELECT p.session_id, p.user_id, (v.user_id IS NOT NULL) AS vanished, u.name,
         coalesce((SELECT m."joinedAt" FROM "RelationshipMember" m
                   WHERE m."relationshipId" = s."relationshipId" AND m."userId" = p.user_id), s."createdAt") AS joined_at
  FROM app_migration.pair p
  JOIN "Session" s ON s.id = p.session_id
  LEFT JOIN app_migration.vanished v ON v.user_id = p.user_id
  LEFT JOIN "User" u ON u.id = p.user_id
), ins AS (
  INSERT INTO participant (id, session_id, user_id, kind, display_name, joined_at, left_at, created_at, updated_at)
  SELECT app_migration.mint(joined_at), session_id, user_id, 'human', CASE WHEN NOT vanished THEN name END,
         joined_at, CASE WHEN vanished THEN now() END, joined_at, CASE WHEN vanished THEN now() ELSE joined_at END
  FROM src
  ORDER BY src.joined_at, src.session_id, src.user_id
  RETURNING id, session_id, user_id
)
INSERT INTO app_migration.shape_map SELECT 'participant', session_id::text || ':' || user_id::text, id FROM ins;

-- A live session with a vanished member cannot continue: ABANDONED (4a).
WITH upd AS (
  UPDATE session s SET status = 'ABANDONED', updated_at = now()
  WHERE s.status NOT IN ('RESOLVED', 'ABANDONED', 'ARCHIVED')
    AND EXISTS (SELECT 1 FROM participant p WHERE p.session_id = s.id AND p.left_at IS NOT NULL)
  RETURNING s.id
)
SELECT app_migration.note('4a', 'live session with a vanished member → ABANDONED', count(*), string_agg(id::text, ', ' ORDER BY id)) FROM upd;

SELECT app_migration.assert(a = b, format('step 4: %s participants for %s distinct (session, user) pairs', a, b))
FROM (SELECT (SELECT count(*) FROM participant) AS a, (SELECT count(*) FROM app_migration.pair) AS b) x;
SELECT app_migration.assert(n = 0, format('step 4: %s (session, user) pair(s) resolve to no participant', n))
FROM (SELECT count(*) AS n FROM app_migration.pair p
      WHERE NOT EXISTS (SELECT 1 FROM participant x WHERE x.session_id = p.session_id AND x.user_id = p.user_id)) x;
SELECT app_migration.assert(n = 0, format('step 4a: %s ACTIVE/RESOLVED session(s) with fewer than 2 participants: %s', n, ids))
FROM (SELECT count(*) AS n, string_agg(s.id::text, ', ' ORDER BY s.id) AS ids
      FROM session s
      WHERE s.status IN ('ACTIVE', 'RESOLVED') AND (SELECT count(*) FROM participant p WHERE p.session_id = s.id) < 2) x;
SELECT app_migration.assert(n = 0, format('step 4a: %s ACTIVE session(s) without a live human participant (T-cardinality-1)', n))
FROM (SELECT count(*) AS n FROM session s
      WHERE s.status = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM participant p WHERE p.session_id = s.id AND p.kind = 'human' AND p.left_at IS NULL)) x;

-- ---- Step 5: A/B slots — getUserSlot order materialised once: first
-- RelationshipMember by joinedAt is A; tie-break joinedAt, ctid (physical
-- order, what Prisma returned on a tie). P08 refused the one case where a tie
-- matters (an agreement with agreedByA <> agreedByB).
INSERT INTO app_migration.ab_slot (session_id, slot, participant_id, tied)
SELECT session_id, CASE rn WHEN 1 THEN 'A' ELSE 'B' END, participant_id, tied
FROM (
  SELECT s.id AS session_id, p.id AS participant_id,
         row_number() OVER (PARTITION BY s.id ORDER BY m."joinedAt", m.ctid) AS rn,
         count(*) OVER (PARTITION BY s.id, m."joinedAt") > 1 AS tied
  FROM "Session" s
  JOIN "RelationshipMember" m ON m."relationshipId" = s."relationshipId"
  JOIN participant p ON p.session_id = s.id AND p.user_id = m."userId"
) x
WHERE rn <= 2;
-- A vanished member's RelationshipMember row cascaded with their deletion, so
-- the survivor alone was ranked above (review D2). Where the session has one
-- surviving member and one vanished participant, recover both slots: the
-- survivor is A when a surviving Invitation of the session was sent by them
-- (the inviter joins first), else B (the inviter's own invitation cascaded
-- with the inviter); the vanished participant takes the other slot. (Every
-- agreement that survives step 13 was agreed by both, so the slot decides who
-- is listed, never who agreed — P22b.)
CREATE TABLE app_migration.slot_fix AS
SELECT s.id AS session_id,
       (SELECT a.participant_id FROM app_migration.ab_slot a WHERE a.session_id = s.id) AS survivor,
       (SELECT p.id FROM participant p JOIN app_migration.vanished v USING (user_id) WHERE p.session_id = s.id) AS gone,
       CASE WHEN EXISTS (SELECT 1 FROM "Invitation" i JOIN app_migration.ab_slot a ON a.session_id = s.id
                         JOIN participant p ON p.id = a.participant_id
                         WHERE i."sessionId" = s.id AND i."invitedById" = p.user_id)
            THEN 'A' ELSE 'B' END AS survivor_slot
FROM "Session" s
WHERE (SELECT count(*) FROM app_migration.ab_slot a WHERE a.session_id = s.id) = 1
  AND (SELECT count(*) FROM participant p JOIN app_migration.vanished v USING (user_id) WHERE p.session_id = s.id) = 1;
DELETE FROM app_migration.ab_slot WHERE session_id IN (SELECT session_id FROM app_migration.slot_fix);
INSERT INTO app_migration.ab_slot (session_id, slot, participant_id, tied)
SELECT session_id, survivor_slot, survivor, false FROM app_migration.slot_fix
UNION ALL
SELECT session_id, CASE survivor_slot WHEN 'A' THEN 'B' ELSE 'A' END, gone, false FROM app_migration.slot_fix;
SELECT app_migration.note('5', 'A/B slots recovered for a session with a vanished member (survivor slot from the surviving invitation)', count(*))
FROM app_migration.slot_fix;
SELECT app_migration.note('5', 'A/B slot decided by the ctid tie-break (no split agreement)', count(DISTINCT session_id))
FROM app_migration.ab_slot WHERE tied;
SELECT app_migration.assert(n = 0, format('step 5: %s two-member session(s) without exactly one A and one B', n))
FROM (SELECT count(*) AS n FROM "Session" s
      WHERE (SELECT count(*) FROM "RelationshipMember" m WHERE m."relationshipId" = s."relationshipId") = 2
        AND (SELECT count(*) FROM app_migration.ab_slot a WHERE a.session_id = s.id) <> 2) x;
`;
}

export function stepConversations(): string {
  return `
-- ---- Step 6: conversation — one MAIN per participant (id minted at the
-- UserVessel's createdAt, else the participant's joined_at); ai_memory SUMMARY
-- and NOTABLE_FACTS from the vessel. Sub-chats follow the proposals below;
-- conversation_read_state follows the messages (its FK into message).
WITH src AS (
  SELECT p.id AS participant_id, coalesce(v."createdAt", p.joined_at) AS created_at, coalesce(v."updatedAt", p.joined_at) AS updated_at
  FROM participant p
  LEFT JOIN "UserVessel" v ON v."sessionId" = p.session_id AND v."userId" = p.user_id
), ins AS (
  INSERT INTO conversation (id, participant_id, kind, anchor_kind, anchor_proposal_id, status, resolved_at, created_at, updated_at)
  SELECT app_migration.mint(created_at), participant_id, 'MAIN', NULL, NULL, 'ACTIVE', NULL, created_at, updated_at
  FROM src
  ORDER BY src.created_at, src.participant_id
  RETURNING id, participant_id
)
INSERT INTO app_migration.shape_map SELECT 'conversation:MAIN', participant_id::text, id FROM ins;

WITH ins AS (
  INSERT INTO ai_memory (id, participant_id, user_id, kind, doc, created_at, updated_at)
  SELECT app_migration.mint(v."updatedAt"), p.id, NULL, 'SUMMARY', v."conversationSummary"::jsonb, v."updatedAt", v."updatedAt"
  FROM "UserVessel" v JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId"
  WHERE v."conversationSummary" IS NOT NULL
  ORDER BY v."updatedAt", v.id
  RETURNING id, participant_id
)
INSERT INTO app_migration.shape_map SELECT 'ai_memory:SUMMARY', participant_id::text, id FROM ins;

WITH ins AS (
  INSERT INTO ai_memory (id, participant_id, user_id, kind, doc, created_at, updated_at)
  SELECT app_migration.mint(v."updatedAt"), p.id, NULL, 'NOTABLE_FACTS',
         CASE WHEN jsonb_typeof(v."notableFacts") = 'array' THEN jsonb_build_object('facts', v."notableFacts") ELSE v."notableFacts" END,
         v."updatedAt", v."updatedAt"
  FROM "UserVessel" v JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId"
  WHERE app_migration.jnull(v."notableFacts") IS NOT NULL
  ORDER BY v."updatedAt", v.id
  RETURNING id, participant_id
)
INSERT INTO app_migration.shape_map SELECT 'ai_memory:NOTABLE_FACTS', participant_id::text, id FROM ins;

SELECT app_migration.assert(a = b, format('step 6: %s MAIN conversations for %s participants', a, b))
FROM (SELECT (SELECT count(*) FROM conversation WHERE kind = 'MAIN') AS a, (SELECT count(*) FROM participant) AS b) x;
SELECT app_migration.assert(n = 0, format('step 6: %s participant(s) without exactly one MAIN conversation', n))
FROM (SELECT count(*) AS n FROM participant p
      WHERE (SELECT count(*) FROM conversation c WHERE c.participant_id = p.id AND c.kind = 'MAIN') <> 1) x;
SELECT app_migration.assert(a = b, format('step 6: %s of %s UserVessel rows mapped to a participant', a, b))
FROM (SELECT (SELECT count(*) FROM "UserVessel" v JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId") AS a,
             (SELECT count(*) FROM "UserVessel") AS b) x;
SELECT app_migration.assert(a = b, format('step 6: %s SUMMARY rows for %s vessel summaries', a, b))
FROM (SELECT (SELECT count(*) FROM ai_memory WHERE kind = 'SUMMARY') AS a,
             (SELECT count(*) FROM "UserVessel" WHERE "conversationSummary" IS NOT NULL) AS b) x;
SELECT app_migration.assert(a = b, format('step 6: %s NOTABLE_FACTS rows for %s vessels with notableFacts', a, b))
FROM (SELECT (SELECT count(*) FROM ai_memory WHERE kind = 'NOTABLE_FACTS') AS a,
             (SELECT count(*) FROM "UserVessel" WHERE app_migration.jnull("notableFacts") IS NOT NULL) AS b) x;
`;
}

export function stepMilestones(): string {
  const seed = MILESTONES.map(([k, o, l, s, a]) => `  (${lit(k)}, ${o}, ${lit(l)}, ${lit(s)}, ${a})`).join(',\n');
  const rules = MILESTONE_RULES.map(
    (r) =>
      `  SELECT participant_id, ${lit(r.milestone)}, coalesce(${r.at.map(atExpr).join(', ')}), ${lit('gate:' + r.gate)}\n` +
      `  FROM sp WHERE sp.gates -> ${lit(r.gate)} = 'true'::jsonb`,
  ).join('\n  UNION ALL\n');
  const contentKeys = DROPPED_KEYS.filter((d) => d.content).map((d) => d.key);
  return `
-- ---- Milestone seed (needed before step 7: participant_milestone → milestone
-- is RESTRICT). The plan lists the seed in the trailer; the FK decides.
INSERT INTO milestone (key, ordinal, stage_label, scope, self_assertable) VALUES
${seed};

-- ---- Step 7: participant_milestone from gatesSatisfied (key table in
-- gen/maps.ts), the terminal milestone of every COMPLETED stage, PAUSED, plus
-- two facts the fixtures encode outside gatesSatisfied (current-shape.ts
-- GATE_ENCODING "elsewhere"): empathy_submitted at EmpathyAttempt.sharedAt and
-- invitation_sent at Invitation.messageConfirmedAt. A milestone reached by
-- several sources keeps its earliest time.
CREATE TABLE app_migration.milestone_src AS
WITH sp AS (
  SELECT p.id AS participant_id, x.*,
         CASE WHEN jsonb_typeof(x."gatesSatisfied") = 'object' THEN x."gatesSatisfied" ELSE '{}'::jsonb END AS gates
  FROM "StageProgress" x JOIN participant p ON p.session_id = x."sessionId" AND p.user_id = x."userId"
)
SELECT * FROM (
${rules}
  UNION ALL
  SELECT participant_id, 'repair_walkthrough_started',
         coalesce(app_migration.ts(sp.gates -> 'stage4Walkthrough' -> 'updatedAt'), sp."startedAt"), 'gate:stage4Walkthrough'
  FROM sp
  WHERE jsonb_typeof(sp.gates -> 'stage4Walkthrough') = 'object'
     OR (jsonb_typeof(sp.gates -> 'phase') = 'string' AND sp.gates ->> 'phase' <> 'INVENTORY')
  UNION ALL
  SELECT participant_id, (${terminalArr})[sp.stage + 1], coalesce(sp."completedAt", sp."startedAt"), 'terminal:stage' || sp.stage
  FROM sp WHERE sp.status = 'COMPLETED' AND sp.stage BETWEEN 0 AND 4
  UNION ALL
  SELECT p.id, 'paused', s."updatedAt", 'Session.PAUSED'
  FROM "Session" s JOIN participant p ON p.session_id = s.id
  WHERE s.status = 'PAUSED' AND p.left_at IS NULL
  UNION ALL
  SELECT p.id, 'empathy_submitted', a."sharedAt", 'EmpathyAttempt.sharedAt'
  FROM app_migration.empathy_attempt_src a JOIN participant p ON p.session_id = a."sessionId" AND p.user_id = a."sourceUserId"
  UNION ALL
  SELECT p.id, 'invitation_sent', i."messageConfirmedAt", 'Invitation.messageConfirmedAt'
  FROM "Invitation" i JOIN participant p ON p.session_id = i."sessionId" AND p.user_id = i."invitedById"
  WHERE i."messageConfirmedAt" IS NOT NULL
) r (participant_id, milestone_key, reached_at, source);

INSERT INTO participant_milestone (participant_id, milestone_key, reached_at, created_at)
SELECT participant_id, milestone_key, min(reached_at), min(reached_at)
FROM app_migration.milestone_src
GROUP BY participant_id, milestone_key
ORDER BY 3, 1, 2;

SELECT app_migration.note('7', 'milestone source ' || source || ' → ' || milestone_key, count(*))
FROM app_migration.milestone_src GROUP BY source, milestone_key ORDER BY source, milestone_key;
INSERT INTO app_migration.dropped_content (concept, session_id, user_id, text, written_at)
SELECT 'StageProgress.gatesSatisfied.' || k, sp."sessionId", sp."userId", sp."gatesSatisfied" ->> k, coalesce(sp."completedAt", sp."startedAt")
FROM "StageProgress" sp CROSS JOIN unnest(${litArr(contentKeys)}) AS k
WHERE jsonb_typeof(sp."gatesSatisfied") = 'object' AND app_migration.jnull(sp."gatesSatisfied" -> k) IS NOT NULL
ORDER BY sp.id, k;
SELECT app_migration.note('7', 'gatesSatisfied.' || k || ' (free text, no target column) → app_migration.dropped_content', count(*))
FROM "StageProgress" sp CROSS JOIN unnest(${litArr(contentKeys)}) AS k
WHERE jsonb_typeof(sp."gatesSatisfied") = 'object' AND app_migration.jnull(sp."gatesSatisfied" -> k) IS NOT NULL
GROUP BY k;
SELECT app_migration.assert(n = 0, format('step 7: %s COMPLETED StageProgress row(s) without their terminal milestone', n))
FROM (SELECT count(*) AS n
      FROM "StageProgress" x JOIN participant p ON p.session_id = x."sessionId" AND p.user_id = x."userId"
      WHERE x.status = 'COMPLETED'
        AND NOT EXISTS (SELECT 1 FROM participant_milestone pm
                        WHERE pm.participant_id = p.id AND pm.milestone_key = (${terminalArr})[x.stage + 1])) x;
`;
}

export function stepNeeds(): string {
  return `
-- ---- need ← IdentifiedNeed (ids kept; owner = the vessel's participant).
-- confirmed has no timestamp: confirmed_at = createdAt when confirmed.
INSERT INTO need (id, participant_id, label, category, evidence, ai_confidence, confirmed_at, locked_at, superseded_by_need_id, deleted_at, created_at, updated_at)
SELECT n.id, p.id, n.need, n.category::text::need_category, coalesce(n.evidence, '{}'), n."aiConfidence"::real,
       CASE WHEN n.confirmed THEN n."createdAt" END, n."lockedAt", NULL, n."deletedAt", n."createdAt",
       greatest(n."createdAt", n."lockedAt", n."deletedAt")
FROM "IdentifiedNeed" n
JOIN "UserVessel" v ON v.id = n."vesselId"
JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId";
UPDATE need SET superseded_by_need_id = o."supersededByNeedId"
FROM "IdentifiedNeed" o WHERE o.id = need.id AND o."supersededByNeedId" IS NOT NULL;
SELECT app_migration.assert(a = b, format('needs: %s need rows for %s "IdentifiedNeed" rows', a, b))
FROM (SELECT (SELECT count(*) FROM need) AS a, (SELECT count(*) FROM "IdentifiedNeed") AS b) x;

-- ---- Step 12 (part): need_share ← ConsentedContent ∪ granted IDENTIFIED_NEED
-- ConsentRecord rows (TS-7b). participant_id/session_id from the resolved
-- need's owner (pass 2 N-1; T-need-share-owner).
-- (a) ConsentedContent: need via consentRecordId → ConsentRecord.targetId
-- (originalNeedId was never written, census §3); shared_text = the
-- transformed text.
WITH ins AS (
  INSERT INTO need_share (need_id, participant_id, session_id, category, shared_text, shared_at, revoked_at, created_at, updated_at)
  SELECT n.id, n.participant_id, p.session_id, n.category, cc."transformedContent", cc."consentedAt", cc."revokedAt",
         cc."consentedAt", coalesce(cc."revokedAt", cc."consentedAt")
  FROM "ConsentedContent" cc
  JOIN "ConsentRecord" cr ON cr.id = cc."consentRecordId"
  JOIN need n ON n.id = app_migration.as_uuid(cr."targetId")
  JOIN participant p ON p.id = n.participant_id
  RETURNING need_id
)
SELECT app_migration.note('12', 'need_share from ConsentedContent', count(*)) FROM ins;
INSERT INTO app_migration.shape_map
SELECT 'need_share:ConsentedContent', cc.id::text, app_migration.as_uuid(cr."targetId")
FROM "ConsentedContent" cc JOIN "ConsentRecord" cr ON cr.id = cc."consentRecordId";
-- (b) the Stage 3 share-needs handler (stage3.ts ~750-780 on phoenix/base)
-- writes one GRANTED ConsentRecord(IDENTIFIED_NEED) per shared need and never
-- a ConsentedContent row: a granted (or since revoked) record whose need has
-- no ConsentedContent is the share. No transformed text exists on this path:
-- shared_text = the need's label. shared_at = the grant time (decidedAt),
-- else the owner's stage-3 gatesSatisfied.sharedAt, else the record's
-- createdAt; revoked_at from the record. P20e-P20g guarantee one resolvable
-- record per such need, with revoked_at >= shared_at. Step 12's consent copy
-- below still writes the consent row for the same record: one record, one
-- consent, one need_share.
CREATE TABLE app_migration.need_share_record_src AS
SELECT cr.id AS record_id, n.id AS need_id, n.participant_id, p.session_id, n.category, n.label,
       coalesce(cr."decidedAt",
                (SELECT app_migration.ts(sp."gatesSatisfied" -> 'sharedAt') FROM "StageProgress" sp
                 WHERE sp."sessionId" = p.session_id AND sp."userId" = p.user_id AND sp.stage = 3
                   AND jsonb_typeof(sp."gatesSatisfied") = 'object'),
                cr."createdAt") AS shared_at,
       CASE WHEN cr."decidedAt" IS NOT NULL THEN 'decidedAt'
            WHEN EXISTS (SELECT 1 FROM "StageProgress" sp
                         WHERE sp."sessionId" = p.session_id AND sp."userId" = p.user_id AND sp.stage = 3
                           AND jsonb_typeof(sp."gatesSatisfied") = 'object' AND app_migration.ts(sp."gatesSatisfied" -> 'sharedAt') IS NOT NULL)
              THEN 'gatesSatisfied.sharedAt'
            ELSE 'createdAt' END AS shared_at_source,
       cr."revokedAt" AS revoked_at
FROM "ConsentRecord" cr
JOIN need n ON n.id = app_migration.as_uuid(cr."targetId")
JOIN participant p ON p.id = n.participant_id
WHERE ${needConsentGranted('cr')}
  AND ${needHasNoConsentedContent('n.id')};
WITH ins AS (
  INSERT INTO need_share (need_id, participant_id, session_id, category, shared_text, shared_at, revoked_at, created_at, updated_at)
  SELECT need_id, participant_id, session_id, category, label, shared_at, revoked_at, shared_at, coalesce(revoked_at, shared_at)
  FROM app_migration.need_share_record_src
  ORDER BY need_id
  RETURNING need_id
)
SELECT app_migration.note('12', 'need_share from a granted IDENTIFIED_NEED ConsentRecord without ConsentedContent (Stage 3 share; shared_text = need label)', count(*))
FROM ins;
SELECT app_migration.note('12', 'need_share from a ConsentRecord: shared_at from ' || shared_at_source, count(*))
FROM app_migration.need_share_record_src GROUP BY shared_at_source;
INSERT INTO app_migration.shape_map
SELECT 'need_share:ConsentRecord', record_id::text, need_id FROM app_migration.need_share_record_src;

-- Reported both ways: need_share = ConsentedContent + qualifying records, and
-- every granted IDENTIFIED_NEED record lands in exactly one need_share
-- (need_id is the PK: "exactly one" is "one").
SELECT app_migration.assert(a = b + c, format('step 12: %s need_share rows for %s "ConsentedContent" rows + %s granted IDENTIFIED_NEED "ConsentRecord" rows without ConsentedContent', a, b, c))
FROM (SELECT (SELECT count(*) FROM need_share) AS a, (SELECT count(*) FROM "ConsentedContent") AS b,
             (SELECT count(*) FROM app_migration.need_share_record_src) AS c) x;
SELECT app_migration.assert(n = 0, format('step 12: %s granted IDENTIFIED_NEED "ConsentRecord" row(s) without exactly one need_share: %s', n, ids))
FROM (SELECT count(*) AS n, string_agg(cr.id::text, ', ' ORDER BY cr.id) AS ids
      FROM "ConsentRecord" cr
      WHERE ${needConsentGranted('cr')}
        AND (SELECT count(*) FROM need_share ns WHERE ns.need_id = app_migration.as_uuid(cr."targetId")) <> 1) x;
SELECT app_migration.assert(n = 0, format('step 12: %s need_share row(s) whose participant_id/session_id is not the need owner''s (T-need-share-owner)', n))
FROM (SELECT count(*) AS n FROM need_share ns
      JOIN need n ON n.id = ns.need_id JOIN participant p ON p.id = n.participant_id
      WHERE ns.participant_id <> n.participant_id OR ns.session_id <> p.session_id) x;
DROP TABLE app_migration.need_share_record_src;

-- ---- Step 8: need_disposition ← stage4Walkthrough {currentNeedId,
-- coveredNeedIds, skippedNeedIds} (stage4.ts:500, stream-turn-actions.ts:243;
-- the plan's top-level keys are read too) ∪ Stage4NeedDeclination (→ DECLINED),
-- for needs with a need_share row. Others are reported and dropped.
-- Precedence on one (participant, need): DECLINED > COVERED > SKIPPED > OPEN.
CREATE TABLE app_migration.disposition_ref AS
WITH walk AS (
  SELECT p.id AS participant_id, x."startedAt",
         CASE WHEN jsonb_typeof(x."gatesSatisfied" -> 'stage4Walkthrough') = 'object'
              THEN x."gatesSatisfied" -> 'stage4Walkthrough' ELSE x."gatesSatisfied" END AS w
  FROM "StageProgress" x JOIN participant p ON p.session_id = x."sessionId" AND p.user_id = x."userId"
  WHERE x.stage = 4 AND jsonb_typeof(x."gatesSatisfied") = 'object'
)
SELECT participant_id, need_text, status, is_current, at, source FROM (
  SELECT participant_id, e AS need_text, 'COVERED' AS status, false AS is_current,
         coalesce(app_migration.ts(w -> 'updatedAt'), "startedAt") AS at, 'coveredNeedIds' AS source
  FROM walk CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(w -> 'coveredNeedIds') = 'array' THEN w -> 'coveredNeedIds' ELSE '[]' END) e
  UNION ALL
  SELECT participant_id, e, 'SKIPPED', false, coalesce(app_migration.ts(w -> 'updatedAt'), "startedAt"), 'skippedNeedIds'
  FROM walk CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(w -> 'skippedNeedIds') = 'array' THEN w -> 'skippedNeedIds' ELSE '[]' END) e
  UNION ALL
  SELECT participant_id, w ->> 'currentNeedId', 'OPEN', true, coalesce(app_migration.ts(w -> 'updatedAt'), "startedAt"), 'currentNeedId'
  FROM walk WHERE jsonb_typeof(w -> 'currentNeedId') = 'string'
  UNION ALL
  SELECT p.id, d."needId", 'DECLINED', false, d."declinedAt", 'Stage4NeedDeclination'
  FROM "Stage4NeedDeclination" d JOIN participant p ON p.session_id = d."sessionId" AND p.user_id = app_migration.as_uuid(d."userId")
) r;

INSERT INTO need_disposition (participant_id, need_id, status, is_current, note, created_at, updated_at)
SELECT r.participant_id, ns.need_id,
       ((ARRAY['OPEN', 'SKIPPED', 'COVERED', 'DECLINED'])[max(array_position(ARRAY['OPEN', 'SKIPPED', 'COVERED', 'DECLINED'], r.status))])::need_disposition_status,
       bool_or(r.is_current), NULL, min(r.at), max(r.at)
FROM app_migration.disposition_ref r
JOIN need_share ns ON ns.need_id = app_migration.as_uuid(r.need_text)
GROUP BY r.participant_id, ns.need_id
ORDER BY 1, 2;

SELECT app_migration.note('8', 'disposition on a need without need_share (' || source || '): dropped', count(*),
                          string_agg(need_text, ', ' ORDER BY need_text))
FROM app_migration.disposition_ref r
WHERE NOT EXISTS (SELECT 1 FROM need_share ns WHERE ns.need_id = app_migration.as_uuid(r.need_text))
GROUP BY source;
SELECT app_migration.assert(n = 0, format('step 8: %s disposition reference(s) to a shared need did not land', n))
FROM (SELECT count(*) AS n FROM app_migration.disposition_ref r
      JOIN need_share ns ON ns.need_id = app_migration.as_uuid(r.need_text)
      WHERE NOT EXISTS (SELECT 1 FROM need_disposition d WHERE d.participant_id = r.participant_id AND d.need_id = ns.need_id)) x;
SELECT app_migration.note('8', 'Stage4NeedCoverage not copied (computed: v_need_coverage)', count(*)) FROM "Stage4NeedCoverage";
INSERT INTO app_migration.dropped_content (concept, session_id, user_id, text, written_at)
SELECT 'Stage4NeedCoverage.note', c."sessionId", app_migration.as_uuid(c."sourceUserId"), c.note, c."updatedAt"
FROM "Stage4NeedCoverage" c WHERE c.note IS NOT NULL ORDER BY c.id;

-- ---- Step 13 (part): proposal ← StrategyProposal (ids kept). needsAddressed
-- → proposal_need / unresolved_need_labels below; parentProposalId,
-- coverageSummary, consentRecordId, capturedFromMessageId dropped.
INSERT INTO proposal (id, session_id, created_by_participant_id, source, kind, status, description, duration, measure_of_success,
                      unresolved_need_labels, removed_at, removed_by_participant_id, removal_reason, shared_at, created_at, updated_at)
SELECT sp.id, sp."sessionId", pc.id, sp.source::text::proposal_source, sp.kind::text::proposal_kind, sp.status::text::proposal_status,
       sp.description, sp.duration, sp."measureOfSuccess", '{}', sp."removedAt", pr.id, sp."removalReason", NULL, sp."createdAt", sp."updatedAt"
FROM "StrategyProposal" sp
LEFT JOIN participant pc ON pc.session_id = sp."sessionId" AND pc.user_id = sp."createdByUserId"
LEFT JOIN participant pr ON pr.session_id = sp."sessionId" AND pr.user_id = sp."removedByUserId";
SELECT app_migration.assert(a = b, format('step 13: %s proposal rows for %s "StrategyProposal" rows', a, b))
FROM (SELECT (SELECT count(*) FROM proposal) AS a, (SELECT count(*) FROM "StrategyProposal") AS b) x;
SELECT app_migration.note('13', 'StrategyProposal.' || c || ' dropped', n)
FROM (SELECT 'parentProposalId' AS c, count(*) FILTER (WHERE "parentProposalId" IS NOT NULL) AS n FROM "StrategyProposal"
      UNION ALL SELECT 'coverageSummary', count(*) FILTER (WHERE app_migration.jnull("coverageSummary") IS NOT NULL) FROM "StrategyProposal"
      UNION ALL SELECT 'capturedFromMessageId', count(*) FILTER (WHERE "capturedFromMessageId" IS NOT NULL) FROM "StrategyProposal") x
WHERE n > 0;

-- Sub-chats (step 6, second half): SUBCHAT conversations ← Stage4SubChat (ids kept).
INSERT INTO conversation (id, participant_id, kind, anchor_kind, anchor_proposal_id, status, resolved_at, created_at, updated_at)
SELECT sc.id, p.id, 'SUBCHAT', sc."anchorKind"::text::subchat_anchor, pr.id, sc.status::text::conversation_status,
       sc."resolvedAt", sc."createdAt", coalesce(sc."resolvedAt", sc."createdAt")
FROM "Stage4SubChat" sc
JOIN participant p ON p.session_id = sc."sessionId" AND p.user_id = sc."userId"
LEFT JOIN proposal pr ON pr.id = app_migration.as_uuid(sc."anchorId");
SELECT app_migration.note('17', 'Stage4SubChat.anchorId that is not a proposal id (anchor_proposal_id NULL)', count(*))
FROM "Stage4SubChat" sc
WHERE sc."anchorId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "StrategyProposal" p WHERE p.id = app_migration.as_uuid(sc."anchorId"));
SELECT app_migration.assert(a = b, format('step 6: %s SUBCHAT conversations for %s "Stage4SubChat" rows', a, b))
FROM (SELECT (SELECT count(*) FROM conversation WHERE kind = 'SUBCHAT') AS a, (SELECT count(*) FROM "Stage4SubChat") AS b) x;
`;
}
