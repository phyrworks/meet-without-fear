import Ably from 'ably';
import { logger } from '../lib/logger';
import { ablyCircuitBreaker } from '../utils/circuit-breaker';
import { sendPushNotification } from './push';

// Re-export for monitoring endpoints
export { ablyCircuitBreaker };
import {
  SessionEventType,
  SessionEventData,
  PresenceStatus,
  REALTIME_CHANNELS,
  UserEventType,
  UserEventData,
  MessageAIResponsePayload,
  MessageErrorPayload,
  MessageDTO,
  ContextUpdatedPayload,
} from '@meet-without-fear/shared';
import type {
  SessionEventPublishData,
  UserEventPublishData,
  SessionEventEnvelope,
  UserEventEnvelope,
  NoExtraSessionEventKeys,
  NoExtraUserEventKeys,
} from '@meet-without-fear/shared';

/**
 * Session events for real-time communication between partners.
 * Re-export from shared for backward compatibility.
 */
export type SessionEvent = Extract<
  SessionEventType,
  | 'partner.signed_compact'
  | 'partner.stage_completed'
  | 'partner.advanced'
  | 'partner.empathy_shared'
  | 'partner.additional_context_shared'
  | 'partner.empathy_revealed'
  | 'partner.skipped_refinement'
  | 'partner.needs_confirmed'
  | 'partner.needs_shared'
  | 'partner.needs_validated'
  | 'session.needs_reveal_ready'
  | 'session.strategies_updated'
  | 'partner.ranking_submitted'
  | 'partner.ready_to_rank'
  | 'partner.consent_granted'
  | 'partner.consent_revoked'
  | 'agreement.proposed'
  | 'agreement.confirmed'
  | 'session.joined'
  | 'session.paused'
  | 'session.resumed'
  | 'session.resolved'
  | 'invitation.declined'
  | 'invitation.confirmed'
  // Empathy reconciler events
  | 'empathy.share_suggestion'
  | 'empathy.revealed'
  | 'empathy.refining'
  | 'empathy.context_shared'
  | 'empathy.status_updated'
  | 'notification.pending_action'
  | 'empathy.resubmitted'
>;

// Re-export for backward compatibility
export type { SessionEventData };

/**
 * Ably client singleton.
 * Throws if ABLY_API_KEY is not configured.
 */
function getAblyClient(): Ably.Rest {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    throw new Error('ABLY_API_KEY not configured - realtime features require Ably');
  }
  return new Ably.Rest(apiKey);
}

// Lazy-initialized Ably client
let ablyClient: Ably.Rest | undefined;

function shouldSkipAblyInE2E(): boolean {
  return process.env.E2E_AUTH_BYPASS === 'true' && !process.env.ABLY_API_KEY;
}

export function getAbly(): Ably.Rest {
  if (ablyClient === undefined) {
    ablyClient = getAblyClient();
  }
  return ablyClient;
}

/**
 * Reset the Ably client (useful for testing).
 */
export function resetAblyClient(): void {
  ablyClient = undefined;
}

// ============================================================================
// Typing Indicator State (in-memory for now, could be Redis)
// ============================================================================

interface TypingState {
  isTyping: boolean;
  lastUpdate: number;
}

const typingStates = new Map<string, TypingState>();

/**
 * Get the typing state key for a user in a session.
 */
function getTypingKey(sessionId: string, userId: string): string {
  return `${sessionId}:${userId}`;
}

/**
 * Typing indicator timeout in milliseconds.
 * After this time without updates, typing is considered stopped.
 */
const TYPING_TIMEOUT = 5000;

// ============================================================================
// Core Event Publishing
// ============================================================================

/**
 * Publishes a session event to the Ably channel for the given session.
 *
 * @param sessionId - The session ID to publish to
 * @param event - The event type to publish
 * @param data - The event data payload
 * @param excludeUserId - Optional user ID to exclude from receiving the event
 * @returns Promise<void>
 */
// Events that should NOT trigger session list updates (transient/typing events)
const TRANSIENT_EVENTS = new Set([
  'typing.start',
  'typing.stop',
  'presence.online',
  'presence.offline',
  'presence.away',
]);

/**
 * Publish a Stage 0 topic frame update to the session channel.
 * Sent whenever the AI proposes (or revises) a topic via <draft>...</draft>
 * during Stage 0 chat, before the user has confirmed it.
 */
