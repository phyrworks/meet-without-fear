/**
 * Session Hooks for Meet Without Fear Mobile
 *
 * React Query hooks for session-related API operations.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  UseQueryOptions,
  UseMutationOptions,
  useInfiniteQuery,
  UseInfiniteQueryOptions,
  InfiniteData,
} from '@tanstack/react-query';
import { get, post, del, ApiClientError } from '../lib/api';
import { trackInvitationAccepted, trackInvitationDeclined } from '../services/analytics';
import {
  SessionSummaryDTO,
  SessionDetailDTO,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionStatus,
  StageStatus,
  PaginatedResponse,
  AcceptInvitationResponse,
  DeclineInvitationResponse,
  InvitationDTO,
  Stage,
  SessionStateResponse,
  GetMessagesResponse,
  EmpathyExchangeStatusResponse,
  MarkSharedContextViewedRequest,
  MarkSharedContextViewedResponse,
} from '@meet-without-fear/shared';

// Import query keys from centralized file to avoid circular dependencies
import {
  sessionKeys,
  stageKeys,
  messageKeys,
  notificationKeys,
} from './queryKeys';

// Re-export for backwards compatibility
export { sessionKeys };

// ============================================================================
// Types
// ============================================================================

export interface ListSessionsParams {
  status?: SessionStatus;
  limit?: number;
  cursor?: string;
}

// ============================================================================
// List Sessions Hook
// ============================================================================

/**
 * Fetch a paginated list of sessions.
 *
 * @param params - Query parameters for filtering and pagination
 * @param options - React Query options
 */
export function useSessions(
  params: ListSessionsParams = {},
  options?: Omit<
    UseQueryOptions<PaginatedResponse<SessionSummaryDTO>, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: sessionKeys.list({ status: params.status }),
    queryFn: async () => {
      const queryParams = new URLSearchParams();
      if (params.status) queryParams.set('status', params.status);
      if (params.limit) queryParams.set('limit', params.limit.toString());
      if (params.cursor) queryParams.set('cursor', params.cursor);

      const queryString = queryParams.toString();
      const url = queryString ? `/sessions?${queryString}` : '/sessions';
      return get<PaginatedResponse<SessionSummaryDTO>>(url);
    },
    staleTime: 30_000, // 30 seconds
    ...options,
  });
}

/**
 * Fetch sessions with infinite scroll pagination.
 */
export function useInfiniteSessions(
  params: Omit<ListSessionsParams, 'cursor'> = {},
  options?: Omit<
    UseInfiniteQueryOptions<PaginatedResponse<SessionSummaryDTO>, ApiClientError>,
    'queryKey' | 'queryFn' | 'getNextPageParam' | 'initialPageParam'
  >
) {
  return useInfiniteQuery({
    queryKey: sessionKeys.list({ status: params.status }),
    queryFn: async ({ pageParam }) => {
      const queryParams = new URLSearchParams();
      if (params.status) queryParams.set('status', params.status);
      if (params.limit) queryParams.set('limit', params.limit.toString());
      if (pageParam) queryParams.set('cursor', pageParam as string);

      const queryString = queryParams.toString();
      const url = queryString ? `/sessions?${queryString}` : '/sessions';
      return get<PaginatedResponse<SessionSummaryDTO>>(url);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.cursor : undefined,
    staleTime: 30_000,
    ...options,
  });
}

// ============================================================================
// Get Session Detail Hook
// ============================================================================

/**
 * Fetch a single session by ID with full details.
 *
 * @param sessionId - The session ID to fetch
 * @param options - React Query options
 */
export function useSession(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<{ session: SessionDetailDTO }, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: sessionKeys.detail(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<{ session: SessionDetailDTO }>(`/sessions/${sessionId}`);
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    ...options,
  });
}

// ============================================================================
// Create Session Hook
// ============================================================================

/**
 * Create a new session and send invitation.
 */
