/**
 * (3b) Copies, plan §3 steps 11, 9, 10, 12 (consent), in FK order:
 * empathy_attempt · reconciler_result · reconciler_guidance ·
 * context_share_offer · empathy_review · message (+ delivered copies) ·
 * conversation_read_state · draft · consent.
 */

export function stepEmpathy(): string {
  return `
-- ---- Step 11: empathy_attempt ← EmpathyAttempt (ids kept). author ←
-- sourceUserId; subject ← the one other participant (P15b refused N≠2);
-- round ← revisionCount + 1; ANALYZING → HELD, NEEDS_WORK → AWAITING_SHARING.
INSERT INTO empathy_attempt (id, author_participant_id, subject_participant_id, round, supersedes_attempt_id, content, status, status_version,
                             submitted_at, revealed_at, delivery_status, delivered_at, seen_at, created_at, updated_at)
SELECT a.id, pa.id, ps.id, a."revisionCount" + 1, NULL, a.content,
       (CASE a.status::text WHEN 'ANALYZING' THEN 'HELD' WHEN 'NEEDS_WORK' THEN 'AWAITING_SHARING' ELSE a.status::text END)::empathy_status,
       a."statusVersion", a."sharedAt", a."revealedAt", a."deliveryStatus"::text::delivery_status, a."deliveredAt", a."seenAt",
       a."sharedAt", greatest(a."sharedAt", a."revealedAt", a."deliveredAt", a."seenAt")
FROM app_migration.empathy_attempt_src a
JOIN participant pa ON pa.session_id = a."sessionId" AND pa.user_id = a."sourceUserId"
JOIN participant ps ON ps.session_id = a."sessionId" AND ps.user_id <> a."sourceUserId";
SELECT app_migration.note('11', 'EmpathyAttempt.status ' || status::text || ' → ' ||
                          CASE status::text WHEN 'ANALYZING' THEN 'HELD' ELSE 'AWAITING_SHARING' END, count(*))
FROM app_migration.empathy_attempt_src WHERE status IN ('ANALYZING', 'NEEDS_WORK') GROUP BY status;
SELECT app_migration.assert(a = b, format('step 11: %s empathy_attempt rows for %s "EmpathyAttempt" rows (subject must be unique)', a, b))
FROM (SELECT (SELECT count(*) FROM empathy_attempt) AS a, (SELECT count(*) FROM app_migration.empathy_attempt_src) AS b) x;

-- reconciler_result ← ReconcilerResult (ids kept) → the attempt of (session, guesser).
INSERT INTO reconciler_result (id, attempt_id, subject_participant_id, iteration, alignment_score, alignment_summary, gap_summary, gap_severity,
                               correctly_identified, missed_feelings, misattributions, most_important_gap, recommended_action, rationale,
                               sharing_would_help, suggested_share_focus, suggested_share_content, suggested_share_reason,
                               circuit_breaker_tripped, superseded_at, created_at, updated_at)
SELECT r.id, a.id, ps.id, r.iteration, r."alignmentScore", r."alignmentSummary", r."gapSummary", upper(r."gapSeverity")::gap_severity,
       coalesce(r."correctlyIdentified", '{}'), coalesce(r."missedFeelings", '{}'), coalesce(r.misattributions, '{}'), r."mostImportantGap",
       r."recommendedAction"::recommender_action, r.rationale, r."sharingWouldHelp", r."suggestedShareFocus",
       r."suggestedShareContent", r."suggestedShareReason", r."wasCircuitBreakerTrip", r."supersededAt",
       r."createdAt", coalesce(r."supersededAt", r."createdAt")
FROM "ReconcilerResult" r
JOIN app_migration.empathy_attempt_src a ON a."sessionId" = r."sessionId" AND a."sourceUserId" = app_migration.as_uuid(r."guesserId")
JOIN participant ps ON ps.session_id = r."sessionId" AND ps.user_id = app_migration.as_uuid(r."subjectId");
SELECT app_migration.assert(a = b, format('step 11: %s reconciler_result rows for %s "ReconcilerResult" rows', a, b))
FROM (SELECT (SELECT count(*) FROM reconciler_result) AS a, (SELECT count(*) FROM "ReconcilerResult") AS b) x;
SELECT app_migration.assert(n = 0, format('step 11: %s reconciler_result row(s) whose subject is not the attempt''s subject (T-result-live-attempt)', n))
FROM (SELECT count(*) AS n FROM reconciler_result r JOIN empathy_attempt a ON a.id = r.attempt_id
      WHERE r.subject_participant_id <> a.subject_participant_id) x;
SELECT app_migration.assert(n = 0, format('step 11: %s attempt(s) with more than one current reconciler_result', n))
FROM (SELECT count(*) AS n FROM (SELECT attempt_id FROM reconciler_result WHERE superseded_at IS NULL GROUP BY attempt_id HAVING count(*) > 1) d) x;
-- The plan asks "counter value = count(reconciler_result) per direction"; the
-- app deletes results on resubmit (circuit-breaker.ts:63-70) and increments
-- the counter only on resubmit, so the two are not equal by design. Reported.
SELECT app_migration.note('11', 'RefinementAttemptCounter direction: attempts vs results (not asserted; see header)', count(*),
                          string_agg(format('%s %s: counter=%s results=%s round=%s', c."sessionId", c.direction, c.attempts,
                            (SELECT count(*) FROM "ReconcilerResult" r WHERE r."sessionId" = c."sessionId" AND r."guesserId" || '->' || r."subjectId" = c.direction),
                            (SELECT a."revisionCount" + 1 FROM app_migration.empathy_attempt_src a WHERE a."sessionId" = c."sessionId" AND a."sourceUserId"::text = split_part(c.direction, '->', 1))),
                            '; '))
FROM "RefinementAttemptCounter" c;

-- reconciler_guidance ← ReconcilerResult.{areaHint, guidanceType, promptSeed} (P3 D8a split), where any is set.
INSERT INTO reconciler_guidance (result_id, author_participant_id, subject_participant_id, area_hint, guidance_type, prompt_seed, created_at)
SELECT r.id, a.author_participant_id, a.subject_participant_id, o."areaHint", o."guidanceType", o."promptSeed", r.created_at
FROM "ReconcilerResult" o
JOIN reconciler_result r ON r.id = o.id
JOIN empathy_attempt a ON a.id = r.attempt_id
WHERE num_nonnulls(o."areaHint", o."guidanceType", o."promptSeed") > 0;

-- context_share_offer ← ReconcilerShareOffer (ids kept); NOT_OFFERED/SKIPPED → EXPIRED;
-- refinedContent → draft(SHARE_CONTEXT) below; skippedAt, refinementChatUsed dropped.
INSERT INTO context_share_offer (id, attempt_id, result_id, subject_participant_id, iteration, status, offer_message, suggested_content,
                                 suggested_reason, shared_content, shared_at, declined_at, offered_at, delivery_status, delivered_at, seen_at,
                                 delivery_notified_at, seen_notified_at, created_at, updated_at)
SELECT o.id, r.attempt_id, r.id, r.subject_participant_id, o.iteration,
       (CASE o.status::text WHEN 'NOT_OFFERED' THEN 'EXPIRED' WHEN 'SKIPPED' THEN 'EXPIRED' ELSE o.status::text END)::share_offer_status,
       o."offerMessage", o."suggestedContent", o."suggestedReason", o."sharedContent", o."sharedAt", o."declinedAt", NULL,
       o."deliveryStatus"::text::delivery_status, o."deliveredAt", o."seenAt", o."lastDeliveryNotifiedAt", o."lastSeenNotifiedAt",
       o."createdAt", o."updatedAt"
FROM "ReconcilerShareOffer" o JOIN reconciler_result r ON r.id = o."resultId";
SELECT app_migration.note('11', 'ReconcilerShareOffer.status ' || status::text || ' → EXPIRED', count(*))
FROM "ReconcilerShareOffer" WHERE status IN ('NOT_OFFERED', 'SKIPPED') GROUP BY status;
SELECT app_migration.assert(a = b, format('step 11: %s context_share_offer rows for %s "ReconcilerShareOffer" rows', a, b))
FROM (SELECT (SELECT count(*) FROM context_share_offer) AS a, (SELECT count(*) FROM "ReconcilerShareOffer") AS b) x;

-- empathy_review ← EmpathyValidation (ids kept). feedback kept only where it
-- was shared (feedback_sent_at = validatedAt); unsent text → draft below.
INSERT INTO empathy_review (id, attempt_id, reviewer_participant_id, validated, feedback, feedback_sent_at, created_at, updated_at)
SELECT v.id, v."attemptId", p.id, v.validated,
       CASE WHEN v."feedbackShared" THEN v.feedback END,
       CASE WHEN v."feedbackShared" AND v.feedback IS NOT NULL THEN coalesce(v."validatedAt", a.submitted_at) END,
       coalesce(v."validatedAt", a.submitted_at), coalesce(v."validatedAt", a.submitted_at)
FROM app_migration.empathy_validation_src v
JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId"
JOIN empathy_attempt a ON a.id = v."attemptId";
SELECT app_migration.assert(a = b, format('step 11: %s empathy_review rows for %s "EmpathyValidation" rows', a, b))
FROM (SELECT (SELECT count(*) FROM empathy_review) AS a, (SELECT count(*) FROM app_migration.empathy_validation_src) AS b) x;
SELECT app_migration.assert(n = 0, format('step 11: %s empathy_review row(s) whose reviewer is not the attempt''s subject', n))
FROM (SELECT count(*) AS n FROM empathy_review r JOIN empathy_attempt a ON a.id = r.attempt_id
      WHERE r.reviewer_participant_id <> a.subject_participant_id) x;
`;
}

