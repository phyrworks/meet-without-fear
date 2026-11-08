/**
 * chatUIState.ts
 *
 * Pure derivation functions for computing the complete UI state of the chat screen.
 * This expands beyond waiting status to include ALL dynamic UI elements:
 * - Invitation panel
 * - Empathy statement panel
 * - Feel-heard confirmation
 * - Share suggestion panel
 * - Waiting banners
 * - Input visibility
 * - Inner thoughts button
 *
 * The goal is to have a single, testable, pure function that computes
 * exactly what UI elements should be visible given the current state.
 */

import { Stage, SessionStatus } from '@meet-without-fear/shared';
import { WaitingStatusState, computeWaitingStatus, WaitingStatusInputs } from './getWaitingStatus';
import { getWaitingStatusConfig, WaitingStatusConfig } from '../config/waitingStatusConfig';

// ============================================================================
// Types
// ============================================================================

/**
 * All possible above-input panels that can be shown.
 * Only ONE panel can be shown at a time - this defines priority.
 */
export type AboveInputPanel =
  | 'topic-proposal' // AI-proposed topic awaiting Use/Refine (Stage 0, inviter)
  | 'invitation' // Invitation share panel for inviters
  | 'invitee-topic-ack' // Invitee Stage 0 topic-acknowledgement Ready bar
  | 'empathy-statement' // Empathy statement review panel
  | 'partner-empathy-validation' // Partner empathy review panel
  | 'feel-heard' // Feel heard confirmation panel
  | 'share-suggestion' // Share suggestion from reconciler (Subject side)
  | 'needs-send' // Stage 3: share locked live needs with partner
  | 'needs-reveal-validation' // Legacy needs reveal continue panel (Stage 3)
  | 'waiting-banner' // General waiting banner
  | 'compact-agreement-bar' // Compact agreement bar during onboarding
  | null;

/**
 * Input state for computing chat UI.
 * All values should be derived from React Query cache or component state.
 */
export interface ChatUIStateInputs extends WaitingStatusInputs {
  // Session context
  sessionStatus: SessionStatus | undefined;
  isInviter: boolean;

  // Loading states
  isLoading: boolean;
  loadingCompact: boolean;

  // Typewriter animation state
  isTypewriterAnimating: boolean;

  // Onboarding state
  compactMySigned: boolean | undefined;
  myProgress: { stage: Stage } | undefined;

  // Invitation phase
  // The invitation panel opens once the topic frame has been confirmed and
  // the invitation has not been confirmed/sent yet.
  hasTopicConfirmed: boolean;
  invitationConfirmed: boolean;
  invitationPanelDismissed: boolean;
  isConfirmingInvitation: boolean;

  // Invitee Stage 0: topic-acknowledgement step. When true, the invitee has
  // signed the compact and is on the topic-ack screen (showing the inviter's
  // confirmed topicFrame with a Ready bar). Hides chat input.
  inviteeTopicAckPending: boolean;

  // Stage 0: AI-proposed topic awaiting user decision (Use / Refine).
  // The topic-proposal panel appears for the inviter when the AI has emitted
  // a topic frame inline via <draft> but the user has not yet confirmed it.
  topicFrameProposed: string | null;
  topicProposalDismissed: boolean;
  isConfirmingTopicFrame: boolean;

  // Stage 1: Feel heard
  showFeelHeardConfirmation: boolean;
  feelHeardConfirmedAt: string | null | undefined;
  isConfirmingFeelHeard: boolean;

  // Stage 2: Empathy
  hasEmpathyContent: boolean; // liveProposedEmpathyStatement || empathyDraftData?.draft?.content
  hasLiveProposedEmpathyStatement: boolean;
  hasDistinctRefinedEmpathyContent: boolean;
  empathyAlreadyConsented: boolean;
  hasSharedEmpathyLocal: boolean; // Local latch to prevent flash

  // Empathy refining mode (received shared context)
  isRefiningEmpathy: boolean;
  messageCountSinceSharedContext: number;
  myAttemptContent: boolean;

  // Share suggestion (Subject side)
  hasShareSuggestion: boolean;
  hasRespondedToShareOfferLocal: boolean;

  // Shared context viewing (Guesser side)
  hasUnviewedSharedContext: boolean; // Newest delivered shared context not yet shown on screen (work-2doq)

