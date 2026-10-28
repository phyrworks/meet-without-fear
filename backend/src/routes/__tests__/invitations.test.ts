/*
 * TS-12: the Prisma-mock tests of this suite are gone. The invitation
 * lifecycle runs on invitation / participant / app.session_set_status as
 * mwf_app (and the job) in services/__tests__/invitations.target.test.ts.
 * What remains is the auth guard and request validation.
 */
import { Request, Response } from 'express';
import { createSession, getInvitation, acceptInvitation, declineInvitation } from '../../controllers/invitations';

// Mock Prisma

// Mock email service
jest.mock('../../services/email', () => ({
  sendInvitationEmail: jest.fn().mockResolvedValue({
    success: true,
    messageId: 'mock-email-id',
    mocked: true,
  }),
}));

// Mock realtime service
jest.mock('../../services/realtime', () => ({
  notifyPartner: jest.fn().mockResolvedValue(undefined),
  notifyPartnerWithFallback: jest.fn().mockResolvedValue(undefined),
  publishSessionCreated: jest.fn().mockResolvedValue(undefined),
  getAbly: jest.fn().mockReturnValue({
    channels: {
      get: jest.fn().mockReturnValue({
        publish: jest.fn().mockResolvedValue(undefined),
      }),
    },
  }),
}));

// Helper to create mock request
function createMockRequest(options: {
  user?: { id: string; email: string; name?: string | null };
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}): Partial<Request> {
  return {
    user: options.user,
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

describe('Invitations API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /sessions (createSession)', () => {
    it('requires authentication', async () => {
      const req = createMockRequest({
        body: { inviteName: 'Partner Name' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await createSession(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
        }),
      );
    });

    it('validates request body', async () => {
      const mockUser = { id: 'user-1', email: 'inviter@example.com' };
      const req = createMockRequest({
        user: mockUser,
        body: {}, // Missing required fields
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await createSession(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        }),
      );
    });
  });

  describe('GET /invitations/:id (getInvitation)', () => {});

  describe('POST /invitations/:id/accept (acceptInvitation)', () => {});

  describe('POST /invitations/:id/decline (declineInvitation)', () => {});
});
