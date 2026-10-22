// ---------------------------------------------------------------------------
// The current shape (phoenix/base schema.prisma, 2026-10): 68 tables, 51 enums
// ---------------------------------------------------------------------------

export const OLD_TABLES = [
  'User', 'Relationship', 'RelationshipMember', 'Session', 'InnerWorkSession', 'InnerWorkMessage',
  'SessionTakeaway', 'TakeawayLink', 'StageProgress', 'UserVessel', 'UserEvent', 'EmotionalReading',
  'IdentifiedNeed', 'Boundary', 'UserDocument', 'SharedVessel', 'ConsentedContent', 'CommonGround',
  'Agreement', 'ConsentRecord', 'Message', 'PreSessionMessage', 'EmpathyDraft', 'EmpathyAttempt',
  'EmpathyValidation', 'ReconcilerResult', 'ReconcilerShareOffer', 'RefinementAttemptCounter',
  'StrategyProposal', 'StrategyProposalNeed', 'Stage4ProposalSelection', 'Stage4ProposalRevision',
  'Stage4NeedCoverage', 'Stage4NeedDeclination', 'Stage4Closure', 'Stage4SubChat', 'Stage4SubChatMessage',
  'TendingEntry', 'TendingCheckin', 'TendingCoordinationCycle', 'TendingResponse', 'TendingEntryOutcome',
  'TendingNeedOutcome', 'TendingReminder', 'TendingAdjustment', 'TendingBetweenPeriodNote',
  'TendingResponsePartialClosure', 'StrategyRanking', 'EmotionalExerciseCompletion', 'GlobalLibraryItem',
  'Invitation', 'UserMemory', 'Need', 'NeedScore', 'NeedsAssessmentState', 'Person', 'PersonMention',
  'Insight', 'RecurringTheme', 'GratitudeEntry', 'GratitudePreferences', 'MeditationSession',
  'MeditationStats', 'MeditationFavorite', 'MeditationPreferences', 'SavedMeditation', 'BrainActivity',
  'ValidationFeedbackDraft',
];

export const OLD_ENUMS = [
  'SessionType', 'SessionStatus', 'InnerWorkStatus', 'TakeawaySource', 'TakeawayType', 'TakeawayLinkType',
  'StageStatus', 'Attribution', 'NeedCategory', 'AgreementType', 'AgreementStatus', 'ConsentContentType',
  'ConsentDecision', 'MessageRole', 'EmpathyStatus', 'SharedContentDeliveryStatus', 'ReconcilerShareStatus',
  'StrategySource', 'Stage4ProposalKind', 'Stage4ProposalStatus', 'Stage4SelectionDecision',
  'Stage4ClosureKind', 'Stage4ClosureReason', 'TendingEntryType', 'TendingEntryStatus', 'TendingEntryScope',
  'TendingFollowThroughStatus', 'TendingHelpfulnessStatus', 'TendingBlockerCategory',
  'TendingNeedResolutionStatus', 'TendingNextAction', 'TendingReminderScope', 'TendingCoordinationStatus',
  'Stage4SubChatAnchor', 'Stage4SubChatStatus', 'ContinueChoice', 'PartialClosureResolution', 'ExerciseType',
  'GlobalLibrarySource', 'InvitationStatus', 'MemoryCategory', 'MemoryStatus', 'MemorySource', 'NeedsCategory',
  'MentionSourceType', 'InsightType', 'MeditationType', 'FavoriteType', 'BrainActivityCallType',
  'ActivityType', 'ActivityStatus',
];

/**
 * Tables the target drops whose rows are content nobody else holds. The census
 * (schema-review-2026-10 §2) found them unpopulated; a non-empty one is a
 * precheck failure, never a silent loss.
 */
export const DROPPED_MUST_BE_EMPTY = ['UserEvent', 'Boundary', 'UserDocument', 'PreSessionMessage', 'GlobalLibraryItem', 'CommonGround'];

/** Tables dropped by decision even when populated (derived or out of the product flow); counted in the report. */
export const DROPPED_COUNTED = [
  ['StrategyRanking', 'ranking is not in the product flow (plan step 13, A-Q4-adjacent)'],
  ['RefinementAttemptCounter', 'becomes the count of rounds (spec §1.2); counter vs round reported'],
  ['Stage4NeedCoverage', 'computed: v_need_coverage (plan step 8)'],
  ['TendingCoordinationCycle', 'response_deadline_at/summary on follow_up + v_follow_up_cycle (plan step 14)'],
  ['Insight', 'derivable AI output (spec §1.7)'],
  ['RecurringTheme', 'derivable: v_reflection_theme (plan step 15)'],
  ['Need', 'the 19-row taxonomy moves to shared/src/constants/needs.ts (spec A-Q4)'],
  ['SharedVessel', '1:1 container with no columns; children key on session_id (spec §1.1)'],
];

