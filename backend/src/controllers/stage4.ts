/**
 * Stage 4 Controller
 *
 * Handles the Strategic Repair stage endpoints:
 * - GET /sessions/:id/strategies - Get anonymous strategy pool
 * - POST /sessions/:id/strategies - Propose a strategy
 * - POST /sessions/:id/strategies/rank - Submit ranking
 * - GET /sessions/:id/strategies/overlap - Get ranking overlap
 * - POST /sessions/:id/agreements - Create agreement
 * - POST /sessions/:id/agreements/:agreementId/confirm - Confirm agreement
 */

import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import {
  proposeStrategyRequestSchema,
  rankStrategiesRequestSchema,
  confirmAgreementRequestSchema,
  AgreementType,
  ApiResponse,
  ErrorCode,
  StrategyPhase,
  MAX_AGREEMENTS,
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
  GetStage4StateResponse,
} from '@meet-without-fear/shared';
import { notifyPartner, publishSessionEvent } from '../services/realtime';
import { successResponse, errorResponse } from '../utils/response';
import { getPartnerUserId } from '../utils/session';
import { getStage4State as buildStage4State, Stage4StateNotFoundError } from '../services/stage4-state';
import { stage4HandoffBridgeMessage } from '../services/stage4-prompts';
import {
  scheduleIndividualCommitmentTendingEntries,
  scheduleSharedAgreementTendingEntries,
} from '../services/tending.service';
import { getModelCompletion } from '../lib/bedrock';
import { extractJsonFromResponse } from '../utils/json-extractor';
import { findMessageByContent } from '../utils/message-dedupe';
import { z } from 'zod';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Determine which user slot (A or B) a user occupies in a session
 */
async function getUserSlot(
  sessionId: string,
  userId: string
): Promise<'A' | 'B' | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      relationship: {
        include: {
          members: {
            orderBy: { joinedAt: 'asc' },
          },
        },
      },
    },
  });

  if (!session) return null;

  const members = session.relationship.members;
  if (members.length < 2) return null;

  // First member is A, second is B
  if (members[0].userId === userId) return 'A';
  if (members[1].userId === userId) return 'B';

  return null;
}