export function stepMessages(): string {
  return `
-- ---- Step 9: message ← Message (ids kept). conversation = the MAIN
-- conversation of participant (session, coalesce(forUserId, senderId)).
-- role USER/AI/SYSTEM stays (kind CHAT); the six event roles become kind,
-- with role USER when the row has a sender and AI when not (the role/sender
-- CHECKs: USER ⇒ sender, AI/SYSTEM ⇒ no sender). A USER row whose sender was
-- nulled (SetNull on a deleted user) is the conversation owner's own turn.
-- source_attempt_id: EMPATHY_STATEMENT → the attempt authored by its sender
-- (plan: by (session, author)); VALIDATION_FEEDBACK and SHARED_CONTEXT (spec
-- §1.1 names it too) → the attempt the sender is the subject of.
-- Rows with neither forUserId nor senderId (ruling R16, exact or nothing):
-- an AI/SYSTEM row with exactly one candidate user goes to that user's MAIN
-- conversation (app_migration.ownerless.exact_user); every other ownerless row
-- — only in a vanished-member session, P33 refused them elsewhere — is not
-- copied and goes to app_migration.dropped_content with its candidates.
INSERT INTO app_migration.dropped_content (concept, session_id, user_id, text, written_at, candidates)
SELECT 'message_without_owner', m."sessionId", NULL, m.content, m."timestamp", to_jsonb(o.candidates)
FROM "Message" m JOIN app_migration.ownerless o ON o.message_id = m.id
WHERE o.exact_user IS NULL
ORDER BY m."timestamp", m.id;
SELECT app_migration.note('9', 'ownerless ' || role || ' message attributed exactly (one candidate)', count(*), string_agg(message_id::text, ', ' ORDER BY message_id))
FROM app_migration.ownerless WHERE exact_user IS NOT NULL GROUP BY role;
SELECT app_migration.note('9', 'ownerless ' || role || ' message, vanished-member session, not attributable exactly → dropped_content with candidates', count(*),
                          string_agg(message_id::text, ', ' ORDER BY message_id))
FROM app_migration.ownerless WHERE exact_user IS NULL GROUP BY role;

INSERT INTO message (id, conversation_id, sender_participant_id, role, kind, content, content_hash, refining_need_id, source_attempt_id, created_at)
SELECT m.id, c.id,
       CASE WHEN m.role IN ('AI', 'SYSTEM') THEN NULL
            WHEN m.role = 'USER' THEN coalesce(ps.id, po.id)
            ELSE ps.id END,
       (CASE WHEN m.role IN ('USER', 'AI', 'SYSTEM') THEN m.role::text
             WHEN ps.id IS NOT NULL THEN 'USER' ELSE 'AI' END)::message_role,
       (CASE WHEN m.role IN ('USER', 'AI', 'SYSTEM') THEN 'CHAT' ELSE m.role::text END)::message_kind,
       m.content, m."contentHash", m."refiningNeedId",
       CASE m.role::text
         WHEN 'EMPATHY_STATEMENT' THEN
           (SELECT a.id FROM app_migration.empathy_attempt_src a WHERE a."sessionId" = m."sessionId" AND a."sourceUserId" = coalesce(m."senderId", o.owner))
         WHEN 'VALIDATION_FEEDBACK' THEN
           (SELECT a.id FROM app_migration.empathy_attempt_src a WHERE a."sessionId" = m."sessionId"
              AND CASE WHEN m."senderId" IS NOT NULL THEN a."sourceUserId" <> m."senderId" ELSE a."sourceUserId" = o.owner END)
         WHEN 'SHARED_CONTEXT' THEN
           (SELECT a.id FROM app_migration.empathy_attempt_src a WHERE a."sessionId" = m."sessionId"
              AND CASE WHEN m."senderId" IS NOT NULL THEN a."sourceUserId" <> m."senderId" ELSE a."sourceUserId" = o.owner END)
       END,
       m.timestamp
FROM "Message" m
LEFT JOIN app_migration.ownerless ow ON ow.message_id = m.id
CROSS JOIN LATERAL (SELECT coalesce(app_migration.as_uuid(m."forUserId"), m."senderId", ow.exact_user) AS owner) o
JOIN participant po ON po.session_id = m."sessionId" AND po.user_id = o.owner
JOIN conversation c ON c.participant_id = po.id AND c.kind = 'MAIN'
LEFT JOIN participant ps ON ps.session_id = m."sessionId" AND ps.user_id = m."senderId"
ORDER BY m.timestamp, m.id;

SELECT app_migration.note('9', 'Message role ' || m.role::text || ' → role ' || x.role::text || ', kind ' || x.kind::text, count(*))
FROM "Message" m JOIN message x ON x.id = m.id
GROUP BY m.role, x.role, x.kind;
SELECT app_migration.note('9', 'USER message with a nulled sender → sender = the conversation owner', count(*))
FROM "Message" WHERE role = 'USER' AND "senderId" IS NULL AND "forUserId" IS NOT NULL;
SELECT app_migration.note('9', kind::text || ' message without a resolvable source attempt', count(*))
FROM message WHERE kind IN ('EMPATHY_STATEMENT', 'VALIDATION_FEEDBACK', 'SHARED_CONTEXT') AND source_attempt_id IS NULL GROUP BY kind;

-- Stage4SubChatMessage → its SUBCHAT conversation (ids kept); no sender column:
-- USER rows are the sub-chat owner's.
INSERT INTO message (id, conversation_id, sender_participant_id, role, kind, content, content_hash, refining_need_id, source_attempt_id, created_at)
SELECT sm.id, c.id, CASE WHEN sm.role = 'USER' THEN c.participant_id END,
       (CASE WHEN sm.role IN ('USER', 'AI', 'SYSTEM') THEN sm.role::text ELSE 'AI' END)::message_role,
       (CASE WHEN sm.role IN ('USER', 'AI', 'SYSTEM') THEN 'CHAT' ELSE sm.role::text END)::message_kind,
       sm.content, NULL, NULL, NULL, sm."createdAt"
FROM "Stage4SubChatMessage" sm JOIN conversation c ON c.id = sm."subChatId"
ORDER BY sm."createdAt", sm.id;

-- Delivered copies (P0-2): for every REVEALED/VALIDATED attempt, the
-- EMPATHY_STATEMENT the reveal job writes into the SUBJECT's conversation,
-- at revealed_at — today's data has none. content_hash NULL (the plaintext
-- hash is not derivable in SQL from encrypted content).
WITH ins AS (
  INSERT INTO message (id, conversation_id, sender_participant_id, role, kind, content, content_hash, refining_need_id, source_attempt_id, created_at)
  SELECT app_migration.mint(a.revealed_at), c.id, a.author_participant_id, 'USER', 'EMPATHY_STATEMENT', a.content, NULL, NULL, a.id, a.revealed_at
  FROM empathy_attempt a
  JOIN conversation c ON c.participant_id = a.subject_participant_id AND c.kind = 'MAIN'
  WHERE a.status IN ('REVEALED', 'VALIDATED')
    AND NOT EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = c.id AND m.source_attempt_id = a.id AND m.kind = 'EMPATHY_STATEMENT')
  ORDER BY a.revealed_at, a.id
  RETURNING id, source_attempt_id
)
INSERT INTO app_migration.shape_map SELECT 'message:delivered_empathy_statement', source_attempt_id::text, id FROM ins;
SELECT app_migration.note('9', 'delivered EMPATHY_STATEMENT copies inserted (added rows)', count(*))
FROM app_migration.shape_map WHERE concept = 'message:delivered_empathy_statement';

SELECT app_migration.assert(a = b + c + d - e,
         format('step 9: message %s <> Message %s + Stage4SubChatMessage %s + delivered copies %s - unattributable ownerless %s', a, b, c, d, e))
FROM (SELECT (SELECT count(*) FROM message) AS a, (SELECT count(*) FROM "Message") AS b, (SELECT count(*) FROM "Stage4SubChatMessage") AS c,
             (SELECT count(*) FROM app_migration.shape_map WHERE concept = 'message:delivered_empathy_statement') AS d,
             (SELECT count(*) FROM app_migration.ownerless WHERE exact_user IS NULL) AS e) x;

-- Step 11 assertion: every reveal is still resolvable — for every
-- REVEALED/VALIDATED attempt, under the subject's identity
-- (app.current_user_id() via SET LOCAL-equivalent set_config(…, true)), the
-- target SELECT policy on empathy_attempt (spec §1.2: mine(author) OR
-- (mine(subject) AND revealed_at IS NOT NULL)) admits the row, and the
-- subject's own conversation holds its delivered copy.
DO $$
DECLARE
  r   record;
  bad text := '';
  n   int := 0;
BEGIN
  FOR r IN
    SELECT a.id, s.user_id AS subject_user
    FROM empathy_attempt a JOIN participant s ON s.id = a.subject_participant_id
    WHERE a.status IN ('REVEALED', 'VALIDATED')
  LOOP
    PERFORM set_config('app.current_user_id', r.subject_user::text, true);
    IF NOT EXISTS (
         SELECT 1 FROM empathy_attempt a
         WHERE a.id = r.id
           AND (EXISTS (SELECT 1 FROM participant p WHERE p.id = a.author_participant_id AND p.user_id = app.current_user_id())
                OR (EXISTS (SELECT 1 FROM participant p WHERE p.id = a.subject_participant_id AND p.user_id = app.current_user_id())
                    AND a.revealed_at IS NOT NULL)))
       OR NOT EXISTS (
         SELECT 1 FROM message m
         JOIN conversation c ON c.id = m.conversation_id
         JOIN participant p ON p.id = c.participant_id
         WHERE m.source_attempt_id = r.id AND m.kind = 'EMPATHY_STATEMENT' AND p.user_id = app.current_user_id())
    THEN
      n := n + 1;
      bad := bad || ' ' || r.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.current_user_id', '', true);
  PERFORM app_migration.assert(n = 0, format('step 11: %s revealed attempt(s) not resolvable by their subject:%s', n, bad));
END
$$;

-- conversation_read_state ← UserVessel read fields. lastSeenChatItemId keeps
-- only a value that is a migrated message id (FK message SET NULL); others are reported.
INSERT INTO conversation_read_state (participant_id, last_viewed_at, last_seen_message_id, last_viewed_share_tab_at, last_active_at, archived_at, created_at, updated_at)
SELECT p.id, v."lastViewedAt", m.id, v."lastViewedShareTabAt", v."lastActiveAt", v."archivedAt", v."createdAt", v."updatedAt"
FROM "UserVessel" v
JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId"
LEFT JOIN message m ON m.id = app_migration.as_uuid(v."lastSeenChatItemId");
SELECT app_migration.note('6', 'UserVessel.lastSeenChatItemId not a migrated message id → NULL', count(*))
FROM "UserVessel" v
WHERE v."lastSeenChatItemId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM message m WHERE m.id = app_migration.as_uuid(v."lastSeenChatItemId"));
SELECT app_migration.assert(a = b, format('step 6: %s conversation_read_state rows for %s "UserVessel" rows', a, b))
FROM (SELECT (SELECT count(*) FROM conversation_read_state) AS a, (SELECT count(*) FROM "UserVessel") AS b) x;
`;
}