  // Stage 3: Needs
  needsAvailable: boolean; // Needs have been extracted and are available for review
  allNeedsConfirmed: boolean; // All identified needs confirmed by user
  needsShared: boolean; // User has consented to share needs
  needsRevealReady: boolean; // Both users have shared and comparison can be shown
  hasConfirmedNeedsLocal: boolean; // Local latch to prevent panel flash after confirming

  // Stage 3: Needs reveal validation.
  needsRevealAvailable: boolean;
  needsRevealNoOverlap: boolean;
  needsRevealValidatedByMe: boolean;
  needsRevealValidatedByBoth: boolean;
  hasValidatedNeedsRevealLocal: boolean;

  // Stage 4: Strategy readiness
  strategyReadiness?: {
    myReadyToRank?: boolean;
    partnerReadyToRank?: boolean;
    canMarkReadyToRank?: boolean;
    canRank?: boolean;
  };
}

/**
 * Complete derived UI state for the chat screen.
 */
export interface ChatUIState {
  // Core waiting status
  waitingStatus: WaitingStatusState;
  waitingStatusConfig: WaitingStatusConfig;

  // Which panel to show above input (only one at a time)
  aboveInputPanel: AboveInputPanel;

  // Whether the panel should animate (wait for typewriter)
  shouldAnimatePanel: boolean;

  // Input visibility
  shouldHideInput: boolean;

  // Inner thoughts button
  shouldShowInnerThoughts: boolean;

  // Specific panel visibility (for debugging/testing)
  panels: {
    showTopicProposalPanel: boolean;
    showInvitationPanel: boolean;
    showInviteeTopicAckPanel: boolean;
    showEmpathyPanel: boolean;
    showPartnerEmpathyValidationPanel: boolean;
    showFeelHeardPanel: boolean;
    showShareSuggestionPanel: boolean;
    showNeedsSendPanel: boolean;
    showNeedsRevealValidationPanel: boolean;
    showWaitingBanner: boolean;
    showCompactAgreementBar: boolean;
  };

  // Banner text (if waiting banner is shown)
  waitingBannerText: string | undefined;

  // Whether the user is in onboarding with unsigned compact
  isInOnboardingUnsigned: boolean;
}

// ============================================================================
// Priority Order for Above-Input Panels
// ============================================================================

/**
 * Panel priority order (highest priority first):
 *
 * 1. Compact Agreement Bar - During onboarding, must sign compact first
 * 2. Invitation Panel - After signing, must craft and send invitation
 * 3. Feel Heard Panel - Stage 1 completion requires feeling heard
 * 4. Share Suggestion Panel - Subject must respond to share suggestion
 * 5. Empathy Statement Panel - User's empathy statement to review
 * 6. Needs Review Panel - Stage 3: Review and confirm identified needs
 * 7. Needs Reveal Validation Panel - Stage 3: validate both needs lists
 * 8. Waiting Banner - Any waiting status
 */

// ============================================================================
// Pure Derivation Functions
// ============================================================================

/**
 * Determines if user is in onboarding with unsigned compact.
 */
function computeIsInOnboardingUnsigned(inputs: ChatUIStateInputs): boolean {
  const { compactMySigned, isLoading, myProgress } = inputs;

  // If compact is already signed, not in onboarding
  if (compactMySigned) {
    return false;
  }

  // If loading and no progress data, optimistically show compact (for invitees)
  if (isLoading && !myProgress) {
    return true;
  }

  // Check stage - ONBOARDING means compact not signed
  const currentStage = myProgress?.stage ?? Stage.ONBOARDING;
  return currentStage === Stage.ONBOARDING && !compactMySigned;
}

/**
 * Determines if the topic-proposal panel should show.
 * Shows for the inviter when the AI has proposed a topic but the user has
 * neither confirmed it nor dismissed the panel ("Refine" hint).
 */
function computeShowTopicProposalPanel(inputs: ChatUIStateInputs): boolean {
  const {
    isInviter,
    topicFrameProposed,
    hasTopicConfirmed,
    topicProposalDismissed,
    isConfirmingTopicFrame,
  } = inputs;

  return !!(
    isInviter &&
    topicFrameProposed &&
    !hasTopicConfirmed &&
    !topicProposalDismissed &&
    !isConfirmingTopicFrame
  );
}

/**
 * Determines if invitation panel should show.
 * Cache-First: invitationConfirmed is derived from cache (set optimistically in onMutate)
 */
