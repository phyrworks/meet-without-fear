/**
 * Message Hooks for Meet Without Fear Mobile
 *
 * React Query hooks for chat messages and emotional barometer.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  UseQueryOptions,
  UseMutationOptions,
  useInfiniteQuery,
  InfiniteData,
} from '@tanstack/react-query';
import { get, post, ApiClientError } from '../lib/api';
import {
  MessageDTO,
  GetMessagesResponse,
  RecordEmotionalReadingRequest,
  RecordEmotionalReadingResponse,
  GetEmotionalHistoryResponse,
  CompleteExerciseRequest,
  CompleteExerciseResponse,
  Stage,
} from '@meet-without-fear/shared';

// Import query keys from centralized file to avoid circular dependencies
import {
  sessionKeys,
  messageKeys,
} from './queryKeys';

// Re-export for backwards compatibility
export { messageKeys };

// ============================================================================
// Types
// ============================================================================

export interface GetMessagesParams {
  sessionId: string;
  stage?: Stage;
  limit?: number;
  cursor?: string;
}

// ============================================================================
// Get Messages Hook
// ============================================================================

/**
 * Fetch messages for a session with optional stage filter.
 *
 * @param params - Query parameters
 * @param options - React Query options
 */
export function useMessages(
  params: GetMessagesParams,
  options?: Omit<
    UseQueryOptions<GetMessagesResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  const { sessionId, stage, limit, cursor } = params;

  return useQuery({
    queryKey: messageKeys.list(sessionId, stage),
    queryFn: async () => {
      const queryParams = new URLSearchParams();
      if (stage !== undefined) queryParams.set('stage', stage.toString());
      if (limit) queryParams.set('limit', limit.toString());
      if (cursor) queryParams.set('cursor', cursor);

      const queryString = queryParams.toString();
      const url = queryString
        ? `/sessions/${sessionId}/messages?${queryString}`
        : `/sessions/${sessionId}/messages`;

      return get<GetMessagesResponse>(url);
    },
    enabled: !!sessionId,
    staleTime: 10_000, // 10 seconds - messages update frequently
    ...options,
  });
}

/** Options for useInfiniteMessages hook */
export interface UseInfiniteMessagesOptions {
  enabled?: boolean;
}

/** Return type for useInfiniteMessages hook */
export interface UseInfiniteMessagesResult {
  data: InfiniteData<GetMessagesResponse> | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  refetch: () => void;
}

/**
 * Fetch messages with infinite scroll pagination.
 * Initial load gets newest messages (order: desc, reversed on server).
 * Loading more fetches older messages using the 'beforeSeq' cursor (the oldest loaded message's seq).
 */
export function useInfiniteMessages(
  params: Omit<GetMessagesParams, 'cursor'>,
  options?: UseInfiniteMessagesOptions
): UseInfiniteMessagesResult {
  const { sessionId, stage, limit = 25 } = params;

  const result = useInfiniteQuery({
    queryKey: messageKeys.infinite(sessionId, stage),
    queryFn: async ({ pageParam }) => {
      const queryParams = new URLSearchParams();
      if (stage !== undefined) queryParams.set('stage', stage.toString());
      queryParams.set('limit', limit.toString());

      // First page: get newest messages (default order is 'desc').
      // Subsequent pages also use descending order with the `beforeSeq` cursor
      // (work-k5fk.4: the page is in seq order, so the cursor is a seq) so the
      // backend returns the immediately previous chunk, then reverses that
      // chunk into chronological display order.
      if (pageParam !== undefined) {
        queryParams.set('beforeSeq', String(pageParam));
      }

      const url = `/sessions/${sessionId}/messages?${queryParams.toString()}`;
      return get<GetMessagesResponse>(url);
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore || lastPage.messages.length === 0) return undefined;
      // The oldest message's seq is the cursor for the next page
      return lastPage.messages[0]?.seq;
    },
    enabled: options?.enabled ?? !!sessionId,
    staleTime: 60_000, // 1 minute - keep data fresh longer
    gcTime: 300_000, // 5 minutes - keep in cache longer (formerly cacheTime)
    refetchOnMount: 'always', // Always refetch when session opens to ensure fresh messages
  });

  return {
    data: result.data,
    isLoading: result.isLoading,
    isFetching: result.isFetching,
    isError: result.isError,
    error: result.error,
    fetchNextPage: result.fetchNextPage,
    hasNextPage: result.hasNextPage ?? false,
    isFetchingNextPage: result.isFetchingNextPage,
    refetch: result.refetch,
  };
}

