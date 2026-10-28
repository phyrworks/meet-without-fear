/**
 * Empathy Reconciler Service
 *
 * Analyzes the gap between what one person guessed about the other's feelings
 * vs what they actually expressed. This runs ASYMMETRICALLY - when User A
 * submits their empathy statement about User B, the reconciler runs as soon as
 * User B completes Stage 1 (not waiting for User B to submit empathy).
 *
 * Flow:
 * 1. User A completes Stage 2 (shares empathy statement about User B) -> status = HELD
 * 2. User B completes Stage 1 (confirms "I feel heard") -> triggers reconciler for A->B direction
 * 3. Reconciler compares A's empathy guess vs B's actual witnessing content
 * 4. If gaps exist:
 *    a. Generate a suggestion for B to share with A (status = AWAITING_SHARING)
 *    b. B can accept, refine, or decline
 *    c. If B shares, A receives the context and can refine their empathy (status = REFINING)
 * 5. Once every direction is READY (or B declines to share), the attempts are REVEALED
 *
 * Target shape (TS-10): attempts are immutable rounds; every status move is
 * app.empathy_set_status; results are the subject's only. See empathy-store.ts.
 *
 * Module structure:
 * - circuit-breaker.ts: round counting and the already-shared check
 * - analysis.ts: gap analysis, persistence (job), runReconciler
 * - sharing.ts: share suggestion generation/refinement, the subject's response
 * - state.ts: empathy status transitions, reveal logic, status and summary
 */

// Circuit Breaker
export { checkAttempts, hasContextAlreadyBeenShared } from './circuit-breaker';

// Analysis
export {
  analyzeEmpathyGap,
  loadRecentSubjectStage2Turns,
  runReconciler,
  persistAnalysis,
  supersedeCurrentResult,
} from './analysis';

// Sharing
export {
  generateShareSuggestionForDirection,
  generateShareSuggestion,
  generateShareOffer,
  respondToShareSuggestion,
  shareAccepted,
  deliverAcceptedShare,
  resumeUndeliveredShare,
  getShareSuggestionForUser,
  getSharedContextForGuesser,
  getSharedContentDeliveryStatus,
  generatePostShareContinuation,
  getFallbackContinuation,
  generateContextReceivedReflection,
  generateValidationFeedbackReflection,
} from './sharing';

// State
export {
  runReconcilerForDirection,
  checkAndRevealBothIfReady,
  hasPartnerCompletedStage1,
  getReconcilerStatus,
  generateReconcilerSummary,
  directionParties,
} from './state';