/**
 * Shuffle array for random ordering
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

type StrategyProposalForVisibility = {
  id: string;
  description: string;
  needsAddressed: string[];
  duration: string | null;
  measureOfSuccess: string | null;
  createdByUserId: string | null;
};

function toStrategyDTO(strategy: StrategyProposalForVisibility) {
  return {
    id: strategy.id,
    description: strategy.description,
    needsAddressed: strategy.needsAddressed,
    duration: strategy.duration,
    measureOfSuccess: strategy.measureOfSuccess,
  };
}

type Stage4SuggestionDraft = {
  description: string;
  duration: string | null;
  measureOfSuccess: string | null;
};

function normalizeSuggestionDrafts(value: unknown, count: number): Stage4SuggestionDraft[] {
  const raw =
    typeof value === 'object' && value !== null && Array.isArray((value as { suggestions?: unknown }).suggestions)
      ? (value as { suggestions: unknown[] }).suggestions
      : [];

  return raw
    .map((item): Stage4SuggestionDraft | null => {
      if (typeof item !== 'object' || item === null) return null;
      const draft = item as Record<string, unknown>;
      const description = typeof draft.description === 'string' ? draft.description.trim() : '';
      if (description.length < 10) return null;
      return {
        description,
        duration: typeof draft.duration === 'string' && draft.duration.trim() ? draft.duration.trim() : null,
        measureOfSuccess:
          typeof draft.measureOfSuccess === 'string' && draft.measureOfSuccess.trim()
            ? draft.measureOfSuccess.trim()
            : null,
      };
    })
    .filter((draft): draft is Stage4SuggestionDraft => draft !== null)
    .slice(0, count);
}

function fallbackSuggestionDrafts(needLabel: string, count: number): Stage4SuggestionDraft[] {
  const base = needLabel.trim() || 'this need';
  const drafts: Stage4SuggestionDraft[] = [
    {
      description: `Try one small check-in focused on "${base}" and each name one concrete thing that would help this week.`,
      duration: '10 minutes, once this week',
      measureOfSuccess: 'Both people can name one next step that feels doable.',
    },
    {
      description: `Choose one low-stakes experiment for "${base}" and agree to revisit it after a few days without treating it as permanent.`,
      duration: '3 days',
      measureOfSuccess: 'The experiment gives useful information without creating more pressure.',
    },
    {
      description: `Set aside one moment to ask, "What would make ${base} easier right now?" and write down the smallest answer either person can offer.`,
      duration: 'One conversation this week',
      measureOfSuccess: 'There is one specific action or boundary to try next.',
    },
  ];
  return drafts.slice(0, count);
}

async function generateStage4SuggestionDrafts(params: {
  sessionId: string;
  needLabel: string;
  count: number;
  globalLibraryItems: Array<{ title: string; description: string; category: string }>;
}): Promise<Stage4SuggestionDraft[]> {
  const libraryContext =
    params.globalLibraryItems.length > 0
      ? params.globalLibraryItems
          .map((item) => `- ${item.title} (${item.category}): ${item.description}`)
          .join('\n')
      : '(none available)';

  const response = await getModelCompletion('haiku', {
    systemPrompt: [
      'You generate Stage 4 micro-experiment suggestions for one confirmed need.',
      'Use only the need label and the global micro-experiments library below. Do not use user memory or unrelated session history.',
      'Return JSON only: {"suggestions":[{"description":"...","duration":"...","measureOfSuccess":"..."}]}.',
      'Each suggestion must be concrete, small, reversible, observable, and phrased as something the partners could try.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `Need: ${params.needLabel}`,
          `Count: ${params.count}`,
          '',
          'Global micro-experiments library:',
          libraryContext,
        ].join('\n'),
      },
    ],
    maxTokens: 900,
    operation: 'stage4-need-suggestions',
    sessionId: params.sessionId,
    turnId: `${params.sessionId}:stage4-suggest:${Date.now()}`,
  });

  if (!response) return fallbackSuggestionDrafts(params.needLabel, params.count);

  try {
    const parsed = extractJsonFromResponse(response);
    const drafts = normalizeSuggestionDrafts(parsed, params.count);
    return drafts.length > 0 ? drafts : fallbackSuggestionDrafts(params.needLabel, params.count);
  } catch (error) {
    logger.warn('[requestSuggestions] Failed to parse AI suggestion response; using fallback', error);
    return fallbackSuggestionDrafts(params.needLabel, params.count);
  }
}

// Create agreement request schema locally
const createAgreementRequestSchema = z.object({
  strategyId: z.string().optional(),
  description: z.string().min(1, 'Description is required'),
  type: z.nativeEnum(AgreementType),
  duration: z.string().optional(),
  measureOfSuccess: z.string().optional(),
  followUpDate: z.string().optional(),
});

const stage4SelectionDecisionSchema = z.nativeEnum(Stage4SelectionDecision);

const submitStage4SelectionRequestSchema = z.object({
  decision: stage4SelectionDecisionSchema,
  note: z.string().max(1000).optional(),
});

const submitStage4SelectionsRequestSchema = z.object({
  selections: z
    .array(
      z.object({
        proposalId: z.string().min(1, 'Proposal ID is required'),
        decision: stage4SelectionDecisionSchema,
        note: z.string().max(1000).optional(),
      })
    )
    .min(1, 'At least one selection is required'),
});

const stage4NeedWalkthroughActionSchema = z.object({
  action: z.enum(['covered', 'skip', 'reset']),
});

const requestSuggestionsRequestSchema = z.object({
  count: z.number().int().min(1).max(3).optional().default(3),
  focusNeeds: z.array(z.string()).optional(),
  needId: z.string().min(1).optional(),
});

const closeStage4RequestSchema = z.object({
  kind: z.nativeEnum(Stage4ClosureKind).optional(),
  reason: z.nativeEnum(Stage4ClosureReason).optional(),
  summary: z.string().max(2000).optional(),
  checkInDate: z
    .string()
    .min(1, 'checkInDate is required')
    .refine((value) => !Number.isNaN(new Date(value).getTime()), {
      message: 'checkInDate must be a valid ISO date string',
    })
    .optional(),
  // Optional, deprecated. Kept for backward compatibility — Phase 4 removes it.
  // TODO(phase-4): remove followUpDatesByProposalId; checkInDate is the single source.
  followUpDatesByProposalId: z.record(z.string()).optional(),
});

type Stage4MutableSession = {
  id: string;
  status: string;
  relationship: {
    members: Array<{ userId: string; joinedAt: Date }>;
  };
};

type Stage4ProposalForClosure = {
  id: string;
  sessionId: string;
  description: string;
  duration: string | null;
  measureOfSuccess: string | null;
  kind: Stage4ProposalKind;
  status: Stage4ProposalStatus;
  createdByUserId: string | null;
};

type Stage4SelectionForClosure = {
  proposalId: string;
  userId: string;
  decision: Stage4SelectionDecision;
};

type Stage4CoverageForClosure = {
  id: string;
  needId: string | null;
  coverageStatus: string;
};

class Stage4ClosedConflictError extends Error {
  constructor() {
    super('Stage 4 is already closed');
    this.name = 'Stage4ClosedConflictError';
  }
}

class Stage4WalkthroughNeedNotFoundError extends Error {
  constructor() {
    super('Stage 4 walkthrough need not found');
    this.name = 'Stage4WalkthroughNeedNotFoundError';
  }
}

type Stage4ProgressWriter = {
  stageProgress: {
    update(args: Prisma.StageProgressUpdateArgs): Promise<unknown>;
  };
};

async function getMutableStage4Session(
  sessionId: string,
  userId: string
): Promise<{ session: Stage4MutableSession; progress: { stage: number; gatesSatisfied: Prisma.JsonValue | null } | null } | null> {
  const session = (await prisma.session.findFirst({
    where: {
      id: sessionId,
      relationship: {
        members: {
          some: { userId },
        },
      },
    },
    include: {
      relationship: {
        include: {
          members: {
            orderBy: { joinedAt: 'asc' },
          },
        },
      },
    },
  })) as Stage4MutableSession | null;

  if (!session) return null;

  const progress = await prisma.stageProgress.findFirst({
    where: {
      sessionId,
      userId,
      status: 'IN_PROGRESS',
    },
    orderBy: { stage: 'desc' },
    select: { stage: true, gatesSatisfied: true },
  });

  return { session, progress };
}

async function stage4NeedExistsForSession(sessionId: string, needId: string): Promise<boolean> {
  const need = await prisma.stage4NeedCoverage.findFirst({
    where: {
      sessionId,
      OR: [{ id: needId }, { needId }],
    },
    select: { id: true },
  });
  return Boolean(need);
}

async function markStage4SelectionSubmitted(
  sessionId: string,
  userId: string,
  existingGates: Prisma.JsonValue | null | undefined,
  client: Stage4ProgressWriter = prisma
): Promise<void> {
  const gatesSatisfied = {
    ...((existingGates as Record<string, unknown> | null) || {}),
    selectionSubmitted: true,
    selectionSubmittedAt: new Date().toISOString(),
  } satisfies Prisma.InputJsonValue;

  await client.stageProgress.update({
    where: {
      sessionId_userId_stage: { sessionId, userId, stage: 4 },
    },
    data: { gatesSatisfied },
  });
}

async function clearStage4SelectionSubmitted(
  sessionId: string,
  userId: string,
  existingGates: Prisma.JsonValue | null | undefined,
  client: Stage4ProgressWriter = prisma
): Promise<void> {
  const next = {
    ...((existingGates as Record<string, unknown> | null) || {}),
  };
  delete next.selectionSubmitted;
  delete next.selectionSubmittedAt;

  await client.stageProgress.update({
    where: {
      sessionId_userId_stage: { sessionId, userId, stage: 4 },
    },
    data: { gatesSatisfied: next as Prisma.InputJsonValue },
  });
}

function hasSubmittedSelectionGate(
  existingGates: Prisma.JsonValue | null | undefined
): boolean {
  const gates = existingGates as Record<string, unknown> | null | undefined;
  return Boolean(gates && gates.selectionSubmitted === true);
}

async function updateStage4WalkthroughNeed(
  sessionId: string,
  userId: string,
  needId: string,
  action: 'covered' | 'skip' | 'reset',
): Promise<GetStage4StateResponse> {
  const before = await buildStage4State(sessionId, userId);
  const targetOwnNeed = before.walkthrough.ownNeeds.find(need => need.id === needId);
  const targetPartnerNeed = before.walkthrough.partnerNeeds.find(need => need.id === needId);
  if (!targetOwnNeed && !targetPartnerNeed) {
    throw new Stage4WalkthroughNeedNotFoundError();
  }

  const progress = await prisma.stageProgress.findUnique({
    where: { sessionId_userId_stage: { sessionId, userId, stage: 4 } },
    select: { gatesSatisfied: true },
  });
  const gates = (progress?.gatesSatisfied as Record<string, unknown> | null) ?? {};
  const existing =
    gates.stage4Walkthrough &&
    typeof gates.stage4Walkthrough === 'object' &&
    !Array.isArray(gates.stage4Walkthrough)
      ? (gates.stage4Walkthrough as Record<string, unknown>)
      : {};
  const covered = new Set(
    Array.isArray(existing.coveredNeedIds)
      ? existing.coveredNeedIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const skipped = new Set(
    Array.isArray(existing.skippedNeedIds)
      ? existing.skippedNeedIds.filter((id): id is string => typeof id === 'string')
      : [],
  );

  if (action === 'covered') {
    covered.add(needId);
    skipped.delete(needId);
  } else if (action === 'skip') {
    skipped.add(needId);
    covered.delete(needId);
  } else {
    covered.delete(needId);
    skipped.delete(needId);
  }

  const remainingOwn = before.walkthrough.ownNeeds.find(
    need => !covered.has(need.id) && !skipped.has(need.id),
  );
  const remainingPartner = before.walkthrough.partnerNeeds.find(
    need => !covered.has(need.id) && !skipped.has(need.id),
  );

  let phase: 'MY_NEEDS' | 'PARTNER_NEEDS' | 'QUALITY_REVIEW';
  let currentNeedId: string | null;
  if (action === 'reset') {
    phase = targetOwnNeed ? 'MY_NEEDS' : 'PARTNER_NEEDS';
    currentNeedId = needId;
  } else if (before.walkthrough.phase === 'MY_NEEDS' && remainingOwn) {
    phase = 'MY_NEEDS';
    currentNeedId = remainingOwn.id;
  } else if (before.walkthrough.phase === 'MY_NEEDS' && remainingPartner) {
    phase = 'PARTNER_NEEDS';
    currentNeedId = remainingPartner.id;
  } else if (before.walkthrough.phase === 'PARTNER_NEEDS' && remainingPartner) {
    phase = 'PARTNER_NEEDS';
    currentNeedId = remainingPartner.id;
  } else if (remainingOwn) {
    phase = 'MY_NEEDS';
    currentNeedId = remainingOwn.id;
  } else if (remainingPartner) {
    phase = 'PARTNER_NEEDS';
    currentNeedId = remainingPartner.id;
  } else {
    phase = 'QUALITY_REVIEW';
    currentNeedId = null;
  }

  await prisma.stageProgress.update({
    where: { sessionId_userId_stage: { sessionId, userId, stage: 4 } },
    data: {
      gatesSatisfied: {
        ...gates,
        stage4Walkthrough: {
          phase,
          currentNeedId,
          coveredNeedIds: [...covered],
          skippedNeedIds: [...skipped],
          updatedAt: new Date().toISOString(),
        },
      } satisfies Prisma.InputJsonValue,
    },
  });

  return buildStage4State(sessionId, userId);
}

function userIsSessionMember(session: Stage4MutableSession, userId: string): boolean {
  return session.relationship.members.some((member) => member.userId === userId);
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function assertStage4StillOpen(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  if (await tx.stage4Closure.findUnique({ where: { sessionId } })) {
    throw new Stage4ClosedConflictError();
  }
}

function selectionsByProposalAndUser(
  selections: Stage4SelectionForClosure[]
): Map<string, Map<string, Stage4SelectionForClosure>> {
  const byProposal = new Map<string, Map<string, Stage4SelectionForClosure>>();
  for (const selection of selections) {
    const byUser = byProposal.get(selection.proposalId) ?? new Map<string, Stage4SelectionForClosure>();
    byUser.set(selection.userId, selection);
    byProposal.set(selection.proposalId, byUser);
  }
  return byProposal;
}

function bothPartnersWilling(
  proposalId: string,
  session: Stage4MutableSession,
  selectionsByProposal: Map<string, Map<string, Stage4SelectionForClosure>>
): boolean {
  const proposalSelections = selectionsByProposal.get(proposalId);
  if (!proposalSelections) return false;

  return session.relationship.members.every(
    (member) => proposalSelections.get(member.userId)?.decision === Stage4SelectionDecision.WILLING
  );
}

function requiresSharedSelection(proposal: Stage4ProposalForClosure): boolean {
  return proposal.kind === Stage4ProposalKind.SHARED_PROPOSAL && proposal.status === Stage4ProposalStatus.ACTIVE;
}

function getWillingIndividualCommitments(
  proposals: Stage4ProposalForClosure[],
  selections: Stage4SelectionForClosure[]
): Stage4ProposalForClosure[] {
  return proposals
    .filter((proposal) => proposal.kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT)
    .filter((proposal) =>
      selections.some(
        (selection) =>
          selection.proposalId === proposal.id &&
          selection.decision === Stage4SelectionDecision.WILLING &&
          (!proposal.createdByUserId || proposal.createdByUserId === selection.userId)
      )
    );
}


function buildClosureSummary(
  kind: Stage4ClosureKind,
  mutualProposalCount: number,
  individualCommitmentCount: number,
  openNeedCount: number,
  requestedSummary?: string
): string {
  if (requestedSummary) return requestedSummary;

  if (kind === Stage4ClosureKind.SHARED_AGREEMENT) {
    return `Closed with ${mutualProposalCount} shared agreement${mutualProposalCount === 1 ? '' : 's'} and ${individualCommitmentCount} individual commitment${individualCommitmentCount === 1 ? '' : 's'}.`;
  }

  return `Closed without a shared agreement, preserving ${individualCommitmentCount} individual commitment${individualCommitmentCount === 1 ? '' : 's'} and ${openNeedCount} still-open need${openNeedCount === 1 ? '' : 's'}.`;
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * Get redesigned Stage 4 state for proposal inventory, coverage, selections,
 * outcome, and Tending preview.
 * GET /sessions/:id/stage4
 */