// ============================================================================
// AI Message Handler Hook (for Fire-and-Forget Ably messages)
// ============================================================================

/**
 * @deprecated This hook was used for the fire-and-forget pattern which is now deprecated.
 * With SSE streaming, AI responses arrive on the same connection and are handled by
 * useStreamingMessage. This hook is kept for backwards compatibility but the
 * `addAIMessage` function will no longer receive messages since the fire-and-forget
 * endpoint returns HTTP 410 Gone.
 *
 * The `handleAIMessageError` function may still be useful for edge cases.
 */
export function useAIMessageHandler() {
  const queryClient = useQueryClient();

  return {
    /**
     * Add an AI message from Ably to the cache.
     * Called when message.ai_response event is received.
     */
    addAIMessage: (sessionId: string, message: MessageDTO) => {
      const stage = message.stage;

      const updateCache = (old: GetMessagesResponse | undefined) => {
        if (!old) {
          return { messages: [message], hasMore: false };
        }
        // Check for duplicates
        const existingIds = new Set((old.messages || []).map((m) => m.id));
        if (existingIds.has(message.id)) {
          return old; // Already have this message
        }
        return {
          ...old,
          messages: [...(old.messages || []), message],
        };
      };

      const updateInfiniteCache = (
        old: InfiniteData<GetMessagesResponse> | undefined
      ): InfiniteData<GetMessagesResponse> | undefined => {
        if (!old || old.pages.length === 0) {
          return {
            pages: [{ messages: [message], hasMore: false }],
            pageParams: [undefined],
          };
        }
        // Update the first page (newest messages)
        const updatedPages = [...old.pages];
        const firstPage = updatedPages[0];
        const existingIds = new Set((firstPage.messages || []).map((m) => m.id));
        if (existingIds.has(message.id)) {
          return old; // Already have this message
        }
        updatedPages[0] = {
          ...firstPage,
          messages: [...(firstPage.messages || []), message],
        };
        return { ...old, pages: updatedPages };
      };

      // Update stage-specific cache
      if (stage !== undefined) {
        queryClient.setQueryData<GetMessagesResponse>(
          messageKeys.list(sessionId, stage),
          updateCache
        );
        queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
          messageKeys.infinite(sessionId, stage),
          updateInfiniteCache
        );
      }

      // Also update non-stage-filtered cache
      queryClient.setQueryData<GetMessagesResponse>(
        messageKeys.list(sessionId),
        updateCache
      );
      queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
        messageKeys.infinite(sessionId),
        updateInfiniteCache
      );

      console.log(`[useAIMessageHandler] Added AI message ${message.id} to cache for session ${sessionId}`);
    },

    /**
     * Handle AI message error from Ably.
     * Called when message.error event is received.
     * Returns the error info so the component can display retry UI; the
     * message caches themselves are reconciled by the streaming client.
     */
    handleAIMessageError: (sessionId: string, userMessageId: string, errorMessage: string, canRetry: boolean) => {
      console.error(`[useAIMessageHandler] AI message error for session ${sessionId}:`, errorMessage);

      // Return error info so the component can display appropriate UI
      return {
        sessionId,
        userMessageId,
        errorMessage,
        canRetry,
      };
    },
  };
}

// ============================================================================
// Emotional Barometer Hooks
// ============================================================================

/**
 * Get emotional reading history for a session.
 */
