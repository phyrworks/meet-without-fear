/**
 * useUnifiedSession Hook
 *
 * Composite hook that combines all stage-specific logic for the unified session interface.
 * Manages state across all stages while keeping the chat interface as the primary view.
 */

import { useMemo, useCallback, useReducer, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Stage, MessageRole, StrategyPhase, AgreementType, MemorySuggestion, SessionStatus, ConfirmAgreementResponse, MAX_AGREEMENTS } from '@meet-without-fear/shared';
import { useToast } from '../contexts/ToastContext';
import { ApiClientError } from '../lib/api';

import {
  useSessionState,
  useConfirmInvitationMessage,
  useMarkSessionViewed,
} from './useSessions';
import {
  useInfiniteMessages,
  useRecordEmotion,
  useFetchInitialMessage,
} from './useMessages';
import { useStreamingMessage, StreamMetadata } from './useStreamingMessage';
import { sessionKeys, stageKeys } from './queryKeys';
import {
  useSignCompact,
  useAdvanceStage,
  useConfirmFeelHeard,
  useEmpathyDraft,
  usePartnerEmpathy,
  useSaveEmpathyDraft,
  useConsentToShareEmpathy,
  useValidateEmpathy,
  useNeeds,
  useConfirmNeeds,
  useConsentShareNeeds,
  useNeedsComparison,
  useValidateNeeds,
  useStrategies,
  useRequestStrategySuggestions,
  useProposeStrategy,
  useAgreements,
  useConfirmAgreement,
  useCreateAgreement,
  useResolveSession,
  useEmpathyStatus,
  useShareOffer,
  useRespondToShareOffer,
  useResubmitEmpathy,
  useSkipRefinement,
} from './useStages';
import { shouldFetchShareOffer } from '../utils/shareOfferEligibility';

const SESSION_TRANSCRIPT_MESSAGE_LIMIT = 500;

// ============================================================================
// Types
// ============================================================================

export type OverlayType =
  | 'breathing-exercise'
  | 'grounding-exercise'
  | 'body-scan-exercise'
  | 'support-options'
  | 'strategy-pool'
  | 'strategy-ranking'
  | 'overlap-reveal'
  | 'agreement-confirmation'
  | 'curiosity-compact'
  | 'waiting-room'
  | null;

export type InlineCardType =
  // Cross-stage: Waiting status
  | 'waiting-status'
  // Stage 1: Witness
  | 'emotional-barometer'
  | 'feel-heard-confirmation'
  | 'cooling-suggestion'
  // Stage 2: Perspective Stretch
  | 'consent-prompt'
  | 'ready-to-share-confirmation'
  // Stage 3: Need Mapping
  | 'need-card'
  // Stage 4: Strategic Repair
  | 'strategy-suggestion'
  | 'strategy-pool-preview'
  | 'overlap-preview'
  | 'agreement-preview';

export interface InlineChatCard {
  id: string;
  type: InlineCardType;
  position: string | 'end';
  props: Record<string, unknown>;
  dismissible?: boolean;
}

type LegacyNeedsRevealItem = {
  id: string;
  need: string;
  category: string;
  confirmedByMe: boolean;
  confirmedByPartner: boolean;
};

// Re-export WaitingStatusState from the new pure derivation module
// This maintains backward compatibility while centralizing the type definition
export type { WaitingStatusState } from '../utils/getWaitingStatus';

interface UnifiedSessionState {
  activeOverlay: OverlayType;
  dismissedCards: Set<string>;
  barometerValue: number;
  lastBarometerMessageCount: number;
  showCoolingSuggestion: boolean;
  showFinalCheck: boolean;
  pendingConfirmation: boolean;
  hasConfirmedHeard: boolean; // Tracks if user confirmed they feel heard
  followUpDate: Date | null;
}

// ============================================================================
// Constants
// ============================================================================

const BAROMETER_MESSAGE_INTERVAL = 5;
const HIGH_INTENSITY_THRESHOLD = 8;

// ============================================================================
// State Reducer
// ============================================================================

type SessionAction =
  | { type: 'OPEN_OVERLAY'; payload: OverlayType }
  | { type: 'CLOSE_OVERLAY' }
  | { type: 'DISMISS_CARD'; payload: string }
  | { type: 'SET_BAROMETER'; payload: number }
  | { type: 'SET_FOLLOW_UP_DATE'; payload: Date | null }
  | { type: 'SET_LAST_BAROMETER_COUNT'; payload: number }
  | { type: 'SHOW_COOLING_SUGGESTION'; payload: boolean }
  | { type: 'SHOW_FINAL_CHECK'; payload: boolean }
  | { type: 'SET_PENDING_CONFIRMATION'; payload: boolean }
  | { type: 'SET_HAS_CONFIRMED_HEARD'; payload: boolean }
  | { type: 'RESET_STATE' };

function sessionReducer(
  state: UnifiedSessionState,
  action: SessionAction
): UnifiedSessionState {
  switch (action.type) {
    case 'OPEN_OVERLAY':
      return { ...state, activeOverlay: action.payload };
    case 'CLOSE_OVERLAY':
      return { ...state, activeOverlay: null };
    case 'DISMISS_CARD':
      return {
        ...state,
        dismissedCards: new Set([...state.dismissedCards, action.payload]),
      };
    case 'SET_BAROMETER':
      return { ...state, barometerValue: action.payload };
    case 'SET_FOLLOW_UP_DATE':
      return { ...state, followUpDate: action.payload };
    case 'SET_LAST_BAROMETER_COUNT':
      return { ...state, lastBarometerMessageCount: action.payload };
    case 'SHOW_COOLING_SUGGESTION':
      return { ...state, showCoolingSuggestion: action.payload };
    case 'SHOW_FINAL_CHECK':
      return { ...state, showFinalCheck: action.payload };
    case 'SET_PENDING_CONFIRMATION':
      return { ...state, pendingConfirmation: action.payload };
    case 'SET_HAS_CONFIRMED_HEARD':
      return { ...state, hasConfirmedHeard: action.payload };
    case 'RESET_STATE':
      return initialState;
    default:
      return state;
  }
}