export async function getStage4State(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const state = await buildStage4State(sessionId, user.id);

    successResponse(res, state);
  } catch (error) {
    if (error instanceof Stage4StateNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    logger.error('[getStage4State] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get Stage 4 state', 500);
  }
}

/**
 * Submit one redesigned Stage 4 per-proposal willingness decision.
 * POST /sessions/:id/stage4/proposals/:proposalId/selection
 */
export async function submitStage4ProposalSelection(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId, proposalId } = req.params;
    const parseResult = submitStage4SelectionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    await submitStage4SelectionsInternal(
      req,
      res,
      sessionId,
      user.id,
      [{ proposalId, ...parseResult.data }]
    );
  } catch (error) {
    logger.error('[submitStage4ProposalSelection] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to submit Stage 4 selection', 500);
  }
}

/**
 * Submit redesigned Stage 4 per-proposal willingness decisions.
 * POST /sessions/:id/stage4/selections
 */
export async function submitStage4Selections(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const parseResult = submitStage4SelectionsRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    await submitStage4SelectionsInternal(req, res, sessionId, user.id, parseResult.data.selections);
  } catch (error) {
    logger.error('[submitStage4Selections] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to submit Stage 4 selections', 500);
  }
}

/**
 * Persist Stage 4 walkthrough progress for one need.
 * POST /sessions/:id/stage4/walkthrough/needs/:needId
 */
