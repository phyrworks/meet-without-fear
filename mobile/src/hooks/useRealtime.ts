/**
 * useRealtime Hook for Meet Without Fear Mobile
 *
 * Provides WebSocket connection management, event subscriptions,
 * and reconnection logic using Ably for real-time functionality.
 *
 * IMPORTANT: This hook uses a singleton Ably client that exists outside
 * the React component lifecycle. This ensures connections survive Fast
 * Refresh/Live Reload during development.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import Ably from 'ably';
import {
  ConnectionStatus,
  ConnectionState,
  SessionEventType,
  SessionEventData,
  PresenceStatus,
  REALTIME_CHANNELS,
  UserEventType,
  UserEventData,
  MessageAIResponsePayload,
  MessageErrorPayload,
  parseSessionEvent,
  parseUserEventData,
  isKnownUserEventName,
  isKnownSessionEventName,
} from '@meet-without-fear/shared';
import { useQueryClient } from '@tanstack/react-query';
import { sessionKeys } from './queryKeys';
import { useAuth } from './useAuth';
import {
  getAblyClient,
  getAblyClientSync,
  reconnectAbly,
  getAblyConnectionState,
  refreshAblyToken,
} from '../lib/ably';
import { isRealtimePayloadAddressedToCurrentUser } from '../utils/realtimePrivacy';

// ============================================================================
// Types
// ============================================================================

export interface RealtimeConfig {
  /** Session ID to subscribe to */
  sessionId: string;
  /** Whether to enable the realtime subscription (default: true). Set false to pause. */
  enabled?: boolean;
  /** Whether to enable presence tracking */
  enablePresence?: boolean;
  /** Callback when connection state changes */
  onConnectionChange?: (state: ConnectionState) => void;
  /** Callback when partner presence changes */
  onPresenceChange?: (userId: string, status: PresenceStatus) => void;
  /** Callback when partner starts/stops typing */
  onTypingChange?: (userId: string, isTyping: boolean) => void;
  /** Callback for session events */
  onSessionEvent?: (event: SessionEventType, data: SessionEventData) => void;
  /** Callback for stage progress updates */
  onStageProgress?: (userId: string, stage: number, status: string) => void;
  /** Callback when AI response arrives (fire-and-forget pattern) */
  onAIResponse?: (payload: MessageAIResponsePayload) => void;
  /** Callback when AI processing fails (fire-and-forget pattern) */
  onAIError?: (payload: MessageErrorPayload) => void;
}

export interface RealtimeState {
  /** Current connection status */
  connectionStatus: ConnectionStatus;
  /** Whether the partner is online */
  partnerOnline: boolean;
  /** Whether the partner is typing */
  partnerTyping: boolean;
  /** Partner's current stage (if known) */
  partnerStage?: number;
  /** Last error message */
  error?: string;
}

export interface RealtimeActions {
  /** Send typing indicator */
  sendTyping: (isTyping: boolean) => void;
  /** Manually reconnect */
  reconnect: () => void;
  /** Disconnect from realtime */
  disconnect: () => void;
}

// ============================================================================
// Ably Types
// ============================================================================

type AblyRealtimeChannel = Ably.RealtimeChannel;

// ============================================================================
// Validation Failure Reporting
// ============================================================================

type SentryBreadcrumb = {
  category: string;
  message: string;
  level: string;
  data: Record<string, unknown>;
};

/**
 * Resolved lazily rather than imported at module scope.
 *
 * `@sentry/react-native` ships ESM and is not in Jest's `transformIgnorePatterns`,
 * so a static import here fails to parse in every suite that transitively pulls
 * in this hook — not just the ones testing it. Resolving on first use keeps that
 * blast radius at zero: the require only runs when a validation actually fails,
 * which is never in unrelated suites. Mirrors the lazy `expo-updates` load in
 * `useOTAUpdate.ts`.
 */
let cachedAddBreadcrumb: ((breadcrumb: SentryBreadcrumb) => void) | null | undefined;

function getAddBreadcrumb(): ((breadcrumb: SentryBreadcrumb) => void) | null {
  if (cachedAddBreadcrumb === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cachedAddBreadcrumb = require('@sentry/react-native').addBreadcrumb ?? null;
    } catch {
      cachedAddBreadcrumb = null;
    }
  }
  return cachedAddBreadcrumb ?? null;
}

