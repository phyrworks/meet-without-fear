/**
 * (2b) Prechecks — plan §3 step 0b. Every check lists its offending ids into
 * app_migration.precheck; after the last one a single DO block RAISEs with
 * every failing check, its count and up to ten offenders. Expected empty on
 * production after the rehearsal's fix-data script
 * (scripts/target-shape/fix-data.template.sql has one block per check name).
 *
 * The plan's nine prechecks come first (P01–P09); the rest (P10+) guard a
 * target constraint or mapping that would otherwise fail later with a bare
 * constraint error and no ids.
 */

import {
  DISPOSITION_KEYS,
  DROPPED_KEYS,
  DROPPED_MUST_BE_EMPTY,
  MILESTONE_RULES,
  TIMESTAMP_KEYS,
  WALKTHROUGH_KEYS,
  litArr,
  q,
} from './maps';

/** Every key the step-7 table knows. */
export const KNOWN_GATE_KEYS = [
  ...new Set([
    ...MILESTONE_RULES.map((r) => r.gate),
    ...TIMESTAMP_KEYS,
    ...DROPPED_KEYS.map((d) => d.key),
    ...DISPOSITION_KEYS,
  ]),
].sort();

/** Every precheck, as registered by prechecks(): the fix-data template is rendered from the same list. */
export const CHECKS: Array<{ title: string; name: string; select: string }> = [];

const P = (title: string, select: string) => {
  CHECKS.push({ title, name: title.split(' ')[1], select: select.trim() });
  return `-- ${title}\nINSERT INTO app_migration.precheck (check_name, offender, detail)\n${select.trim()};\n`;
};