export function useCreateSession(
  options?: Omit<
    UseMutationOptions<CreateSessionResponse, ApiClientError, CreateSessionRequest>,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: CreateSessionRequest) => {
      return post<CreateSessionResponse, CreateSessionRequest>('/sessions', request);
    },
    onSuccess: (data) => {
      // Invalidate session list to show new session
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });

      if (!data.session) {
        return;
      }

      // Pre-populate the cache with the new session
      queryClient.setQueryData(sessionKeys.detail(data.session.id), {
        session: data.session,
      });
    },
    ...options,
  });
}

// ============================================================================
// Pause Session Hook
// ============================================================================

/**
 * Pause an active session.
 */
export function usePauseSession(
  options?: Omit<
    UseMutationOptions<
      { paused: boolean; pausedAt: string },
      ApiClientError,
      { sessionId: string; reason?: string }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, reason }) => {
      return post<{ paused: boolean; pausedAt: string }, { reason?: string }>(
        `/sessions/${sessionId}/pause`,
        { reason }
      );
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
    ...options,
  });
}

// ============================================================================
// Resume Session Hook
// ============================================================================

/**
 * Resume a paused session.
 */
export function useResumeSession(
  options?: Omit<
    UseMutationOptions<{ resumed: boolean; resumedAt: string }, ApiClientError, { sessionId: string }>,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }) => {
      return post<{ resumed: boolean; resumedAt: string }>(`/sessions/${sessionId}/resume`);
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
    ...options,
  });
}

// ============================================================================
// Invitation Hooks
// ============================================================================

/**
 * Get invitation details by ID.
 */
export function useInvitation(
  invitationId: string | undefined,
  options?: Omit<
    UseQueryOptions<{ invitation: InvitationDTO }, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: sessionKeys.invitation(invitationId || ''),
    queryFn: async () => {
      if (!invitationId) throw new Error('Invitation ID is required');
      return get<{ invitation: InvitationDTO }>(`/invitations/${invitationId}`);
    },
    enabled: !!invitationId,
    ...options,
  });
}

/**
 * Accept a session invitation.
 */
export function useAcceptInvitation(
  options?: Omit<
    UseMutationOptions<AcceptInvitationResponse, ApiClientError, { invitationId: string }>,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ invitationId }) => {
      return post<AcceptInvitationResponse>(`/invitations/${invitationId}/accept`);
    },
    onSuccess: (data) => {
      trackInvitationAccepted(data.session.id);
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      queryClient.invalidateQueries({ queryKey: sessionKeys.invitations() });

      // Pre-populate session cache
      queryClient.setQueryData(sessionKeys.detail(data.session.id), {
        session: data.session,
      });
    },
    ...options,
  });
}

/**
 * Decline a session invitation.
 */
export function useDeclineInvitation(
  options?: Omit<
    UseMutationOptions<
      DeclineInvitationResponse,
      ApiClientError,
      { invitationId: string; reason?: string }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ invitationId, reason }) => {
      return post<DeclineInvitationResponse>(`/invitations/${invitationId}/decline`, {
        reason,
      });
    },
    onSuccess: (_, { invitationId }) => {
      trackInvitationDeclined(invitationId);
      queryClient.invalidateQueries({ queryKey: sessionKeys.invitations() });
    },
    ...options,
  });
}

/**
 * Resend a session invitation.
 */
export function useResendInvitation(
  options?: Omit<
    UseMutationOptions<
      { sent: boolean; sentAt: string; expiresAt: string },
      ApiClientError,
      { invitationId: string }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ invitationId }) => {
      return post<{ sent: boolean; sentAt: string; expiresAt: string }>(
        `/invitations/${invitationId}/resend`
      );
    },
    onSuccess: (_, { invitationId }) => {
      queryClient.invalidateQueries({
        queryKey: sessionKeys.invitation(invitationId),
      });
    },
    ...options,
  });
}

// ============================================================================
// Session Invitation Message Hooks
// ============================================================================

