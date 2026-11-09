/**
 * Stage Hooks for Meet Without Fear Mobile
 *
 * React Query hooks for stage-specific API operations.
 * Covers all 5 stages: Onboarding, Witness, Perspective Stretch, Need Mapping, Strategic Repair.
 */

import { useEffect, useRef } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
  UseQueryOptions,
  UseMutationOptions,
  InfiniteData,
  QueryClient,
} from '@tanstack/react-query';
import { get, post, del, ApiClientError } from '../lib/api';
import { useAuth } from './useAuth';
import {
  // Response types
  SignCompactResponse,
  CompactStatusResponse,
  ConfirmFeelHeardResponse,
  SaveEmpathyDraftResponse,
  DeleteEmpathyDraftResponse,
  EditPreJoinDraftFirstResponse,
  MessageDTO,
  ConsentToShareEmpathyResponse,
  GetProgressResponse,
  MilestoneKey,
  MilestoneMap,
  StageBlockedReason,
  SessionStateResponse,
  // DTOs
  GetEmpathyDraftResponse,
  GetPartnerEmpathyResponse,
  ValidateEmpathyRequest,
  ValidateEmpathyResponse,
  GetNeedsResponse,
  CaptureNeedsRequest,
  CaptureNeedsResponse,
  ConfirmNeedsRequest,
  NeedAdjustment,
  ConfirmNeedsResponse,
  InterpretNeedEditRequest,
  InterpretNeedEditResponse,
  ApplyNeedEditsRequest,
  ApplyNeedEditsResponse,
  DeleteNeedResponse,
  GetNeedsComparisonResponse,
  ValidateNeedsResponse,
  AddNeedRequest,
  AddNeedResponse,
  ConsentShareNeedsResponse,
  StrategyDTO,
  GetStrategiesResponse,
  ProposeStrategyRequest,
  ProposeStrategyResponse,
  SubmitRankingResponse,
  RevealOverlapResponse,
  MarkReadyResponse,
  GetStage4StateResponse,
  Stage4SelectionDecision,
  SubmitStage4SelectionRequest,
  SubmitStage4SelectionsRequest,
  SubmitStage4SelectionsResponse,
  CloseStage4Request,
  CloseStage4Response,
  GetTendingEntriesResponse,
  GetTendingHistoryResponse,
  SubmitTendingResponseRequest,
  SubmitTendingResponseResponse,
  SubmitTendingCheckinRequest,
  SubmitTendingCheckinResponse,
  CreateTendingBetweenPeriodNoteRequest,
  CreateTendingBetweenPeriodNoteResponse,
  CreateTendingReentryRequest,
  CreateTendingReentryResponse,
  AgreementDTO,
  CreateAgreementRequest,
  CreateAgreementResponse,
  ConfirmAgreementResponse,
  ResolveSessionResponse,
  Stage,
  StageStatus,
  GetMessagesResponse,
  MessageRole,
  EmpathyExchangeStatusResponse,
  GetShareSuggestionResponse,
  RespondToShareSuggestionRequest,
  RespondToShareSuggestionResponse,
  ResubmitEmpathyResponse,
  SkipRefinementRequest,
  SkipRefinementResponse,
  SaveValidationFeedbackDraftRequest,
  SaveValidationFeedbackDraftResponse,
  RefineValidationFeedbackRequest,
  RefineValidationFeedbackResponse,
  StrategyPhase,
  IdentifiedNeedDTO,
} from '@meet-without-fear/shared';

// Import query keys from centralized file to avoid circular dependencies
import {
  sessionKeys,
  stageKeys,
  messageKeys,
} from './queryKeys';

// Re-export for backwards compatibility
export { stageKeys };

/**
 * Write reached milestones into the caller's progress, in both caches that
 * carry it (GET /progress and GET /state): `myProgress.milestones` is the
 * participant_milestone map (key → reachedAt ISO). Optimistic writers only
 * add keys the server will write; a refetch replaces the map wholesale.
 */
export function patchMyMilestones(
  queryClient: ReturnType<typeof useQueryClient>,
  sessionId: string,
  reached: MilestoneMap,
) {
  const merge = <T extends { myProgress?: { milestones?: MilestoneMap } }>(old: T | undefined): T | undefined => {
    if (!old?.myProgress) return old;
    return {
      ...old,
      myProgress: { ...old.myProgress, milestones: { ...(old.myProgress.milestones ?? {}), ...reached } },
    };
  };

  queryClient.setQueryData<GetProgressResponse>(stageKeys.progress(sessionId), merge);
  queryClient.setQueryData<SessionStateResponse>(sessionKeys.state(sessionId), (old) => {
    if (!old) return old;
    return { ...old, progress: merge(old.progress) ?? old.progress };
  });
}

export function patchNeedsCacheWithNeed(
  queryClient: QueryClient,
  sessionId: string,
  need: IdentifiedNeedDTO,
): void {
  queryClient.setQueryData<GetNeedsResponse>(stageKeys.needs(sessionId), (old) => {
    if (!old) {
      return {
        needs: [need],
        synthesizedAt: need.createdAt ?? new Date().toISOString(),
        sharedAt: null,
      };
    }

    const existingIndex = old.needs.findIndex((item) => item.id === need.id);
    const needs =
      existingIndex >= 0
        ? old.needs.map((item) => (item.id === need.id ? need : item))
        : [...old.needs, need];

    return {
      ...old,
      needs: [...needs].sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
        return aTime - bTime;
      }),
      synthesizedAt: old.synthesizedAt ?? need.createdAt ?? new Date().toISOString(),
    };
  });
}

// ============================================================================
// Progress Hook
// ============================================================================

/**
 * Get session progress for both users.
 */
export function useProgress(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<GetProgressResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.progress(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetProgressResponse>(`/sessions/${sessionId}/progress`);
    },
    enabled: !!sessionId,
    staleTime: 10_000, // Progress can change frequently
    ...options,
  });
}

// ============================================================================
// Stage 0: Curiosity Compact
// ============================================================================

/**
 * Get empathy exchange status (for Stage 2 progress and reconciler status)
 */
export function useEmpathyStatus(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<EmpathyExchangeStatusResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.empathyStatus(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<EmpathyExchangeStatusResponse>(`/sessions/${sessionId}/empathy/status`);
    },
    enabled: !!sessionId,
    staleTime: 30_000, // Ably events deliver status updates in real-time via setQueryData
    // Reconciliation runs after the consent request returns. The first person
    // to share remains HELD until their partner shares, and without an Ably
    // event that cached state would never learn that reconciliation started.
    // Poll only in those transient states; terminal states remain event-driven.
    refetchInterval: (query) => {
      const status = query.state.data;
      if (status?.analyzing || status?.myAttempt?.status === 'READY') return 2_000;
      if (
        status?.myAttempt?.status === 'HELD' ||
        status?.myAttempt?.status === 'AWAITING_SHARING' ||
        status?.myAttempt?.status === 'REVEALED'
      ) {
        return 5_000;
      }
      return false;
    },
    ...options,
  });
}

/**
 * Get pending share offer (from reconciler)
 */
export function useShareOffer(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<GetShareSuggestionResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.shareOffer(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetShareSuggestionResponse>(`/sessions/${sessionId}/reconciler/share-offer`);
    },
    enabled: !!sessionId,
    staleTime: 30_000, // Ably events deliver share offer updates in real-time
    ...options,
  });
}

/**
 * Respond to a share offer
 */
export function useRespondToShareOffer(
  options?: Omit<
    UseMutationOptions<
      RespondToShareSuggestionResponse,
      ApiClientError,
      { sessionId: string; sharedContent?: string } & RespondToShareSuggestionRequest,
      { previousInfinite: InfiniteData<GetMessagesResponse> | undefined }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();
  const { user: shareOfferUser } = useAuth();

  return useMutation<
    RespondToShareSuggestionResponse,
    ApiClientError,
    { sessionId: string; sharedContent?: string } & RespondToShareSuggestionRequest,
    { previousInfinite: InfiniteData<GetMessagesResponse> | undefined }
  >({
    mutationFn: async ({ sessionId, sharedContent: _, ...request }) => {
      return post<RespondToShareSuggestionResponse>(
        `/sessions/${sessionId}/reconciler/share-offer/respond`,
        request
      );
    },
    onMutate: async ({ sessionId, action, sharedContent }) => {
      // Only add optimistic message for 'accept' action with content
      if (action !== 'accept' || !sharedContent) {
        return { previousInfinite: undefined };
      }

      // Cancel outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: messageKeys.infinite(sessionId) });

      // Snapshot previous state for rollback
      const previousInfinite = queryClient.getQueryData<InfiniteData<GetMessagesResponse>>(
        messageKeys.infinite(sessionId)
      );

      // Create optimistic "What you shared" message
      const optimisticMessage = {
        id: `optimistic-shared-${Date.now()}`,
        sessionId,
        senderId: shareOfferUser?.id ?? null,
        role: MessageRole.EMPATHY_STATEMENT,
        content: sharedContent,
        stage: 2,
        timestamp: new Date().toISOString(),
      };

      // Update infinite query cache - add to END (chronological order within page)
      // useUnifiedSession flattens with [...pages].reverse().flatMap()
      queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
        messageKeys.infinite(sessionId),
        (old) => {
          if (!old || !old.pages || old.pages.length === 0) {
            return {
              pages: [{ messages: [optimisticMessage], hasMore: false }],
              pageParams: [undefined],
            };
          }

          const newPages = [...old.pages];
          const firstPage = { ...newPages[0] };
          // Add to END for chronological order
          firstPage.messages = [...firstPage.messages, optimisticMessage];
          newPages[0] = firstPage;
          return { ...old, pages: newPages };
        }
      );

      // Immediately hide the share offer panel by clearing the cache
      queryClient.setQueryData<GetShareSuggestionResponse>(
        stageKeys.shareOffer(sessionId),
        { hasSuggestion: false, suggestion: null }
      );

      console.log('[useRespondToShareOffer] Optimistic update applied');
      return { previousInfinite };
    },
    onError: (err, { sessionId }, context) => {
      // Rollback on error
      if (context?.previousInfinite) {
        queryClient.setQueryData(messageKeys.infinite(sessionId), context.previousInfinite);
      }
      // Restore share offer data by invalidating
      queryClient.invalidateQueries({ queryKey: stageKeys.shareOffer(sessionId) });
      console.error('[useRespondToShareOffer] Error, rolling back:', err);
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: [...stageKeys.all, 'empathy', 'status', sessionId] });
      queryClient.invalidateQueries({ queryKey: stageKeys.shareOffer(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });

      // Refetch messages to pick up any new messages from the share response
      queryClient.invalidateQueries({ queryKey: messageKeys.infinite(sessionId) });
    },
    ...options,
  });
}

/**
 * Response from the generate-draft endpoint
 */
export interface GenerateShareDraftResponse {
  draft: string;
  messageId: string;
  guesserName: string;
  suggestedShareFocus: string;
}

/**
 * Generate a share draft based on suggestedShareFocus.
 * Called when user taps "Yes, help me share" in the ShareTopicDrawer.
 * The draft is generated by AI and saved as a message in the chat.
 */
