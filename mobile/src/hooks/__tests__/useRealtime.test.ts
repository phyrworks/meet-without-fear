/**
 * useRealtime Hook Tests
 *
 * Tests for the realtime WebSocket hook that manages Ably connections.
 * Note: These tests use a mock Ably client which simulates async connection.
 */

import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useRealtime,
  usePartnerTyping,
  usePartnerPresence,
  useUserSessionUpdates,
} from '../useRealtime';
import { ConnectionStatus } from '@meet-without-fear/shared';

// Mock the Ably singleton
jest.mock('../../lib/ably', () => {
  const mockChannel = {
    subscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn(),
    publish: jest.fn(),
    presence: {
      enter: jest.fn().mockResolvedValue(undefined),
      leave: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue([]),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
    },
  };

  const mockAblyClient = {
    connection: {
      state: 'connecting',
      on: jest.fn(),
      off: jest.fn(),
    },
    channels: {
      get: jest.fn(() => mockChannel),
    },
  };

  return {
    getAblyClient: jest.fn().mockResolvedValue(mockAblyClient),
    getAblyClientSync: jest.fn(() => mockAblyClient),
    reconnectAbly: jest.fn(),
    getAblyConnectionState: jest.fn(() => 'connecting'),
  };
});

jest.mock('../useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-123', name: 'Test User' },
  }),
}));

jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
}));

// Mock AppState
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