export async function updateStage4WalkthroughNeedStatus(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId, needId } = req.params;
    const parseResult = stage4NeedWalkthroughActionSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    const mutable = await getMutableStage4Session(sessionId, user.id);
    if (!mutable) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (mutable.session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (mutable.progress?.stage !== 4) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot update Stage 4 walkthrough: you are in stage ${mutable.progress?.stage ?? 0}, but stage 4 is required`,
        400,
      );
      return;
    }
    if (await prisma.stage4Closure.findUnique({ where: { sessionId } })) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }

    const state = await updateStage4WalkthroughNeed(
      sessionId,
      user.id,
      needId,
      parseResult.data.action
    );
    successResponse(res, { state });
  } catch (error) {
    if (error instanceof Stage4StateNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (error instanceof Stage4WalkthroughNeedNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Need not found', 404);
      return;
    }
    logger.error('[updateStage4WalkthroughNeedStatus] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to update Stage 4 walkthrough', 500);
  }
}

async function submitStage4SelectionsInternal(
  req: Request,
  res: Response,
  sessionId: string,
  userId: string,
  selections: Array<{ proposalId: string; decision: Stage4SelectionDecision; note?: string }>
): Promise<void> {
  const mutable = await getMutableStage4Session(sessionId, userId);
  if (!mutable) {
    errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
    return;
  }

  if (mutable.session.status !== 'ACTIVE') {
    errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
    return;
  }

  const currentStage = await prisma.stageProgress.findFirst({
    where: { sessionId, userId, status: 'IN_PROGRESS' },
    orderBy: { stage: 'desc' },
  });
  if ((currentStage?.stage ?? 0) !== 4) {
    errorResponse(
      res,
      'VALIDATION_ERROR',
      `Cannot submit Stage 4 selections: you are in stage ${currentStage?.stage ?? 0}, but stage 4 is required`,
      400
    );
    return;
  }

  const existingClosure = await prisma.stage4Closure.findUnique({ where: { sessionId } });
  if (existingClosure) {
    errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
    return;
  }

  const uniqueProposalIds = [...new Set(selections.map((selection) => selection.proposalId))];
  if (uniqueProposalIds.length !== selections.length) {
    errorResponse(res, 'VALIDATION_ERROR', 'Proposal selections must be unique per request', 400);
    return;
  }

  const proposals = await prisma.strategyProposal.findMany({
    where: {
      sessionId,
      id: { in: uniqueProposalIds },
      status: Stage4ProposalStatus.ACTIVE,
    },
    select: { id: true },
  });
  const validProposalIds = new Set(proposals.map((proposal) => proposal.id));
  if (uniqueProposalIds.some((proposalId) => !validProposalIds.has(proposalId))) {
    errorResponse(res, 'VALIDATION_ERROR', 'Selections must reference active proposals in this session', 400);
    return;
  }

  const submittedAt = new Date();
  await prisma.$transaction(
    selections.map((selection) =>
      prisma.stage4ProposalSelection.upsert({
        where: {
          proposalId_userId: {
            proposalId: selection.proposalId,
            userId,
          },
        },
        create: {
          proposalId: selection.proposalId,
          sessionId,
          userId,
          decision: selection.decision,
          note: selection.note,
          selectedAt: submittedAt,
        },
        update: {
          decision: selection.decision,
          note: selection.note,
          selectedAt: submittedAt,
        },
      })
    )
  );

  // Per-tap selections are kept private until the user explicitly shares.
  // If the user has already shared, persist the change but clear the gate so
  // the partner doesn't see partially-revised stances mid-stream.
  if (hasSubmittedSelectionGate(mutable.progress?.gatesSatisfied)) {
    await clearStage4SelectionSubmitted(sessionId, userId, mutable.progress?.gatesSatisfied);
    const partnerId = await getPartnerUserId(sessionId, userId);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'session.strategies_updated', {
        stage: 4,
        submittedBy: userId,
        change: 'stage4_selection_revised',
      });
    }
  }

  const state = await buildStage4State(sessionId, userId);
  const partnerId = await getPartnerUserId(sessionId, userId);
  const partnerSubmitted = state.partnerSelectionStatus === 'SUBMITTED';

  successResponse(res, {
    submitted: state.mySelectionStatus === 'SUBMITTED',
    submittedAt: submittedAt.toISOString(),
    partnerSubmitted,
    state,
  });
  void partnerId;
}

/**
 * Mark the current user's Stage 4 selections as shared with their partner.
 * Requires a selection on every active proposal.
 * POST /sessions/:id/stage4/share-selections
 */
export async function shareStage4Selections(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const mutable = await getMutableStage4Session(sessionId, user.id);
    if (!mutable) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (mutable.session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (await prisma.stage4Closure.findUnique({ where: { sessionId } })) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }

    // Stances are required only on shared proposals — individual commitments
    // are one-sided so a stance from the non-owner isn't expected.
    const [activeSharedProposals, mySelections] = await Promise.all([
      prisma.strategyProposal.findMany({
        where: {
          sessionId,
          status: Stage4ProposalStatus.ACTIVE,
          kind: Stage4ProposalKind.SHARED_PROPOSAL,
        },
        select: { id: true },
      }),
      prisma.stage4ProposalSelection.findMany({
        where: { sessionId, userId: user.id },
        select: { proposalId: true },
      }),
    ]);

    if (activeSharedProposals.length === 0) {
      errorResponse(res, 'VALIDATION_ERROR', 'No shared proposals to share stances on yet', 400);
      return;
    }

    const selectedIds = new Set(mySelections.map((s) => s.proposalId));
    const missing = activeSharedProposals.filter((p) => !selectedIds.has(p.id));
    if (missing.length > 0) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Take a stance on every shared proposal before sharing',
        400
      );
      return;
    }

    // Gate: every open need must be addressed by a willing-active
    // proposal or explicitly declined ("leave for now") by this user.
    const [openNeeds, willingSelections, declinations] = await Promise.all([
      prisma.stage4NeedCoverage.findMany({
        where: {
          sessionId,
          coverageStatus: 'OPEN',
        },
        select: {
          id: true,
          needId: true,
          coverageStatus: true,
          coveringProposalIds: true,
        },
      }),
      prisma.stage4ProposalSelection.findMany({
        where: {
          sessionId,
          userId: user.id,
          decision: Stage4SelectionDecision.WILLING,
        },
        select: { proposalId: true },
      }),
      prisma.stage4NeedDeclination.findMany({
        where: { sessionId, userId: user.id },
        select: { needId: true },
      }),
    ]);

    const willingProposalIds = new Set(willingSelections.map((s) => s.proposalId));
    const activeProposalIds = new Set(
      (
        await prisma.strategyProposal.findMany({
          where: { sessionId, status: Stage4ProposalStatus.ACTIVE },
          select: { id: true },
        })
      ).map((p) => p.id)
    );
    const declinedNeedIds = new Set(declinations.map((d) => d.needId));

    const ungated = openNeeds.filter((row) => {
      const needIdentifier = row.needId ?? row.id;
      if (declinedNeedIds.has(needIdentifier)) return false;
      const hasWillingCover = row.coveringProposalIds.some(
        (pid) => activeProposalIds.has(pid) && willingProposalIds.has(pid)
      );
      return !hasWillingCover;
    });

    if (ungated.length > 0) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Address or set aside every open need before sharing',
        400
      );
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        await assertStage4StillOpen(tx, sessionId);
        await markStage4SelectionSubmitted(sessionId, user.id, mutable.progress?.gatesSatisfied, tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'session.strategies_updated', {
        stage: 4,
        submittedBy: user.id,
        change: 'stage4_selection_submitted',
      });
    }

    // Stage 4 Phase 6 (Surface 5) — quiet handoff bridge. When this user shares
    // for the first time AND the partner hasn't shared yet, append a single
    // templated AI message to their chat so the moment doesn't go silent.
    try {
      const partnerProgress = partnerId
        ? await prisma.stageProgress.findFirst({
            where: { sessionId, userId: partnerId, stage: 4 },
            select: { gatesSatisfied: true },
          })
        : null;
      const partnerHasShared = hasSubmittedSelectionGate(partnerProgress?.gatesSatisfied);
      if (!partnerHasShared) {
        const sessionWithMembers = await prisma.session.findUnique({
          where: { id: sessionId },
          include: {
            relationship: {
              include: {
                members: {
                  include: { user: { select: { firstName: true, name: true } } },
                },
              },
            },
          },
        });
        const members = sessionWithMembers?.relationship.members ?? [];
        const myMember = members.find((m) => m.userId === user.id);
        const partnerMember = members.find((m) => m.userId !== user.id);
        const partnerName =
          myMember?.nickname ||
          partnerMember?.user.firstName ||
          partnerMember?.user.name ||
          undefined;
        const bridgeContent = stage4HandoffBridgeMessage(partnerName);
        // Matched on contentHash, not content: the content column is encrypted with
        // a random IV per write, so equality on it can never match. See
        // utils/message-dedupe.ts.
        const alreadyBridged = Boolean(
          await findMessageByContent(prisma.message, {
            sessionId,
            forUserId: user.id,
            role: 'AI',
            content: bridgeContent,
          })
        );
        if (!alreadyBridged) {
          await prisma.message.create({
            data: {
              sessionId,
              senderId: null,
              forUserId: user.id,
              role: 'AI',
              content: bridgeContent,
              stage: 4,
            },
          });
        }
      }
    } catch (bridgeError) {
      logger.warn('[shareStage4Selections] Failed to persist handoff bridge message', { bridgeError });
    }

    const state = await buildStage4State(sessionId, user.id);
    successResponse(res, { state });
  } catch (error) {
    if (error instanceof Stage4ClosedConflictError) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }
    logger.error('[shareStage4Selections] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to share Stage 4 selections', 500);
  }
}

/**
 * Mark a need as "leave for now" — explicitly declines to address it.
 * POST /sessions/:id/stage4/needs/:needId/decline
 */
export async function declineStage4Need(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId, needId } = req.params;
    const mutable = await getMutableStage4Session(sessionId, user.id);
    if (!mutable) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (mutable.session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (mutable.progress?.stage !== 4) {
      errorResponse(res, 'VALIDATION_ERROR', `Cannot decline need: you are in stage ${mutable.progress?.stage ?? 0}, but stage 4 is required`, 400);
      return;
    }
    if (await prisma.stage4Closure.findUnique({ where: { sessionId } })) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }
    if (!(await stage4NeedExistsForSession(sessionId, needId))) {
      errorResponse(res, 'NOT_FOUND', 'Need not found', 404);
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        await assertStage4StillOpen(tx, sessionId);
        await tx.stage4NeedDeclination.upsert({
          where: { sessionId_userId_needId: { sessionId, userId: user.id, needId } },
          update: {},
          create: { sessionId, userId: user.id, needId },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    const state = await buildStage4State(sessionId, user.id);
    successResponse(res, { state });
  } catch (error) {
    if (error instanceof Stage4ClosedConflictError) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }
    logger.error('[declineStage4Need] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to decline need', 500);
  }
}

/**
 * Remove a "leave for now" declination — user changed their mind.
 * DELETE /sessions/:id/stage4/needs/:needId/decline
 */
export async function undeclineStage4Need(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId, needId } = req.params;
    const mutable = await getMutableStage4Session(sessionId, user.id);
    if (!mutable) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (mutable.session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (mutable.progress?.stage !== 4) {
      errorResponse(res, 'VALIDATION_ERROR', `Cannot undecline need: you are in stage ${mutable.progress?.stage ?? 0}, but stage 4 is required`, 400);
      return;
    }
    if (await prisma.stage4Closure.findUnique({ where: { sessionId } })) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }
    if (!(await stage4NeedExistsForSession(sessionId, needId))) {
      errorResponse(res, 'NOT_FOUND', 'Need not found', 404);
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        await assertStage4StillOpen(tx, sessionId);
        await tx.stage4NeedDeclination.deleteMany({
          where: { sessionId, userId: user.id, needId },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    const state = await buildStage4State(sessionId, user.id);
    successResponse(res, { state });
  } catch (error) {
    if (error instanceof Stage4ClosedConflictError) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }
    logger.error('[undeclineStage4Need] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to undecline need', 500);
  }
}

/**
 * Withdraw the current user's shared Stage 4 selections so they can revise.
 * Partner immediately stops seeing them as shared.
 * POST /sessions/:id/stage4/unshare-selections
 */
export async function unshareStage4Selections(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const mutable = await getMutableStage4Session(sessionId, user.id);
    if (!mutable) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (mutable.session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (await prisma.stage4Closure.findUnique({ where: { sessionId } })) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        await assertStage4StillOpen(tx, sessionId);
        await clearStage4SelectionSubmitted(sessionId, user.id, mutable.progress?.gatesSatisfied, tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'session.strategies_updated', {
        stage: 4,
        submittedBy: user.id,
        change: 'stage4_selection_revised',
      });
    }

    const state = await buildStage4State(sessionId, user.id);
    successResponse(res, { state });
  } catch (error) {
    if (error instanceof Stage4ClosedConflictError) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }
    logger.error('[unshareStage4Selections] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to revise Stage 4 selections', 500);
  }
}

/**
 * Close redesigned Stage 4 from willingness selections.
 * POST /sessions/:id/stage4/close
 */
export async function closeStage4(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const parseResult = closeStage4RequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    const mutable = await getMutableStage4Session(sessionId, user.id);
    if (!mutable) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    if (mutable.session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    const currentStage = await prisma.stageProgress.findFirst({
      where: { sessionId, userId: user.id, status: 'IN_PROGRESS' },
      orderBy: { stage: 'desc' },
    });
    if ((currentStage?.stage ?? 0) !== 4) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot close Stage 4: you are in stage ${currentStage?.stage ?? 0}, but stage 4 is required`,
        400
      );
      return;
    }

    if (await prisma.stage4Closure.findUnique({ where: { sessionId } })) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }

    const memberUserIds = mutable.session.relationship.members.map((member) => member.userId);
    const [proposals, selections, coverageRows, sharedVessel, stage4ProgressRows] = await Promise.all([
      prisma.strategyProposal.findMany({
        where: { sessionId, status: { not: Stage4ProposalStatus.REMOVED } },
        select: {
          id: true,
          sessionId: true,
          description: true,
          duration: true,
          measureOfSuccess: true,
          kind: true,
          status: true,
          createdByUserId: true,
        },
      }) as Promise<Stage4ProposalForClosure[]>,
      prisma.stage4ProposalSelection.findMany({
        where: { sessionId },
        select: { proposalId: true, userId: true, decision: true },
      }) as Promise<Stage4SelectionForClosure[]>,
      prisma.stage4NeedCoverage.findMany({
        where: { sessionId },
        select: { id: true, needId: true, coverageStatus: true },
      }) as Promise<Stage4CoverageForClosure[]>,
      prisma.sharedVessel.findUnique({ where: { sessionId } }),
      prisma.stageProgress.findMany({
        where: { sessionId, stage: 4, userId: { in: memberUserIds } },
        select: { userId: true, gatesSatisfied: true },
      }),
    ]);

    if (!sharedVessel) {
      errorResponse(res, 'NOT_FOUND', 'Shared vessel not found', 404);
      return;
    }

    const progressByUserId = new Map(stage4ProgressRows.map((progress) => [progress.userId, progress]));
    const bothPartnersSubmitted = mutable.session.relationship.members.every((member) =>
      hasSubmittedSelectionGate(progressByUserId.get(member.userId)?.gatesSatisfied)
    );
    const selectionsByProposal = selectionsByProposalAndUser(selections);
    const mutuallyWillingSharedProposals = proposals
      .filter(requiresSharedSelection)
      .filter((proposal) => bothPartnersWilling(proposal.id, mutable.session, selectionsByProposal))
      .slice(0, MAX_AGREEMENTS);
    const willingIndividualCommitments = getWillingIndividualCommitments(proposals, selections);
    const individualProposalIds = willingIndividualCommitments.map((p) => p.id);
    const openNeedIds = coverageRows
      .filter((row) => row.coverageStatus === 'OPEN' || row.coverageStatus === 'PARTIAL')
      .map((row) => row.needId ?? row.id);

    const requestedKind = parseResult.data.kind;
    const closureKind =
      requestedKind ??
      (mutuallyWillingSharedProposals.length > 0 && bothPartnersSubmitted
        ? Stage4ClosureKind.SHARED_AGREEMENT
        : Stage4ClosureKind.NO_SHARED_AGREEMENT);

    if (closureKind === Stage4ClosureKind.SHARED_AGREEMENT) {
      if (!bothPartnersSubmitted) {
        errorResponse(res, 'VALIDATION_ERROR', 'Both partners must submit selections before shared agreement closure', 400);
        return;
      }
      if (mutuallyWillingSharedProposals.length === 0) {
        errorResponse(res, 'VALIDATION_ERROR', 'No mutually willing shared proposals are available to close', 400);
        return;
      }
    }

    if (
      closureKind === Stage4ClosureKind.NO_SHARED_AGREEMENT &&
      mutuallyWillingSharedProposals.length > 0 &&
      parseResult.data.reason !== Stage4ClosureReason.BOUNDARY_HONORED &&
      parseResult.data.reason !== Stage4ClosureReason.USER_STOPPED
    ) {
      errorResponse(res, 'VALIDATION_ERROR', 'Mutual willingness exists; no-shared-agreement closure requires an explicit boundary or stop reason', 400);
      return;
    }

    const now = new Date();
    const closureReason =
      parseResult.data.reason ??
      (closureKind === Stage4ClosureKind.SHARED_AGREEMENT
        ? Stage4ClosureReason.MUTUAL_SELECTION
        : bothPartnersSubmitted
          ? Stage4ClosureReason.NO_OVERLAP
          : Stage4ClosureReason.USER_STOPPED);
    const summary = buildClosureSummary(
      closureKind,
      mutuallyWillingSharedProposals.length,
      individualProposalIds.length,
      openNeedIds.length,
      parseResult.data.summary
    );

    const agreementIds = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const createdAgreementIds: string[] = [];
      const agreementsForTending: Array<{
        id: string;
        description: string;
        followUpDate: Date | null;
      }> = [];

      const checkInAt = parseResult.data.checkInDate
        ? new Date(parseResult.data.checkInDate)
        : new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

      if (closureKind === Stage4ClosureKind.SHARED_AGREEMENT) {
        for (const proposal of mutuallyWillingSharedProposals) {
          const legacyFollowUp = parseResult.data.followUpDatesByProposalId?.[proposal.id];
          const parsedFollowUpDate = legacyFollowUp ? new Date(legacyFollowUp) : checkInAt;
          const agreement = await tx.agreement.create({
            data: {
              sharedVesselId: sharedVessel.id,
              proposalId: proposal.id,
              description: proposal.description,
              type: AgreementType.MICRO_EXPERIMENT,
              duration: proposal.duration,
              measureOfSuccess: proposal.measureOfSuccess,
              followUpDate: parsedFollowUpDate,
              status: 'AGREED',
              agreedByA: true,
              agreedByB: true,
              agreedAt: now,
            },
          });
          createdAgreementIds.push(agreement.id);
          agreementsForTending.push({
            id: agreement.id,
            description: proposal.description,
            followUpDate: parsedFollowUpDate,
          });

          await tx.strategyProposal.update({
            where: { id: proposal.id },
            data: { status: Stage4ProposalStatus.CONVERTED_TO_AGREEMENT },
          });

          await tx.stage4ProposalRevision.create({
            data: {
              proposalId: proposal.id,
              sessionId,
              actorUserId: user.id,
              action: 'CONVERTED',
              before: { status: proposal.status },
              after: { agreementId: agreement.id, status: Stage4ProposalStatus.CONVERTED_TO_AGREEMENT },
              reason: 'Mutual Stage 4 willingness closure',
            },
          });
        }

        await scheduleSharedAgreementTendingEntries(tx, sessionId, agreementsForTending, now);
      }

      const individualCommitmentsForTending = willingIndividualCommitments
        .filter((p) => !!p.createdByUserId)
        .map((p) => ({
          proposalId: p.id,
          ownerUserId: p.createdByUserId as string,
          description: p.description,
        }));
      if (individualCommitmentsForTending.length > 0) {
        await scheduleIndividualCommitmentTendingEntries(
          tx,
          sessionId,
          individualCommitmentsForTending,
          checkInAt,
          now
        );
      }

      await tx.stage4Closure.create({
        data: {
          sessionId,
          kind: closureKind,
          reason: closureReason,
          summary,
          sharedAgreementIds: createdAgreementIds,
          individualProposalIds,
          openNeedIds,
          checkInAt,
          closedByUserId: user.id,
          closedAt: now,
        },
      });

      await tx.session.update({
        where: { id: sessionId },
        data: { status: 'RESOLVED', resolvedAt: now },
      });

      await tx.stageProgress.updateMany({
        where: { sessionId, completedAt: null },
        data: { status: 'COMPLETED', completedAt: now },
      });

      return createdAgreementIds;
    });

    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId && userIsSessionMember(mutable.session, partnerId)) {
      await notifyPartner(sessionId, partnerId, 'session.resolved', {
        closedBy: user.id,
        kind: closureKind,
        agreementIds,
      });
    }

    await publishSessionEvent(sessionId, 'session.resolved', {
      closureKind,
      agreementIds,
    });

    const state = await buildStage4State(sessionId, user.id);
    if (!state.outcome) {
      errorResponse(res, 'INTERNAL_ERROR', 'Stage 4 closed but outcome was not available', 500);
      return;
    }

    successResponse(res, {
      closed: true,
      closedAt: now.toISOString(),
      outcome: state.outcome,
      state,
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
      return;
    }
    logger.error('[closeStage4] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to close Stage 4', 500);
  }
}