export function useGenerateShareDraft(
  options?: Omit<
    UseMutationOptions<
      GenerateShareDraftResponse,
      ApiClientError,
      { sessionId: string }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation<
    GenerateShareDraftResponse,
    ApiClientError,
    { sessionId: string }
  >({
    mutationFn: async ({ sessionId }) => {
      return post<GenerateShareDraftResponse>(
        `/sessions/${sessionId}/reconciler/share-offer/generate-draft`,
        {}
      );
    },
    onSuccess: (data, { sessionId }) => {
      // Invalidate messages to show the new AI message with the draft
      queryClient.invalidateQueries({ queryKey: messageKeys.infinite(sessionId) });
      queryClient.invalidateQueries({ queryKey: messageKeys.list(sessionId) });
      console.log('[useGenerateShareDraft] Draft generated:', data.draft.substring(0, 50) + '...');
    },
    onError: (err) => {
      console.error('[useGenerateShareDraft] Error generating draft:', err);
    },
    ...options,
  });
}

/**
 * Get compact status for both users.
 */
export function useCompactStatus(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<CompactStatusResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.compact(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<CompactStatusResponse>(`/sessions/${sessionId}/compact/status`);
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    ...options,
  });
}

/**
 * Sign the curiosity compact.
 */
/**
 * Context stored by onMutate for rollback on error.
 */
interface SignCompactContext {
  previousSessionState: SessionStateResponse | undefined;
  optimisticTimestamp: string;
}

/**
 * Sign the Curiosity Compact.
 *
 * Cache-First Architecture:
 * - onMutate: Immediately updates compact.mySigned and compact.mySignedAt in cache
 * - onSuccess: Invalidates queries to sync with server
 * - onError: Rolls back to previous cache state
 */
export function useSignCompact(
  options?: Omit<
    UseMutationOptions<
      SignCompactResponse,
      ApiClientError,
      { sessionId: string },
      SignCompactContext
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation<
    SignCompactResponse,
    ApiClientError,
    { sessionId: string },
    SignCompactContext
  >({
    mutationFn: async ({ sessionId }) => {
      return post<SignCompactResponse>(`/sessions/${sessionId}/compact/sign`, {
        agreed: true,
      });
    },

    // =========================================================================
    // OPTIMISTIC UPDATE: Update compact status immediately
    // =========================================================================
    onMutate: async ({ sessionId }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: sessionKeys.state(sessionId) });

      // Snapshot previous state for rollback
      const previousSessionState = queryClient.getQueryData<SessionStateResponse>(
        sessionKeys.state(sessionId)
      );

      const optimisticTimestamp = new Date().toISOString();

      // Optimistically update compact status
      queryClient.setQueryData<SessionStateResponse>(
        sessionKeys.state(sessionId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            compact: old.compact ? {
              ...old.compact,
              mySigned: true,
              mySignedAt: optimisticTimestamp,
            } : old.compact,
          };
        }
      );

      return { previousSessionState, optimisticTimestamp };
    },

    // =========================================================================
    // SUCCESS: Invalidate queries to sync with server
    // =========================================================================
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.compact(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      // Also invalidate consolidated state so shouldShowCompactOverlay updates
      queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
    },

    // =========================================================================
    // ERROR: Rollback to previous cache state
    // =========================================================================
    onError: (_error, { sessionId }, context) => {
      if (context?.previousSessionState !== undefined) {
        queryClient.setQueryData(sessionKeys.state(sessionId), context.previousSessionState);
      }
    },

    ...options,
  });
}

// ============================================================================
// Stage 1: Feel Heard
// ============================================================================

/**
 * Context stored by onMutate for rollback on error.
 */
interface ConfirmFeelHeardContext {
  previousSessionState: SessionStateResponse | undefined;
  optimisticTimestamp: string;
}

/**
 * Confirm that user feels heard (gate for stage 1 completion).
 *
 * Cache-First Architecture:
 * - onMutate: Immediately writes the feel_heard milestone into myProgress.milestones
 * - onSuccess: Invalidates queries to sync with server
 * - onError: Rolls back to previous cache state
 */
export function useConfirmFeelHeard(
  options?: Omit<
    UseMutationOptions<
      ConfirmFeelHeardResponse,
      ApiClientError,
      { sessionId: string; confirmed: boolean; feedback?: string },
      ConfirmFeelHeardContext
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation<
    ConfirmFeelHeardResponse,
    ApiClientError,
    { sessionId: string; confirmed: boolean; feedback?: string },
    ConfirmFeelHeardContext
  >({
    mutationFn: async ({ sessionId, confirmed, feedback }) => {
      return post<ConfirmFeelHeardResponse>(`/sessions/${sessionId}/feel-heard`, {
        confirmed,
        feedback,
      });
    },

    // =========================================================================
    // OPTIMISTIC UPDATE: Update milestones immediately
    // =========================================================================
    onMutate: async ({ sessionId, confirmed }) => {
      // Only optimistically update if confirming (not dismissing)
      if (!confirmed) {
        return { previousSessionState: undefined, optimisticTimestamp: '' };
      }

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: sessionKeys.state(sessionId) });

      // Snapshot previous state for rollback
      const previousSessionState = queryClient.getQueryData<SessionStateResponse>(
        sessionKeys.state(sessionId)
      );

      const optimisticTimestamp = new Date().toISOString();

      // Optimistically update session state with feelHeardConfirmedAt AND advance stage
      queryClient.setQueryData<SessionStateResponse>(
        sessionKeys.state(sessionId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            progress: old.progress ? {
              ...old.progress,
              myProgress: old.progress.myProgress ? {
                ...old.progress.myProgress,
                stage: Stage.PERSPECTIVE_STRETCH,
                milestones: { ...old.progress.myProgress.milestones, feel_heard: optimisticTimestamp },
              } : old.progress.myProgress,
            } : old.progress,
          };
        }
      );

      return { previousSessionState, optimisticTimestamp };
    },

    // =========================================================================
    // SUCCESS: Update caches directly (no refetch needed!)
    // =========================================================================
    onSuccess: (data, { sessionId }, context) => {
      // Invalidate less critical queries in background
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });

      // UPDATE SESSION STATE DIRECTLY - DO NOT INVALIDATE!
      // Invalidating sessionKeys.state causes a race condition where the refetch
      // overwrites the optimistic update with stale server data before the server
      // has processed the mutation. This is the root cause of the recurring bug
      // where messages don't appear after feel-heard confirmation.
      // See commits: 6c6504e, d16a32f, 1151ab9 for history of this bug.
      queryClient.setQueryData<SessionStateResponse>(
        sessionKeys.state(sessionId),
        (old) => {
          // If cache was cleared between onMutate and onSuccess, use context fallback
          const baseState = old ?? context?.previousSessionState;
          if (!baseState) return old;

          return {
            ...baseState,
            progress: baseState.progress ? {
              ...baseState.progress,
              myProgress: baseState.progress.myProgress ? {
                ...baseState.progress.myProgress,
                stage: Stage.PERSPECTIVE_STRETCH,
                milestones: {
                  ...baseState.progress.myProgress.milestones,
                  // Use server's confirmedAt timestamp (authoritative)
                  feel_heard: data.confirmedAt || context?.optimisticTimestamp,
                },
              } : baseState.progress.myProgress,
            } : baseState.progress,
          };
        }
      );

      // Add transition message directly to cache instead of refetching
      // This preserves existing messages and prevents re-animation
      if (data.transitionMessage) {
        const newMessage = {
          id: data.transitionMessage.id,
          content: data.transitionMessage.content,
          timestamp: data.transitionMessage.timestamp,
          stage: data.transitionMessage.stage,
          role: MessageRole.AI,
          sessionId,
          senderId: null, // AI messages have no sender
        };

        const updateCache = (old: GetMessagesResponse | undefined): GetMessagesResponse => {
          if (!old) {
            return { messages: [newMessage], hasMore: false };
          }
          // Check for duplicates
          const existingIds = new Set((old.messages || []).map((m) => m.id));
          if (existingIds.has(newMessage.id)) {
            return old;
          }
          return {
            ...old,
            messages: [...(old.messages || []), newMessage],
          };
        };

        const updateInfiniteCache = (
          old: InfiniteData<GetMessagesResponse> | undefined
        ): InfiniteData<GetMessagesResponse> => {
          if (!old || old.pages.length === 0) {
            return {
              pages: [{ messages: [newMessage], hasMore: false }],
              pageParams: [undefined],
            };
          }
          // Update the first page (newest messages)
          const updatedPages = [...old.pages];
          const firstPage = updatedPages[0];
          const existingIds = new Set((firstPage.messages || []).map((m) => m.id));
          if (existingIds.has(newMessage.id)) {
            return old;
          }
          updatedPages[0] = {
            ...firstPage,
            messages: [...(firstPage.messages || []), newMessage],
          };
          return { ...old, pages: updatedPages };
        };

        // Update all message caches
        queryClient.setQueryData<GetMessagesResponse>(messageKeys.list(sessionId), updateCache);
        queryClient.setQueryData<GetMessagesResponse>(messageKeys.list(sessionId, 2), updateCache);
        queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId), updateInfiniteCache);
        queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId, 2), updateInfiniteCache);

        console.log(`[useConfirmFeelHeard] Added transition message ${newMessage.id} directly to cache`);
      }
    },

    // =========================================================================
    // ERROR: Rollback to previous cache state
    // =========================================================================
    onError: (_error, { sessionId }, context) => {
      if (context?.previousSessionState !== undefined) {
        queryClient.setQueryData(sessionKeys.state(sessionId), context.previousSessionState);
      }
    },

    ...options,
  });
}

// ============================================================================
// Stage 2: Empathy / Perspective Stretch
// ============================================================================

/**
 * Get current empathy draft.
 */
export function useEmpathyDraft(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<GetEmpathyDraftResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.empathyDraft(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetEmpathyDraftResponse>(`/sessions/${sessionId}/empathy/draft`);
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    ...options,
  });
}

/**
 * Save empathy draft.
 */
export interface SaveEmpathyDraftVariables {
  sessionId: string;
  content: string;
  readyToShare?: boolean;
  /**
   * work-99k2: the author's explicit choice in the review of a pre-join draft
   * (Send as is / Edit first). Only such a save ends the review; any other
   * save while it is pending is skipped by the server.
   */
  resolvePreJoinReview?: boolean;
}

interface SaveEmpathyDraftContext {
  previous: GetEmpathyDraftResponse | undefined;
}

export function useSaveEmpathyDraft(
  options?: Omit<
    UseMutationOptions<SaveEmpathyDraftResponse, ApiClientError, SaveEmpathyDraftVariables, SaveEmpathyDraftContext>,
    'mutationFn' | 'onMutate' | 'onError'
  >
) {
  const queryClient = useQueryClient();

  return useMutation<SaveEmpathyDraftResponse, ApiClientError, SaveEmpathyDraftVariables, SaveEmpathyDraftContext>({
    mutationFn: async ({ sessionId, content, readyToShare, resolvePreJoinReview }) => {
      return post<SaveEmpathyDraftResponse>(
        `/sessions/${sessionId}/empathy/draft`,
        resolvePreJoinReview ? { content, readyToShare, resolvePreJoinReview } : { content, readyToShare }
      );
    },
    onMutate: async ({ sessionId, resolvePreJoinReview }) => {
      // work-99k2: the author's explicit review choice ends the pre-join
      // review, so hide it now (rolled back on error). Other saves leave it.
      const key = stageKeys.empathyDraft(sessionId);
      const previous = queryClient.getQueryData<GetEmpathyDraftResponse>(key);
      if (resolvePreJoinReview && previous?.preJoinReview) {
        await queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<GetEmpathyDraftResponse>(key, { ...previous, preJoinReview: null });
      }
      return { previous };
    },
    onError: (_error, { sessionId, resolvePreJoinReview }, context) => {
      if (resolvePreJoinReview && context?.previous) {
        queryClient.setQueryData(stageKeys.empathyDraft(sessionId), context.previous);
      }
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.empathyDraft(sessionId) });
    },
    ...options,
  });
}