function computeShowInvitationPanel(inputs: ChatUIStateInputs): boolean {
  const {
    isInviter,
    hasTopicConfirmed,
    invitationConfirmed,
    invitationPanelDismissed,
    isConfirmingInvitation,
  } = inputs;

  // The invitation panel should not reserve the above-input slot after the
  // invitation is confirmed; otherwise it blocks later panels like feel-heard.
  return !!(
    isInviter &&
    hasTopicConfirmed &&
    !invitationConfirmed &&
    !invitationPanelDismissed &&
    !isConfirmingInvitation
  );
}

/**
 * Determines if empathy statement panel should show.
 *
 * The panel shows "Review what you'll share" for initial empathy drafts.
 * During REFINING (after receiving shared context from partner), the panel
 * stays hidden until the user has taken one reflection turn. After that it
 * re-appears as "Revisit what you'll share" so the user can resubmit their
 * revised empathy through the UI.
 */
function computeShowEmpathyPanel(inputs: ChatUIStateInputs): boolean {
  const {
    myStage,
    hasEmpathyContent,
    empathyAlreadyConsented,
    hasSharedEmpathyLocal,
    isRefiningEmpathy,
    myAttemptContent,
    hasDistinctRefinedEmpathyContent,
    sessionStatus,
  } = inputs;

  if (sessionStatus === SessionStatus.RESOLVED) return false;

  const currentStage = myStage ?? Stage.ONBOARDING;

  // In refining mode, never offer Resubmit with the old attempt as fallback.
  // The panel should appear only after AI/user flow has produced a distinct
  // revised draft. Otherwise the user can accidentally resubmit unchanged text.
  if (isRefiningEmpathy) {
    return hasDistinctRefinedEmpathyContent;
  }

  // Local latch: Once user clicks Share, never show panel again (prevents flash during refetch)
  if (hasSharedEmpathyLocal) {
    return false;
  }

  // Must be in Stage 2
  if (currentStage !== Stage.PERSPECTIVE_STRETCH) {
    return false;
  }

  // If already consented and NOT refining, don't show.
  // During REFINING, the user needs the panel to resubmit their revised empathy.
  if (empathyAlreadyConsented && !isRefiningEmpathy) {
    return false;
  }

  // Must have content to show (from AI or draft)
  return hasEmpathyContent || myAttemptContent;
}

/**
 * Determines if feel heard confirmation panel should show.
 */
function computeShowFeelHeardPanel(inputs: ChatUIStateInputs): boolean {
  const {
    myStage,
    showFeelHeardConfirmation,
    feelHeardConfirmedAt,
    isConfirmingFeelHeard,
  } = inputs;

  const currentStage = myStage ?? Stage.ONBOARDING;

  return !!(
    currentStage === Stage.WITNESS &&
    showFeelHeardConfirmation &&
    !feelHeardConfirmedAt &&
    !isConfirmingFeelHeard
  );
}

/**
 * Determines if share suggestion panel should show.
 * Only shows during Stage 2 (Perspective Stretch).
 */
function computeShowShareSuggestionPanel(inputs: ChatUIStateInputs): boolean {
  const {
    hasShareSuggestion,
    hasRespondedToShareOfferLocal,
    myStage,
    sessionStatus,
    isRefiningEmpathy,
  } = inputs;

  if (sessionStatus === SessionStatus.RESOLVED) return false;

  const currentStage = myStage ?? Stage.ONBOARDING;

  // Only show share suggestion during Stage 2
  if (currentStage !== Stage.PERSPECTIVE_STRETCH) {
    return false;
  }

  // Optional context sharing must not block the required Stage 2 refinement
  // review/resubmit path after the partner shares new context.
  if (isRefiningEmpathy) {
    return false;
  }

  return hasShareSuggestion && !hasRespondedToShareOfferLocal;
}

/**
 * Determines if partner empathy needs the user's response.
 *
 * This owns the Stage 2 focus until the user either confirms the empathy or
 * responds in chat with what feels missing. Other ready actions, such as
 * optional context sharing, remain queued behind this panel.
 */
function computeShowPartnerEmpathyValidationPanel(inputs: ChatUIStateInputs): boolean {
  const { myStage, hasPartnerEmpathy, myValidation, sessionStatus } = inputs;

  if (sessionStatus === SessionStatus.RESOLVED) return false;

  const currentStage = myStage ?? Stage.ONBOARDING;
  if (currentStage !== Stage.PERSPECTIVE_STRETCH) return false;

  return !!(
    hasPartnerEmpathy &&
    myValidation?.validated !== true &&
    myValidation?.awaitingRevision !== true
  );
}