interface SessionInvitationResponse {
  invitation: {
    id: string;
    name: string | null;
    messageConfirmed: boolean;
    /** When the user confirmed the invitation message (for chat indicator positioning) */
    messageConfirmedAt: string | null;
    /** When the invitation was accepted by the invitee */
    acceptedAt: string | null;
    status: string;
    expiresAt: string;
    /** Whether the current user is the inviter (true) or invitee (false) */
    isInviter: boolean;
    /** AI-finalized neutral topic frame shown to the invited user */
    topicFrame: string | null;
    /** When the topic frame was finalized */
    topicFrameConfirmedAt: string | null;
  };
}

interface TopicFrameResponse {
  topicFrame: string;
  alreadyConfirmed?: boolean;
  confirmedAt?: string;
}

/**
 * Confirm the AI-proposed topic frame. Body is empty — the canonical topic
 * comes from the latest <draft> emitted by the AI and persisted server-side.
 */
export function useConfirmTopicFrame(
  options?: Omit<
    UseMutationOptions<TopicFrameResponse, ApiClientError, { sessionId: string }>,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();
  const { onSuccess, ...restOptions } = options ?? {};

  return useMutation({
    mutationFn: async ({ sessionId }) => {
      return post<TopicFrameResponse>(`/sessions/${sessionId}/topic-frame/confirm`, {});
    },
    onSuccess: (data, variables, onMutateResult, context) => {
      const { sessionId } = variables;
      const confirmedAt = data.confirmedAt ?? new Date().toISOString();
      queryClient.setQueryData<SessionStateResponse>(
        sessionKeys.state(sessionId),
        (old) => {
          if (!old?.invitation) return old;
          return {
            ...old,
            invitation: {
              ...old.invitation,
              topicFrame: data.topicFrame,
              topicFrameConfirmedAt: confirmedAt,
            },
          };
        }
      );
      queryClient.setQueryData<SessionInvitationResponse>(
        sessionKeys.sessionInvitation(sessionId),
        (old) => {
          if (!old?.invitation) return old;
          return {
            ...old,
            invitation: {
              ...old.invitation,
              topicFrame: data.topicFrame,
              topicFrameConfirmedAt: confirmedAt,
            },
          };
        }
      );
      onSuccess?.(data, variables, onMutateResult, context);
    },
    ...restOptions,
  });
}

/**
 * Get invitation details for a session.
 */
export function useSessionInvitation(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<SessionInvitationResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: sessionKeys.sessionInvitation(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      return get<SessionInvitationResponse>(`/sessions/${sessionId}/invitation`);
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    ...options,
  });
}

/**
 * Context stored by onMutate for rollback on error.
 */
interface ConfirmInvitationContext {
  previousSessionState: SessionStateResponse | undefined;
  previousInvitation: { invitation?: InvitationDTO } | undefined;
  optimisticTimestamp: string;
}

/**
 * Confirm the invitation message for a session.
 *
 * Cache-First Architecture:
 * - onMutate: Immediately updates invitation.messageConfirmedAt in cache
 * - onSuccess: Replaces optimistic data with real server response
 * - onError: Rolls back to previous cache state
 *
 * This ensures the "Invitation Sent" indicator appears immediately
 * without needing local state like isConfirmingInvitation or optimisticConfirmTimestamp.
 */