const initialState: UnifiedSessionState = {
  activeOverlay: null,
  dismissedCards: new Set(),
  barometerValue: 5,
  lastBarometerMessageCount: 0,
  showCoolingSuggestion: false,
  showFinalCheck: false,
  pendingConfirmation: false,
  hasConfirmedHeard: false,
  followUpDate: null,
};

// ============================================================================
// Main Hook
// ============================================================================

export function useUnifiedSession(
  sessionId: string | undefined,
  options?: { inviteeTopicAcked?: boolean }
) {
  // Whether the invitee has tapped "Ready" on the Stage 0 topic-ack screen.
  // While false, we defer all auto-fetches of the initial Stage 0/1 AI message
  // for the invitee so they don't see chat content before acknowledging the
  // inviter's topic frame.
  const inviteeTopicAcked = options?.inviteeTopicAcked ?? true;
  // Local state management
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const lastActivityTime = useRef<number>(Date.now());
  const prevMessageCountRef = useRef(0);
  const queryClient = useQueryClient();

  // Toast for error feedback
  const { showError } = useToast();

  // Track AI-proposed empathy statement (Stage 2)
  // This captures the proposed statement when AI determines user is ready to share
  const [liveProposedEmpathyStatement, setLiveProposedEmpathyStatement] = useState<string | null>(null);

  // Track if stream triggered feel-heard check (only set in handleStreamMetadata)
  const [streamTriggeredFeelHeard, setStreamTriggeredFeelHeard] = useState(false);

  // Track if user has dismissed the feel-heard confirmation
  const [hasDismissedFeelHeard, setHasDismissedFeelHeard] = useState(false);

  // Track AI recommendation for ready-to-share empathy (Stage 2)
  const [aiRecommendsReadyToShare, setAiRecommendsReadyToShare] = useState(false);

  // Track AI-detected memory suggestion
  const [memorySuggestion, setMemorySuggestion] = useState<MemorySuggestion | null>(null);

  // NOTE: localInvitationConfirmed state was removed as part of Cache-First Architecture.
  // The cache now handles optimistic updates via useConfirmInvitationMessage.onMutate.

  // -------------------------------------------------------------------------
  // Consolidated Session State (reduces initial requests from ~5 to 1)
  // Returns session, progress, messages, invitation, and compact in one request
  // -------------------------------------------------------------------------
  const { data: stateData, isLoading: loadingState, error: stateError, refetch: refetchState } = useSessionState(sessionId);

  // If the /state endpoint returns 403 (no access) or 404 (session deleted/missing),
  // disable all child queries to prevent hundreds of redundant errors from polling.
  const accessDenied =
    stateError instanceof ApiClientError &&
    (stateError.status === 403 || stateError.status === 404);

  // Extract core data from consolidated state
  const sessionData = stateData ? { session: stateData.session } : undefined;
  const progressData = stateData?.progress;
  const compactData = stateData?.compact;
  const invitationData = stateData?.invitation ? { invitation: stateData.invitation } : undefined;

  // Loading states - use consolidated loading for core data
  const loadingSession = loadingState;
  const loadingProgress = loadingState;
  const loadingCompact = loadingState;

  const currentStage = progressData?.myProgress?.stage ?? Stage.ONBOARDING;

  // Messages - use infinite scroll for pagination
  // The useSessionState hook hydrates the messages cache, so this will get a cache hit
  // Gate behind !loadingState to prevent initial parallel burst before /state resolves (see #428)
  const stateResolved = !loadingState && !stateError;
  const {
    data: messagesData,
    isLoading: loadingMessages,
    isFetching: fetchingMessages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteMessages(
    { sessionId: sessionId!, limit: SESSION_TRANSCRIPT_MESSAGE_LIMIT },
    { enabled: !!sessionId && !accessDenied && stateResolved }
  );

  // Stage-gated queries: only fetch data for the user's current stage to avoid
  // a network request storm on stage load (especially PERSPECTIVE_STRETCH).
  // Ably events deliver real-time updates via setQueryData, so pre-fetching
  // future stages is unnecessary.
  const isStage2Plus = currentStage >= Stage.PERSPECTIVE_STRETCH;
  const isStage3Plus = currentStage >= Stage.NEED_MAPPING;
  const isStage4 = currentStage >= Stage.STRATEGIC_REPAIR;

  // Stage 2: Empathy
  const { data: empathyDraftData } = useEmpathyDraft(sessionId, {
    enabled: !!sessionId && !accessDenied && stateResolved && isStage2Plus,
  });
  const { data: partnerEmpathyData } = usePartnerEmpathy(sessionId, {
    enabled: !!sessionId && !accessDenied && stateResolved && isStage2Plus,
  });
  const partnerEmpathy = partnerEmpathyData?.attempt ?? null;

  // Stage 3: Needs
  const { data: needsData } = useNeeds(sessionId, {
    enabled: !!sessionId && !accessDenied && stateResolved && isStage3Plus,
  });

  // Derive needs state for gating the side-by-side reveal query.
  const needsForGating = needsData?.needs ?? [];
  const liveNeedsForGating = needsForGating.filter((n) => !n.deletedAt && !n.supersededByNeedId);
  const allNeedsConfirmedForGating =
    liveNeedsForGating.length > 0 && liveNeedsForGating.every((n) => Boolean(n.confirmed));
  const myNeedsSharedForGating =
    (progressData?.myProgress?.gatesSatisfied as Record<string, unknown> | undefined)?.needsShared === true;

  const { data: needsComparisonData } = useNeedsComparison(
    sessionId,
    !accessDenied && stateResolved && (allNeedsConfirmedForGating || myNeedsSharedForGating)
  );

  // Stage 4: Strategies
  const { data: strategyData } = useStrategies(sessionId, {
    enabled: !!sessionId && !accessDenied && stateResolved && isStage4,
  });
  const { data: agreementsData } = useAgreements(sessionId, {
    enabled: !!sessionId && !accessDenied && stateResolved && isStage4,
  });

  // Empathy Reconciler Data — only active during Stage 2
  const { data: empathyStatusData } = useEmpathyStatus(sessionId, {
    enabled: !!sessionId && !accessDenied && stateResolved && isStage2Plus,
  });
  const { data: shareOfferData } = useShareOffer(sessionId, {
    enabled: shouldFetchShareOffer({
      sessionId,
      accessDenied,
      currentStage,
      ownEmpathyAlreadyConsented: empathyDraftData?.alreadyConsented,
      ownEmpathyAttempt: empathyStatusData?.myAttempt,
    }),
  });
  const { mutate: respondToShareOffer, isPending: isRespondingToShareOffer } = useRespondToShareOffer();

  // -------------------------------------------------------------------------
  // Mutation Hooks
  // -------------------------------------------------------------------------
  const { mutate: recordEmotion } = useRecordEmotion();
  const { mutate: confirmHeard, isPending: isConfirmingFeelHeard } = useConfirmFeelHeard();
  const { mutate: signCompact, isPending: isSigningCompact } = useSignCompact();
  const { mutate: confirmInvitationMessage, isPending: isConfirmingInvitation } = useConfirmInvitationMessage();
  const { mutate: advanceStage } = useAdvanceStage();
  const { mutate: saveDraft, mutateAsync: saveDraftAsync, isPending: isSavingEmpathyDraft } = useSaveEmpathyDraft();
  const { mutate: consentToShare, isPending: isSharingEmpathy } = useConsentToShareEmpathy({
    onError: (error) => {
      console.error('[useConsentToShareEmpathy] Mutation error', error);
    },
    onSuccess: (data) => {
      console.log('[useConsentToShareEmpathy] Mutation success', data);
    },
  });
  const { mutate: validateEmpathy } = useValidateEmpathy();
  const { mutate: resubmitEmpathy, isPending: isResubmittingEmpathy } = useResubmitEmpathy();
  const { mutate: skipRefinement } = useSkipRefinement();
  const { mutate: confirmNeeds, isPending: isConfirmingNeeds } = useConfirmNeeds();
  const { mutate: consentShareNeeds, isPending: isSharingNeeds } = useConsentShareNeeds();
  const { mutate: validateNeedsMutation } = useValidateNeeds();
  const { mutate: proposeStrategy, isPending: isProposing } = useProposeStrategy();
  const { mutate: requestSuggestions, isPending: isGenerating } =
    useRequestStrategySuggestions();
  const { mutate: confirmAgreement } = useConfirmAgreement();
  const { mutate: createAgreement } = useCreateAgreement();
  const { mutate: resolveSession } = useResolveSession();

  // Streaming message hook with callbacks for metadata handling
  const handleStreamMetadata = useCallback(
    (_sessionId: string, metadata: StreamMetadata) => {
      // Update feel-heard check recommendation from AI
      if (metadata.offerFeelHeardCheck === true) {
        setStreamTriggeredFeelHeard(true);
      }
      // Update ready-to-share recommendation from AI (Stage 2)
      if (metadata.offerReadyToShare === true) {
        setAiRecommendsReadyToShare(true);
      }
      // Capture AI-proposed empathy statement (Stage 2)
      // Save to database immediately so it persists across reloads
      if (sessionId && metadata.proposedEmpathyStatement !== undefined && metadata.proposedEmpathyStatement !== null) {
        setLiveProposedEmpathyStatement(metadata.proposedEmpathyStatement);
        // Save to database with readyToShare: false (user hasn't confirmed yet)
        saveDraft({ sessionId, content: metadata.proposedEmpathyStatement, readyToShare: false });
      }
      // Invalidate strategies cache when AI extracts new strategies (Stage 4)
      if (sessionId && metadata.proposedStrategies && metadata.proposedStrategies.length > 0) {
        queryClient.refetchQueries({ queryKey: stageKeys.strategies(sessionId) });
      }
      // Stage 3 need cards are updated by need.* Ably events with setQueryData.
      if (sessionId && metadata.proposedNeeds && metadata.proposedNeeds.length > 0) {
        queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
        queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
      }
      // Stage 0: AI emitted a <draft> topic — backend persisted Session.topicFrame.
      // Refresh session state so the topic-proposal panel picks it up.
      if (sessionId && metadata.topicFrame) {
        queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
        queryClient.invalidateQueries({ queryKey: sessionKeys.sessionInvitation(sessionId) });
      }
      if (sessionId && metadata.needsCaptured) {
        queryClient.invalidateQueries({ queryKey: stageKeys.needs(sessionId) });
        queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
        queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
      }
      if (sessionId && metadata.stage4WalkthroughAction && metadata.stage4WalkthroughAction.action !== 'NONE') {
        queryClient.invalidateQueries({ queryKey: stageKeys.stage4(sessionId) });
        queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
        queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
      }
    },
    [sessionId, saveDraft, setStreamTriggeredFeelHeard, setAiRecommendsReadyToShare,
     setLiveProposedEmpathyStatement, queryClient]
  );

  const handleStreamError = useCallback(
    (error: Error) => {
      const message = error instanceof ApiClientError
        ? error.message
        : 'Failed to send message. Please try again.';
      showError('Message not sent', message);
    },
    [showError]
  );

  const {
    sendMessage: streamingSendMessage,
    isSending,
    isStreaming,
    failedMessageContent,
  } = useStreamingMessage({
    onMetadata: handleStreamMetadata,
    onError: handleStreamError,
  });

  const handleRespondToShareOffer = useCallback(
    (action: 'accept' | 'decline' | 'refine', refinedContent?: string) => {
      if (!sessionId) return;
      // Pass sharedContent for optimistic UI when accepting
      const sharedContent = action === 'accept'
        ? (refinedContent || shareOfferData?.suggestion?.suggestedContent)
        : undefined;
      respondToShareOffer({ sessionId, action, refinedContent, sharedContent });
    },
    [sessionId, respondToShareOffer, shareOfferData?.suggestion?.suggestedContent]
  );

  // Initial message - fetch AI-generated first message when session has no messages
  const { mutate: fetchInitialMessage, isPending: isFetchingInitialMessage } = useFetchInitialMessage();
  const hasFetchedInitialMessage = useRef(false);

  // -------------------------------------------------------------------------
  // Derived Values
  // -------------------------------------------------------------------------
  const session = sessionData?.session;
  // Flatten paginated messages - pages are in reverse chronological order (newest first)
  // but each page's messages are in chronological order, so we need to flatten
  // with older pages first: [page2, page1, page0].flatMap(p => p.messages)
  const messages = useMemo(() => {
    // messagesData is InfiniteData<GetMessagesResponse> with pages array
    // Pages are in reverse chronological order (newest first)
    // but each page's messages are in chronological order, so we flatten
    // with older pages first: [page2, page1, page0].flatMap(p => p.messages)
    const pages = messagesData?.pages;
    if (!pages || pages.length === 0) return [];
    const seenIds = new Set<string>();
    const dedupedMessages = [];

    for (const page of [...pages].reverse()) {
      for (const message of page.messages) {
        if (seenIds.has(message.id)) continue;
        seenIds.add(message.id);
        dedupedMessages.push(message);
      }
    }

    return dedupedMessages;
  }, [messagesData]);

  // -------------------------------------------------------------------------
  // Mark Session as Viewed
  // -------------------------------------------------------------------------
  // Mark the session as viewed when user opens it, which clears unread indicators
  const { mutate: markViewed } = useMarkSessionViewed(sessionId);
  const hasMarkedViewed = useRef(false);

  // Capture the initial lastSeenChatItemId when session first loads
  // This is used for the "New messages" separator and should NOT update
  // while the user is actively viewing the session
  // Use undefined as initial state to indicate "not yet loaded" vs null meaning "never viewed"
  const initialLastSeenChatItemIdRef = useRef<string | null | undefined>(undefined);
  const [lastSeenChatItemIdForSeparator, setLastSeenChatItemIdForSeparator] = useState<string | null | undefined>(undefined);
  const initialLastViewedAtRef = useRef<string | null | undefined>(undefined);
  const [lastViewedAtForAnimation, setLastViewedAtForAnimation] = useState<string | null | undefined>(undefined);

  // Capture initial value when session loads (before marking viewed)
  useEffect(() => {
    if (
      session?.lastSeenChatItemId !== undefined &&
      session?.lastViewedAt !== undefined &&
      initialLastSeenChatItemIdRef.current === undefined &&
      !hasMarkedViewed.current
    ) {
      initialLastSeenChatItemIdRef.current = session.lastSeenChatItemId;
      initialLastViewedAtRef.current = session.lastViewedAt;
      setLastSeenChatItemIdForSeparator(session.lastSeenChatItemId);
      setLastViewedAtForAnimation(session.lastViewedAt);
    }
  }, [session?.lastSeenChatItemId, session?.lastViewedAt]);

  useEffect(() => {
    // Only mark viewed once per session load, when we have messages
    if (!sessionId || hasMarkedViewed.current || messages.length === 0) return;
    if (session?.status === SessionStatus.CREATED) return;

    // Get the newest message ID (last in the chronologically sorted array)
    const newestMessageId = messages[messages.length - 1]?.id;

    markViewed({ lastSeenChatItemId: newestMessageId });
    hasMarkedViewed.current = true;

    // NOTE: We intentionally do NOT clear lastSeenChatItemIdForSeparator here.
    // The separator should persist while user is viewing the session so they can see
    // the "New" label and the new messages get typewriter animation.
    // The separator will naturally be gone when user returns to the session since
    // they will get a new lastSeenChatItemId from the server (updated by markViewed).
  }, [sessionId, messages, markViewed, session?.status]);

  // Reset the flags when sessionId changes (user navigates to a different session)
  useEffect(() => {
    hasMarkedViewed.current = false;
    initialLastSeenChatItemIdRef.current = undefined;
    initialLastViewedAtRef.current = undefined;
    setLastSeenChatItemIdForSeparator(null);
    setLastViewedAtForAnimation(undefined);
  }, [sessionId]);

  // Only show 'Partner' fallback after data has loaded, otherwise show empty string
  const partnerName = loadingSession
    ? ''
    : (session?.partner?.nickname ?? session?.partner?.name ?? 'Partner');

  // Invitation phase detection
  // We're in invitation phase when:
  // - Session status is CREATED
  // - Invitation message hasn't been confirmed yet
  const invitation = invitationData?.invitation;
  const isInvitationPhase =
    session?.status === 'CREATED' && !invitation?.messageConfirmed;
  const invitationConfirmed = invitation?.messageConfirmed ?? false;
  const myProgress = progressData?.myProgress;
  const partnerProgress = progressData?.partnerProgress;
  const canAdvance = progressData?.canAdvance ?? false;

  // Count user messages for barometer trigger
  const userMessageCount = messages.filter((m) => m.role === MessageRole.USER).length;

  // Derive showFeelHeardConfirmation from gates + stream trigger + dismissal state
  // This ensures proper restoration from backend AND handles stream-triggered state
  // NOTE: Using simple derived expression (not useMemo) to match invitation pattern for reliable updates
  const gates = myProgress?.gatesSatisfied as Record<string, unknown> | undefined;
  const gateOffered = !!gates?.feelHeardCheckOffered;
  const gateConfirmed = !!gates?.feelHeardConfirmed;
  const isWitnessStage = myProgress?.stage === Stage.WITNESS;
  const showFeelHeardConfirmation = (
    isWitnessStage &&
    (gateOffered || streamTriggeredFeelHeard) &&
    !gateConfirmed &&
    !hasDismissedFeelHeard &&
    !state.hasConfirmedHeard
  );

  // Needs confirmation state
  const needs = useMemo(() => needsData?.needs ?? [], [needsData?.needs]);
  const liveNeeds = needs.filter((n) => !n.deletedAt && !n.supersededByNeedId);
  const allNeedsConfirmed = liveNeeds.length > 0 && liveNeeds.every((n) => Boolean(n.confirmed));
  const needsRevealValidationItems = useMemo<LegacyNeedsRevealItem[]>(() => [], []);
  const needsRevealReady =
    (needsComparisonData?.myNeeds?.length ?? 0) > 0 &&
    (needsComparisonData?.partnerNeeds?.length ?? 0) > 0;
  const needsRevealValidationData = needsRevealReady
    ? { needsRevealValidationItems: [], analysisComplete: true, bothConfirmed: false, noOverlap: false }
    : undefined;
  const needsRevealValidatedByBoth = false;

  // Strategy phase
  const strategyPhase = strategyData?.phase ?? StrategyPhase.COLLECTING;
  const strategies = useMemo(() => strategyData?.strategies ?? [], [strategyData?.strategies]);
  const myReadyToRank =
    strategyData?.myReadyToRank === true ||
    (myProgress?.gatesSatisfied as Record<string, unknown> | undefined)?.readyToRank === true;
  const canMarkReadyToRank = strategyData?.canMarkReadyToRank === true;
  const canRankStrategies = strategyData?.canRank === true;
  const agreements = useMemo(() => agreementsData?.agreements ?? [], [agreementsData?.agreements]);

  // -------------------------------------------------------------------------
  // Barometer Trigger Effect
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (currentStage !== Stage.WITNESS) return;

    if (userMessageCount > prevMessageCountRef.current) {
      prevMessageCountRef.current = userMessageCount;

      const messagesSinceLastBarometer =
        userMessageCount - state.lastBarometerMessageCount;
      if (messagesSinceLastBarometer >= BAROMETER_MESSAGE_INTERVAL) {
        dispatch({ type: 'SET_LAST_BAROMETER_COUNT', payload: userMessageCount });
        // Show barometer via inline card
      }
    }
  }, [userMessageCount, state.lastBarometerMessageCount, currentStage]);

  // Waiting status is now computed purely via useChatUIState → computeWaitingStatus.
  // The imperative useEffect was removed to eliminate dual computation.

  // -------------------------------------------------------------------------
  // Initialize Empathy State from Database Effect
  // -------------------------------------------------------------------------
  // When loading a session with an existing draft (not yet marked ready),
  // restore the local state so the "View your understanding" button appears
  useEffect(() => {
    if (
      empathyDraftData?.draft?.content &&
      !empathyDraftData.draft.readyToShare &&
      !empathyDraftData.alreadyConsented
    ) {
      // Restore the proposed statement from database
      setLiveProposedEmpathyStatement(empathyDraftData.draft.content);
      // Show the ready-to-share card
      setAiRecommendsReadyToShare(true);
    }
  }, [empathyDraftData?.draft?.content, empathyDraftData?.draft?.readyToShare, empathyDraftData?.alreadyConsented]);

  // NOTE: Feel-Heard Check State is now derived via useMemo (showFeelHeardConfirmation)
  // instead of syncing from backend. This eliminates race conditions and restoration bugs.

  // -------------------------------------------------------------------------
  // Initial Message Effect
  // -------------------------------------------------------------------------
  // Fetch AI-generated initial message when session loads with no messages
  // IMPORTANT: Skip during onboarding when compact is not signed - the compact
  // should be the only content shown until user signs it
  useEffect(() => {
    // Skip if:
    // - No session ID
    // - Still loading session or messages or compact
    // - Already fetched or fetching
    // - Messages already exist
    // - In onboarding with unsigned compact (compact must be signed first)

    // Skip if still loading or during onboarding with unsigned compact
    const isOnboardingUnsigned = currentStage === Stage.ONBOARDING && !compactData?.mySigned;

    // Defer initial-message fetch for the invitee while they are on the
    // Stage 0 topic-acknowledgement screen. The screen flips
    // `inviteeTopicAcked` to true once they tap Ready.
    const isInviteeAwaitingTopicAck =
      invitation && invitation.isInviter === false && !inviteeTopicAcked;

    if (
      !sessionId ||
      loadingSession ||
      loadingMessages ||
      loadingCompact ||
      hasFetchedInitialMessage.current ||
      isFetchingInitialMessage ||
      isOnboardingUnsigned ||
      isInviteeAwaitingTopicAck
    ) {
      return;
    }

    // Check if messages are empty after loading completes
    const messagesPages = messagesData?.pages;
    const hasMessages = messagesPages && messagesPages.some(page => page.messages.length > 0);

    if (!hasMessages) {
      hasFetchedInitialMessage.current = true;
      fetchInitialMessage({ sessionId });
    }
  }, [
    sessionId,
    loadingSession,
    loadingMessages,
    loadingCompact,
    messagesData?.pages,
    isFetchingInitialMessage,
    fetchInitialMessage,
    currentStage,
    compactData?.mySigned,
    invitation,
    inviteeTopicAcked,
  ]);

  // -------------------------------------------------------------------------
  // Generate Inline Cards
  // -------------------------------------------------------------------------
  const inlineCards = useMemo((): InlineChatCard[] => {
    const cards: InlineChatCard[] = [];

    // Note: Waiting status cards have been removed.
    // We don't show "waiting for partner" messages anymore.

    // Stage 1: Witness cards
    if (currentStage === Stage.WITNESS) {
      // Cooling suggestion
      if (state.showCoolingSuggestion) {
        cards.push({
          id: 'cooling-suggestion',
          type: 'cooling-suggestion',
          position: 'end',
          props: {
            intensity: state.barometerValue,
            pendingConfirmation: state.pendingConfirmation,
          },
        });
      }

      // Note: Feel heard confirmation is now rendered above chat input, not as inline card
    }

    // Stage 2: Perspective Stretch cards
    if (currentStage === Stage.PERSPECTIVE_STRETCH) {
      // Note: ready-to-share-confirmation card removed - now shown as panel above chat input
      // The panel slides up when empathy statement is ready to review

      // Note: empathy-draft-preview card removed - users access empathy statement via the overlay drawer
      // The ready-to-share-confirmation card opens the overlay, and after sending it appears as a message in chat

      // Note: accuracy-feedback card removed - now handled by inline validation card

      // Note: Share suggestion from reconciler is now handled via the low-profile panel
      // + ShareSuggestionDrawer pattern instead of an inline card.
    }

    // Stage 3: Need Mapping cards
    // Note: needs-summary and needs-reveal-preview inline cards removed.
    // Needs render inline in the transcript; reveal validation still opens
    // the side-by-side review surface.

    // Stage 4: Strategic Repair cards
    if (currentStage === Stage.STRATEGIC_REPAIR) {
      // Strategy pool preview (hide after session is resolved)
      if (
        strategyPhase === StrategyPhase.COLLECTING &&
        strategies.length > 0 &&
        !myReadyToRank &&
        session?.status !== SessionStatus.RESOLVED
      ) {
        cards.push({
          id: 'strategy-pool-preview',
          type: 'strategy-pool-preview',
          position: 'end',
          props: {
            strategyCount: strategies.length,
            canMarkReadyToRank,
            canRank: canRankStrategies,
            // Note: StrategyDTO doesn't expose source to keep strategies unlabeled
            userContributedCount: 0,
          },
        });
      }

      // Agreement preview (hide after session is resolved — no need to "Review & Confirm")
      if (agreements.length > 0 && session?.status !== SessionStatus.RESOLVED) {
        const confirmedByMe = agreements.filter(a => a.agreedByMe).length;
        const allConfirmedByMe = confirmedByMe === agreements.length;
        const waitingForPartner = allConfirmedByMe &&
          agreements.some(a => !a.agreedByPartner);

        cards.push({
          id: 'agreement-preview',
          type: 'agreement-preview',
          position: 'end',
          props: {
            totalAgreements: agreements.length,
            confirmedByMe,
            waitingForPartner,
            partnerName,
            agreements,
          },
        });
      }
    }

    // Filter out dismissed cards
    return cards.filter((card) => !state.dismissedCards.has(card.id));
  }, [
    currentStage,
    state,
    showFeelHeardConfirmation,
    aiRecommendsReadyToShare,
    liveProposedEmpathyStatement,
    empathyDraftData,
    partnerEmpathyData,
    needs,
    allNeedsConfirmed,
    needsRevealValidationItems,
    needsRevealValidatedByBoth,
    strategyPhase,
    strategies,
    myReadyToRank,
    canMarkReadyToRank,
    canRankStrategies,
    agreements,
    partnerName,
    session?.status,
  ]);

  // -------------------------------------------------------------------------
  // Action Handlers
  // -------------------------------------------------------------------------

  const handleSendMessage = useCallback(
    (content: string, options?: { refiningNeedId?: string | null }) => {
      if (!sessionId) return;

      // Prevent duplicate submissions
      if (isSending || isStreaming) {
        console.warn('[handleSendMessage] Already sending a message, ignoring duplicate call');
        return;
      }

      // Reset activity timer
      lastActivityTime.current = Date.now();

      // Send message with SSE streaming for AI response
      // Metadata handling is done via onMetadata callback to the streaming hook
      streamingSendMessage({ sessionId, content, currentStage, refiningNeedId: options?.refiningNeedId ?? null });
    },
    [sessionId, currentStage, streamingSendMessage, isSending, isStreaming]
  );

  const handleBarometerChange = useCallback(
    (value: number) => {
      dispatch({ type: 'SET_BAROMETER', payload: value });
      if (sessionId) {
        recordEmotion({ sessionId, intensity: value });
      }

      if (value >= HIGH_INTENSITY_THRESHOLD) {
        dispatch({ type: 'SHOW_COOLING_SUGGESTION', payload: true });
      }
    },
    [sessionId, recordEmotion]
  );

  const handleConfirmFeelHeard = useCallback(
    (onSuccess?: () => void) => {
      if (!sessionId) return;
      // Prevent duplicate submissions
      if (isConfirmingFeelHeard) {
        console.warn('[handleConfirmFeelHeard] Already confirming, ignoring duplicate call');
        return;
      }
      // Mark as confirmed to prevent looping (this will hide the confirmation via useMemo)
      dispatch({ type: 'SET_HAS_CONFIRMED_HEARD', payload: true });
      confirmHeard(
        { sessionId, confirmed: true },
        {
          onSuccess,
          onError: (error) => {
            console.error('[handleConfirmFeelHeard] Error confirming feel-heard:', error);
          },
        }
      );
    },
    [sessionId, confirmHeard, isConfirmingFeelHeard]
  );

  // Dismiss feel-heard card without confirming (user clicks "Not yet")
  // Sets dismissal state which hides the confirmation via useMemo derivation
  const handleDismissFeelHeard = useCallback(() => {
    setHasDismissedFeelHeard(true);
  }, []);

  // Dismiss ready-to-share prompt (user clicks "Not yet")
  // Resets the AI recommendation so it can be offered again later
  const handleDismissReadyToShare = useCallback(() => {
    setAiRecommendsReadyToShare(false);
  }, []);

  // Mark empathy draft as ready to share (user confirms from AI prompt)
  // This saves the draft with readyToShare: true
  const handleConfirmReadyToShare = useCallback(() => {
    if (!sessionId) return;
    // Reset the AI recommendation
    setAiRecommendsReadyToShare(false);

    if (empathyDraftData?.draft?.content) {
      // If draft exists, mark it ready to share
      saveDraft({ sessionId, content: empathyDraftData.draft.content, readyToShare: true });
    } else if (liveProposedEmpathyStatement) {
      // Use AI-proposed empathy statement - mark as ready so preview card appears
      saveDraft({
        sessionId,
        content: liveProposedEmpathyStatement,
        readyToShare: true
      });
    } else {
      // If no draft or proposal exists, create a placeholder and mark ready
      // This will show the preview card so user can edit before sharing
      saveDraft({
        sessionId,
        content: 'Based on our conversation, I understand that you might be feeling...',
        readyToShare: true
      });
    }
  }, [sessionId, empathyDraftData?.draft?.content, liveProposedEmpathyStatement, saveDraft]);

  const handleSignCompact = useCallback(
    (onSuccess?: () => void) => {
      if (!sessionId) return;
      signCompact(
        { sessionId },
        {
          onSuccess: () => {
            // Fetch initial message if none exist. Skipped for the invitee
            // while they're awaiting the Stage 0 topic-ack screen — they
            // should see the inviter's topic before any AI message arrives.
            const messagesPages = messagesData?.pages;
            const hasMessages = messagesPages && messagesPages.some(page => page.messages.length > 0);
            const isInviteeAwaitingTopicAck =
              invitation && invitation.isInviter === false && !inviteeTopicAcked;
            if (
              !isInviteeAwaitingTopicAck &&
              !hasMessages &&
              !hasFetchedInitialMessage.current
            ) {
              hasFetchedInitialMessage.current = true;
              fetchInitialMessage({ sessionId });
            }
            // Call success callback (which triggers stage completion)
            onSuccess?.();
          },
        }
      );
    },
    [sessionId, signCompact, messagesData?.pages, fetchInitialMessage, invitation, inviteeTopicAcked]
  );

  const handleConfirmInvitationMessage = useCallback(
    (onSuccess?: () => void) => {
      if (!sessionId) return;
      confirmInvitationMessage(
        { sessionId },
        { onSuccess }
      );
    },
    [sessionId, confirmInvitationMessage]
  );

  const handleSaveEmpathyDraft = useCallback(
    (content: string, readyToShare?: boolean) => {
      if (!sessionId) return;
      saveDraft({ sessionId, content, readyToShare });
    },
    [sessionId, saveDraft]
  );

  const handleShareEmpathy = useCallback((content?: string) => {
    if (!sessionId) {
      console.warn('[handleShareEmpathy] No sessionId, aborting');
      return;
    }
    if (!consentToShare) {
      console.error('[handleShareEmpathy] consentToShare mutation is not available');
      return;
    }
    // Pass draft content for optimistic UI update
    // Use provided content, or fall back to draft/proposed statement
    const draftContent = content || empathyDraftData?.draft?.content || liveProposedEmpathyStatement || undefined;
    console.log('[handleShareEmpathy] Calling consentToShare', {
      sessionId,
      hasDraftContent: !!draftContent,
      draftContentLength: draftContent?.length,
      contentProvided: !!content,
      hasEmpathyDraft: !!empathyDraftData?.draft?.content,
      hasLiveProposed: !!liveProposedEmpathyStatement
    });
    (async () => {
      try {
        // Ensure the draft is marked ready BEFORE consenting (prevents backend 400 + retry race)
        if (draftContent) {
          await saveDraftAsync({ sessionId, content: draftContent, readyToShare: true });
        }

        console.log('[handleShareEmpathy] About to call consentToShare mutation');
        consentToShare(
          { sessionId, consent: true, draftContent },
          {
            onError: (error) => {
              console.error('[handleShareEmpathy] Mutation onError callback', error);
            },
            onSuccess: (data) => {
              console.log('[handleShareEmpathy] Mutation onSuccess callback', data);
            },
          }
        );
        console.log('[handleShareEmpathy] consentToShare mutation called (async)');
      } catch (error) {
        console.error('[handleShareEmpathy] Failed during ready-to-share + consent flow', error);
      }
    })();
  }, [sessionId, consentToShare, empathyDraftData?.draft?.content, liveProposedEmpathyStatement, saveDraftAsync]);

  /**
   * Resubmit empathy statement after refining (received shared context from partner).
   * This is used when the user has already shared their empathy statement once,
   * but received additional context from their partner and wants to revise it.
   */
  const handleResubmitEmpathy = useCallback((content: string) => {
    if (!sessionId) {
      console.warn('[handleResubmitEmpathy] No sessionId, aborting');
      return;
    }
    console.log('[handleResubmitEmpathy] Calling resubmitEmpathy', {
      sessionId,
      contentLength: content.length,
    });
    resubmitEmpathy(
      { sessionId, content },
      {
        onError: (error) => {
          console.error('[handleResubmitEmpathy] Mutation onError callback', error);
          const message = error instanceof ApiClientError
            ? error.message
            : 'Failed to resubmit. Please try again.';
          showError('Resubmission failed', message);
        },
        onSuccess: (data) => {
          console.log('[handleResubmitEmpathy] Mutation onSuccess callback', data);
        },
      }
    );
  }, [sessionId, resubmitEmpathy, showError]);

  const handleValidatePartnerEmpathy = useCallback(
    (validated: boolean, feedback?: string) => {
      if (!sessionId) return;
      validateEmpathy({ sessionId, validated, feedback });
    },
    [sessionId, validateEmpathy]
  );

  const handleSkipRefinement = useCallback(
    (willingToAccept: boolean, reason?: string) => {
      if (!sessionId) return;
      skipRefinement({ sessionId, willingToAccept, reason });
    },
    [sessionId, skipRefinement]
  );

  const handleConfirmAllNeeds = useCallback(
    (onSuccess?: () => void) => {
      if (!sessionId || liveNeeds.length === 0) return;

      const needIds = liveNeeds.map((need) => need.id);

      confirmNeeds(
        { sessionId, needIds },
        {
          onSuccess: () => onSuccess?.(),
        }
      );
    },
    [sessionId, liveNeeds, confirmNeeds]
  );

  const handleConsentToShareNeeds = useCallback(
    (onSuccess?: () => void) => {
      if (!sessionId || liveNeeds.length === 0) return;

      const needIds = liveNeeds.map((need) => need.id);

      consentShareNeeds(
        { sessionId, needIds },
        {
          onSuccess: () => {
            onSuccess?.();
          },
        }
      );
    },
    [sessionId, liveNeeds, consentShareNeeds]
  );

  const handleValidateNeedsReveal = useCallback(
    (onSuccess?: () => void) => {
      if (!sessionId) return;

      validateNeedsMutation(
        { sessionId, validated: true },
        { onSuccess: () => onSuccess?.() }
      );
    },
    [sessionId, validateNeedsMutation]
  );

  const handleNeedsNotValidYet = useCallback(
    (onSuccess?: () => void) => {
      if (!sessionId) return;

      validateNeedsMutation(
        { sessionId, validated: false },
        { onSuccess: () => onSuccess?.() }
      );
    },
    [sessionId, validateNeedsMutation]
  );

  const handleAddStrategy = useCallback(
    (description: string) => {
      if (!sessionId) return;
      proposeStrategy({ sessionId, description });
    },
    [sessionId, proposeStrategy]
  );

  const handleRequestMoreStrategies = useCallback(
    (count?: number) => {
      if (!sessionId) return;
      requestSuggestions({ sessionId, count });
    },
    [sessionId, requestSuggestions]
  );

  const handleConfirmAgreement = useCallback(
    (agreementId: string, onSuccess?: (response: ConfirmAgreementResponse) => void) => {
      if (!sessionId) return;
      confirmAgreement(
        { sessionId, agreementId, confirmed: true },
        { onSuccess: (response) => onSuccess?.(response) }
      );
    },
    [sessionId, confirmAgreement]
  );

  const handleCreateAgreementFromOverlap = useCallback(
    (strategy: { id: string; description: string }) => {
      if (!sessionId) return;
      if (agreements.length >= MAX_AGREEMENTS) return; // UI should already disable
      createAgreement({
        sessionId,
        strategyId: strategy.id,
        description: strategy.description,
        type: AgreementType.MICRO_EXPERIMENT,
      });
    },
    [sessionId, createAgreement, agreements.length]
  );

  const handleResolveSession = useCallback(
    (onSuccess?: () => void) => {
      if (!sessionId) return;
      resolveSession({ sessionId }, { onSuccess });
    },
    [sessionId, resolveSession]
  );

  const openOverlay = useCallback((overlay: OverlayType) => {
    dispatch({ type: 'OPEN_OVERLAY', payload: overlay });
  }, []);

  const closeOverlay = useCallback(() => {
    dispatch({ type: 'CLOSE_OVERLAY' });
  }, []);

  const dismissCard = useCallback((cardId: string) => {
    dispatch({ type: 'DISMISS_CARD', payload: cardId });
  }, []);

  // -------------------------------------------------------------------------
  // Return Value
  // -------------------------------------------------------------------------
  return {
    // Loading state
    isLoading: loadingSession || loadingProgress || loadingMessages,
    isFetchingMessages: fetchingMessages && !isFetchingNextPage,
    loadError: accessDenied ? null : stateError,
    refetchSession: refetchState,
    accessDenied,
    isFetchingInitialMessage,

    // Session context
    session,
    sessionId,
    currentStage,
    stageStatus: myProgress?.status,
    partnerName,
    partnerProgress,
    myProgress,
    canAdvance,
    gates: myProgress?.gatesSatisfied,
    milestones: progressData?.milestones,

    // Messages and cards
    messages,
    inlineCards,
    isSending,
    isStreaming,
    failedMessageContent,
    isSigningCompact,
    isConfirmingFeelHeard,
    isConfirmingInvitation,
    showFeelHeardConfirmation,

    // Unread tracking - for "New messages" separator in chat
    // This is the lastSeenChatItemId from BEFORE the user opened the session
    // It's cleared after markViewed is called so new messages don't show a separator
    lastSeenChatItemIdForSeparator,
    lastViewedAtForAnimation,

    // Pagination for loading older messages
    fetchMoreMessages: fetchNextPage,
    hasMoreMessages: hasNextPage ?? false,
    isFetchingMoreMessages: isFetchingNextPage,

    // Overlay state
    activeOverlay: state.activeOverlay,

    // Local state
    barometerValue: state.barometerValue,
    showCoolingSuggestion: state.showCoolingSuggestion,
    showFinalCheck: state.showFinalCheck,
    pendingConfirmation: state.pendingConfirmation,
    followUpDate: state.followUpDate,

    // Memory suggestion
    memorySuggestion,
    setMemorySuggestion,
    clearMemorySuggestion: () => setMemorySuggestion(null),

    // Invitation phase
    isInvitationPhase,
    invitationConfirmed,
    invitation,

    // Stage-specific data
    compactData,
    loadingCompact,
    empathyDraftData,
    partnerEmpathyData,
    liveProposedEmpathyStatement,
    setLiveProposedEmpathyStatement,
    aiRecommendsReadyToShare,
    setAiRecommendsReadyToShare,
    setStreamTriggeredFeelHeard,
    setHasDismissedFeelHeard,
    needsData,
    needs,
    allNeedsConfirmed,
    needsRevealValidationData,
    needsRevealValidationItems,
    needsRevealValidatedByBoth,
    needsComparisonData,
    strategyData,
    strategyPhase,
    strategies,
    canMarkReadyToRank,
    canRankStrategies,
    agreementsData,
    agreements,
    empathyStatusData,
    shareOfferData,
    isGenerating,
    isSavingEmpathyDraft,
    isSharingEmpathy,
    isResubmittingEmpathy,
    isRespondingToShareOffer,
    isProposing,
    isConfirmingNeeds,
    isSharingNeeds,

    // Actions
    sendMessage: handleSendMessage,
    openOverlay,
    closeOverlay,
    dismissCard,
    dispatch,

    // Stage-specific actions
    handleBarometerChange,
    handleConfirmFeelHeard,
    handleDismissFeelHeard,
    handleConfirmReadyToShare,
    handleDismissReadyToShare,
    handleSignCompact,
    handleConfirmInvitationMessage,
    handleSaveEmpathyDraft,
    handleShareEmpathy,
    handleResubmitEmpathy,
    handleValidatePartnerEmpathy,
    handleSkipRefinement,
    handleConfirmAllNeeds,
    handleConsentToShareNeeds,
    handleValidateNeedsReveal,
    handleNeedsNotValidYet,
    handleAddStrategy,
    handleRequestMoreStrategies,
    handleConfirmAgreement,
    handleCreateAgreementFromOverlap,
    handleResolveSession,
    handleRespondToShareOffer,

    // Stage advancement (used e.g. by invitee topic-ack Ready button)
    advanceStage,
    // Manual initial-message trigger (for callers using deferInitialMessage)
    triggerInitialMessage: () => {
      if (!sessionId) return;
      if (hasFetchedInitialMessage.current) return;
      hasFetchedInitialMessage.current = true;
      fetchInitialMessage({ sessionId });
    },

    // Utility actions
    showCooling: (show: boolean) =>
      dispatch({ type: 'SHOW_COOLING_SUGGESTION', payload: show }),
    showFinal: (show: boolean) =>
      dispatch({ type: 'SHOW_FINAL_CHECK', payload: show }),
    setPendingConfirmation: (pending: boolean) =>
      dispatch({ type: 'SET_PENDING_CONFIRMATION', payload: pending }),
    setFollowUpDate: (date: Date | null) =>
      dispatch({ type: 'SET_FOLLOW_UP_DATE', payload: date }),

    // Session viewed tracking - call when user receives new content while viewing
    // This updates lastViewedAt so partner sees "seen" status in real-time
    markSessionViewed: markViewed,
  };
}