export async function publishTopicFrameUpdated(
  sessionId: string,
  topicFrame: string,
  confirmed: boolean
): Promise<void> {
  if (shouldSkipAblyInE2E()) {
    logger.info(`[Realtime] E2E mode without ABLY_API_KEY - skipping session.topic_frame_updated publish for session ${sessionId}`);
    return;
  }

  const cbStats = ablyCircuitBreaker.getStats();
  if (cbStats.state === 'OPEN') {
    logger.warn(`[Realtime] Ably circuit breaker OPEN - skipping topic_frame_updated for ${sessionId}`);
    return;
  }
  const ably = getAbly();
  try {
    const channel = ably.channels.get(REALTIME_CHANNELS.session(sessionId));
    // Published directly rather than via publishSessionEvent: topic-frame drafts
    // are high-frequency and must not touch session.updatedAt / notify members.
    const payload: SessionEventPublishData<'session.topic_frame_updated'> = {
      sessionId,
      timestamp: Date.now(),
      topicFrame,
      confirmed,
    };
    await channel.publish('session.topic_frame_updated', payload);
    ablyCircuitBreaker.recordSuccess();
    logger.info(`[Realtime] Published session.topic_frame_updated to session ${sessionId}`);
  } catch (error) {
    ablyCircuitBreaker.recordFailure('publishTopicFrameUpdated');
    logger.error(`[Realtime] Failed to publish session.topic_frame_updated to session ${sessionId}:`, error);
    // Don't throw - topic frame updates are non-critical
  }
}

/**
 * Publishes a session event, typed against the shared realtime contract.
 *
 * `event` must be a known `SessionEventType` and `data` must match that event's
 * schema in `shared/src/contracts/realtime.ts`. An unknown event name is a
 * compile error, as is an unknown or misspelled payload key that is statically
 * visible at the call site (see the scope note in the contract's docblock). To
 * add a field, add it to the contract first; both sides then pick it up.
 */
export async function publishSessionEvent<
  E extends SessionEventType,
  T extends SessionEventPublishData<E>,
>(
  sessionId: string,
  event: E,
  data: T & NoExtraSessionEventKeys<E, T>,
  excludeUserId?: string
): Promise<void> {
  if (shouldSkipAblyInE2E()) {
    logger.info(`[Realtime] E2E mode without ABLY_API_KEY - skipping ${event} publish for session ${sessionId}`);
    return;
  }

  // Circuit breaker fast-fail: skip publish if Ably is in OPEN state
  const cbStats = ablyCircuitBreaker.getStats();
  if (cbStats.state === 'OPEN') {
    logger.warn(`[Realtime] Ably circuit breaker OPEN - skipping ${event} publish for session ${sessionId}`);
    return;
  }

  const ably = getAbly();

  // Typed as the contract envelope rather than SessionEventData: caller data is
  // spread over `timestamp` and may legitimately override it with an ISO string
  // (controllers/sessions.ts does exactly that for invitation.confirmed).
  //
  // sessionId is stamped AFTER the spread. It has to match the channel we are
  // publishing to, so a caller must not be able to override it — or blank it by
  // passing `sessionId: undefined`, which would produce an event the consumer
  // boundary drops.
  const eventData: SessionEventEnvelope & Record<string, unknown> = {
    timestamp: Date.now(),
    excludeUserId,
    ...data,
    sessionId,
  };

  try {
    const channel = ably.channels.get(REALTIME_CHANNELS.session(sessionId));
    await channel.publish(event, eventData);
    ablyCircuitBreaker.recordSuccess();
    logger.info(`[Realtime] Published ${event} to session ${sessionId}`);

    // Automatically notify session members for non-transient events
    // This updates their session list without requiring each caller to remember
    if (!TRANSIENT_EVENTS.has(event)) {
      // Fire and forget - don't block on user channel updates
      notifySessionMembers(sessionId, excludeUserId).catch((err) =>
        logger.warn(`[Realtime] Failed to notify session members:`, err)
      );
    }
  } catch (error) {
    ablyCircuitBreaker.recordFailure('publishSessionEvent');
    logger.error(`[Realtime] Failed to publish ${event} to session ${sessionId}:`, error);
    throw error;
  }
}

/**
 * Publishes a user-level event to notify about session updates.
 * Used for home/sessions list updates when user is not in the session.
 *
 * @param userId - The user ID to publish to
 * @param event - The event type to publish
 * @param data - The event data payload (must include sessionId)
 * @returns Promise<void>
 */