describe('useRealtime', () => {
  const testSessionId = 'session-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('returns initial state with correct structure', () => {
      const { result } = renderHook(() =>
        useRealtime({ sessionId: testSessionId })
      );

      // Initial state should have these properties
      expect(result.current).toHaveProperty('connectionStatus');
      expect(result.current).toHaveProperty('partnerOnline');
      expect(result.current).toHaveProperty('partnerTyping');
      expect(result.current).toHaveProperty('error');
      expect(result.current.partnerOnline).toBe(false);
      expect(result.current.partnerTyping).toBe(false);
    });

    it('provides action functions', () => {
      const { result } = renderHook(() =>
        useRealtime({ sessionId: testSessionId })
      );

      expect(typeof result.current.sendTyping).toBe('function');
      expect(typeof result.current.reconnect).toBe('function');
      expect(typeof result.current.disconnect).toBe('function');
    });
  });

  describe('connection management', () => {
    it('starts in connecting state', () => {
      const { result } = renderHook(() =>
        useRealtime({ sessionId: testSessionId })
      );

      // Should start connecting
      expect(result.current.connectionStatus).toBe(ConnectionStatus.CONNECTING);
    });

    it('accepts onConnectionChange callback without errors', () => {
      const onConnectionChange = jest.fn();

      // Should not throw when providing a callback
      expect(() => {
        renderHook(() =>
          useRealtime({
            sessionId: testSessionId,
            onConnectionChange,
          })
        );
      }).not.toThrow();
    });

    it('provides disconnect function', () => {
      const { result } = renderHook(() =>
        useRealtime({ sessionId: testSessionId })
      );

      expect(result.current.disconnect).toBeDefined();
      expect(typeof result.current.disconnect).toBe('function');
    });

    it('provides reconnect function', () => {
      const { result } = renderHook(() =>
        useRealtime({ sessionId: testSessionId })
      );

      expect(result.current.reconnect).toBeDefined();
      expect(typeof result.current.reconnect).toBe('function');
    });
  });

  describe('typing indicators', () => {
    it('provides sendTyping function', () => {
      const { result } = renderHook(() =>
        useRealtime({ sessionId: testSessionId })
      );

      expect(result.current.sendTyping).toBeDefined();
      expect(typeof result.current.sendTyping).toBe('function');
    });

    it('can call sendTyping without errors', () => {
      const { result } = renderHook(() =>
        useRealtime({ sessionId: testSessionId })
      );

      // Should not throw
      expect(() => {
        act(() => {
          result.current.sendTyping(true);
          result.current.sendTyping(false);
        });
      }).not.toThrow();
    });

    it('publishes typing only on the typing channel, and handles only typing names from it (work-k5fk.32 S8)', async () => {
      const { getAblyClientSync } = jest.requireMock('../../lib/ably');
      const ably = getAblyClientSync();
      const sessionChannel = ably.channels.get();
      const typingChannel = {
        ...sessionChannel,
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn(),
        publish: jest.fn(),
      };
      ably.channels.get.mockImplementation((name?: string) =>
        name === `meetwithoutfear:typing:${testSessionId}` ? typingChannel : sessionChannel
      );
      sessionChannel.publish.mockClear();
      const onTypingChange = jest.fn();
      const onSessionEvent = jest.fn();
      try {
        const { result } = renderHook(() =>
          useRealtime({ sessionId: testSessionId, onTypingChange, onSessionEvent, enablePresence: false })
        );
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        const typing = typingChannel.subscribe.mock.calls[0][0] as (m: { name: string; data: unknown }) => void;
        act(() => {
          // A forged session event on the typing channel is dropped, never handled.
          typing({ name: 'partner.needs_shared', data: { sessionId: testSessionId, timestamp: 1, stage: 3 } });
          typing({
            name: 'typing.start',
            data: { sessionId: testSessionId, timestamp: 1, userId: 'user-456', isTyping: true },
          });
        });
        expect(onSessionEvent).not.toHaveBeenCalled();
        expect(onTypingChange).toHaveBeenCalledWith('user-456', true);

        act(() => {
          result.current.sendTyping(true);
        });
        expect(typingChannel.publish).toHaveBeenCalledWith('typing.start', expect.objectContaining({ isTyping: true }));
        expect(sessionChannel.publish).not.toHaveBeenCalled();
      } finally {
        ably.channels.get.mockImplementation(() => sessionChannel);
      }
    });
  });

  describe('callbacks', () => {
    it('accepts onTypingChange callback', () => {
      const onTypingChange = jest.fn();

      const { result } = renderHook(() =>
        useRealtime({
          sessionId: testSessionId,
          onTypingChange,
        })
      );

      expect(result.current.sendTyping).toBeDefined();
    });

    it('accepts onPresenceChange callback', () => {
      const onPresenceChange = jest.fn();

      const { result } = renderHook(() =>
        useRealtime({
          sessionId: testSessionId,
          onPresenceChange,
        })
      );

      expect(result.current.partnerOnline).toBe(false);
    });

    it('accepts onSessionEvent callback', () => {
      const onSessionEvent = jest.fn();

      const { result } = renderHook(() =>
        useRealtime({
          sessionId: testSessionId,
          onSessionEvent,
        })
      );

      expect(result.current.connectionStatus).toBeDefined();
    });

    it('accepts onStageProgress callback', () => {
      const onStageProgress = jest.fn();

      const { result } = renderHook(() =>
        useRealtime({
          sessionId: testSessionId,
          onStageProgress,
        })
      );

      expect(result.current.partnerStage).toBeUndefined();
    });
  });

  /**
   * The validated boundary: every incoming session-channel payload is parsed
   * against the shared realtime contract before any handler sees it.
   *
   * These drive the real subscribe handler, so they are the regression guard for
   * "validation newly drops an event that used to flow" — the one failure mode
   * this contract must not introduce.
   */
  describe('event validation boundary', () => {
    const currentUserId = 'user-123';
    const partnerId = 'user-456';

    afterEach(() => {
      // jest.clearAllMocks() clears calls but NOT implementations, so the
      // deliberately-throwing addBreadcrumb below would leak into later tests.
      jest.requireMock('@sentry/react-native').addBreadcrumb.mockReset();
    });

    // The Ably mock returns one shared channel object, so subscribe calls from
    // the session and user hooks accumulate on the same mock. Both helpers
    // therefore record the call count before rendering and take the first
    // handler registered after that point — otherwise a test that renders both
    // hooks would silently drive the wrong one.
    const handlerRegisteredAfter = (
      channel: { subscribe: { mock: { calls: unknown[][] } } },
      startIndex: number
    ): ((message: { name: string; data: unknown }) => void) => {
      const call = channel.subscribe.mock.calls
        .slice(startIndex)
        .find((args: unknown[]) => typeof args[0] === 'function');
      if (!call) throw new Error('subscribe handler was never registered');
      return call[0] as (message: { name: string; data: unknown }) => void;
    };

    /** Renders the hook and returns the handler Ably was subscribed with. */
    const captureHandler = async (
      config: Parameters<typeof useRealtime>[0]
    ): Promise<(message: { name: string; data: unknown }) => void> => {
      const { getAblyClientSync } = jest.requireMock('../../lib/ably');
      const channel = getAblyClientSync().channels.get();
      const before = channel.subscribe.mock.calls.length;

      renderHook(() => useRealtime(config));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      return handlerRegisteredAfter(channel, before);
    };

    const envelope = (extra: Record<string, unknown> = {}) => ({
      sessionId: 'session-123',
      timestamp: 1750000000000,
      ...extra,
    });

    it('delivers a well-formed known event', async () => {
      const onSessionEvent = jest.fn();
      const handler = await captureHandler({
        sessionId: 'session-123',
        onSessionEvent,
      });

      act(() => {
        handler({
          name: 'partner.needs_shared',
          data: envelope({ stage: 3, sharedBy: partnerId, needsRevealReady: true }),
        });
      });

      expect(onSessionEvent).toHaveBeenCalledWith(
        'partner.needs_shared',
        expect.objectContaining({ sharedBy: partnerId, needsRevealReady: true })
      );
    });

    it('delivers an event name the contract does not know, rather than dropping it', async () => {
      const onSessionEvent = jest.fn();
      const handler = await captureHandler({
        sessionId: 'session-123',
        onSessionEvent,
      });

      act(() => {
        handler({
          name: 'some.future.event',
          data: envelope({ somethingNew: 'value' }),
        });
      });

      expect(onSessionEvent).toHaveBeenCalledWith(
        'some.future.event',
        expect.objectContaining({ somethingNew: 'value' })
      );
    });

    it('preserves fields the contract does not declare', async () => {
      const onSessionEvent = jest.fn();
      const handler = await captureHandler({
        sessionId: 'session-123',
        onSessionEvent,
      });

      act(() => {
        handler({
          name: 'partner.activity',
          data: envelope({ activeAt: '2026-05-30T12:00:00.000Z', addedLater: { a: 1 } }),
        });
      });

      expect(onSessionEvent).toHaveBeenCalledWith(
        'partner.activity',
        expect.objectContaining({ addedLater: { a: 1 } })
      );
    });

    it('drops a payload that is not a usable envelope', async () => {
      const onSessionEvent = jest.fn();
      const handler = await captureHandler({
        sessionId: 'session-123',
        onSessionEvent,
      });

      act(() => {
        handler({ name: 'partner.activity', data: null });
        handler({ name: 'partner.activity', data: 'not-an-object' });
        handler({ name: 'partner.activity', data: { timestamp: 1 } });
      });

      expect(onSessionEvent).not.toHaveBeenCalled();
    });

    it('still drops events addressed to the other partner', async () => {
      const onSessionEvent = jest.fn();
      const handler = await captureHandler({
        sessionId: 'session-123',
        onSessionEvent,
      });

      act(() => {
        handler({
          name: 'empathy.refining',
          data: envelope({ forUserId: partnerId, hasNewContext: true }),
        });
      });

      expect(onSessionEvent).not.toHaveBeenCalled();
    });

    it('still drops our own echoed events', async () => {
      const onSessionEvent = jest.fn();
      const handler = await captureHandler({
        sessionId: 'session-123',
        onSessionEvent,
      });

      act(() => {
        handler({
          name: 'partner.activity',
          data: envelope({ excludeUserId: currentUserId, activeAt: 'now' }),
        });
      });

      expect(onSessionEvent).not.toHaveBeenCalled();
    });

    it('routes an AI response addressed to us and withholds one addressed to the partner', async () => {
      const onAIResponse = jest.fn();
      const handler = await captureHandler({
        sessionId: 'session-123',
        onAIResponse,
      });

      const aiMessage = {
        id: 'msg-1',
        sessionId: 'session-123',
        senderId: null,
        role: 'AI',
        content: 'hello',
        stage: 1,
        timestamp: '2026-05-30T12:00:00.000Z',
      };

      act(() => {
        handler({
          name: 'message.ai_response',
          data: envelope({ forUserId: currentUserId, message: aiMessage }),
        });
        handler({
          name: 'message.ai_response',
          data: envelope({ forUserId: partnerId, message: aiMessage }),
        });
      });

      expect(onAIResponse).toHaveBeenCalledTimes(1);
      expect(onAIResponse).toHaveBeenCalledWith(
        expect.objectContaining({ forUserId: currentUserId })
      );
    });

    /** Renders the user-channel hook and returns its subscribe handler + client. */
    const captureUserChannelHandler = async (
      config: Parameters<typeof useUserSessionUpdates>[0]
    ) => {
      const { getAblyClientSync } = jest.requireMock('../../lib/ably');
      const channel = getAblyClientSync().channels.get();
      const before = channel.subscribe.mock.calls.length;

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const refetchSpy = jest
        .spyOn(queryClient, 'refetchQueries')
        .mockResolvedValue(undefined as never);
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      renderHook(() => useUserSessionUpdates(config), { wrapper });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      return { handler: handlerRegisteredAfter(channel, before), refetchSpy };
    };

    it('routes a memory suggestion and drops a malformed one', async () => {
      const onMemorySuggestion = jest.fn();
      const { handler } = await captureUserChannelHandler({ onMemorySuggestion });

      act(() => {
        handler({
          name: 'memory.suggested',
          data: {
            sessionId: 'session-123',
            timestamp: 1750000000000,
            suggestion: { id: 'mem-1', suggestedContent: 'x' },
          },
        });
        // No sessionId — unusable, and this is the one user event whose handler
        // reads the payload, so it must be dropped rather than passed through.
        handler({ name: 'memory.suggested', data: { suggestion: { id: 'mem-2' } } });
      });

      expect(onMemorySuggestion).toHaveBeenCalledTimes(1);
      expect(onMemorySuggestion).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'mem-1', sessionId: 'session-123' })
      );
    });

    it('still refetches on a malformed session.updated instead of dropping it', async () => {
      // The refetch path reads nothing off the payload, so a validation failure
      // must not cost the user a refresh. This is the regression guard for that:
      // it fails if the handler goes back to dropping malformed non-memory events.
      const { handler, refetchSpy } = await captureUserChannelHandler({});

      act(() => {
        handler({ name: 'session.updated', data: { notASessionId: true } });
      });

      const refetchedKeys = refetchSpy.mock.calls.map((call) =>
        JSON.stringify((call[0] as { queryKey: unknown }).queryKey)
      );
      expect(refetchedKeys).toHaveLength(2);
      expect(refetchedKeys.join(' ')).toContain('sessions');
    });

    it('reports a dropped session event to Sentry without leaking the payload', async () => {
      const Sentry = jest.requireMock('@sentry/react-native');
      const handler = await captureHandler({ sessionId: 'session-123' });

      act(() => {
        // Envelope is unusable, and the payload carries private content that
        // must not reach a crash report.
        handler({
          name: 'empathy.context_shared',
          data: { content: 'PRIVATE-SHARED-CONTEXT', forUserId: 'user-456' },
        });
      });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
      const breadcrumb = Sentry.addBreadcrumb.mock.calls[0][0];
      // Exact equality, not objectContaining: the point is that ONLY these
      // fields ship, so a new field must fail this test rather than slip past.
      expect(breadcrumb).toEqual({
        category: 'realtime-validation',
        message: 'Dropped malformed session event',
        level: 'warning',
        data: {
          event: 'empathy.context_shared',
          // A KNOWN event name that fails its per-event schema; the
          // invalid-envelope reason is reserved for unknown event names.
          reason: 'invalid-payload',
          dropped: true,
        },
      });

      // The privacy assertion: nothing from the payload may appear anywhere in
      // the breadcrumb, and no session/user identifiers either.
      const serialized = JSON.stringify(breadcrumb);
      expect(serialized).not.toContain('PRIVATE-SHARED-CONTEXT');
      expect(serialized).not.toContain('user-456');
      expect(serialized).not.toContain('session-123');
    });

    it('never reports an attacker-controlled event name', async () => {
      // A compromised partner client could publish arbitrary names (on the typing
      // channel since work-k5fk.32 S8; auth.ts ablyCapabilityFor), so message.name
      // is hostile input.
      // An unknown name must collapse to 'unknown' rather than reach Sentry,
      // because beforeBreadcrumb strips PII *keys*, not arbitrary *values*.
      const Sentry = jest.requireMock('@sentry/react-native');
      const handler = await captureHandler({ sessionId: 'session-123' });
      const malicious = 'I never felt heard when you SECRET-CONFESSION';

      act(() => {
        handler({ name: malicious, data: null });
      });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
      const breadcrumb = Sentry.addBreadcrumb.mock.calls[0][0];
      expect(breadcrumb.data.event).toBe('unknown');
      expect(JSON.stringify(breadcrumb)).not.toContain('SECRET-CONFESSION');
    });

    it('keeps wire-derived content out of production console output', async () => {
      // Sentry's console integration captures console arguments as breadcrumbs,
      // and beforeBreadcrumb does not sanitize values under data.arguments. So
      // sanitizing only the explicit breadcrumb is not enough — the console path
      // has to be clean too. Exercised with __DEV__ false, since the raw-value
      // branches are dev-only and Sentry is disabled in dev.
      const globals = globalThis as unknown as { __DEV__: boolean };
      const wasDev = globals.__DEV__;
      globals.__DEV__ = false;

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const sessionHandler = await captureHandler({ sessionId: 'session-123' });
        act(() => {
          // Valid envelope, hostile name, addressed to the partner: this takes
          // the privacy-drop path, which logs the event name.
          sessionHandler({
            name: 'LEAK-VIA-EVENT-NAME',
            data: envelope({ forUserId: partnerId }),
          });
          // Malformed envelope: takes the validation-drop path.
          sessionHandler({ name: 'LEAK-VIA-EVENT-NAME', data: null });
        });

        const { handler: userHandler } = await captureUserChannelHandler({});
        act(() => {
          userHandler({
            name: 'session.updated',
            data: { sessionId: 'session-123', secret: 'LEAK-VIA-PAYLOAD' },
          });
        });

        const consoleOutput = JSON.stringify([logSpy.mock.calls, warnSpy.mock.calls]);
        expect(consoleOutput).not.toContain('LEAK-VIA-EVENT-NAME');
        expect(consoleOutput).not.toContain('LEAK-VIA-PAYLOAD');
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        globals.__DEV__ = wasDev;
      }
    });

    it('keeps AI response, AI error and memory suggestion content out of production logs', async () => {
      // Regression cover for the three remaining __DEV__-gated sites, so all
      // five changed console calls are pinned rather than just the two the
      // drop-path test reaches.
      const globals = globalThis as unknown as { __DEV__: boolean };
      const wasDev = globals.__DEV__;
      globals.__DEV__ = false;

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const sessionHandler = await captureHandler({
          sessionId: 'session-123',
          onAIResponse: jest.fn(),
          onAIError: jest.fn(),
        });

        act(() => {
          sessionHandler({
            name: 'message.ai_response',
            data: envelope({
              forUserId: currentUserId,
              message: {
                id: 'LEAK-VIA-MESSAGE-ID',
                sessionId: 'session-123',
                senderId: null,
                role: 'AI',
                content: 'LEAK-VIA-MESSAGE-CONTENT',
                stage: 1,
                timestamp: '2026-05-30T12:00:00.000Z',
              },
            }),
          });
          sessionHandler({
            name: 'message.error',
            data: envelope({
              forUserId: currentUserId,
              userMessageId: 'msg-1',
              error: 'LEAK-VIA-ERROR-TEXT',
              canRetry: true,
            }),
          });
        });

        const { handler: userHandler } = await captureUserChannelHandler({
          onMemorySuggestion: jest.fn(),
        });
        act(() => {
          userHandler({
            name: 'memory.suggested',
            data: {
              sessionId: 'session-123',
              timestamp: 1750000000000,
              suggestion: { id: 'mem-1', suggestedContent: 'LEAK-VIA-SUGGESTION' },
            },
          });
        });

        const consoleOutput = JSON.stringify([logSpy.mock.calls, warnSpy.mock.calls]);
        for (const sentinel of [
          'LEAK-VIA-MESSAGE-ID',
          'LEAK-VIA-MESSAGE-CONTENT',
          'LEAK-VIA-ERROR-TEXT',
          'LEAK-VIA-SUGGESTION',
        ]) {
          expect(consoleOutput).not.toContain(sentinel);
        }
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        globals.__DEV__ = wasDev;
      }
    });

    it('keeps delivering events when Sentry itself throws', async () => {
      // Reporting runs inside the Ably callback. If addBreadcrumb throws and the
      // exception escapes, the user-channel case would skip the refetch that a
      // malformed-but-delivered event still owes.
      const Sentry = jest.requireMock('@sentry/react-native');
      Sentry.addBreadcrumb.mockImplementation(() => {
        throw new Error('Sentry exploded');
      });

      const sessionHandler = await captureHandler({ sessionId: 'session-123' });
      expect(() => {
        act(() => {
          sessionHandler({ name: 'partner.activity', data: null });
        });
      }).not.toThrow();

      const { handler: userHandler, refetchSpy } = await captureUserChannelHandler({});
      expect(() => {
        act(() => {
          userHandler({ name: 'session.updated', data: { notASessionId: true } });
        });
      }).not.toThrow();

      // The refetch must still have happened despite the reporting failure.
      expect(refetchSpy).toHaveBeenCalledTimes(2);
    });

    it('reports a dropped memory.suggested from the user channel', async () => {
      const Sentry = jest.requireMock('@sentry/react-native');
      const { handler } = await captureUserChannelHandler({
        onMemorySuggestion: jest.fn(),
      });

      act(() => {
        handler({ name: 'memory.suggested', data: { suggestion: { id: 'mem-2' } } });
      });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
      expect(Sentry.addBreadcrumb.mock.calls[0][0].data).toEqual({
        event: 'memory.suggested',
        reason: 'invalid-payload',
        dropped: true,
      });
    });

    it('does not report a well-formed event to Sentry', async () => {
      const Sentry = jest.requireMock('@sentry/react-native');
      const handler = await captureHandler({ sessionId: 'session-123' });

      act(() => {
        handler({
          name: 'partner.activity',
          data: envelope({ activeAt: '2026-05-30T12:00:00.000Z' }),
        });
      });

      expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
    });

    it('distinguishes a delivered-anyway user event from a dropped one', async () => {
      const Sentry = jest.requireMock('@sentry/react-native');
      const { handler } = await captureUserChannelHandler({});

      act(() => {
        handler({ name: 'session.updated', data: { notASessionId: true } });
      });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(1);
      expect(Sentry.addBreadcrumb.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ event: 'session.updated', dropped: false })
      );
    });

    it('reports stage progress from a validated payload', async () => {
      const onStageProgress = jest.fn();
      const handler = await captureHandler({
        sessionId: 'session-123',
        onStageProgress,
      });

      act(() => {
        handler({
          name: 'stage.progress',
          data: envelope({ userId: partnerId, stage: 3, status: 'in_progress' }),
        });
      });

      expect(onStageProgress).toHaveBeenCalledWith(partnerId, 3, 'in_progress');
    });
  });
});

describe('usePartnerTyping', () => {
  it('returns typing status', () => {
    const { result } = renderHook(() => usePartnerTyping('session-123'));

    expect(result.current).toBe(false);
  });
});

describe('usePartnerPresence', () => {
  it('returns presence and connection status structure', () => {
    const { result } = renderHook(() => usePartnerPresence('session-123'));

    expect(result.current).toHaveProperty('isOnline');
    expect(result.current).toHaveProperty('status');
    expect(result.current.isOnline).toBe(false);
    // Status starts as CONNECTING
    expect(result.current.status).toBe(ConnectionStatus.CONNECTING);
  });
});
