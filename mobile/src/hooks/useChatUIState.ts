/**
 * useChatUIState Hook
 *
 * Custom hook that computes the complete UI state for the chat screen
 * using pure derivation functions. This replaces scattered useEffect chains
 * with a single, testable computation.
 *
 * Usage:
 * ```tsx
 * const { uiState, updatePreviousStatus } = useChatUIState({
 *   // ...inputs from useUnifiedSession
 * });
 *
 * // Access derived values
 * uiState.aboveInputPanel // 'invitation' | 'empathy-statement' | 'waiting-banner' | etc.
 * uiState.shouldHideInput // boolean
 * uiState.waitingBannerText // string with partnerName interpolated
 * ```
 */

import { useMemo, useState, useEffect } from 'react';
import { Stage, SessionStatus, StrategyPhase, GetShareSuggestionResponse } from '@meet-without-fear/shared';
import {
  computeChatUIState,
  ChatUIStateInputs,
  ChatUIState,
} from '../utils/chatUIState';
import { WaitingStatusState } from '../utils/getWaitingStatus';
import { getWaitingBannerText } from '../config/waitingStatusConfig';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the useChatUIState hook.
 * These are the "raw" values from useUnifiedSession and component state.
 */
export interface UseChatUIStateProps {
  // Partner context (for banner text)
  partnerName: string;

  // Session context
  sessionStatus: SessionStatus | undefined;
  isInviter: boolean;

  // Loading states
  isLoading: boolean;
  loadingCompact: boolean;

  // Typewriter animation state
  isTypewriterAnimating: boolean;

  // Progress data
  myProgress: { stage: Stage } | undefined;
  partnerProgress: { stage: Stage } | undefined;

  // Compact state
  compactMySigned: boolean | undefined;

  // Invitation phase
  // The invitation panel opens when the topic frame is confirmed and the
  // invitation has not been confirmed/sent yet.
  hasTopicConfirmed: boolean;
  invitationConfirmed: boolean;
  invitationPanelDismissed: boolean;
  isConfirmingInvitation: boolean;

  // Stage 0: Topic proposal panel
  topicFrameProposed: string | null;
  topicProposalDismissed: boolean;
  isConfirmingTopicFrame: boolean;

  // Invitee Stage 0 topic acknowledgement (between sign-compact and Stage 1 chat)
  inviteeTopicAckPending: boolean;

  // Stage 1: Feel heard
  showFeelHeardConfirmation: boolean;
  feelHeardConfirmedAt: string | null | undefined;
  isConfirmingFeelHeard: boolean;

  // Stage 2: Empathy
  empathyStatusData: {
    analyzing?: boolean;
    awaitingSharing?: boolean;
    hasNewSharedContext?: boolean;
    hasUnviewedSharedContext?: boolean;
    myAttempt?: { status?: string; content?: string };
    partnerEmpathyHeldStatus?: string | null;
    myValidation?: { validated?: boolean; awaitingRevision?: boolean };
    partnerValidated?: boolean;
    messageCountSinceSharedContext?: number;
  } | undefined;
  empathyDraftData: {
    alreadyConsented?: boolean;
    /** work-9309: reopened by Edit first, the AI not yet proposing. */
    awaitingRevision?: boolean;
    draft?: { content?: string };
  } | undefined;
  hasPartnerEmpathy: boolean;
  hasLiveProposedEmpathyStatement: boolean;
  liveProposedEmpathyStatement?: string | null;
  hasSharedEmpathyLocal: boolean;

  // Stage 2: Share suggestion (Subject side)
  shareOfferData: Pick<GetShareSuggestionResponse, 'hasSuggestion' | 'suggestion'> | undefined;
  hasRespondedToShareOfferLocal: boolean;

  // Stage 3: Needs
  allNeedsConfirmed: boolean;
  needsAvailable: boolean;
  needsShared: boolean;
  needsRevealReady: boolean;
  hasConfirmedNeedsLocal: boolean;
  needsRevealValidationCount: number;
  needsRevealAvailable: boolean;
  needsRevealNoOverlap: boolean;
  needsRevealValidatedByMe: boolean;
  needsRevealValidatedByBoth: boolean;
  hasValidatedNeedsRevealLocal: boolean;

  // Stage 4: Strategies
  strategyPhase: StrategyPhase | string;
  strategyReadiness?: {
    myReadyToRank?: boolean;
    partnerReadyToRank?: boolean;
    canMarkReadyToRank?: boolean;
    canRank?: boolean;
  };
  overlappingStrategiesCount: number;

  // Stage 4: Agreements
  agreements?: Array<{
    agreedByMe: boolean;
    agreedByPartner: boolean;
  }>;

