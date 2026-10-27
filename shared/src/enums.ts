/**
 * Shared Enums for Meet Without Fear
 *
 * These mirror the Prisma enums but are available to both backend and mobile
 * without requiring the Prisma client.
 */

// ============================================================================
// Session Lifecycle
// ============================================================================

export enum SessionStatus {
  CREATED = 'CREATED', // Session created, invitation not yet sent
  INVITED = 'INVITED', // Partner invited, awaiting acceptance
  ACTIVE = 'ACTIVE', // Both users engaged
  PAUSED = 'PAUSED', // Cooling period or temporary pause
  WAITING = 'WAITING', // One user ahead, waiting for other
  RESOLVED = 'RESOLVED', // Process completed successfully
  ABANDONED = 'ABANDONED', // Timeout or withdrawal
  ARCHIVED = 'ARCHIVED', // User has archived this session
}

export enum StageStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  GATE_PENDING = 'GATE_PENDING', // Requirements met, awaiting partner
  COMPLETED = 'COMPLETED',
}

// ============================================================================
// Stage Definitions
// ============================================================================

export enum Stage {
  ONBOARDING = 0,
  WITNESS = 1,
  PERSPECTIVE_STRETCH = 2,
  NEED_MAPPING = 3,
  STRATEGIC_REPAIR = 4,
  INFORMED_EMPATHY = 21, // Stage 2B: prompt-routing only, StageProgress stays at 2
}

export const STAGE_NAMES: Record<Stage, string> = {
  [Stage.ONBOARDING]: 'Onboarding',
  [Stage.WITNESS]: 'The Witness',
  [Stage.PERSPECTIVE_STRETCH]: 'Perspective Stretch',
  [Stage.NEED_MAPPING]: 'What Matters',
  [Stage.STRATEGIC_REPAIR]: 'Strategic Repair',
  [Stage.INFORMED_EMPATHY]: 'Informed Empathy',
};

// INFORMED_EMPATHY is a Stage 2B sub-phase (prompt-routing only).
// This name exists for type completeness and internal tooling.
// It is suppressed from user-facing chapter markers.
export const STAGE_FRIENDLY_NAMES: Record<Stage, string> = {
  [Stage.ONBOARDING]: 'Getting Started',
  [Stage.WITNESS]: 'Your Story',
  [Stage.PERSPECTIVE_STRETCH]: 'Walking in Their Shoes',
  [Stage.NEED_MAPPING]: 'What Matters Most',
  [Stage.STRATEGIC_REPAIR]: 'What Comes Next',
  [Stage.INFORMED_EMPATHY]: 'Deeper Understanding',
};

/** Stage accent colors for visual stage indicators in the chat timeline. */
export const STAGE_COLORS: Record<Stage, string> = {
  [Stage.ONBOARDING]: '#8B9DC3',
  [Stage.WITNESS]: '#D4A574',
  [Stage.PERSPECTIVE_STRETCH]: '#7BC47F',
  [Stage.NEED_MAPPING]: '#C084C0',
  [Stage.STRATEGIC_REPAIR]: '#E8A87C',
  [Stage.INFORMED_EMPATHY]: '#7BC47F',
};

// ============================================================================
// User & Content
// ============================================================================

export enum MessageRole {
  USER = 'USER',
  AI = 'AI',
  SYSTEM = 'SYSTEM',
  EMPATHY_STATEMENT = 'EMPATHY_STATEMENT', // User's shared empathy statement (shown in chat history)
  SHARE_SUGGESTION = 'SHARE_SUGGESTION', // Suggested content for subject to share (reconciler)
  SHARED_CONTEXT = 'SHARED_CONTEXT', // Additional context shared by subject to guesser (reconciler)
  VALIDATION_FEEDBACK = 'VALIDATION_FEEDBACK', // Feedback sent after a "Not quite" validation response
}

export enum Attribution {
  SELF = 'SELF',
  OTHER = 'OTHER',
  MUTUAL = 'MUTUAL',
  EXTERNAL = 'EXTERNAL',
}

export enum NeedCategory {
  SAFETY = 'SAFETY',
  CONNECTION = 'CONNECTION',
  AUTONOMY = 'AUTONOMY',
  RECOGNITION = 'RECOGNITION',
  MEANING = 'MEANING',
  FAIRNESS = 'FAIRNESS',
}

