/**
 * Stage 4 API Tests
 *
 * Tests for the Strategic Repair stage endpoints:
 * - GET /sessions/:id/strategies - Get anonymous strategy pool
 * - POST /sessions/:id/strategies - Propose a strategy
 * - POST /sessions/:id/strategies/rank - Submit ranking
 * - GET /sessions/:id/strategies/overlap - Get ranking overlap
 * - POST /sessions/:id/agreements - Create agreement
 * - POST /sessions/:id/agreements/:agreementId/confirm - Confirm agreement
 */

import { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { notifyPartner, publishSessionEvent } from '../../services/realtime';
import { getModelCompletion } from '../../lib/bedrock';
import {
  AgreementStatus,
  AgreementType,
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4Phase,
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
  TendingEntryStatus,
  TendingEntryType,
} from '@meet-without-fear/shared';

// Mock prisma
jest.mock('../../lib/prisma');


// Mock realtime
jest.mock('../../services/realtime');

jest.mock('../../lib/bedrock', () => ({
  getModelCompletion: jest.fn(),
}));

// Import controllers after mocks
import {
  getStage4State,
  submitStage4ProposalSelection,
  submitStage4Selections,
  updateStage4WalkthroughNeedStatus,
  shareStage4Selections,
  declineStage4Need,
  undeclineStage4Need,
  closeStage4,
  getStrategies,
  proposeStrategy,
  submitRanking,
  markReady,
  getOverlap,
  createAgreement,
  confirmAgreement,
  requestSuggestions,
} from '../../controllers/stage4';

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

// Helper to create mock session
function mockSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clsession00001',
    status: 'ACTIVE',
    relationship: {
      members: [
        { userId: 'clusertest00001', joinedAt: new Date('2024-01-01') },
        { userId: 'clpartner00001', joinedAt: new Date('2024-01-02') },
      ],
    },
    ...overrides,
  };
}

