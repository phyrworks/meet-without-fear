/**
 * Auth Middleware Tests
 *
 * Tests for Clerk-based authentication middleware.
 */

import { Request, Response, NextFunction } from 'express';
import { requireAuth, optionalAuth, getUser, requireSessionAccess } from '../auth';
import { ForbiddenError, NotFoundError } from '../errors';
import { prisma } from '../../lib/prisma';

// Mock Prisma
jest.mock('../../lib/prisma');


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

    it('authenticates existing user with valid Clerk token (fast path — DB only, no Clerk API call)', async () => {
      mockVerifyToken.mockResolvedValue({ sub: 'clerk-user-123' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-clerk-token' },
      });
      const { res } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { clerkId: 'clerk-user-123' },
      });
      // Fast path: no Clerk API call or DB update for existing users
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual(mockUser);
      expect(req.clerkUserId).toBe('clerk-user-123');
    });

    it('creates new user when not found (find + create)', async () => {
      mockVerifyToken.mockResolvedValue({ sub: 'clerk-new-user' });
      mockGetUser.mockResolvedValue({
        firstName: 'New',
        lastName: 'User',
        emailAddresses: [{ emailAddress: 'new@example.com' }],
      });
      const newUser = { ...mockUser, id: 'user-new', clerkId: 'clerk-new-user', email: 'new@example.com', name: 'New User' };
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue(newUser);

      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-clerk-token' },
      });
      const { res } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { clerkId: 'clerk-new-user' },
      });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { clerkId: 'clerk-new-user', email: 'new@example.com', name: 'New User', firstName: 'New', lastName: 'User' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual(newUser);
    });

    it('handles concurrent create race (P2002 fallback)', async () => {
      const { PrismaClientKnownRequestError } = jest.requireActual('../../generated/prisma/client').Prisma;
      mockVerifyToken.mockResolvedValue({ sub: 'clerk-race-user' });
      mockGetUser.mockResolvedValue({
        firstName: 'Race',
        lastName: 'User',
        emailAddresses: [{ emailAddress: 'race@example.com' }],
      });
      const raceUser = { ...mockUser, id: 'user-race', clerkId: 'clerk-race-user', email: 'race@example.com' };
      // First findUnique: not found. Create fails with P2002. Second findUnique: found.
      (prisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(raceUser);
      const p2002Error = new PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
      (prisma.user.create as jest.Mock).mockRejectedValue(p2002Error);

      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-clerk-token' },
      });
      const { res } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual(raceUser);
    });

    it('links an existing user by email when create hits the email unique constraint', async () => {
      const { PrismaClientKnownRequestError } = jest.requireActual('../../generated/prisma/client').Prisma;
      mockVerifyToken.mockResolvedValue({ sub: 'clerk-new-local-user' });
      mockGetUser.mockResolvedValue({
        firstName: 'Local',
        lastName: 'User',
        emailAddresses: [{ emailAddress: 'local@example.com' }],
      });
      const existingUser = {
        ...mockUser,
        id: 'user-local',
        clerkId: null,
        email: 'local@example.com',
        name: 'Local User',
      };
      const linkedUser = { ...existingUser, clerkId: 'clerk-new-local-user' };
      (prisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingUser);
      const p2002Error = new PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.0.0' });
      (prisma.user.create as jest.Mock).mockRejectedValue(p2002Error);
      (prisma.user.update as jest.Mock).mockResolvedValue(linkedUser);

      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-clerk-token' },
      });
      const { res } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
        where: { clerkId: 'clerk-new-local-user' },
      });
      expect(prisma.user.findUnique).toHaveBeenNthCalledWith(3, {
        where: { email: 'local@example.com' },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-local' },
        data: {
          clerkId: 'clerk-new-local-user',
          email: 'local@example.com',
          name: 'Local User',
          firstName: 'Local',
          lastName: 'User',
        },
      });
      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual(linkedUser);
    });

    it('uses an existing local user when Clerk profile lookup fails', async () => {
      mockVerifyToken.mockResolvedValue({ sub: 'clerk-user-123' });
      mockGetUser.mockRejectedValue(new Error('Clerk unavailable'));
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-clerk-token' },
      });
      const { res, statusMock } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { clerkId: 'clerk-user-123' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual(mockUser);
      expect(req.clerkUserId).toBe('clerk-user-123');
    });

    it('fails when Clerk profile lookup fails for an unknown user', async () => {
      const clerkError = new Error('Clerk unavailable');
      mockVerifyToken.mockResolvedValue({ sub: 'clerk-new-user' });
      mockGetUser.mockRejectedValue(clerkError);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-clerk-token' },
      });
      const { res } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(clerkError);
      expect(req.user).toBeUndefined();
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

    it('populates user when valid Clerk token provided', async () => {
      mockVerifyToken.mockResolvedValue({ sub: 'clerk-user-123' });
      mockGetUser.mockResolvedValue({
        firstName: 'Test',
        lastName: 'User',
        emailAddresses: [{ emailAddress: 'test@example.com' }],
      });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prisma.user.update as jest.Mock).mockResolvedValue(mockUser);

      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-clerk-token' },
      });
      const { res, statusMock } = createMockResponse();
      const next = jest.fn();

      await optionalAuth(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
      expect(req.user).toEqual(mockUser);
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

    it('authenticates user with e2e headers when bypass enabled', async () => {
      const e2eUser = {
        id: 'e2e-user-123',
        clerkId: 'e2e_e2e-user-123',
        email: 'test@e2e.test',
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
      (prisma.user.upsert as jest.Mock).mockResolvedValue(e2eUser);

      const req = createMockRequest({
        headers: {
          'x-e2e-user-id': 'e2e-user-123',
          'x-e2e-user-email': 'test@e2e.test',
        },
      });
      const { res, statusMock } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      expect(prisma.user.upsert).toHaveBeenCalledWith({
        where: { id: 'e2e-user-123' },
        create: { id: 'e2e-user-123', email: 'test@e2e.test', clerkId: 'e2e_e2e-user-123' },
        update: { email: 'test@e2e.test', clerkId: 'e2e_e2e-user-123' },
      });
      expect(next).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
      expect(req.user).toEqual(e2eUser);
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
          'x-e2e-user-id': 'e2e-user-123',
          'x-e2e-user-email': 'test@e2e.test',
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      // Without valid Clerk token, should fail
      expect(statusMock).toHaveBeenCalledWith(401);
    });

    it('uses e2e auth even when Clerk header is present', async () => {
      const e2eUser = {
        id: 'e2e-user-123',
        clerkId: 'e2e_e2e-user-123',
        email: 'test@e2e.test',
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
      (prisma.user.upsert as jest.Mock).mockResolvedValue(e2eUser);

      const req = createMockRequest({
        headers: {
          'x-e2e-user-id': 'e2e-user-123',
          'x-e2e-user-email': 'test@e2e.test',
          authorization: 'Bearer some-clerk-token',
        },
      });
      const { res, statusMock } = createMockResponse();
      const next = jest.fn();

      await requireAuth(req as Request, res as Response, next);

      // E2E bypass should take precedence, Clerk verification should not be called
      expect(mockVerifyToken).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
      expect(req.user).toEqual(e2eUser);
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

    it('passes when user is a relationship member', async () => {
      (prisma.session.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'sess-1' });
      const req = createMockRequest({ user, params: { id: 'sess-1' } });
      const { res } = createMockResponse();
      const next = jest.fn();
      await requireSessionAccess(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('throws NotFoundError when session does not exist', async () => {
      (prisma.session.findFirst as jest.Mock).mockResolvedValueOnce(null);
      (prisma.session.findUnique as jest.Mock).mockResolvedValueOnce(null);
      const req = createMockRequest({ user, params: { id: 'missing' } });
      const { res } = createMockResponse();
      const next = jest.fn();
      await requireSessionAccess(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Session not found' }));
    });

    it('throws ForbiddenError when session exists but user has no access', async () => {
      (prisma.session.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // membership check
        .mockResolvedValueOnce(null); // invitation fallback
      (prisma.session.findUnique as jest.Mock).mockResolvedValueOnce({ id: 'sess-2' });
      const req = createMockRequest({ user, params: { id: 'sess-2' } });
      const { res } = createMockResponse();
      const next = jest.fn();
      await requireSessionAccess(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('passes for invitee via invitation fallback', async () => {
      (prisma.session.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // membership
        .mockResolvedValueOnce({ id: 'sess-3' }); // invitation
      (prisma.session.findUnique as jest.Mock).mockResolvedValueOnce({ id: 'sess-3' });
      const req = createMockRequest({ user, params: { id: 'sess-3' } });
      const { res } = createMockResponse();
      const next = jest.fn();
      await requireSessionAccess(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith();
    });
  });
});