export async function publishUserEvent<
  E extends UserEventType,
  T extends UserEventPublishData<E>,
>(
  userId: string,
  event: E,
  data: T & NoExtraUserEventKeys<E, T>
): Promise<void> {
  if (shouldSkipAblyInE2E()) {
    logger.info(`[Realtime] E2E mode without ABLY_API_KEY - skipping ${event} publish for user ${userId}`);
    return;
  }

  // Circuit breaker fast-fail
  const userCbStats = ablyCircuitBreaker.getStats();
  if (userCbStats.state === 'OPEN') {
    logger.warn(`[Realtime] Ably circuit breaker OPEN - skipping ${event} publish for user ${userId}`);
    return;
  }

  const ably = getAbly();

  // Typed as the contract envelope rather than UserEventData: `data` is now the
  // generic exact-payload type, which carries no index signature.
  const eventData: UserEventEnvelope & Record<string, unknown> = {
    ...data,
    timestamp: Date.now(),
  };

  try {
    const channel = ably.channels.get(REALTIME_CHANNELS.user(userId));
    await channel.publish(event, eventData);
    ablyCircuitBreaker.recordSuccess();
    logger.info(`[Realtime] Published ${event} to user ${userId} for session ${data.sessionId}`);
  } catch (error) {
    ablyCircuitBreaker.recordFailure('publishUserEvent');
    logger.error(`[Realtime] Failed to publish ${event} to user ${userId}:`, error);
    // Don't throw - user channel failures shouldn't break operations
  }
}

/**
 * Notifies all members of a session that there's an update.
 * Publishes to each member's user channel so their session list updates.
 * Also touches session.updatedAt so the unread count calculation picks up the change.
 *
 * @param sessionId - The session ID
 * @param excludeUserId - Optional user ID to exclude (e.g., the user who caused the update)
 */
export async function notifySessionMembers(
  sessionId: string,
  excludeUserId?: string
): Promise<void> {
  logger.info(`[notifySessionMembers] Called for session ${sessionId}, excludeUserId=${excludeUserId}`);
  try {
    // Import prisma here to avoid circular dependency
    const { prisma } = await import('../lib/prisma');

    // Touch session.updatedAt so unread count calculation picks up the change
    // Also fetch session members in the same query
    const now = new Date();
    logger.info(`[notifySessionMembers] Updating session.updatedAt to ${now.toISOString()}`);

    // TS-10: the members are the session's participants (user-keyed channels).
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: { updatedAt: now },
      select: {
        updatedAt: true,
        participants: { where: { userId: { not: null }, leftAt: null }, select: { userId: true } },
      },
    });

    logger.info(`[notifySessionMembers] Session updated, new updatedAt: ${session.updatedAt.toISOString()}`);

    if (!session?.participants) {
      logger.warn(`[notifySessionMembers] Session ${sessionId} not found or has no members`);
      return;
    }

    // Publish to each member's user channel (except the excluded user)
    const memberIds = session.participants
      .map((m: { userId: string | null }) => m.userId)
      .filter((id): id is string => !!id && id !== excludeUserId);

    logger.info(`[notifySessionMembers] Publishing to ${memberIds.length} members: ${memberIds.join(', ')}`);

    await Promise.all(
      memberIds.map((userId: string) =>
        publishUserEvent(userId, 'session.updated', { sessionId })
      )
    );

    logger.info(`[notifySessionMembers] Notified ${memberIds.length} members of session ${sessionId}`);
  } catch (error) {
    logger.error('[notifySessionMembers] Error:', error);
    // Don't throw - notification failures shouldn't break the main operation
  }
}

// ============================================================================
// Presence Management
// ============================================================================

/**
 * Checks if a user is present (online) in a session's presence channel.
 *
 * @param sessionId - The session ID
 * @param userId - The user ID to check
 * @returns Promise<boolean> - true if user is present
 */
export async function isUserPresent(sessionId: string, userId: string): Promise<boolean> {
  if (shouldSkipAblyInE2E()) {
    return false;
  }

  const ably = getAbly();

  try {
    const presenceChannel = ably.channels.get(REALTIME_CHANNELS.presence(sessionId));
    const presenceResult = await presenceChannel.presence.get();
    // Ably v2 returns a PaginatedResult, need to access .items
    const members = presenceResult.items || [];
    return members.some((m: Ably.PresenceMessage) => m.clientId === userId);
  } catch (error) {
    logger.error(`[Realtime] Failed to check presence for user ${userId}:`, error);
    return false;
  }
}