// ---------------------------------------------------------------------------
// gatesSatisfied key table (plan §3 step 7), completed from a grep of every
// writer in backend/src on 2026-10-21 and of the fixture writer
// (src/testing/fixture-scenarios/current-shape.ts GATE_ENCODING). A key not in
// MILESTONE_RULES, TIMESTAMP_KEYS, DROPPED_KEYS or DISPOSITION_KEYS is an
// "unknown key" precheck failure.
// ---------------------------------------------------------------------------

/** One timestamp source, in coalesce order: a gate key (ISO string) or a StageProgress column. */
export type At = { gate: string } | { col: 'startedAt' | 'completedAt' };

export interface MilestoneRule {
  /** Gate key whose JSON value `true` means the milestone was reached. */
  gate: string;
  milestone: string;
  at: At[];
  source: string;
}

export const g = (gate: string): At => ({ gate });
export const col = (c: 'startedAt' | 'completedAt'): At => ({ col: c });

export const MILESTONE_RULES: MilestoneRule[] = [
  { gate: 'compactSigned', milestone: 'compact_signed', at: [g('signedAt'), g('compactSignedAt'), col('completedAt'), col('startedAt')],
    source: 'plan table (compactSigned + signedAt); stage0.ts:157; fixtures write compactSignedAt' },
  { gate: 'invitationSent', milestone: 'invitation_sent', at: [col('startedAt')],
    source: 'plan table; sessions.ts:903' },
  { gate: 'feelHeardConfirmed', milestone: 'feel_heard', at: [g('feelHeardConfirmedAt'), g('confirmedAt'), col('completedAt'), col('startedAt')],
    source: 'plan table; messages.ts:286' },
  { gate: 'empathyValidated', milestone: 'empathy_validated', at: [col('completedAt'), g('validatedAt'), col('startedAt')],
    source: 'plan table (@ completedAt); stage2.ts:1235, :1417' },
  { gate: 'empathyExchanged', milestone: 'empathy_validated', at: [col('completedAt'), g('empathyExchangedAt'), col('startedAt')],
    source: 'EXTENSION: fixture key for empathy_validated (current-shape.ts GATE_ENCODING)' },
  { gate: 'needsConfirmed', milestone: 'needs_confirmed', at: [g('confirmedAt'), g('needsIdentifiedAt'), col('startedAt')],
    source: 'plan table; stage3.ts:586' },
  { gate: 'needsIdentified', milestone: 'needs_confirmed', at: [g('needsIdentifiedAt'), col('startedAt')],
    source: 'EXTENSION: fixture key for needs_confirmed (current-shape.ts GATE_ENCODING)' },
  { gate: 'needsShared', milestone: 'needs_shared', at: [g('sharedAt'), col('completedAt'), col('startedAt')],
    source: 'plan table; stage3.ts:141, :749' },
  { gate: 'needsValidated', milestone: 'needs_validated', at: [g('needsValidatedAt'), g('needsRevealReviewedAt'), col('startedAt')],
    source: 'plan table; stage3.ts:141, :939' },
  { gate: 'selectionSubmitted', milestone: 'choices_shared', at: [g('selectionSubmittedAt'), col('startedAt')],
    source: 'plan table; stage4.ts:380' },
];

/** Companion timestamps, consumed by the rules above or dropped with their flag. */
export const TIMESTAMP_KEYS = [
  'signedAt', 'compactSignedAt', 'feelHeardConfirmedAt', 'confirmedAt', 'validatedAt', 'empathyExchangedAt',
  'needsIdentifiedAt', 'needsValidatedAt', 'needsRevealReviewedAt', 'sharedAt', 'selectionSubmittedAt',
  'needsCapturedAt', 'rankingSubmittedAt', 'readyAt',
];

/** Keys with no target home (plan table + grep). `content` = user-authored text, counted in the report. */
export const DROPPED_KEYS: Array<{ key: string; why: string; content?: boolean }> = [
  { key: 'feelHeardCheckOffered', why: 'AI hint flag (plan table); stream-turn-actions.ts:313' },
  { key: 'finalEmotionalReading', why: 'always null (plan table); messages.ts:289' },
  { key: 'partnerConsented', why: 'derived (plan table)' },
  { key: 'partnerValidated', why: 'derived (plan table)' },
  { key: 'readyToRank', why: 'ranking dropped (plan table); stage4.ts:2600' },
  { key: 'rankingSubmitted', why: 'ranking dropped (plan table); stage4.ts:1870' },
  { key: 'strategiesRanked', why: 'EXTENSION: fixture ranking flag; ranking dropped' },
  { key: 'agreementCreated', why: 'EXTENSION: legacy stage-4 gate (sessions.ts:524); replaced by choices_shared + session_closure' },
  { key: 'agreementConfirmed', why: 'EXTENSION: fixture legacy stage-4 flag; the agreement row carries it' },
  { key: 'needsCaptured', why: 'EXTENSION: services/needs.ts:189; derivable from need rows' },
  { key: 'skippedRefinement', why: 'EXTENSION: stage2.ts:1417 skip path; not a milestone' },
  { key: 'willingToAccept', why: 'EXTENSION: stage2.ts:1417 skip path; not a milestone' },
  { key: 'skipReason', why: 'EXTENSION: stage2.ts:1417 skip path; free text with no target column', content: true },
  { key: 'feedback', why: 'EXTENSION: messages.ts:290 feel-heard feedback; free text with no target column', content: true },
  { key: 'partner', why: 'read-side projection (plan table, shared-context.ts:60)' },
  { key: 'own', why: 'read-side projection (plan table, shared-context.ts:61)' },
];

