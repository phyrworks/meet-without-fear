/**
 * (3c) Copies, plan §3 steps 13 (rest) and 14: proposal_need · proposal_choice
 * · proposal_revision · agreement · agreement_party · session_closure ·
 * follow_up · follow_up_checkin · follow_up_note · reminder.
 */

export function stepProposals(): string {
  return `
-- ---- Step 13: proposal_need ← StrategyProposalNeed ∪ needsAddressed[] labels
-- matched case-insensitively to a need of the session, both filtered to needs
-- with a need_share row (P0-1). A label that matches several shared needs
-- links each. Unmatched or unshared → proposal.unresolved_need_labels (first
-- occurrence order, case-insensitively distinct).
CREATE TABLE app_migration.proposal_need_src AS
SELECT spn."proposalId" AS proposal_id, spn."needId" AS need_id, n.need AS label, 0 AS ord, spn."createdAt" AS at, 'StrategyProposalNeed' AS source
FROM "StrategyProposalNeed" spn JOIN "IdentifiedNeed" n ON n.id = spn."needId"
UNION ALL
SELECT sp.id, m.need_id, l.label, l.ord::int, sp."createdAt", 'needsAddressed'
FROM "StrategyProposal" sp
CROSS JOIN LATERAL unnest(coalesce(sp."needsAddressed", '{}')) WITH ORDINALITY AS l (label, ord)
LEFT JOIN LATERAL (
  SELECT n.id AS need_id FROM need n JOIN participant p ON p.id = n.participant_id
  WHERE p.session_id = sp."sessionId" AND lower(trim(n.label)) = lower(trim(l.label))
) m ON true;

INSERT INTO proposal_need (proposal_id, need_id, created_at)
SELECT s.proposal_id, ns.need_id, min(s.at)
FROM app_migration.proposal_need_src s JOIN need_share ns ON ns.need_id = s.need_id
GROUP BY s.proposal_id, ns.need_id
ORDER BY 1, 2;

UPDATE proposal p SET unresolved_need_labels = u.labels
FROM (
  SELECT proposal_id, array_agg(label ORDER BY ord, label) AS labels
  FROM (
    SELECT DISTINCT ON (s.proposal_id, lower(trim(s.label))) s.proposal_id, s.label, s.ord
    FROM app_migration.proposal_need_src s
    WHERE s.label IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM app_migration.proposal_need_src s2 JOIN need_share ns ON ns.need_id = s2.need_id
                      WHERE s2.proposal_id = s.proposal_id AND lower(trim(s2.label)) = lower(trim(s.label)))
    ORDER BY s.proposal_id, lower(trim(s.label)), s.ord
  ) d
  GROUP BY proposal_id
) u
WHERE u.proposal_id = p.id;

SELECT app_migration.note('13', 'needsAddressed label coverage: ' || outcome, count(*))
FROM (SELECT CASE WHEN EXISTS (SELECT 1 FROM need_share ns WHERE ns.need_id = s.need_id) THEN 'linked to a shared need'
                  WHEN s.need_id IS NOT NULL THEN 'matched an unshared need → unresolved_need_labels'
                  ELSE 'no match → unresolved_need_labels' END AS outcome
      FROM app_migration.proposal_need_src s WHERE s.source = 'needsAddressed') x
GROUP BY outcome;
SELECT app_migration.note('13', 'StrategyProposalNeed on an unshared need → unresolved_need_labels', count(*))
FROM app_migration.proposal_need_src s
WHERE s.source = 'StrategyProposalNeed' AND NOT EXISTS (SELECT 1 FROM need_share ns WHERE ns.need_id = s.need_id);
SELECT app_migration.assert(n = 0, format('step 13: %s proposal_need row(s) on a need without need_share', n))
FROM (SELECT count(*) AS n FROM proposal_need pn WHERE NOT EXISTS (SELECT 1 FROM need_share ns WHERE ns.need_id = pn.need_id)) x;

-- proposal_choice ← Stage4ProposalSelection.
INSERT INTO proposal_choice (proposal_id, participant_id, decision, note, created_at, updated_at)
SELECT s."proposalId", p.id, s.decision::text::choice_decision, s.note, s."selectedAt", s."updatedAt"
FROM "Stage4ProposalSelection" s JOIN participant p ON p.session_id = s."sessionId" AND p.user_id = s."userId";
SELECT app_migration.assert(a = b, format('step 13: %s proposal_choice rows for %s "Stage4ProposalSelection" rows', a, b))
FROM (SELECT (SELECT count(*) FROM proposal_choice) AS a, (SELECT count(*) FROM "Stage4ProposalSelection") AS b) x;

-- proposal_revision ← Stage4ProposalRevision (ids kept): action upper-snaked;
-- sessionId asserted (P23b) then dropped; messageId dropped.
INSERT INTO proposal_revision (id, proposal_id, actor_participant_id, action, before, after, reason, created_at)
SELECT r.id, r."proposalId", pa.id,
       upper(regexp_replace(regexp_replace(r.action, '([a-z0-9])([A-Z])', '\\1_\\2', 'g'), '[^A-Za-z0-9]+', '_', 'g'))::revision_action,
       app_migration.jnull(r.before), app_migration.jnull(r.after), r.reason, r."createdAt"
FROM "Stage4ProposalRevision" r
JOIN "StrategyProposal" sp ON sp.id = r."proposalId"
LEFT JOIN participant pa ON pa.session_id = sp."sessionId" AND pa.user_id = app_migration.as_uuid(r."actorUserId");
SELECT app_migration.note('13', 'Stage4ProposalRevision.messageId dropped', count(*)) FROM "Stage4ProposalRevision" WHERE "messageId" IS NOT NULL;
SELECT app_migration.assert(a = b, format('step 13: %s proposal_revision rows for %s "Stage4ProposalRevision" rows', a, b))
FROM (SELECT (SELECT count(*) FROM proposal_revision) AS a, (SELECT count(*) FROM "Stage4ProposalRevision") AS b) x;

-- agreement ← Agreement (ids kept; session via SharedVessel). PROPOSED with
-- both agreed → AGREED; PROPOSED otherwise → dropped (the proposal remains;
-- listed). created_at = agreedAt, else the proposal's createdAt (Agreement has no createdAt).
SELECT app_migration.note('13', 'PROPOSED agreement not accepted by both: dropped', count(*), string_agg(id::text, ', ' ORDER BY id))
FROM "Agreement" WHERE status = 'PROPOSED' AND NOT ("agreedByA" AND "agreedByB");
INSERT INTO app_migration.dropped_content (concept, session_id, user_id, text, written_at)
SELECT 'Agreement.description (PROPOSED, not accepted by both; dropped)', sv."sessionId", NULL, a.description, a."agreedAt"
FROM "Agreement" a JOIN "SharedVessel" sv ON sv.id = a."sharedVesselId"
WHERE a.status = 'PROPOSED' AND NOT (a."agreedByA" AND a."agreedByB");
SELECT app_migration.note('13', 'PROPOSED agreement accepted by both → AGREED', count(*))
FROM "Agreement" WHERE status = 'PROPOSED' AND "agreedByA" AND "agreedByB";
INSERT INTO agreement (id, session_id, proposal_id, type, status, description, duration, measure_of_success, follow_up_at, completed_at, created_at, updated_at)
SELECT a.id, sv."sessionId", a."proposalId", a.type::text::agreement_type,
       (CASE a.status::text WHEN 'PROPOSED' THEN 'AGREED' ELSE a.status::text END)::agreement_status,
       a.description, a.duration, a."measureOfSuccess", a."followUpDate", a."completedAt",
       coalesce(a."agreedAt", sp."createdAt"), greatest(coalesce(a."agreedAt", sp."createdAt"), a."completedAt")
FROM "Agreement" a
JOIN "SharedVessel" sv ON sv.id = a."sharedVesselId"
JOIN "StrategyProposal" sp ON sp.id = a."proposalId"
WHERE a.status <> 'PROPOSED' OR (a."agreedByA" AND a."agreedByB");

SELECT app_migration.assert(a = b - c, format('step 13: %s agreement rows for %s "Agreement" rows - %s dropped PROPOSED', a, b, c))
FROM (SELECT (SELECT count(*) FROM agreement) AS a, (SELECT count(*) FROM "Agreement") AS b,
             (SELECT count(*) FROM "Agreement" WHERE status = 'PROPOSED' AND NOT ("agreedByA" AND "agreedByB")) AS c) x;

-- agreement_party ← agreedByA/agreedByB through the A/B slots.
INSERT INTO agreement_party (agreement_id, participant_id, agreed_at, created_at)
SELECT ag.id, s.participant_id, ag.created_at, ag.created_at
FROM agreement ag
JOIN "Agreement" a ON a.id = ag.id
JOIN app_migration.ab_slot s ON s.session_id = ag.session_id
WHERE (s.slot = 'A' AND a."agreedByA") OR (s.slot = 'B' AND a."agreedByB");
SELECT app_migration.assert(a = b, format('step 13: %s agreement_party rows for %s agreedByA/agreedByB flags', a, b))
FROM (SELECT (SELECT count(*) FROM agreement_party) AS a,
             (SELECT coalesce(sum(a."agreedByA"::int + a."agreedByB"::int), 0) FROM "Agreement" a JOIN agreement ag ON ag.id = a.id) AS b) x;

-- Agreement.agreedByA/B is also choice evidence (spec §1.4 proposal_choice
-- Absorbs): a party without a choice on the proposal gets WILLING at
-- agreed_at, so T-agreement-parties (ii) holds for the legacy ranking flow,
-- which wrote no selections. Reported as added rows.
WITH ins AS (
  INSERT INTO proposal_choice (proposal_id, participant_id, decision, note, created_at, updated_at)
  SELECT ag.proposal_id, ap.participant_id, 'WILLING', NULL, ap.agreed_at, ap.agreed_at
  FROM agreement_party ap JOIN agreement ag ON ag.id = ap.agreement_id
  WHERE NOT EXISTS (SELECT 1 FROM proposal_choice c WHERE c.proposal_id = ag.proposal_id AND c.participant_id = ap.participant_id)
  RETURNING proposal_id, participant_id
)
INSERT INTO app_migration.shape_map SELECT 'proposal_choice:from_agreement', proposal_id::text || ':' || participant_id::text, participant_id FROM ins;
SELECT app_migration.note('13', 'proposal_choice WILLING synthesised from Agreement.agreedByA/B (added rows)', count(*))
FROM app_migration.shape_map WHERE concept = 'proposal_choice:from_agreement';

-- T-agreement-parties, evaluated on every migrated agreement (its deferred
-- trigger only sees rows written after the trailer creates it): the parties
-- are the human participants present when it was created — a tombstoned
-- leaver (left_at = the migration) included (spec §4 "what survives").
SELECT app_migration.assert(n = 0, format('step 13: %s agreement(s) whose parties are not exactly the human participants present at creation, all WILLING: %s', n, ids))
FROM (SELECT count(*) AS n, string_agg(ag.id::text, ', ' ORDER BY ag.id) AS ids
      FROM agreement ag
      WHERE EXISTS (SELECT participant_id FROM agreement_party WHERE agreement_id = ag.id
                    EXCEPT SELECT id FROM participant WHERE session_id = ag.session_id AND kind = 'human'
                                                        AND (left_at IS NULL OR left_at > ag.created_at))
         OR EXISTS (SELECT id FROM participant WHERE session_id = ag.session_id AND kind = 'human'
                                                AND (left_at IS NULL OR left_at > ag.created_at)
                    EXCEPT SELECT participant_id FROM agreement_party WHERE agreement_id = ag.id)
         OR EXISTS (SELECT 1 FROM agreement_party ap
                    WHERE ap.agreement_id = ag.id
                      AND NOT EXISTS (SELECT 1 FROM proposal_choice c WHERE c.proposal_id = ag.proposal_id
                                        AND c.participant_id = ap.participant_id AND c.decision = 'WILLING'))) x;

-- session_closure ← Stage4Closure minus the three arrays (→ v_session_closure_items,
-- compared in the trailer against app_migration.old_closure).
INSERT INTO session_closure (session_id, kind, reason, summary, closed_by_participant_id, check_in_at, closed_at, created_at)
SELECT c."sessionId", c.kind::text::closure_kind, c.reason::text::closure_reason, c.summary, p.id, c."checkInAt", c."closedAt", c."createdAt"
FROM "Stage4Closure" c
LEFT JOIN participant p ON p.session_id = c."sessionId" AND p.user_id = app_migration.as_uuid(c."closedByUserId");
INSERT INTO app_migration.old_closure (session_id, shared_agreement_ids, individual_proposal_ids, open_need_ids)
SELECT "sessionId", coalesce("sharedAgreementIds", '{}'), coalesce("individualProposalIds", '{}'), coalesce("openNeedIds", '{}')
FROM "Stage4Closure";
-- Explanation inputs for the trailer's closure comparison (R20): the old
-- coverage rows of closed sessions, and needsAddressed labels that matched
-- no need case-insensitively.
INSERT INTO app_migration.old_coverage (session_id, need_id, status, covering_proposal_ids)
SELECT c."sessionId", app_migration.as_uuid(c."needId"), c."coverageStatus", coalesce(c."coveringProposalIds", '{}')
FROM "Stage4NeedCoverage" c
WHERE app_migration.as_uuid(c."needId") IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Stage4Closure" x WHERE x."sessionId" = c."sessionId")
ORDER BY c."sessionId", c."needId";
INSERT INTO app_migration.proposal_nomatch_label (proposal_id, label)
SELECT DISTINCT s.proposal_id, s.label FROM app_migration.proposal_need_src s
WHERE s.source = 'needsAddressed' AND s.need_id IS NULL AND s.label IS NOT NULL
ORDER BY 1, 2;
SELECT app_migration.assert(a = b, format('step 13: %s session_closure rows for %s "Stage4Closure" rows', a, b))
FROM (SELECT (SELECT count(*) FROM session_closure) AS a, (SELECT count(*) FROM "Stage4Closure") AS b) x;
SELECT app_migration.note('13', 'StrategyRanking dropped (ranking not in the product flow)', count(*)) FROM "StrategyRanking";
`;
}