/**
 * Get all present users in a session.
 *
 * @param sessionId - The session ID
 * @returns Promise<string[]> - Array of user IDs currently present
 */
export async function getSessionPresence(sessionId: string): Promise<string[]> {
  if (shouldSkipAblyInE2E()) {
    return [];
  }

  const ably = getAbly();

  try {
    const presenceChannel = ably.channels.get(REALTIME_CHANNELS.presence(sessionId));
    const presenceResult = await presenceChannel.presence.get();
    const members = presenceResult.items || [];
    return members.map((m: Ably.PresenceMessage) => m.clientId).filter(Boolean) as string[];
  } catch (error) {
    logger.error(`[Realtime] Failed to get presence for session ${sessionId}:`, error);
    return [];
  }
}

/**
 * Publish a presence update for a user.
 *
 * @param sessionId - The session ID
 * @param userId - The user ID
 * @param status - The presence status
 * @param userName - Optional user name
 */
export async function publishPresenceUpdate(
  sessionId: string,
  userId: string,
  status: PresenceStatus,
  userName?: string
): Promise<void> {
  const event = status === PresenceStatus.ONLINE
    ? 'presence.online'
    : status === PresenceStatus.OFFLINE
      ? 'presence.offline'
      : 'presence.away';

  await publishSessionEvent(sessionId, event, {
    userId,
    name: userName,
    status,
  });
}

// ============================================================================
// Typing Indicators
// ============================================================================

/**
 * Publish a typing indicator update.
 *
 * @param sessionId - The session ID
 * @param userId - The user ID who is typing
 * @param isTyping - Whether the user is typing
 */
export async function publishTypingIndicator(
  sessionId: string,
  userId: string,
  isTyping: boolean
): Promise<void> {
  const key = getTypingKey(sessionId, userId);
  const currentState = typingStates.get(key);

  // Debounce: only publish if state actually changed
  if (currentState?.isTyping === isTyping) {
    typingStates.set(key, { isTyping, lastUpdate: Date.now() });
    return;
  }

  typingStates.set(key, { isTyping, lastUpdate: Date.now() });

  const event = isTyping ? 'typing.start' : 'typing.stop';
  await publishSessionEvent(sessionId, event, {
    userId,
    isTyping,
  }, userId); // Exclude the typing user from receiving their own typing event
}

/**
 * Get typing state for a user in a session.
 *
 * @param sessionId - The session ID
 * @param userId - The user ID
 * @returns The typing state or null if not found
 */
export function getTypingState(sessionId: string, userId: string): TypingState | null {
  const key = getTypingKey(sessionId, userId);
  const state = typingStates.get(key);

  if (!state) return null;

  // Check if typing has timed out
  if (state.isTyping && Date.now() - state.lastUpdate > TYPING_TIMEOUT) {
    typingStates.set(key, { isTyping: false, lastUpdate: Date.now() });
    return { isTyping: false, lastUpdate: Date.now() };
  }

  return state;
}

/**
 * Clear typing state for a user in a session.
 *
 * @param sessionId - The session ID
 * @param userId - The user ID
 */
export function clearTypingState(sessionId: string, userId: string): void {
  const key = getTypingKey(sessionId, userId);
  typingStates.delete(key);
}

/**
 * Clear all typing states for a session.
 *
 * @param sessionId - The session ID
 */
export function clearSessionTypingStates(sessionId: string): void {
  for (const key of typingStates.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      typingStates.delete(key);
    }
  }
}

// ============================================================================
// Stage Progress Sync
// ============================================================================

/**
 * Publish a stage progress update to notify partner.
 *
 * @param sessionId - The session ID
 * @param userId - The user who progressed
 * @param stage - The current stage number
 * @param status - The stage status
 */
export async function publishStageProgress(
  sessionId: string,
  userId: string,
  stage: number,
  status: 'in_progress' | 'gate_pending' | 'completed'
): Promise<void> {
  await publishSessionEvent(sessionId, 'stage.progress', {
    userId,
    stage,
    status,
  }, userId);
}

/**
 * Publish a stage waiting notification when one partner is ahead.
 *
 * @param sessionId - The session ID
 * @param waitingUserId - The user who is waiting
 * @param stage - The stage they are waiting at
 */