/**
 * Reduce a wire event name to something safe to report.
 *
 * `message.name` is treated as ATTACKER-CONTROLLED. Clients may publish only on
 * `meetwithoutfear:typing:{id}` (the session channel is subscribe-only since
 * work-k5fk.32 S8; `backend/src/controllers/auth.ts` ablyCapabilityFor), and
 * only typing names are handled from there — but a name is still never trusted
 * into a report, in case a compromised partner client publishes arbitrary text,
 * including the user's private content. The app's `beforeBreadcrumb` hook
 * (`mobile/app/_layout.tsx:57`) strips known PII *keys*, not arbitrary *values*,
 * so an unsanitized name would sail straight through into Sentry.
 *
 * Names in the contract's registry are safe compile-time constants; anything
 * else is collapsed to 'unknown'. Diagnosing contract drift only ever needs the
 * known names, so nothing of value is lost.
 */
function safeEventName(name: string | undefined, channel: 'session' | 'user'): string {
  if (!name) return 'unknown';
  const isKnown = channel === 'session' ? isKnownSessionEventName(name) : isKnownUserEventName(name);
  return isKnown ? name : 'unknown';
}

/**
 * Report a realtime payload that failed contract validation.
 *
 * Nothing should ever reach here: the backend typechecks its publish call sites
 * against the same shapes the consumer validates with, so a failure means the
 * two have drifted. That makes it worth alarming on rather than leaving in a dev
 * console nobody reads in production.
 *
 * PRIVACY: the breadcrumb carries a SANITIZED event name and the failure reason
 * only. Never the payload — realtime payloads carry empathy statements, shared
 * context and need descriptions, and several are addressed to one partner.
 * Session and user IDs are omitted too; the event name plus reason is enough to
 * identify a drifted contract, and anything more would put private content in
 * crash reports. `dropped` distinguishes a real drop from a payload we delivered
 * anyway because its handler never reads it.
 *
 * NEVER THROWS. This runs inside the Ably subscribe callback, where an escaping
 * exception would abort event processing — and on the user channel would skip
 * the refetch that a malformed-but-delivered event still owes. Reporting must
 * never be able to break delivery, so every failure path here is swallowed.
 *
 * Safe on web: `shims/sentry-web.ts` makes addBreadcrumb a no-op.
 */
function reportRealtimeValidationFailure(params: {
  channel: 'session' | 'user';
  eventName: string | undefined;
  reason: string;
  dropped: boolean;
}): void {
  const { channel, eventName, reason, dropped } = params;
  try {
    const addBreadcrumb = getAddBreadcrumb();
    if (typeof addBreadcrumb !== 'function') return;
    addBreadcrumb({
      category: 'realtime-validation',
      message: dropped
        ? `Dropped malformed ${channel} event`
        : `Malformed ${channel} event delivered (payload not read by handler)`,
      level: 'warning',
      data: { event: safeEventName(eventName, channel), reason, dropped },
    });
  } catch {
    // Reporting is best-effort and must never interrupt realtime delivery.
  }
}

// ============================================================================
// Connection State Mapping
// ============================================================================

function mapAblyState(state: string): ConnectionStatus {
  switch (state) {
    case 'initialized':
    case 'connecting':
      return ConnectionStatus.CONNECTING;
    case 'connected':
      return ConnectionStatus.CONNECTED;
    case 'disconnected':
    case 'closing':
    case 'closed':
      return ConnectionStatus.DISCONNECTED;
    case 'suspended':
      return ConnectionStatus.SUSPENDED;
    case 'failed':
      return ConnectionStatus.FAILED;
    default:
      return ConnectionStatus.DISCONNECTED;
  }
}

// ============================================================================
// useRealtime Hook
// ============================================================================

/**
 * Hook for managing real-time WebSocket connections and subscriptions.
 * Uses a singleton Ably client that survives component remounts and live reload.
 *
 * @param config - Configuration options for the realtime connection
 * @returns Current state and actions for real-time functionality
 */