/**
 * Determines if the needs-send panel should show.
 * Shows only after all live needs are locked and before sharing.
 */
function computeShowNeedsSendPanel(inputs: ChatUIStateInputs): boolean {
  const {
    myStage,
    needsAvailable,
    allNeedsConfirmed,
    needsShared,
    needsRevealReady,
    sessionStatus,
  } = inputs;

  if (sessionStatus === SessionStatus.RESOLVED) return false;

  const currentStage = myStage ?? Stage.ONBOARDING;
  if (currentStage !== Stage.NEED_MAPPING) return false;
  if (!needsAvailable || !allNeedsConfirmed) return false;
  if (needsShared || needsRevealReady) return false;
  return true;
}

/**
 * Determines if the legacy needs reveal continue panel should show.
 * New sessions advance to Stage 4 as soon as both users send needs; this keeps
 * older/stale Stage 3 states recoverable without asking users to judge accuracy.
 */
function computeShowNeedsRevealValidationPanel(inputs: ChatUIStateInputs): boolean {
  const {
    myStage,
    needsRevealAvailable,
    needsRevealReady,
    needsRevealNoOverlap,
    needsRevealValidatedByMe,
    needsRevealValidatedByBoth,
    hasValidatedNeedsRevealLocal,
    sessionStatus,
  } = inputs;

  if (sessionStatus === SessionStatus.RESOLVED) return false;

  const currentStage = myStage ?? Stage.ONBOARDING;

  // Must be in Stage 3
  if (currentStage !== Stage.NEED_MAPPING) {
    return false;
  }

  // Local latch: Once user confirms, hide panel immediately
  if (hasValidatedNeedsRevealLocal) {
    return false;
  }

  // Already confirmed by both or by me - no need to show
  if (needsRevealValidatedByBoth || needsRevealValidatedByMe) {
    return false;
  }

  if (needsRevealReady) {
    return true;
  }

  // Legacy no-overlap state is treated as validation-ready for compatibility.
  if (needsRevealNoOverlap) {
    return true;
  }

  // Must have both revealed needs lists available
  return needsRevealAvailable;
}

/**
 * Determines which waiting statuses should show a banner.
 */
function computeShouldShowWaitingBanner(status: WaitingStatusState): boolean {
  return getWaitingStatusConfig(status).showBanner;
}

/**
 * Computes which panel should be shown above the input.
 * Only one panel can be shown at a time - this enforces priority.
 */
function computeAboveInputPanel(
  _inputs: ChatUIStateInputs,
  panels: ChatUIState['panels']
): AboveInputPanel {
  // Priority 1: Compact agreement bar (during onboarding)
  if (panels.showCompactAgreementBar) {
    return 'compact-agreement-bar';
  }

  // Priority 2a: Topic proposal panel (Stage 0, before topic confirmation)
  if (panels.showTopicProposalPanel) {
    return 'topic-proposal';
  }

  // Priority 2: Invitation panel (after signing, before sending invite)
  if (panels.showInvitationPanel) {
    return 'invitation';
  }

  // Priority 2b: Invitee topic acknowledgement (Stage 0, after compact signed)
  if (panels.showInviteeTopicAckPanel) {
    return 'invitee-topic-ack';
  }

  // Priority 3: Feel heard panel (Stage 1)
  if (panels.showFeelHeardPanel) {
    return 'feel-heard';
  }

  // Priority 4: Partner empathy validation (Stage 2)
  if (panels.showPartnerEmpathyValidationPanel) {
    return 'partner-empathy-validation';
  }

  // Priority 5: Share suggestion panel (Subject side in Stage 2)
  if (panels.showShareSuggestionPanel) {
    return 'share-suggestion';
  }

  // Priority 6: Empathy statement panel (Stage 2)
  if (panels.showEmpathyPanel) {
    return 'empathy-statement';
  }

  // Priority 7: Needs send panel (Stage 3)
  if (panels.showNeedsSendPanel) {
    return 'needs-send';
  }

  // Priority 8: Needs reveal validation panel (Stage 3)
  if (panels.showNeedsRevealValidationPanel) {
    return 'needs-reveal-validation';
  }

  // Priority 10: Waiting banner
  if (panels.showWaitingBanner) {
    return 'waiting-banner';
  }

  return null;
}

/**
 * Computes whether inner thoughts button should show.
 */
