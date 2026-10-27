/**
 * Empathy (Stage 2) DTOs
 *
 * Drafting, sharing, and validating empathy attempts.
 */

// ============================================================================
// Empathy Status (Reconciler Flow)
// ============================================================================

export const EmpathyStatus = {
  /** Waiting for partner to complete Stage 1 */
  HELD: 'HELD',
  /** Reconciler is comparing guess vs actual Stage 1 content */
  ANALYZING: 'ANALYZING',
  /** Gaps detected, waiting for subject to respond to share suggestion */
  AWAITING_SHARING: 'AWAITING_SHARING',
  /** Guesser is refining after receiving shared context from subject */
  REFINING: 'REFINING',
  /** Significant gaps detected, guesser should refine (legacy - use AWAITING_SHARING) */
  NEEDS_WORK: 'NEEDS_WORK',
  /** Reconciler complete, waiting for partner to also complete Stage 2 before revealing */
  READY: 'READY',
  /** Recipient can now see statement */
  REVEALED: 'REVEALED',
  /** Recipient has validated accuracy */
  VALIDATED: 'VALIDATED',
} as const;

export type EmpathyStatus = (typeof EmpathyStatus)[keyof typeof EmpathyStatus];

// ============================================================================
// Drafting
// ============================================================================

export interface EmpathyDraftDTO {
  id: string;
  content: string;
  version: number;
  readyToShare: boolean;
  updatedAt: string;
}

export interface SaveEmpathyDraftRequest {
  sessionId: string;
  content: string;
  readyToShare?: boolean;
}

export interface SaveEmpathyDraftResponse {
  draft: EmpathyDraftDTO;
  readyToShare: boolean;
}

export interface GetEmpathyDraftResponse {
  draft: EmpathyDraftDTO | null;
  canConsent: boolean;
  alreadyConsented: boolean;
}

// ============================================================================
// Consent to Share
// ============================================================================

export interface ConsentToShareEmpathyRequest {
  sessionId: string;
  draftId: string;
  finalContent?: string;
}

export interface EmpathyAttemptDTO {
  id: string;
  sourceUserId: string;
  content: string;
  sharedAt: string;
  consentRecordId: string;
  status: EmpathyStatus;
  revealedAt: string | null;
  /** When the recipient validated this attempt (null until validated). */
  validatedAt: string | null;
  revisionCount: number;
  /** Monotonic server-side status version used to ignore stale local/realtime state */
  statusVersion?: number;
  /** Delivery status: pending (not revealed to partner), delivered (revealed), seen (partner validated) */
  deliveryStatus?: SharedContentDeliveryStatus;
  /** The attempt row this payload states (target shape: one row per round; additive, TS-10). */
  attemptId?: string;
  /** The round of the direction this attempt is (1 = first submission; additive, TS-10). */
  round?: number;
}

/** Message included in consent response for immediate display */
export interface ConsentMessageDTO {
  id: string;
  content: string;
  timestamp: string;
  stage: number;
}

export interface ConsentToShareEmpathyResponse {
  consented: boolean;
  consentedAt: string | null;
  partnerConsented: boolean;
  canReveal: boolean;
  /** Current status of the empathy attempt */
  status: EmpathyStatus;
  /** The empathy statement message that was saved */
  empathyMessage: ConsentMessageDTO;
  /** AI transition message (optional, may fail to generate) */
  transitionMessage: ConsentMessageDTO | null;
}

// ============================================================================
// Exchange & Validation
// ============================================================================

export interface GetPartnerEmpathyResponse {
  attempt: EmpathyAttemptDTO | null;
  waitingForPartner: boolean;
  /** Partner's attempt status (or null if no attempt) */
  partnerStatus: EmpathyStatus | null;
  validated: boolean;
  validatedAt: string | null;
  awaitingRevision: boolean;
}

export interface ValidateEmpathyRequest {
  sessionId: string;
  validated: boolean;
  feedback?: string;
  consentToShareFeedback?: boolean;
}

export interface ValidateEmpathyResponse {
  validated: boolean;
  validatedAt: string | null;
  feedbackShared: boolean;
  awaitingRevision: boolean;
  canAdvance: boolean;
  partnerValidated: boolean;
}

/**
 * Handle "Skip Refinement" / "Acceptance Check"
 */
export interface SkipRefinementRequest {
  willingToAccept: boolean;
  reason?: string;
}

export interface SkipRefinementResponse {
  success: true;
}