// ============================================================================
// Consent
// ============================================================================

export enum ConsentDecision {
  GRANTED = 'GRANTED',
  DENIED = 'DENIED',
  REVOKED = 'REVOKED',
}

export enum ConsentContentType {
  IDENTIFIED_NEED = 'IDENTIFIED_NEED',
  EVENT_SUMMARY = 'EVENT_SUMMARY',
  EMOTIONAL_PATTERN = 'EMOTIONAL_PATTERN',
  BOUNDARY = 'BOUNDARY',
  EMPATHY_DRAFT = 'EMPATHY_DRAFT',
  EMPATHY_ATTEMPT = 'EMPATHY_ATTEMPT',
  STRATEGY_PROPOSAL = 'STRATEGY_PROPOSAL',
  /** The subject's answer to a reconciler share suggestion (consent arc share_offer_id; TS-10, additive). */
  CONTEXT_SHARE_OFFER = 'CONTEXT_SHARE_OFFER',
  /** The subject's explicit send of review feedback (consent arc review_id; TS-10, additive). */
  EMPATHY_REVIEW = 'EMPATHY_REVIEW',
}

// ============================================================================
// Agreements (Stage 4)
// ============================================================================

export enum AgreementType {
  MICRO_EXPERIMENT = 'MICRO_EXPERIMENT', // Small, reversible action
  COMMITMENT = 'COMMITMENT', // Longer-term agreement
  CHECK_IN = 'CHECK_IN', // Scheduled follow-up
  HYBRID = 'HYBRID', // Combined elements from multiple strategies
}

export enum AgreementStatus {
  PROPOSED = 'PROPOSED',
  AGREED = 'AGREED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  ABANDONED = 'ABANDONED',
}

export enum Stage4ProposalKind {
  SHARED_PROPOSAL = 'SHARED_PROPOSAL',
  INDIVIDUAL_COMMITMENT = 'INDIVIDUAL_COMMITMENT',
}

export enum Stage4ProposalStatus {
  ACTIVE = 'ACTIVE',
  REVISED = 'REVISED',
  REMOVED = 'REMOVED',
  CONVERTED_TO_AGREEMENT = 'CONVERTED_TO_AGREEMENT',
}

export enum Stage4SelectionDecision {
  WILLING = 'WILLING',
  NOT_WILLING = 'NOT_WILLING',
}

export enum Stage4ClosureKind {
  SHARED_AGREEMENT = 'SHARED_AGREEMENT',
  NO_SHARED_AGREEMENT = 'NO_SHARED_AGREEMENT',
}

export enum Stage4ClosureReason {
  MUTUAL_SELECTION = 'MUTUAL_SELECTION',
  NO_OVERLAP = 'NO_OVERLAP',
  BOUNDARY_HONORED = 'BOUNDARY_HONORED',
  USER_STOPPED = 'USER_STOPPED',
}

export enum Stage4SubChatAnchor {
  NEEDS_BRAINSTORM = 'NEEDS_BRAINSTORM',
  PROPOSAL_REFINEMENT = 'PROPOSAL_REFINEMENT',
  NO_OVERLAP = 'NO_OVERLAP',
}

export enum Stage4SubChatStatus {
  ACTIVE = 'ACTIVE',
  RESOLVED = 'RESOLVED',
}

export enum TendingEntryType {
  SCHEDULED_SHARED_AGREEMENT_CHECKIN = 'SCHEDULED_SHARED_AGREEMENT_CHECKIN',
  SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN = 'SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN',
  USER_INITIATED_REENTRY = 'USER_INITIATED_REENTRY',
}

export enum TendingEntryScope {
  SHARED = 'SHARED',
  INDIVIDUAL = 'INDIVIDUAL',
}

