/*
 * TS-12: the Prisma-mock tests of this suite are gone. Profile, push tokens,
 * devices, preferences and mood run against user / user_device /
 * user_preferences / mood_reading as mwf_app in
 * services/__tests__/user-settings.target.test.ts. What remains is the request
 * validation and the auth guard, which never reach the database.
 */
/**
 * Auth Routes Tests
 *
 * Tests for auth API endpoints.
 */

import { Request, Response } from 'express';
import {
  ablyCapabilityFor,
  getMe,
  updateProfile,
  updatePushToken,
  deletePushToken,
  getAblyToken,
} from '../../controllers/auth';
import { UnauthorizedError, ValidationError } from '../../middleware/errors';

// Mock Prisma

// Helper to create mock request
function createMockRequest(options: {
  user?: {
    id: string;
    email: string;
    name: string | null;
    pushToken: string | null;
    createdAt: Date;
    updatedAt: Date;
    clerkId: string | null;
  };
  body?: Record<string, unknown>;
}): Partial<Request> {
  return {
    user: options.user as Request['user'],
    body: options.body || {},
  } as Partial<Request>;
}

// Helper to create mock response
function createMockResponse(): {
  res: Partial<Response>;
  statusMock: jest.Mock;
  jsonMock: jest.Mock;
} {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });

  return {
    res: {
      status: statusMock,
      json: jsonMock,
    } as Partial<Response>,
    statusMock,
    jsonMock,
  };
}

describe('Auth API', () => {
  const mockUser = {
    id: 'user-123',
    clerkId: 'clerk-123',
    email: 'test@example.com',
    name: 'Test User',
    pushToken: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  };

  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNext = jest.fn();
  });

  describe('GET /auth/me (getMe)', () => {
    it('throws UnauthorizedError when no user', async () => {
      const req = createMockRequest({});
      const { res } = createMockResponse();

      await getMe(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });
  });

  describe('PATCH /auth/me (updateProfile)', () => {
    it('throws ValidationError for empty name', async () => {
      const req = createMockRequest({
        user: mockUser,
        body: { name: '' },
      });
      const { res } = createMockResponse();

      await updateProfile(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('throws ValidationError for name over 100 characters', async () => {
      const req = createMockRequest({
        user: mockUser,
        body: { name: 'x'.repeat(101) },
      });
      const { res } = createMockResponse();

      await updateProfile(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('throws UnauthorizedError when no user', async () => {
      const req = createMockRequest({ body: { name: 'Test' } });
      const { res } = createMockResponse();

      await updateProfile(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });
  });

  describe('POST /auth/push-token (updatePushToken)', () => {
    it('throws ValidationError for missing pushToken', async () => {
      const req = createMockRequest({
        user: mockUser,
        body: { platform: 'ios' },
      });
      const { res } = createMockResponse();

      await updatePushToken(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('throws ValidationError for invalid platform', async () => {
      const req = createMockRequest({
        user: mockUser,
        body: { pushToken: 'token', platform: 'web' },
      });
      const { res } = createMockResponse();

      await updatePushToken(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    // work-k5fk.9 (review r1 F7): user_device.push_token is bounded at 512 and every token is Expo's, so either
    // violation is a 400 at the contract, never the database's 500
    it.each([
      ['an oversized token', `ExponentPushToken[${'a'.repeat(520)}]`],
      ['a token that is not an Expo push token', 'FCM-token-xxx'],
    ])('throws ValidationError for %s', async (_label, pushToken) => {
      const req = createMockRequest({ user: mockUser, body: { pushToken, platform: 'ios' } });
      const { res } = createMockResponse();

      await updatePushToken(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('throws UnauthorizedError when no user', async () => {
      const req = createMockRequest({
        body: { pushToken: 'token', platform: 'ios' },
      });
      const { res } = createMockResponse();

      await updatePushToken(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });
  });

  describe('DELETE /auth/push-token (deletePushToken)', () => {
    it('throws UnauthorizedError when no user', async () => {
      const req = createMockRequest({});
      const { res } = createMockResponse();

      await deletePushToken(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });
  });

  describe('GET /auth/ably-token (getAblyToken)', () => {
    it('throws UnauthorizedError when no user', async () => {
      const req = createMockRequest({});
      const { res } = createMockResponse();

      await getAblyToken(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });

    it('grants no client publish on a session channel: only the typing channel takes a client publish (work-k5fk.32 S8)', () => {
      expect(ablyCapabilityFor('u1', ['s1', 's2'])).toEqual({
        'meetwithoutfear:user:u1': ['subscribe'],
        'meetwithoutfear:session:s1': ['subscribe'],
        'meetwithoutfear:presence:s1': ['subscribe', 'presence'],
        'meetwithoutfear:typing:s1': ['subscribe', 'publish'],
        'meetwithoutfear:session:s2': ['subscribe'],
        'meetwithoutfear:presence:s2': ['subscribe', 'presence'],
        'meetwithoutfear:typing:s2': ['subscribe', 'publish'],
      });
    });
  });
});
