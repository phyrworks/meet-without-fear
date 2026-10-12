import { Request, Response } from 'express';
import {
  getNeeds,
  captureNeeds,
  confirmNeeds,
  consentToShareNeeds,
  validateNeeds,
} from '../../controllers/stage3';
import { advanceStage } from '../../controllers/sessions';
import { prisma } from '../../lib/prisma';

// Mock Prisma
jest.mock('../../lib/prisma');

// Mock realtime service
jest.mock('../../services/realtime', () => ({
  ...jest.requireActual('../../services/realtime'),
  notifyPartner: jest.fn().mockResolvedValue(undefined),
  publishSessionEvent: jest.fn().mockResolvedValue(undefined),
  publishMessageAIResponse: jest.fn().mockResolvedValue(undefined),
}));


// Helper to create mock request
function createMockRequest(options: {
  user?: { id: string; email: string; name?: string | null };
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}): Partial<Request> {
  return {
    user: options.user,
    params: options.params || {},
    body: options.body || {},
    query: options.query || {},
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

describe('Stage 3 API', () => {
  const mockUser = { id: 'cluser0001aaaaaaaaa', email: 'test@example.com', name: 'Test User' };
  const mockPartnerId = 'cluser0002aaaaaaaaa';
  const mockSessionId = 'clsess0001aaaaaaaaa';
  const mockVesselId = 'clvess0001aaaaaaaaa';
  const mockNeedId1 = '00000000-0000-4000-8000-0000000ee001'; // uuids: the request contract validates them
  const mockNeedId2 = '00000000-0000-4000-8000-0000000ee002';

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(prisma));
    (prisma.commonGround.findMany as jest.Mock).mockReset();
  });

  describe('GET /sessions/:id/needs (getNeeds)', () => {
    it('returns existing needs for the user (simple read)', async () => {
      const mockNeeds = [
        {
          id: mockNeedId1,
          vesselId: mockVesselId,
          need: 'To feel emotionally connected with partner',
          category: 'CONNECTION',
          evidence: ['I feel disconnected'],
          aiConfidence: 0.85,
          confirmed: false,
          createdAt: new Date(),
        },
        {
          id: mockNeedId2,
          vesselId: mockVesselId,
          need: 'To have contributions acknowledged',
          category: 'RECOGNITION',
          evidence: ['No one notices what I do'],
          aiConfidence: 0.78,
          confirmed: false,
          createdAt: new Date(),
        },
      ];

      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      });

      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({ id: mockVesselId });
      (prisma.identifiedNeed.findMany as jest.Mock).mockResolvedValue(mockNeeds);

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await getNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            needs: expect.arrayContaining([
              expect.objectContaining({
                id: mockNeedId1,
                category: 'CONNECTION',
                need: 'To feel emotionally connected with partner',
              }),
              expect.objectContaining({
                id: mockNeedId2,
                category: 'RECOGNITION',
              }),
            ]),
          }),
        })
      );
    });

    it('returns empty needs when none exist (no auto-extraction)', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      });

      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({ id: mockVesselId });
      (prisma.identifiedNeed.findMany as jest.Mock).mockResolvedValue([]);

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await getNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            needs: [],
            extracting: false,
          }),
        })
      );
    });

    it('requires authentication', async () => {
      const req = createMockRequest({
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await getNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
        })
      );
    });

    it('returns 404 when session not found', async () => {
      (prisma.session.findFirst as jest.Mock).mockResolvedValue(null);

      const req = createMockRequest({
        user: mockUser,
        params: { id: 'non-existent' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await getNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'NOT_FOUND' }),
        })
      );
    });

    it('returns empty data when user not in stage 3', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 2, // Still in stage 2
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }],
        },
      });

      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await getNeeds(req as Request, res as Response);

      // Returns empty data instead of error to allow parallel fetching
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: {
            needs: [],
            synthesizedAt: null,
            isDirty: false,
          },
        })
      );
    });
  });

  describe('POST /sessions/:id/needs/capture (captureNeeds)', () => {
    it('captures needs from a summary card without confirming them', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
      });
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({ id: mockVesselId });
      (prisma.stageProgress.findUnique as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({
        ...mockStageProgress,
        gatesSatisfied: {
          needsCaptured: true,
          needsCapturedAt: new Date().toISOString(),
        },
      });
      (prisma.identifiedNeed.create as jest.Mock).mockResolvedValue({
        id: mockNeedId1,
        vesselId: mockVesselId,
        need: 'To feel heard before problem solving',
        category: 'CONNECTION',
        evidence: ['I just want you to listen first'],
        confirmed: false,
        aiConfidence: 0.85,
        createdAt: new Date(),
      });
      (prisma.identifiedNeed.findMany as jest.Mock).mockResolvedValue([{
        id: mockNeedId1,
        vesselId: mockVesselId,
        need: 'To feel heard before problem solving',
        category: 'CONNECTION',
        evidence: ['I just want you to listen first'],
        confirmed: false,
        aiConfidence: 0.85,
        createdAt: new Date(),
      }]);

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          needs: [
            {
              need: 'Connection',
              category: 'CONNECTION',
              description: 'To feel heard before problem solving',
              evidence: ['I just want you to listen first'],
            },
          ],
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await captureNeeds(req as Request, res as Response);

      expect(prisma.identifiedNeed.deleteMany).toHaveBeenCalledWith({
        where: {
          vesselId: mockVesselId,
          confirmed: false,
        },
      });
      expect(prisma.identifiedNeed.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            vesselId: mockVesselId,
            need: 'To feel heard before problem solving',
            category: 'CONNECTION',
            confirmed: false,
          }),
        })
      );
      expect(prisma.stageProgress.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockStageProgress.id },
          data: expect.objectContaining({
            gatesSatisfied: expect.objectContaining({
              needsCaptured: true,
              needsCapturedAt: expect.any(String),
            }),
          }),
        })
      );
      expect(statusMock).toHaveBeenCalledWith(201);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            needs: [expect.objectContaining({ id: mockNeedId1, confirmed: false })],
            capturedAt: expect.any(String),
          }),
        })
      );
    });
  });

  describe('POST /sessions/:id/needs/confirm (confirmNeeds)', () => {
    it('confirms user needs and marks them as confirmed', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      };

      const mockNeed = {
        id: mockNeedId1,
        vesselId: mockVesselId,
        need: 'To feel emotionally connected',
        category: 'CONNECTION',
        evidence: [],
        aiConfidence: 0.85,
        confirmed: false,
        createdAt: new Date(),
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      });

      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.stageProgress.findUnique as jest.Mock).mockResolvedValue(null); // Partner not shared
      (prisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        relationship: { members: [{ userId: mockUser.id }, { userId: mockPartnerId }] },
      });
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({ id: mockVesselId });
      (prisma.identifiedNeed.findMany as jest.Mock).mockResolvedValue([mockNeed]);
      (prisma.identifiedNeed.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({
        ...mockStageProgress,
        gatesSatisfied: { needsConfirmed: true },
      });

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          needIds: [mockNeedId1],
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await confirmNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            confirmed: true,
            confirmedAt: expect.any(String),
          }),
        })
      );

      expect(prisma.identifiedNeed.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { in: [mockNeedId1] },
            vesselId: mockVesselId,
          },
          data: { confirmed: true, lockedAt: expect.any(Date) },
        })
      );
    });

    it('allows adjustments to need descriptions', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      };

      const mockNeed = {
        id: mockNeedId1,
        vesselId: mockVesselId,
        need: 'To feel emotionally connected',
        category: 'CONNECTION',
        evidence: [],
        aiConfidence: 0.85,
        confirmed: false,
        createdAt: new Date(),
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      });

      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.stageProgress.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        relationship: { members: [{ userId: mockUser.id }, { userId: mockPartnerId }] },
      });
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({ id: mockVesselId });
      (prisma.identifiedNeed.findMany as jest.Mock).mockResolvedValue([mockNeed]);
      (prisma.identifiedNeed.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.identifiedNeed.update as jest.Mock).mockResolvedValue({
        ...mockNeed,
        need: 'To feel deeply heard and understood',
        confirmed: true,
      });
      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({
        ...mockStageProgress,
        gatesSatisfied: { needsConfirmed: true },
      });

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          needIds: [mockNeedId1],
          adjustments: [
            {
              needId: mockNeedId1,
              confirmed: true,
              correction: 'To feel deeply heard and understood',
            },
          ],
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await confirmNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(prisma.identifiedNeed.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockNeedId1, vesselId: mockVesselId },
          data: expect.objectContaining({
            need: 'To feel deeply heard and understood',
            confirmed: true,
          }),
        })
      );
    });

    it('rejects adjustments for needs outside the user vessel', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      });
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({ id: mockVesselId });
      (prisma.identifiedNeed.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockNeedId1,
          vesselId: mockVesselId,
          need: 'To feel emotionally connected',
          category: 'CONNECTION',
          evidence: [],
          aiConfidence: 0.85,
          confirmed: false,
          createdAt: new Date(),
        },
      ]);

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          needIds: [mockNeedId1],
          adjustments: [
            {
              needId: 'partner-need-1',
              confirmed: true,
              correction: 'Overwrite partner need',
            },
          ],
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await confirmNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'VALIDATION_ERROR',
          }),
        })
      );
      expect(prisma.identifiedNeed.update).not.toHaveBeenCalled();
      expect(prisma.identifiedNeed.updateMany).not.toHaveBeenCalled();
    });

    it('requires authentication', async () => {
      const req = createMockRequest({
        params: { id: mockSessionId },
        body: { needIds: [mockNeedId1] },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await confirmNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
        })
      );
    });

    it('validates needIds are provided', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }],
        },
      });

      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {}, // Missing needIds
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await confirmNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        })
      );
    });
  });

  describe('POST /sessions/:id/needs/consent (consentToShareNeeds)', () => {
    it('records consent to share needs with partner', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: { needsConfirmed: true },
      };

      const mockNeeds = [
        {
          id: mockNeedId1,
          vesselId: mockVesselId,
          need: 'To feel connected',
          category: 'CONNECTION',
          evidence: [],
          confirmed: true,
        },
      ];

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      });

      (prisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      });

      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.stageProgress.findUnique as jest.Mock).mockResolvedValue(null); // Partner hasn't consented
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({ id: mockVesselId });
      (prisma.identifiedNeed.findMany as jest.Mock).mockResolvedValue(mockNeeds);
      (prisma.consentRecord.create as jest.Mock).mockResolvedValue({
        id: 'consent-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        targetType: 'IDENTIFIED_NEED',
        targetId: mockNeedId1,
        decision: 'GRANTED',
        createdAt: new Date(),
      });

      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({
        ...mockStageProgress,
        gatesSatisfied: { needsConfirmed: true, needsShared: true },
      });
      (prisma.stageProgress.upsert as jest.Mock).mockResolvedValue({
        id: 'progress-stage-4',
        sessionId: mockSessionId,
        stage: 4,
        status: 'IN_PROGRESS',
      });
      (prisma.message.create as jest.Mock).mockImplementation(({ data }) => ({
        id: `msg-${data.forUserId}`,
        content: data.content,
        timestamp: new Date(),
        forUserId: data.forUserId,
      }));

      (prisma.message.create as jest.Mock).mockResolvedValue({
        id: 'msg-guidance-1',
        sessionId: mockSessionId,
        senderId: null,
        content: 'Your needs have been shared.',
        timestamp: new Date(),
        role: 'AI',
        stage: 3,
      });

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { needIds: [mockNeedId1] },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await consentToShareNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            consented: true,
            sharedAt: expect.any(String),
            waitingForPartner: true,
          }),
        })
      );
    });

    it('indicates when both partners have consented', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: { needsConfirmed: true },
      };

      const partnerProgress = {
        id: 'progress-2',
        sessionId: mockSessionId,
        userId: mockPartnerId,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: { needsConfirmed: true, needsShared: true },
      };

      const mockSession = {
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession);
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession);
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.stageProgress.findUnique as jest.Mock).mockResolvedValue(partnerProgress);
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({ id: mockVesselId });
      (prisma.identifiedNeed.findFirst as jest.Mock).mockResolvedValue({
        need: 'to be able to speak freely',
      });
      (prisma.identifiedNeed.findMany as jest.Mock).mockResolvedValue([
        { id: mockNeedId1, vesselId: mockVesselId, confirmed: true },
      ]);
      (prisma.consentRecord.create as jest.Mock).mockResolvedValue({
        id: 'consent-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        targetType: 'IDENTIFIED_NEED',
        targetId: mockNeedId1,
        decision: 'GRANTED',
      });

      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({
        ...mockStageProgress,
        gatesSatisfied: { needsConfirmed: true, needsShared: true },
      });

      (prisma.message.create as jest.Mock).mockResolvedValue({
        id: 'msg-guidance-2',
        sessionId: mockSessionId,
        senderId: null,
        content: 'Both of you have shared your needs.',
        timestamp: new Date(),
        role: 'AI',
        stage: 3,
      });

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { needIds: [mockNeedId1] },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await consentToShareNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            consented: true,
            waitingForPartner: false,
            needsRevealReady: true,
            advancedToStage4: true,
          }),
        })
      );
      expect(prisma.stageProgress.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stage: 4,
            content: expect.stringContaining('What might help honor that need?'),
          }),
        })
      );
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stage: 4,
            content: expect.stringContaining('to be able to speak freely'),
          }),
        })
      );
    });

    it('requires authentication', async () => {
      const req = createMockRequest({
        params: { id: mockSessionId },
        body: { needIds: [mockNeedId1] },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await consentToShareNeeds(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
        })
      );
    });
  });

  describe('POST /sessions/:id/needs/validate (validateNeeds)', () => {
    it('validates revealed needs and opens Stage 4 when partner already validated', async () => {
      const mockStageProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'IN_PROGRESS',
        gatesSatisfied: { needsConfirmed: true, needsShared: true },
      };

      const partnerProgress = {
        id: 'progress-2',
        sessionId: mockSessionId,
        userId: mockPartnerId,
        stage: 3,
        status: 'GATE_PENDING',
        gatesSatisfied: {
          needsConfirmed: true,
          needsShared: true,
          needsValidated: true,
        },
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      });
      (prisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        relationship: { members: [{ userId: mockUser.id }, { userId: mockPartnerId }] },
      });
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue(mockStageProgress);
      (prisma.stageProgress.findUnique as jest.Mock)
        .mockResolvedValueOnce(partnerProgress)
        .mockResolvedValueOnce(partnerProgress);
      (prisma.userVessel.findUnique as jest.Mock).mockResolvedValue({ id: mockVesselId });
      (prisma.identifiedNeed.findFirst as jest.Mock).mockResolvedValue({
        need: 'to be able to speak freely',
      });
      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({
        ...mockStageProgress,
        status: 'GATE_PENDING',
      });

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await validateNeeds(req as Request, res as Response);

      expect(prisma.stageProgress.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'GATE_PENDING',
            completedAt: null,
          }),
        })
      );
      expect(prisma.stageProgress.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stage: 4,
            content: expect.stringContaining('What might help honor that need?'),
          }),
        })
      );
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stage: 4,
            content: expect.stringContaining('to be able to speak freely'),
          }),
        })
      );
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            validated: true,
            partnerValidated: true,
            canAdvance: true,
          }),
        })
      );
    });
  });

  describe('POST /sessions/:id/stages/advance from Stage 3', () => {
    it('allows explicit Stage 4 advancement after both users satisfy Stage 3 gates', async () => {
      const currentProgress = {
        id: 'progress-1',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 3,
        status: 'GATE_PENDING',
        gatesSatisfied: {
          needsConfirmed: true,
          needsShared: true,
          needsValidated: true,
        },
      };
      const partnerProgress = {
        id: 'progress-2',
        sessionId: mockSessionId,
        userId: mockPartnerId,
        stage: 3,
        status: 'GATE_PENDING',
        gatesSatisfied: {
          needsConfirmed: true,
          needsShared: true,
          needsValidated: true,
        },
      };

      (prisma.session.findFirst as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        status: 'ACTIVE',
        stageProgress: [currentProgress, partnerProgress],
        relationship: {
          members: [{ userId: mockUser.id }, { userId: mockPartnerId }],
        },
      });
      (prisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: mockSessionId,
        relationship: { members: [{ userId: mockUser.id }, { userId: mockPartnerId }] },
      });
      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({
        ...currentProgress,
        status: 'COMPLETED',
      });
      (prisma.stageProgress.create as jest.Mock).mockResolvedValue({
        id: 'progress-4',
        sessionId: mockSessionId,
        userId: mockUser.id,
        stage: 4,
        status: 'IN_PROGRESS',
      });

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await advanceStage(req as Request, res as Response);

      expect(prisma.stageProgress.update).toHaveBeenCalledWith({
        where: { id: 'progress-1' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      });
      expect(prisma.stageProgress.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sessionId: mockSessionId,
            userId: mockUser.id,
            stage: 4,
            status: 'IN_PROGRESS',
          }),
        })
      );
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            advanced: true,
            newStage: 4,
          }),
        })
      );
    });
  });
});
