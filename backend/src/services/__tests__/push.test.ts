/*
 * TS-12: the send-path half of this suite mocked the Prisma client and is gone.
 * On the target the recipient's devices are read by the job (user_device), the
 * progress copy from the stage shim and the actor's name from display names —
 * all against real tables in services/__tests__/push.target.test.ts. What
 * remains is pure: the message table and the token check.
 */
import { isValidPushToken, PUSH_MESSAGES, resetExpoClient } from '../push';
import type { SessionEvent } from '../realtime';

// Mock Prisma

// Mock Expo SDK
const mockSendPushNotificationsAsync = jest.fn();

jest.mock('expo-server-sdk', () => ({
  Expo: jest.fn().mockImplementation(() => ({
    sendPushNotificationsAsync: mockSendPushNotificationsAsync,
  })),
}));

// Import Expo after mock
import { Expo } from 'expo-server-sdk';

// Set up isExpoPushToken mock
(Expo as unknown as { isExpoPushToken: jest.Mock }).isExpoPushToken = jest.fn();

describe('Push Notification Service', () => {
  const validPushToken = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

  beforeEach(() => {
    jest.clearAllMocks();
    resetExpoClient();
    (Expo as unknown as { isExpoPushToken: jest.Mock }).isExpoPushToken.mockReturnValue(true);
  });

  describe('PUSH_MESSAGES', () => {
    it('has messages for all session event types', () => {
      const allEvents: SessionEvent[] = [
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

      for (const event of allEvents) {
        expect(PUSH_MESSAGES[event]).toBeDefined();
        expect(PUSH_MESSAGES[event].title).toBeTruthy();
        expect(PUSH_MESSAGES[event].body).toBeTruthy();
      }
    });

    it('has appropriate messages for partner events', () => {
      expect(PUSH_MESSAGES['partner.signed_compact'].title).toContain('ready');
      expect(PUSH_MESSAGES['partner.empathy_shared'].title).toContain('empathy');
    });

    it('has appropriate messages for agreement events', () => {
      expect(PUSH_MESSAGES['agreement.proposed'].title).toContain('agreement');
      expect(PUSH_MESSAGES['agreement.confirmed'].title).toContain('confirmed');
    });

    it('has appropriate messages for session events', () => {
      expect(PUSH_MESSAGES['session.paused'].title).toContain('paused');
      expect(PUSH_MESSAGES['session.resumed'].title).toContain('resumed');
      expect(PUSH_MESSAGES['session.resolved'].title).toContain('complete');
    });
  });

  describe('isValidPushToken', () => {
    it('returns true for valid Expo push token', () => {
      (Expo as unknown as { isExpoPushToken: jest.Mock }).isExpoPushToken.mockReturnValue(true);
      expect(isValidPushToken(validPushToken)).toBe(true);
    });

    it('returns false for invalid token', () => {
      (Expo as unknown as { isExpoPushToken: jest.Mock }).isExpoPushToken.mockReturnValue(false);
      expect(isValidPushToken('invalid')).toBe(false);
    });
  });
});
