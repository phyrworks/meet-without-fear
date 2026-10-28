/*
 * TS-12: the Prisma-mock tests of this suite are gone. Compact signing and
 * its status run on participant_milestone in services/__tests__/compact.target.test.ts
 * and the golden harness. What remains is the request validation and the auth guard.
 */
import { Request, Response } from 'express';
import { signCompact, getCompactStatus } from '../../controllers/stage0';

// Mock Prisma

// Mock realtime service
jest.mock('../../services/realtime');

// Helper to create mock request
function createMockRequest(options: {
  user?: { id: string; email: string; name?: string | null };
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}): Partial<Request> {
  return {
    user: options.user as Request['user'],
    params: options.params || {},
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

describe('Stage 0 API', () => {
  const mockUser = { id: 'user-1', email: 'user1@example.com', name: 'User 1' };
  const mockSessionId = 'session-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /sessions/:id/compact/sign (signCompact)', () => {
    it('validates agreed field is true', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { agreed: false },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await signCompact(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'VALIDATION_ERROR',
          }),
        }),
      );
    });

    it('requires authentication', async () => {
      const req = createMockRequest({
        params: { id: mockSessionId },
        body: { agreed: true },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await signCompact(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'UNAUTHORIZED',
          }),
        }),
      );
    });
  });

  describe('GET /sessions/:id/compact/status (getCompactStatus)', () => {
    it('requires authentication', async () => {
      const req = createMockRequest({
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await getCompactStatus(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'UNAUTHORIZED',
          }),
        }),
      );
    });
  });
});