/**
 * Set the empathy draft aside (discard it) — work-99k2's review after the
 * partner joins. Optimistic: the draft and the review leave the cache at once.
 */
export function useDeleteEmpathyDraft(
  options?: Omit<
    UseMutationOptions<
      DeleteEmpathyDraftResponse,
      ApiClientError,
      { sessionId: string },
      { previous: GetEmpathyDraftResponse | undefined }
    >,
    'mutationFn' | 'onMutate' | 'onError'
  >
) {
  const queryClient = useQueryClient();

  return useMutation<
    DeleteEmpathyDraftResponse,
    ApiClientError,
    { sessionId: string },
    { previous: GetEmpathyDraftResponse | undefined }
  >({
    mutationFn: async ({ sessionId }) => del<DeleteEmpathyDraftResponse>(`/sessions/${sessionId}/empathy/draft`),
    onMutate: async ({ sessionId }) => {
      const key = stageKeys.empathyDraft(sessionId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<GetEmpathyDraftResponse>(key);
      if (previous) {
        queryClient.setQueryData<GetEmpathyDraftResponse>(key, {
          ...previous,
          draft: null,
          canConsent: false,
          preJoinReview: null,
        });
      }
      return { previous };
    },
    onError: (_error, { sessionId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(stageKeys.empathyDraft(sessionId), context.previous);
      }
    },
    ...options,
  });
}

/** Append one message to every message cache of the session (deduped by id). */
function appendMessageToCaches(queryClient: QueryClient, sessionId: string, message: MessageDTO): void {
  const updateCache = (old: GetMessagesResponse | undefined): GetMessagesResponse => {
    if (!old) return { messages: [message], hasMore: false };
    if ((old.messages || []).some((m) => m.id === message.id)) return old;
    return { ...old, messages: [...(old.messages || []), message] };
  };
  const updateInfiniteCache = (
    old: InfiniteData<GetMessagesResponse> | undefined
  ): InfiniteData<GetMessagesResponse> => {
    if (!old || old.pages.length === 0) {
      return { pages: [{ messages: [message], hasMore: false }], pageParams: [undefined] };
    }
    const pages = [...old.pages];
    const first = pages[0];
    if ((first.messages || []).some((m) => m.id === message.id)) return old;
    pages[0] = { ...first, messages: [...(first.messages || []), message] };
    return { ...old, pages };
  };
  const stages = message.stage !== undefined ? [undefined, message.stage] : [undefined];
  for (const stage of stages) {
    queryClient.setQueryData<GetMessagesResponse>(messageKeys.list(sessionId, stage), updateCache);
    queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId, stage), updateInfiniteCache);
  }
}

/** How the client waits for the background opener after Edit first (work-9309). Mutable for tests. */
export const EDIT_FIRST_OPENER_POLL = { attempts: 40, intervalMs: 1500 };

/** The newest wait per session: a newer wait, an unmount or a session switch bumps it and the older loop stops. */
const openerWaits = new Map<string, number>();

/** Stop any wait for this session's opener (unmount, session switch). */
export function cancelEditFirstOpenerWait(sessionId: string): void {
  openerWaits.set(sessionId, (openerWaits.get(sessionId) ?? 0) + 1);
}

/** Is there an AI message at or after `reopenedAt` in the session's cached conversation? */
function hasOpenerSince(queryClient: QueryClient, sessionId: string, reopenedAt: string): boolean {
  const since = new Date(reopenedAt).getTime();
  const infinite = queryClient.getQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId));
  const list = queryClient.getQueryData<GetMessagesResponse>(messageKeys.list(sessionId));
  const all = [...(infinite?.pages.flatMap((p) => p.messages || []) ?? []), ...(list?.messages ?? [])];
  return all.some((m) => m.role === MessageRole.AI && new Date(m.timestamp).getTime() >= since);
}

/**
 * Refetch the (active) conversation queries until the opener — the first AI
 * message at or after `reopenedAt` — is in the cache, bounded. Cancellable: a
 * newer wait for the session, or cancelEditFirstOpenerWait (unmount, session
 * switch), stops it. Resolves 'found', 'gave-up' or 'cancelled'. The draft
 * state is not touched: the reopen marker is the server's, so the panel stays
 * hidden whatever a refetch returns.
 */
export async function awaitEditFirstOpener(
  queryClient: QueryClient,
  sessionId: string,
  reopenedAt: string
): Promise<'found' | 'gave-up' | 'cancelled'> {
  cancelEditFirstOpenerWait(sessionId);
  const token = openerWaits.get(sessionId);
  const current = () => openerWaits.get(sessionId) === token;
  for (let i = 0; i < EDIT_FIRST_OPENER_POLL.attempts; i++) {
    if (!current()) return 'cancelled';
    if (hasOpenerSince(queryClient, sessionId, reopenedAt)) return 'found';
    await queryClient.refetchQueries({ queryKey: messageKeys.infinite(sessionId), type: 'active' });
    await queryClient.refetchQueries({ queryKey: messageKeys.list(sessionId), type: 'active' });
    if (!current()) return 'cancelled';
    if (hasOpenerSince(queryClient, sessionId, reopenedAt)) return 'found';
    await new Promise((r) => setTimeout(r, EDIT_FIRST_OPENER_POLL.intervalMs));
  }
  return 'gave-up';
}

/**
 * Merge the server's empathy draft into the cache (setQueryData, never an
 * invalidation): for a realtime AI response while a reopen is in effect — the
 * AI's proposal on another device ends it.
 */
export async function mergeEmpathyDraftFromServer(queryClient: QueryClient, sessionId: string): Promise<void> {
  const fresh = await get<GetEmpathyDraftResponse>(`/sessions/${sessionId}/empathy/draft`);
  queryClient.setQueryData<GetEmpathyDraftResponse>(stageKeys.empathyDraft(sessionId), (old) =>
    old ? { ...old, ...fresh } : fresh
  );
}


/** The device's IANA time zone, when the runtime can tell. */
function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * "Edit first" in the review of a pre-join draft (work-9309). Ends the review
 * (optimistic: the review leaves the cache at once, rolled back on error) and
 * the AI opens the revision conversation: its opener comes back in the
 * response and goes straight into the message caches, then the conversation
 * is refetched — so it shows without Ably and without a reload.
 */
export function useEditPreJoinDraftFirst(
  options?: Omit<
    UseMutationOptions<
      EditPreJoinDraftFirstResponse,
      ApiClientError,
      { sessionId: string },
      { previous: GetEmpathyDraftResponse | undefined }
    >,
    'mutationFn' | 'onMutate' | 'onError' | 'onSuccess'
  >
) {
  const queryClient = useQueryClient();
  // The wait for the opener stops when the screen unmounts or the session changes.
  const sessionRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (sessionRef.current) cancelEditFirstOpenerWait(sessionRef.current);
    },
    []
  );

  return useMutation<
    EditPreJoinDraftFirstResponse,
    ApiClientError,
    { sessionId: string },
    { previous: GetEmpathyDraftResponse | undefined }
  >({
    mutationFn: async ({ sessionId }) => {
      if (sessionRef.current && sessionRef.current !== sessionId) cancelEditFirstOpenerWait(sessionRef.current);
      sessionRef.current = sessionId;
      const timeZone = deviceTimeZone();
      return post<EditPreJoinDraftFirstResponse>(
        `/sessions/${sessionId}/empathy/draft/edit-first`,
        timeZone ? { timeZone } : {}
      );
    },
    onMutate: async ({ sessionId }) => {
      // The review ends and the reopen begins at once: the old draft's
      // Review/Share panel stays hidden until the AI proposes (work-9309,
      // owner decision 2026-11-09). Rolled back on error.
      const key = stageKeys.empathyDraft(sessionId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<GetEmpathyDraftResponse>(key);
      if (previous) {
        queryClient.setQueryData<GetEmpathyDraftResponse>(key, {
          ...previous,
          preJoinReview: null,
          awaitingRevision: true,
        });
      }
      return { previous };
    },
    onError: (_error, { sessionId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(stageKeys.empathyDraft(sessionId), context.previous);
      }
    },
    onSuccess: (data, { sessionId }) => {
      if (!data.resolved || !data.reopenedAt) {
        // No reopen in effect after all: the server's state is the truth.
        queryClient.invalidateQueries({ queryKey: stageKeys.empathyDraft(sessionId) });
        return;
      }
      // The reopen is in effect (the server's marker): the draft stays hidden,
      // nothing here un-hides it.
      if (data.opener) {
        // The opener is already written (a later call): it comes back in the response.
        appendMessageToCaches(queryClient, sessionId, data.opener);
        return;
      }
      // Being generated (the 202, or a later call before it lands): it reaches
      // the chat by Ably (message.ai_response -> refetch) or, without Ably, by
      // this bounded, cancellable refetch until the first AI message at or
      // after reopenedAt is there.
      void awaitEditFirstOpener(queryClient, sessionId, data.reopenedAt);
    },
    ...options,
  });
}

/**
 * Consent to share empathy attempt.
 * Pass draftContent for optimistic UI update (shows empathy message immediately).
 */
/** Context for consent mutation rollback */
interface ConsentToShareContext {
  previousInfinite: InfiniteData<GetMessagesResponse> | undefined;
  previousEmpathyStatus: EmpathyExchangeStatusResponse | undefined;
  previousEmpathyDraft: GetEmpathyDraftResponse | undefined;
}