export async function publishStageWaiting(
  sessionId: string,
  waitingUserId: string,
  stage: number
): Promise<void> {
  await publishSessionEvent(sessionId, 'stage.waiting', {
    userId: waitingUserId,
    stage,
    status: 'gate_pending',
  }, waitingUserId);
}

// ============================================================================
// Session State Updates
// ============================================================================

/**
 * Publish a session paused event.
 *
 * @param sessionId - The session ID
 * @param pausedByUserId - The user who paused the session
 * @param reason - Optional reason for pausing
 */
export async function publishSessionPaused(
  sessionId: string,
  pausedByUserId: string,
  reason?: string
): Promise<void> {
  await publishSessionEvent(sessionId, 'session.paused', {
    pausedBy: pausedByUserId,
    reason,
  });

  // Clear typing states when session is paused
  clearSessionTypingStates(sessionId);
}

/**
 * Publish a session resumed event.
 *
 * @param sessionId - The session ID
 * @param resumedByUserId - The user who resumed the session
 */
export async function publishSessionResumed(
  sessionId: string,
  resumedByUserId: string
): Promise<void> {
  await publishSessionEvent(sessionId, 'session.resumed', {
    resumedBy: resumedByUserId,
  });
}

/**
 * Publish a session resolved event.
 *
 * @param sessionId - The session ID
 * @param resolvedByUserId - The user who resolved the session
 */
export async function publishSessionResolved(
  sessionId: string,
  resolvedByUserId: string
): Promise<void> {
  await publishSessionEvent(sessionId, 'session.resolved', {
    resolvedBy: resolvedByUserId,
  });

  // Clear typing states when session is resolved
  clearSessionTypingStates(sessionId);
}

// ============================================================================
// Partner Notification (with fallback to push)
// ============================================================================

/**
 * Notifies a partner of a session event.
 * If the partner is online (present in the Ably channel), the event is published.
 * If the partner is offline, a push notification is sent instead.
 * Also publishes to the partner's user channel for session list updates.
 *
 * @param sessionId - The session ID
 * @param partnerId - The partner's user ID
 * @param event - The event type
 * @param data - The event data payload
 * @param options - Optional configuration
 * @param options.excludeUserId - User ID to exclude from receiving the Ably event (typically the actor)
 */
export async function notifyPartner<
  E extends SessionEvent,
  T extends SessionEventPublishData<E>,
>(
  sessionId: string,
  partnerId: string,
  event: E,
  data: T & NoExtraSessionEventKeys<E, T>,
  options?: { excludeUserId?: string }
): Promise<void> {
  if (shouldSkipAblyInE2E()) {
    logger.info(`[Realtime] E2E mode without ABLY_API_KEY - skipping partner ${event} notification for session ${sessionId}`);
    return;
  }

  // Always publish to session channel (for clients viewing the session)
  // This also calls notifySessionMembers which updates session.updatedAt
  // and publishes to all members' user channels
  // Optionally exclude the actor from receiving their own event to prevent race conditions
  await publishSessionEvent(sessionId, event, data, options?.excludeUserId);

  // If partner is not in the session, also send push notification
  const partnerPresent = await isUserPresent(sessionId, partnerId);
  if (!partnerPresent) {
    await sendPushNotification(partnerId, event, data, sessionId);
  }
}

/**
 * Notifies a partner and always publishes to Ably channel.
 * If partner is offline, also sends a push notification.
 * Also publishes to the partner's user channel for session list updates.
 *
 * @param sessionId - The session ID
 * @param partnerId - The partner's user ID
 * @param event - The event type
 * @param data - The event data payload
 */
export async function notifyPartnerWithFallback<
  E extends SessionEvent,
  T extends SessionEventPublishData<E>,
>(
  sessionId: string,
  partnerId: string,
  event: E,
  data: T & NoExtraSessionEventKeys<E, T>
): Promise<void> {
  if (shouldSkipAblyInE2E()) {
    logger.info(`[Realtime] E2E mode without ABLY_API_KEY - skipping partner ${event} fallback notification for session ${sessionId}`);
    return;
  }

  // Always publish to Ably for clients that might reconnect
  // Note: publishSessionEvent automatically notifies all session members
  await publishSessionEvent(sessionId, event, data);

  // Also send push if partner is offline
  const partnerPresent = await isUserPresent(sessionId, partnerId);
  if (!partnerPresent) {
    await sendPushNotification(partnerId, event, data, sessionId);
  }
}