/**
 * Get anonymous strategy pool for the session
 * GET /sessions/:id/strategies
 */
export async function getStrategies(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Check session exists and user has access
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Return empty data for non-active sessions (allows parallel fetching)
    if (session.status !== 'ACTIVE') {
      successResponse(res, {
        strategies: [],
        phase: StrategyPhase.COLLECTING,
        aiSuggestionsAvailable: false,
      });
      return;
    }

    // Get creator attribution for server-side visibility checks, but strip it
    // before returning the anonymous pool to clients.
    const strategies = await prisma.strategyProposal.findMany({
      where: { sessionId },
      select: {
        id: true,
        description: true,
        needsAddressed: true,
        duration: true,
        measureOfSuccess: true,
        createdByUserId: true,
      },
    }) as StrategyProposalForVisibility[];

    // Compute actual phase from DB state
    const allProgress = await prisma.stageProgress.findMany({
      where: { sessionId, stage: 4 },
    });

    const rankings = await prisma.strategyRanking.findMany({
      where: { sessionId },
    });

    // Check gates for both users
    const allReadyToRank = allProgress.length >= 2 &&
      allProgress.every((p) => {
        const gates = p.gatesSatisfied as Record<string, unknown> | null;
        return gates?.readyToRank === true;
      });
    const myProgress = allProgress.find((p) => p.userId === user.id);
    const partnerProgress = allProgress.find((p) => p.userId !== user.id);
    const myGates = myProgress?.gatesSatisfied as Record<string, unknown> | null;
    const partnerGates = partnerProgress?.gatesSatisfied as Record<string, unknown> | null;

    const bothRanked = rankings.length >= 2;
    const myRanked = rankings.some((r) => r.userId === user.id);
    const myProposalCount = strategies.filter((s) => s.createdByUserId === user.id).length;
    const rankingOpenForUser = allReadyToRank && myProposalCount > 0;

    let phase: StrategyPhase;
    if (bothRanked) {
      phase = StrategyPhase.REVEALING;
    } else if (myRanked) {
      phase = StrategyPhase.REVEALING;
    } else if (rankingOpenForUser) {
      phase = StrategyPhase.RANKING;
    } else {
      phase = StrategyPhase.COLLECTING;
    }

    const fullPoolVisible = rankingOpenForUser || myRanked || bothRanked;
    const visibleStrategies = fullPoolVisible
      ? strategies
      : strategies.filter((s) => s.createdByUserId === user.id);
    const canRank = phase === StrategyPhase.RANKING && !myRanked && strategies.length > 0;
    const canMarkReadyToRank = phase === StrategyPhase.COLLECTING &&
      myGates?.readyToRank !== true &&
      myProposalCount > 0;

    // Shuffle to avoid order bias
    const shuffled = shuffleArray(visibleStrategies.map(toStrategyDTO));

    successResponse(res, {
      strategies: shuffled,
      phase,
      aiSuggestionsAvailable: false,
      myReadyToRank: myGates?.readyToRank === true,
      partnerReadyToRank: partnerGates?.readyToRank === true,
      canMarkReadyToRank,
      canRank,
      rankableStrategyCount: fullPoolVisible ? strategies.length : visibleStrategies.length,
    });
  } catch (error) {
    logger.error('[getStrategies] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get strategies', 500);
  }
}

