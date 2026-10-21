/**
 * The pre-migration fix-data script template (TS-7 deliverable 4), rendered
 * from the migration's own precheck list so the offender queries can never
 * drift from what the migration checks:
 *
 *   npx tsx scripts/gen-target-migration.ts --fix-data-template > scripts/target-shape/fix-data.template.sql
 *
 * One block per precheck: why it exists, the query that lists offenders
 * (exactly the precheck's), and the corrective statement an operator fills
 * in — commented out, with the decision it needs. Every check name must have
 * an entry in FIXES and vice versa (generation fails otherwise). Expected
 * empty on production after the rehearsal; fix-data.fixtures.sql is the
 * template filled in for the seeded scratch database.
 */

import { beforeCounts, evidenceSrc, helperFns, pairSet } from './workspace';
import { CHECKS, prechecks } from './prechecks';

/** Corrective guidance per check name: comment lines, then a commented statement. */
const FIXES: Record<string, string> = {
  live_sessions_per_relationship: `
-- Decide which session stays live; end the others (ABANDONED, or ARCHIVED if
-- already resolved in substance).
-- UPDATE "Session" SET status = 'ABANDONED', "updatedAt" = now() WHERE id IN (<older live session ids>);`,
  ai_message_with_sender: `
-- An AI/SYSTEM row with a sender is a human authoring as the facilitator
-- (work-kpkq.4). If the sender is the real author, it is a USER message;
-- otherwise null the sender.
-- UPDATE "Message" SET "senderId" = NULL WHERE id IN (<ids>);
-- or: UPDATE "Message" SET role = 'USER' WHERE id IN (<ids>);`,
  agreement_without_proposal: `
-- Find the proposal the agreement was converted from (same session,
-- description) and link it; an agreement with no proposal cannot exist.
-- UPDATE "Agreement" SET "proposalId" = '<proposal id>' WHERE id = '<agreement id>';`,
  dropped_proposed_agreement_in_use: `
-- A PROPOSED agreement not accepted by both is dropped by the migration, but a
-- TendingEntry still points at it: mark it AGREED (if both did agree) or
-- detach the entry.
-- UPDATE "TendingEntry" SET "agreementId" = NULL WHERE "agreementId" = '<agreement id>';`,
  user_name_mismatch: `
-- user.name becomes GENERATED from first/last name: write the split names
-- (plan step 1). Check the result reproduces "name" exactly.
-- UPDATE "User" SET "firstName" = split_part(trim(name), ' ', 1),
--   "lastName" = nullif(trim(substr(trim(name), length(split_part(trim(name), ' ', 1)) + 1)), '')
-- WHERE id IN (<ids>);`,
  gates_not_object: `
-- gatesSatisfied must be a JSON object (or null).
-- UPDATE "StageProgress" SET "gatesSatisfied" = '{}' WHERE id IN (<ids>);`,
  unknown_gate_key: `
-- A key the step-7 table does not know is unmodelled state. Either extend the
-- key table in backend/scripts/target-shape/gen/maps.ts (and regenerate the
-- migration) or remove the key after recording what it meant:
-- UPDATE "StageProgress" SET "gatesSatisfied" = "gatesSatisfied" - '<key>' WHERE id IN (<ids>);`,
  walkthrough_shape: `
-- stage4Walkthrough must be an object with the known keys and array id lists.
-- UPDATE "StageProgress" SET "gatesSatisfied" = jsonb_set("gatesSatisfied", '{stage4Walkthrough,coveredNeedIds}', '[]') WHERE id IN (<ids>);`,
  gate_timestamp_unparseable: `
-- A timestamp companion that is not an ISO timestamp would silently fall back
-- to startedAt/completedAt; repair or remove it.
-- UPDATE "StageProgress" SET "gatesSatisfied" = "gatesSatisfied" - '<key>' WHERE id IN (<ids>);`,
  consent_target_type: `
-- EVENT_SUMMARY / EMOTIONAL_PATTERN / BOUNDARY consents have no target in the
-- target shape (the arc has five targets). Confirm nothing was shared under
-- them, then delete.
-- DELETE FROM "ConsentRecord" WHERE id IN (<ids>);`,
  consent_target_unresolved: `
-- targetId names no row of its type: the target was deleted. Delete the
-- consent (it governs nothing) or point it at the surviving row.
-- DELETE FROM "ConsentRecord" WHERE id IN (<ids>);`,
  ab_slot_tie_with_split_agreement: `
-- Two members joined at the same instant and an agreement has agreedByA <>
-- agreedByB: which member is A is a guess. Decide from the app logs who
-- agreed, then make joinedAt distinct so the earlier is A.
-- UPDATE "RelationshipMember" SET "joinedAt" = "joinedAt" + interval '1 millisecond'
-- WHERE "relationshipId" = '<relationship id>' AND "userId" = '<the B user>';`,
  dropped_table_not_empty: `
-- The census found this table unpopulated and the target drops it. Export
-- the rows for the owner before deleting them.
-- \\copy (SELECT * FROM "<table>") TO '<file>.csv' CSV HEADER
-- DELETE FROM "<table>";`,
  relationship_role: `
-- role becomes the enum member | owner.
-- UPDATE "RelationshipMember" SET role = 'member' WHERE role NOT IN ('member', 'owner');`,
  session_resolved_without_resolved_at: `
-- CHECK status <> RESOLVED OR resolved_at IS NOT NULL.
-- UPDATE "Session" SET "resolvedAt" = "updatedAt" WHERE id IN (<ids>);`,
  session_without_two_participants: `
-- An ACTIVE/WAITING/PAUSED/RESOLVED session with fewer than two participants
-- (T-cardinality-1; step 4a). If the partner never joined it was never
-- active: move it back to INVITED (and its invitation to PENDING), or
-- ABANDONED if it is over.
-- UPDATE "Session" SET status = 'INVITED' WHERE id IN (<ids>);
-- UPDATE "Invitation" SET status = 'PENDING', "acceptedAt" = NULL WHERE "sessionId" IN (<ids>) AND status = 'ACCEPTED';`,
  invitation_accepted_without_accepted_at: `
-- CHECK: an ACCEPTED invitation records when.
-- UPDATE "Invitation" i SET "acceptedAt" = (SELECT min(m."joinedAt") FROM "RelationshipMember" m JOIN "Session" s ON s."relationshipId" = m."relationshipId"
--   WHERE s.id = i."sessionId" AND m."userId" <> i."invitedById") WHERE id IN (<ids>);`,
  invitation_accepted_without_unique_acceptor: `
-- accepted_by_user_id (new, P3 §6) is the session's one participant other
-- than the inviter (a vanished acceptor counts: their evidence names them).
-- Zero: nobody accepted (→ PENDING); several: decide who.
-- UPDATE "Invitation" SET status = 'PENDING', "acceptedAt" = NULL WHERE id IN (<ids>);`,
  message_without_owner: `
-- Pre-2026-01-02 rows have no forUserId (migration 20260102225910 added it
-- without a backfill). Backfill rule: the sender of the nearest EARLIER USER
-- message with a sender in the same session (the turn the AI answered); if
-- none, the nearest LATER one. Rows with no USER sender in their session at
-- all stay listed: decide them by hand. Review the result before committing.
-- UPDATE "Message" m SET "forUserId" = coalesce(
--     (SELECT u."senderId" FROM "Message" u WHERE u."sessionId" = m."sessionId" AND u.role = 'USER' AND u."senderId" IS NOT NULL
--        AND (u.timestamp, u.id) < (m.timestamp, m.id) ORDER BY u.timestamp DESC, u.id DESC LIMIT 1),
--     (SELECT u."senderId" FROM "Message" u WHERE u."sessionId" = m."sessionId" AND u.role = 'USER' AND u."senderId" IS NOT NULL
--        AND (u.timestamp, u.id) > (m.timestamp, m.id) ORDER BY u.timestamp, u.id LIMIT 1))::text
-- WHERE m.id IN (<ids>);`,
  attempt_without_author: `
-- sourceUserId was nulled (author deleted) and the migration could not
-- recover it (it recovers the session's one vanished member without another
-- attempt there). Name the author from the app logs if known (a vanished id
-- needs other evidence in the session, e.g. a Message.forUserId); otherwise
-- the attempt cannot be attributed.
-- UPDATE "EmpathyAttempt" SET "sourceUserId" = '<user id>' WHERE id = '<attempt id>';`,
  attempt_without_unique_subject: `
-- An attempt needs exactly one other participant as its subject. None: the
-- partner never joined — the attempt is about nobody; its statement stays in
-- the author's chat. Delete it (and its draft / EMPATHY_DRAFT consent).
-- DELETE FROM "ConsentRecord" WHERE "targetType" = 'EMPATHY_DRAFT' AND "targetId" IN (<draft ids>);
-- DELETE FROM "EmpathyAttempt" WHERE id IN (<ids>);`,
  empathy_draft_without_unique_subject: `
-- As attempt_without_unique_subject, for the draft.
-- DELETE FROM "EmpathyDraft" WHERE id IN (<ids>);`,
  attempt_revealed_without_revealed_at: `
-- CHECK REVEALED/VALIDATED → revealed_at. It was revealed no later than its
-- validation: use that, else delivery, else submission.
-- UPDATE "EmpathyAttempt" a SET "revealedAt" = coalesce((SELECT min(v."validatedAt") FROM "EmpathyValidation" v WHERE v."attemptId" = a.id),
--   a."deliveredAt", a."sharedAt") WHERE id IN (<ids>);`,
  validation_without_reviewer: `
-- The reviewer was deleted (userId nulled) and the attempt has no single
-- other participant to recover them as (the migration does that itself).
-- UPDATE "EmpathyValidation" v SET "userId" = <the attempt's other member> WHERE id IN (<ids>);`,
  validation_reviewer_is_author: `
-- An author reviewing their own attempt: not a review. Delete.
-- DELETE FROM "EmpathyValidation" WHERE id IN (<ids>);`,
  validation_draft_without_partner_attempt: `
-- A feedback draft needs the partner's attempt; without one it reviews nothing.
-- DELETE FROM "ValidationFeedbackDraft" WHERE id IN (<ids>);`,
  reconciler_result_without_attempt: `
-- A result whose guesser has no attempt in the session: stale. Delete (its
-- share offer cascades).
-- DELETE FROM "ReconcilerResult" WHERE id IN (<ids>);`,
  reconciler_result_two_current: `
-- sql_result_one_current: supersede all but the newest.
-- UPDATE "ReconcilerResult" SET "supersededAt" = now() WHERE id IN (<older ids>);`,
  reconciler_result_duplicate_iteration: `
-- UNIQUE (attempt, iteration): renumber the older rows.
-- UPDATE "ReconcilerResult" SET iteration = <n> WHERE id = '<id>';`,
  reconciler_result_enum: `
-- gapSeverity / recommendedAction become enums; map the stray value.
-- UPDATE "ReconcilerResult" SET "gapSeverity" = 'moderate' WHERE id IN (<ids>);`,
  reconciler_result_self: `
-- A self-guess is a parameter swap bug; delete.
-- DELETE FROM "ReconcilerResult" WHERE id IN (<ids>);`,
  reconciler_result_score_range: `
-- CHECK alignment_score 0..100.
-- UPDATE "ReconcilerResult" SET "alignmentScore" = least(greatest("alignmentScore", 0), 100) WHERE id IN (<ids>);`,
  share_offer_status_dates: `
-- CHECK ACCEPTED ⇔ sharedAt and DECLINED ⇔ declinedAt.
-- UPDATE "ReconcilerShareOffer" SET "declinedAt" = "updatedAt" WHERE status = 'DECLINED' AND "declinedAt" IS NULL AND id IN (<ids>);`,
  share_offer_user_not_subject: `
-- The offer goes to the result's subject.
-- UPDATE "ReconcilerShareOffer" o SET "userId" = r."subjectId" FROM "ReconcilerResult" r WHERE r.id = o."resultId" AND o.id IN (<ids>);`,
  share_offer_duplicate_iteration: `
-- UNIQUE (attempt, iteration): renumber or drop the offer of a superseded result.
-- UPDATE "ReconcilerShareOffer" SET iteration = <n> WHERE id = '<id>';`,
  consent_decision_undated: `
-- CHECK (decision IS NULL) = (decided_at IS NULL).
-- UPDATE "ConsentRecord" SET "decidedAt" = "createdAt" WHERE decision IS NOT NULL AND "decidedAt" IS NULL AND id IN (<ids>);`,
  consent_revoked_not_revoked: `
-- A revokedAt implies decision REVOKED.
-- UPDATE "ConsentRecord" SET decision = 'REVOKED' WHERE id IN (<ids>);`,
  consented_content_target: `
-- need_share is found through consentRecordId → ConsentRecord.targetId (an
-- IdentifiedNeed). Point the record at the need that was shared.
-- UPDATE "ConsentRecord" SET "targetType" = 'IDENTIFIED_NEED', "targetId" = '<need id>' WHERE id = '<record id>';`,
  consented_content_duplicate_need: `
-- need_share is keyed by need: one shared row per need. Keep the live one.
-- DELETE FROM "ConsentedContent" WHERE id IN (<duplicate ids>);`,
  consented_content_revocation: `
-- An inactive row records when it was revoked; revocation follows consent.
-- UPDATE "ConsentedContent" SET "revokedAt" = greatest("consentedAt", coalesce("revokedAt", "consentedAt")) WHERE id IN (<ids>);`,
  consented_content_session: `
-- The shared need must belong to the session it was shared into.
-- (Investigate: a need shared across sessions is a bug; delete the row.)
-- DELETE FROM "ConsentedContent" WHERE id IN (<ids>);`,
  proposal_removed_dates: `
-- CHECK (status = REMOVED) = (removed_at IS NOT NULL).
-- UPDATE "StrategyProposal" SET "removedAt" = "updatedAt" WHERE status = 'REMOVED' AND "removedAt" IS NULL AND id IN (<ids>);`,
  agreement_duplicate_proposal: `
-- One agreement per proposal: keep the live one.
-- DELETE FROM "Agreement" WHERE id IN (<duplicate ids>);`,
  agreement_parties_incomplete: `
-- T-agreement-parties: an agreement names every participant. One party
-- missing: it was never agreed — PROPOSED (dropped by the migration) — or
-- both did agree (set the flag).
-- UPDATE "Agreement" SET status = 'PROPOSED' WHERE id IN (<ids>);`,
  agreement_party_not_willing: `
-- A party said NOT_WILLING on the agreed proposal: one of the two is wrong.
-- UPDATE "Stage4ProposalSelection" SET decision = 'WILLING' WHERE id IN (<ids>);`,
  revision_action_unknown: `
-- revision_action has 8 members; map the stray action.
-- UPDATE "Stage4ProposalRevision" SET action = 'REVISED' WHERE id IN (<ids>);`,
  revision_session_mismatch: `
-- The revision's sessionId must be its proposal's (it is then dropped).
-- UPDATE "Stage4ProposalRevision" r SET "sessionId" = p."sessionId"::text FROM "StrategyProposal" p WHERE p.id = r."proposalId" AND r.id IN (<ids>);`,
  revision_json_not_object: `
-- before/after must be JSON objects.
-- UPDATE "Stage4ProposalRevision" SET before = jsonb_build_object('value', before) WHERE id IN (<ids>);`,
  follow_up_scope_owner: `
-- CHECK (scope = INDIVIDUAL) = (owner IS NOT NULL).
-- UPDATE "TendingEntry" SET scope = 'SHARED' WHERE "ownerUserId" IS NULL AND id IN (<ids>);`,
  reminder_status_unknown: `
-- status becomes SCHEDULED | DELIVERED | CANCELLED.
-- UPDATE "TendingReminder" SET status = 'CANCELLED' WHERE id IN (<ids>);`,
  checkin_without_entry: `
-- A check-in covering no entry has no follow_up to land on.
-- DELETE FROM "TendingCheckin" WHERE id IN (<ids>);`,
  checkin_entry_duplicate: `
-- UNIQUE follow_up_checkin (follow_up, participant): two check-ins of one
-- user on one entry (successive periods). Keep the latest; its predecessor's
-- answers are history the target does not hold per period.
-- DELETE FROM "TendingCheckin" WHERE id IN (<older ids>);`,
  cycle_entry_unknown: `
-- entryIds names a deleted entry.
-- UPDATE "TendingCoordinationCycle" SET "entryIds" = array_remove("entryIds", '<id>') WHERE id = '<cycle id>';`,
  text_id_not_uuid: `
-- A text id that becomes a uuid FK is not uuid-shaped (step 17).
-- UPDATE "<table>" SET "<column>" = NULL WHERE id IN (<ids>);  -- or the right id`,
  declination_need_unresolved: `
-- A declination of a need that no longer exists.
-- DELETE FROM "Stage4NeedDeclination" WHERE id IN (<ids>);`,
  intensity_out_of_range: `
-- The intensity domain is 1..10.
-- UPDATE "EmotionalReading" SET intensity = least(greatest(intensity, 1), 10) WHERE id IN (<ids>);`,
  summary_not_json_object: `
-- conversationSummary is parsed into jsonb; an invalid one, or a vessel
-- summary without text/messageCount/generatedAt, cannot be. Regenerate or null.
-- UPDATE "UserVessel" SET "conversationSummary" = NULL WHERE id IN (<ids>);`,
  facts_shape: `
-- *_FACTS documents hold a facts array.
-- UPDATE "UserVessel" SET "notableFacts" = NULL WHERE id IN (<ids>);`,
  jsonb_not_container: `
-- Every jsonb column holds an object (or array where allowed).
-- UPDATE "BrainActivity" SET input = jsonb_build_object('value', input) WHERE id IN (<ids>);`,
  inner_work_message_role: `
-- reflection_message.role is USER | AI | SYSTEM.
-- UPDATE "InnerWorkMessage" SET role = 'AI' WHERE id IN (<ids>);`,
  need_confidence_range: `
-- CHECK ai_confidence 0..1.
-- UPDATE "IdentifiedNeed" SET "aiConfidence" = least(greatest("aiConfidence", 0), 1) WHERE id IN (<ids>);`,
  takeaway_link_self: `
-- A takeaway cannot link to itself.
-- DELETE FROM "TakeawayLink" WHERE id IN (<ids>);`,
  brain_cost_overflow: `
-- cost becomes numeric(10,6).
-- UPDATE "BrainActivity" SET cost = 0 WHERE id IN (<ids>);`,
};