export function useConfirmInvitationMessage(
  options?: Omit<
	    UseMutationOptions<
	      {
	        confirmed: boolean;
	        invitation: { id: string; messageConfirmed: boolean; messageConfirmedAt?: string; topicFrame?: string | null };
	        advancedToStage?: number;
	        transitionMessage?: { id: string; content: string; timestamp: string };
	      },
      ApiClientError,
      { sessionId: string },
      ConfirmInvitationContext
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

	  return useMutation<
	    {
	      confirmed: boolean;
	      invitation: { id: string; messageConfirmed: boolean; messageConfirmedAt?: string; topicFrame?: string | null };
	      advancedToStage?: number;
	      transitionMessage?: { id: string; content: string; timestamp: string };
	    },
    ApiClientError,
    { sessionId: string },
    ConfirmInvitationContext
  >({
    mutationFn: async ({ sessionId }) => {
	      return post<{
	        confirmed: boolean;
	        invitation: { id: string; messageConfirmed: boolean; messageConfirmedAt?: string; topicFrame?: string | null };
	        advancedToStage?: number;
	        transitionMessage?: { id: string; content: string; timestamp: string };
	      }>(`/sessions/${sessionId}/invitation/confirm`, {});
    },

    // =========================================================================
    // OPTIMISTIC UPDATE: Update invitation cache immediately
    // =========================================================================
    onMutate: async ({ sessionId }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: sessionKeys.state(sessionId) });
      await queryClient.cancelQueries({ queryKey: sessionKeys.sessionInvitation(sessionId) });

      // Snapshot previous values for rollback
      const previousSessionState = queryClient.getQueryData<SessionStateResponse>(
        sessionKeys.state(sessionId)
      );
      const previousInvitation = queryClient.getQueryData<{ invitation?: InvitationDTO }>(
        sessionKeys.sessionInvitation(sessionId)
      );

      const optimisticTimestamp = new Date().toISOString();

      // Optimistically update session state (consolidated state used by useUnifiedSession)
      queryClient.setQueryData<SessionStateResponse>(
        sessionKeys.state(sessionId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            invitation: old.invitation ? {
              ...old.invitation,
              messageConfirmed: true,
              messageConfirmedAt: optimisticTimestamp,
            } : old.invitation,
          };
        }
      );

      // Optimistically update invitation query
      queryClient.setQueryData<{ invitation?: InvitationDTO }>(
        sessionKeys.sessionInvitation(sessionId),
        (old) => {
          if (!old?.invitation) return old;
          return {
            ...old,
            invitation: {
              ...old.invitation,
              messageConfirmed: true,
              messageConfirmedAt: optimisticTimestamp,
            },
          };
        }
      );

      return { previousSessionState, previousInvitation, optimisticTimestamp };
    },

    // =========================================================================
    // SUCCESS: Replace optimistic data with real response
    // Using setQueryData instead of invalidateQueries for invitation/state to prevent
    // race conditions that can overwrite optimistic messageConfirmedAt before
    // the server response settles (fix for disappearing indicator bug)
    // =========================================================================
    onSuccess: (data, { sessionId }, context) => {
      // Update invitation cache with server response (preserves messageConfirmedAt)
      queryClient.setQueryData<SessionInvitationResponse>(
        sessionKeys.sessionInvitation(sessionId),
        (old) => {
          if (!old) return { invitation: data.invitation as SessionInvitationResponse['invitation'] };
          return {
            ...old,
            invitation: {
              ...old.invitation,
              ...data.invitation,
            },
          };
        }
      );

      // Update session state, merging invitation data (avoids race conditions)
      // IMPORTANT: Get current state FIRST, then decide whether to update.
      // Using setQueryData with an updater that returns undefined would clear the cache!
      let existingState = queryClient.getQueryData<SessionStateResponse>(sessionKeys.state(sessionId));

      // If cache was cleared, use context from onMutate as fallback
      // This preserves the optimistic update even when something else cleared the cache
      if (!existingState && context?.previousSessionState) {
        // The context.previousSessionState is from BEFORE onMutate's optimistic update
        // We need to apply the optimistic changes + server response
        existingState = {
          ...context.previousSessionState,
          invitation: context.previousSessionState.invitation ? {
            ...context.previousSessionState.invitation,
            messageConfirmed: true,
            messageConfirmedAt: data.invitation.messageConfirmedAt || context.optimisticTimestamp,
          } : context.previousSessionState.invitation,
        };
      }

      if (!existingState) {
        // No cache and no context - this shouldn't happen but handle gracefully
        console.error('[confirmInvitation:onSuccess] No existing session state AND no context - forcing refetch');
        queryClient.invalidateQueries({ queryKey: sessionKeys.state(sessionId) });
      } else {
        // Build the new state, updating stage if advanced
        const newInvitation = existingState.invitation ? {
          ...existingState.invitation,
          messageConfirmed: data.invitation.messageConfirmed,
          messageConfirmedAt: data.invitation.messageConfirmedAt || existingState.invitation.messageConfirmedAt,
        } : existingState.invitation;

        // Update progress.myProgress.stage if advanced
        const newProgress = data.advancedToStage !== undefined
          ? {
              ...existingState.progress,
              myProgress: {
                ...existingState.progress.myProgress,
                stage: data.advancedToStage,
                status: 'IN_PROGRESS', // Stage advances to in-progress
              },
            }
          : existingState.progress;

        // Update session.currentStage and session.myProgress for consistency
        const newSession = data.advancedToStage !== undefined
          ? {
              ...existingState.session,
              status: SessionStatus.INVITED,
              currentStage: data.advancedToStage,
              stageStatus: StageStatus.IN_PROGRESS,
              myProgress: {
                ...existingState.session.myProgress,
                stage: data.advancedToStage,
                status: StageStatus.IN_PROGRESS,
              },
            }
          : existingState.session;

        const newState: SessionStateResponse = {
          ...existingState,
          invitation: newInvitation,
          progress: newProgress,
          session: newSession,
        };

        // Set the new state directly (not using updater to avoid undefined issues)
        queryClient.setQueryData(sessionKeys.state(sessionId), newState);
      }

      // Only invalidate detail and progress (less critical, won't affect indicator)
      // These are background refreshes that won't race with the optimistic indicator
      queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(sessionId),
      });
      queryClient.invalidateQueries({
        queryKey: stageKeys.progress(sessionId),
      });

      // NOTE: Transition message is NO LONGER in the HTTP response.
      // It arrives via Ably (message.ai_response event) after background AI generation.
      // The mobile app handles this via useAIMessageHandler.addAIMessage, which
      // writes the message to messageKeys.infinite and messageKeys.list caches.
      // This eliminates the 2-10s race window that caused the invitation panel bug.

      console.log('[confirmInvitation:onSuccess] Invitation confirmed, AI message will arrive via Ably');
    },

    // =========================================================================
    // ERROR: Rollback to previous cache state
    // =========================================================================
    onError: (_error, { sessionId }, context) => {
      if (context) {
        if (context.previousSessionState !== undefined) {
          queryClient.setQueryData(sessionKeys.state(sessionId), context.previousSessionState);
        }
        if (context.previousInvitation !== undefined) {
          queryClient.setQueryData(sessionKeys.sessionInvitation(sessionId), context.previousInvitation);
        }
      }
    },

    ...options,
  });
}