/**
 * Propose a new strategy
 * POST /sessions/:id/strategies
 */
export async function proposeStrategy(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Validate request body
    const parseResult = proposeStrategyRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Invalid request body',
        400,
        parseResult.error.issues
      );
      return;
    }

    const { description, needsAddressed, duration, measureOfSuccess } = parseResult.data;

    // Check session exists and user has access
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { stage: 'desc' },
    });

    // Check user is in stage 4
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 4) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot propose strategy: you are in stage ${currentStage}, but stage 4 is required`,
        400
      );
      return;
    }

    // Create strategy proposal
    const strategy = await prisma.strategyProposal.create({
      data: {
        sessionId,
        createdByUserId: user.id,
        description,
        needsAddressed,
        duration,
        measureOfSuccess,
        source: 'USER_SUBMITTED',
      },
    });

    successResponse(
      res,
      {
        strategy: {
          id: strategy.id,
          description: strategy.description,
          duration: strategy.duration,
          measureOfSuccess: strategy.measureOfSuccess,
        },
        createdAt: strategy.createdAt.toISOString(),
      },
      201
    );
  } catch (error) {
    logger.error('[proposeStrategy] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to propose strategy', 500);
  }
}

/**
 * Submit strategy ranking
 * POST /sessions/:id/strategies/rank
 */
export async function submitRanking(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Validate request body
    const parseResult = rankStrategiesRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Invalid request body',
        400,
        parseResult.error.issues
      );
      return;
    }

    const { rankedIds } = parseResult.data;
    if (new Set(rankedIds).size !== rankedIds.length) {
      errorResponse(res, 'VALIDATION_ERROR', 'Ranked strategy IDs must be unique', 400);
      return;
    }

    // Check session exists and user has access
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { stage: 'desc' },
    });

    // Check user is in stage 4
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 4) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot submit ranking: you are in stage ${currentStage}, but stage 4 is required`,
        400
      );
      return;
    }

    const allProgress = await prisma.stageProgress.findMany({
      where: { sessionId, stage: 4 },
    });
    const allReadyToRank = allProgress.length >= 2 &&
      allProgress.every((p) => {
        const gates = p.gatesSatisfied as Record<string, unknown> | null;
        return gates?.readyToRank === true;
      });
    if (!allReadyToRank) {
      errorResponse(res, 'VALIDATION_ERROR', 'Strategies are not ready to rank yet', 400);
      return;
    }

    const myProposalCount = await prisma.strategyProposal.count({
      where: { sessionId, createdByUserId: user.id },
    });
    if (myProposalCount === 0) {
      errorResponse(res, 'VALIDATION_ERROR', 'Add at least one strategy before ranking', 400);
      return;
    }

    const rankableStrategies = await prisma.strategyProposal.findMany({
      where: { sessionId },
      select: { id: true },
    });
    const rankableIds = new Set(rankableStrategies.map((strategy) => strategy.id));
    if (rankedIds.some((id) => !rankableIds.has(id))) {
      errorResponse(res, 'VALIDATION_ERROR', 'Ranked strategy IDs must belong to this session', 400);
      return;
    }

    // Upsert ranking
    await prisma.strategyRanking.upsert({
      where: { sessionId_userId: { sessionId, userId: user.id } },
      create: { sessionId, userId: user.id, rankedIds },
      update: { rankedIds, submittedAt: new Date() },
    });

    // Update gate
    const gatesSatisfied = {
      ...(progress?.gatesSatisfied as Record<string, unknown> | null || {}),
      rankingSubmitted: true,
      rankingSubmittedAt: new Date().toISOString(),
    } satisfies Prisma.InputJsonValue;

    await prisma.stageProgress.update({
      where: {
        sessionId_userId_stage: { sessionId, userId: user.id, stage: 4 },
      },
      data: { gatesSatisfied },
    });

    // Check if partner has also ranked
    const partnerId = await getPartnerUserId(sessionId, user.id);
    const rankings = await prisma.strategyRanking.findMany({
      where: { sessionId },
    });

    const partnerRanked = rankings.some((r) => r.userId === partnerId);
    const canReveal = rankings.length >= 2;

    // Notify partner
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'partner.ranking_submitted', {
        stage: 4,
        submittedBy: user.id,
      });
    }

    successResponse(res, {
      submitted: true,
      submittedAt: new Date().toISOString(),
      partnerSubmitted: partnerRanked,
      awaitingReveal: canReveal,
      // Legacy aliases kept for older clients.
      ranked: true,
      rankedAt: new Date().toISOString(),
      partnerRanked,
      canReveal,
    });
  } catch (error) {
    logger.error('[submitRanking] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to submit ranking', 500);
  }
}