export function useConsentToShareEmpathy(
  options?: Omit<
    UseMutationOptions<
      ConsentToShareEmpathyResponse,
      ApiClientError,
      { sessionId: string; consent: boolean; draftContent?: string },
      ConsentToShareContext
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Extract callbacks from options to merge with internal handlers
  // This prevents ...options from overwriting our onSuccess/onError
  const {
    onSuccess: externalOnSuccess,
    onError: externalOnError,
    ...restOptions
  } = options ?? {};

  return useMutation<
    ConsentToShareEmpathyResponse,
    ApiClientError,
    { sessionId: string; consent: boolean; draftContent?: string },
    ConsentToShareContext
  >({
    mutationFn: async ({ sessionId, consent }) => {
      console.log('[useConsentToShareEmpathy] mutationFn called', { sessionId, consent });
      try {
        const result = await post<ConsentToShareEmpathyResponse>(
          `/sessions/${sessionId}/empathy/consent`,
          { consent }
        );
        console.log('[useConsentToShareEmpathy] mutationFn success', result);
        return result;
      } catch (error) {
        console.error('[useConsentToShareEmpathy] mutationFn error', error);
        throw error;
      }
    },
    onMutate: async ({ sessionId, draftContent }): Promise<ConsentToShareContext> => {
      console.log('[useConsentToShareEmpathy] onMutate started');

      // Safety Check: Verify messageKeys exists (circular dependency protection)
      if (!messageKeys || !messageKeys.list || !messageKeys.infinite) {
        console.error('[useConsentToShareEmpathy] CRITICAL: messageKeys is undefined due to circular dependency');
        // Return empty context so mutation continues despite optimistic error
        return { previousInfinite: undefined, previousEmpathyStatus: undefined, previousEmpathyDraft: undefined };
      }

      try {
        // Cancel any outgoing refetches to avoid overwriting optimistic update
        await queryClient.cancelQueries({ queryKey: messageKeys.infinite(sessionId) });

        // Snapshot previous state for rollback
        const previousInfinite = queryClient.getQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId));
        const previousEmpathyStatus = queryClient.getQueryData<EmpathyExchangeStatusResponse>(stageKeys.empathyStatus(sessionId));
        const previousEmpathyDraft = queryClient.getQueryData<GetEmpathyDraftResponse>(stageKeys.empathyDraft(sessionId));

        // Only add optimistic message if we have draft content
        if (draftContent) {
          const optimisticMessage = {
            id: `optimistic-empathy-${Date.now()}`,
            sessionId,
            senderId: user?.id ?? null,
            role: MessageRole.EMPATHY_STATEMENT,
            content: draftContent,
            stage: 2,
            timestamp: new Date().toISOString(),
            // Show "Sending..." while waiting for server confirmation
            sharedContentDeliveryStatus: 'sending' as const,
          };

          // Update infinite query cache with proper immutability
          // For inverted lists (newest first), add to the START of the first page
          queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
            messageKeys.infinite(sessionId),
            (old: InfiniteData<GetMessagesResponse> | undefined) => {
              if (!old || !old.pages || old.pages.length === 0) {
                return {
                  pages: [{ messages: [optimisticMessage], hasMore: false }],
                  pageParams: [undefined],
                };
              }

              // Deep clone to ensure immutability
              const newPages = [...old.pages];
              const firstPage = { ...newPages[0] };

              // Add to the END of the messages array (chronological order within page)
              // useUnifiedSession flattens with [...pages].reverse().flatMap() which expects
              // each page's messages in chronological order (oldest to newest)
              firstPage.messages = [...firstPage.messages, optimisticMessage];

              newPages[0] = firstPage;
              return { ...old, pages: newPages };
            }
          );

          // Also update the stage-specific infinite query if it exists
          queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
            messageKeys.infinite(sessionId, 2),
            (old: InfiniteData<GetMessagesResponse> | undefined) => {
              if (!old || !old.pages || old.pages.length === 0) {
                return {
                  pages: [{ messages: [optimisticMessage], hasMore: false }],
                  pageParams: [undefined],
                };
              }

              const newPages = [...old.pages];
              const firstPage = { ...newPages[0] };
              // Add to END for chronological order within page
              firstPage.messages = [...firstPage.messages, optimisticMessage];
              newPages[0] = firstPage;
              return { ...old, pages: newPages };
            }
          );

          console.log('[useConsentToShareEmpathy] Optimistic update applied to infinite query');
        }

        // Immediately hide the empathy draft preview card
        queryClient.setQueryData<GetEmpathyDraftResponse>(
          stageKeys.empathyDraft(sessionId),
          (old) => {
            if (!old) return { draft: null, canConsent: false, alreadyConsented: true };
            return { ...old, canConsent: false, alreadyConsented: true };
          }
        );

        // Optimistically set empathy status to mark that user has shared
        // Only set analyzing: true if partner has already shared their attempt
        // The actual status will be determined by the backend response and refetch
        queryClient.setQueryData<EmpathyExchangeStatusResponse>(
          stageKeys.empathyStatus(sessionId),
          (old) => ({
            // Preserve existing myAttempt or set to null (will be updated by refetch)
            myAttempt: old?.myAttempt ? {
              ...old.myAttempt,
              status: old?.partnerAttempt ? 'ANALYZING' : 'HELD',
            } : null,
            partnerAttempt: old?.partnerAttempt ?? null,
            partnerCompletedStage1: old?.partnerCompletedStage1 ?? false,
            // Only set analyzing: true if partner has already shared their attempt
            analyzing: !!old?.partnerAttempt,
            awaitingSharing: false,
            hasNewSharedContext: false,
            hasUnviewedSharedContext: false,
            sharedContext: old?.sharedContext ?? null,
            mySharedContext: old?.mySharedContext ?? null,
            mySharedAt: old?.mySharedAt ?? null,
            refinementHint: old?.refinementHint ?? null,
            readyForStage3: false,
            messageCountSinceSharedContext: old?.messageCountSinceSharedContext ?? 0,
            sharedContentDeliveryStatus: 'sending', // Show sending status on message
            myReconcilerResult: old?.myReconcilerResult ?? null, // Preserve existing reconciler result
            partnerHasSubmittedEmpathy: old?.partnerHasSubmittedEmpathy ?? false,
            partnerEmpathyHeldStatus: old?.partnerEmpathyHeldStatus ?? null,
            partnerEmpathySubmittedAt: old?.partnerEmpathySubmittedAt ?? null,
          })
        );

        console.log('[useConsentToShareEmpathy] Optimistic updates applied to empathyDraft and empathyStatus');

        return { previousInfinite, previousEmpathyStatus, previousEmpathyDraft };
      } catch (err) {
        console.error('[useConsentToShareEmpathy] Error in onMutate:', err);
        // Return empty context so mutation continues despite optimistic error
        // This ensures the network request still fires even if optimistic update fails
        return { previousInfinite: undefined, previousEmpathyStatus: undefined, previousEmpathyDraft: undefined };
      }
    },
    onSuccess: (data, variables, context) => {
      const { sessionId } = variables;

      queryClient.invalidateQueries({ queryKey: stageKeys.empathyDraft(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.partnerEmpathy(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });

      // Directly update empathy status cache with correct delivery status
      // This immediately clears 'sending' status instead of waiting for refetch
      queryClient.setQueryData<EmpathyExchangeStatusResponse>(
        stageKeys.empathyStatus(sessionId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            sharedContentDeliveryStatus: 'pending', // Clear 'sending' status
            myAttempt: old.myAttempt ? {
              ...old.myAttempt,
              deliveryStatus: 'pending', // Update delivery status
              status: data.status === 'HELD' ? 'HELD' : old.myAttempt.status,
            } : old.myAttempt,
          };
        }
      );
      // Also invalidate to eventually sync with server
      queryClient.invalidateQueries({ queryKey: stageKeys.empathyStatus(sessionId) });

      // Replace optimistic message with real ones and add AI response
      const messagesToAdd: Array<{
        id: string;
        sessionId: string;
        senderId: string | null;
        role: MessageRole;
        content: string;
        stage: number;
        timestamp: string;
        sharedContentDeliveryStatus?: 'pending';
        skipTypewriter?: boolean;
      }> = [];
      if (data.empathyMessage) {
        messagesToAdd.push({
          id: data.empathyMessage.id,
          sessionId,
          senderId: user?.id ?? null,
          role: MessageRole.EMPATHY_STATEMENT,
          content: data.empathyMessage.content,
          stage: data.empathyMessage.stage,
          timestamp: data.empathyMessage.timestamp,
          // Include pending delivery status until empathyStatusData refetch completes
          sharedContentDeliveryStatus: 'pending',
          // Skip animation since this replaces the optimistic message (prevents flicker)
          skipTypewriter: true,
        });
      }
      if (data.transitionMessage) {
        messagesToAdd.push({
          id: data.transitionMessage.id,
          sessionId,
          senderId: null,
          role: MessageRole.AI,
          content: data.transitionMessage.content,
          stage: data.transitionMessage.stage,
          timestamp: data.transitionMessage.timestamp,
        });
      }

      if (messagesToAdd.length > 0) {
        // Update caches, removing optimistic message and adding real ones
        const updateCache = (old: GetMessagesResponse | undefined): GetMessagesResponse => {
          // Handle missing or malformed cache
          if (!old || !old.messages) {
            return { messages: messagesToAdd, hasMore: false };
          }
          // Remove optimistic message, add real messages
          const filteredMessages = old.messages.filter((m) => !m.id.startsWith('optimistic-empathy-'));
          const existingIds = new Set(filteredMessages.map((m) => m.id));
          const newMessages = messagesToAdd.filter((m) => !existingIds.has(m.id));
          return { ...old, messages: [...filteredMessages, ...newMessages] };
        };

        const updateInfiniteCache = (
          old: InfiniteData<GetMessagesResponse> | undefined
        ): InfiniteData<GetMessagesResponse> => {
          if (!old || !old.pages || old.pages.length === 0) {
            return { pages: [{ messages: messagesToAdd, hasMore: false }], pageParams: [undefined] };
          }
          // Deep clone to ensure immutability
          const newPages = [...old.pages];
          const firstPage = { ...newPages[0] };

          // Handle case where firstPage.messages might be undefined
          const existingMessages = firstPage.messages ?? [];

          // Remove optimistic message, add real messages
          // Add to END for chronological order within page (oldest to newest)
          // useUnifiedSession flattens with [...pages].reverse().flatMap()
          const filteredMessages = existingMessages.filter((m) => !m.id.startsWith('optimistic-empathy-'));
          const existingIds = new Set(filteredMessages.map((m) => m.id));
          const newMessages = messagesToAdd.filter((m) => !existingIds.has(m.id));

          // Add new messages to the END (chronological order within page)
          firstPage.messages = [...filteredMessages, ...newMessages];
          newPages[0] = firstPage;

          return { ...old, pages: newPages };
        };

        queryClient.setQueryData<GetMessagesResponse>(messageKeys.list(sessionId), updateCache);
        queryClient.setQueryData<GetMessagesResponse>(messageKeys.list(sessionId, 2), updateCache);
        queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId), updateInfiniteCache);
        queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId, 2), updateInfiniteCache);
      }

      // Invalidate consolidated session state for UI updates
      queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
      // Note: We don't invalidate message queries here because:
      // 1. We already added the real messages to the cache above
      // 2. A refetch would overwrite skipTypewriter flag, causing re-animation flicker
      // If we need to sync with server, a separate polling mechanism can be used

      // Call consumer's onSuccess callback if provided (type cast to work around React Query types)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (externalOnSuccess as any)?.(data, variables, context);
    },
    onError: (err, variables, context) => {
      const { sessionId } = variables;
      // Rollback to previous state on error
      if (context?.previousInfinite) {
        queryClient.setQueryData(messageKeys.infinite(sessionId), context.previousInfinite);
      }
      if (context?.previousEmpathyStatus) {
        queryClient.setQueryData(stageKeys.empathyStatus(sessionId), context.previousEmpathyStatus);
      }
      if (context?.previousEmpathyDraft) {
        queryClient.setQueryData(stageKeys.empathyDraft(sessionId), context.previousEmpathyDraft);
      }
      // Also invalidate to refetch fresh data
      queryClient.invalidateQueries({ queryKey: stageKeys.empathyDraft(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.empathyStatus(sessionId) });

      // Call consumer's onError callback if provided (type cast to work around React Query types)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (externalOnError as any)?.(err, variables, context);
    },
    // Note: Removed onSettled message refetch to prevent overwriting skipTypewriter flag
    // The real messages are added in onSuccess with correct IDs from the server response
    // Use restOptions (without onSuccess/onError) to prevent overwriting our handlers
    ...restOptions,
  });
}

/**
 * Get partner's empathy attempt (after both consented).
 */