export enum TendingEntryStatus {
  SCHEDULED = 'SCHEDULED',
  OPEN = 'OPEN',
  PARTIAL = 'PARTIAL',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

export enum TendingFollowThroughStatus {
  HAPPENED = 'HAPPENED',
  PARTLY_HAPPENED = 'PARTLY_HAPPENED',
  DID_NOT_HAPPEN = 'DID_NOT_HAPPEN',
  NOT_SURE = 'NOT_SURE',
}

export enum TendingHelpfulnessStatus {
  HELPED = 'HELPED',
  PARTLY_HELPED = 'PARTLY_HELPED',
  DID_NOT_HELP = 'DID_NOT_HELP',
  NOT_SURE = 'NOT_SURE',
}

export enum TendingBlockerCategory {
  FORGOT = 'FORGOT',
  TOO_HARD = 'TOO_HARD',
  TOO_FREQUENT = 'TOO_FREQUENT',
  UNCLEAR = 'UNCLEAR',
  PARTNER_DID_NOT_DO_PART = 'PARTNER_DID_NOT_DO_PART',
  I_DID_NOT_DO_PART = 'I_DID_NOT_DO_PART',
  CIRCUMSTANCES_CHANGED = 'CIRCUMSTANCES_CHANGED',
  NO_LONGER_WANTED = 'NO_LONGER_WANTED',
  OTHER = 'OTHER',
}

export enum TendingNeedResolutionStatus {
  RESOLVED = 'RESOLVED',
  IMPROVING = 'IMPROVING',
  STILL_OPEN = 'STILL_OPEN',
  CHANGED = 'CHANGED',
  NOT_SURE = 'NOT_SURE',
}

export enum TendingNextAction {
  FULL_CLOSURE = 'FULL_CLOSURE',
  EXTEND = 'EXTEND',
  ADJUST_COMMITMENT = 'ADJUST_COMMITMENT',
  REOPEN_STRATEGY_WORK = 'REOPEN_STRATEGY_WORK',
  NEW_PROCESS = 'NEW_PROCESS',
  PARTIAL_CLOSURE = 'PARTIAL_CLOSURE',
}

export enum TendingReminderScope {
  PRIVATE = 'PRIVATE',
  SHARED = 'SHARED',
}

export enum TendingCoordinationStatus {
  WAITING_FOR_PARTNER = 'WAITING_FOR_PARTNER',
  READY_TO_RESOLVE = 'READY_TO_RESOLVE',
  RESOLVED = 'RESOLVED',
  TIMED_OUT = 'TIMED_OUT',
}

// ============================================================================
// Global Library
// ============================================================================

export enum GlobalLibrarySource {
  CURATED = 'CURATED', // Admin/expert authored
  CONTRIBUTED = 'CONTRIBUTED', // User-contributed with explicit consent
}

// ============================================================================
// Inner Work: Needs Assessment
// ============================================================================

export enum NeedsCategory {
  FOUNDATION = 'FOUNDATION', // Physical safety, health, rest, material security
  EMOTIONAL = 'EMOTIONAL', // Emotional safety, self-compassion, regulation, agency
  RELATIONAL = 'RELATIONAL', // Being seen, belonging, trust, contribution
  INTEGRATION = 'INTEGRATION', // Purpose, learning, integrity, hope
  TRANSCENDENCE = 'TRANSCENDENCE', // Presence, gratitude, connection to larger whole
}

// ============================================================================
// Inner Work: People Tracking
// ============================================================================

export enum MentionSourceType {
  INNER_THOUGHTS = 'INNER_THOUGHTS', // InnerWorkMessage
  GRATITUDE = 'GRATITUDE', // GratitudeEntry
  NEEDS_CHECKIN = 'NEEDS_CHECKIN', // NeedScore clarification
  PARTNER_SESSION = 'PARTNER_SESSION', // Session message
}

// ============================================================================
// Inner Work: Meditation
// ============================================================================

export enum MeditationType {
  GUIDED = 'GUIDED',
  UNGUIDED = 'UNGUIDED',
}

export enum FavoriteType {
  EXACT = 'EXACT', // Replay exact script
  THEME = 'THEME', // Generate fresh variation
}

// ============================================================================
// Inner Work: Cross-Feature Intelligence
// ============================================================================

export enum InsightType {
  PATTERN = 'PATTERN', // Recurring behavior or theme detected
  CONTRADICTION = 'CONTRADICTION', // Conflicting self-reports or behaviors
  SUGGESTION = 'SUGGESTION', // Recommended action based on patterns
}