// ============================================================================
// Archive Session Hook
// ============================================================================

/**
 * Archive a session (for resolved, abandoned, or pending sessions).
 * @deprecated Use useDeleteSession instead for proper data cleanup
 */
export function useArchiveSession(
  options?: Omit<
    UseMutationOptions<
      { archived: boolean; archivedAt: string },
      ApiClientError,
      { sessionId: string }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }) => {
      return post<{ archived: boolean; archivedAt: string }>(
        `/sessions/${sessionId}/archive`
      );
    },
    onSuccess: (_, { sessionId }) => {
      // Invalidate session lists to remove the archived session
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      // Invalidate the specific session detail
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
    },
    ...options,
  });
}

// ============================================================================
// Delete Session Hook
// ============================================================================

interface DeleteSessionSummary {
  sessionAbandoned: boolean;
  partnerNotified: boolean;
  dataRecordsDeleted: number;
}

/**
 * Delete a session for the current user.
 *
 * This removes the user's data from the session but leaves the session
 * available for the partner. The partner keeps access to their own data
 * and any content that was shared.
 *
 * For active sessions, the partner is notified that the session was abandoned.
 */
export function useDeleteSession(
  options?: Omit<
    UseMutationOptions<
      { deleted: boolean; summary: DeleteSessionSummary },
      ApiClientError,
      { sessionId: string }
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }) => {
      return del<{ deleted: boolean; summary: DeleteSessionSummary }>(
        `/sessions/${sessionId}`
      );
    },
    onSuccess: (_, { sessionId }) => {
      // Invalidate session lists to remove the deleted session
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      // Remove the specific session detail from cache
      queryClient.removeQueries({ queryKey: sessionKeys.detail(sessionId) });
      // Remove session state from cache
      queryClient.removeQueries({ queryKey: sessionKeys.state(sessionId) });
    },
    ...options,
  });
}