export function stepDraftsConsent(): string {
  return `
-- ---- Step 10: draft. EmpathyDraft → EMPATHY about the other participant;
-- ValidationFeedbackDraft → VALIDATION_FEEDBACK on the partner's attempt;
-- unsent EmpathyValidation.feedback → VALIDATION_FEEDBACK on the reviewed
-- attempt (unless a ValidationFeedbackDraft already holds that point — it is
-- the newer working text; the skipped text is reported); ReconcilerShareOffer
-- .refinedContent → SHARE_CONTEXT on the offer. Ids minted (plan id policy).
WITH ins AS (
  INSERT INTO draft (id, participant_id, kind, about_participant_id, attempt_id, share_offer_id, content, ready_to_share, version, created_at, updated_at)
  SELECT app_migration.mint(d."createdAt"), p.id, 'EMPATHY', o.id, NULL, NULL, d.content, d."readyToShare", d.version, d."createdAt", d."updatedAt"
  FROM "EmpathyDraft" d
  JOIN participant p ON p.session_id = d."sessionId" AND p.user_id = d."userId"
  JOIN participant o ON o.session_id = d."sessionId" AND o.user_id <> d."userId"
  ORDER BY d."createdAt", d.id
  RETURNING id, participant_id, about_participant_id
)
INSERT INTO app_migration.shape_map
SELECT 'draft:EmpathyDraft', d.id::text, ins.id
FROM ins JOIN participant p ON p.id = ins.participant_id
JOIN "EmpathyDraft" d ON d."sessionId" = p.session_id AND d."userId" = p.user_id;

WITH ins AS (
  INSERT INTO draft (id, participant_id, kind, about_participant_id, attempt_id, share_offer_id, content, ready_to_share, version, created_at, updated_at)
  SELECT app_migration.mint(d."createdAt"), p.id, 'VALIDATION_FEEDBACK', NULL, a.id, NULL, d.content, d."readyToShare", 1, d."createdAt", d."updatedAt"
  FROM "ValidationFeedbackDraft" d
  JOIN participant p ON p.session_id = d."sessionId" AND p.user_id = d."userId"
  JOIN app_migration.empathy_attempt_src a ON a."sessionId" = d."sessionId" AND a."sourceUserId" <> d."userId"
  ORDER BY d."createdAt", d.id
  RETURNING id, participant_id
)
INSERT INTO app_migration.shape_map
SELECT 'draft:ValidationFeedbackDraft', d.id::text, ins.id
FROM ins JOIN participant p ON p.id = ins.participant_id
JOIN "ValidationFeedbackDraft" d ON d."sessionId" = p.session_id AND d."userId" = p.user_id;

WITH src AS (
  SELECT v.id AS validation_id, p.id AS participant_id, v."attemptId", v.feedback, coalesce(v."validatedAt", a.submitted_at) AS at
  FROM app_migration.empathy_validation_src v
  JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId"
  JOIN empathy_attempt a ON a.id = v."attemptId"
  WHERE NOT v."feedbackShared" AND v.feedback IS NOT NULL
), ins AS (
  INSERT INTO draft (id, participant_id, kind, about_participant_id, attempt_id, share_offer_id, content, ready_to_share, version, created_at, updated_at)
  SELECT app_migration.mint(at), participant_id, 'VALIDATION_FEEDBACK', NULL, "attemptId", NULL, feedback, false, 1, at, at
  FROM src
  WHERE NOT EXISTS (SELECT 1 FROM draft d WHERE d.participant_id = src.participant_id AND d.kind = 'VALIDATION_FEEDBACK' AND d.attempt_id = src."attemptId")
  ORDER BY at, validation_id
  RETURNING id, participant_id, attempt_id
)
INSERT INTO app_migration.shape_map
SELECT 'draft:EmpathyValidation.feedback', v.id::text, ins.id
FROM ins JOIN participant p ON p.id = ins.participant_id
JOIN app_migration.empathy_validation_src v ON v."attemptId" = ins.attempt_id AND v."userId" = p.user_id;
INSERT INTO app_migration.dropped_content (concept, session_id, user_id, text, written_at)
SELECT 'EmpathyValidation.feedback (unsent; superseded by a ValidationFeedbackDraft)', v."sessionId", v."userId", v.feedback, v."validatedAt"
FROM app_migration.empathy_validation_src v
JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId"
WHERE NOT v."feedbackShared" AND v.feedback IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM app_migration.shape_map s WHERE s.concept = 'draft:EmpathyValidation.feedback' AND s.old_key = v.id::text);
SELECT app_migration.note('10', 'unsent EmpathyValidation.feedback superseded by a ValidationFeedbackDraft → dropped_content', count(*))
FROM app_migration.empathy_validation_src v
JOIN participant p ON p.session_id = v."sessionId" AND p.user_id = v."userId"
WHERE NOT v."feedbackShared" AND v.feedback IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM app_migration.shape_map s WHERE s.concept = 'draft:EmpathyValidation.feedback' AND s.old_key = v.id::text);

WITH ins AS (
  INSERT INTO draft (id, participant_id, kind, about_participant_id, attempt_id, share_offer_id, content, ready_to_share, version, created_at, updated_at)
  SELECT app_migration.mint(o.updated_at), o.subject_participant_id, 'SHARE_CONTEXT', NULL, NULL, o.id, r."refinedContent", false, 1, o.updated_at, o.updated_at
  FROM "ReconcilerShareOffer" r JOIN context_share_offer o ON o.id = r.id
  WHERE r."refinedContent" IS NOT NULL
  ORDER BY o.updated_at, o.id
  RETURNING id, share_offer_id
)
INSERT INTO app_migration.shape_map SELECT 'draft:ReconcilerShareOffer.refinedContent', share_offer_id::text, id FROM ins;

SELECT app_migration.assert(a = b, format('step 10: %s drafts for %s sources', a, b))
FROM (SELECT (SELECT count(*) FROM draft) AS a,
             (SELECT count(*) FROM app_migration.shape_map WHERE concept LIKE 'draft:%') AS b) x;
SELECT app_migration.assert(a = b, format('step 10: %s EMPATHY drafts for %s "EmpathyDraft" rows', a, b))
FROM (SELECT (SELECT count(*) FROM draft WHERE kind = 'EMPATHY') AS a, (SELECT count(*) FROM "EmpathyDraft") AS b) x;
SELECT app_migration.assert(n = 0, format('step 10: %s sharing point(s) with more than one draft', n))
FROM (SELECT count(*) AS n FROM (
        SELECT 1 FROM draft GROUP BY participant_id, kind, coalesce(about_participant_id, attempt_id, share_offer_id) HAVING count(*) > 1) d) x;

-- ---- Step 12: consent ← ConsentRecord (ids kept). Arc column by targetType:
-- IDENTIFIED_NEED → need_id; EMPATHY_ATTEMPT → empathy_attempt_id;
-- EMPATHY_DRAFT → empathy_attempt_id of the draft's attempt (the writer
-- stores the EmpathyDraft id, stage2.ts:682); STRATEGY_PROPOSAL → proposal_id.
-- sessionId (nullable) falls back to the target's session. target_kind is
-- written here because Prisma's DDL made it a plain NOT NULL column; the
-- trailer re-creates it GENERATED from the same arc. metadata dropped.
WITH t AS (
  SELECT c.*,
         CASE c."targetType" WHEN 'IDENTIFIED_NEED' THEN app_migration.as_uuid(c."targetId") END AS t_need,
         CASE c."targetType"
           WHEN 'EMPATHY_ATTEMPT' THEN app_migration.as_uuid(c."targetId")
           WHEN 'EMPATHY_DRAFT' THEN coalesce(
             (SELECT a.id FROM app_migration.empathy_attempt_src a WHERE a.id = app_migration.as_uuid(c."targetId")),
             (SELECT a.id FROM app_migration.empathy_attempt_src a WHERE a."draftId" = app_migration.as_uuid(c."targetId") ORDER BY a.id LIMIT 1),
             (SELECT a.id FROM "EmpathyDraft" d JOIN app_migration.empathy_attempt_src a ON a."sessionId" = d."sessionId" AND a."sourceUserId" = d."userId"
              WHERE d.id = app_migration.as_uuid(c."targetId")))
         END AS t_attempt,
         CASE c."targetType" WHEN 'STRATEGY_PROPOSAL' THEN app_migration.as_uuid(c."targetId") END AS t_proposal
  FROM "ConsentRecord" c
), s AS (
  SELECT t.*, coalesce(t."sessionId",
           (SELECT p.session_id FROM need n JOIN participant p ON p.id = n.participant_id WHERE n.id = t.t_need),
           (SELECT p.session_id FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id WHERE a.id = t.t_attempt),
           (SELECT pr.session_id FROM proposal pr WHERE pr.id = t.t_proposal)) AS t_session
  FROM t
)
INSERT INTO consent (id, participant_id, requested_by_participant_id, need_id, empathy_attempt_id, proposal_id, share_offer_id, review_id,
                     target_kind, decision, decided_at, revoked_at, created_at, updated_at)
SELECT s.id, pd.id, pr.id, s.t_need, s.t_attempt, s.t_proposal, NULL, NULL,
       (CASE WHEN s.t_need IS NOT NULL THEN 'NEED' WHEN s.t_attempt IS NOT NULL THEN 'EMPATHY_ATTEMPT' ELSE 'PROPOSAL' END)::consent_target,
       s.decision::text::consent_decision, s."decidedAt", s."revokedAt", s."createdAt", coalesce(s."revokedAt", s."decidedAt", s."createdAt")
FROM s
JOIN participant pd ON pd.session_id = s.t_session AND pd.user_id = s."userId"
LEFT JOIN participant pr ON pr.session_id = s.t_session AND pr.user_id = s."requestedByUserId";

SELECT app_migration.note('12', 'ConsentRecord.targetType ' || "targetType"::text, count(*)) FROM "ConsentRecord" GROUP BY "targetType";
SELECT app_migration.note('12', 'ConsentRecord.metadata dropped', count(*)) FROM "ConsentRecord" WHERE app_migration.jnull(metadata) IS NOT NULL;
SELECT app_migration.assert(a = b, format('step 12: %s consent rows for %s "ConsentRecord" rows (decider must be a participant)', a, b))
FROM (SELECT (SELECT count(*) FROM consent) AS a, (SELECT count(*) FROM "ConsentRecord") AS b) x;
SELECT app_migration.assert(n = 0, format('step 12: %s consent row(s) without exactly one arc target', n))
FROM (SELECT count(*) AS n FROM consent WHERE num_nonnulls(need_id, empathy_attempt_id, proposal_id, share_offer_id, review_id) <> 1) x;
SELECT app_migration.assert(n = 0, format('step 12: %s consent row(s) with a requester that is not a participant of the session', n))
FROM (SELECT count(*) AS n FROM consent c JOIN "ConsentRecord" o ON o.id = c.id
      WHERE o."requestedByUserId" IS NOT NULL AND c.requested_by_participant_id IS NULL) x;
-- T-consent-owner on every migrated row: the decider owns the arc target.
SELECT app_migration.assert(n = 0, format('step 12: %s consent row(s) name a target the decider does not own (T-consent-owner): %s', n, ids))
FROM (SELECT count(*) AS n, string_agg(c.id::text, ', ' ORDER BY c.id) AS ids
      FROM consent c
      LEFT JOIN need n ON n.id = c.need_id
      LEFT JOIN empathy_attempt a ON a.id = c.empathy_attempt_id
      LEFT JOIN proposal p ON p.id = c.proposal_id
      WHERE c.participant_id IS DISTINCT FROM coalesce(n.participant_id, a.author_participant_id, p.created_by_participant_id)) x;
`;
}
