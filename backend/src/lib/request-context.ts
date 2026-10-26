/**
 * Request Context using AsyncLocalStorage
 *
 * Provides global access to request-scoped context (turnId, sessionId, userId)
 * throughout the async call stack without explicit parameter passing.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  /** Turn ID for grouping all operations from a single user action */
  turnId: string;
  /** Session ID if available */
  sessionId?: string;
  /** User ID if authenticated */
  userId?: string;
  /**
   * The caller's `participant` row in `sessionId`, resolved once per request
   * by `requireSessionAccess` (TS-9). Absent outside a session route.
   */
  participantId?: string;
  /** Request ID for tracing */
  requestId: string;
  /** Timestamp when the request started */
  startTime: number;
  /** E2E fixture ID for this request (from X-E2E-Fixture-ID header) */
  e2eFixtureId?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context
 * Returns undefined if called outside of a request context
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Get turnId from the current request context
 * Falls back to generating a synthetic turnId if not in a request context
 */
export function getCurrentTurnId(fallbackSessionId?: string): string {
  const context = getRequestContext();
  if (context?.turnId) {
    return context.turnId;
  }
  // Fallback for code running outside HTTP request context
  if (fallbackSessionId) {
    return `${fallbackSessionId}-${Date.now()}`;
  }
  return `background-${Date.now()}`;
}

/**
 * Get userId from the current request context
 */
export function getCurrentUserId(): string | undefined {
  return getRequestContext()?.userId;
}

/**
 * Get the caller's participant id (set by `requireSessionAccess`).
 */
export function getCurrentParticipantId(): string | undefined {
  return getRequestContext()?.participantId;
}

/**
 * Get sessionId from the current request context
 */
export function getCurrentSessionId(): string | undefined {
  return getRequestContext()?.sessionId;
}

/**
 * Get the E2E fixture ID for the current request.
 * Falls back to E2E_FIXTURE_ID environment variable if not set in context.
 */
export function getE2EFixtureId(): string | undefined {
  const context = getRequestContext();
  return context?.e2eFixtureId ?? process.env.E2E_FIXTURE_ID;
}

/**
 * Run a function within a request context
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Run a function in exactly this context — or in none, when `context` is
 * undefined. For re-entering a captured context from a callback that runs
 * elsewhere (lib/prisma-identity.ts).
 */
export function runInCapturedContext<T>(context: RequestContext | undefined, fn: () => T): T {
  return asyncLocalStorage.run(context as RequestContext, fn);
}

/**
 * Update the current request context with additional data
 * Only call this within an existing request context
 */
export function updateContext(updates: Partial<Omit<RequestContext, 'requestId' | 'startTime'>>): void {
  const current = getRequestContext();
  if (current) {
    Object.assign(current, updates);
  }
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