/**
 * Get ranking overlap between partners
 * GET /sessions/:id/strategies/overlap
 */
export async function getOverlap(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Check session exists and user has access
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Return empty data for non-active sessions (allows parallel fetching)
    if (session.status !== 'ACTIVE') {
      successResponse(res, {
        overlap: null,
        waitingForPartner: false,
        agreementCandidates: null,
      });
      return;
    }

    const partnerId = await getPartnerUserId(sessionId, user.id);

    // Get all rankings for this session
    const rankings = await prisma.strategyRanking.findMany({
      where: { sessionId },
    });

    // Check if both have ranked
    if (rankings.length < 2) {
      successResponse(res, {
        overlap: null,
        waitingForPartner: true,
        agreementCandidates: null,
      });
      return;
    }

    // Calculate overlap
    const myRanking = rankings.find((r) => r.userId === user.id);
    const partnerRanking = rankings.find((r) => r.userId === partnerId);

    if (!myRanking || !partnerRanking) {
      successResponse(res, {
        overlap: null,
        waitingForPartner: true,
        agreementCandidates: null,
      });
      return;
    }

    // Simple overlap: strategies in both top 3
    const myTop3 = new Set(myRanking.rankedIds.slice(0, 3));
    const partnerTop3 = new Set(partnerRanking.rankedIds.slice(0, 3));
    const topOverlapIds = [...myTop3].filter((id) => partnerTop3.has(id));

    // Get strategy details for overlapping strategies
    const overlapStrategies = topOverlapIds.length > 0
      ? await prisma.strategyProposal.findMany({
          where: { id: { in: topOverlapIds } },
          select: {
            id: true,
            description: true,
            needsAddressed: true,
            duration: true,
          },
        })
      : [];

    // Agreement candidates: overlapping or top choices from each
    const agreementCandidateIds = topOverlapIds.length > 0
      ? topOverlapIds
      : [myRanking.rankedIds[0], partnerRanking.rankedIds[0]].filter(Boolean);

    const agreementCandidates = await prisma.strategyProposal.findMany({
      where: { id: { in: agreementCandidateIds } },
      select: {
        id: true,
        description: true,
        duration: true,
      },
    });

    successResponse(res, {
      overlap: overlapStrategies,
      waitingForPartner: false,
      agreementCandidates,
    });
  } catch (error) {
    logger.error('[getOverlap] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get overlap', 500);
  }
}

/**
 * Create agreement from a strategy
 * POST /sessions/:id/agreements
 */
export async function createAgreement(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Validate request body
    const parseResult = createAgreementRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Invalid request body',
        400,
        parseResult.error.issues
      );
      return;
    }

    const { strategyId, description, type, followUpDate } = parseResult.data;

    // Check session exists and user has access
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { stage: 'desc' },
    });

    // Check user is in stage 4
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 4) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot create agreement: you are in stage ${currentStage}, but stage 4 is required`,
        400
      );
      return;
    }

    // Enforce maximum agreements per session
    const agreementCount = await prisma.agreement.count({
      where: { sharedVessel: { sessionId } },
    });
    if (agreementCount >= MAX_AGREEMENTS) {
      errorResponse(res, 'VALIDATION_ERROR', 'Maximum of 2 agreements per session', 400);
      return;
    }

    // Enforce uniqueness: one agreement per strategy
    if (strategyId) {
      const existingAgreement = await prisma.agreement.findFirst({
        where: { sharedVessel: { sessionId }, proposalId: strategyId },
      });
      if (existingAgreement) {
        errorResponse(res, 'CONFLICT', 'An agreement already exists for this strategy', 409);
        return;
      }
    }

    // Get or verify the strategy if provided
    if (strategyId) {
      const strategy = await prisma.strategyProposal.findUnique({
        where: { id: strategyId },
      });
      if (!strategy || strategy.sessionId !== sessionId) {
        errorResponse(res, 'NOT_FOUND', 'Strategy not found', 404);
        return;
      }
    }

    // Get shared vessel
    const sharedVessel = await prisma.sharedVessel.findUnique({
      where: { sessionId },
    });

    if (!sharedVessel) {
      errorResponse(res, 'NOT_FOUND', 'Shared vessel not found', 404);
      return;
    }

    // Determine user slot
    const userSlot = await getUserSlot(sessionId, user.id);

    // Create agreement - proposer auto-agrees
    const agreement = await prisma.agreement.create({
      data: {
        sharedVesselId: sharedVessel.id,
        description,
        type,
        proposalId: strategyId || null,
        followUpDate: followUpDate ? new Date(followUpDate) : null,
        status: 'PROPOSED',
        agreedByA: userSlot === 'A',
        agreedByB: userSlot === 'B',
      },
    });

    // Notify partner via real-time and create in-app notification
    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'agreement.proposed', {
        agreementId: agreement.id,
        proposedBy: user.id,
      });
    }

    successResponse(
      res,
      {
        agreement: {
          id: agreement.id,
          strategyId: agreement.proposalId,
          description: agreement.description,
          type: agreement.type,
          duration: null,
          measureOfSuccess: null,
          status: agreement.status,
          agreedByMe: true,
          agreedByPartner: false,
          agreedAt: agreement.agreedAt?.toISOString() ?? null,
          followUpDate: agreement.followUpDate?.toISOString() ?? null,
        },
        awaitingPartnerConfirmation: true,
      },
      201
    );
  } catch (error) {
    logger.error('[createAgreement] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to create agreement', 500);
  }
}

/**
 * Confirm or decline an agreement
 * POST /sessions/:id/agreements/:agreementId/confirm
 */
export async function confirmAgreement(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId, agreementId } = req.params;

    // Validate request body
    const parseResult = confirmAgreementRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Invalid request body',
        400,
        parseResult.error.issues
      );
      return;
    }

    const { confirmed } = parseResult.data;

    // Check session exists and user has access
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { stage: 'desc' },
    });

    // Check user is in stage 4
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 4) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot confirm agreement: you are in stage ${currentStage}, but stage 4 is required`,
        400
      );
      return;
    }

    // Get the agreement
    const agreement = await prisma.agreement.findUnique({
      where: { id: agreementId },
      include: {
        sharedVessel: true,
      },
    });

    if (!agreement) {
      errorResponse(res, 'NOT_FOUND', 'Agreement not found', 404);
      return;
    }

    // Verify agreement belongs to this session
    if (agreement.sharedVessel.sessionId !== sessionId) {
      errorResponse(res, 'NOT_FOUND', 'Agreement not found', 404);
      return;
    }

    // Determine user slot
    const userSlot = await getUserSlot(sessionId, user.id);

    // Update agreement based on confirmation
    const updateData: Prisma.AgreementUpdateInput = {};

    if (confirmed) {
      if (userSlot === 'A') {
        updateData.agreedByA = true;
      } else if (userSlot === 'B') {
        updateData.agreedByB = true;
      }

      // Check if both have now agreed
      const willBothAgree =
        (userSlot === 'A' && agreement.agreedByB) ||
        (userSlot === 'B' && agreement.agreedByA);

      if (willBothAgree) {
        updateData.status = 'AGREED';
        updateData.agreedAt = new Date();
      }
    }
    // If not confirmed, we don't change agreement status - it stays PROPOSED for renegotiation

    const now = new Date();
    const { updatedAgreement, sessionCanResolve } = await prisma.$transaction(async (tx) => {
      const updatedAgreement = await tx.agreement.update({
        where: { id: agreementId },
        data: updateData,
      });

      const allAgreements = await tx.agreement.findMany({
        where: { sharedVessel: { sessionId } },
      });
      const sessionCanResolve = allAgreements.length > 0 &&
        allAgreements.every((a) => a.agreedByA && a.agreedByB);

      if (sessionCanResolve) {
        await tx.session.update({
          where: { id: sessionId },
          data: { status: 'RESOLVED', resolvedAt: now },
        });
        await tx.stageProgress.updateMany({
          where: { sessionId, completedAt: null },
          data: { status: 'COMPLETED', completedAt: now },
        });
      }

      return { updatedAgreement, sessionCanResolve };
    });

    const bothConfirmed = updatedAgreement.agreedByA && updatedAgreement.agreedByB;

    // Notify partner via real-time and create in-app notification
    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'agreement.confirmed', {
        agreementId: agreement.id,
        confirmedBy: user.id,
        confirmed,
        bothConfirmed,
      });
    }

    if (sessionCanResolve) {
      await publishSessionEvent(sessionId, 'session.resolved', {
        agreementId: updatedAgreement.id,
      });
    }

    successResponse(res, {
      agreement: {
        id: updatedAgreement.id,
        strategyId: updatedAgreement.proposalId,
        description: updatedAgreement.description,
        type: updatedAgreement.type,
        duration: null, // Field not in Prisma model
        measureOfSuccess: null, // Field not in Prisma model
        status: updatedAgreement.status,
        agreedByMe: userSlot === 'A' ? updatedAgreement.agreedByA : updatedAgreement.agreedByB,
        agreedByPartner: userSlot === 'A' ? updatedAgreement.agreedByB : updatedAgreement.agreedByA,
        agreedAt: updatedAgreement.agreedAt?.toISOString() ?? null,
        followUpDate: updatedAgreement.followUpDate?.toISOString() ?? null,
      },
      sessionCanResolve,
    });
  } catch (error) {
    logger.error('[confirmAgreement] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to confirm agreement', 500);
  }
}