export function usePartnerEmpathy(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<GetPartnerEmpathyResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.partnerEmpathy(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetPartnerEmpathyResponse>(`/sessions/${sessionId}/empathy/partner`);
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    ...options,
  });
}

/**
 * Validate partner's empathy attempt.
 */
export function useValidateEmpathy(
  options?: Omit<
    UseMutationOptions<
      ValidateEmpathyResponse,
      ApiClientError,
      ValidateEmpathyRequest,
      {
        previousPartnerEmpathy: GetPartnerEmpathyResponse | undefined;
        previousEmpathyStatus: EmpathyExchangeStatusResponse | undefined;
      }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: ValidateEmpathyRequest) => {
      return post<ValidateEmpathyResponse>(
        `/sessions/${request.sessionId}/empathy/validate`,
        request
      );
    },
    // Optimistic update: immediately mark as validated so the accuracy panel hides
    onMutate: async ({ sessionId, validated }) => {
      await queryClient.cancelQueries({ queryKey: stageKeys.partnerEmpathy(sessionId) });

      const previousPartnerEmpathy = queryClient.getQueryData<GetPartnerEmpathyResponse>(
        stageKeys.partnerEmpathy(sessionId)
      );
      const previousEmpathyStatus = queryClient.getQueryData<EmpathyExchangeStatusResponse>(
        stageKeys.empathyStatus(sessionId)
      );

      // Write optimistic result: set validated and validatedAt immediately
      queryClient.setQueryData<GetPartnerEmpathyResponse>(
        stageKeys.partnerEmpathy(sessionId),
        (old) => old ? {
          ...old,
          validated,
          validatedAt: new Date().toISOString(),
          awaitingRevision: !validated,
        } : old
      );

      if (!validated) {
        queryClient.setQueryData<EmpathyExchangeStatusResponse>(
          stageKeys.empathyStatus(sessionId),
          (old) => old ? {
            ...old,
            partnerAttempt: null,
            partnerHasSubmittedEmpathy: true,
            partnerEmpathyHeldStatus: 'REFINING',
          } : old
        );
      }

      return { previousPartnerEmpathy, previousEmpathyStatus };
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.partnerEmpathy(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.empathyStatus(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.pendingActions(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
      queryClient.refetchQueries({ queryKey: messageKeys.infinite(sessionId) });
      queryClient.refetchQueries({ queryKey: messageKeys.list(sessionId) });
      // When both users validated, the server triggers stage transition async.
      // Delayed refetch ensures we pick up the new stage after the transition commits.
      if (data.canAdvance && data.partnerValidated) {
        setTimeout(() => {
          queryClient.refetchQueries({ queryKey: stageKeys.progress(sessionId) });
          queryClient.refetchQueries({ queryKey: sessionKeys.state(sessionId) });
        }, 2000);
      }
    },
    // Rollback on error: restore previous cache state
    onError: (_error, { sessionId }, context) => {
      if (context?.previousPartnerEmpathy) {
        queryClient.setQueryData(
          stageKeys.partnerEmpathy(sessionId),
          context.previousPartnerEmpathy
        );
      }
      if (context?.previousEmpathyStatus) {
        queryClient.setQueryData(
          stageKeys.empathyStatus(sessionId),
          context.previousEmpathyStatus
        );
      }
    },
    ...options,
  });
}

/**
 * Resubmit empathy statement after refining.
 * Used when user has received shared context from partner and is revising their understanding.
 */
export function useResubmitEmpathy(
  options?: Omit<
    UseMutationOptions<
      ResubmitEmpathyResponse,
      ApiClientError,
      { sessionId: string; content: string },
      { previousInfinite: InfiniteData<GetMessagesResponse> | undefined }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();
  const { user: authUser } = useAuth();

  return useMutation<
    ResubmitEmpathyResponse,
    ApiClientError,
    { sessionId: string; content: string },
    { previousInfinite: InfiniteData<GetMessagesResponse> | undefined }
  >({
    mutationFn: async ({ sessionId, content }) => {
      return post<ResubmitEmpathyResponse>(
        `/sessions/${sessionId}/empathy/resubmit`,
        { content }
      );
    },
    onMutate: async ({ sessionId, content }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: messageKeys.infinite(sessionId) });

      // Snapshot the previous value
      const previousInfinite = queryClient.getQueryData<InfiniteData<GetMessagesResponse>>(
        messageKeys.infinite(sessionId)
      );

      // Optimistically add the new message
      if (previousInfinite) {
        queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
          messageKeys.infinite(sessionId),
          (old) => {
            if (!old) return old;

            const optimisticMessage: {
              id: string;
              sessionId: string;
              senderId: string | null;
              role: MessageRole;
              content: string;
              stage: number;
              timestamp: string;
              sharedContentDeliveryStatus: 'sending';
            } = {
              id: `optimistic-resubmit-${Date.now()}`,
              sessionId,
              senderId: authUser?.id ?? null,
              role: MessageRole.EMPATHY_STATEMENT,
              content,
              stage: 2,
              timestamp: new Date().toISOString(),
              // Show "Sending..." while waiting for server confirmation
              sharedContentDeliveryStatus: 'sending',
            };

            // Add to the last page
            const newPages = [...old.pages];
            const lastPageIndex = newPages.length - 1;
            if (lastPageIndex >= 0) {
              newPages[lastPageIndex] = {
                ...newPages[lastPageIndex],
                messages: [...newPages[lastPageIndex].messages, optimisticMessage],
              };
            }

            return { ...old, pages: newPages };
          }
        );
      }

      return { previousInfinite };
    },
    onSuccess: (data, { sessionId }) => {
      // Build the server message with proper typing
      const serverMessage: {
        id: string;
        sessionId: string;
        senderId: string | null;
        role: MessageRole;
        content: string;
        stage: number;
        timestamp: string;
        sharedContentDeliveryStatus: 'pending';
        skipTypewriter: boolean;
      } = {
        id: data.empathyMessage.id,
        sessionId,
        senderId: authUser?.id ?? null,
        role: MessageRole.EMPATHY_STATEMENT,
        content: data.empathyMessage.content,
        stage: data.empathyMessage.stage,
        timestamp: data.empathyMessage.timestamp,
        // Include pending delivery status until empathyStatusData refetch completes
        sharedContentDeliveryStatus: 'pending',
        // Skip animation since this replaces the optimistic message (prevents flicker)
        skipTypewriter: true,
      };

      // Update the message with the server response and add transition message if present
      queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
        messageKeys.infinite(sessionId),
        (old) => {
          if (!old) return old;

          // Replace optimistic message with server message
          let newPages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((msg) =>
              msg.id.startsWith('optimistic-resubmit-') ? serverMessage : msg
            ),
          }));

          // Add transition message if present
          if (data.transitionMessage) {
            const transitionMsg = {
              id: data.transitionMessage.id,
              sessionId,
              senderId: null,
              role: MessageRole.AI,
              content: data.transitionMessage.content,
              stage: data.transitionMessage.stage,
              timestamp: data.transitionMessage.timestamp,
            };

            // Add to the first page (most recent messages)
            if (newPages.length > 0) {
              const existingIds = new Set(newPages[0].messages.map((m) => m.id));
              if (!existingIds.has(transitionMsg.id)) {
                newPages = [
                  {
                    ...newPages[0],
                    messages: [...newPages[0].messages, transitionMsg],
                  },
                  ...newPages.slice(1),
                ];
              }
            }
          }

          return { ...old, pages: newPages };
        }
      );

      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: stageKeys.empathyDraft(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.empathyStatus(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.pendingActions(sessionId) });
    },
    onError: (_err, { sessionId }, context) => {
      // Rollback to previous state on error
      if (context?.previousInfinite) {
        queryClient.setQueryData(messageKeys.infinite(sessionId), context.previousInfinite);
      }
    },
    ...options,
  });
}

/**
 * Skip refinement (Acceptance Check).
 */
export function useSkipRefinement(
  options?: Omit<
    UseMutationOptions<
      SkipRefinementResponse,
      ApiClientError,
      { sessionId: string } & SkipRefinementRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, ...request }) => {
      return post<SkipRefinementResponse>(
        `/sessions/${sessionId}/empathy/skip-refinement`,
        request
      );
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.empathyStatus(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.pendingActions(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
    },
    ...options,
  });
}

/**
 * Save validation feedback draft.
 */
export function useSaveValidationFeedbackDraft(
  options?: Omit<
    UseMutationOptions<
      SaveValidationFeedbackDraftResponse,
      ApiClientError,
      { sessionId: string } & SaveValidationFeedbackDraftRequest
    >,
    'mutationFn'
  >
) {
  return useMutation({
    mutationFn: async ({ sessionId, ...request }) => {
      return post<SaveValidationFeedbackDraftResponse>(
        `/sessions/${sessionId}/empathy/validation-feedback/draft`,
        request
      );
    },
    ...options,
  });
}

/**
 * Refine validation feedback (AI Coach).
 */
export function useRefineValidationFeedback(
  options?: Omit<
    UseMutationOptions<
      RefineValidationFeedbackResponse,
      ApiClientError,
      { sessionId: string } & RefineValidationFeedbackRequest
    >,
    'mutationFn'
  >
) {
  return useMutation({
    mutationFn: async ({ sessionId, ...request }) => {
      return post<RefineValidationFeedbackResponse>(
        `/sessions/${sessionId}/empathy/validation-feedback/refine`,
        request
      );
    },
    ...options,
  });
}

// ============================================================================
// Stage 3: Need Mapping
// ============================================================================

/**
 * Get captured needs for the current user.
 */
export function useNeeds(
  sessionId: string | undefined,
  options?: Omit<UseQueryOptions<GetNeedsResponse, ApiClientError>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: stageKeys.needs(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetNeedsResponse>(`/sessions/${sessionId}/needs`);
    },
    enabled: !!sessionId,
    staleTime: 30_000, // Ably need.* events keep this cache fresh with setQueryData.
    ...options,
  });
}

/**
 * Capture the user's final needs list from the Stage 3 conversation.
 */
export function useCaptureNeeds(
  options?: Omit<
    UseMutationOptions<
      CaptureNeedsResponse,
      ApiClientError,
      { sessionId: string } & CaptureNeedsRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, needs }) => {
      return post<CaptureNeedsResponse>(`/sessions/${sessionId}/needs/capture`, {
        needs,
      });
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.needsComparison(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
    },
    ...options,
  });
}

/**
 * Confirm or adjust identified needs.
 */
export function useConfirmNeeds(
  options?: Omit<
    UseMutationOptions<
      ConfirmNeedsResponse,
      ApiClientError,
      { sessionId: string; needIds: string[]; adjustments?: NeedAdjustment[] },
      { previousNeeds: GetNeedsResponse | undefined }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, needIds, adjustments }) => {
      return post<ConfirmNeedsResponse>(`/sessions/${sessionId}/needs/confirm`, {
        needIds,
        adjustments,
      });
    },
    onMutate: async ({ sessionId, needIds }) => {
      await queryClient.cancelQueries({ queryKey: stageKeys.needs(sessionId) });
      const previousNeeds = queryClient.getQueryData<GetNeedsResponse>(
        stageKeys.needs(sessionId),
      );
      queryClient.setQueryData<GetNeedsResponse>(
        stageKeys.needs(sessionId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            needs: old.needs.map((n) =>
              needIds.includes(n.id) ? { ...n, confirmed: true } : n,
            ),
          };
        },
      );
      return { previousNeeds };
    },
    onError: (_err, { sessionId }, context) => {
      if (context?.previousNeeds) {
        queryClient.setQueryData(stageKeys.needs(sessionId), context.previousNeeds);
      }
    },
    onSuccess: (_, { sessionId }) => {
      const confirmedAt = new Date().toISOString();
      patchMyMilestones(queryClient, sessionId, { needs_confirmed: confirmedAt });
      queryClient.setQueryData<GetNeedsResponse>(stageKeys.needs(sessionId), (old) => {
        if (!old) return old;
        return {
          ...old,
          needs: old.needs.map((need) =>
            need.deletedAt || need.supersededByNeedId
              ? need
              : { ...need, confirmed: true, lockedAt: need.lockedAt ?? confirmedAt }
          ),
        };
      });
      queryClient.invalidateQueries({ queryKey: stageKeys.needsComparison(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.needs(sessionId) });
    },
    ...options,
  });
}