export function prechecks(): string {
  CHECKS.length = 0;
  const parts: string[] = [];

  // ---------------- the plan's prechecks ----------------
  parts.push(P('P01 live_sessions_per_relationship (A-Q3 partial unique)', `
SELECT 'live_sessions_per_relationship', "relationshipId"::text, string_agg(id::text, ', ' ORDER BY id)
FROM "Session"
WHERE status NOT IN ('RESOLVED', 'ABANDONED', 'ARCHIVED')
GROUP BY "relationshipId"
HAVING count(*) > 1`));

  parts.push(P('P02 ai_message_with_sender (target message role/sender CHECK, P3 §6)', `
SELECT 'ai_message_with_sender', id::text, role::text
FROM "Message"
WHERE role IN ('AI', 'SYSTEM') AND "senderId" IS NOT NULL`));

  parts.push(P('P03 agreement_without_proposal (agreement.proposal_id NOT NULL, P1-10)', `
SELECT 'agreement_without_proposal', id::text, status::text
FROM "Agreement"
WHERE "proposalId" IS NULL`));

  // P04: PROPOSED agreements nobody fully accepted are dropped (listed in the
  // report by step 13); fatal only when a TendingEntry still points at one.
  parts.push(P('P04 dropped_proposed_agreement_in_use (PROPOSED dropped unless both agreed, P1-10)', `
SELECT 'dropped_proposed_agreement_in_use', a.id::text, 'tending entries: ' || string_agg(e.id::text, ', ' ORDER BY e.id)
FROM "Agreement" a
JOIN "TendingEntry" e ON e."agreementId" = a.id
WHERE a.status = 'PROPOSED' AND NOT (a."agreedByA" AND a."agreedByB")
GROUP BY a.id`));

  parts.push(P('P05 user_name_mismatch (user.name becomes GENERATED, P2)', `
SELECT 'user_name_mismatch', id::text,
       format('name=%L generated=%L', name, nullif(trim(coalesce("firstName", '') || ' ' || coalesce("lastName", '')), ''))
FROM "User"
WHERE name IS DISTINCT FROM nullif(trim(coalesce("firstName", '') || ' ' || coalesce("lastName", '')), '')`));

  parts.push(P('P06a gates_not_object', `
SELECT 'gates_not_object', id::text, jsonb_typeof("gatesSatisfied")
FROM "StageProgress"
WHERE "gatesSatisfied" IS NOT NULL AND jsonb_typeof("gatesSatisfied") NOT IN ('object', 'null')`));

  parts.push(P('P06b unknown_gate_key (step 7 key table; unknown key = unmodelled state)', `
SELECT 'unknown_gate_key', sp.id::text, k
FROM "StageProgress" sp
CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(sp."gatesSatisfied") = 'object' THEN sp."gatesSatisfied" ELSE '{}'::jsonb END) AS k
WHERE k <> ALL (${litArr(KNOWN_GATE_KEYS)})`));

  parts.push(P('P06c walkthrough_shape (stage4Walkthrough → need_disposition)', `
SELECT 'walkthrough_shape', sp.id::text, coalesce(k, jsonb_typeof(w))
FROM "StageProgress" sp
CROSS JOIN LATERAL (SELECT sp."gatesSatisfied" -> 'stage4Walkthrough' AS w) x
LEFT JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(w) = 'object' THEN w ELSE '{}'::jsonb END) AS k ON true
WHERE jsonb_typeof(sp."gatesSatisfied") = 'object' AND w IS NOT NULL AND jsonb_typeof(w) <> 'null'
  AND (jsonb_typeof(w) <> 'object'
       OR k <> ALL (${litArr(WALKTHROUGH_KEYS)})
       OR jsonb_typeof(coalesce(w -> 'coveredNeedIds', '[]')) <> 'array'
       OR jsonb_typeof(coalesce(w -> 'skippedNeedIds', '[]')) <> 'array')`));

  parts.push(P('P06d gate_timestamp_unparseable', `
SELECT 'gate_timestamp_unparseable', sp.id::text, k || '=' || (sp."gatesSatisfied" ->> k)
FROM "StageProgress" sp
CROSS JOIN unnest(${litArr(TIMESTAMP_KEYS)}) AS k
WHERE jsonb_typeof(sp."gatesSatisfied") = 'object'
  AND jsonb_typeof(sp."gatesSatisfied" -> k) NOT IN ('null')
  AND app_migration.ts(sp."gatesSatisfied" -> k) IS NULL`));

  parts.push(P('P07a consent_target_type (arc: 4 old types map to the target arc)', `
SELECT 'consent_target_type', id::text, "targetType"::text
FROM "ConsentRecord"
WHERE "targetType" NOT IN ('IDENTIFIED_NEED', 'EMPATHY_ATTEMPT', 'EMPATHY_DRAFT', 'STRATEGY_PROPOSAL')`));

  parts.push(P('P07b consent_target_unresolved (targetId must resolve, P0-3)', `
SELECT 'consent_target_unresolved', c.id::text, c."targetType"::text || ':' || coalesce(c."targetId", 'NULL')
FROM "ConsentRecord" c
WHERE c."targetType" IN ('IDENTIFIED_NEED', 'EMPATHY_ATTEMPT', 'EMPATHY_DRAFT', 'STRATEGY_PROPOSAL')
  AND NOT CASE c."targetType"
    WHEN 'IDENTIFIED_NEED' THEN EXISTS (SELECT 1 FROM "IdentifiedNeed" n WHERE n.id = app_migration.as_uuid(c."targetId"))
    WHEN 'EMPATHY_ATTEMPT' THEN EXISTS (SELECT 1 FROM "EmpathyAttempt" a WHERE a.id = app_migration.as_uuid(c."targetId"))
    WHEN 'EMPATHY_DRAFT' THEN
         EXISTS (SELECT 1 FROM "EmpathyAttempt" a WHERE a.id = app_migration.as_uuid(c."targetId") OR a."draftId" = app_migration.as_uuid(c."targetId"))
      OR EXISTS (SELECT 1 FROM "EmpathyDraft" d JOIN "EmpathyAttempt" a ON a."sessionId" = d."sessionId" AND a."sourceUserId" = d."userId"
                 WHERE d.id = app_migration.as_uuid(c."targetId"))
    WHEN 'STRATEGY_PROPOSAL' THEN EXISTS (SELECT 1 FROM "StrategyProposal" p WHERE p.id = app_migration.as_uuid(c."targetId"))
  END`));

  parts.push(P('P08 ab_slot_tie_with_split_agreement (P1-8: a joinedAt tie decides A/B only when agreedByA <> agreedByB)', `
SELECT 'ab_slot_tie_with_split_agreement', s.id::text, 'agreements: ' || string_agg(a.id::text, ', ' ORDER BY a.id)
FROM "Session" s
JOIN "SharedVessel" sv ON sv."sessionId" = s.id
JOIN "Agreement" a ON a."sharedVesselId" = sv.id AND a."agreedByA" <> a."agreedByB"
WHERE (SELECT count(*) FROM (
         SELECT m."joinedAt" FROM "RelationshipMember" m WHERE m."relationshipId" = s."relationshipId"
         ORDER BY m."joinedAt", m.ctid LIMIT 2) two
       HAVING count(DISTINCT "joinedAt") = 1 AND count(*) = 2) IS NOT NULL
GROUP BY s.id`));

  // P09 (vanished members) is a report, not a failure: step 4a lists them.

  // ---------------- guards for target constraints and mappings ----------------
  parts.push(P('P10 dropped_table_not_empty (census §2: unpopulated; dropping content is never silent)', `
SELECT 'dropped_table_not_empty', table_name, n::text || ' row(s)'
FROM app_migration.row_counts
WHERE phase = 'before' AND n > 0 AND table_name = ANY (${litArr(DROPPED_MUST_BE_EMPTY)})`));

  parts.push(P('P11 relationship_role (text → relationship_role enum)', `
SELECT 'relationship_role', "relationshipId"::text || ':' || "userId"::text, role
FROM "RelationshipMember"
WHERE role NOT IN ('member', 'owner')`));

  parts.push(P('P12 session_resolved_without_resolved_at (CHECK status <> RESOLVED OR resolved_at)', `
SELECT 'session_resolved_without_resolved_at', id::text, NULL
FROM "Session"
WHERE status = 'RESOLVED' AND "resolvedAt" IS NULL`));

  // A live or resolved session needs two participants (step 4a assertion,
  // T-cardinality-1). Sessions that step 4a abandons (a vanished member,
  // non-terminal) are exempt.
  parts.push(P('P13 session_without_two_participants (step 4a; T-cardinality-1)', `
SELECT 'session_without_two_participants', s.id::text,
       s.status::text || ', participants: ' || coalesce((SELECT string_agg(DISTINCT p.user_id::text, ', ') FROM app_migration.pair p WHERE p.session_id = s.id), 'none')
FROM "Session" s
WHERE s.status IN ('ACTIVE', 'WAITING', 'PAUSED', 'RESOLVED')
  AND (SELECT count(DISTINCT p.user_id) FROM app_migration.pair p WHERE p.session_id = s.id) < 2
  AND NOT (s.status <> 'RESOLVED'
           AND EXISTS (SELECT 1 FROM app_migration.pair p JOIN app_migration.vanished v USING (user_id) WHERE p.session_id = s.id))`));

  parts.push(P('P14a invitation_accepted_without_accepted_at (CHECK, P3 §6)', `
SELECT 'invitation_accepted_without_accepted_at', id::text, NULL
FROM "Invitation"
WHERE status = 'ACCEPTED' AND "acceptedAt" IS NULL`));

  parts.push(P('P14b invitation_accepted_without_unique_acceptor (accepted_by_user_id = the one non-inviter member)', `
SELECT 'invitation_accepted_without_unique_acceptor', i.id::text,
       (SELECT count(*) FROM "RelationshipMember" m WHERE m."relationshipId" = s."relationshipId" AND m."userId" <> i."invitedById")::text
       || ' non-inviter member(s)'
FROM "Invitation" i JOIN "Session" s ON s.id = i."sessionId"
WHERE i.status = 'ACCEPTED'
  AND (SELECT count(*) FROM "RelationshipMember" m WHERE m."relationshipId" = s."relationshipId" AND m."userId" <> i."invitedById") <> 1`));

  parts.push(P('P15a attempt_without_author (empathy_attempt.author NOT NULL)', `
SELECT 'attempt_without_author', id::text, NULL
FROM "EmpathyAttempt"
WHERE "sourceUserId" IS NULL`));

  parts.push(P('P15b attempt_without_unique_subject (step 11: subject = the other participant; RAISE if N≠2)', `
SELECT 'attempt_without_unique_subject', a.id::text,
       (SELECT count(DISTINCT p.user_id) FROM app_migration.pair p WHERE p.session_id = a."sessionId" AND p.user_id <> a."sourceUserId")::text
       || ' other participant(s)'
FROM "EmpathyAttempt" a
WHERE a."sourceUserId" IS NOT NULL
  AND (SELECT count(DISTINCT p.user_id) FROM app_migration.pair p WHERE p.session_id = a."sessionId" AND p.user_id <> a."sourceUserId") <> 1`));

  parts.push(P('P15c empathy_draft_without_unique_subject (draft.about_participant_id = the other participant)', `
SELECT 'empathy_draft_without_unique_subject', d.id::text,
       (SELECT count(DISTINCT p.user_id) FROM app_migration.pair p WHERE p.session_id = d."sessionId" AND p.user_id <> d."userId")::text
       || ' other participant(s)'
FROM "EmpathyDraft" d
WHERE (SELECT count(DISTINCT p.user_id) FROM app_migration.pair p WHERE p.session_id = d."sessionId" AND p.user_id <> d."userId") <> 1`));

  parts.push(P('P15d attempt_revealed_without_revealed_at (CHECK REVEALED/VALIDATED → revealed_at)', `
SELECT 'attempt_revealed_without_revealed_at', id::text, status::text
FROM "EmpathyAttempt"
WHERE status IN ('REVEALED', 'VALIDATED') AND "revealedAt" IS NULL`));

  parts.push(P('P16a validation_without_reviewer (empathy_review.reviewer NOT NULL)', `
SELECT 'validation_without_reviewer', id::text, NULL
FROM "EmpathyValidation"
WHERE "userId" IS NULL`));

  parts.push(P('P16b validation_reviewer_is_author (reviewer = the subject of the attempt)', `
SELECT 'validation_reviewer_is_author', v.id::text, NULL
FROM "EmpathyValidation" v JOIN "EmpathyAttempt" a ON a.id = v."attemptId"
WHERE v."userId" = a."sourceUserId"`));

  parts.push(P('P16c validation_draft_without_partner_attempt (draft(VALIDATION_FEEDBACK).attempt = the attempt of the partner)', `
SELECT 'validation_draft_without_partner_attempt', d.id::text,
       (SELECT count(*) FROM "EmpathyAttempt" a WHERE a."sessionId" = d."sessionId" AND a."sourceUserId" <> d."userId")::text || ' partner attempt(s)'
FROM "ValidationFeedbackDraft" d
WHERE (SELECT count(*) FROM "EmpathyAttempt" a WHERE a."sessionId" = d."sessionId" AND a."sourceUserId" <> d."userId") <> 1`));

  parts.push(P('P17a reconciler_result_without_attempt (result → attempt by (session, guesser))', `
SELECT 'reconciler_result_without_attempt', r.id::text, r."guesserId"
FROM "ReconcilerResult" r
WHERE NOT EXISTS (SELECT 1 FROM "EmpathyAttempt" a
                  WHERE a."sessionId" = r."sessionId" AND a."sourceUserId" = app_migration.as_uuid(r."guesserId"))`));

  parts.push(P('P17b reconciler_result_two_current (sql_result_one_current)', `
SELECT 'reconciler_result_two_current', "sessionId"::text || ':' || "guesserId" || '->' || "subjectId",
       string_agg(id::text, ', ' ORDER BY id)
FROM "ReconcilerResult"
WHERE "supersededAt" IS NULL
GROUP BY "sessionId", "guesserId", "subjectId"
HAVING count(*) > 1`));

  parts.push(P('P17c reconciler_result_duplicate_iteration (UNIQUE (attempt_id, iteration))', `
SELECT 'reconciler_result_duplicate_iteration', "sessionId"::text || ':' || "guesserId" || ' #' || iteration,
       string_agg(id::text, ', ' ORDER BY id)
FROM "ReconcilerResult"
GROUP BY "sessionId", "guesserId", iteration
HAVING count(*) > 1`));

  parts.push(P('P17d reconciler_result_enum (gap_severity / recommender_action)', `
SELECT 'reconciler_result_enum', id::text, format('gapSeverity=%L recommendedAction=%L', "gapSeverity", "recommendedAction")
FROM "ReconcilerResult"
WHERE upper("gapSeverity") NOT IN ('NONE', 'MINOR', 'MODERATE', 'SIGNIFICANT')
   OR "recommendedAction" NOT IN ('PROCEED', 'OFFER_OPTIONAL', 'OFFER_SHARING')`));

  parts.push(P('P17e reconciler_result_self (CHECK author <> subject)', `
SELECT 'reconciler_result_self', id::text, NULL
FROM "ReconcilerResult"
WHERE "guesserId" = "subjectId"`));

  parts.push(P('P17f reconciler_result_score_range (CHECK alignment_score 0..100)', `
SELECT 'reconciler_result_score_range', id::text, "alignmentScore"::text
FROM "ReconcilerResult"
WHERE "alignmentScore" NOT BETWEEN 0 AND 100`));

  parts.push(P('P18a share_offer_status_dates (CHECK ACCEPTED ⇔ shared_at, DECLINED ⇔ declined_at)', `
SELECT 'share_offer_status_dates', id::text, format('status=%s sharedAt=%s declinedAt=%s', status, "sharedAt", "declinedAt")
FROM "ReconcilerShareOffer"
WHERE (status = 'ACCEPTED') <> ("sharedAt" IS NOT NULL)
   OR (status = 'DECLINED') <> ("declinedAt" IS NOT NULL)`));

  parts.push(P('P18b share_offer_user_not_subject (context_share_offer.subject = result.subject)', `
SELECT 'share_offer_user_not_subject', o.id::text, o."userId" || ' <> ' || r."subjectId"
FROM "ReconcilerShareOffer" o JOIN "ReconcilerResult" r ON r.id = o."resultId"
WHERE o."userId" <> r."subjectId"`));

  parts.push(P('P18c share_offer_duplicate_iteration (UNIQUE (attempt_id, iteration))', `
SELECT 'share_offer_duplicate_iteration', r."sessionId"::text || ':' || r."guesserId" || ' #' || o.iteration,
       string_agg(o.id::text, ', ' ORDER BY o.id)
FROM "ReconcilerShareOffer" o JOIN "ReconcilerResult" r ON r.id = o."resultId"
GROUP BY r."sessionId", r."guesserId", o.iteration
HAVING count(*) > 1`));

  parts.push(P('P19a consent_decision_undated (CHECK (decision IS NULL) = (decided_at IS NULL), P3 §6)', `
SELECT 'consent_decision_undated', id::text, format('decision=%s decidedAt=%s', decision, "decidedAt")
FROM "ConsentRecord"
WHERE (decision IS NULL) <> ("decidedAt" IS NULL)`));

  parts.push(P('P19b consent_revoked_not_revoked (CHECK revoked_at IS NULL OR decision = REVOKED)', `
SELECT 'consent_revoked_not_revoked', id::text, format('decision=%s', decision)
FROM "ConsentRecord"
WHERE "revokedAt" IS NOT NULL AND decision IS DISTINCT FROM 'REVOKED'`));

  parts.push(P('P20a consented_content_target (need_share.need_id via consentRecordId → ConsentRecord.targetId)', `
SELECT 'consented_content_target', cc.id::text, cr."targetType"::text || ':' || coalesce(cr."targetId", 'NULL')
FROM "ConsentedContent" cc JOIN "ConsentRecord" cr ON cr.id = cc."consentRecordId"
WHERE cr."targetType" <> 'IDENTIFIED_NEED'
   OR NOT EXISTS (SELECT 1 FROM "IdentifiedNeed" n WHERE n.id = app_migration.as_uuid(cr."targetId"))
   OR (cc."originalNeedId" IS NOT NULL AND cc."originalNeedId" IS DISTINCT FROM app_migration.as_uuid(cr."targetId"))`));

  parts.push(P('P20b consented_content_duplicate_need (need_share PK need_id)', `
SELECT 'consented_content_duplicate_need', cr."targetId", string_agg(cc.id::text, ', ' ORDER BY cc.id)
FROM "ConsentedContent" cc JOIN "ConsentRecord" cr ON cr.id = cc."consentRecordId"
GROUP BY cr."targetId"
HAVING count(*) > 1`));

  parts.push(P('P20c consented_content_revocation (inactive needs revokedAt; CHECK revoked_at >= shared_at)', `
SELECT 'consented_content_revocation', id::text, format('consentActive=%s revokedAt=%s consentedAt=%s', "consentActive", "revokedAt", "consentedAt")
FROM "ConsentedContent"
WHERE (NOT "consentActive" AND "revokedAt" IS NULL) OR "revokedAt" < "consentedAt"`));

  parts.push(P('P20d consented_content_session (session of the need owner = SharedVessel session)', `
SELECT 'consented_content_session', cc.id::text, NULL
FROM "ConsentedContent" cc
JOIN "ConsentRecord" cr ON cr.id = cc."consentRecordId"
JOIN "SharedVessel" sv ON sv.id = cc."sharedVesselId"
JOIN "IdentifiedNeed" n ON n.id = app_migration.as_uuid(cr."targetId")
JOIN "UserVessel" uv ON uv.id = n."vesselId"
WHERE uv."sessionId" <> sv."sessionId"`));

  parts.push(P('P21 proposal_removed_dates (CHECK (status = REMOVED) = (removed_at IS NOT NULL))', `
SELECT 'proposal_removed_dates', id::text, format('status=%s removedAt=%s', status, "removedAt")
FROM "StrategyProposal"
WHERE (status = 'REMOVED') <> ("removedAt" IS NOT NULL)`));

  parts.push(P('P22a agreement_duplicate_proposal (UNIQUE agreement.proposal_id)', `
SELECT 'agreement_duplicate_proposal', "proposalId"::text, string_agg(id::text, ', ' ORDER BY id)
FROM "Agreement"
WHERE "proposalId" IS NOT NULL AND (status <> 'PROPOSED' OR ("agreedByA" AND "agreedByB"))
GROUP BY "proposalId"
HAVING count(*) > 1`));

  // T-agreement-parties: the party set is every live human participant. An
  // agreement that survives step 13 with a missing party would fail it.
  parts.push(P('P22b agreement_parties_incomplete (T-agreement-parties: every participant is a party)', `
SELECT 'agreement_parties_incomplete', id::text, format('status=%s agreedByA=%s agreedByB=%s', status, "agreedByA", "agreedByB")
FROM "Agreement"
WHERE status <> 'PROPOSED' AND NOT ("agreedByA" AND "agreedByB")`));

  parts.push(P('P22c agreement_party_not_willing (T-agreement-parties: every party WILLING)', `
SELECT 'agreement_party_not_willing', a.id::text, 'NOT_WILLING selection ' || s.id::text
FROM "Agreement" a
JOIN "Stage4ProposalSelection" s ON s."proposalId" = a."proposalId" AND s.decision = 'NOT_WILLING'
WHERE a.status <> 'PROPOSED' OR (a."agreedByA" AND a."agreedByB")`));

  parts.push(P('P23a revision_action_unknown (action → revision_action, upper snake)', `
SELECT 'revision_action_unknown', id::text, action
FROM "Stage4ProposalRevision"
WHERE upper(regexp_replace(regexp_replace(action, '([a-z0-9])([A-Z])', '\\1_\\2', 'g'), '[^A-Za-z0-9]+', '_', 'g'))
      NOT IN ('CREATED', 'REVISED', 'REMOVED', 'RESTORED', 'CONVERTED', 'CAPTURE_SKIPPED', 'COVERED', 'SUBCHAT_REFINED')`));

  parts.push(P('P23b revision_session_mismatch (sessionId asserted = that of the proposal, then dropped)', `
SELECT 'revision_session_mismatch', r.id::text, r."sessionId" || ' <> ' || p."sessionId"::text
FROM "Stage4ProposalRevision" r JOIN "StrategyProposal" p ON p.id = r."proposalId"
WHERE r."sessionId" <> p."sessionId"::text`));

  parts.push(P('P23c revision_json_not_object (CHECK jsonb_typeof(before/after) = object)', `
SELECT 'revision_json_not_object', id::text, format('before=%s after=%s', jsonb_typeof(before), jsonb_typeof(after))
FROM "Stage4ProposalRevision"
WHERE coalesce(jsonb_typeof(before), 'null') NOT IN ('object', 'null')
   OR coalesce(jsonb_typeof(after), 'null') NOT IN ('object', 'null')`));

  parts.push(P('P24a follow_up_scope_owner (CHECK (scope = INDIVIDUAL) = (owner IS NOT NULL))', `
SELECT 'follow_up_scope_owner', id::text, format('scope=%s ownerUserId=%s', scope, "ownerUserId")
FROM "TendingEntry"
WHERE (scope = 'INDIVIDUAL') <> ("ownerUserId" IS NOT NULL)`));

  parts.push(P('P24b reminder_status_unknown (text → reminder_status)', `
SELECT 'reminder_status_unknown', id::text, status
FROM "TendingReminder"
WHERE status NOT IN ('SCHEDULED', 'DELIVERED', 'CANCELLED')`));

  parts.push(P('P24c checkin_without_entry (a check-in must land on a follow_up)', `
SELECT 'checkin_without_entry', c.id::text, NULL
FROM "TendingCheckin" c
WHERE NOT EXISTS (SELECT 1 FROM "TendingCoordinationCycle" y WHERE y.id = c."coordinationCycleId" AND cardinality(y."entryIds") > 0)
  AND NOT EXISTS (SELECT 1 FROM "TendingResponse" r WHERE r."checkinId" = c.id)
  AND NOT EXISTS (SELECT 1 FROM "TendingEntryOutcome" o WHERE o."checkinId" = c.id)
  AND NOT EXISTS (SELECT 1 FROM "TendingAdjustment" a WHERE a."checkinId" = c.id)`));

  parts.push(P('P24d checkin_entry_duplicate (UNIQUE follow_up_checkin (follow_up_id, participant_id))', `
WITH covers AS (
  SELECT c.id AS checkin_id, c."userId" AS user_id, e AS entry_id
  FROM "TendingCheckin" c
  JOIN "TendingCoordinationCycle" y ON y.id = c."coordinationCycleId"
  CROSS JOIN unnest(y."entryIds") AS e
  UNION SELECT r."checkinId", r."userId", r."tendingEntryId" FROM "TendingResponse" r WHERE r."checkinId" IS NOT NULL
  UNION SELECT o."checkinId", o."userId", o."tendingEntryId" FROM "TendingEntryOutcome" o
  UNION SELECT a."checkinId", a."userId", a."tendingEntryId" FROM "TendingAdjustment" a
)
SELECT 'checkin_entry_duplicate', entry_id::text || ':' || user_id::text, string_agg(DISTINCT checkin_id::text, ', ')
FROM covers
GROUP BY entry_id, user_id
HAVING count(DISTINCT checkin_id) > 1`));

  parts.push(P('P24e cycle_entry_unknown (TendingCoordinationCycle.entryIds must be entries)', `
SELECT 'cycle_entry_unknown', y.id::text, e::text
FROM "TendingCoordinationCycle" y CROSS JOIN unnest(y."entryIds") AS e
WHERE NOT EXISTS (SELECT 1 FROM "TendingEntry" t WHERE t.id = e)`));

  // Step 17: every FK-less text id that becomes a real FK must be uuid-shaped.
  const textIds: Array<[string, string]> = [
    ['Message', 'forUserId'], ['ReconcilerResult', 'guesserId'], ['ReconcilerResult', 'subjectId'],
    ['ReconcilerShareOffer', 'userId'], ['Stage4NeedDeclination', 'userId'], ['Stage4NeedDeclination', 'needId'],
    ['Stage4ProposalRevision', 'actorUserId'], ['Stage4Closure', 'closedByUserId'], ['TendingEntry', 'ownerUserId'],
    ['TendingNeedOutcome', 'sourceUserId'], ['ConsentRecord', 'targetId'],
  ];
  parts.push(P('P25 text_id_not_uuid (step 17: every resolved value cast to uuid)', textIds
    .map(([t, c]) => `SELECT 'text_id_not_uuid', id::text, '${t}.${c}=' || ${q(c)}
FROM ${q(t)} WHERE ${q(c)} IS NOT NULL AND app_migration.as_uuid(${q(c)}) IS NULL`)
    .join('\nUNION ALL\n')));

  parts.push(P('P26 declination_need_unresolved (step 17: Stage4NeedDeclination.needId found)', `
SELECT 'declination_need_unresolved', d.id::text, d."needId"
FROM "Stage4NeedDeclination" d
WHERE app_migration.as_uuid(d."needId") IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "IdentifiedNeed" n WHERE n.id = app_migration.as_uuid(d."needId"))`));

  parts.push(P('P27 intensity_out_of_range (intensity domain 1..10)', `
SELECT 'intensity_out_of_range', id::text, 'EmotionalReading.intensity=' || intensity
FROM "EmotionalReading" WHERE intensity NOT BETWEEN 1 AND 10
UNION ALL
SELECT 'intensity_out_of_range', id::text, format('EmotionalExerciseCompletion before=%s after=%s', "intensityBefore", "intensityAfter")
FROM "EmotionalExerciseCompletion"
WHERE "intensityBefore" NOT BETWEEN 1 AND 10 OR "intensityAfter" NOT BETWEEN 1 AND 10`));

  parts.push(P('P28a summary_not_json_object (conversationSummary text → jsonb, RAISE on invalid JSON)', `
SELECT 'summary_not_json_object', 'UserVessel:' || id::text, left("conversationSummary", 60)
FROM "UserVessel"
WHERE "conversationSummary" IS NOT NULL
  AND (NOT pg_input_is_valid("conversationSummary", 'jsonb') OR jsonb_typeof("conversationSummary"::jsonb) <> 'object'
       OR NOT ("conversationSummary"::jsonb ?& ARRAY['text', 'messageCount', 'generatedAt']))
UNION ALL
SELECT 'summary_not_json_object', 'InnerWorkSession:' || id::text, left("conversationSummary", 60)
FROM "InnerWorkSession"
WHERE "conversationSummary" IS NOT NULL
  AND (NOT pg_input_is_valid("conversationSummary", 'jsonb') OR jsonb_typeof("conversationSummary"::jsonb) <> 'object')`));

  parts.push(P('P28b facts_shape (ai_memory *_FACTS doc requires a facts array)', `
SELECT 'facts_shape', 'UserVessel:' || id::text, jsonb_typeof("notableFacts")
FROM "UserVessel"
WHERE app_migration.jnull("notableFacts") IS NOT NULL
  AND jsonb_typeof("notableFacts") <> 'array'
  AND NOT (jsonb_typeof("notableFacts") = 'object' AND jsonb_typeof("notableFacts" -> 'facts') = 'array')
UNION ALL
SELECT 'facts_shape', 'User:' || id::text, jsonb_typeof("globalFacts")
FROM "User"
WHERE app_migration.jnull("globalFacts") IS NOT NULL
  AND jsonb_typeof("globalFacts") <> 'array'
  AND NOT (jsonb_typeof("globalFacts") = 'object' AND jsonb_typeof("globalFacts" -> 'facts') = 'array')`));

  parts.push(P('P28c jsonb_not_container (CHECK jsonb_typeof on every jsonb column)', `
SELECT 'jsonb_not_container', 'BrainActivity:' || id::text,
       format('input=%s output=%s metadata=%s structuredOutput=%s', jsonb_typeof(input), jsonb_typeof(output), jsonb_typeof(metadata), jsonb_typeof("structuredOutput"))
FROM "BrainActivity"
WHERE coalesce(jsonb_typeof(input), 'null') NOT IN ('object', 'array', 'null')
   OR coalesce(jsonb_typeof(output), 'null') NOT IN ('object', 'array', 'null')
   OR coalesce(jsonb_typeof(metadata), 'null') NOT IN ('object', 'array', 'null')
   OR coalesce(jsonb_typeof("structuredOutput"), 'null') NOT IN ('object', 'array', 'null')
UNION ALL
SELECT 'jsonb_not_container', 'User:' || id::text,
       format('memory=%s notifications=%s privacy=%s', jsonb_typeof("memoryPreferences"), jsonb_typeof("notificationPreferences"), jsonb_typeof("privacyPreferences"))
FROM "User"
WHERE coalesce(jsonb_typeof("memoryPreferences"), 'null') NOT IN ('object', 'null')
   OR coalesce(jsonb_typeof("notificationPreferences"), 'null') NOT IN ('object', 'null')
   OR coalesce(jsonb_typeof("privacyPreferences"), 'null') NOT IN ('object', 'null')`));

  parts.push(P('P29 inner_work_message_role (reflection_message.role is USER/AI/SYSTEM)', `
SELECT 'inner_work_message_role', id::text, role::text
FROM "InnerWorkMessage"
WHERE role NOT IN ('USER', 'AI', 'SYSTEM')`));

  parts.push(P('P30 need_confidence_range (CHECK ai_confidence 0..1)', `
SELECT 'need_confidence_range', id::text, "aiConfidence"::text
FROM "IdentifiedNeed"
WHERE "aiConfidence" NOT BETWEEN 0 AND 1`));

  parts.push(P('P31 takeaway_link_self (CHECK source_id <> target_id)', `
SELECT 'takeaway_link_self', id::text, NULL
FROM "TakeawayLink"
WHERE "sourceId" = "targetId"`));

  parts.push(P('P32 brain_cost_overflow (cost numeric(10,6))', `
SELECT 'brain_cost_overflow', id::text, cost::text
FROM "BrainActivity"
WHERE abs(cost) >= 10000`));

  parts.push(`
-- The single verdict: every failing precheck at once, with ids.
DO $$
DECLARE
  r   record;
  msg text := '';
  total bigint;
BEGIN
  SELECT count(*) INTO total FROM app_migration.precheck;
  IF total = 0 THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT check_name, count(*) AS n,
           string_agg(offender || coalesce(' (' || detail || ')', ''), '; ' ORDER BY offender) FILTER (WHERE rn <= 10) AS sample
    FROM (SELECT p.*, row_number() OVER (PARTITION BY check_name ORDER BY offender) AS rn FROM app_migration.precheck p) x
    GROUP BY check_name
    ORDER BY check_name
  LOOP
    msg := msg || E'\\n  ' || r.check_name || ' x' || r.n || ': ' || r.sample;
  END LOOP;
  RAISE EXCEPTION 'target_shape: % precheck offender(s); the database is unchanged:%', total, msg
    USING HINT = 'Fix the data with backend/scripts/target-shape/fix-data.template.sql (one block per check name) and re-run.';
END
$$;
`);

  return parts.join('\n');
}