// ============================================================================
// Validation Feedback Flow (Feedback Coach)
// ============================================================================

export interface SaveValidationFeedbackDraftRequest {
  sessionId: string;
  content: string;
  readyToShare: boolean;
}

export interface SaveValidationFeedbackDraftResponse {
  success: boolean;
  draftId?: string;
  savedAt?: string;
}

export interface RefineValidationFeedbackRequest {
  message: string;
  history?: Array<{ role: 'coach' | 'user'; content: string }>;
}

export interface RefineValidationFeedbackResponse {
  response: string;
  proposedFeedback: string | null;
  canSend: boolean;
}

// ============================================================================
// Refinement Flow (Phase 4)
// ============================================================================

export interface RefineEmpathyRequest {
  /** User's response to refinement prompt */
  message: string;
}

export interface RefineEmpathyResponse {
  /** AI's next question/guidance */
  response: string;
  /** Updated statement if user agreed to revise (null if still exploring) */
  proposedRevision: string | null;
  /** Whether user can now resubmit their revised statement */
  canResubmit: boolean;
}

export interface ResubmitEmpathyRequest {
  /** Revised empathy statement content */
  content: string;
}

export interface ResubmitEmpathyResponse {
  /** Status after resubmit (will be ANALYZING while reconciler runs) */
  status: EmpathyStatus;
  /** Informational message for the user */
  message: string;
  /** The new empathy statement message that was created */
  empathyMessage: {
    id: string;
    content: string;
    timestamp: string;
    stage: number;
    /** Delivery status: pending until delivered */
    deliveryStatus: SharedContentDeliveryStatus;
  };
  /** AI acknowledgment message for the revision (optional) */
  transitionMessage?: {
    id: string;
    content: string;
    timestamp: string;
    stage: number;
  } | null;
}

// ============================================================================
// Empathy Exchange Status (for UI state management)
// ============================================================================

/** Reconciler result summary for display */
export interface ReconcilerResultSummary {
  /** Gap severity: none, minor, moderate, significant */
  gapSeverity: 'none' | 'minor' | 'moderate' | 'significant';
  /** Action taken: PROCEED, OFFER_OPTIONAL, OFFER_SHARING */
  action: 'PROCEED' | 'OFFER_OPTIONAL' | 'OFFER_SHARING';
  /** When the reconciler analyzed this */
  analyzedAt: string;
  /** Brief summary of gaps (if any) */
  gapSummary: string | null;
}

export interface EmpathyExchangeStatusResponse {
  /** Current user's empathy attempt toward partner */
  myAttempt: EmpathyAttemptDTO | null;
  /** Partner's empathy attempt toward me */
  partnerAttempt: EmpathyAttemptDTO | null;
  /** Whether partner has completed Stage 1 (confirmed feelHeard) */
  partnerCompletedStage1: boolean;
  /** Whether reconciler is currently analyzing */
  analyzing: boolean;
  /** Whether awaiting subject to respond to share suggestion */
  awaitingSharing: boolean;
  /** Whether there is new shared context to view (guesser only) */
  hasNewSharedContext: boolean;
  /** Whether user has unviewed shared context (guesser must view Share tab before continuing) */
  hasUnviewedSharedContext: boolean;
  /** Shared context from subject (guesser only, if any) */
  sharedContext: {
    content: string;
    sharedAt: string;
  } | null;
  /** Abstract guidance hint if my attempt needs work */
  refinementHint: {
    areaHint: string | null;
    guidanceType: string | null;
    promptSeed: string | null;
  } | null;
  /** Whether ready to proceed to Stage 3 */
  readyForStage3: boolean;
  /** Number of messages sent since receiving shared context (for delaying refinement UI) */
  messageCountSinceSharedContext: number;
  /** Delivery status of shared content (for subject who shared): pending, delivered, or seen */
  sharedContentDeliveryStatus: SharedContentDeliveryStatus | null;
  /** Content the user shared (for subject to see in Partner tab) */
  mySharedContext: {
    content: string;
    sharedAt: string;
    deliveryStatus: SharedContentDeliveryStatus | null;
  } | null;
  /** When the user shared context via ReconcilerShareOffer (for indicator derivation) */
  mySharedAt: string | null;
  /** Reconciler result for my empathy attempt (if reconciler has run) */
  myReconcilerResult: ReconcilerResultSummary | null;
  /** Whether partner has submitted an empathy attempt (even if not revealed to me yet) */
  partnerHasSubmittedEmpathy: boolean;
  /** Partner's empathy attempt status (even if not revealed) - allows showing "held by reconciler" */
  partnerEmpathyHeldStatus: EmpathyStatus | null;
  /** When partner submitted their empathy attempt (for chronological ordering, even if not revealed) */
  partnerEmpathySubmittedAt: string | null;
}