export function useEmotionalHistory(
  params: { sessionId: string; stage?: Stage; limit?: number },
  options?: Omit<
    UseQueryOptions<GetEmotionalHistoryResponse, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  const { sessionId, stage, limit } = params;

  return useQuery({
    queryKey: messageKeys.emotionHistory(sessionId, stage),
    queryFn: async () => {
      const queryParams = new URLSearchParams();
      if (stage !== undefined) queryParams.set('stage', stage.toString());
      if (limit) queryParams.set('limit', limit.toString());

      const queryString = queryParams.toString();
      const url = queryString
        ? `/sessions/${sessionId}/emotions?${queryString}`
        : `/sessions/${sessionId}/emotions`;

      return get<GetEmotionalHistoryResponse>(url);
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    ...options,
  });
}

/**
 * Record an emotional reading.
 */
export function useRecordEmotion(
  options?: Omit<
    UseMutationOptions<
      RecordEmotionalReadingResponse,
      ApiClientError,
      RecordEmotionalReadingRequest
    >,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: RecordEmotionalReadingRequest) => {
      return post<RecordEmotionalReadingResponse, RecordEmotionalReadingRequest>(
        `/sessions/${request.sessionId}/emotions`,
        request
      );
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({
        queryKey: messageKeys.emotionHistory(sessionId),
      });
    },
    ...options,
  });
}

/**
 * Complete an emotional support exercise (breathing, body scan, etc.).
 */
export function useCompleteExercise(
  options?: Omit<
    UseMutationOptions<CompleteExerciseResponse, ApiClientError, CompleteExerciseRequest>,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: CompleteExerciseRequest) => {
      return post<CompleteExerciseResponse, CompleteExerciseRequest>(
        `/sessions/${request.sessionId}/exercises/complete`,
        request
      );
    },
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({
        queryKey: messageKeys.emotionHistory(sessionId),
      });
    },
    ...options,
  });
}

// ============================================================================
// Initial Message Hook
// ============================================================================

interface InitialMessageResponse {
  message: MessageDTO;
}

/**
 * Fetch AI-generated initial message for a session.
 * Called when starting a new session that has no messages yet.
 */
export function useFetchInitialMessage(
  options?: Omit<
    UseMutationOptions<InitialMessageResponse, ApiClientError, { sessionId: string }>,
    'mutationFn'
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      console.log('[useFetchInitialMessage] Calling API for session:', sessionId);
      return post<InitialMessageResponse, Record<string, never>>(
        `/sessions/${sessionId}/messages/initial`,
        {}
      );
    },
    onSuccess: (data, { sessionId }) => {
      console.log('[useFetchInitialMessage] Success! Message:', data.message.content.substring(0, 50));
      const stage = data.message.stage;

      // Add the AI message to the cache
      const updateCache = (old: GetMessagesResponse | undefined) => {
        if (!old) {
          return { messages: [data.message], hasMore: false };
        }
        return {
          ...old,
          messages: [...(old.messages || []), data.message],
        };
      };

      // Update infinite query cache
      const updateInfiniteCache = (
        old: InfiniteData<GetMessagesResponse> | undefined
      ): InfiniteData<GetMessagesResponse> | undefined => {
        if (!old || old.pages.length === 0) {
          return {
            pages: [{ messages: [data.message], hasMore: false }],
            pageParams: [undefined],
          };
        }
        const updatedPages = [...old.pages];
        const firstPage = updatedPages[0];
        updatedPages[0] = {
          ...firstPage,
          messages: [data.message, ...(firstPage.messages || [])],
        };
        return { ...old, pages: updatedPages };
      };

      // Update stage-specific cache
      if (stage !== undefined) {
        queryClient.setQueryData<GetMessagesResponse>(
          messageKeys.list(sessionId, stage),
          updateCache
        );
        queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
          messageKeys.infinite(sessionId, stage),
          updateInfiniteCache
        );
      }

      // Also update non-stage-filtered cache
      queryClient.setQueryData<GetMessagesResponse>(
        messageKeys.list(sessionId),
        updateCache
      );
      queryClient.setQueryData<InfiniteData<GetMessagesResponse>>(
        messageKeys.infinite(sessionId),
        updateInfiniteCache
      );

      console.log('[useFetchInitialMessage] Cache updated for session:', sessionId);
    },
    onError: (error, { sessionId }) => {
      console.error('[useFetchInitialMessage] Error fetching initial message:', error, 'session:', sessionId);
    },
    ...options,
  });
}