// ============================================================================
// Consolidated Session State Hook
// ============================================================================

/**
 * Fetch consolidated session state in a single request.
 *
 * Returns core session data (session, progress, messages, invitation, compact)
 * in one API call for efficient initial load.
 *
 * Also hydrates individual query caches so subsequent hook calls get cache hits.
 *
 * @param sessionId - The session ID to fetch
 * @param options - React Query options
 */
export function useSessionState(
  sessionId: string | undefined,
  options?: Omit<
    UseQueryOptions<SessionStateResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: sessionKeys.state(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) throw new Error('Session ID is required');
      const data = await get<SessionStateResponse>(`/sessions/${sessionId}/state`);

      // Hydrate individual query caches from consolidated response.
      // GUARD: Only hydrate if no existing data (initial load).
      // After initial load, these caches are updated by mutations and Ably events.
      // Blindly overwriting them here can undo optimistic updates.
      if (!queryClient.getQueryData(sessionKeys.detail(sessionId))) {
        queryClient.setQueryData(sessionKeys.detail(sessionId), {
          session: data.session,
        });
      }

      if (!queryClient.getQueryData(stageKeys.progress(sessionId))) {
        queryClient.setQueryData(stageKeys.progress(sessionId), data.progress);
      }

      // Hydrate only the infinite cache when empty. The session-state endpoint
      // already returns the initial message page, and this prevents the chat
      // from rendering blank while the separate infinite query starts. Do not
      // overwrite existing data because mutations and realtime events update
      // this cache optimistically after initial load.
      if (!queryClient.getQueryData(messageKeys.infinite(sessionId))) {
        queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
          messageKeys.infinite(sessionId),
          {
            pages: [data.messages],
            pageParams: [undefined],
          }
        );
      }

      if (data.invitation && !queryClient.getQueryData(sessionKeys.sessionInvitation(sessionId))) {
        queryClient.setQueryData(sessionKeys.sessionInvitation(sessionId), {
          invitation: data.invitation,
        });
      }

      if (!queryClient.getQueryData(stageKeys.compact(sessionId))) {
        queryClient.setQueryData(stageKeys.compact(sessionId), data.compact);
      }

      return data;
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    ...options,
  });

  return query;
}

// ============================================================================
// Mark Session Viewed Hook
// ============================================================================

interface MarkSessionViewedResponse {
  success: boolean;
  lastViewedAt: string;
  lastSeenChatItemId: string | null;
}

/**
 * Mark a session as viewed by the current user.
 *
 * This updates the lastViewedAt timestamp and optionally the lastSeenChatItemId.
 * Used to clear unread indicators (blue dot, badge count) when user opens a session.
 *
 * @param sessionId - The session ID (required for automatic call on mount)
 */
export function useMarkSessionViewed(sessionId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ lastSeenChatItemId }: { lastSeenChatItemId?: string }) => {
      if (!sessionId) throw new Error('Session ID is required');
      return post<MarkSessionViewedResponse>(`/sessions/${sessionId}/viewed`, {
        lastSeenChatItemId,
      });
    },
    onSuccess: (data) => {
      // Invalidate sessions list to update hasUnread flags
      queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
      // Invalidate unread count for tab badge
      queryClient.invalidateQueries({ queryKey: sessionKeys.unreadCount() });
      // Update session state directly instead of invalidating to avoid race conditions
      // with other mutations (like confirmInvitation) that use optimistic updates.
      // Keep read state in sync for unread badges and animation boundaries.
      queryClient.setQueryData<SessionStateResponse>(
        sessionKeys.state(sessionId || ''),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            session: {
              ...old.session,
              lastViewedAt: data.lastViewedAt,
              lastSeenChatItemId: data.lastSeenChatItemId,
            },
          };
        }
      );
    },
  });
}

