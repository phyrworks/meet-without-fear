/*
 * TS-12: the Prisma-mock tests of this suite (cleanup, seed) are gone; the
 * target paths are exercised by e2e-routes.target.test.ts. What remains is the
 * bypass gate and request validation.
 */
/**
 * E2E Routes Tests
 *
 * Tests for E2E testing helper endpoints.
 */

import { Request, Response, NextFunction } from 'express';

// Mock Prisma

// Import after mock setup
import { cleanupE2EUsers, seedE2EUser } from '../e2e';

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

  describe('POST /api/e2e/cleanup', () => {
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
  });
});
