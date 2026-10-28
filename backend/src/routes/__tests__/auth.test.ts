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
import { getMe, updateProfile, updatePushToken, deletePushToken, getAblyToken } from '../../controllers/auth';
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
  });
});