describe('Stage 4 API', () => {
  const mockUser = { id: 'clusertest00001', email: 'test@example.com', name: 'Test User' };
  const mockSessionId = 'clsession00001';
  const mockPartnerId = 'clpartner00001';
  const mockStrategyIds = [ // uuids: the request contract validates rankedIds
    '00000000-0000-4000-8000-00000005a001',
    '00000000-0000-4000-8000-00000005a002',
    '00000000-0000-4000-8000-00000005a003',
    '00000000-0000-4000-8000-00000005a004',
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.stageProgress.findMany as jest.Mock).mockImplementation((args) => {
      if (args?.where?.stage === 4 && args?.where?.userId?.in) {
        return Promise.resolve([
          { userId: mockUser.id, stage: 4, gatesSatisfied: { selectionSubmitted: true } },
          { userId: mockPartnerId, stage: 4, gatesSatisfied: { selectionSubmitted: true } },
        ]);
      }
      return Promise.resolve([]);
    });
    (getModelCompletion as jest.Mock).mockResolvedValue(null);
  });

  describe('GET /sessions/:id/stage4 (getStage4State)', () => {
    it('returns redesigned inventory and initial phase for existing proposals', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Weekly check-in',
          needsAddressed: ['connection'],
          duration: '2 weeks',
          measureOfSuccess: 'Both feel less surprised',
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
        {
          id: mockStrategyIds[1],
          description: 'I will send the pickup plan by noon',
          needsAddressed: ['predictability'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.INDIVIDUAL_COMMITMENT,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:01:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await getStage4State(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: Stage4Phase.INVENTORY_BUILDING,
            partnerSelectionStatus: 'NOT_STARTED',
            outcome: null,
            inventory: expect.objectContaining({
              sharedProposals: [
                expect.objectContaining({
                  id: mockStrategyIds[0],
                  kind: Stage4ProposalKind.SHARED_PROPOSAL,
                  needsAddressed: [{ label: 'connection', coverage: 'COVERED' }],
                }),
              ],
              individualCommitments: [
                expect.objectContaining({
                  id: mockStrategyIds[1],
                  ownerLabel: 'You',
                }),
              ],
              removedProposalCount: 0,
            }),
          }),
        })
      );
    });

    it('represents a no-shared-agreement closure without agreements', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'I will keep weekends unscheduled',
          needsAddressed: ['autonomy'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.INDIVIDUAL_COMMITMENT,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([
        {
          proposalId: mockStrategyIds[0],
          userId: mockUser.id,
          decision: Stage4SelectionDecision.WILLING,
          note: null,
          selectedAt: new Date('2026-05-06T10:02:00.000Z'),
          updatedAt: new Date('2026-05-06T10:02:00.000Z'),
        },
      ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'coverage-open',
          needId: 'need-open',
          needLabel: 'shared predictability',
          sourceUserId: mockPartnerId,
          coverageStatus: 'OPEN',
          coveringProposalIds: [],
          note: 'Named as still open',
          updatedAt: new Date('2026-05-06T10:03:00.000Z'),
        },
      ]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue({
        kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
        reason: Stage4ClosureReason.NO_OVERLAP,
        summary: 'Closed with no shared obligation and one individual commitment.',
        sharedAgreementIds: [],
        individualProposalIds: [mockStrategyIds[0]],
        openNeedIds: ['need-open'],
        closedAt: new Date('2026-05-06T10:04:00.000Z'),
      });
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await getStage4State(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: Stage4Phase.CLOSED_NO_SHARED_AGREEMENT,
            tendingPreview: expect.objectContaining({
              nextEntry: null,
              passiveReentryAvailable: true,
            }),
            outcome: expect.objectContaining({
              kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
              agreements: [],
              openNeeds: [
                expect.objectContaining({
                  id: 'need-open',
                  source: 'PARTNER',
                }),
              ],
            }),
          }),
        })
      );
    });

    it('hides partner proposal decisions until current user also submits selections', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Weekly check-in',
          needsAddressed: ['connection'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockPartnerId,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([
        {
          proposalId: mockStrategyIds[0],
          userId: mockPartnerId,
          decision: Stage4SelectionDecision.WILLING,
          note: 'Partner note stays private for now',
          selectedAt: new Date('2026-05-06T10:02:00.000Z'),
          updatedAt: new Date('2026-05-06T10:02:00.000Z'),
        },
      ]);
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValue([
        { userId: mockPartnerId, stage: 4, gatesSatisfied: { selectionSubmitted: true } },
      ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await getStage4State(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: Stage4Phase.SELECTION,
            partnerSelectionStatus: 'SUBMITTED',
            mySelections: [],
            inventory: expect.objectContaining({
              sharedProposals: [
                expect.not.objectContaining({
                  partnerDecisionVisible: Stage4SelectionDecision.WILLING,
                }),
              ],
            }),
          }),
        })
      );
    });

    it('returns coverage-review phase with covered, partial, and open needs', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Weekly check-in',
          needsAddressed: ['connection'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'coverage-covered',
          needId: 'need-covered',
          needLabel: 'connection',
          sourceUserId: mockUser.id,
          coverageStatus: 'COVERED',
          coveringProposalIds: [mockStrategyIds[0]],
          note: 'Covered by weekly check-in',
          updatedAt: new Date('2026-05-06T10:03:00.000Z'),
        },
        {
          id: 'coverage-partial',
          needId: 'need-partial',
          needLabel: 'predictability',
          sourceUserId: mockPartnerId,
          coverageStatus: 'PARTIAL',
          coveringProposalIds: [mockStrategyIds[0]],
          note: 'Partly covered by the timing',
          updatedAt: new Date('2026-05-06T10:04:00.000Z'),
        },
        {
          id: 'coverage-open',
          needId: 'need-open',
          needLabel: 'repair after conflict',
          sourceUserId: null,
          coverageStatus: 'OPEN',
          coveringProposalIds: [],
          note: null,
          updatedAt: new Date('2026-05-06T10:05:00.000Z'),
        },
      ]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await getStage4State(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: Stage4Phase.COVERAGE_REVIEW,
            coverageAudit: {
              covered: [
                expect.objectContaining({
                  id: 'need-covered',
                  source: 'YOU',
                  coveringProposalIds: [mockStrategyIds[0]],
                }),
              ],
              partial: [
                expect.objectContaining({
                  id: 'need-partial',
                  source: 'PARTNER',
                }),
              ],
              open: [
                expect.objectContaining({
                  id: 'need-open',
                  source: 'UNKNOWN',
                  note: null,
                }),
              ],
              updatedAt: '2026-05-06T10:05:00.000Z',
            },
            inventory: expect.objectContaining({
              unaddressedNeeds: [
                expect.objectContaining({
                  id: 'need-open',
                  note: 'Still open',
                }),
              ],
            }),
          }),
        })
      );
    });

    it('reveals partner decisions and returns outcome-review phase after both users submit selections', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Weekly check-in',
          needsAddressed: ['connection'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([
        {
          proposalId: mockStrategyIds[0],
          userId: mockUser.id,
          decision: Stage4SelectionDecision.WILLING,
          note: 'Worth trying',
          selectedAt: new Date('2026-05-06T10:02:00.000Z'),
          updatedAt: new Date('2026-05-06T10:02:00.000Z'),
        },
        {
          proposalId: mockStrategyIds[0],
          userId: mockPartnerId,
          decision: Stage4SelectionDecision.NOT_WILLING,
          note: 'Timing is still unclear',
          selectedAt: new Date('2026-05-06T10:03:00.000Z'),
          updatedAt: new Date('2026-05-06T10:03:00.000Z'),
        },
      ]);
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, stage: 4, gatesSatisfied: { selectionSubmitted: true } },
        { userId: mockPartnerId, stage: 4, gatesSatisfied: { selectionSubmitted: true } },
      ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await getStage4State(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: Stage4Phase.OUTCOME_REVIEW,
            partnerSelectionStatus: 'SUBMITTED',
            mySelections: [
              expect.objectContaining({
                proposalId: mockStrategyIds[0],
                decision: Stage4SelectionDecision.WILLING,
              }),
            ],
            inventory: expect.objectContaining({
              sharedProposals: [
                expect.objectContaining({
                  myDecision: Stage4SelectionDecision.WILLING,
                  partnerDecisionVisible: Stage4SelectionDecision.NOT_WILLING,
                }),
              ],
            }),
          }),
        })
      );
    });

    it('stays in selection until both users review every active shared proposal', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Weekly check-in',
          needsAddressed: ['connection'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
        {
          id: mockStrategyIds[1],
          description: 'Monthly desire conversation',
          needsAddressed: ['curiosity'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockPartnerId,
          updatedAt: new Date('2026-05-06T10:01:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([
        {
          proposalId: mockStrategyIds[0],
          userId: mockUser.id,
          decision: Stage4SelectionDecision.WILLING,
          note: null,
          selectedAt: new Date('2026-05-06T10:02:00.000Z'),
          updatedAt: new Date('2026-05-06T10:02:00.000Z'),
        },
        {
          proposalId: mockStrategyIds[0],
          userId: mockPartnerId,
          decision: Stage4SelectionDecision.WILLING,
          note: null,
          selectedAt: new Date('2026-05-06T10:03:00.000Z'),
          updatedAt: new Date('2026-05-06T10:03:00.000Z'),
        },
        {
          proposalId: mockStrategyIds[1],
          userId: mockPartnerId,
          decision: Stage4SelectionDecision.WILLING,
          note: null,
          selectedAt: new Date('2026-05-06T10:04:00.000Z'),
          updatedAt: new Date('2026-05-06T10:04:00.000Z'),
        },
      ]);
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValue([
        { userId: mockPartnerId, stage: 4, gatesSatisfied: { selectionSubmitted: true } },
      ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await getStage4State(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: Stage4Phase.SELECTION,
            partnerSelectionStatus: 'SUBMITTED',
            partnerSelections: [],
            inventory: expect.objectContaining({
              sharedProposals: [
                expect.not.objectContaining({
                  partnerDecisionVisible: Stage4SelectionDecision.WILLING,
                }),
                expect.not.objectContaining({
                  partnerDecisionVisible: Stage4SelectionDecision.WILLING,
                }),
              ],
            }),
          }),
        })
      );
    });

    it('uses submitted gates for outcome review even when a late active shared proposal lacks one selection', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Sunday check-in',
          needsAddressed: ['connection'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
        {
          id: mockStrategyIds[1],
          description: 'Late captured walk idea',
          needsAddressed: ['steadiness'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockPartnerId,
          updatedAt: new Date('2026-05-06T10:01:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([
        {
          proposalId: mockStrategyIds[0],
          userId: mockUser.id,
          decision: Stage4SelectionDecision.WILLING,
          note: null,
          selectedAt: new Date('2026-05-06T10:02:00.000Z'),
          updatedAt: new Date('2026-05-06T10:02:00.000Z'),
        },
        {
          proposalId: mockStrategyIds[0],
          userId: mockPartnerId,
          decision: Stage4SelectionDecision.WILLING,
          note: null,
          selectedAt: new Date('2026-05-06T10:03:00.000Z'),
          updatedAt: new Date('2026-05-06T10:03:00.000Z'),
        },
        {
          proposalId: mockStrategyIds[1],
          userId: mockPartnerId,
          decision: Stage4SelectionDecision.NOT_WILLING,
          note: null,
          selectedAt: new Date('2026-05-06T10:04:00.000Z'),
          updatedAt: new Date('2026-05-06T10:04:00.000Z'),
        },
      ]);
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValue([
        {
          userId: mockUser.id,
          gatesSatisfied: { selectionSubmitted: true },
        },
        {
          userId: mockPartnerId,
          gatesSatisfied: { selectionSubmitted: true },
        },
      ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await getStage4State(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: Stage4Phase.OUTCOME_REVIEW,
            partnerSelectionStatus: 'SUBMITTED',
            partnerSelections: expect.arrayContaining([
              expect.objectContaining({
                proposalId: mockStrategyIds[1],
                decision: Stage4SelectionDecision.NOT_WILLING,
              }),
            ]),
            inventory: expect.objectContaining({
              sharedProposals: expect.arrayContaining([
                expect.objectContaining({
                  id: mockStrategyIds[1],
                  myDecision: undefined,
                  partnerDecisionVisible: Stage4SelectionDecision.NOT_WILLING,
                }),
              ]),
            }),
          }),
        })
      );
    });

    it('returns closed shared-agreement outcome with the next Tending entry preview', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Weekly check-in',
          needsAddressed: ['connection'],
          duration: '2 weeks',
          measureOfSuccess: 'We both know the plan by Friday',
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.CONVERTED_TO_AGREEMENT,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([
        {
          proposalId: mockStrategyIds[0],
          userId: mockUser.id,
          decision: Stage4SelectionDecision.WILLING,
          note: null,
          selectedAt: new Date('2026-05-06T10:02:00.000Z'),
          updatedAt: new Date('2026-05-06T10:02:00.000Z'),
        },
        {
          proposalId: mockStrategyIds[0],
          userId: mockPartnerId,
          decision: Stage4SelectionDecision.WILLING,
          note: null,
          selectedAt: new Date('2026-05-06T10:03:00.000Z'),
          updatedAt: new Date('2026-05-06T10:03:00.000Z'),
        },
      ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue({
        kind: Stage4ClosureKind.SHARED_AGREEMENT,
        reason: Stage4ClosureReason.MUTUAL_SELECTION,
        summary: 'Closed with one shared agreement.',
        sharedAgreementIds: ['agreement-1'],
        individualProposalIds: [],
        openNeedIds: [],
        closedAt: new Date('2026-05-06T10:04:00.000Z'),
      });
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'agreement-1',
          proposalId: mockStrategyIds[0],
          description: 'Weekly check-in',
          type: AgreementType.MICRO_EXPERIMENT,
          duration: '2 weeks',
          measureOfSuccess: 'We both know the plan by Friday',
          status: AgreementStatus.AGREED,
          agreedByA: true,
          agreedByB: true,
          agreedAt: new Date('2026-05-06T10:04:00.000Z'),
          followUpDate: new Date('2099-05-13T10:00:00.000Z'),
        },
      ]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tending-1',
          type: TendingEntryType.SCHEDULED_SHARED_AGREEMENT_CHECKIN,
          status: TendingEntryStatus.SCHEDULED,
          agreementId: 'agreement-1',
          scheduledFor: new Date('2099-05-13T10:00:00.000Z'),
          openedAt: null,
          completedAt: null,
          summary: 'Check whether the weekly check-in is helping.',
        },
      ]);

      await getStage4State(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: Stage4Phase.CLOSED_SHARED_AGREEMENT,
            outcome: expect.objectContaining({
              kind: Stage4ClosureKind.SHARED_AGREEMENT,
              agreements: [
                expect.objectContaining({
                  id: 'agreement-1',
                  strategyId: mockStrategyIds[0],
                  agreedByMe: true,
                  agreedByPartner: true,
                  followUpDate: '2099-05-13T10:00:00.000Z',
                }),
              ],
              closedAt: '2026-05-06T10:04:00.000Z',
            }),
            tendingPreview: {
              nextEntry: expect.objectContaining({
                id: 'tending-1',
                type: TendingEntryType.SCHEDULED_SHARED_AGREEMENT_CHECKIN,
                status: TendingEntryStatus.SCHEDULED,
                agreementId: 'agreement-1',
                scheduledFor: '2099-05-13T10:00:00.000Z',
              }),
              scheduledCount: 1,
              openCount: 0,
              passiveReentryAvailable: true,
            },
          }),
        })
      );
    });

    it('returns own-needs-first walkthrough with proposal source groups', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Ten-minute reset after dinner',
          needsAddressed: ['reliability around chores'],
          duration: '10 days',
          measureOfSuccess: 'Kitchen is reset by 8pm',
          source: 'AI_SUGGESTED',
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: null,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
        {
          id: mockStrategyIds[1],
          description: 'Alternate kitchen cleanup days',
          needsAddressed: ['reliability around chores'],
          duration: null,
          measureOfSuccess: null,
          source: 'USER_SUBMITTED',
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockPartnerId,
          updatedAt: new Date('2026-05-06T10:01:00.000Z'),
        },
        {
          id: mockStrategyIds[2],
          description: 'Use a clear pause phrase before either person escalates',
          needsAddressed: ['reliability around chores'],
          duration: null,
          measureOfSuccess: null,
          source: 'AI_SUGGESTED',
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:02:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'coverage-own',
          needId: 'need-own',
          needLabel: 'reliability around chores',
          sourceUserId: mockUser.id,
          coverageStatus: 'COVERED',
          coveringProposalIds: [mockStrategyIds[0], mockStrategyIds[1], mockStrategyIds[2]],
          note: null,
          updatedAt: new Date('2026-05-06T10:03:00.000Z'),
        },
        {
          id: 'coverage-partner',
          needId: 'need-partner',
          needLabel: 'more appreciation',
          sourceUserId: mockPartnerId,
          coverageStatus: 'OPEN',
          coveringProposalIds: [],
          note: null,
          updatedAt: new Date('2026-05-06T10:04:00.000Z'),
        },
      ]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.strategyProposalNeed.findMany as jest.Mock).mockResolvedValue([
        { proposalId: mockStrategyIds[0], needId: 'need-own', need: { need: 'reliability around chores' } },
        { proposalId: mockStrategyIds[1], needId: 'need-own', need: { need: 'reliability around chores' } },
        { proposalId: mockStrategyIds[2], needId: 'need-own', need: { need: 'reliability around chores' } },
      ]);

      await getStage4State(req as Request, res as Response);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            walkthrough: expect.objectContaining({
              phase: 'MY_NEEDS',
              currentNeed: expect.objectContaining({ id: 'need-own' }),
              proposalGroups: expect.arrayContaining([
                expect.objectContaining({
                  key: 'you_suggested',
                  proposals: [expect.objectContaining({ sourceLabel: 'YOU' })],
                }),
                expect.objectContaining({
                  key: 'partner_suggested',
                  proposals: [expect.objectContaining({ sourceLabel: 'PARTNER' })],
                }),
                expect.objectContaining({
                  key: 'ai_suggested',
                  proposals: [expect.objectContaining({ sourceLabel: 'AI' })],
                }),
              ]),
            }),
          }),
        })
      );
    });
  });

  describe('POST /sessions/:id/stage4/walkthrough/needs/:needId', () => {
    it('persists covered need state and advances to the partner need after own needs', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId, needId: 'need-own' },
        body: { action: 'covered' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        gatesSatisfied: {},
      });
      (prisma.stageProgress.findUnique as jest.Mock).mockResolvedValue({
        gatesSatisfied: {},
      });
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'coverage-own',
          needId: 'need-own',
          needLabel: 'reliability around chores',
          sourceUserId: mockUser.id,
          coverageStatus: 'OPEN',
          coveringProposalIds: [],
          note: null,
          updatedAt: new Date('2026-05-06T10:03:00.000Z'),
        },
        {
          id: 'coverage-partner',
          needId: 'need-partner',
          needLabel: 'more appreciation',
          sourceUserId: mockPartnerId,
          coverageStatus: 'OPEN',
          coveringProposalIds: [],
          note: null,
          updatedAt: new Date('2026-05-06T10:04:00.000Z'),
        },
      ]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.strategyProposalNeed.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({});

      await updateStage4WalkthroughNeedStatus(req as Request, res as Response);

      expect(prisma.stageProgress.update).toHaveBeenCalledWith({
        where: { sessionId_userId_stage: { sessionId: mockSessionId, userId: mockUser.id, stage: 4 } },
        data: {
          gatesSatisfied: expect.objectContaining({
            stage4Walkthrough: expect.objectContaining({
              phase: 'PARTNER_NEEDS',
              currentNeedId: 'need-partner',
              coveredNeedIds: ['need-own'],
              skippedNeedIds: [],
            }),
          }),
        },
      });
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            state: expect.any(Object),
          }),
        })
      );
    });

    it('resets a skipped partner need from quality review back to walkthrough without removing proposals', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId, needId: 'need-partner' },
        body: { action: 'reset' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        gatesSatisfied: {},
      });
      (prisma.stageProgress.findUnique as jest.Mock).mockResolvedValue({
        gatesSatisfied: {
          stage4Walkthrough: {
            phase: 'QUALITY_REVIEW',
            currentNeedId: null,
            coveredNeedIds: ['need-own'],
            skippedNeedIds: ['need-partner'],
          },
        },
      });
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Weekly check-in',
          needsAddressed: ['need-own'],
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
          updatedAt: new Date('2026-05-06T10:00:00.000Z'),
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'coverage-own',
          needId: 'need-own',
          needLabel: 'reliability around chores',
          sourceUserId: mockUser.id,
          coverageStatus: 'OPEN',
          coveringProposalIds: [mockStrategyIds[0]],
          note: null,
          updatedAt: new Date('2026-05-06T10:03:00.000Z'),
        },
        {
          id: 'coverage-partner',
          needId: 'need-partner',
          needLabel: 'more appreciation',
          sourceUserId: mockPartnerId,
          coverageStatus: 'OPEN',
          coveringProposalIds: [],
          note: null,
          updatedAt: new Date('2026-05-06T10:04:00.000Z'),
        },
      ]);
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.strategyProposalNeed.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({});

      await updateStage4WalkthroughNeedStatus(req as Request, res as Response);

      expect(prisma.stageProgress.update).toHaveBeenCalledWith({
        where: { sessionId_userId_stage: { sessionId: mockSessionId, userId: mockUser.id, stage: 4 } },
        data: {
          gatesSatisfied: expect.objectContaining({
            stage4Walkthrough: expect.objectContaining({
              phase: 'PARTNER_NEEDS',
              currentNeedId: 'need-partner',
              coveredNeedIds: ['need-own'],
              skippedNeedIds: [],
            }),
          }),
        },
      });
      expect(prisma.strategyProposal.findMany).toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            state: expect.any(Object),
          }),
        })
      );
    });
  });

  describe('POST /sessions/:id/stage4 selections and close', () => {
    it('rejects duplicate proposal IDs in bulk willingness submissions', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          selections: [
            { proposalId: mockStrategyIds[0], decision: Stage4SelectionDecision.WILLING },
            { proposalId: mockStrategyIds[0], decision: Stage4SelectionDecision.NOT_WILLING },
          ],
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock)
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: {} })
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: {} });
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);

      await submitStage4Selections(req as Request, res as Response);

      expect(prisma.stage4ProposalSelection.upsert).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            message: 'Proposal selections must be unique per request',
          }),
        })
      );
    });

    it('submits a single proposal willingness decision and keeps partner decisions private until both submit', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId, proposalId: mockStrategyIds[0] },
        body: { decision: Stage4SelectionDecision.WILLING, note: 'Worth trying' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock)
        .mockResolvedValueOnce(mockSession())
        .mockResolvedValueOnce(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock)
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: {} })
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: {} });
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.strategyProposal.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: mockStrategyIds[0] }])
        .mockResolvedValueOnce([
          {
            id: mockStrategyIds[0],
            description: 'Weekly check-in',
            needsAddressed: ['connection'],
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.ACTIVE,
            createdByUserId: mockUser.id,
            updatedAt: new Date('2026-05-06T10:00:00.000Z'),
          },
        ]);
      (prisma.stage4ProposalSelection.count as jest.Mock).mockResolvedValue(0);
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([
        {
          proposalId: mockStrategyIds[0],
          userId: mockUser.id,
          decision: Stage4SelectionDecision.WILLING,
          note: 'Worth trying',
          selectedAt: new Date('2026-05-06T10:02:00.000Z'),
          updatedAt: new Date('2026-05-06T10:02:00.000Z'),
        },
      ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await submitStage4ProposalSelection(req as Request, res as Response);

      expect(prisma.stage4ProposalSelection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            proposalId_userId: {
              proposalId: mockStrategyIds[0],
              userId: mockUser.id,
            },
          },
          create: expect.objectContaining({
            decision: Stage4SelectionDecision.WILLING,
            note: 'Worth trying',
          }),
        })
      );
      // Per-tap should NOT flip the selectionSubmitted gate — that's now an
      // explicit "share" action.
      expect(prisma.stageProgress.update).not.toHaveBeenCalled();
      expect(notifyPartner).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            submitted: false,
            partnerSubmitted: false,
            state: expect.objectContaining({
              phase: Stage4Phase.SELECTION,
              mySelectionStatus: 'NOT_STARTED',
              partnerSelectionStatus: 'NOT_STARTED',
            }),
          }),
        })
      );
    });

    it('closes with shared agreements when both partners are willing on shared proposals', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          checkInDate: '2099-05-13T10:00:00.000Z',
          followUpDatesByProposalId: {
            [mockStrategyIds[0]]: '2099-05-13T10:00:00.000Z',
          },
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock)
        .mockResolvedValueOnce(mockSession())
        .mockResolvedValueOnce(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock)
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } })
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } });
      (prisma.stage4Closure.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          kind: Stage4ClosureKind.SHARED_AGREEMENT,
          reason: Stage4ClosureReason.MUTUAL_SELECTION,
          summary: 'Closed with 1 shared agreement and 0 individual commitments.',
          sharedAgreementIds: ['agreement-1'],
          individualProposalIds: [],
          openNeedIds: [],
          closedAt: new Date('2026-05-06T10:04:00.000Z'),
        });
      (prisma.strategyProposal.findMany as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: mockStrategyIds[0],
            sessionId: mockSessionId,
            description: 'Weekly check-in',
            duration: '2 weeks',
            measureOfSuccess: 'We both know the plan by Friday',
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.ACTIVE,
            createdByUserId: mockUser.id,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: mockStrategyIds[0],
            description: 'Weekly check-in',
            needsAddressed: ['connection'],
            duration: '2 weeks',
            measureOfSuccess: 'We both know the plan by Friday',
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.CONVERTED_TO_AGREEMENT,
            createdByUserId: mockUser.id,
            updatedAt: new Date('2026-05-06T10:00:00.000Z'),
          },
        ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { proposalId: mockStrategyIds[0], userId: mockUser.id, decision: Stage4SelectionDecision.WILLING },
          { proposalId: mockStrategyIds[0], userId: mockPartnerId, decision: Stage4SelectionDecision.WILLING },
        ])
        .mockResolvedValueOnce([
          {
            proposalId: mockStrategyIds[0],
            userId: mockUser.id,
            decision: Stage4SelectionDecision.WILLING,
            note: null,
            selectedAt: new Date('2026-05-06T10:02:00.000Z'),
            updatedAt: new Date('2026-05-06T10:02:00.000Z'),
          },
          {
            proposalId: mockStrategyIds[0],
            userId: mockPartnerId,
            decision: Stage4SelectionDecision.WILLING,
            note: null,
            selectedAt: new Date('2026-05-06T10:03:00.000Z'),
            updatedAt: new Date('2026-05-06T10:03:00.000Z'),
          },
        ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'coverage-partial', needId: 'need-partial', coverageStatus: 'PARTIAL' },
          { id: 'coverage-open', needId: 'need-open', coverageStatus: 'OPEN' },
        ])
        .mockResolvedValueOnce([]);
      (prisma.sharedVessel.findUnique as jest.Mock).mockResolvedValue({ id: 'shared-vessel-1' });
      (prisma.agreement.create as jest.Mock).mockResolvedValue({
        id: 'agreement-1',
      });
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'agreement-1',
          proposalId: mockStrategyIds[0],
          description: 'Weekly check-in',
          type: AgreementType.MICRO_EXPERIMENT,
          duration: '2 weeks',
          measureOfSuccess: 'We both know the plan by Friday',
          status: AgreementStatus.AGREED,
          agreedByA: true,
          agreedByB: true,
          agreedAt: new Date('2026-05-06T10:04:00.000Z'),
          followUpDate: new Date('2099-05-13T10:00:00.000Z'),
        },
      ]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await closeStage4(req as Request, res as Response);

      expect(prisma.agreement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sharedVesselId: 'shared-vessel-1',
            proposalId: mockStrategyIds[0],
            status: AgreementStatus.AGREED,
            agreedByA: true,
            agreedByB: true,
            followUpDate: new Date('2099-05-13T10:00:00.000Z'),
          }),
        })
      );
      expect(prisma.stage4Closure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: Stage4ClosureKind.SHARED_AGREEMENT,
            reason: Stage4ClosureReason.MUTUAL_SELECTION,
            sharedAgreementIds: ['agreement-1'],
            openNeedIds: ['need-partial', 'need-open'],
          }),
        })
      );
      expect(prisma.tendingEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agreementId: 'agreement-1',
            type: TendingEntryType.SCHEDULED_SHARED_AGREEMENT_CHECKIN,
            status: TendingEntryStatus.SCHEDULED,
            scheduledFor: new Date('2099-05-13T10:00:00.000Z'),
          }),
        })
      );
      expect(prisma.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'RESOLVED' }),
        })
      );
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            closed: true,
            outcome: expect.objectContaining({
              kind: Stage4ClosureKind.SHARED_AGREEMENT,
              agreements: [expect.objectContaining({ id: 'agreement-1' })],
            }),
          }),
        })
      );
    });

    it('closes with no shared agreement without creating agreements when no mutual willingness exists', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { checkInDate: '2026-06-03T10:00:00.000Z' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock)
        .mockResolvedValueOnce(mockSession())
        .mockResolvedValueOnce(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock)
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } })
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } });
      (prisma.stage4Closure.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
          reason: Stage4ClosureReason.NO_OVERLAP,
          summary: 'Closed without a shared agreement, preserving 1 individual commitment and 1 still-open need.',
          sharedAgreementIds: [],
          individualProposalIds: [mockStrategyIds[1]],
          openNeedIds: ['need-open'],
          closedAt: new Date('2026-05-06T10:04:00.000Z'),
        });
      (prisma.strategyProposal.findMany as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: mockStrategyIds[0],
            sessionId: mockSessionId,
            description: 'Weekly check-in',
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.ACTIVE,
            createdByUserId: mockUser.id,
          },
          {
            id: mockStrategyIds[1],
            sessionId: mockSessionId,
            description: 'I will keep weekends unscheduled',
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.INDIVIDUAL_COMMITMENT,
            status: Stage4ProposalStatus.ACTIVE,
            createdByUserId: mockUser.id,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: mockStrategyIds[0],
            description: 'Weekly check-in',
            needsAddressed: [],
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.ACTIVE,
            createdByUserId: mockUser.id,
            updatedAt: new Date('2026-05-06T10:00:00.000Z'),
          },
          {
            id: mockStrategyIds[1],
            description: 'I will keep weekends unscheduled',
            needsAddressed: ['autonomy'],
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.INDIVIDUAL_COMMITMENT,
            status: Stage4ProposalStatus.ACTIVE,
            createdByUserId: mockUser.id,
            updatedAt: new Date('2026-05-06T10:01:00.000Z'),
          },
        ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { proposalId: mockStrategyIds[0], userId: mockUser.id, decision: Stage4SelectionDecision.WILLING },
          { proposalId: mockStrategyIds[0], userId: mockPartnerId, decision: Stage4SelectionDecision.NOT_WILLING },
          { proposalId: mockStrategyIds[1], userId: mockUser.id, decision: Stage4SelectionDecision.WILLING },
        ])
        .mockResolvedValueOnce([
          {
            proposalId: mockStrategyIds[1],
            userId: mockUser.id,
            decision: Stage4SelectionDecision.WILLING,
            note: null,
            selectedAt: new Date('2026-05-06T10:02:00.000Z'),
            updatedAt: new Date('2026-05-06T10:02:00.000Z'),
          },
        ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'coverage-open', needId: 'need-open', coverageStatus: 'OPEN' },
        ])
        .mockResolvedValueOnce([
          {
            id: 'coverage-open',
            needId: 'need-open',
            needLabel: 'shared predictability',
            sourceUserId: mockPartnerId,
            coverageStatus: 'OPEN',
            coveringProposalIds: [],
            note: 'Named as still open',
            updatedAt: new Date('2026-05-06T10:03:00.000Z'),
          },
        ]);
      (prisma.sharedVessel.findUnique as jest.Mock).mockResolvedValue({ id: 'shared-vessel-1' });
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await closeStage4(req as Request, res as Response);

      expect(prisma.agreement.create).not.toHaveBeenCalled();
      expect(prisma.tendingEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scope: 'INDIVIDUAL',
            ownerUserId: mockUser.id,
            type: 'SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN',
          }),
        })
      );
      expect(prisma.stage4Closure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
            reason: Stage4ClosureReason.NO_OVERLAP,
            sharedAgreementIds: [],
            individualProposalIds: [mockStrategyIds[1]],
            openNeedIds: ['need-open'],
          }),
        })
      );
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            outcome: expect.objectContaining({
              kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
              agreements: [],
              individualCommitments: [expect.objectContaining({ id: mockStrategyIds[1] })],
            }),
          }),
        })
      );
    });

    it('does not create a shared obligation when the partner has not submitted selections', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          kind: Stage4ClosureKind.SHARED_AGREEMENT,
          checkInDate: '2026-06-03T10:00:00.000Z',
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock)
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } })
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } });
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          sessionId: mockSessionId,
          description: 'Weekly check-in',
          duration: null,
          measureOfSuccess: null,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
          status: Stage4ProposalStatus.ACTIVE,
          createdByUserId: mockUser.id,
        },
      ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([
        { proposalId: mockStrategyIds[0], userId: mockUser.id, decision: Stage4SelectionDecision.WILLING },
      ]);
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValueOnce([
        { userId: mockUser.id, stage: 4, gatesSatisfied: { selectionSubmitted: true } },
        { userId: mockPartnerId, stage: 4, gatesSatisfied: {} },
      ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.sharedVessel.findUnique as jest.Mock).mockResolvedValue({ id: 'shared-vessel-1' });

      await closeStage4(req as Request, res as Response);

      expect(prisma.agreement.create).not.toHaveBeenCalled();
      expect(prisma.stage4Closure.create).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            message: 'Both partners must submit selections before shared agreement closure',
          }),
        })
      );
    });

    it('rejects close requests with an empty checkInDate with VALIDATION_ERROR', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { checkInDate: '' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await closeStage4(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        })
      );
      expect(prisma.stage4Closure.create).not.toHaveBeenCalled();
    });

    it('persists Stage4Closure.checkInAt from the request body', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { checkInDate: '2026-06-03T10:00:00.000Z' },
      });
      const { res } = createMockResponse();

      (prisma.session.findFirst as jest.Mock)
        .mockResolvedValueOnce(mockSession())
        .mockResolvedValueOnce(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock)
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } })
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } });
      (prisma.stage4Closure.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
          reason: Stage4ClosureReason.NO_OVERLAP,
          summary: 'closed',
          sharedAgreementIds: [],
          individualProposalIds: [],
          openNeedIds: [],
          closedAt: new Date('2026-05-06T10:04:00.000Z'),
          checkInAt: new Date('2026-06-03T10:00:00.000Z'),
        });
      (prisma.strategyProposal.findMany as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      (prisma.sharedVessel.findUnique as jest.Mock).mockResolvedValue({ id: 'shared-vessel-1' });
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await closeStage4(req as Request, res as Response);

      expect(prisma.stage4Closure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkInAt: new Date('2026-06-03T10:00:00.000Z'),
          }),
        })
      );
    });

    it('closes a shared agreement when mutual willingness exists even if unrelated active fragments are unreviewed', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          kind: Stage4ClosureKind.SHARED_AGREEMENT,
          checkInDate: '2026-06-03T10:00:00.000Z',
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock)
        .mockResolvedValueOnce(mockSession())
        .mockResolvedValueOnce(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock)
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } })
        .mockResolvedValueOnce({ stage: 4, status: 'IN_PROGRESS', gatesSatisfied: { selectionSubmitted: true } });
      (prisma.stage4Closure.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          kind: Stage4ClosureKind.SHARED_AGREEMENT,
          reason: Stage4ClosureReason.MUTUAL_SELECTION,
          summary: 'Closed with 1 shared agreement and 0 individual commitments.',
          sharedAgreementIds: ['agreement-1'],
          individualProposalIds: [],
          openNeedIds: [],
          closedAt: new Date('2026-05-06T10:04:00.000Z'),
        });
      (prisma.strategyProposal.findMany as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: mockStrategyIds[0],
            sessionId: mockSessionId,
            description: 'Weekly check-in',
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.ACTIVE,
            createdByUserId: mockUser.id,
          },
          {
            id: mockStrategyIds[1],
            sessionId: mockSessionId,
            description: 'Monthly desire conversation',
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.ACTIVE,
            createdByUserId: mockPartnerId,
          },
          {
            id: mockStrategyIds[2],
            sessionId: mockSessionId,
            description: 'Older shared proposal already revised away',
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.REVISED,
            createdByUserId: mockPartnerId,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: mockStrategyIds[0],
            description: 'Weekly check-in',
            needsAddressed: ['connection'],
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.CONVERTED_TO_AGREEMENT,
            createdByUserId: mockUser.id,
            updatedAt: new Date('2026-05-06T10:00:00.000Z'),
          },
          {
            id: mockStrategyIds[1],
            description: 'Monthly desire conversation',
            needsAddressed: [],
            duration: null,
            measureOfSuccess: null,
            kind: Stage4ProposalKind.SHARED_PROPOSAL,
            status: Stage4ProposalStatus.ACTIVE,
            createdByUserId: mockPartnerId,
            updatedAt: new Date('2026-05-06T10:00:00.000Z'),
          },
        ]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { proposalId: mockStrategyIds[0], userId: mockUser.id, decision: Stage4SelectionDecision.WILLING },
          { proposalId: mockStrategyIds[0], userId: mockPartnerId, decision: Stage4SelectionDecision.WILLING },
          { proposalId: mockStrategyIds[1], userId: mockPartnerId, decision: Stage4SelectionDecision.WILLING },
        ])
        .mockResolvedValueOnce([
          {
            proposalId: mockStrategyIds[0],
            userId: mockUser.id,
            decision: Stage4SelectionDecision.WILLING,
            note: null,
            selectedAt: new Date('2026-05-06T10:02:00.000Z'),
            updatedAt: new Date('2026-05-06T10:02:00.000Z'),
          },
          {
            proposalId: mockStrategyIds[0],
            userId: mockPartnerId,
            decision: Stage4SelectionDecision.WILLING,
            note: null,
            selectedAt: new Date('2026-05-06T10:03:00.000Z'),
            updatedAt: new Date('2026-05-06T10:03:00.000Z'),
          },
          {
            proposalId: mockStrategyIds[1],
            userId: mockPartnerId,
            decision: Stage4SelectionDecision.WILLING,
            note: null,
            selectedAt: new Date('2026-05-06T10:03:00.000Z'),
            updatedAt: new Date('2026-05-06T10:03:00.000Z'),
          },
        ]);
      (prisma.stage4NeedCoverage.findMany as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      (prisma.sharedVessel.findUnique as jest.Mock).mockResolvedValue({ id: 'shared-vessel-1' });
      (prisma.agreement.create as jest.Mock).mockResolvedValue({
        id: 'agreement-1',
      });
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'agreement-1',
          proposalId: mockStrategyIds[0],
          description: 'Weekly check-in',
          type: AgreementType.MICRO_EXPERIMENT,
          duration: null,
          measureOfSuccess: null,
          status: AgreementStatus.AGREED,
          agreedByA: true,
          agreedByB: true,
          agreedAt: new Date('2026-05-06T10:04:00.000Z'),
          followUpDate: null,
        },
      ]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);

      await closeStage4(req as Request, res as Response);

      expect(prisma.agreement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            proposalId: mockStrategyIds[0],
            status: AgreementStatus.AGREED,
          }),
        })
      );
      expect(prisma.stage4Closure.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: Stage4ClosureKind.SHARED_AGREEMENT,
            sharedAgreementIds: ['agreement-1'],
          }),
        })
      );
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            closed: true,
            outcome: expect.objectContaining({
              kind: Stage4ClosureKind.SHARED_AGREEMENT,
              agreements: [expect.objectContaining({ id: 'agreement-1' })],
            }),
          }),
        })
      );
    });
  });

  describe('GET /sessions/:id/strategies (getStrategies)', () => {
    it('returns unlabeled strategy pool', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, stage: 4, gatesSatisfied: { readyToRank: true } },
        { userId: mockPartnerId, stage: 4, gatesSatisfied: null },
      ]);
      // Mock returns only the selected fields (as Prisma would with select clause)
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Weekly check-in',
          needsAddressed: ['connection'],
          duration: '2 weeks',
          measureOfSuccess: 'Feel more connected',
          createdByUserId: mockUser.id,
        },
        {
          id: mockStrategyIds[1],
          description: 'Daily appreciation',
          needsAddressed: ['recognition'],
          duration: '1 week',
          measureOfSuccess: null,
          createdByUserId: mockUser.id,
        },
      ]);

      await getStrategies(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            myReadyToRank: true,
            partnerReadyToRank: false,
            strategies: expect.arrayContaining([
              expect.objectContaining({
                id: expect.any(String),
                description: expect.any(String),
              }),
            ]),
          }),
        })
      );

      // Verify strategies don't expose createdBy
      const responseData = jsonMock.mock.calls[0][0];
      responseData.data.strategies.forEach((strategy: Record<string, unknown>) => {
        expect(strategy).not.toHaveProperty('createdBy');
        expect(strategy).not.toHaveProperty('createdByUserId');
      });

      // Verify Prisma can use createdByUserId for server-side visibility without exposing it
      expect(prisma.strategyProposal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            id: true,
            description: true,
            needsAddressed: true,
            duration: true,
            measureOfSuccess: true,
            createdByUserId: true,
          }),
        })
      );
    });

    it('does not return partner-only strategies while current user is still collecting', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, stage: 4, gatesSatisfied: null },
        { userId: mockPartnerId, stage: 4, gatesSatisfied: { readyToRank: true } },
      ]);
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Partner-only idea',
          needsAddressed: [],
          duration: null,
          measureOfSuccess: null,
          createdByUserId: mockPartnerId,
        },
      ]);
      (prisma.strategyRanking.findMany as jest.Mock).mockResolvedValue([]);

      await getStrategies(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: 'COLLECTING',
            strategies: [],
            canMarkReadyToRank: false,
            canRank: false,
          }),
        })
      );
    });

    it('returns revealing phase for a user who already submitted ranking while partner has not', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, stage: 4, gatesSatisfied: { readyToRank: true, rankingSubmitted: true } },
        { userId: mockPartnerId, stage: 4, gatesSatisfied: { readyToRank: true } },
      ]);
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        {
          id: mockStrategyIds[0],
          description: 'Weekly check-in',
          needsAddressed: ['connection'],
          duration: '2 weeks',
          measureOfSuccess: 'Feel more connected',
        },
      ]);
      (prisma.strategyRanking.findMany as jest.Mock).mockResolvedValue([
        { sessionId: mockSessionId, userId: mockUser.id, rankedIds: [mockStrategyIds[0]] },
      ]);

      await getStrategies(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            phase: 'REVEALING',
            myReadyToRank: true,
            partnerReadyToRank: true,
          }),
        })
      );
    });

    it('requires authentication', async () => {
      const req = createMockRequest({
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await getStrategies(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
        })
      );
    });

    it('returns 404 when session not found', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: 'non-existent' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(null);

      await getStrategies(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'NOT_FOUND' }),
        })
      );
    });
  });

  describe('POST /sessions/:id/strategies (proposeStrategy)', () => {
    it('adds user strategy to pool', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          description: 'We could try having a weekly check-in',
          needsAddressed: ['connection', 'safety'],
          duration: '2 weeks',
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });
      (prisma.strategyProposal.create as jest.Mock).mockResolvedValue({
        id: 'strat-new',
        description: 'We could try having a weekly check-in',
        needsAddressed: ['connection', 'safety'],
        duration: '2 weeks',
        measureOfSuccess: null,
        createdAt: new Date(),
      });

      await proposeStrategy(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(201);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            strategy: expect.objectContaining({
              id: 'strat-new',
              description: 'We could try having a weekly check-in',
            }),
          }),
        })
      );

      expect(prisma.strategyProposal.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sessionId: mockSessionId,
            createdByUserId: mockUser.id,
            description: 'We could try having a weekly check-in',
            needsAddressed: ['connection', 'safety'],
            duration: '2 weeks',
            source: 'USER_SUBMITTED',
          }),
        })
      );
    });

    it('validates description is long enough', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          description: 'short', // Less than 10 characters
          needsAddressed: ['connection'],
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await proposeStrategy(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        })
      );
    });

    it('requires at least one need to be addressed', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          description: 'A valid description here',
          needsAddressed: [], // Empty array
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await proposeStrategy(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        })
      );
    });

    it('rejects if user not in stage 4', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          description: 'A valid description here',
          needsAddressed: ['connection'],
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 3, // Not stage 4
        status: 'IN_PROGRESS',
      });

      await proposeStrategy(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        })
      );
    });
  });

  describe('POST /sessions/:id/strategies/rank (submitRanking)', () => {
    it('stores private ranking', async () => {
      const rankedIds = [mockStrategyIds[0], mockStrategyIds[1], mockStrategyIds[2]];
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { rankedIds },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, stage: 4, gatesSatisfied: { readyToRank: true } },
        { userId: mockPartnerId, stage: 4, gatesSatisfied: { readyToRank: true } },
      ]);
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue(
        rankedIds.map((id) => ({ id }))
      );
      (prisma.strategyProposal.count as jest.Mock).mockResolvedValue(1);
      (prisma.strategyRanking.upsert as jest.Mock).mockResolvedValue({
        id: 'clranking0001',
        rankedIds,
        submittedAt: new Date(),
      });
      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({
        gatesSatisfied: { rankingSubmitted: true },
      });
      // Mock partner ranking check - partner has not ranked yet
      (prisma.strategyRanking.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, rankedIds },
      ]);

      await submitRanking(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            ranked: true,
            partnerRanked: false,
          }),
        })
      );

      expect(prisma.strategyRanking.upsert).toHaveBeenCalled();
      expect(prisma.stageProgress.update).toHaveBeenCalled();
      expect(notifyPartner).toHaveBeenCalled();
    });

    it('indicates when partner has also ranked', async () => {
      const rankedIds = [mockStrategyIds[0], mockStrategyIds[1], mockStrategyIds[2]];
      const partnerRankedIds = [mockStrategyIds[1], mockStrategyIds[0], mockStrategyIds[2]];
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { rankedIds },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });
      (prisma.stageProgress.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, stage: 4, gatesSatisfied: { readyToRank: true } },
        { userId: mockPartnerId, stage: 4, gatesSatisfied: { readyToRank: true } },
      ]);
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue(
        rankedIds.map((id) => ({ id }))
      );
      (prisma.strategyProposal.count as jest.Mock).mockResolvedValue(1);
      (prisma.strategyRanking.upsert as jest.Mock).mockResolvedValue({
        id: 'clranking0001',
        rankedIds,
        submittedAt: new Date(),
      });
      (prisma.stageProgress.update as jest.Mock).mockResolvedValue({
        gatesSatisfied: { rankingSubmitted: true },
      });
      // Mock partner ranking check - partner HAS ranked
      (prisma.strategyRanking.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, rankedIds },
        { userId: mockPartnerId, rankedIds: partnerRankedIds },
      ]);

      await submitRanking(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            ranked: true,
            partnerRanked: true,
            canReveal: true,
          }),
        })
      );
    });

    it('requires at least one strategy to be ranked', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { rankedIds: [] },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await submitRanking(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        })
      );
    });
  });

  describe('POST /sessions/:id/stage4/proposals/suggest (requestSuggestions)', () => {
    it('persists AI suggestions linked to the target need', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          needId: 'need-1',
          focusNeeds: ['predictability'],
          count: 2,
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });
      (prisma.identifiedNeed.findFirst as jest.Mock).mockResolvedValue({
        id: 'need-1',
        sessionId: mockSessionId,
        need: 'predictability',
      });
      (prisma.globalLibraryItem.findMany as jest.Mock).mockResolvedValue([
        {
          title: 'Short planning check-in',
          description: 'A small scheduled check-in to reduce surprise.',
          category: 'planning',
        },
      ]);
      (prisma.strategyProposal.create as jest.Mock)
        .mockResolvedValueOnce({
          id: 'ai-proposal-1',
          description:
            'Try one small check-in focused on "predictability" and each name one concrete thing that would help this week.',
          needsAddressed: ['predictability'],
          duration: '10 minutes, once this week',
          measureOfSuccess: 'Both people can name one next step that feels doable.',
        })
        .mockResolvedValueOnce({
          id: 'ai-proposal-2',
          description:
            'Choose one low-stakes experiment for "predictability" and agree to revisit it after a few days without treating it as permanent.',
          needsAddressed: ['predictability'],
          duration: '3 days',
          measureOfSuccess: 'The experiment gives useful information without creating more pressure.',
        });

      await requestSuggestions(req as Request, res as Response);

      expect(prisma.identifiedNeed.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'need-1',
          vessel: {
            sessionId: mockSessionId,
            userId: mockUser.id,
          },
        },
      });
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            source: 'AI_GENERATED',
            count: 2,
            suggestions: expect.arrayContaining([
              expect.objectContaining({ id: 'ai-proposal-1' }),
              expect.objectContaining({ id: 'ai-proposal-2' }),
            ]),
          }),
        })
      );
      expect(prisma.strategyProposal.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sessionId: mockSessionId,
            createdByUserId: null,
            needsAddressed: ['predictability'],
            source: 'AI_SUGGESTED',
            kind: 'SHARED_PROPOSAL',
            needLinks: {
              create: {
                needId: 'need-1',
              },
            },
          }),
        })
      );
    });

    it('requires a target need or focus need label', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { count: 1 },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });

      await requestSuggestions(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        })
      );
      expect(prisma.strategyProposal.create).not.toHaveBeenCalled();
    });

    it('rejects target needs outside the current user vessel', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          needId: 'partner-need-1',
          count: 1,
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });
      (prisma.identifiedNeed.findFirst as jest.Mock).mockResolvedValue(null);

      await requestSuggestions(req as Request, res as Response);

      expect(prisma.identifiedNeed.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'partner-need-1',
          vessel: {
            sessionId: mockSessionId,
            userId: mockUser.id,
          },
        },
      });
      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'NOT_FOUND' }),
        })
      );
      expect(prisma.strategyProposal.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /sessions/:id/strategies/ready (markReady)', () => {
    it('rejects readiness when current user has not contributed strategies', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });
      (prisma.strategyProposal.count as jest.Mock).mockResolvedValue(0);

      await markReady(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        })
      );
      expect(prisma.stageProgress.update).not.toHaveBeenCalled();
    });
  });

  describe('GET /sessions/:id/strategies/overlap (getOverlap)', () => {
    it('returns null overlap when waiting for partner', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
      });
      // Only user has ranked, partner has not
      (prisma.strategyRanking.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, rankedIds: [mockStrategyIds[0], mockStrategyIds[1], mockStrategyIds[2]] },
      ]);

      await getOverlap(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            overlap: null,
            waitingForPartner: true,
          }),
        })
      );
    });

    it('returns overlap calculation when both have ranked', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
      });
      // Both have ranked with some overlap
      (prisma.strategyRanking.findMany as jest.Mock).mockResolvedValue([
        { userId: mockUser.id, rankedIds: [mockStrategyIds[0], mockStrategyIds[1], mockStrategyIds[2]] },
        { userId: mockPartnerId, rankedIds: [mockStrategyIds[1], mockStrategyIds[0], mockStrategyIds[3]] },
      ]);
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([
        { id: mockStrategyIds[0], description: 'Strategy 1' },
        { id: mockStrategyIds[1], description: 'Strategy 2' },
      ]);

      await getOverlap(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            overlap: expect.any(Array),
            waitingForPartner: false,
          }),
        })
      );
    });
  });

  describe('POST /sessions/:id/agreements (createAgreement)', () => {
    it('creates agreement from top strategy', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: {
          strategyId: mockStrategyIds[0],
          description: 'We will have weekly check-ins',
          type: 'MICRO_EXPERIMENT',
          followUpDate: '2024-02-01',
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
      });
      (prisma.strategyProposal.findUnique as jest.Mock).mockResolvedValue({
        id: mockStrategyIds[0],
        sessionId: mockSessionId,
        description: 'Weekly check-in',
      });
      (prisma.sharedVessel.findUnique as jest.Mock).mockResolvedValue({
        id: 'clvessel00001',
        sessionId: mockSessionId,
      });
      (prisma.agreement.create as jest.Mock).mockResolvedValue({
        id: 'clagreement01',
        description: 'We will have weekly check-ins',
        type: 'MICRO_EXPERIMENT',
        status: 'PROPOSED',
        agreedByA: true,
        agreedByB: false,
        followUpDate: new Date('2024-02-01'),
      });

      await createAgreement(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(201);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            agreement: expect.objectContaining({
              id: 'clagreement01',
              status: 'PROPOSED',
            }),
            awaitingPartnerConfirmation: true,
          }),
        })
      );

      expect(prisma.agreement.create).toHaveBeenCalled();
      expect(notifyPartner).toHaveBeenCalled();
    });

    it('requires authentication', async () => {
      const req = createMockRequest({
        params: { id: mockSessionId },
        body: {
          description: 'We will have weekly check-ins',
          type: 'MICRO_EXPERIMENT',
        },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await createAgreement(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  describe('POST /sessions/:id/agreements/:agreementId/confirm (confirmAgreement)', () => {
    it('confirms agreement when partner agrees', async () => {
      const req = createMockRequest({
        user: { id: mockPartnerId, email: 'partner@example.com', name: 'Partner' },
        params: { id: mockSessionId, agreementId: 'clagreement01' },
        body: { confirmed: true },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
      });
      (prisma.agreement.findUnique as jest.Mock).mockResolvedValue({
        id: 'clagreement01',
        sharedVesselId: 'clvessel00001',
        description: 'Weekly check-in',
        type: 'MICRO_EXPERIMENT',
        status: 'PROPOSED',
        agreedByA: true,
        agreedByB: false,
        sharedVessel: {
          sessionId: mockSessionId,
        },
      });
      (prisma.agreement.update as jest.Mock).mockResolvedValue({
        id: 'clagreement01',
        description: 'Weekly check-in',
        type: 'MICRO_EXPERIMENT',
        status: 'AGREED',
        agreedByA: true,
        agreedByB: true,
        agreedAt: new Date(),
      });
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([{
        id: 'clagreement01',
        agreedByA: true,
        agreedByB: true,
      }]);

      await confirmAgreement(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            agreement: expect.objectContaining({
              agreedByMe: true,
              agreedByPartner: true,
              status: 'AGREED',
            }),
            sessionCanResolve: true,
          }),
        })
      );

      expect(prisma.agreement.update).toHaveBeenCalled();
    });

    it('marks agreement declined when confirmed: false', async () => {
      const req = createMockRequest({
        user: { id: mockPartnerId, email: 'partner@example.com', name: 'Partner' },
        params: { id: mockSessionId, agreementId: 'clagreement01' },
        body: { confirmed: false },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
      });
      (prisma.agreement.findUnique as jest.Mock).mockResolvedValue({
        id: 'clagreement01',
        sharedVesselId: 'clvessel00001',
        description: 'Weekly check-in',
        type: 'MICRO_EXPERIMENT',
        status: 'PROPOSED',
        agreedByA: true,
        agreedByB: false,
        sharedVessel: {
          sessionId: mockSessionId,
        },
      });
      (prisma.agreement.update as jest.Mock).mockResolvedValue({
        id: 'clagreement01',
        description: 'Weekly check-in',
        type: 'MICRO_EXPERIMENT',
        status: 'PROPOSED', // Stays proposed for renegotiation
        agreedByA: true,
        agreedByB: false,
      });
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([{
        id: 'clagreement01',
        agreedByA: true,
        agreedByB: false,
      }]);

      await confirmAgreement(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            agreement: expect.objectContaining({
              agreedByMe: false,
              agreedByPartner: true,
              status: 'PROPOSED',
            }),
            sessionCanResolve: false,
          }),
        })
      );
    });

    it('returns 404 if agreement not found', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId, agreementId: 'clnonexistent' },
        body: { confirmed: true },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.session.findUnique as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
      });
      (prisma.agreement.findUnique as jest.Mock).mockResolvedValue(null);

      await confirmAgreement(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'NOT_FOUND' }),
        })
      );
    });
  });

  describe('Stage 4 need declination', () => {
    const needId = 'need-1';

    function arrangeMutable() {
      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.strategyProposal.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4ProposalSelection.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4NeedCoverage.findFirst as jest.Mock).mockResolvedValue({
        id: 'coverage-1',
        needId,
      });
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.stage4NeedDeclination.findMany as jest.Mock).mockResolvedValue([]);
    }

    it('declines a need (POST decline) and returns updated state', async () => {
      arrangeMutable();
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId, needId },
      });
      const { res, statusMock } = createMockResponse();

      await declineStage4Need(req as Request, res as Response);

      expect(prisma.stage4NeedCoverage.findFirst).toHaveBeenCalledWith({
        where: {
          sessionId: mockSessionId,
          OR: [{ id: needId }, { needId }],
        },
        select: { id: true },
      });
      expect(prisma.stage4NeedDeclination.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sessionId_userId_needId: {
              sessionId: mockSessionId,
              userId: mockUser.id,
              needId,
            },
          },
          create: { sessionId: mockSessionId, userId: mockUser.id, needId },
        })
      );
      expect(statusMock).toHaveBeenCalledWith(200);
    });

    it('rejects phantom need declinations', async () => {
      arrangeMutable();
      (prisma.stage4NeedCoverage.findFirst as jest.Mock).mockResolvedValue(null);
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId, needId: 'phantom-need' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await declineStage4Need(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'NOT_FOUND' }),
        })
      );
      expect(prisma.stage4NeedDeclination.upsert).not.toHaveBeenCalled();
    });

    it('undeclines a need (DELETE decline)', async () => {
      arrangeMutable();
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId, needId },
      });
      const { res, statusMock } = createMockResponse();

      await undeclineStage4Need(req as Request, res as Response);

      expect(prisma.stage4NeedDeclination.deleteMany).toHaveBeenCalledWith({
        where: { sessionId: mockSessionId, userId: mockUser.id, needId },
      });
      expect(statusMock).toHaveBeenCalledWith(200);
    });
  });

  describe('POST /sessions/:id/stage4/share-selections', () => {
    function arrangeForShare(opts: {
      openCoverage?: Array<{
        id: string;
        needId: string | null;
        coverageStatus: 'OPEN' | 'PARTIAL';
        coveringProposalIds: string[];
      }>;
      willingProposalIds?: string[];
      activeProposalIds?: string[];
      declinedNeedIds?: string[];
    }) {
      (prisma.session.findFirst as jest.Mock).mockResolvedValue(mockSession());
      (prisma.stageProgress.findFirst as jest.Mock).mockResolvedValue({
        stage: 4,
        status: 'IN_PROGRESS',
        gatesSatisfied: {},
      });
      (prisma.stage4Closure.findUnique as jest.Mock).mockResolvedValue(null);
      // first findMany: activeSharedProposals; second findMany inside gate: activeProposals (any)
      (prisma.strategyProposal.findMany as jest.Mock)
        .mockResolvedValueOnce(
          (opts.activeProposalIds ?? ['prop-a']).map((id) => ({ id }))
        )
        .mockResolvedValueOnce(
          (opts.activeProposalIds ?? ['prop-a']).map((id) => ({ id }))
        );
      (prisma.stage4ProposalSelection.findMany as jest.Mock)
        // first call: mySelections used to ensure stance on all shared proposals
        .mockResolvedValueOnce(
          (opts.activeProposalIds ?? ['prop-a']).map((proposalId) => ({ proposalId }))
        )
        // second call: WILLING selections for gate
        .mockResolvedValueOnce(
          (opts.willingProposalIds ?? []).map((proposalId) => ({ proposalId }))
        );
      (prisma.stage4NeedCoverage.findMany as jest.Mock).mockResolvedValue(
        opts.openCoverage ?? []
      );
      (prisma.stage4NeedDeclination.findMany as jest.Mock).mockResolvedValue(
        (opts.declinedNeedIds ?? []).map((needId) => ({ needId }))
      );
      (prisma.agreement.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.tendingEntry.findMany as jest.Mock).mockResolvedValue([]);
    }

    it('rejects when an open need is neither addressed-willing nor declined', async () => {
      arrangeForShare({
        openCoverage: [
          {
            id: 'cov-1',
            needId: 'need-1',
            coverageStatus: 'OPEN',
            coveringProposalIds: [],
          },
        ],
        willingProposalIds: ['prop-a'],
        activeProposalIds: ['prop-a'],
      });

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await shareStage4Selections(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'VALIDATION_ERROR',
            message: 'Address or set aside every open need before sharing',
          }),
        })
      );
    });

    it('allows share when every open need is declined', async () => {
      arrangeForShare({
        openCoverage: [
          {
            id: 'cov-1',
            needId: 'need-1',
            coverageStatus: 'OPEN',
            coveringProposalIds: [],
          },
        ],
        willingProposalIds: ['prop-a'],
        activeProposalIds: ['prop-a'],
        declinedNeedIds: ['need-1'],
      });

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock } = createMockResponse();

      await shareStage4Selections(req as Request, res as Response);

      expect(prisma.stageProgress.update).toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(200);
    });

    it('allows share when remaining coverage rows are only partial', async () => {
      arrangeForShare({
        openCoverage: [
          {
            id: 'cov-partial',
            needId: 'need-partial',
            coverageStatus: 'PARTIAL',
            coveringProposalIds: ['prop-a'],
          },
        ],
        willingProposalIds: ['prop-a'],
        activeProposalIds: ['prop-a'],
      });

      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
      });
      const { res, statusMock } = createMockResponse();

      await shareStage4Selections(req as Request, res as Response);

      expect(prisma.stage4NeedCoverage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            coverageStatus: 'OPEN',
          }),
        })
      );
      expect(prisma.stageProgress.update).toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(200);
    });
  });
});