/**
 * Add a custom need.
 */
export function useAddNeed(
  options?: Omit<
    UseMutationOptions<
      AddNeedResponse,
      ApiClientError,
      { sessionId: string } & AddNeedRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, need, category, description }) => {
      return post<AddNeedResponse>(`/sessions/${sessionId}/needs`, {
        need,
        category,
        description,
      });
    },
    onSuccess: (data, { sessionId }) => {
      patchNeedsCacheWithNeed(queryClient, sessionId, data.need);
    },
    ...options,
  });
}

export function useInterpretNeedEdit(
  options?: Omit<
    UseMutationOptions<
      InterpretNeedEditResponse,
      ApiClientError,
      { sessionId: string } & InterpretNeedEditRequest
    >,
    'mutationFn'
  >
) {
  return useMutation({
    mutationFn: async ({ sessionId, request, targetNeedId, conversationHistory }) => {
      return post<InterpretNeedEditResponse>(`/sessions/${sessionId}/needs/interpret-edit-request`, {
        request,
        targetNeedId,
        conversationHistory,
      });
    },
    ...options,
  });
}

export function useApplyNeedEdits(
  options?: Omit<
    UseMutationOptions<
      ApplyNeedEditsResponse,
      ApiClientError,
      { sessionId: string } & ApplyNeedEditsRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();
  const userOnSuccess = options?.onSuccess;

  return useMutation({
    mutationFn: async ({ sessionId, operations }) => {
      return post<ApplyNeedEditsResponse>(`/sessions/${sessionId}/needs/apply-edits`, {
        operations,
      });
    },
    ...options,
    onSuccess: (data, variables, context) => {
      queryClient.setQueryData<GetNeedsResponse>(stageKeys.needs(variables.sessionId), (old) => {
        if (!old) return old;
        return {
          ...old,
          needs: data.needs,
          synthesizedAt: old.synthesizedAt ?? new Date().toISOString(),
        };
      });
      userOnSuccess?.(data, variables, context, undefined as never);
    },
  });
}

export function useRemoveNeed(
  options?: Omit<
    UseMutationOptions<
      DeleteNeedResponse,
      ApiClientError,
      { sessionId: string; needId: string }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();
  const userOnSuccess = options?.onSuccess;

  return useMutation({
    mutationFn: async ({ sessionId, needId }) => {
      return del<DeleteNeedResponse>(`/sessions/${sessionId}/needs/${needId}`);
    },
    ...options,
    onSuccess: (data, variables, context) => {
      queryClient.setQueryData<GetNeedsResponse>(stageKeys.needs(variables.sessionId), (old) => {
        if (!old) return old;
        if (data.need) {
          return {
            ...old,
            needs: old.needs.map((need) => (need.id === data.needId ? data.need! : need)),
          };
        }
        return old;
      });
      userOnSuccess?.(data, variables, context, undefined as never);
    },
  });
}

/**
 * Consent to reveal confirmed needs to the partner.
 */
export function useConsentShareNeeds(
  options?: Omit<
    UseMutationOptions<
      ConsentShareNeedsResponse,
      ApiClientError,
      { sessionId: string; needIds: string[] }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, needIds }) => {
      return post<ConsentShareNeedsResponse>(`/sessions/${sessionId}/needs/consent`, {
        needIds,
      });
    },
    onSuccess: (data, { sessionId }) => {
      // "I shared" is GetNeedsResponse.sharedAt (need_share). needs_shared is
      // session-scoped — the server writes it for everyone once ALL have
      // shared (data.needsRevealReady) — so it is written here only then.
      queryClient.setQueryData<GetNeedsResponse>(stageKeys.needs(sessionId), (old) =>
        old ? { ...old, sharedAt: old.sharedAt ?? data.sharedAt } : old
      );
      if (data.needsRevealReady) {
        patchMyMilestones(queryClient, sessionId, { needs_shared: data.sharedAt });
      }
      queryClient.invalidateQueries({ queryKey: stageKeys.needs(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.needsComparison(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
    },
    ...options,
  });
}

/**
 * Get needs comparison (side-by-side view of both users' needs).
 *
 * Only available after both users have shared their needs.
 */
export function useNeedsComparison(
  sessionId: string | undefined,
  enabled: boolean = false
) {
  return useQuery({
    queryKey: stageKeys.needsComparison(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetNeedsComparisonResponse>(
        `/sessions/${sessionId}/needs/comparison`
      );
    },
    enabled: !!sessionId && enabled,
    staleTime: 0,
  });
}

/**
 * Validate both revealed needs lists.
 */
export function useValidateNeeds(
  options?: Omit<
    UseMutationOptions<
      ValidateNeedsResponse,
      ApiClientError,
      { sessionId: string; validated: boolean }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, validated }) => {
      return post<ValidateNeedsResponse>(
        `/sessions/${sessionId}/needs/validate`,
        { validated }
      );
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.needs(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
    },
    ...options,
  });
}

// ============================================================================
// Stage 4: Strategic Repair
// ============================================================================

/**
 * Get strategies for the session.
 */
export function useStrategies(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<GetStrategiesResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.strategies(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetStrategiesResponse>(`/sessions/${sessionId}/strategies`);
    },
    enabled: !!sessionId,
    staleTime: 0,
    ...options,
  });
}

/**
 * Propose a new strategy.
 */
export function useProposeStrategy(
  options?: Omit<
    UseMutationOptions<
      ProposeStrategyResponse,
      ApiClientError,
      { sessionId: string } & ProposeStrategyRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      description,
      needsAddressed,
      duration,
      measureOfSuccess,
    }) => {
      return post<ProposeStrategyResponse>(`/sessions/${sessionId}/strategies`, {
        description,
        needsAddressed,
        duration,
        measureOfSuccess,
      });
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.strategies(sessionId) });
    },
    ...options,
  });
}

/**
 * Request AI strategy suggestions.
 */
export function useRequestStrategySuggestions(
  options?: Omit<
    UseMutationOptions<
      { suggestions: StrategyDTO[]; source: 'AI_GENERATED' },
      ApiClientError,
      { sessionId: string; count?: number; focusNeeds?: string[]; needId?: string }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, count, focusNeeds, needId }) => {
      return post<{ suggestions: StrategyDTO[]; source: 'AI_GENERATED' }>(
        `/sessions/${sessionId}/stage4/proposals/suggest`,
        { count, focusNeeds, needId }
      );
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.strategies(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.stage4(sessionId) });
    },
    ...options,
  });
}

/**
 * Mark ready to rank strategies.
 */
export function useMarkReadyToRank(
  options?: Omit<
    UseMutationOptions<
      MarkReadyResponse,
      ApiClientError,
      { sessionId: string },
      {
        previousStrategies: GetStrategiesResponse | undefined;
      }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }) => {
      return post<MarkReadyResponse>(`/sessions/${sessionId}/strategies/ready`);
    },
    onMutate: async ({ sessionId }) => {
      await queryClient.cancelQueries({ queryKey: stageKeys.strategies(sessionId) });

      const previousStrategies = queryClient.getQueryData<GetStrategiesResponse>(
        stageKeys.strategies(sessionId)
      );

      queryClient.setQueryData<GetStrategiesResponse>(
        stageKeys.strategies(sessionId),
        (old) => old
          ? { ...old, myReadyToRank: true }
          : old
      );
      return { previousStrategies };
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<GetStrategiesResponse>(
        stageKeys.strategies(sessionId),
        (old) => old
          ? {
              ...old,
              myReadyToRank: true,
              partnerReadyToRank: data.partnerReady,
              phase: data.canStartRanking ? StrategyPhase.RANKING : old.phase,
              canMarkReadyToRank: false,
              canRank: data.canStartRanking,
            }
          : old
      );
      queryClient.invalidateQueries({ queryKey: stageKeys.strategies(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
    },
    onError: (_error, { sessionId }, context) => {
      if (context?.previousStrategies) {
        queryClient.setQueryData(stageKeys.strategies(sessionId), context.previousStrategies);
      }
    },
    ...options,
  });
}

/**
 * Submit strategy rankings.
 */
export function useSubmitRankings(
  options?: Omit<
    UseMutationOptions<
      SubmitRankingResponse,
      ApiClientError,
      { sessionId: string; rankedIds: string[] },
      {
        previousStrategies: GetStrategiesResponse | undefined;
      }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, rankedIds }) => {
      return post<SubmitRankingResponse>(`/sessions/${sessionId}/strategies/rank`, {
        rankedIds,
      });
    },
    onMutate: async ({ sessionId }) => {
      await queryClient.cancelQueries({ queryKey: stageKeys.strategies(sessionId) });

      const previousStrategies = queryClient.getQueryData<GetStrategiesResponse>(
        stageKeys.strategies(sessionId)
      );

      queryClient.setQueryData<GetStrategiesResponse>(
        stageKeys.strategies(sessionId),
        (old) => old
          ? { ...old, phase: StrategyPhase.REVEALING }
          : old
      );
      return { previousStrategies };
    },
    onSuccess: (data, { sessionId }) => {
      const canReveal =
        (data as SubmitRankingResponse & { canReveal?: boolean }).canReveal ??
        (data as SubmitRankingResponse & { awaitingReveal?: boolean }).awaitingReveal ??
        false;
      queryClient.setQueryData<GetStrategiesResponse>(
        stageKeys.strategies(sessionId),
        (old) => old
          ? { ...old, phase: canReveal ? StrategyPhase.REVEALING : old.phase }
          : old
      );
      queryClient.refetchQueries({ queryKey: stageKeys.strategies(sessionId) });
      queryClient.refetchQueries({ queryKey: stageKeys.strategiesReveal(sessionId) });
      queryClient.refetchQueries({ queryKey: stageKeys.progress(sessionId) });
    },
    onError: (_error, { sessionId }, context) => {
      if (context?.previousStrategies) {
        queryClient.setQueryData(stageKeys.strategies(sessionId), context.previousStrategies);
      }
    },
    ...options,
  });
}

/**
 * Get strategy reveal (overlap after both ranked).
 */
export function useStrategiesReveal(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<RevealOverlapResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.strategiesReveal(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<RevealOverlapResponse>(`/sessions/${sessionId}/strategies/overlap`);
    },
    enabled: !!sessionId,
    staleTime: 0,
    ...options,
  });
}

// ============================================================================
// Redesigned Stage 4
// ============================================================================

/**
 * Get redesigned Stage 4 state: inventory, coverage, selections, outcome, and Tending preview.
 */