function computeShouldShowInnerThoughts(
  inputs: ChatUIStateInputs,
  waitingStatus: WaitingStatusState
): boolean {
  const { myStage } = inputs;
  const currentStage = myStage ?? Stage.ONBOARDING;

  // Show if stage 2 is completed (we're in stage 3 or 4)
  if (currentStage > Stage.PERSPECTIVE_STRETCH) {
    return true;
  }

  // Show if in stage 2 and waiting for partner
  if (
    currentStage === Stage.PERSPECTIVE_STRETCH &&
    (waitingStatus === 'witness-pending' ||
      waitingStatus === 'empathy-pending' ||
      waitingStatus === 'partner-considering-perspective' ||
      waitingStatus === 'revision-analyzing')
  ) {
    return true;
  }

  return false;
}

/**
 * Computes whether the input should be hidden.
 */
function computeShouldHideInput(
  waitingStatusConfig: WaitingStatusConfig,
  aboveInputPanel: AboveInputPanel,
  inputs: ChatUIStateInputs
): boolean {
  // If waiting status says hide input, hide it
  if (waitingStatusConfig.hideInput) {
    return true;
  }

  // During onboarding (compact agreement bar), input is hidden
  if (aboveInputPanel === 'compact-agreement-bar') {
    return true;
  }

  // Invitee Stage 0 topic acknowledgement: hide input until they tap Ready
  if (aboveInputPanel === 'invitee-topic-ack') {
    return true;
  }

  if (aboveInputPanel === 'invitation') {
    return true;
  }

  // Note: hasUnviewedSharedContext no longer hides input.
  // The notification popup already surfaces the shared context to the user,
  // so requiring them to also open the Activity menu is unnecessary friction.

  // Safety: In Stage 2, if empathy data is still loading (undefined),
  // hide input conservatively to avoid showing input when we shouldn't.
  // This prevents the flash of input on initial load before data arrives.
  // Exception: if there's a share suggestion, user CAN chat to respond.
  const currentStage = inputs.myStage ?? Stage.ONBOARDING;
  // In Stage 3, only hide input for needs-reveal-validation.
  if (
    currentStage === Stage.NEED_MAPPING &&
    aboveInputPanel === 'needs-reveal-validation'
  ) {
    return true;
  }

  const hasShareSuggestion = inputs.shareOffer?.hasSuggestion === true;
  if (
    currentStage === Stage.PERSPECTIVE_STRETCH &&
    inputs.empathyDraft === undefined &&
    inputs.empathyStatus === undefined &&
    aboveInputPanel !== 'empathy-statement' &&
    !hasShareSuggestion
  ) {
    return true;
  }

  if (
    currentStage === Stage.NEED_MAPPING &&
    inputs.needsShared &&
    !inputs.needsRevealReady &&
    !inputs.needsRevealAvailable
  ) {
    return true;
  }

  // During Stage 4 non-COLLECTING phases, hide input
  // Users should focus on ranking, reviewing overlap, or confirming agreements
  if (currentStage === Stage.STRATEGIC_REPAIR &&
      inputs.strategyPhase &&
      inputs.strategyPhase !== 'COLLECTING') {
    return true;
  }

  if (
    currentStage === Stage.STRATEGIC_REPAIR &&
    inputs.agreements &&
    inputs.agreements.length > 0
  ) {
    return true;
  }

  // After session resolves, hide input
  if (inputs.sessionStatus === SessionStatus.RESOLVED) {
    return true;
  }

  return false;
}

// ============================================================================
// Main Derivation Function
// ============================================================================

/**
 * Computes the complete UI state for the chat screen.
 *
 * This is a pure function that takes a snapshot of all relevant state
 * and returns exactly what should be rendered. No side effects.
 *
 * @param inputs - Current state snapshot from hooks and queries
 * @returns Complete derived UI state
 */