/** Repair walkthrough state → need_disposition (step 8) and repair_walkthrough_started (step 7). */
export const DISPOSITION_KEYS = ['stage4Walkthrough', 'phase', 'currentNeedId', 'coveredNeedIds', 'skippedNeedIds'];
export const WALKTHROUGH_KEYS = ['phase', 'currentNeedId', 'coveredNeedIds', 'skippedNeedIds', 'updatedAt', 'updatedFrom', 'lastAction', 'lastReason'];

/** StageProgress(COMPLETED, stage n) → this milestone at completedAt (plan step 7). */
export const TERMINAL_MILESTONE = ['compact_signed', 'feel_heard', 'empathy_validated', 'needs_shared', 'choices_shared'];

// ---------------------------------------------------------------------------
// milestone seed (spec §1.1 milestone; keys from the fixture vocabulary
// scenario-model.ts MILESTONE_KEYS). ordinal = stage * 100 + position, in
// today's stage order, so floor(ordinal / 100) is the old stage number;
// `paused` is off the journey (ordinal 0, ignored by v_current_stage).
// stage_label = shared/src/enums.ts STAGE_FRIENDLY_NAMES (spec example "Your Story").
// self_assertable per spec §1.1 participant_milestone RLS; scope 'session' for
// the milestones every participant must reach before the session advances.
// ---------------------------------------------------------------------------

export const MILESTONES: Array<[key: string, ordinal: number, label: string, scope: 'participant' | 'session', selfAssertable: boolean]> = [
  ['paused', 0, 'Paused', 'participant', false],
  ['invitation_sent', 10, 'Getting Started', 'participant', false],
  ['compact_signed', 20, 'Getting Started', 'session', true],
  ['feel_heard', 110, 'Your Story', 'participant', true],
  ['empathy_submitted', 210, 'Walking in Their Shoes', 'participant', false],
  ['empathy_ready', 220, 'Walking in Their Shoes', 'participant', false],
  ['empathy_validated', 230, 'Walking in Their Shoes', 'session', false],
  ['needs_confirmed', 310, 'What Matters Most', 'participant', true],
  ['needs_validated', 320, 'What Matters Most', 'session', false],
  ['needs_shared', 330, 'What Matters Most', 'session', false],
  ['repair_walkthrough_started', 410, 'What Comes Next', 'participant', false],
  ['choices_shared', 420, 'What Comes Next', 'session', true],
  ['closed', 430, 'What Comes Next', 'session', false],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const litArr = (xs: string[]) => `ARRAY[${xs.map(lit).join(', ')}]::text[]`;
export const jsonLit = (o: unknown) => `${lit(JSON.stringify(o))}::jsonb`;

export function section(title: string, body: string): string {
  const bar = '-- ' + '='.repeat(76);
  return `${bar}\n-- ${title}\n${bar}\n\n${body.trim()}\n`;
}

export function atExpr(a: At): string {
  return 'gate' in a ? `app_migration.ts(sp.gates -> ${lit(a.gate)})` : `sp.${q(a.col)}`;
}


// ---------------------------------------------------------------------------
// Step 12, need_share's second source (TS-7b). Production's Stage 3
// share-needs handler (controllers/stage3.ts ~750-780 on phoenix/base) writes
// one ConsentRecord(IDENTIFIED_NEED, targetId = need id, decision GRANTED) per
// shared need and sets gatesSatisfied.needsShared/sharedAt — it never writes
// ConsentedContent (only controllers/consent.ts:125 does). A shared need is
// therefore ConsentedContent ∪ these records. "Granted" includes REVOKED: a
// record is only revoked after it was granted (consent.ts:217 sets revokedAt,
// and P19b makes such rows decision REVOKED), and the share keeps its
// revoked_at. The prechecks, the copy and the assertions all use these two
// fragments, so they cannot drift.
// ---------------------------------------------------------------------------

/** A ConsentRecord `alias` that shares an IdentifiedNeed (granted, possibly revoked since). */
export const needConsentGranted = (alias: string) =>
  `${alias}."targetType" = 'IDENTIFIED_NEED' AND ${alias}.decision IN ('GRANTED', 'REVOKED')`;

/** No ConsentedContent shares the need `needExpr` (uuid) — the record is then need_share's source. */
export const needHasNoConsentedContent = (needExpr: string) =>
  `NOT EXISTS (SELECT 1 FROM "ConsentedContent" xcc JOIN "ConsentRecord" xcr ON xcr.id = xcc."consentRecordId"
                  WHERE app_migration.as_uuid(xcr."targetId") = ${needExpr})`;
