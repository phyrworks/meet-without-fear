/**
 * E2E Routes Tests
 *
 * Tests for E2E testing helper endpoints.
 */

import { Request, Response, NextFunction } from 'express';

// Mock Prisma
jest.mock('../../lib/prisma');

// Import after mock setup
import { prisma } from '../../lib/prisma';
import { cleanupE2EUsers, seedE2EUser, seedE2ESession, seedE2EInnerThoughts, triggerE2EReconciler } from '../e2e';

describe('E2E Routes', () => {
  const originalEnv = process.env.E2E_AUTH_BYPASS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.E2E_AUTH_BYPASS = 'true';
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.E2E_AUTH_BYPASS = originalEnv;
    } else {
      delete process.env.E2E_AUTH_BYPASS;
    }
  });

  describe('NODE_ENV allow-list (bypass on, environment not test/development)', () => {
    const savedNodeEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = savedNodeEnv;
    });

    const handlers = [
      ['cleanup', cleanupE2EUsers],
      ['seed', seedE2EUser],
      ['seed-session', seedE2ESession],
      ['seed-inner-thoughts', seedE2EInnerThoughts],
      ['trigger-reconciler', triggerE2EReconciler],
    ] as const;

    it.each(
      handlers.flatMap(([name, handler]) =>
        [undefined, 'production', 'staging', 'prod', 'Test'].map((env) => [name, env, handler] as const)
      )
    )('%s refuses with 403 when NODE_ENV=%p', async (_name, env, handler) => {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      const req = { body: { email: 'test@e2e.test' }, params: {}, query: {}, headers: {} } as unknown as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock, json: jsonMock } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await handler(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(prisma.user.upsert).not.toHaveBeenCalled();
      expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/e2e/cleanup', () => {
    it('deletes sessions, relationships, and users for @e2e.test emails', async () => {
      const mockUsers = [{ id: 'user-1' }, { id: 'user-2' }];
      const mockRelationships = [{ id: 'rel-1' }];
      const mockOrphanedRelationships: { id: string }[] = [];

      (prisma.user.findMany as jest.Mock).mockResolvedValue(mockUsers);
      (prisma.relationship.findMany as jest.Mock)
        .mockResolvedValueOnce(mockRelationships) // E2E relationships
        .mockResolvedValueOnce(mockOrphanedRelationships); // Orphaned relationships
      (prisma.session.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
      (prisma.relationship.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.user.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });

      const req = {} as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock, json: jsonMock } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await cleanupE2EUsers(req, res, next);

      // Should find E2E users first
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { email: { endsWith: '@e2e.test' } },
        select: { id: true },
      });
      // Should delete sessions before relationships
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { relationshipId: { in: ['rel-1'] } },
      });
      // Should delete relationships before users
      expect(prisma.relationship.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['rel-1'] } },
      });
      // Should delete users last
      expect(prisma.user.deleteMany).toHaveBeenCalledWith({
        where: { email: { endsWith: '@e2e.test' } },
      });
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        deletedUsers: 2,
        deletedSessions: 2,
        deletedRelationships: 1,
      });
    });

    it('returns early with zero counts when no E2E users exist', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      const req = {} as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock, json: jsonMock } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await cleanupE2EUsers(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        deletedUsers: 0,
        deletedSessions: 0,
        deletedRelationships: 0,
      });
    });

    it('returns 403 when E2E_AUTH_BYPASS is not enabled', async () => {
      process.env.E2E_AUTH_BYPASS = 'false';

      const req = {} as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock, json: jsonMock } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await cleanupE2EUsers(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: 'E2E cleanup only available when E2E_AUTH_BYPASS is enabled',
      });
    });
  });

  describe('POST /api/e2e/seed', () => {
    it('creates user with email and name when provided', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@e2e.test',
        name: 'Test User',
      };
      (prisma.user.upsert as jest.Mock).mockResolvedValue(mockUser);

      const req = {
        body: { email: 'test@e2e.test', name: 'Test User' },
      } as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock, json: jsonMock } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await seedE2EUser(req, res, next);

      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'test@e2e.test' },
          update: { name: 'Test User' },
          create: expect.objectContaining({
            email: 'test@e2e.test',
            name: 'Test User',
            clerkId: expect.stringMatching(/^e2e_/),
          }),
        })
      );
      expect(statusMock).toHaveBeenCalledWith(201);
      expect(jsonMock).toHaveBeenCalledWith({
        id: 'user-123',
        email: 'test@e2e.test',
        name: 'Test User',
      });
    });

    it('returns 400 if email does not end with @e2e.test', async () => {
      const req = {
        body: { email: 'test@example.com', name: 'Test User' },
      } as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock, json: jsonMock } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await seedE2EUser(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: 'Email must end with @e2e.test',
      });
    });

    it('returns 400 if neither email nor fixtureId provided', async () => {
      const req = { body: {} } as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock, json: jsonMock } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await seedE2EUser(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: 'Either email or fixtureId is required',
      });
    });

    it('returns 403 when E2E_AUTH_BYPASS is not enabled', async () => {
      process.env.E2E_AUTH_BYPASS = 'false';

      const req = {
        body: { email: 'test@e2e.test' },
      } as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock, json: jsonMock } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await seedE2EUser(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: 'E2E seed only available when E2E_AUTH_BYPASS is enabled',
      });
    });

    it('loads user from fixture when fixtureId is provided', async () => {
      const mockUser = {
        id: 'user-a',
        email: 'user-a@e2e.test',
        name: 'Alice Test',
      };
      (prisma.user.upsert as jest.Mock).mockResolvedValue(mockUser);

      const req = {
        body: { fixtureId: 'test-fixture' },
      } as Request;
      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock, json: jsonMock } as unknown as Response;
      const next = jest.fn() as NextFunction;

      await seedE2EUser(req, res, next);

      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'user-a@e2e.test' },
          update: { name: 'Alice Test' },
          create: expect.objectContaining({
            email: 'user-a@e2e.test',
            name: 'Alice Test',
            clerkId: expect.stringMatching(/^e2e_/),
          }),
        })
      );
      expect(statusMock).toHaveBeenCalledWith(201);
    });
  });
});