export function computeChatUIState(inputs: ChatUIStateInputs): ChatUIState {
  // Step 1: Compute waiting status
  const waitingStatus = computeWaitingStatus(inputs);
  const waitingStatusConfig = getWaitingStatusConfig(waitingStatus);

  // Step 2: Compute isInOnboardingUnsigned
  const isInOnboardingUnsigned = computeIsInOnboardingUnsigned(inputs);

  // Step 3: Compute individual panel visibility
  const showTopicProposalPanel = computeShowTopicProposalPanel(inputs);
  const showInvitationPanel = computeShowInvitationPanel(inputs);
  const showInviteeTopicAckPanel = !inputs.isInviter && inputs.inviteeTopicAckPending;
  const showEmpathyPanel = computeShowEmpathyPanel(inputs);
  const showPartnerEmpathyValidationPanel = computeShowPartnerEmpathyValidationPanel(inputs);
  const showFeelHeardPanel = computeShowFeelHeardPanel(inputs);
  const showShareSuggestionPanel = computeShowShareSuggestionPanel(inputs);
  const showNeedsSendPanel = computeShowNeedsSendPanel(inputs);
  const showNeedsRevealValidationPanel = computeShowNeedsRevealValidationPanel(inputs);
  const showWaitingBanner = computeShouldShowWaitingBanner(waitingStatus);
  const showCompactAgreementBar = isInOnboardingUnsigned;

  const panels = {
    showTopicProposalPanel,
    showInvitationPanel,
    showInviteeTopicAckPanel,
    showEmpathyPanel,
    showPartnerEmpathyValidationPanel,
    showFeelHeardPanel,
    showShareSuggestionPanel,
    showNeedsSendPanel,
    showNeedsRevealValidationPanel,
    showWaitingBanner,
    showCompactAgreementBar,
  };

  // Step 4: Determine which single panel to show (priority)
  const aboveInputPanel = computeAboveInputPanel(inputs, panels);

  // Step 5: Determine if panel should animate (wait for typewriter)
  const shouldAnimatePanel = !inputs.isTypewriterAnimating;

  // Step 6: Compute input visibility
  const shouldHideInput = computeShouldHideInput(waitingStatusConfig, aboveInputPanel, inputs);

  // Step 7: Compute inner thoughts visibility
  const shouldShowInnerThoughts = computeShouldShowInnerThoughts(inputs, waitingStatus);

  // Step 8: Compute banner text
  const waitingBannerText = waitingStatusConfig.bannerText?.(
    'Partner' // This will be replaced with actual partner name in the hook
  );

  return {
    waitingStatus,
    waitingStatusConfig,
    aboveInputPanel,
    shouldAnimatePanel,
    shouldHideInput,
    shouldShowInnerThoughts,
    panels,
    waitingBannerText,
    isInOnboardingUnsigned,
  };
}

/**
 * Creates default inputs for when data is loading or unavailable.
 * Useful for initial render before data loads.
 */
export function createDefaultChatUIStateInputs(): ChatUIStateInputs {
  return {
    // WaitingStatusInputs
    myStage: Stage.ONBOARDING,
    partnerStage: undefined,
    previousStatus: null,
    empathyStatus: undefined,
    empathyDraft: undefined,
    hasPartnerEmpathy: false,
    shareOffer: undefined,
    needs: { allConfirmed: false },
    needsRevealValidation: { count: 0 },
    strategyPhase: 'COLLECTING',
    strategyReadiness: undefined,
    overlappingStrategies: { count: 0 },
    agreements: undefined,

    // ChatUIStateInputs
    sessionStatus: undefined,
    isInviter: true,
    isLoading: true,
    loadingCompact: true,
    isTypewriterAnimating: false,
    compactMySigned: undefined,
    myProgress: undefined,
    hasTopicConfirmed: false,
    invitationConfirmed: false,
    invitationPanelDismissed: false,
    isConfirmingInvitation: false,
    topicFrameProposed: null,
    topicProposalDismissed: false,
    isConfirmingTopicFrame: false,
    inviteeTopicAckPending: false,
    showFeelHeardConfirmation: false,
    feelHeardConfirmedAt: undefined,
    isConfirmingFeelHeard: false,
    hasEmpathyContent: false,
    hasLiveProposedEmpathyStatement: false,
    hasDistinctRefinedEmpathyContent: false,
    empathyAlreadyConsented: false,
    hasSharedEmpathyLocal: false,
    isRefiningEmpathy: false,
    messageCountSinceSharedContext: 0,
    myAttemptContent: false,
    hasShareSuggestion: false,
    hasRespondedToShareOfferLocal: false,
    hasUnviewedSharedContext: false,

    // Stage 3: Needs
    needsAvailable: false,
    allNeedsConfirmed: false,
    needsShared: false,
    needsRevealReady: false,
    hasConfirmedNeedsLocal: false,

    // Stage 3: Needs reveal validation
    needsRevealAvailable: false,
    needsRevealNoOverlap: false,
    needsRevealValidatedByMe: false,
    needsRevealValidatedByBoth: false,
    hasValidatedNeedsRevealLocal: false,
  };
}