export function stepFollowUp(): string {
  return `
-- ---- Step 14: follow_up ← TendingEntry (ids kept). type: the *_CHECKIN suffix
-- goes (owner decision 2026-10-21), any other value RAISEs. response_deadline_at
-- and summary from the entry's OPEN TendingCoordinationCycle (plan step 14),
-- else its latest; the entry's own summary wins when both are set, and the
-- cycle's differing resultSummary goes to app_migration.dropped_content.
INSERT INTO follow_up (id, session_id, agreement_id, proposal_id, type, scope, owner_participant_id, opted_in_shared, status,
                       scheduled_for, response_deadline_at, opened_at, completed_at, summary, created_at, updated_at)
SELECT e.id, e."sessionId", ag.id, NULL,
       (CASE e.type::text
          WHEN 'SCHEDULED_SHARED_AGREEMENT_CHECKIN' THEN 'SCHEDULED_SHARED_AGREEMENT'
          WHEN 'SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN' THEN 'SCHEDULED_INDIVIDUAL_COMMITMENT'
          WHEN 'USER_INITIATED_REENTRY' THEN 'USER_INITIATED_REENTRY'
          ELSE app_migration.unmapped('TendingEntry.type', e.type::text)
        END)::follow_up_type,
       e.scope::text::follow_up_scope, po.id, e."optedInShared", e.status::text::follow_up_status,
       e."scheduledFor", y."responseDeadlineAt", e."openedAt", e."completedAt", coalesce(e.summary, y."resultSummary"),
       e."createdAt", e."updatedAt"
FROM "TendingEntry" e
LEFT JOIN agreement ag ON ag.id = e."agreementId"
LEFT JOIN participant po ON po.session_id = e."sessionId" AND po.user_id = app_migration.as_uuid(e."ownerUserId")
LEFT JOIN LATERAL (
  SELECT * FROM "TendingCoordinationCycle" c WHERE e.id = ANY (c."entryIds") ORDER BY (c.status IN ('WAITING_FOR_PARTNER', 'READY_TO_RESOLVE')) DESC, c."createdAt" DESC, c.id DESC LIMIT 1
) y ON true;
INSERT INTO app_migration.dropped_content (concept, session_id, user_id, text, written_at)
SELECT 'TendingCoordinationCycle.resultSummary (differs from the entry summary kept)', e."sessionId", y."createdByUserId", y."resultSummary", y."updatedAt"
FROM "TendingEntry" e
JOIN LATERAL (SELECT * FROM "TendingCoordinationCycle" c WHERE e.id = ANY (c."entryIds") ORDER BY (c.status IN ('WAITING_FOR_PARTNER', 'READY_TO_RESOLVE')) DESC, c."createdAt" DESC, c.id DESC LIMIT 1) y ON true
WHERE e.summary IS NOT NULL AND y."resultSummary" IS NOT NULL AND e.summary <> y."resultSummary";
SELECT app_migration.note('14', 'TendingEntry.summary and its cycle resultSummary both set and different (entry kept; cycle text → dropped_content)', count(*))
FROM "TendingEntry" e
JOIN LATERAL (SELECT * FROM "TendingCoordinationCycle" c WHERE e.id = ANY (c."entryIds") ORDER BY (c.status IN ('WAITING_FOR_PARTNER', 'READY_TO_RESOLVE')) DESC, c."createdAt" DESC, c.id DESC LIMIT 1) y ON true
WHERE e.summary IS NOT NULL AND y."resultSummary" IS NOT NULL AND e.summary <> y."resultSummary";
-- The entry's open (else latest) cycle — the one response_deadline_at came
-- from — for the trailer's v_follow_up_cycle comparison.
INSERT INTO app_migration.old_cycle (follow_up_id, cycle_id, status)
SELECT e.id, y.id, y.status::text
FROM "TendingEntry" e
JOIN LATERAL (SELECT * FROM "TendingCoordinationCycle" c WHERE e.id = ANY (c."entryIds") ORDER BY (c.status IN ('WAITING_FOR_PARTNER', 'READY_TO_RESOLVE')) DESC, c."createdAt" DESC, c.id DESC LIMIT 1) y ON true;
SELECT app_migration.assert(a = b, format('step 14: %s follow_up rows for %s "TendingEntry" rows', a, b))
FROM (SELECT (SELECT count(*) FROM follow_up) AS a, (SELECT count(*) FROM "TendingEntry") AS b) x;
SELECT app_migration.assert(n = 0, format('step 14: %s follow_up row(s) lost their agreement or owner', n))
FROM (SELECT count(*) AS n FROM "TendingEntry" e JOIN follow_up f ON f.id = e.id
      WHERE (e."agreementId" IS NOT NULL AND f.agreement_id IS NULL) OR (e."ownerUserId" IS NOT NULL AND f.owner_participant_id IS NULL)) x;

-- follow_up_checkin: one row per (old check-in, entry it covers) — a check-in
-- covers its cycle's entryIds and every entry its responses / outcomes /
-- adjustments name (P24c/P24d: at least one entry, never two check-ins of one
-- user on one entry). Children without an entry (need outcomes, carried
-- notes) go on the check-in's first row (lowest entry id). An orphan
-- TendingResponse (checkinId NULL) joins the row for its (entry, user), or
-- gets a synthetic check-in at its submittedAt.
INSERT INTO app_migration.checkin_map (checkin_id, entry_id, user_id, session_id, submitted_at, is_first, new_id)
SELECT checkin_id, entry_id, user_id, session_id, submitted_at, rn = 1, app_migration.mint(submitted_at)
FROM (
  SELECT c.id AS checkin_id, x.entry_id, c."userId" AS user_id, c."sessionId" AS session_id, c."submittedAt" AS submitted_at,
         row_number() OVER (PARTITION BY c.id ORDER BY x.entry_id) AS rn
  FROM "TendingCheckin" c
  CROSS JOIN LATERAL (
    SELECT e AS entry_id FROM "TendingCoordinationCycle" y CROSS JOIN unnest(y."entryIds") AS e WHERE y.id = c."coordinationCycleId"
    UNION SELECT r."tendingEntryId" FROM "TendingResponse" r WHERE r."checkinId" = c.id
    UNION SELECT o."tendingEntryId" FROM "TendingEntryOutcome" o WHERE o."checkinId" = c.id
    UNION SELECT a."tendingEntryId" FROM "TendingAdjustment" a WHERE a."checkinId" = c.id
  ) x
) z
ORDER BY submitted_at, checkin_id, entry_id;
INSERT INTO app_migration.checkin_map (checkin_id, entry_id, user_id, session_id, submitted_at, is_first, new_id)
SELECT NULL, r."tendingEntryId", r."userId", e."sessionId", r."submittedAt", true, app_migration.mint(r."submittedAt")
FROM "TendingResponse" r JOIN "TendingEntry" e ON e.id = r."tendingEntryId"
WHERE r."checkinId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM app_migration.checkin_map m WHERE m.entry_id = r."tendingEntryId" AND m.user_id = r."userId")
ORDER BY r."submittedAt", r.id;
SELECT app_migration.note('14', 'orphan TendingResponse → synthetic check-in (added rows)', count(*))
FROM app_migration.checkin_map WHERE checkin_id IS NULL;
SELECT app_migration.note('14', 'orphan TendingResponse joined an existing check-in of its (entry, user)', count(*))
FROM "TendingResponse" r
WHERE r."checkinId" IS NULL
  AND EXISTS (SELECT 1 FROM app_migration.checkin_map m WHERE m.entry_id = r."tendingEntryId" AND m.user_id = r."userId" AND m.checkin_id IS NOT NULL);
INSERT INTO app_migration.shape_map
SELECT 'follow_up_checkin', coalesce(checkin_id::text, 'orphan') || ':' || entry_id::text || ':' || user_id::text, new_id
FROM app_migration.checkin_map;

INSERT INTO follow_up_checkin (id, follow_up_id, participant_id, next_action, continue_choice, reflection_summary, payload, submitted_at, created_at)
SELECT m.new_id, m.entry_id, p.id, c."nextAction"::text::next_action,
       coalesce(c."continueChoice", (SELECT r."continueChoice" FROM "TendingResponse" r
                                     WHERE m.checkin_id IS NULL AND r."tendingEntryId" = m.entry_id AND r."userId" = m.user_id))::text::continue_choice,
       c."reflectionSummary",
       jsonb_build_object(
         'responses', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'reflection', r.reflection,
                                                'continueChoice', r."continueChoice", 'submittedAt', r."submittedAt")
                             ORDER BY r."submittedAt", r.id)
            FROM "TendingResponse" r
            WHERE r."tendingEntryId" = m.entry_id AND r."userId" = m.user_id
              AND (r."checkinId" = m.checkin_id OR r."checkinId" IS NULL)), '[]'::jsonb),
         'entryOutcomes', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', o.id, 'responseId', o."responseId", 'followThroughStatus', o."followThroughStatus",
                                                'helpfulnessStatus', o."helpfulnessStatus", 'blockerCategories', to_jsonb(o."blockerCategories"),
                                                'whatHappened', o."whatHappened", 'helpedNeed', o."helpedNeed", 'blockerNote', o."blockerNote",
                                                'stillWorthTrying', o."stillWorthTrying", 'createdAt', o."createdAt")
                             ORDER BY o."createdAt", o.id)
            FROM "TendingEntryOutcome" o WHERE o."checkinId" = m.checkin_id AND o."tendingEntryId" = m.entry_id), '[]'::jsonb),
         'adjustments', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', a.id, 'privacyScope', a."privacyScope", 'revisedCommitmentText', a."revisedCommitmentText",
                                                'revisedCadence', a."revisedCadence", 'revisedScope', a."revisedScope",
                                                'revisedSuccessCriteria', a."revisedSuccessCriteria", 'reason', a.reason,
                                                'blockerAddressed', to_jsonb(a."blockerAddressed"), 'createdAt', a."createdAt")
                             ORDER BY a."createdAt", a.id)
            FROM "TendingAdjustment" a WHERE a."checkinId" = m.checkin_id AND a."tendingEntryId" = m.entry_id), '[]'::jsonb),
         'partialClosures', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', pc.id, 'responseId', pc."tendingResponseId", 'followUpId', pc."tendingEntryId",
                                                'resolution', pc.resolution, 'createdAt', pc."createdAt")
                             ORDER BY pc."createdAt", pc.id)
            FROM "TendingResponsePartialClosure" pc JOIN "TendingResponse" r ON r.id = pc."tendingResponseId"
            WHERE r."tendingEntryId" = m.entry_id AND r."userId" = m.user_id
              AND (r."checkinId" = m.checkin_id OR r."checkinId" IS NULL)), '[]'::jsonb),
         'needOutcomes', coalesce((
            SELECT jsonb_agg(jsonb_build_object('id', n.id, 'needId', ns.need_id, 'needLabel', n."needLabel",
                                                'sourceParticipantId', sp.id, 'resolutionStatus', n."resolutionStatus", 'note', n.note,
                                                'changedNeedLabel', n."changedNeedLabel", 'nextAction', n."nextAction", 'createdAt', n."createdAt")
                             ORDER BY n."createdAt", n.id)
            FROM "TendingNeedOutcome" n
            LEFT JOIN need_share ns ON ns.need_id = app_migration.as_uuid(n."needId")
            LEFT JOIN participant sp ON sp.session_id = n."sessionId" AND sp.user_id = app_migration.as_uuid(n."sourceUserId")
            WHERE m.is_first AND n."checkinId" = m.checkin_id), '[]'::jsonb),
         'carriedNotes', coalesce((
            SELECT jsonb_agg(jsonb_build_object('noteId', b.id, 'content', b.content, 'shareConsentAt', b."shareConsentAt", 'createdAt', b."createdAt")
                             ORDER BY b."createdAt", b.id)
            FROM "TendingBetweenPeriodNote" b
            WHERE m.is_first AND b."selectedForCheckinId" = m.checkin_id AND b."consentToShareWithPartner"), '[]'::jsonb)
       ),
       m.submitted_at, coalesce(c."createdAt", m.submitted_at)
FROM app_migration.checkin_map m
JOIN participant p ON p.session_id = m.session_id AND p.user_id = m.user_id
LEFT JOIN "TendingCheckin" c ON c.id = m.checkin_id
ORDER BY m.submitted_at, m.new_id;

-- Conservation per concept: Σ array lengths = old child rows (incl. orphans).
SELECT app_migration.assert(got = want, format('step 14: payload.%s holds %s entries for %s old rows', k, got, want))
FROM (
  SELECT k,
         (SELECT coalesce(sum(jsonb_array_length(payload -> k)), 0) FROM follow_up_checkin) AS got,
         CASE k WHEN 'responses' THEN (SELECT count(*) FROM "TendingResponse")
                WHEN 'entryOutcomes' THEN (SELECT count(*) FROM "TendingEntryOutcome")
                WHEN 'adjustments' THEN (SELECT count(*) FROM "TendingAdjustment")
                WHEN 'partialClosures' THEN (SELECT count(*) FROM "TendingResponsePartialClosure")
                WHEN 'needOutcomes' THEN (SELECT count(*) FROM "TendingNeedOutcome")
                WHEN 'carriedNotes' THEN (SELECT count(*) FROM "TendingBetweenPeriodNote"
                                          WHERE "selectedForCheckinId" IS NOT NULL AND "consentToShareWithPartner")
         END AS want
  FROM unnest(ARRAY['responses', 'entryOutcomes', 'adjustments', 'partialClosures', 'needOutcomes', 'carriedNotes']) AS k
) x;
SELECT app_migration.assert(a = b, format('step 14: %s follow_up_checkin rows for %s mapped (check-in, entry) pairs', a, b))
FROM (SELECT (SELECT count(*) FROM follow_up_checkin) AS a, (SELECT count(*) FROM app_migration.checkin_map) AS b) x;

-- follow_up_note ← TendingBetweenPeriodNote (ids kept); selectedForCheckinId →
-- carried_into_checkin_id (the check-in's first row); consent flags → the copy above.
INSERT INTO follow_up_note (id, participant_id, content, carry_forward, carried_into_checkin_id, created_at, updated_at)
SELECT b.id, p.id, b.content, b."carryForwardSelected", m.new_id, b."createdAt", b."updatedAt"
FROM "TendingBetweenPeriodNote" b
JOIN participant p ON p.session_id = b."sessionId" AND p.user_id = b."userId"
LEFT JOIN app_migration.checkin_map m ON m.checkin_id = b."selectedForCheckinId" AND m.is_first;
SELECT app_migration.assert(a = b, format('step 14: %s follow_up_note rows for %s "TendingBetweenPeriodNote" rows', a, b))
FROM (SELECT (SELECT count(*) FROM follow_up_note) AS a, (SELECT count(*) FROM "TendingBetweenPeriodNote") AS b) x;

-- reminder ← TendingReminder (ids kept; status text → enum, P24b checked).
INSERT INTO reminder (id, user_id, follow_up_id, scope, remind_at, cadence, note, status, created_at, updated_at)
SELECT r.id, r."userId", r."tendingEntryId", r.scope::text::reminder_scope, r."remindAt", r.cadence, r.note, r.status::reminder_status,
       r."createdAt", r."updatedAt"
FROM "TendingReminder" r;
SELECT app_migration.note('14', 'TendingReminder.' || c || ' dropped (reminder keys on user + follow_up)', n)
FROM (SELECT 'checkinId' AS c, count(*) FILTER (WHERE "checkinId" IS NOT NULL) AS n FROM "TendingReminder"
      UNION ALL SELECT 'sessionId', count(*) FROM "TendingReminder") x;
SELECT app_migration.assert(a = b, format('step 14: %s reminder rows for %s "TendingReminder" rows', a, b))
FROM (SELECT (SELECT count(*) FROM reminder) AS a, (SELECT count(*) FROM "TendingReminder") AS b) x;
SELECT app_migration.note('14', 'TendingCoordinationCycle dropped (→ response_deadline_at/summary + v_follow_up_cycle)', count(*))
FROM "TendingCoordinationCycle";
`;
}