// ============================================================================
// Channel Names (re-export from shared)
// ============================================================================

/**
 * Get the Ably channel name for a session.
 *
 * @param sessionId - The session ID
 * @returns The Ably channel name
 */
export function getSessionChannelName(sessionId: string): string {
  return REALTIME_CHANNELS.session(sessionId);
}

/**
 * Get the Ably channel name for a user's private channel.
 *
 * @param userId - The user ID
 * @returns The Ably channel name
 */
export function getUserChannelName(userId: string): string {
  return REALTIME_CHANNELS.user(userId);
}

// ============================================================================
// Audit Stream (for Neural Monitor dashboard)
// ============================================================================

/**
 * Publish a session-created event to the audit stream for monitoring dashboards.
 * This is separate from session-specific events - it goes to a global audit channel.
 *
 * @param sessionId - The session ID
 * @param sessionData - Basic session information for the dashboard
 */
export async function publishSessionCreated(
  sessionId: string,
  sessionData: {
    type: string;
    status: string;
    createdAt: string;
    members?: Array<{ userId: string; name?: string }>;
  }
): Promise<void> {
  if (process.env.ENABLE_AUDIT_STREAM !== 'true') {
    return; // Audit stream disabled
  }

  try {
    const ably = getAbly();
    const channel = ably.channels.get('ai-audit-stream');
    await channel.publish('session-created', {
      sessionId,
      timestamp: Date.now(),
      ...sessionData,
    });
    logger.info(`[Realtime] Published session-created to audit stream for ${sessionId}`);
  } catch (error) {
    // Don't throw - audit stream failures shouldn't break session creation
    logger.warn(`[Realtime] Failed to publish session-created to audit stream:`, error);
  }
}

// ============================================================================
// Fire-and-Forget Message Events
// ============================================================================

/**
 * The metadata tail of a `message.ai_response`, derived FROM the contract rather
 * than declared alongside it.
 *
 * This matters: `metadata` is spread into the payload, and TypeScript does not
 * excess-check properties introduced through a spread. If this were an inline
 * literal type, a field added here would ship on the wire without ever touching
 * the contract or the DTO. Deriving it means adding a statically-visible field
 * requires adding it to `contracts/realtime.ts` first — see the scope note in
 * that module's docblock for what type-level checking cannot cover.
 */
type MessageAIResponseMetadata = Omit<
  SessionEventPublishData<'message.ai_response'>,
  'sessionId' | 'timestamp' | 'excludeUserId' | 'forUserId' | 'message'
>;

/**
 * Rejects metadata keys the contract does not declare, including via a widened
 * variable — excess-property checking alone only covers fresh object literals.
 */
type NoExtraMetadataKeys<T> = {
  [K in Exclude<keyof T, keyof MessageAIResponseMetadata>]?: never;
};

/**
 * Publish an AI response message via Ably for fire-and-forget message flow.
 * Called after background AI processing completes.
 *
 * @param sessionId - The session ID
 * @param forUserId - The user ID this response is for
 * @param message - The AI response message DTO
 * @param metadata - Optional metadata for UI updates (feel heard check, invitation, etc.)
 */
export async function publishMessageAIResponse<T extends MessageAIResponseMetadata>(
  sessionId: string,
  forUserId: string,
  message: MessageDTO,
  metadata?: T & NoExtraMetadataKeys<T>
): Promise<void> {
  if (shouldSkipAblyInE2E()) {
    logger.info(`[Realtime] E2E mode without ABLY_API_KEY - skipping message.ai_response publish for session ${sessionId}`);
    return;
  }

  const ably = getAbly();

  // R36 / work-t4zp: the session channel reaches every participant's device
  // (forUserId is a client-side filter), so the private reply never rides it:
  // no message, no proposed statement — the addressed flags and the message id
  // only. The addressed client refetches its own conversation over the API.
  // Typed against BOTH the DTO and the contract, so the two cannot drift apart
  // without a compile error.
  const { proposedEmpathyStatement: _private, ...flags } = (metadata ?? {}) as MessageAIResponseMetadata;
  void _private;
  const payload: MessageAIResponsePayload &
    SessionEventPublishData<'message.ai_response'> = {
    sessionId,
    timestamp: Date.now(),
    forUserId,
    messageId: message.id,
    ...flags,
  };

  try {
    const channel = ably.channels.get(REALTIME_CHANNELS.session(sessionId));
    await channel.publish('message.ai_response', payload);
    logger.info(`[Realtime] Published message.ai_response to session ${sessionId} for user ${forUserId}`);

    // Also notify session members for list updates (but exclude the user who sent the message
    // since they're already subscribed to the session channel)
    notifySessionMembers(sessionId).catch((err) =>
      logger.warn(`[Realtime] Failed to notify session members after AI response:`, err)
    );
  } catch (error) {
    logger.error(`[Realtime] Failed to publish message.ai_response to session ${sessionId}:`, error);
    throw error;
  }
}

