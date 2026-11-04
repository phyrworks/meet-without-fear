/**
 * React Query Provider for Meet Without Fear Mobile
 *
 * Configures and provides the QueryClient to the app.
 */

import React, { type PropsWithChildren, useState } from 'react';
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  MutationCache,
  focusManager,
} from '@tanstack/react-query';
import { AppState, AppStateStatus, Platform } from 'react-native';
import { ApiClientError } from '../lib/api';
import { trackError } from '../services/analytics';
import { ErrorCode } from '@meet-without-fear/shared';

// ============================================================================
// App Focus Management
// ============================================================================

/**
 * Configure React Query to refetch on app focus.
 * This ensures data is fresh when the user returns to the app.
 */
function setupFocusManager(): () => void {
  const subscription = AppState.addEventListener(
    'change',
    (status: AppStateStatus) => {
      if (Platform.OS !== 'web') {
        focusManager.setFocused(status === 'active');
      }
    }
  );

  return () => subscription.remove();
}


// ============================================================================
// Query Client Configuration
// ============================================================================

function trackNetworkError(error: unknown): void {
  if (error instanceof ApiClientError && error.code === ErrorCode.SERVICE_UNAVAILABLE) {
    const errorCode = error.message === 'Request timed out' ? 'TIMEOUT' : 'NETWORK_ERROR';
    trackError('network', errorCode);
  }
}

/**
 * Retry only what can succeed on a retry: network failures, timeouts and 5xx.
 * A 4xx is the server's answer to this request (validation, auth, not found,
 * conflict) and repeats verbatim, so it is never retried — except 408 (request
 * timeout) and 429 (rate limited). work-99k2: draft autosave hammered a 400.
 */
export function shouldRetryApiError(failureCount: number, error: unknown, maxRetries: number): boolean {
  if (error instanceof ApiClientError) {
    const status = error.status;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return false;
    }
  }
  return failureCount < maxRetries;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => trackNetworkError(error),
    }),
    mutationCache: new MutationCache({
      onError: (error) => trackNetworkError(error),
    }),
    defaultOptions: {
      queries: {
        // Data considered fresh for 30 seconds
        staleTime: 30_000,

        // Cache data for 5 minutes
        gcTime: 5 * 60_000,

        // Retry failed requests up to 3 times, but never on 401/403/404 —
        // those are terminal client errors and retrying just floods Sentry.
        retry: (failureCount, error) => shouldRetryApiError(failureCount, error, 3),

        // Exponential backoff for retries
        retryDelay: (attemptIndex) =>
          Math.min(1000 * 2 ** attemptIndex, 30000),

        // Refetch on window focus (app comes to foreground)
        refetchOnWindowFocus: true,

        // Refetch on reconnect
        refetchOnReconnect: true,

        // Don't refetch on mount if data is fresh
        refetchOnMount: true,

        // Network mode - always run queries even when offline to use cache
        networkMode: 'offlineFirst',
      },
      mutations: {
        // Retry failed mutations once, but never on terminal client errors.
        retry: (failureCount, error) => shouldRetryApiError(failureCount, error, 1),

        // Network mode for mutations
        networkMode: 'offlineFirst',
      },
    },
  });
}

// ============================================================================
// Provider Component
// ============================================================================

type QueryProviderProps = PropsWithChildren;

/**
 * Query Provider component that wraps the app.
 *
 * Features:
 * - Automatic refetch on app focus
 * - Optimistic caching
 * - Retry with exponential backoff
 *
 * @example
 * ```tsx
 * export default function App() {
 *   return (
 *     <QueryProvider>
 *       <NavigationContainer>
 *         {...}
 *       </NavigationContainer>
 *     </QueryProvider>
 *   );
 * }
 * ```
 */
export function QueryProvider({ children }: QueryProviderProps): React.ReactElement {
  // Create client once per app lifecycle
  const [queryClient] = useState(() => createQueryClient());

  // Setup focus manager on mount
  React.useEffect(() => {
    const unsubscribeFocus = setupFocusManager();

    return () => {
      unsubscribeFocus();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {children as any}
    </QueryClientProvider>
  );
}

// ============================================================================
// Dev Tools (only in development)
// ============================================================================

/**
 * Get the query client for debugging purposes.
 * Only use this in development.
 */
export function useDebugQueryClient(): QueryClient | null {
  // Hook must be called unconditionally (React rules of hooks)
  const context = React.useContext(
    // @ts-expect-error - accessing internal context for debugging
    QueryClientProvider._context || {}
  ) as { queryClient?: QueryClient };

  // Only return the client in development
  if (__DEV__) {
    return context.queryClient || null;
  }
  return null;
}

export default QueryProvider;