export interface MarkSharedContextViewedVariables {
  /** Server id of the received SHARED_CONTEXT / VALIDATION_FEEDBACK message shown on screen */
  messageId: string;
  /** Its timestamp (ISO): everything delivered up to it now counts as viewed */
  timestamp: string;
}

interface PendingActionsCache {
  actions: { type: string; id: string; data: Record<string, unknown> }[];
  sentTabUpdates?: number;
}

/**
 * Cache-first projection of a shared-frame view onto the recipient's empathy
 * status: the newest delivered context is viewed once a frame at or after it
 * was shown. Exported for tests.
 */
export function applySharedContextViewedToEmpathyStatus(
  old: EmpathyExchangeStatusResponse | undefined,
  timestamp: string,
): EmpathyExchangeStatusResponse | undefined {
  if (!old || !old.hasUnviewedSharedContext || !old.sharedContext) return old;
  if (new Date(timestamp).getTime() < new Date(old.sharedContext.sharedAt).getTime()) return old;
  return { ...old, hasUnviewedSharedContext: false };
}

/** The same view projected onto pending actions: received context up to it is no longer unviewed. */
export function applySharedContextViewedToPendingActions<T extends PendingActionsCache>(
  old: T | undefined,
  timestamp: string,
): T | undefined {
  if (!old) return old;
  const at = new Date(timestamp).getTime();
  const actions = old.actions.filter((a) => {
    if (a.type !== 'context_received') return true;
    const ts = typeof a.data?.timestamp === 'string' ? new Date(a.data.timestamp).getTime() : NaN;
    return !(ts <= at);
  });
  return actions.length === old.actions.length ? old : { ...old, actions };
}

/**
 * Mark a received shared frame ("Context from X" / "Feedback from X") as shown
 * on the current user's screen (work-2doq). The server advances the user's
 * viewed instant, which turns the sender's line into "✓ Seen" (the sender is
 * pinged over Ably and refetches its own empathy status) and clears this
 * user's unviewed shared context and context_received actions — written
 * here optimistically, rolled back on error.
 */
export function useMarkSharedContextViewed(sessionId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation<
    MarkSharedContextViewedResponse,
    ApiClientError,
    MarkSharedContextViewedVariables,
    { previousStatus: unknown; previousActions: unknown }
  >({
    mutationFn: async ({ messageId }) => {
      if (!sessionId) throw new Error('Session ID is required');
      const body: MarkSharedContextViewedRequest = { messageId };
      return post<MarkSharedContextViewedResponse>(`/sessions/${sessionId}/shared-context-viewed`, body);
    },
    onMutate: async ({ timestamp }) => {
      const statusKey = stageKeys.empathyStatus(sessionId || '');
      const actionsKey = stageKeys.pendingActions(sessionId || '');
      await Promise.all([
        queryClient.cancelQueries({ queryKey: statusKey }),
        queryClient.cancelQueries({ queryKey: actionsKey }),
      ]);
      const previousStatus = queryClient.getQueryData(statusKey);
      const previousActions = queryClient.getQueryData(actionsKey);
      queryClient.setQueryData<EmpathyExchangeStatusResponse>(statusKey, (old) =>
        applySharedContextViewedToEmpathyStatus(old, timestamp),
      );
      queryClient.setQueryData<PendingActionsCache>(actionsKey, (old) =>
        applySharedContextViewedToPendingActions(old, timestamp),
      );
      return { previousStatus, previousActions };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData(stageKeys.empathyStatus(sessionId || ''), context.previousStatus);
      queryClient.setQueryData(stageKeys.pendingActions(sessionId || ''), context.previousActions);
    },
    onSettled: () => {
      // The aggregate badge has no optimistic copy; refetch it.
      queryClient.invalidateQueries({ queryKey: notificationKeys.badgeCount() });
    },
  });
}