export function useStage4State(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<GetStage4StateResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.stage4(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetStage4StateResponse>(`/sessions/${sessionId}/stage4`);
    },
    enabled: !!sessionId,
    staleTime: 0,
    ...options,
  });
}

function refreshStage4Caches(queryClient: ReturnType<typeof useQueryClient>, sessionId: string) {
  queryClient.refetchQueries({ queryKey: stageKeys.strategies(sessionId) });
  queryClient.refetchQueries({ queryKey: stageKeys.strategiesReveal(sessionId) });
  queryClient.refetchQueries({ queryKey: stageKeys.agreements(sessionId) });
  queryClient.refetchQueries({ queryKey: stageKeys.progress(sessionId) });
  queryClient.refetchQueries({ queryKey: sessionKeys.state(sessionId) });
}

/**
 * Submit willingness for a single redesigned Stage 4 proposal.
 */
export function useSubmitStage4ProposalSelection(
  options?: Omit<
    UseMutationOptions<
      SubmitStage4SelectionsResponse,
      ApiClientError,
      { sessionId: string; proposalId: string } & SubmitStage4SelectionRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation<
    SubmitStage4SelectionsResponse,
    ApiClientError,
    { sessionId: string; proposalId: string } & SubmitStage4SelectionRequest,
    { previous: GetStage4StateResponse | undefined }
  >({
    ...options,
    mutationFn: async ({ sessionId, proposalId, ...request }) => {
      return post<SubmitStage4SelectionsResponse, SubmitStage4SelectionRequest>(
        `/sessions/${sessionId}/stage4/proposals/${proposalId}/selection`,
        request
      );
    },
    onMutate: async ({ sessionId, proposalId, decision }) => {
      const key = stageKeys.stage4(sessionId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<GetStage4StateResponse>(key);
      if (previous) {
        const patchProposal = <T extends { id: string; myDecision?: Stage4SelectionDecision }>(p: T): T =>
          p.id === proposalId ? { ...p, myDecision: decision } : p;
        queryClient.setQueryData<GetStage4StateResponse>(key, {
          ...previous,
          // Changing a stance after sharing pulls the share back so the
          // partner never sees a stale value. Match the backend behavior.
          mySelectionStatus: 'NOT_STARTED',
          inventory: {
            ...previous.inventory,
            sharedProposals: previous.inventory.sharedProposals.map(patchProposal),
            individualCommitments: previous.inventory.individualCommitments.map(patchProposal),
          },
        });
      }
      return { previous };
    },
    onError: (_err, { sessionId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(stageKeys.stage4(sessionId), context.previous);
      }
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData(stageKeys.stage4(sessionId), data.state);
      refreshStage4Caches(queryClient, sessionId);
    },
  });
}

/**
 * Submit willingness for multiple redesigned Stage 4 proposals.
 */
export function useSubmitStage4Selections(
  options?: Omit<
    UseMutationOptions<
      SubmitStage4SelectionsResponse,
      ApiClientError,
      { sessionId: string } & SubmitStage4SelectionsRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, selections }) => {
      return post<SubmitStage4SelectionsResponse, SubmitStage4SelectionsRequest>(
        `/sessions/${sessionId}/stage4/selections`,
        { selections }
      );
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData(stageKeys.stage4(sessionId), data.state);
      refreshStage4Caches(queryClient, sessionId);
    },
    ...options,
  });
}

export function useUpdateStage4WalkthroughNeed() {
  const queryClient = useQueryClient();
  return useMutation<
    { state: GetStage4StateResponse },
    ApiClientError,
    { sessionId: string; needId: string; action: 'covered' | 'skip' | 'reset' },
    { previous: GetStage4StateResponse | undefined }
  >({
    mutationFn: async ({ sessionId, needId, action }) =>
      post<{ state: GetStage4StateResponse }, { action: 'covered' | 'skip' | 'reset' }>(
        `/sessions/${sessionId}/stage4/walkthrough/needs/${needId}`,
        { action }
      ),
    onMutate: async ({ sessionId }) => {
      const key = stageKeys.stage4(sessionId);
      await queryClient.cancelQueries({ queryKey: key });
      return { previous: queryClient.getQueryData<GetStage4StateResponse>(key) };
    },
    onError: (_err, { sessionId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(stageKeys.stage4(sessionId), context.previous);
      }
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData(stageKeys.stage4(sessionId), data.state);
      refreshStage4Caches(queryClient, sessionId);
    },
  });
}

/**
 * Share the current user's Stage 4 selections with their partner.
 * Requires every active proposal to have a stance.
 */
export function useShareStage4Selections() {
  const queryClient = useQueryClient();
  return useMutation<
    { state: GetStage4StateResponse },
    ApiClientError,
    { sessionId: string },
    { previous: GetStage4StateResponse | undefined }
  >({
    mutationFn: async ({ sessionId }) =>
      post<{ state: GetStage4StateResponse }, Record<string, never>>(
        `/sessions/${sessionId}/stage4/share-selections`,
        {} as Record<string, never>
      ),
    onMutate: async ({ sessionId }) => {
      const key = stageKeys.stage4(sessionId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<GetStage4StateResponse>(key);
      if (previous) {
        queryClient.setQueryData<GetStage4StateResponse>(key, {
          ...previous,
          mySelectionStatus: 'SUBMITTED',
        });
      }
      return { previous };
    },
    onError: (_err, { sessionId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(stageKeys.stage4(sessionId), context.previous);
      }
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData(stageKeys.stage4(sessionId), data.state);
      refreshStage4Caches(queryClient, sessionId);
    },
  });
}

/**
 * Withdraw the current user's shared Stage 4 selections so they can revise.
 */
export function useUnshareStage4Selections() {
  const queryClient = useQueryClient();
  return useMutation<
    { state: GetStage4StateResponse },
    ApiClientError,
    { sessionId: string },
    { previous: GetStage4StateResponse | undefined }
  >({
    mutationFn: async ({ sessionId }) =>
      post<{ state: GetStage4StateResponse }, Record<string, never>>(
        `/sessions/${sessionId}/stage4/unshare-selections`,
        {} as Record<string, never>
      ),
    onMutate: async ({ sessionId }) => {
      const key = stageKeys.stage4(sessionId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<GetStage4StateResponse>(key);
      if (previous) {
        queryClient.setQueryData<GetStage4StateResponse>(key, {
          ...previous,
          mySelectionStatus: 'NOT_STARTED',
        });
      }
      return { previous };
    },
    onError: (_err, { sessionId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(stageKeys.stage4(sessionId), context.previous);
      }
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData(stageKeys.stage4(sessionId), data.state);
      refreshStage4Caches(queryClient, sessionId);
    },
  });
}

/**
 * Mark a Stage 4 need as "leave for now" — explicit declination to address it.
 */
export function useDeclineStage4Need() {
  const queryClient = useQueryClient();
  return useMutation<
    { state: GetStage4StateResponse },
    ApiClientError,
    { sessionId: string; needId: string },
    { previous: GetStage4StateResponse | undefined }
  >({
    mutationFn: async ({ sessionId, needId }) =>
      post<{ state: GetStage4StateResponse }, Record<string, never>>(
        `/sessions/${sessionId}/stage4/needs/${needId}/decline`,
        {} as Record<string, never>
      ),
    onMutate: async ({ sessionId, needId }) => {
      const key = stageKeys.stage4(sessionId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<GetStage4StateResponse>(key);
      if (previous) {
        const mark = (rows: typeof previous.coverageAudit.open) =>
          rows.map((row) =>
            row.id === needId ? { ...row, userDeclinedToAddress: true } : row
          );
        queryClient.setQueryData<GetStage4StateResponse>(key, {
          ...previous,
          coverageAudit: {
            ...previous.coverageAudit,
            open: mark(previous.coverageAudit.open),
            partial: mark(previous.coverageAudit.partial),
          },
        });
      }
      return { previous };
    },
    onError: (_err, { sessionId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(stageKeys.stage4(sessionId), context.previous);
      }
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData(stageKeys.stage4(sessionId), data.state);
      refreshStage4Caches(queryClient, sessionId);
    },
  });
}

/**
 * Remove a "leave for now" declination — user changed their mind.
 */
export function useUndeclineStage4Need() {
  const queryClient = useQueryClient();
  return useMutation<
    { state: GetStage4StateResponse },
    ApiClientError,
    { sessionId: string; needId: string },
    { previous: GetStage4StateResponse | undefined }
  >({
    mutationFn: async ({ sessionId, needId }) =>
      del<{ state: GetStage4StateResponse }>(
        `/sessions/${sessionId}/stage4/needs/${needId}/decline`
      ),
    onMutate: async ({ sessionId, needId }) => {
      const key = stageKeys.stage4(sessionId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<GetStage4StateResponse>(key);
      if (previous) {
        const unmark = (rows: typeof previous.coverageAudit.open) =>
          rows.map((row) =>
            row.id === needId ? { ...row, userDeclinedToAddress: false } : row
          );
        queryClient.setQueryData<GetStage4StateResponse>(key, {
          ...previous,
          coverageAudit: {
            ...previous.coverageAudit,
            open: unmark(previous.coverageAudit.open),
            partial: unmark(previous.coverageAudit.partial),
          },
        });
      }
      return { previous };
    },
    onError: (_err, { sessionId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(stageKeys.stage4(sessionId), context.previous);
      }
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData(stageKeys.stage4(sessionId), data.state);
      refreshStage4Caches(queryClient, sessionId);
    },
  });
}

/**
 * Close redesigned Stage 4 with either shared agreements or no shared agreement.
 */
export function useCloseStage4(
  options?: Omit<
    UseMutationOptions<
      CloseStage4Response,
      ApiClientError,
      { sessionId: string } & CloseStage4Request
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, ...request }) => {
      return post<CloseStage4Response, CloseStage4Request>(
        `/sessions/${sessionId}/stage4/close`,
        request
      );
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData(stageKeys.stage4(sessionId), data.state);
      queryClient.setQueryData(stageKeys.agreements(sessionId), {
        agreements: data.outcome.agreements,
      });
      refreshStage4Caches(queryClient, sessionId);
    },
    ...options,
  });
}

// ============================================================================
// Tending
// ============================================================================

/**
 * Get scheduled check-ins and passive re-entry entries for a session.
 */
export function useTendingEntries(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<GetTendingEntriesResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.tending(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetTendingEntriesResponse>(`/sessions/${sessionId}/tending`);
    },
    enabled: !!sessionId,
    staleTime: 0,
    ...options,
  });
}

export function useTendingHistory(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<GetTendingHistoryResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: [...stageKeys.tending(sessionId || ''), 'history'] as const,
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<GetTendingHistoryResponse>(`/sessions/${sessionId}/tending/history`);
    },
    enabled: !!sessionId,
    staleTime: 0,
    ...options,
  });
}

/**
 * Submit the current user's review for an open Tending entry.
 */
