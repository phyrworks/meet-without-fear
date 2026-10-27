/*
 * TS-12: the Prisma-mock tests of this suite are gone. Clerk resolution, user
 * creation, the email link, the E2E bypass and requireSessionAccess run against
 * the target user / participant / invitation tables in
 * services/__tests__/auth.target.test.ts (and invitations.target.test.ts,
 * job-path.target.test.ts for the invitee and leaver arms). What remains never
 * reaches the database: configuration, token and header guards.
 */
/**
 * Auth Middleware Tests
 *
 * Tests for Clerk-based authentication middleware.
 */

import { Request, Response, NextFunction } from 'express';
import { requireAuth, optionalAuth, getUser, requireSessionAccess } from '../auth';
import { ForbiddenError, NotFoundError } from '../errors';

// Mock Prisma


// Mock Clerk verifyToken and clerkClient
const mockVerifyToken = jest.fn();
const mockGetUser = jest.fn();
jest.mock('@clerk/express', () => ({
  verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
  clerkClient: {
    users: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
  },
}));

// Helper to create mock request
function createMockRequest(options: {
  headers?: Record<string, string>;
  user?: {
    id: string;
    email: string;
    name?: string | null;
    pushToken?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
    clerkId?: string | null;
  };
  params?: Record<string, string>;
}): Partial<Request> {
  return {
    headers: options.headers || {},
    user: options.user as Request['user'],
    params: options.params || {},
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

describe('Auth Middleware', () => {
  const mockUser = {
    id: 'user-123',
    clerkId: 'clerk-user-123',
    email: 'test@example.com',
    name: 'Test User',
    pushToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Set up Clerk environment
    process.env.CLERK_SECRET_KEY = 'sk_test_xxx';
  });

  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
  });

  describe('requireAuth', () => {
    it('returns 500 when CLERK_SECRET_KEY is not configured', async () => {
      delete process.env.CLERK_SECRET_KEY;

      const req = createMockRequest({ headers: {} });
      const { res, statusMock, jsonMock } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
            message: expect.stringContaining('CLERK_SECRET_KEY'),
          }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when no auth header is provided', async () => {
      const req = createMockRequest({ headers: {} });
      const { res, statusMock, jsonMock } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
          }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when token verification fails', async () => {
      mockVerifyToken.mockRejectedValue(new Error('Invalid token'));

      const req = createMockRequest({
        headers: { authorization: 'Bearer invalid-token' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });






  });

  describe('optionalAuth', () => {
    it('continues without user when no auth header', async () => {
      const req = createMockRequest({ headers: {} });
      const { res, statusMock } = createMockResponse();
      const next = jest.fn();

      await optionalAuth(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });


    it('continues without user when token is invalid', async () => {
      mockVerifyToken.mockRejectedValue(new Error('Invalid token'));

      const req = createMockRequest({
        headers: { authorization: 'Bearer invalid-token' },
      });
      const { res, statusMock } = createMockResponse();
      const next = jest.fn();

      await optionalAuth(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });
  });

  describe('getUser', () => {
    it('returns user when authenticated', () => {
      const req = createMockRequest({
        user: mockUser,
      });

      const user = getUser(req as Request);
      expect(user).toEqual(mockUser);
    });

    it('throws UnauthorizedError when no user', () => {
      const req = createMockRequest({});

      expect(() => getUser(req as Request)).toThrow('No authenticated user');
    });
  });

  describe('E2E Auth Bypass', () => {
    beforeEach(() => {
      process.env.E2E_AUTH_BYPASS = 'true';
    });

    afterEach(() => {
      delete process.env.E2E_AUTH_BYPASS;
    });



    it('returns 401 when e2e headers missing and bypass enabled', async () => {
      const req = createMockRequest({ headers: {} });
      const { res, statusMock, jsonMock } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'UNAUTHORIZED',
          }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('bypasses e2e auth when E2E_AUTH_BYPASS is not true', async () => {
      process.env.E2E_AUTH_BYPASS = 'false';

      const req = createMockRequest({
        headers: {
          'x-e2e-user-id': '00000000-0000-4000-8000-0000000e2e01',
          'x-e2e-user-email': 'test@e2e.test',
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      // Without valid Clerk token, should fail
      expect(statusMock).toHaveBeenCalledWith(401);
    });

  });

  describe('requireSessionAccess', () => {
    const user = {
      id: 'user-1',
      clerkId: 'clerk-1',
      email: 'a@b.com',
      name: null,
      firstName: null,
      lastName: null,
      pushToken: null,
      biometricEnabled: false,
      biometricEnrolledAt: null,
      lastMoodIntensity: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };




  });
});