/**
 * Publish a message processing error via Ably for fire-and-forget message flow.
 * Called when background AI processing fails.
 *
 * @param sessionId - The session ID
 * @param forUserId - The user ID this error is for
 * @param userMessageId - The ID of the user message that failed
 * @param errorMessage - User-friendly error message
 * @param canRetry - Whether the user can retry sending the message
 */
export async function publishMessageError(
  sessionId: string,
  forUserId: string,
  userMessageId: string,
  errorMessage: string,
  canRetry: boolean = true
): Promise<void> {
  if (shouldSkipAblyInE2E()) {
    logger.info(`[Realtime] E2E mode without ABLY_API_KEY - skipping message.error publish for session ${sessionId}`);
    return;
  }

  const ably = getAbly();

  const payload: MessageErrorPayload & SessionEventPublishData<'message.error'> = {
    sessionId,
    timestamp: Date.now(),
    forUserId,
    userMessageId,
    error: errorMessage,
    canRetry,
  };

  try {
    const channel = ably.channels.get(REALTIME_CHANNELS.session(sessionId));
    await channel.publish('message.error', payload);
    logger.info(`[Realtime] Published message.error to session ${sessionId} for user ${forUserId}`);
  } catch (error) {
    logger.error(`[Realtime] Failed to publish message.error to session ${sessionId}:`, error);
    // Don't throw - we don't want to lose error notifications due to Ably issues
  }
}

// ============================================================================
// Context Assembly Events (for Neural Monitor Dashboard)
// ============================================================================

/**
 * Publish a context.updated event when context has been assembled for a user.
 * Used by the Neural Monitor dashboard to trigger context display refresh.
 *
 * @param sessionId - The session ID
 * @param userId - The user ID whose context was assembled
 * @param assembledAt - ISO timestamp when the context was assembled
 */
/**
 * Publish a pending action notification to a specific user.
 * Triggers badge count update in the activity menu.
 *
 * @param sessionId - The session ID
 * @param userId - The user who has a new pending action
 * @param actionType - The type of pending action
 * @param actionId - The ID of the action item
 */
export async function publishPendingAction(
  sessionId: string,
  userId: string,
  actionType: 'share_offer' | 'validate_empathy' | 'context_received',
  actionId: string
): Promise<void> {
  await publishSessionEvent(sessionId, 'notification.pending_action', {
    forUserId: userId,
    actionType,
    actionId,
  });
}

/**
 * Publish an empathy resubmitted event when guesser refines their empathy.
 * Notifies the subject so they can see the updated attempt.
 *
 * @param sessionId - The session ID
 * @param forUserId - The subject user ID (who should see the update)
 * @param guesserUserId - The guesser who resubmitted
 */
export async function publishEmpathyResubmitted(
  sessionId: string,
  forUserId: string,
  guesserUserId: string
): Promise<void> {
  await publishSessionEvent(sessionId, 'empathy.resubmitted', {
    forUserId,
    guesserUserId,
  });
}

export async function publishContextUpdated(
  sessionId: string,
  userId: string,
  assembledAt: string
): Promise<void> {
  if (shouldSkipAblyInE2E()) {
    logger.info(`[Realtime] E2E mode without ABLY_API_KEY - skipping context.updated publish for session ${sessionId}`);
    return;
  }

  const ably = getAbly();

  const payload: ContextUpdatedPayload & SessionEventPublishData<'context.updated'> = {
    sessionId,
    timestamp: Date.now(),
    userId,
    assembledAt,
  };

  try {
    const channel = ably.channels.get(REALTIME_CHANNELS.session(sessionId));
    await channel.publish('context.updated', payload);
    logger.info(`[Realtime] Published context.updated for user ${userId} to session ${sessionId}`);
  } catch (error) {
    logger.error(`[Realtime] Failed to publish context.updated to session ${sessionId}:`, error);
    // Don't throw - this is a non-critical event for dashboard monitoring only
  }
}