/**
 * Request AI strategy suggestions
 * POST /sessions/:id/strategies/suggestions
 */
export async function requestSuggestions(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const parseResult = requestSuggestionsRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid suggestion request', 400, parseResult.error.issues);
      return;
    }
    const { count, focusNeeds, needId } = parseResult.data;

    // Check session exists and user has access
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { stage: 'desc' },
    });

    // Check user is in stage 4
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 4) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot request suggestions: you are in stage ${currentStage}, but stage 4 is required`,
        400
      );
      return;
    }

    const targetNeed = needId
      ? await prisma.identifiedNeed.findFirst({
          where: {
            id: needId,
            vessel: {
              sessionId,
              userId: user.id,
            },
          },
        })
      : null;

    if (needId && !targetNeed) {
      errorResponse(res, 'NOT_FOUND', 'Need not found', 404);
      return;
    }

    const fallbackNeedLabel = focusNeeds?.find((need) => need.trim().length > 0)?.trim();
    const needLabel = targetNeed?.need ?? fallbackNeedLabel;

    if (!needLabel) {
      errorResponse(res, 'VALIDATION_ERROR', 'A needId or focusNeeds value is required', 400);
      return;
    }

    const globalLibraryItems = await prisma.globalLibraryItem.findMany({
      where: {
        source: 'CURATED',
      },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: {
        title: true,
        description: true,
        category: true,
      },
    });

    const drafts = await generateStage4SuggestionDrafts({
      sessionId,
      needLabel,
      count,
      globalLibraryItems,
    });

    const created = await Promise.all(
      drafts.map((draft) =>
        prisma.strategyProposal.create({
          data: {
            sessionId,
            createdByUserId: null,
            description: draft.description,
            needsAddressed: [needLabel],
            duration: draft.duration,
            measureOfSuccess: draft.measureOfSuccess,
            source: 'AI_SUGGESTED',
            kind: 'SHARED_PROPOSAL',
            ...(targetNeed
              ? {
                  needLinks: {
                    create: {
                      needId: targetNeed.id,
                    },
                  },
                }
              : {}),
          },
        })
      )
    );

    successResponse(res, {
      suggestions: created.map(toStrategyDTO),
      source: 'AI_GENERATED',
      count: created.length,
    });
  } catch (error) {
    logger.error('[requestSuggestions] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to request suggestions', 500);
  }
}

/**
 * Mark ready to rank strategies
 * POST /sessions/:id/strategies/ready
 */
export async function markReady(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Check session exists and user has access
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { stage: 'desc' },
    });

    // Check user is in stage 4
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 4) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot mark ready: you are in stage ${currentStage}, but stage 4 is required`,
        400
      );
      return;
    }

    const myProposalCount = await prisma.strategyProposal.count({
      where: { sessionId, createdByUserId: user.id },
    });
    if (myProposalCount === 0) {
      errorResponse(res, 'VALIDATION_ERROR', 'Add at least one strategy before marking ready to rank', 400);
      return;
    }

    // Update gate
    const readyAt = new Date().toISOString();
    const gatesSatisfied = {
      ...(progress?.gatesSatisfied as Record<string, unknown> | null || {}),
      readyToRank: true,
      readyAt,
    } satisfies Prisma.InputJsonValue;

    await prisma.stageProgress.update({
      where: {
        sessionId_userId_stage: { sessionId, userId: user.id, stage: 4 },
      },
      data: { gatesSatisfied },
    });

    // Check if partner is also ready
    const partnerId = await getPartnerUserId(sessionId, user.id);
    const partnerProgress = partnerId ? await prisma.stageProgress.findUnique({
      where: {
        sessionId_userId_stage: { sessionId, userId: partnerId, stage: 4 },
      },
    }) : null;

    const partnerGates = partnerProgress?.gatesSatisfied as Record<string, unknown> | null;
    const partnerReady = partnerGates?.readyToRank === true;
    const canStartRanking = partnerReady;

    // Notify partner
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'partner.ready_to_rank', {
        stage: 4,
        readyBy: user.id,
      });
    }

    successResponse(res, {
      ready: true,
      readyAt,
      partnerReady,
      canStartRanking,
    });
  } catch (error) {
    logger.error('[markReady] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to mark ready', 500);
  }
}

/**
 * Get agreements list
 * GET /sessions/:id/agreements
 */
export async function getAgreements(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Check session exists and user has access
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
      include: {
        relationship: {
          include: {
            members: {
              orderBy: { joinedAt: 'asc' },
            },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Get shared vessel
    const sharedVessel = await prisma.sharedVessel.findUnique({
      where: { sessionId },
    });

    if (!sharedVessel) {
      successResponse(res, {
        agreements: [],
      });
      return;
    }

    // Get agreements for this shared vessel
    const agreements = await prisma.agreement.findMany({
      where: { sharedVesselId: sharedVessel.id },
    });

    // Determine if user is A or B
    const members = session.relationship.members;
    const userIsA = members[0]?.userId === user.id;

    successResponse(res, {
      agreements: agreements.map((a) => ({
        id: a.id,
        strategyId: a.proposalId,
        description: a.description,
        type: a.type,
        duration: null, // Field removed from schema
        measureOfSuccess: null, // Field removed from schema
        status: a.status,
        agreedByMe: userIsA ? a.agreedByA : a.agreedByB,
        agreedByPartner: userIsA ? a.agreedByB : a.agreedByA,
        agreedAt: a.agreedAt?.toISOString() ?? null,
        followUpDate: a.followUpDate?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    logger.error('[getAgreements] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get agreements', 500);
  }
}