  // Stage 4 (redesigned): per-proposal willingness share status
  stage4Selections?: {
    mySelectionSubmitted: boolean;
    partnerSelectionSubmitted: boolean;
    hasOutcome: boolean;
  };
}

/**
 * Return value from useChatUIState hook.
 */
export interface UseChatUIStateResult {
  /** Complete derived UI state */
  uiState: ChatUIState;

  /** Current waiting status (for backward compatibility) */
  waitingStatus: WaitingStatusState;

  /** Banner text with partner name interpolated */
  waitingBannerText: string | undefined;

  /** Whether waiting banner should show */
  shouldShowWaitingBanner: boolean;

  /** Whether to hide the input */
  shouldHideInput: boolean;

  /** Whether to show inner thoughts button */
  shouldShowInnerThoughts: boolean;

  /** Whether user is in onboarding with unsigned compact */
  isInOnboardingUnsigned: boolean;

  /** Which panel should show above input */
  aboveInputPanel: ChatUIState['aboveInputPanel'];

  /** Individual panel visibility (for specific panel logic) */
  panels: ChatUIState['panels'];
}

function normalizeEmpathyContent(content: string | null | undefined): string {
  return (content ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Custom hook that computes chat UI state from session data.
 *
 * This hook:
 * 1. Maintains previousWaitingStatus state for transition detection
 * 2. Builds ChatUIStateInputs from props
 * 3. Calls computeChatUIState (pure function)
 * 4. Returns derived values with partner name interpolated
 */
export function useChatUIState(props: UseChatUIStateProps): UseChatUIStateResult {
  const {
    partnerName,
    sessionStatus,
    isInviter,
    isLoading,
    loadingCompact,
    isTypewriterAnimating,
    myProgress,
    partnerProgress,
    compactMySigned,
    hasTopicConfirmed,
    invitationConfirmed,
    invitationPanelDismissed,
    isConfirmingInvitation,
    topicFrameProposed,
    topicProposalDismissed,
    isConfirmingTopicFrame,
    inviteeTopicAckPending,
    showFeelHeardConfirmation,
    feelHeardConfirmedAt,
    isConfirmingFeelHeard,
    empathyStatusData,
    empathyDraftData,
    hasPartnerEmpathy,
    hasLiveProposedEmpathyStatement,
    liveProposedEmpathyStatement,
    hasSharedEmpathyLocal,
    shareOfferData,
    hasRespondedToShareOfferLocal,
    allNeedsConfirmed,
    needsAvailable,
    needsShared,
    needsRevealReady,
    hasConfirmedNeedsLocal,
    needsRevealValidationCount,
    needsRevealAvailable,
    needsRevealNoOverlap,
    needsRevealValidatedByMe,
    needsRevealValidatedByBoth,
    hasValidatedNeedsRevealLocal,
    strategyPhase,
    strategyReadiness,
    overlappingStrategiesCount,
    agreements,
    stage4Selections,
  } = props;

  // Track previous waiting status for transition detection
  const [previousWaitingStatus, setPreviousWaitingStatus] = useState<WaitingStatusState>(null);

  const proposedRefinedContent =
    liveProposedEmpathyStatement || empathyDraftData?.draft?.content || '';
  const hasDistinctRefinedEmpathyContent =
    normalizeEmpathyContent(proposedRefinedContent).length > 0 &&
    normalizeEmpathyContent(proposedRefinedContent) !==
      normalizeEmpathyContent(empathyStatusData?.myAttempt?.content);

  // Build inputs for the pure computation function
  const inputs: ChatUIStateInputs = useMemo(() => ({
    // WaitingStatusInputs
    myStage: myProgress?.stage,
    partnerStage: partnerProgress?.stage,
    previousStatus: previousWaitingStatus,
    empathyStatus: empathyStatusData ? {
      analyzing: empathyStatusData.analyzing,
      awaitingSharing: empathyStatusData.awaitingSharing,
      hasNewSharedContext: empathyStatusData.hasNewSharedContext,
      myAttemptStatus: empathyStatusData.myAttempt?.status,
      partnerAttemptStatus: empathyStatusData.partnerEmpathyHeldStatus ?? undefined,
    } : undefined,
    myValidation: empathyStatusData?.myValidation,
    partnerValidated: empathyStatusData?.partnerValidated,
    empathyDraft: empathyDraftData ? {
      alreadyConsented: empathyDraftData.alreadyConsented,
    } : undefined,
    hasPartnerEmpathy,
    shareOffer: shareOfferData ? {
      hasSuggestion: shareOfferData.hasSuggestion,
      action: shareOfferData.suggestion?.action,
    } : undefined,
    needs: { allConfirmed: allNeedsConfirmed, shared: needsShared, revealReady: needsRevealReady },
    needsRevealValidation: {
      count: needsRevealValidationCount,
      allConfirmedByMe: needsRevealValidatedByMe,
      allConfirmedByBoth: needsRevealValidatedByBoth,
    },
    strategyPhase,
    strategyReadiness,
    overlappingStrategies: { count: overlappingStrategiesCount },
    agreements,
    stage4Selections,

    // ChatUIStateInputs
    sessionStatus,
    isInviter,
    isLoading,
    loadingCompact,
    isTypewriterAnimating,
    compactMySigned,
    myProgress,
    hasTopicConfirmed,
    invitationConfirmed,
    invitationPanelDismissed,
    isConfirmingInvitation,
    topicFrameProposed,
    topicProposalDismissed,
    isConfirmingTopicFrame,
    inviteeTopicAckPending,
    showFeelHeardConfirmation,
    feelHeardConfirmedAt,
    isConfirmingFeelHeard,
    hasEmpathyContent: hasLiveProposedEmpathyStatement || !!empathyDraftData?.draft?.content,
    hasLiveProposedEmpathyStatement,
    hasDistinctRefinedEmpathyContent,
    empathyAlreadyConsented: empathyDraftData?.alreadyConsented ?? false,
    hasSharedEmpathyLocal,
    empathyAwaitingRevision: empathyDraftData?.awaitingRevision === true,
    isRefiningEmpathy:
      empathyStatusData?.hasNewSharedContext === true ||
      empathyStatusData?.myAttempt?.status === 'REFINING',
    messageCountSinceSharedContext: empathyStatusData?.messageCountSinceSharedContext ?? 0,
    myAttemptContent: !!empathyStatusData?.myAttempt?.content,
    hasShareSuggestion: shareOfferData?.hasSuggestion ?? false,
    hasRespondedToShareOfferLocal,
    hasUnviewedSharedContext: empathyStatusData?.hasUnviewedSharedContext ?? false,

    // Stage 3: Needs
    needsAvailable,
    allNeedsConfirmed,
    needsShared,
    needsRevealReady,
    hasConfirmedNeedsLocal,

    // Stage 3: Common Ground
    needsRevealAvailable,
    needsRevealNoOverlap,
    needsRevealValidatedByMe,
    needsRevealValidatedByBoth,
    hasValidatedNeedsRevealLocal,
  }), [
    myProgress?.stage,
    partnerProgress?.stage,
    previousWaitingStatus,
    empathyStatusData,
    empathyDraftData,
    hasPartnerEmpathy,
    shareOfferData,
    allNeedsConfirmed,
    needsAvailable,
    needsShared,
    needsRevealReady,
    hasConfirmedNeedsLocal,
    needsRevealValidationCount,
    needsRevealAvailable,
    needsRevealNoOverlap,
    needsRevealValidatedByMe,
    needsRevealValidatedByBoth,
    hasValidatedNeedsRevealLocal,
    strategyPhase,
    strategyReadiness,
    overlappingStrategiesCount,
    agreements,
    stage4Selections,
    sessionStatus,
    isInviter,
    isLoading,
    loadingCompact,
    isTypewriterAnimating,
    compactMySigned,
    myProgress,
    hasTopicConfirmed,
    invitationConfirmed,
    invitationPanelDismissed,
    isConfirmingInvitation,
    topicFrameProposed,
    topicProposalDismissed,
    isConfirmingTopicFrame,
    inviteeTopicAckPending,
    showFeelHeardConfirmation,
    feelHeardConfirmedAt,
    isConfirmingFeelHeard,
    hasLiveProposedEmpathyStatement,
    hasDistinctRefinedEmpathyContent,
    hasSharedEmpathyLocal,
    hasRespondedToShareOfferLocal,
  ]);

  // Compute the complete UI state using the pure function
  const uiState = useMemo(() => computeChatUIState(inputs), [inputs]);

  // Sync previous waiting status for next render (only side effect needed)
  useEffect(() => {
    if (uiState.waitingStatus !== previousWaitingStatus) {
      setPreviousWaitingStatus(uiState.waitingStatus);
    }
  }, [uiState.waitingStatus, previousWaitingStatus]);

  // Compute banner text with actual partner name
  const waitingBannerText = useMemo(() => {
    return getWaitingBannerText(uiState.waitingStatus, partnerName);
  }, [uiState.waitingStatus, partnerName]);

  return {
    uiState,
    waitingStatus: uiState.waitingStatus,
    waitingBannerText,
    shouldShowWaitingBanner: uiState.panels.showWaitingBanner,
    shouldHideInput: uiState.shouldHideInput,
    shouldShowInnerThoughts: uiState.shouldShowInnerThoughts,
    isInOnboardingUnsigned: uiState.isInOnboardingUnsigned,
    aboveInputPanel: uiState.aboveInputPanel,
    panels: uiState.panels,
  };
}
