import {
  publishSessionEvent,
  notifyPartner,
  notifyPartnerWithFallback,
  isUserPresent,
  getSessionPresence,
  getSessionChannelName,
  getUserChannelName,
  resetAblyClient,
  publishTypingIndicator,
  getTypingState,
  clearTypingState,
  clearSessionTypingStates,
  publishStageProgress,
  publishStageWaiting,
  publishSessionPaused,
  publishSessionResumed,
  publishSessionResolved,
  publishPresenceUpdate,
  SessionEvent,
} from '../realtime';
import * as pushService from '../push';
import { PresenceStatus } from '@meet-without-fear/shared';

// Mock the push service
jest.mock('../push', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(true),
}));

// Mock Ably
const mockPublish = jest.fn().mockResolvedValue(undefined);
const mockPresenceGet = jest.fn().mockResolvedValue({ items: [] });

jest.mock('ably', () => {
  const MockRest = jest.fn().mockImplementation(() => ({
    channels: {
      get: jest.fn().mockReturnValue({
        publish: mockPublish,
        presence: {
          get: mockPresenceGet,
        },
      }),
    },
  }));

  return {
    __esModule: true,
    default: {
      Rest: MockRest,
    },
    Rest: MockRest,
  };
});

describe('Realtime Service', () => {
  const testSessionId = 'session-123';
  const testUserId = 'user-456';
  const testPartnerId = 'partner-789';

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.E2E_AUTH_BYPASS;
    // Always set ABLY_API_KEY for tests (required now)
    process.env.ABLY_API_KEY = 'test-api-key';
    resetAblyClient();
    // Clear typing states
    clearSessionTypingStates(testSessionId);
  });

  afterAll(() => {
    delete process.env.ABLY_API_KEY;
    delete process.env.E2E_AUTH_BYPASS;
  });

  describe('getSessionChannelName', () => {
    it('returns correct channel name format', () => {
      const channelName = getSessionChannelName('test-session');
      expect(channelName).toBe('meetwithoutfear:session:test-session');
    });
  });

  describe('getUserChannelName', () => {
    it('returns correct user channel name format', () => {
      const channelName = getUserChannelName('test-user');
      expect(channelName).toBe('meetwithoutfear:user:test-user');
    });
  });

  describe('publishSessionEvent', () => {
    it('throws when Ably is not configured', async () => {
      delete process.env.ABLY_API_KEY;
      resetAblyClient();

      await expect(
        publishSessionEvent(testSessionId, 'partner.signed_compact', { signedBy: testUserId }),
      ).rejects.toThrow('ABLY_API_KEY not configured');
    });

    it('publishes to Ably channel when configured', async () => {
      await publishSessionEvent(testSessionId, 'partner.stage_completed', {
        stage: 2,
      });

      expect(mockPublish).toHaveBeenCalledWith(
        'partner.stage_completed',
        expect.objectContaining({
          sessionId: testSessionId,
          stage: 2,
          timestamp: expect.any(Number),
        }),
      );
    });

    it('includes excludeUserId in event data when provided', async () => {
      await publishSessionEvent(testSessionId, 'agreement.proposed', { agreementId: 'agr-1' }, testUserId);

      expect(mockPublish).toHaveBeenCalledWith(
        'agreement.proposed',
        expect.objectContaining({
          excludeUserId: testUserId,
          agreementId: 'agr-1',
        }),
      );
    });

    it('handles all session event types', async () => {
      const events: SessionEvent[] = [
        'partner.signed_compact',
        'partner.stage_completed',
        'partner.advanced',
        'partner.empathy_shared',
        'partner.needs_shared',
        'partner.ranking_submitted',
        'agreement.proposed',
        'agreement.confirmed',
        'session.paused',
        'session.resumed',
        'session.resolved',
      ];

      for (const event of events) {
        await expect(publishSessionEvent(testSessionId, event, {})).resolves.not.toThrow();
      }
    });
  });

  describe('isUserPresent', () => {
    it('returns true when user is in presence list', async () => {
      mockPresenceGet.mockResolvedValueOnce({
        items: [{ clientId: testUserId }, { clientId: 'other-user' }],
      });

      const result = await isUserPresent(testSessionId, testUserId);
      expect(result).toBe(true);
    });

    it('returns false when user is not in presence list', async () => {
      mockPresenceGet.mockResolvedValueOnce({ items: [{ clientId: 'other-user' }] });

      const result = await isUserPresent(testSessionId, testUserId);
      expect(result).toBe(false);
    });

    it('returns false when presence check fails', async () => {
      mockPresenceGet.mockRejectedValueOnce(new Error('Connection failed'));

      const result = await isUserPresent(testSessionId, testUserId);
      expect(result).toBe(false);
    });
  });

  describe('getSessionPresence', () => {
    it('returns array of user IDs when users are present', async () => {
      mockPresenceGet.mockResolvedValueOnce({
        items: [{ clientId: testUserId }, { clientId: testPartnerId }],
      });

      const result = await getSessionPresence(testSessionId);
      expect(result).toEqual([testUserId, testPartnerId]);
    });

    it('returns empty array when no users are present', async () => {
      mockPresenceGet.mockResolvedValueOnce({ items: [] });

      const result = await getSessionPresence(testSessionId);
      expect(result).toEqual([]);
    });
  });

  describe('notifyPartner', () => {
    it('publishes to Ably when partner is online', async () => {
      // Partner is present in channel
      mockPresenceGet.mockResolvedValueOnce({ items: [{ clientId: testPartnerId }] });

      const mockSendPush = pushService.sendPushNotification as jest.Mock;

      await notifyPartner(testSessionId, testPartnerId, 'partner.needs_shared', {
        sharedBy: testUserId,
      });

      // Should publish to Ably, not send push
      expect(mockPublish).toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('sends push notification when partner is offline', async () => {
      // Partner is NOT present
      mockPresenceGet.mockResolvedValueOnce({ items: [{ clientId: 'other-user' }] });

      const mockSendPush = pushService.sendPushNotification as jest.Mock;

      await notifyPartner(testSessionId, testPartnerId, 'session.paused', {});

      expect(mockSendPush).toHaveBeenCalledWith(testPartnerId, 'session.paused', {}, testSessionId);
    });
  });

  describe('notifyPartnerWithFallback', () => {
    it('does not require Ably or send push in Ably-less E2E mode', async () => {
      process.env.E2E_AUTH_BYPASS = 'true';
      delete process.env.ABLY_API_KEY;
      resetAblyClient();

      const mockSendPush = pushService.sendPushNotification as jest.Mock;

      await expect(
        notifyPartnerWithFallback(testSessionId, testPartnerId, 'session.joined', {
          joinedBy: testPartnerId,
          userName: 'Test Partner',
        }),
      ).resolves.toBeUndefined();

      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockPresenceGet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('publishes to Ably and sends push when partner is offline', async () => {
      mockPresenceGet.mockResolvedValueOnce({ items: [] });

      const mockSendPush = pushService.sendPushNotification as jest.Mock;

      await notifyPartnerWithFallback(testSessionId, testPartnerId, 'partner.advanced', {});

      expect(mockPublish).toHaveBeenCalled();
      expect(mockSendPush).toHaveBeenCalledWith(testPartnerId, 'partner.advanced', {}, testSessionId);
    });

    it('publishes to Ably but does not send push when partner is online', async () => {
      mockPresenceGet.mockResolvedValueOnce({ items: [{ clientId: testPartnerId }] });

      const mockSendPush = pushService.sendPushNotification as jest.Mock;

      await notifyPartnerWithFallback(testSessionId, testPartnerId, 'partner.advanced', {});

      expect(mockPublish).toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Typing Indicators Tests
  // ============================================================================

  describe('Typing Indicators', () => {
    describe('publishTypingIndicator', () => {
      it('publishes typing.start event when user starts typing', async () => {
        await publishTypingIndicator(testSessionId, testUserId, true);

        expect(mockPublish).toHaveBeenCalledWith(
          'typing.start',
          expect.objectContaining({
            userId: testUserId,
            isTyping: true,
          }),
        );
      });

      it('publishes typing.stop event when user stops typing', async () => {
        // First start typing
        await publishTypingIndicator(testSessionId, testUserId, true);
        mockPublish.mockClear();

        await publishTypingIndicator(testSessionId, testUserId, false);

        expect(mockPublish).toHaveBeenCalledWith(
          'typing.stop',
          expect.objectContaining({
            userId: testUserId,
            isTyping: false,
          }),
        );
      });

      it('debounces repeated typing events with same state', async () => {
        // First call should publish
        await publishTypingIndicator(testSessionId, testUserId, true);
        expect(mockPublish).toHaveBeenCalledTimes(1);

        // Second call with same state should not publish
        await publishTypingIndicator(testSessionId, testUserId, true);
        expect(mockPublish).toHaveBeenCalledTimes(1);
      });

      it('excludes the typing user from receiving the event', async () => {
        await publishTypingIndicator(testSessionId, testUserId, true);

        expect(mockPublish).toHaveBeenCalledWith(
          'typing.start',
          expect.objectContaining({
            excludeUserId: testUserId,
          }),
        );
      });
    });

    describe('getTypingState', () => {
      it('returns null when no typing state exists', () => {
        const result = getTypingState(testSessionId, testUserId);
        expect(result).toBeNull();
      });

      it('returns typing state after publishing', async () => {
        await publishTypingIndicator(testSessionId, testUserId, true);

        const result = getTypingState(testSessionId, testUserId);
        expect(result).toEqual({
          isTyping: true,
          lastUpdate: expect.any(Number),
        });
      });
    });

    describe('clearTypingState', () => {
      it('removes typing state for a user', async () => {
        await publishTypingIndicator(testSessionId, testUserId, true);
        clearTypingState(testSessionId, testUserId);

        const result = getTypingState(testSessionId, testUserId);
        expect(result).toBeNull();
      });
    });

    describe('clearSessionTypingStates', () => {
      it('removes all typing states for a session', async () => {
        await publishTypingIndicator(testSessionId, testUserId, true);
        await publishTypingIndicator(testSessionId, testPartnerId, true);

        clearSessionTypingStates(testSessionId);

        expect(getTypingState(testSessionId, testUserId)).toBeNull();
        expect(getTypingState(testSessionId, testPartnerId)).toBeNull();
      });

      it('does not affect typing states in other sessions', async () => {
        const otherSessionId = 'other-session';
        await publishTypingIndicator(testSessionId, testUserId, true);
        await publishTypingIndicator(otherSessionId, testUserId, true);

        clearSessionTypingStates(testSessionId);

        expect(getTypingState(testSessionId, testUserId)).toBeNull();
        expect(getTypingState(otherSessionId, testUserId)).not.toBeNull();

        // Cleanup
        clearSessionTypingStates(otherSessionId);
      });
    });
  });

  // ============================================================================
  // Stage Progress Tests
  // ============================================================================

  describe('Stage Progress', () => {
    describe('publishStageProgress', () => {
      it('publishes stage.progress event', async () => {
        await publishStageProgress(testSessionId, testUserId, 2, 'in_progress');

        expect(mockPublish).toHaveBeenCalledWith(
          'stage.progress',
          expect.objectContaining({
            userId: testUserId,
            stage: 2,
            status: 'in_progress',
          }),
        );
      });

      it('excludes the user from receiving their own stage progress', async () => {
        await publishStageProgress(testSessionId, testUserId, 2, 'completed');

        expect(mockPublish).toHaveBeenCalledWith(
          'stage.progress',
          expect.objectContaining({
            excludeUserId: testUserId,
          }),
        );
      });
    });

    describe('publishStageWaiting', () => {
      it('publishes stage.waiting event', async () => {
        await publishStageWaiting(testSessionId, testUserId, 3);

        expect(mockPublish).toHaveBeenCalledWith(
          'stage.waiting',
          expect.objectContaining({
            userId: testUserId,
            stage: 3,
            status: 'gate_pending',
          }),
        );
      });
    });
  });

  // ============================================================================
  // Presence Updates Tests
  // ============================================================================

  describe('Presence Updates', () => {
    describe('publishPresenceUpdate', () => {
      it('publishes presence.online event', async () => {
        await publishPresenceUpdate(testSessionId, testUserId, PresenceStatus.ONLINE, 'Test User');

        expect(mockPublish).toHaveBeenCalledWith(
          'presence.online',
          expect.objectContaining({
            userId: testUserId,
            name: 'Test User',
            status: PresenceStatus.ONLINE,
          }),
        );
      });

      it('publishes presence.offline event', async () => {
        await publishPresenceUpdate(testSessionId, testUserId, PresenceStatus.OFFLINE);

        expect(mockPublish).toHaveBeenCalledWith(
          'presence.offline',
          expect.objectContaining({
            userId: testUserId,
            status: PresenceStatus.OFFLINE,
          }),
        );
      });

      it('publishes presence.away event', async () => {
        await publishPresenceUpdate(testSessionId, testUserId, PresenceStatus.AWAY);

        expect(mockPublish).toHaveBeenCalledWith(
          'presence.away',
          expect.objectContaining({
            userId: testUserId,
            status: PresenceStatus.AWAY,
          }),
        );
      });
    });
  });

  // ============================================================================
  // Session State Tests
  // ============================================================================

  describe('Session State', () => {
    describe('publishSessionPaused', () => {
      it('publishes session.paused event with reason', async () => {
        await publishSessionPaused(testSessionId, testUserId, 'Need a break');

        expect(mockPublish).toHaveBeenCalledWith(
          'session.paused',
          expect.objectContaining({
            pausedBy: testUserId,
            reason: 'Need a break',
          }),
        );
      });

      it('clears typing states when session is paused', async () => {
        await publishTypingIndicator(testSessionId, testUserId, true);
        await publishTypingIndicator(testSessionId, testPartnerId, true);

        await publishSessionPaused(testSessionId, testUserId);

        expect(getTypingState(testSessionId, testUserId)).toBeNull();
        expect(getTypingState(testSessionId, testPartnerId)).toBeNull();
      });
    });

    describe('publishSessionResumed', () => {
      it('publishes session.resumed event', async () => {
        await publishSessionResumed(testSessionId, testUserId);

        expect(mockPublish).toHaveBeenCalledWith(
          'session.resumed',
          expect.objectContaining({
            resumedBy: testUserId,
          }),
        );
      });
    });

    describe('publishSessionResolved', () => {
      it('publishes session.resolved event', async () => {
        await publishSessionResolved(testSessionId, testUserId);

        expect(mockPublish).toHaveBeenCalledWith(
          'session.resolved',
          expect.objectContaining({
            resolvedBy: testUserId,
          }),
        );
      });

      it('clears typing states when session is resolved', async () => {
        await publishTypingIndicator(testSessionId, testUserId, true);

        await publishSessionResolved(testSessionId, testUserId);

        expect(getTypingState(testSessionId, testUserId)).toBeNull();
      });
    });
  });
});