export function useRealtime(config: RealtimeConfig): RealtimeState & RealtimeActions {
  const {
    sessionId,
    enabled: realtimeEnabled = true,
    enablePresence = true,
    onConnectionChange,
    onPresenceChange,
    onTypingChange,
    onSessionEvent,
    onStageProgress,
    onAIResponse,
    onAIError,
  } = config;

  const { user } = useAuth();

  // State
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(() => {
    // Initialize from singleton state
    return mapAblyState(getAblyConnectionState());
  });
  const [partnerOnline, setPartnerOnline] = useState(false);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [partnerStage, setPartnerStage] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Refs for channel and subscription management
  const channelRef = useRef<AblyRealtimeChannel | null>(null);
  // Typing has its own channel: the session channel is subscribe-only for clients (work-k5fk.32 S8).
  const typingChannelRef = useRef<AblyRealtimeChannel | null>(null);
  const presenceChannelRef = useRef<AblyRealtimeChannel | null>(null);
  const connectionListenerRef = useRef<((stateChange: Ably.ConnectionStateChange) => void) | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingRef = useRef<boolean>(false);
  const isMountedRef = useRef(true);
  const reconnectAttemptsRef = useRef(0);

  // Synchronous ref for user ID — prevents stale closure from leaking
  // messages to the wrong user during auth transitions or app backgrounding
  const userIdRef = useRef(user?.id);
  userIdRef.current = user?.id;

  // Store callbacks in refs to avoid stale closures
  const callbacksRef = useRef({
    onConnectionChange,
    onPresenceChange,
    onTypingChange,
    onSessionEvent,
    onStageProgress,
    onAIResponse,
    onAIError,
  });
  callbacksRef.current = {
    onConnectionChange,
    onPresenceChange,
    onTypingChange,
    onSessionEvent,
    onStageProgress,
    onAIResponse,
    onAIError,
  };

  // ============================================================================
  // Connection State Handler
  // ============================================================================

  const handleConnectionStateChange = useCallback(
    (stateChange: { current: string; reason?: { message: string } }) => {
      if (!isMountedRef.current) return;

      const status = mapAblyState(stateChange.current);
      setConnectionStatus(status);

      const state: ConnectionState = {
        status,
        error: stateChange.reason?.message,
        lastConnected: status === ConnectionStatus.CONNECTED ? Date.now() : undefined,
        reconnectAttempts: reconnectAttemptsRef.current,
      };

      if (status === ConnectionStatus.CONNECTED) {
        reconnectAttemptsRef.current = 0;
        setError(undefined);
      } else if (status === ConnectionStatus.FAILED) {
        setError(stateChange.reason?.message || 'Connection failed');
      }

      callbacksRef.current.onConnectionChange?.(state);
    },
    []
  );

  // ============================================================================
  // Message Handler
  // ============================================================================

  const handleMessage = useCallback(
    (message: Ably.Message) => {
      if (!isMountedRef.current) return;

      // Use ref for user ID — avoids stale closure during auth transitions
      const currentUserId = userIdRef.current;
      if (!currentUserId) return;

      // Validate at the boundary against the shared realtime contract, so no
      // unchecked payload reaches a handler. An unrecognised event NAME is not a
      // failure — it falls back to envelope validation and is still delivered, so
      // a newer backend can ship an event this client does not know about yet.
      const parsed = parseSessionEvent(message.name ?? '', message.data);
      if (parsed.kind === 'invalid') {
        // Raw name only in dev, where Sentry is disabled (`enabled: !__DEV__`).
        // In production Sentry's console integration turns this into a
        // breadcrumb too, so it gets the same sanitizing as the explicit one.
        console.warn(
          '[Realtime] Dropping malformed event payload:',
          __DEV__ ? message.name : safeEventName(message.name, 'session'),
          parsed.reason
        );
        reportRealtimeValidationFailure({
          channel: 'session',
          eventName: message.name,
          reason: parsed.reason,
          dropped: true,
        });
        return;
      }

      const eventName = parsed.event as SessionEventType;
      const eventData = parsed.data;

      // Skip events from ourselves
      if (eventData.excludeUserId === currentUserId) {
        return;
      }

      // Session channels are broadcast. Drop private payloads for other users
      // before they reach screen-level handlers.
      if (!isRealtimePayloadAddressedToCurrentUser(eventData, currentUserId)) {
        console.log(
          '[Realtime] Dropping event addressed to a different user:',
          __DEV__ ? eventName : safeEventName(eventName, 'session')
        );
        return;
      }

      if (parsed.kind === 'unknown-event') {
        callbacksRef.current.onSessionEvent?.(eventName, eventData as SessionEventData);
        return;
      }

      // Handle specific events. `parsed.data` is narrowed to the event's payload
      // by the switch — the casts these branches used to need are gone.
      switch (parsed.event) {
        case 'typing.start':
          setPartnerTyping(true);
          callbacksRef.current.onTypingChange?.(parsed.data.userId || '', true);
          break;

        case 'typing.stop':
          setPartnerTyping(false);
          callbacksRef.current.onTypingChange?.(parsed.data.userId || '', false);
          break;

        case 'presence.online':
          setPartnerOnline(true);
          callbacksRef.current.onPresenceChange?.(parsed.data.userId || '', PresenceStatus.ONLINE);
          break;

        case 'presence.offline':
          setPartnerOnline(false);
          setPartnerTyping(false);
          callbacksRef.current.onPresenceChange?.(parsed.data.userId || '', PresenceStatus.OFFLINE);
          break;

        case 'presence.away':
          callbacksRef.current.onPresenceChange?.(parsed.data.userId || '', PresenceStatus.AWAY);
          break;

        case 'stage.progress':
        case 'stage.waiting':
          if (parsed.data.stage !== undefined) {
            setPartnerStage(parsed.data.stage);
            callbacksRef.current.onStageProgress?.(
              parsed.data.userId || '',
              parsed.data.stage,
              parsed.data.status || 'unknown'
            );
          }
          break;

        // Fire-and-forget message events
        case 'message.ai_response':
          if (callbacksRef.current.onAIResponse) {
            // Only handle if this message is for the current user
            if (parsed.data.forUserId === currentUserId) {
              // Wire-derived: dev only. Sentry's console integration turns
              // console args into breadcrumbs in production.
              if (__DEV__) {
                console.log('[Realtime] AI response received:', parsed.data.message?.id);
              }
              callbacksRef.current.onAIResponse(
                parsed.data as unknown as MessageAIResponsePayload
              );
            }
          }
          break;

        case 'message.error':
          if (callbacksRef.current.onAIError) {
            // Only handle if this error is for the current user
            if (parsed.data.forUserId === currentUserId) {
              // Wire-derived error text: dev only (see note above).
              if (__DEV__) {
                console.log('[Realtime] AI error received:', parsed.data.error);
              }
              callbacksRef.current.onAIError(parsed.data as unknown as MessageErrorPayload);
            }
          }
          break;

        default:
          // Generic session event
          callbacksRef.current.onSessionEvent?.(eventName, eventData as SessionEventData);
          break;
      }
    },
    // userIdRef is read synchronously — no dependency on user?.id needed
    []
  );

  // ============================================================================
  // Subscription Setup
  // ============================================================================

  useEffect(() => {
    if (!sessionId || !user?.id || !realtimeEnabled) return;

    let isCleanedUp = false;
    let channel: AblyRealtimeChannel | null = null;
    let hasTriedTokenRefresh = false;

    const setupSubscription = async () => {
      try {
        console.log('[Realtime] Setting up subscription for session:', sessionId);

        // Get the singleton client
        const ably = await getAblyClient();

        if (isCleanedUp) {
          console.log('[Realtime] Cleanup already called, aborting setup');
          return;
        }

        // Subscribe to connection state changes
        const connectionListener = (stateChange: Ably.ConnectionStateChange) => {
          console.log('[Realtime] Connection state:', stateChange.current, stateChange.reason?.message || '');
          handleConnectionStateChange({
            current: stateChange.current,
            reason: stateChange.reason ? { message: stateChange.reason.message || 'Unknown error' } : undefined,
          });
        };
        ably.connection.on(connectionListener);
        connectionListenerRef.current = connectionListener;

        // Update initial connection status
        handleConnectionStateChange({ current: ably.connection.state });

        // Get the session channel
        const channelName = REALTIME_CHANNELS.session(sessionId);
        console.log('[Realtime] Subscribing to channel:', channelName);
        channel = ably.channels.get(channelName);
        channelRef.current = channel;

        // Subscribe to all events
        await channel.subscribe(handleMessage);
        if (isCleanedUp) {
          console.log('[Realtime] Cleanup called after subscribe, aborting setup');
          return;
        }

        // Typing indicators: the one channel clients publish on (work-k5fk.32 S8). Anything a partner client
        // publishes there other than typing.start / typing.stop is dropped, never handled as a session event.
        const typingChannel = ably.channels.get(REALTIME_CHANNELS.typing(sessionId));
        typingChannelRef.current = typingChannel;
        await typingChannel.subscribe((message: Ably.Message) => {
          if (message.name === 'typing.start' || message.name === 'typing.stop') handleMessage(message);
        });
        if (isCleanedUp) return;

        // Set up presence if enabled
        if (enablePresence) {
          console.log('[Realtime] Entering presence...');
          const presenceChannelName = REALTIME_CHANNELS.presence(sessionId);
          const presenceChannel = ably.channels.get(presenceChannelName);
          presenceChannelRef.current = presenceChannel;
          await presenceChannel.presence.enter({ name: user.name });
          if (isCleanedUp) {
            console.log('[Realtime] Cleanup called after presence enter, aborting setup');
            return;
          }
          console.log('[Realtime] Presence entered successfully');

          // Subscribe to presence events
          presenceChannel.presence.subscribe('enter', (member: Ably.PresenceMessage) => {
            if (isCleanedUp || !isMountedRef.current) return;
            console.log('[Realtime] Presence enter event:', member.clientId);
            if (member.clientId !== user.id) {
              setPartnerOnline(true);
              callbacksRef.current.onPresenceChange?.(member.clientId || '', PresenceStatus.ONLINE);
            }
          });

          presenceChannel.presence.subscribe('leave', (member: Ably.PresenceMessage) => {
            if (isCleanedUp || !isMountedRef.current) return;
            console.log('[Realtime] Presence leave event:', member.clientId);
            if (member.clientId !== user.id) {
              setPartnerOnline(false);
              setPartnerTyping(false);
              callbacksRef.current.onPresenceChange?.(member.clientId || '', PresenceStatus.OFFLINE);
            }
          });

          // Check current presence
          const members = await presenceChannel.presence.get();
          console.log('[Realtime] Current presence members:', members.map(m => m.clientId));
          const partnerPresent = members.some((m: Ably.PresenceMessage) => m.clientId !== user.id);
          console.log('[Realtime] Partner present:', partnerPresent);
          if (isMountedRef.current && !isCleanedUp) {
            setPartnerOnline(partnerPresent);
          }
        }

        console.log('[Realtime] Subscription setup complete');
      } catch (err) {
        // Check if this is a capability/access denied error or channel failed state
        // This can happen when connecting to a new session before the token was refreshed
        // Also check error.cause since Ably wraps the root cause
        const errorMessage = err instanceof Error ? err.message : String(err);
        const causeMessage = (err as { cause?: Error })?.cause?.message || '';
        const fullErrorText = `${errorMessage} ${causeMessage}`.toLowerCase();

        const isCapabilityError =
          fullErrorText.includes('denied access') ||
          fullErrorText.includes('capability') ||
          fullErrorText.includes('channel denied') ||
          fullErrorText.includes('channel state is failed');

        if (isCapabilityError && !hasTriedTokenRefresh && !isCleanedUp) {
          // Use warn instead of error since this is a recoverable situation
          console.warn('[Realtime] Capability error detected, will refresh token and retry...');
          console.log('[Realtime] Error message:', errorMessage);
          console.log('[Realtime] Cause message:', causeMessage);
          hasTriedTokenRefresh = true;

          try {
            const ably = await getAblyClient();
            const channelName = REALTIME_CHANNELS.session(sessionId);

            // Release the failed channel so we get a fresh one on retry
            // This is crucial - Ably caches channel objects and a failed channel stays failed
            console.log('[Realtime] Releasing failed channel:', channelName);
            ably.channels.release(channelName);
            channel = null;
            channelRef.current = null;

            // Refresh the token to get updated capabilities including the new session
            await refreshAblyToken();

            // Retry the subscription setup
            if (!isCleanedUp) {
              console.log('[Realtime] Token refreshed, retrying subscription...');
              await setupSubscription();
              return;
            }
          } catch (refreshErr) {
            console.error('[Realtime] Token refresh failed:', refreshErr);
          }
        } else if (!isCapabilityError) {
          // Not a capability error - this is unexpected, log as error
          console.error('[Realtime] Subscription setup error:', err);
        }
        // If isCapabilityError && hasTriedTokenRefresh, we already warned and tried refresh

        if (isMountedRef.current && !isCleanedUp) {
          setError(err instanceof Error ? err.message : 'Connection failed');
          setConnectionStatus(ConnectionStatus.FAILED);
        }
      }
    };

    setupSubscription();

    // Cleanup function - this is crucial for surviving live reload
    return () => {
      console.log('[Realtime] Cleaning up subscriptions for session:', sessionId);
      isCleanedUp = true;

      // Remove connection listener from singleton (don't close the client!)
      const ably = getAblyClientSync();
      if (ably && connectionListenerRef.current) {
        ably.connection.off(connectionListenerRef.current);
        connectionListenerRef.current = null;
      }

      // Unsubscribe from channel
      if (channel) {
        try {
          channel.unsubscribe();
        } catch (err) {
          console.warn('[Realtime] Error during channel cleanup:', err);
        }
      }
      if (typingChannelRef.current) {
        try {
          typingChannelRef.current.unsubscribe();
        } catch (err) {
          console.warn('[Realtime] Error during typing channel cleanup:', err);
        }
      }
      if (presenceChannelRef.current) {
        try {
          presenceChannelRef.current.presence.unsubscribe();
          presenceChannelRef.current.presence.leave().catch((err) => {
            console.warn('[Realtime] Error leaving presence:', err);
          });
        } catch (err) {
          console.warn('[Realtime] Error during presence cleanup:', err);
        }
      }

      channelRef.current = null;
      typingChannelRef.current = null;
      presenceChannelRef.current = null;

      // Clear typing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, [sessionId, user?.id, user?.name, enablePresence, realtimeEnabled, handleMessage, handleConnectionStateChange]);

  // ============================================================================
  // Track Mounted State
  // ============================================================================

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // ============================================================================
  // App State Handling
  // ============================================================================

  useEffect(() => {
    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        // App came to foreground - re-enter presence
        if (presenceChannelRef.current && enablePresence && user?.id) {
          console.log('[Realtime] App active - re-entering presence');
          try {
            await presenceChannelRef.current.presence.enter({ name: user.name });
          } catch (err) {
            console.warn('[Realtime] Failed to re-enter presence:', err);
          }
        }

        // Check if we need to reconnect
        const currentState = getAblyConnectionState();
        if (currentState !== 'connected' && currentState !== 'connecting') {
          console.log('[Realtime] App active - triggering reconnect');
          reconnectAbly();
        }
      } else if (nextAppState === 'background') {
        // App went to background - leave presence so partner sees offline immediately
        if (presenceChannelRef.current && enablePresence) {
          console.log('[Realtime] App background - leaving presence');
          presenceChannelRef.current.presence.leave().catch((err) => {
            console.warn('[Realtime] Failed to leave presence:', err);
          });
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [enablePresence, user]);

  // ============================================================================
  // Actions
  // ============================================================================

  const sendTyping = useCallback(
    (isTyping: boolean) => {
      if (!typingChannelRef.current || !user?.id) return;

      // Debounce typing events
      if (lastTypingRef.current === isTyping) return;
      lastTypingRef.current = isTyping;

      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }

      const event = isTyping ? 'typing.start' : 'typing.stop';
      typingChannelRef.current.publish(event, {
        userId: user.id,
        sessionId,
        isTyping,
        timestamp: Date.now(),
      });

      // Auto-stop typing after 5 seconds of no input
      if (isTyping) {
        typingTimeoutRef.current = setTimeout(() => {
          sendTyping(false);
        }, 5000);
      }
    },
    [sessionId, user]
  );

  const reconnect = useCallback(() => {
    console.log('[Realtime] Manual reconnect requested');
    reconnectAttemptsRef.current += 1;
    reconnectAbly();
  }, []);

  const disconnect = useCallback(() => {
    // For the singleton pattern, we don't actually disconnect the client
    // We just leave presence and clear local state
    console.log('[Realtime] Disconnect requested (clearing local state)');

    if (presenceChannelRef.current && enablePresence) {
      presenceChannelRef.current.presence.leave().catch((err) => {
        console.warn('[Realtime] Error leaving presence:', err);
      });
    }

    if (isMountedRef.current) {
      setPartnerOnline(false);
      setPartnerTyping(false);
    }
  }, [enablePresence]);

  // ============================================================================
  // Return Value
  // ============================================================================

  return {
    // State
    connectionStatus,
    partnerOnline,
    partnerTyping,
    partnerStage,
    error,
    // Actions
    sendTyping,
    reconnect,
    disconnect,
  };
}

// ============================================================================
// Convenience Hooks
// ============================================================================

/**
 * Hook for subscribing to typing indicators only.
 */
export function usePartnerTyping(sessionId: string): boolean {
  const { partnerTyping } = useRealtime({
    sessionId,
    enablePresence: false,
  });
  return partnerTyping;
}

/**
 * Hook for subscribing to partner presence only.
 */
export function usePartnerPresence(sessionId: string): {
  isOnline: boolean;
  status: ConnectionStatus;
} {
  const { partnerOnline, connectionStatus } = useRealtime({
    sessionId,
    enablePresence: true,
  });
  return { isOnline: partnerOnline, status: connectionStatus };
}

/**
 * Hook for session event subscriptions.
 */
export function useSessionEvents(
  sessionId: string,
  onEvent: (event: SessionEventType, data: SessionEventData) => void
): { connectionStatus: ConnectionStatus } {
  const { connectionStatus } = useRealtime({
    sessionId,
    enablePresence: false,
    onSessionEvent: onEvent,
  });
  return { connectionStatus };
}

// ============================================================================
// User-Level Session Updates Hook
// ============================================================================

/**
 * Configuration for user session updates hook
 */
interface UseUserSessionUpdatesConfig {
  /** Callback when a memory suggestion is received */
  onMemorySuggestion?: (suggestion: {
    id: string;
    suggestedContent: string;
    category: string;
    confidence: string;
    evidence: string;
    sessionId: string;
  }) => void;
  /** Whether to disable automatic query refetching on events */
  disableRefetch?: boolean;
  /** Whether to enable the subscription (default: true) */
  enabled?: boolean;
}

/**
 * Hook for subscribing to user-level session updates.
 * Automatically invalidates session queries when events are received.
 * Use this on the home screen or sessions list to get real-time updates.
 * Also receives memory suggestions targeted to this specific user.
 */
export function useUserSessionUpdates(
  config?: UseUserSessionUpdatesConfig
): { connectionStatus: ConnectionStatus } {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Store options in refs to avoid stale closures
  const optionsRef = useRef(config);
  optionsRef.current = config;

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(() => {
    return mapAblyState(getAblyConnectionState());
  });

  const channelRef = useRef<Ably.RealtimeChannel | null>(null);
  const connectionListenerRef = useRef<((stateChange: Ably.ConnectionStateChange) => void) | null>(null);
  const isMountedRef = useRef(true);

  const handleEvent = useCallback(
    (eventName: UserEventType, _data: UserEventData) => {
      // The payload is wire-derived and can carry private content, so it is
      // logged in dev only; production keeps just the sanitized event name.
      if (__DEV__) {
        console.log('[UserSessionUpdates] Received event:', eventName, _data);
      } else {
        console.log('[UserSessionUpdates] Received event:', safeEventName(eventName, 'user'));
      }

      // Handle memory suggestions targeted to this specific user
      if (eventName === 'memory.suggested') {
        const suggestion = (_data as { suggestion?: { id: string; suggestedContent: string; category: string; confidence: string; evidence: string } }).suggestion;
        if (suggestion && optionsRef.current?.onMemorySuggestion) {
          // Carries suggestedContent — the user's own private text. Dev only.
          if (__DEV__) {
            console.log('[UserSessionUpdates] Memory suggestion received:', suggestion);
          }
          optionsRef.current.onMemorySuggestion({
            ...suggestion,
            sessionId: _data.sessionId,
          });
        }
        return; // Don't refetch queries for memory suggestions
      }

      if (optionsRef.current?.disableRefetch) {
        console.log('[UserSessionUpdates] Refetch disabled by config');
        return;
      }

      console.log('[UserSessionUpdates] Refetching queries...');

      // Use refetchQueries to force immediate refetch (not just mark stale)
      // NOTE: We intentionally do NOT refetch sessionKeys.state here!
      // Session state is updated by mutation onSuccess handlers, and refetching
      // from Ably events can race with optimistic updates, overwriting them with
      // stale server data (fix for disappearing indicator bug).
      queryClient.refetchQueries({ queryKey: sessionKeys.lists() })
        .then(() => console.log('[UserSessionUpdates] Lists refetch complete'))
        .catch((err) => console.warn('[UserSessionUpdates] Lists refetch failed:', err));

      queryClient.refetchQueries({ queryKey: sessionKeys.unreadCount() })
        .then(() => console.log('[UserSessionUpdates] Unread count refetch complete'))
        .catch((err) => console.warn('[UserSessionUpdates] Unread count refetch failed:', err));
    },
    [queryClient]
  );

  useEffect(() => {
    // Skip if disabled or no user
    if (optionsRef.current?.enabled === false || !user?.id) return;

    let isCleanedUp = false;
    let channel: Ably.RealtimeChannel | null = null;

    const setupSubscription = async () => {
      try {
        console.log('[UserSessionUpdates] Setting up subscription for user:', user.id);

        const ably = await getAblyClient();

        if (isCleanedUp) return;

        // Listen for connection state changes
        const connectionListener = (stateChange: Ably.ConnectionStateChange) => {
          if (isMountedRef.current && !isCleanedUp) {
            setConnectionStatus(mapAblyState(stateChange.current));
          }
        };
        ably.connection.on(connectionListener);
        connectionListenerRef.current = connectionListener;

        // Update initial status
        if (isMountedRef.current) {
          setConnectionStatus(mapAblyState(ably.connection.state));
        }

        // Subscribe to user channel
        const channelName = REALTIME_CHANNELS.user(user.id);
        channel = ably.channels.get(channelName);
        channelRef.current = channel;

        await channel.subscribe((message: Ably.Message) => {
          if (isCleanedUp || !isMountedRef.current) return;
          const eventName = message.name as UserEventType;
          // Validate against the shared contract before the payload reaches a
          // handler. Unknown event names fall through untyped as before, so a
          // newer backend event still triggers the refetch path.
          const validated = isKnownUserEventName(eventName)
            ? parseUserEventData(eventName, message.data)
            : (message.data as UserEventData | null);

          if (!validated) {
            // memory.suggested is the only user event whose handler reads the
            // payload, so it is the only one worth dropping. Every other user
            // event just triggers a session-list refetch and ignores its data —
            // dropping those would lose a refresh for no safety benefit.
            if (eventName === 'memory.suggested') {
              console.warn(
                '[UserSessionUpdates] Dropping malformed memory.suggested payload'
              );
              reportRealtimeValidationFailure({
                channel: 'user',
                eventName: message.name,
                reason: 'invalid-payload',
                dropped: true,
              });
              return;
            }
            console.warn(
              '[UserSessionUpdates] Malformed payload; refetching anyway:',
              __DEV__ ? message.name : safeEventName(message.name, 'user')
            );
            reportRealtimeValidationFailure({
              channel: 'user',
              eventName: message.name,
              reason: 'invalid-payload',
              dropped: false,
            });
          }

          handleEvent(eventName, (validated ?? {}) as UserEventData);
        });

        console.log('[UserSessionUpdates] Subscription setup complete');
      } catch (err) {
        console.error('[UserSessionUpdates] Subscription error:', err);
        if (isMountedRef.current && !isCleanedUp) {
          setConnectionStatus(ConnectionStatus.FAILED);
        }
      }
    };

    setupSubscription();

    return () => {
      console.log('[UserSessionUpdates] Cleaning up subscription');
      isCleanedUp = true;

      const ably = getAblyClientSync();
      if (ably && connectionListenerRef.current) {
        ably.connection.off(connectionListenerRef.current);
        connectionListenerRef.current = null;
      }

      if (channel) {
        try {
          channel.unsubscribe();
        } catch (err) {
          console.warn('[UserSessionUpdates] Error during cleanup:', err);
        }
      }

      channelRef.current = null;
    };
  }, [user?.id, handleEvent]);

  // Track mounted state
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Handle app state changes
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        const currentState = getAblyConnectionState();
        if (currentState !== 'connected' && currentState !== 'connecting') {
          reconnectAbly();
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  return { connectionStatus };
}