export function fixDataTemplate(): string {
  prechecks(); // registers CHECKS
  const names = [...new Set(CHECKS.map((c) => c.name))];
  const missing = names.filter((n) => !(n in FIXES));
  const stale = Object.keys(FIXES).filter((n) => !names.includes(n));
  if (missing.length || stale.length) {
    throw new Error(`fix-data template out of sync: missing ${missing.join(', ') || '-'}; stale ${stale.join(', ') || '-'}`);
  }
  const prelude = `
-- Session-local helpers (pg_temp) the offender queries use — the same
-- definitions as the migration's schema app_migration. Nothing persists.
CREATE TABLE pg_temp.row_counts (phase text NOT NULL, table_name text NOT NULL, n bigint NOT NULL);
${helperFns('pg_temp')}
${beforeCounts('pg_temp')}
${pairSet("pg_temp")}
${evidenceSrc("pg_temp")}`;
  const blocks = CHECKS.map((c) => {
    const select = c.select.replace(/app_migration\./g, 'pg_temp.');
    return `-- ${'-'.repeat(76)}\n-- ${c.title}\n-- ${'-'.repeat(76)}\n${select};\n${FIXES[c.name].trim()}\n`;
  });
  return `-- ============================================================================
-- fix-data.template.sql — pre-migration data fixes for the target_shape
-- migration (TS-7). GENERATED by backend/scripts/gen-target-migration.ts
-- --fix-data-template from the migration's own prechecks; do not edit the
-- queries by hand (edit gen/prechecks.ts / gen/fix-template.ts and regenerate).
--
-- How to use (plan §6 step 3, on the restored rehearsal copy, never on
-- production directly):
--   1. psql -d <rehearsal db> -f fix-data.template.sql   — every block lists its
--      offenders (column 1 = check name, 2 = offending id, 3 = detail). Expected:
--      zero rows everywhere.
--   2. For each block with rows, copy the template to a dated fix-data file,
--      uncomment and complete the corrective statement, review it with the
--      owner, and run it in a transaction.
--   3. Re-run this template, then the migration on the rehearsal copy, until
--      the migration applies with zero RAISE. The same dated fix-data file is
--      then run on production immediately before the deploy (plan §6).
-- The migration RAISEs with the same check names; read its message for the
-- list. backend/scripts/target-shape/fix-data.fixtures.sql is this template
-- filled in for the seeded scratch database (run-target-migration.sh).
-- ============================================================================
${prelude.trim()}

${blocks.join('\n')}`;
}