export function useSubmitTendingResponse(
  options?: Omit<
    UseMutationOptions<
      SubmitTendingResponseResponse,
      ApiClientError,
      { sessionId: string; entryId: string } & SubmitTendingResponseRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, entryId, ...request }) => {
      return post<SubmitTendingResponseResponse, SubmitTendingResponseRequest>(
        `/sessions/${sessionId}/tending/${entryId}/responses`,
        request
      );
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<GetTendingEntriesResponse>(
        stageKeys.tending(sessionId),
        (old) => {
          const existing = old?.entries ?? [];
          const withoutUpdated = existing.filter((entry) => entry.id !== data.entry.id);
          return {
            entries: [data.entry, ...withoutUpdated],
            coordinationCycles: old?.coordinationCycles,
            betweenPeriodNotes: old?.betweenPeriodNotes,
          };
        }
      );
      queryClient.refetchQueries({ queryKey: [...stageKeys.tending(sessionId), 'history'] });
    },
    ...options,
  });
}

/**
 * Stage 4 Phase 5 — submit the three-orientation Tending check-in covering all
 * open entries on a session.
 */
export function useSubmitTendingCheckin(
  options?: Omit<
    UseMutationOptions<
      SubmitTendingCheckinResponse,
      ApiClientError,
      { sessionId: string } & SubmitTendingCheckinRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, ...request }) => {
      return post<SubmitTendingCheckinResponse, SubmitTendingCheckinRequest>(
        `/sessions/${sessionId}/tending/checkin`,
        request
      );
    },
    onSuccess: (_data, { sessionId }) => {
      queryClient.refetchQueries({ queryKey: stageKeys.tending(sessionId) });
      queryClient.refetchQueries({ queryKey: [...stageKeys.tending(sessionId), 'history'] });
      queryClient.refetchQueries({ queryKey: stageKeys.stage4(sessionId) });
    },
    ...options,
  });
}

/**
 * Add a private between-period note that can optionally be carried into check-in later.
 */
export function useCreateTendingBetweenPeriodNote(
  options?: Omit<
    UseMutationOptions<
      CreateTendingBetweenPeriodNoteResponse,
      ApiClientError,
      { sessionId: string } & CreateTendingBetweenPeriodNoteRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, ...request }) => {
      return post<CreateTendingBetweenPeriodNoteResponse, CreateTendingBetweenPeriodNoteRequest>(
        `/sessions/${sessionId}/tending/notes`,
        request
      );
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<GetTendingEntriesResponse>(
        stageKeys.tending(sessionId),
        (old) => ({
          entries: old?.entries ?? [],
          coordinationCycles: old?.coordinationCycles,
          betweenPeriodNotes: [...(old?.betweenPeriodNotes ?? []), data.note],
        })
      );
    },
    ...options,
  });
}

/**
 * Toggle an INDIVIDUAL Tending entry's opt-in share with the partner.
 */
export function useSetTendingEntryShare(
  options?: Omit<
    UseMutationOptions<
      SubmitTendingResponseResponse,
      ApiClientError,
      { sessionId: string; entryId: string; optedInShared: boolean }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, entryId, optedInShared }) => {
      const suffix = optedInShared ? 'share' : 'unshare';
      return post<SubmitTendingResponseResponse, Record<string, never>>(
        `/sessions/${sessionId}/tending/${entryId}/${suffix}`,
        {}
      );
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<GetTendingEntriesResponse>(
        stageKeys.tending(sessionId),
        (old) => {
          const existing = old?.entries ?? [];
          const next = existing.map((entry) =>
            entry.id === data.entry.id ? data.entry : entry
          );
          return {
            entries: next,
            coordinationCycles: old?.coordinationCycles,
            betweenPeriodNotes: old?.betweenPeriodNotes,
          };
        }
      );
    },
    ...options,
  });
}

/**
 * Start a passive Tending re-entry from a resolved session.
 */
export function useCreateTendingReentry(
  options?: Omit<
    UseMutationOptions<
      CreateTendingReentryResponse,
      ApiClientError,
      { sessionId: string } & CreateTendingReentryRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, ...request }) => {
      return post<CreateTendingReentryResponse, CreateTendingReentryRequest>(
        `/sessions/${sessionId}/tending/reentry`,
        request
      );
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<GetTendingEntriesResponse>(
        stageKeys.tending(sessionId),
        (old) => {
          const existing = old?.entries ?? [];
          const withoutCreated = existing.filter((entry) => entry.id !== data.entry.id);
          return {
            entries: [data.entry, ...withoutCreated],
            coordinationCycles: old?.coordinationCycles,
            betweenPeriodNotes: old?.betweenPeriodNotes,
          };
        }
      );
      queryClient.refetchQueries({ queryKey: stageKeys.tending(sessionId) });
      queryClient.refetchQueries({ queryKey: stageKeys.stage4(sessionId) });
    },
    ...options,
  });
}

// ============================================================================
// Agreements
// ============================================================================

/**
 * Get agreements for the session.
 */
export function useAgreements(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<{ agreements: AgreementDTO[] }, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: stageKeys.agreements(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<{ agreements: AgreementDTO[] }>(`/sessions/${sessionId}/agreements`);
    },
    enabled: !!sessionId,
    staleTime: 0,
    ...options,
  });
}

/**
 * Create an agreement.
 */
export function useCreateAgreement(
  options?: Omit<
    UseMutationOptions<
      CreateAgreementResponse,
      ApiClientError,
      { sessionId: string } & CreateAgreementRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, ...request }) => {
      return post<CreateAgreementResponse>(
        `/sessions/${sessionId}/agreements`,
        request
      );
    },
    onSuccess: (data, { sessionId, strategyId }) => {
      queryClient.setQueryData<{ agreements: AgreementDTO[] }>(
        stageKeys.agreements(sessionId),
        (old) => {
          const existing = old?.agreements ?? [];
          const agreement = {
            ...data.agreement,
            strategyId: data.agreement.strategyId ?? strategyId ?? null,
          };
          const withoutDuplicate = existing.filter((a) => a.id !== agreement.id);
          return { agreements: [...withoutDuplicate, agreement] };
        }
      );
      queryClient.setQueryData<GetStrategiesResponse>(
        stageKeys.strategies(sessionId),
        (old) => old
          ? { ...old, phase: StrategyPhase.NEGOTIATING }
          : old
      );
      queryClient.refetchQueries({ queryKey: stageKeys.agreements(sessionId) });
      queryClient.refetchQueries({ queryKey: stageKeys.strategies(sessionId) });
      queryClient.refetchQueries({ queryKey: stageKeys.strategiesReveal(sessionId) });
      queryClient.refetchQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.refetchQueries({ queryKey: sessionKeys.state(sessionId) });
    },
    ...options,
  });
}

/**
 * Confirm an agreement.
 */
export function useConfirmAgreement(
  options?: Omit<
    UseMutationOptions<
      ConfirmAgreementResponse,
      ApiClientError,
      { sessionId: string; agreementId: string; confirmed: boolean; modification?: string }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, agreementId, confirmed, modification }) => {
      return post<ConfirmAgreementResponse>(
        `/sessions/${sessionId}/agreements/${agreementId}/confirm`,
        { confirmed, modification }
      );
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.agreements(sessionId) });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
    },
    ...options,
  });
}

/**
 * Resolve the session (complete Stage 4).
 */
export function useResolveSession(
  options?: Omit<
    UseMutationOptions<ResolveSessionResponse, ApiClientError, { sessionId: string }>,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }) => {
      return post<ResolveSessionResponse>(`/sessions/${sessionId}/resolve`);
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
    },
    ...options,
  });
}

// ============================================================================
// Stage Advancement
// ============================================================================

/**
 * Response type for advance stage API.
 * Based on backend controller implementation.
 */
interface AdvanceStageApiResponse {
  advanced: boolean;
  newStage: number;
  newStatus: StageStatus | 'NOT_STARTED';
  advancedAt: string | null;
  blockedReason?: StageBlockedReason;
  unreachedMilestones?: MilestoneKey[];
}

/**
 * Advance to the next stage.
 * POST /sessions/:id/stages/advance
 */
export function useAdvanceStage(
  options?: Omit<
    UseMutationOptions<AdvanceStageApiResponse, ApiClientError, { sessionId: string }>,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }) => {
      return post<AdvanceStageApiResponse>(`/sessions/${sessionId}/stages/advance`);
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: stageKeys.progress(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
    },
    ...options,
  });
}

// ============================================================================
// Stage 4 Sub-chat (Phase 3)
// ============================================================================

import type {
  OpenStage4SubChatRequest,
  OpenStage4SubChatResponse,
  SendStage4SubChatMessageRequest,
  SendStage4SubChatMessageResponse,
  ResolveStage4SubChatRequest,
  ResolveStage4SubChatResponse,
  Stage4SubChatDTO,
} from '@meet-without-fear/shared';

/** Open (or get the active) sub-chat for a Stage 4 anchor. */
export function useOpenStage4SubChat() {
  return useMutation<
    OpenStage4SubChatResponse,
    ApiClientError,
    { sessionId: string } & OpenStage4SubChatRequest
  >({
    mutationFn: async ({ sessionId, anchorKind, anchorId }) =>
      post<OpenStage4SubChatResponse, OpenStage4SubChatRequest>(
        `/sessions/${sessionId}/stage4/subchat`,
        { anchorKind, anchorId: anchorId ?? null },
      ),
  });
}

/** Send a message in a sub-chat; the response contains the appended user + AI messages. */
export function useSendStage4SubChatMessage() {
  const queryClient = useQueryClient();
  return useMutation<
    SendStage4SubChatMessageResponse,
    ApiClientError,
    { sessionId: string; subChatId: string } & SendStage4SubChatMessageRequest,
    { previous: Stage4SubChatDTO | undefined }
  >({
    mutationFn: async ({ sessionId, subChatId, content }) =>
      post<SendStage4SubChatMessageResponse, SendStage4SubChatMessageRequest>(
        `/sessions/${sessionId}/stage4/subchat/${subChatId}/messages`,
        { content },
      ),
    onMutate: async ({ sessionId, subChatId, content }) => {
      const key = stageKeys.stage4SubChat(sessionId, subChatId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Stage4SubChatDTO>(key);
      if (previous) {
        queryClient.setQueryData<Stage4SubChatDTO>(key, {
          ...previous,
          messages: [
            ...previous.messages,
            {
              id: `optimistic-${Date.now()}`,
              role: 'USER' as any,
              content,
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }
      return { previous };
    },
    onError: (_err, { sessionId, subChatId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          stageKeys.stage4SubChat(sessionId, subChatId),
          context.previous,
        );
      }
    },
    onSuccess: (data, { sessionId, subChatId }) => {
      queryClient.setQueryData(
        stageKeys.stage4SubChat(sessionId, subChatId),
        data.subChat,
      );
    },
  });
}

/** Resolve a sub-chat with a structured payload (creates / updates proposals). */
export function useResolveStage4SubChat() {
  const queryClient = useQueryClient();
  return useMutation<
    ResolveStage4SubChatResponse,
    ApiClientError,
    { sessionId: string; subChatId: string } & ResolveStage4SubChatRequest
  >({
    mutationFn: async ({ sessionId, subChatId, acceptedProposals, updatedProposals }) =>
      post<ResolveStage4SubChatResponse, ResolveStage4SubChatRequest>(
        `/sessions/${sessionId}/stage4/subchat/${subChatId}/resolve`,
        { acceptedProposals, updatedProposals },
      ),
    onSuccess: (data, { sessionId, subChatId }) => {
      queryClient.setQueryData(
        stageKeys.stage4SubChat(sessionId, subChatId),
        data.subChat,
      );
      // Inventory may have changed — refresh Stage 4 state.
      refreshStage4Caches(queryClient, sessionId);
    },
  });
}