// ============================================================================
// Shared Content Delivery Status
// ============================================================================

/**
 * Delivery status for shared content messages (empathy statements, shared context)
 * - sending: Content is being sent to server (optimistic UI)
 * - pending: Content saved but not yet delivered to recipient
 * - delivered: Content has been delivered to recipient's chat
 * - seen: Recipient has viewed/acknowledged the content
 * - superseded: Content was replaced by an updated version (never delivered)
 */
export const SharedContentDeliveryStatus = {
  /** Content is being sent to server (optimistic UI) */
  SENDING: 'sending',
  /** Content saved but not yet delivered */
  PENDING: 'pending',
  /** Content delivered to recipient's chat */
  DELIVERED: 'delivered',
  /** Recipient has viewed the content */
  SEEN: 'seen',
  /** Content was replaced by an updated version (not delivered) */
  SUPERSEDED: 'superseded',
} as const;

export type SharedContentDeliveryStatus = (typeof SharedContentDeliveryStatus)[keyof typeof SharedContentDeliveryStatus];

// ============================================================================
// Share Suggestion Flow (Reconciler)
// ============================================================================

/** Status of a share suggestion offer */
export const ReconcilerShareStatus = {
  /** Suggestion generated, not yet shown to user */
  PENDING: 'PENDING',
  /** Shown to user, awaiting response */
  OFFERED: 'OFFERED',
  /** User accepted (with or without refinement) */
  ACCEPTED: 'ACCEPTED',
  /** User declined to share */
  DECLINED: 'DECLINED',
  /** Offer expired (timeout) */
  EXPIRED: 'EXPIRED',
} as const;

export type ReconcilerShareStatus = (typeof ReconcilerShareStatus)[keyof typeof ReconcilerShareStatus];

/** Share suggestion shown to the subject */
export interface ShareSuggestionDTO {
  /** Database ID of the ReconcilerShareOffer (needed for refinement chat) */
  offerId: string;
  /** Name of the person trying to understand (the guesser) */
  guesserName: string;
  /**
   * Topic/area to share about (shown in Phase 1 of the two-phase flow)
   * This is the high-level focus identified by the reconciler.
   */
  suggestedShareFocus: string | null;
  /**
   * AI-suggested draft content the subject could share (shown in Phase 2)
   * Generated on-demand when user opts in with "Yes, help me share"
   */
  suggestedContent: string;
  /** Why sharing this would help the guesser understand */
  reason: string;
  /** Whether the user can refine the suggestion */
  canRefine: boolean;
  /**
   * Reconciler action that determines UI language/styling:
   * - OFFER_SHARING: Strong language (significant gaps)
   * - OFFER_OPTIONAL: Soft language (moderate gaps)
   * - PROCEED: No sharing needed (only returned if suggestedShareFocus is null)
   */
  action: 'PROCEED' | 'OFFER_OPTIONAL' | 'OFFER_SHARING';
}

/** Response when getting share suggestion */
export interface GetShareSuggestionResponse {
  /** Whether there is a pending share suggestion */
  hasSuggestion: boolean;
  /** The suggestion details (if any) */
  suggestion: ShareSuggestionDTO | null;
}

/** Request to respond to a share suggestion */
export interface RespondToShareSuggestionRequest {
  /** Action to take */
  action: 'accept' | 'decline' | 'refine';
  /** Refined content (if action is 'refine' or 'accept' with changes) */
  refinedContent?: string;
}

/** Response after responding to a share suggestion */
export interface RespondToShareSuggestionResponse {
  /** Whether the operation succeeded */
  success: boolean;
  /** Resulting status */
  status: 'shared' | 'declined';
  /** The content that was shared (if accepted/refined) */
  sharedContent: string | null;
  /** The "what you shared" message (for optimistic UI replacement) */
  sharedMessage?: {
    id: string;
    content: string;
    stage: number;
    timestamp: string;
    /** Delivery status: pending until delivered, then delivered, then seen when recipient views */
    deliveryStatus?: SharedContentDeliveryStatus;
  };
}
