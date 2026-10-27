/**
 * Stage 4 Controller (TS-11: on the target tables — services/stage4-store.ts).
 *
 * Redesigned Stage 4:
 * - GET  /sessions/:id/stage4                                  - Stage 4 state
 * - POST /sessions/:id/stage4/proposals/:proposalId/selection  - one choice (proposal_choice)
 * - POST /sessions/:id/stage4/selections                       - several choices
 * - POST /sessions/:id/stage4/walkthrough/needs/:needId        - walkthrough (need_disposition)
 * - POST /sessions/:id/stage4/share-selections                 - choices_shared
 * - POST /sessions/:id/stage4/unshare-selections               - withdraw choices_shared
 * - POST|DELETE /sessions/:id/stage4/needs/:needId/decline     - need_disposition DECLINED
 * - POST /sessions/:id/stage4/close                            - closure (job path)
 * Legacy strategy pool / agreements:
 * - GET|POST /sessions/:id/strategies                          - proposals
 * - POST /sessions/:id/strategies/suggest, /stage4/proposals/suggest
 * - POST /sessions/:id/agreements                              - the proposer's WILLING choice
 * - POST /sessions/:id/agreements/:agreementId/confirm         - a partner's WILLING choice; the
 *                                                                job creates the agreement once
 *                                                                every present human is WILLING
 * - GET  /sessions/:id/agreements
 *
 * Ranking is not in the product (spec §1.4 proposal_choice: "StrategyRanking
 * is not absorbed"): /strategies/rank, /strategies/overlap and
 * /strategies/ready are removed.
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import {
  proposeStrategyRequestSchema,
  confirmAgreementRequestSchema,
  AgreementDTO,
  AgreementType,
  StrategyPhase,
  MAX_AGREEMENTS,
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4SelectionDecision,
} from '@meet-without-fear/shared';
import { notifyPartner, publishSessionEvent } from '../services/realtime';
import { successResponse, errorResponse } from '../utils/response';
import { getPartnerUserId } from '../utils/session';
import {
  getStage4State as buildStage4State,
  Stage4StateNotFoundError,
  toAgreementDTO,
} from '../services/stage4-state';
import { stage4HandoffBridgeMessage } from '../services/stage4-prompts';
import { getModelCompletion } from '../lib/bedrock';
import { extractJsonFromResponse } from '../utils/json-extractor';
import { contentHash } from '../utils/content-hash';
import { z } from 'zod';
import { getPartnerParticipant, resolveParticipant, type ResolvedParticipant } from '../services/participant-resolver';
import { loadStageStates } from '../services/stage-shim';
import { createFacilitatorMessage } from '../services/message-store';
import {
  closeSessionAsJob,
  createAgreementsAsJob,
  hasMilestone,
  loadAgreements,
  loadClosure,
  loadProposal,
  loadProposals,
  loadStage4Needs,
  presentHumans,
  resolveNeedLabels,
  setProposalNeeds,
  shareChoices,
  unshareChoices,
  upsertChoice,
} from '../services/stage4-store';
import { advanceWalkthrough, declineNeed, Stage4WalkthroughNeedNotFoundError, undeclineNeed } from '../services/stage4-walkthrough';
import { closeStage4 as closeStage4Service, Stage4CloseError } from '../services/stage4-closure';

// ============================================================================
// Helpers
// ============================================================================

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
          typeof draft.measureOfSuccess === 'string' && draft.measureOfSuccess.trim() ? draft.measureOfSuccess.trim() : null,
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
}): Promise<Stage4SuggestionDraft[]> {
  // The curated global micro-experiments library has no table on the target
  // (dropped with GlobalLibraryItem); the prompt runs without it.
  const response = await getModelCompletion('haiku', {
    systemPrompt: [
      'You generate Stage 4 micro-experiment suggestions for one confirmed need.',
      'Use only the need label. Do not use user memory or unrelated session history.',
      'Return JSON only: {"suggestions":[{"description":"...","duration":"...","measureOfSuccess":"..."}]}.',
      'Each suggestion must be concrete, small, reversible, observable, and phrased as something the partners could try.',
    ].join('\n'),
    messages: [{ role: 'user', content: [`Need: ${params.needLabel}`, `Count: ${params.count}`].join('\n') }],
    maxTokens: 900,
    operation: 'stage4-need-suggestions',
    sessionId: params.sessionId,
    turnId: `${params.sessionId}:stage4-suggest:${Date.now()}`,
  });

  if (!response) return fallbackSuggestionDrafts(params.needLabel, params.count);
  try {
    const drafts = normalizeSuggestionDrafts(extractJsonFromResponse(response), params.count);
    return drafts.length > 0 ? drafts : fallbackSuggestionDrafts(params.needLabel, params.count);
  } catch (error) {
    logger.warn('[requestSuggestions] Failed to parse AI suggestion response; using fallback', error);
    return fallbackSuggestionDrafts(params.needLabel, params.count);
  }
}

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
      }),
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
    .refine((value) => !Number.isNaN(new Date(value).getTime()), { message: 'checkInDate must be a valid ISO date string' })
    .optional(),
  // Optional, deprecated. Kept for backward compatibility — Phase 4 removes it.
  followUpDatesByProposalId: z.record(z.string()).optional(),
});

/** What every mutating Stage 4 endpoint checks first. */
interface Stage4Context {
  participant: ResolvedParticipant;
  sessionStatus: string;
  stage: number;
  closed: boolean;
}

async function stage4Context(req: Request, sessionId: string, userId: string): Promise<Stage4Context | null> {
  const participant = req.participant ?? (await resolveParticipant(sessionId, userId));
  if (!participant) return null;
  const [session, states, closure] = await Promise.all([
    prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } }),
    loadStageStates([{ id: participant.id, joinedAt: participant.joinedAt }]),
    loadClosure(sessionId),
  ]);
  if (!session) return null;
  return {
    participant,
    sessionStatus: session.status,
    stage: states.get(participant.id)?.current.stage ?? 0,
    closed: Boolean(closure),
  };
}

/** Common refusals: not found, not active, not in Stage 4, already closed. Returns true when one was sent. */
function refuse(
  res: Response,
  ctx: Stage4Context | null,
  what: string,
  opts: { stage?: boolean; open?: boolean } = { stage: true, open: true },
): ctx is null {
  if (!ctx) {
    errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
    return true;
  }
  if (ctx.sessionStatus !== 'ACTIVE') {
    errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
    return true;
  }
  if (opts.stage !== false && ctx.stage !== 4) {
    errorResponse(res, 'VALIDATION_ERROR', `Cannot ${what}: you are in stage ${ctx.stage}, but stage 4 is required`, 400);
    return true;
  }
  if (opts.open !== false && ctx.closed) {
    errorResponse(res, 'CONFLICT', 'Stage 4 is already closed', 409);
    return true;
  }
  return false;
}

async function notifyStrategiesUpdated(sessionId: string, userId: string, change: string): Promise<void> {
  const partnerId = await getPartnerUserId(sessionId, userId);
  if (partnerId) {
    await notifyPartner(sessionId, partnerId, 'session.strategies_updated', { stage: 4, submittedBy: userId, change });
  }
}

/** The legacy agreement handle: a proposal whose creator proposed it as an agreement (revision mark). */
const LEGACY_AGREEMENT_MARK = 'agreementProposed';

// ============================================================================
// Controllers
// ============================================================================

/**
 * GET /sessions/:id/stage4
 */
export async function getStage4State(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    successResponse(res, await buildStage4State(req.params.id, user.id));
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
 * POST /sessions/:id/stage4/proposals/:proposalId/selection
 */
export async function submitStage4ProposalSelection(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const parseResult = submitStage4SelectionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    await submitStage4SelectionsInternal(req, res, req.params.id, user.id, [{ proposalId: req.params.proposalId, ...parseResult.data }]);
  } catch (error) {
    logger.error('[submitStage4ProposalSelection] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to submit Stage 4 selection', 500);
  }
}

/**
 * POST /sessions/:id/stage4/selections
 */
export async function submitStage4Selections(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const parseResult = submitStage4SelectionsRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    await submitStage4SelectionsInternal(req, res, req.params.id, user.id, parseResult.data.selections);
  } catch (error) {
    logger.error('[submitStage4Selections] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to submit Stage 4 selections', 500);
  }
}

/**
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
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'update Stage 4 walkthrough')) return;
    const { state } = await advanceWalkthrough({ sessionId, userId: user.id, needId, action: parseResult.data.action });
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
  selections: Array<{ proposalId: string; decision: Stage4SelectionDecision; note?: string }>,
): Promise<void> {
  const ctx = await stage4Context(req, sessionId, userId);
  if (refuse(res, ctx, 'submit Stage 4 selections')) return;

  const ids = [...new Set(selections.map((s) => s.proposalId))];
  if (ids.length !== selections.length) {
    errorResponse(res, 'VALIDATION_ERROR', 'Proposal selections must be unique per request', 400);
    return;
  }
  const valid = new Set(
    (await prisma.proposal.findMany({ where: { sessionId, id: { in: ids }, status: 'ACTIVE' }, select: { id: true } })).map((p) => p.id),
  );
  if (ids.some((id) => !valid.has(id))) {
    errorResponse(res, 'VALIDATION_ERROR', 'Selections must reference active proposals in this session', 400);
    return;
  }

  const submittedAt = new Date();
  for (const s of selections) {
    await upsertChoice({ proposalId: s.proposalId, participantId: ctx.participant.id, decision: s.decision, note: s.note ?? null, at: submittedAt });
  }

  // Choices stay private until the participant explicitly shares; a revision
  // after sharing withdraws the share so the partner never sees a half-revised stance.
  if (await hasMilestone(ctx.participant.id, 'choices_shared')) {
    await unshareChoices(ctx.participant.id);
    await notifyStrategiesUpdated(sessionId, userId, 'stage4_selection_revised');
  }

  const state = await buildStage4State(sessionId, userId);
  successResponse(res, {
    submitted: state.mySelectionStatus === 'SUBMITTED',
    submittedAt: submittedAt.toISOString(),
    partnerSubmitted: state.partnerSelectionStatus === 'SUBMITTED',
    state,
  });
}

/**
 * Share the participant's choices (`choices_shared`). Requires a stance on
 * every active shared proposal, and every open shared need addressed by a
 * WILLING-covered active proposal or set aside ("leave for now").
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
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'share Stage 4 selections', { stage: false, open: true })) return;
    const me = ctx.participant.id;

    const [proposals, myChoices, needs, dispositions] = await Promise.all([
      loadProposals(sessionId, me),
      prisma.proposalChoice.findMany({ where: { participantId: me, proposal: { sessionId } }, select: { proposalId: true, decision: true } }),
      loadStage4Needs(sessionId, me),
      prisma.needDisposition.findMany({ where: { participantId: me, status: 'DECLINED' }, select: { needId: true } }),
    ]);
    const activeShared = proposals.filter((p) => p.status === 'ACTIVE' && p.kind === 'SHARED_PROPOSAL');
    if (activeShared.length === 0) {
      errorResponse(res, 'VALIDATION_ERROR', 'No shared proposals to share stances on yet', 400);
      return;
    }
    const chosen = new Set(myChoices.map((c) => c.proposalId));
    if (activeShared.some((p) => !chosen.has(p.id))) {
      errorResponse(res, 'VALIDATION_ERROR', 'Take a stance on every shared proposal before sharing', 400);
      return;
    }
    // Gate: every shared need with no live covering proposal (v_need_coverage OPEN)
    // must be covered by an active proposal this participant is WILLING on, or set aside.
    const willing = new Set(myChoices.filter((c) => c.decision === 'WILLING').map((c) => c.proposalId));
    const active = proposals.filter((p) => p.status === 'ACTIVE');
    const declined = new Set(dispositions.map((d) => d.needId));
    const { loadCoverage } = await import('../services/stage4-store');
    const coverage = new Map((await loadCoverage(sessionId)).map((c) => [c.needId, c]));
    const ungated = needs.filter((n) => {
      if ((coverage.get(n.id)?.status ?? 'OPEN') !== 'OPEN') return false;
      if (declined.has(n.id)) return false;
      return !active.some((p) => willing.has(p.id) && p.needIds.includes(n.id));
    });
    if (ungated.length > 0) {
      errorResponse(res, 'VALIDATION_ERROR', 'Address or set aside every open need before sharing', 400);
      return;
    }

    await shareChoices(me);
    await notifyStrategiesUpdated(sessionId, user.id, 'stage4_selection_submitted');

    // Quiet hand-off bridge: the first share while the partner has not shared.
    try {
      const partner = await getPartnerParticipant(me);
      const partnerHasShared = partner ? await hasMilestone(partner.participantId, 'choices_shared') : false;
      if (!partnerHasShared && ctx.participant.mainConversationId) {
        const member = await prisma.relationshipMember.findFirst({
          where: { userId: user.id, relationship: { sessions: { some: { id: sessionId } } } },
          select: { nickname: true },
        });
        const bridge = stage4HandoffBridgeMessage(member?.nickname || partner?.displayName || undefined);
        const already = await prisma.message.count({
          where: { conversationId: ctx.participant.mainConversationId, role: 'AI', contentHash: contentHash(bridge) },
        });
        if (already === 0) {
          await createFacilitatorMessage({ conversationId: ctx.participant.mainConversationId, content: bridge });
        }
      }
    } catch (bridgeError) {
      logger.warn('[shareStage4Selections] Failed to persist handoff bridge message', { bridgeError });
    }

    successResponse(res, { state: await buildStage4State(sessionId, user.id) });
  } catch (error) {
    logger.error('[shareStage4Selections] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to share Stage 4 selections', 500);
  }
}

/** The shared need exists in the session (a need_share id). */
async function sharedNeedExists(sessionId: string, needId: string): Promise<boolean> {
  return (await prisma.needShare.count({ where: { needId, sessionId, revokedAt: null } })) > 0;
}

/**
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
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'decline need')) return;
    if (!(await sharedNeedExists(sessionId, needId))) {
      errorResponse(res, 'NOT_FOUND', 'Need not found', 404);
      return;
    }
    await declineNeed(ctx.participant.id, needId);
    successResponse(res, { state: await buildStage4State(sessionId, user.id) });
  } catch (error) {
    logger.error('[declineStage4Need] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to decline need', 500);
  }
}

/**
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
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'undecline need')) return;
    if (!(await sharedNeedExists(sessionId, needId))) {
      errorResponse(res, 'NOT_FOUND', 'Need not found', 404);
      return;
    }
    await undeclineNeed(ctx.participant.id, needId);
    successResponse(res, { state: await buildStage4State(sessionId, user.id) });
  } catch (error) {
    logger.error('[undeclineStage4Need] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to undecline need', 500);
  }
}

/**
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
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'revise Stage 4 selections', { stage: false, open: true })) return;
    await unshareChoices(ctx.participant.id);
    await notifyStrategiesUpdated(sessionId, user.id, 'stage4_selection_revised');
    successResponse(res, { state: await buildStage4State(sessionId, user.id) });
  } catch (error) {
    logger.error('[unshareStage4Selections] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to revise Stage 4 selections', 500);
  }
}

/**
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
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'close Stage 4')) return;

    const result = await closeStage4Service({ sessionId, participantId: ctx.participant.id, ...parseResult.data });

    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'session.resolved', {
        closedBy: user.id,
        kind: result.kind,
        agreementIds: result.agreementIds,
      });
    }
    await publishSessionEvent(sessionId, 'session.resolved', { closureKind: result.kind, agreementIds: result.agreementIds });

    const state = await buildStage4State(sessionId, user.id);
    if (!state.outcome) {
      errorResponse(res, 'INTERNAL_ERROR', 'Stage 4 closed but outcome was not available', 500);
      return;
    }
    successResponse(res, { closed: true, closedAt: result.closedAt.toISOString(), outcome: state.outcome, state });
  } catch (error) {
    if (error instanceof Stage4CloseError) {
      errorResponse(res, error.code, error.message, error.status);
      return;
    }
    logger.error('[closeStage4] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to close Stage 4', 500);
  }
}

/**
 * The legacy strategy pool: the participant's own proposals (the full pool
 * opened only for ranking, which no longer exists).
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
    const participant = req.participant ?? (await resolveParticipant(sessionId, user.id));
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } });
    if (!participant || !session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (session.status !== 'ACTIVE') {
      successResponse(res, { strategies: [], phase: StrategyPhase.COLLECTING, aiSuggestionsAvailable: false });
      return;
    }
    const [own, needs] = await Promise.all([
      prisma.proposal.findMany({
        where: { sessionId, createdByParticipantId: participant.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, description: true, duration: true, measureOfSuccess: true, unresolvedNeedLabels: true, needs: { select: { needId: true } } },
      }),
      loadStage4Needs(sessionId, participant.id),
    ]);
    const labelOf = new Map(needs.map((n) => [n.id, n.label]));
    successResponse(res, {
      strategies: own.map((p) => ({
        id: p.id,
        description: p.description,
        needsAddressed: [...p.needs.map((n) => labelOf.get(n.needId)).filter((l): l is string => Boolean(l)), ...p.unresolvedNeedLabels],
        duration: p.duration,
        measureOfSuccess: p.measureOfSuccess,
      })),
      phase: StrategyPhase.COLLECTING,
      aiSuggestionsAvailable: false,
      // Ranking is gone (spec §1.4): these stay false for older clients.
      myReadyToRank: false,
      partnerReadyToRank: false,
      canMarkReadyToRank: false,
      canRank: false,
      rankableStrategyCount: own.length,
    });
  } catch (error) {
    logger.error('[getStrategies] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get strategies', 500);
  }
}

/**
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
    const parseResult = proposeStrategyRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'propose strategy', { stage: true, open: false })) return;
    const { description, needsAddressed, duration, measureOfSuccess } = parseResult.data;
    const strategy = await prisma.proposal.create({
      data: {
        sessionId,
        createdByParticipantId: ctx.participant.id,
        description,
        duration,
        measureOfSuccess,
        source: 'USER_SUBMITTED',
      },
      select: { id: true, description: true, duration: true, measureOfSuccess: true, createdAt: true },
    });
    const { needIds, unresolved } = await resolveNeedLabels(sessionId, ctx.participant.id, needsAddressed);
    await setProposalNeeds(prisma, strategy.id, needIds, unresolved);
    successResponse(
      res,
      {
        strategy: { id: strategy.id, description: strategy.description, duration: strategy.duration, measureOfSuccess: strategy.measureOfSuccess },
        createdAt: strategy.createdAt.toISOString(),
      },
      201,
    );
  } catch (error) {
    logger.error('[proposeStrategy] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to propose strategy', 500);
  }
}

/** A legacy agreement handle before the agreement exists: the proposal, with who is WILLING. */
async function pendingAgreementDTO(proposalId: string, me: string, partner: string | null, followUpDate: string | null): Promise<AgreementDTO | null> {
  const proposal = await loadProposal(proposalId);
  if (!proposal) return null;
  const choices = await prisma.proposalChoice.findMany({ where: { proposalId, decision: 'WILLING' }, select: { participantId: true, updatedAt: true } });
  return {
    id: proposal.id,
    strategyId: proposal.id,
    proposalId: proposal.id,
    description: proposal.description,
    type: AgreementType.MICRO_EXPERIMENT,
    duration: proposal.duration,
    measureOfSuccess: proposal.measureOfSuccess,
    status: 'PROPOSED' as AgreementDTO['status'],
    agreedByMe: choices.some((c) => c.participantId === me),
    agreedByPartner: partner ? choices.some((c) => c.participantId === partner) : false,
    agreedAt: null,
    followUpDate,
  };
}

/** When every present human is WILLING on the proposal, the job creates the agreement (+ parties). */
async function agreeIfEveryoneWilling(args: {
  sessionId: string;
  proposalId: string;
  actor: string;
  type: AgreementType;
  followUpAt: Date | null;
}): Promise<string | null> {
  const proposal = await loadProposal(args.proposalId);
  if (!proposal || proposal.status === 'CONVERTED_TO_AGREEMENT' || proposal.status === 'REMOVED') return null;
  const humans = (await presentHumans(args.sessionId)).map((h) => h.id);
  const willing = new Set(
    (await prisma.proposalChoice.findMany({ where: { proposalId: args.proposalId, decision: 'WILLING' }, select: { participantId: true } })).map(
      (c) => c.participantId,
    ),
  );
  if (humans.length === 0 || !humans.every((h) => willing.has(h))) return null;
  const [id] = await createAgreementsAsJob({
    sessionId: args.sessionId,
    actorParticipantId: args.actor,
    partyParticipantIds: humans,
    reason: 'Every party confirmed the agreement',
    agreements: [
      {
        proposalId: proposal.id,
        type: args.type,
        description: proposal.description,
        duration: proposal.duration,
        measureOfSuccess: proposal.measureOfSuccess,
        followUpAt: args.followUpAt,
        fromStatus: proposal.status,
      },
    ],
  });
  return id;
}

/**
 * Legacy "create agreement": the proposer's WILLING choice on the proposal
 * (a new one from the description when no strategyId is given). There is no
 * PROPOSED agreement on the target — an agreement exists only once every
 * present human is WILLING (spec §1.4 agreement, T-agreement-parties); until
 * then the handle is the proposal (`id` = `proposalId`).
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
    const parseResult = createAgreementRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    const { strategyId, description, type, duration, measureOfSuccess, followUpDate } = parseResult.data;
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'create agreement', { stage: true, open: false })) return;
    const me = ctx.participant.id;

    if ((await prisma.agreement.count({ where: { sessionId } })) >= MAX_AGREEMENTS) {
      errorResponse(res, 'VALIDATION_ERROR', 'Maximum of 2 agreements per session', 400);
      return;
    }
    let proposalId = strategyId;
    if (proposalId) {
      if (await prisma.agreement.findFirst({ where: { sessionId, proposalId } })) {
        errorResponse(res, 'CONFLICT', 'An agreement already exists for this strategy', 409);
        return;
      }
      const proposal = await prisma.proposal.findFirst({ where: { id: proposalId, sessionId }, select: { id: true } });
      if (!proposal) {
        errorResponse(res, 'NOT_FOUND', 'Strategy not found', 404);
        return;
      }
    } else {
      proposalId = (
        await prisma.proposal.create({
          data: { sessionId, createdByParticipantId: me, description, duration, measureOfSuccess, source: 'USER_SUBMITTED' },
          select: { id: true },
        })
      ).id;
    }
    await upsertChoice({ proposalId, participantId: me, decision: 'WILLING' });
    await prisma.proposalRevision.create({
      data: {
        proposalId,
        actorParticipantId: me,
        action: 'REVISED',
        after: { [LEGACY_AGREEMENT_MARK]: true, type, followUpDate: followUpDate ?? null },
        reason: 'Proposed as an agreement',
      },
    });

    const followUpAt = followUpDate ? new Date(followUpDate) : null;
    const agreementId = await agreeIfEveryoneWilling({ sessionId, proposalId, actor: me, type, followUpAt });
    const partner = (await getPartnerParticipant(me))?.participantId ?? null;
    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'agreement.proposed', { agreementId: agreementId ?? proposalId, proposedBy: user.id });
    }
    const agreement = agreementId
      ? (await loadAgreements(sessionId)).find((a) => a.id === agreementId)!
      : null;
    successResponse(
      res,
      {
        agreement: agreement
          ? { ...toAgreementDTO(agreement, me, partner), proposalId }
          : await pendingAgreementDTO(proposalId, me, partner, followUpAt?.toISOString() ?? null),
        awaitingPartnerConfirmation: !agreement,
      },
      201,
    );
  } catch (error) {
    logger.error('[createAgreement] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to create agreement', 500);
  }
}

/**
 * Confirm an agreement: the caller's WILLING choice on its proposal; when
 * every present human is WILLING the job creates the agreement, and when no
 * proposed agreement remains open the repair stage closes (job). Response
 * shape unchanged. `:agreementId` is an agreement id or, before it exists,
 * the proposal handle.
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
    const parseResult = confirmAgreementRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    const { confirmed } = parseResult.data;
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'confirm agreement', { stage: true, open: false })) return;
    const me = ctx.participant.id;
    const partner = (await getPartnerParticipant(me))?.participantId ?? null;

    const existing = await prisma.agreement.findFirst({ where: { id: agreementId, sessionId }, select: { id: true, proposalId: true } });
    const proposalId = existing?.proposalId ?? (await prisma.proposal.findFirst({ where: { id: agreementId, sessionId }, select: { id: true } }))?.id;
    if (!proposalId) {
      errorResponse(res, 'NOT_FOUND', 'Agreement not found', 404);
      return;
    }
    const mark = await prisma.proposalRevision.findFirst({
      where: { proposalId, reason: 'Proposed as an agreement' },
      orderBy: { createdAt: 'desc' },
      select: { after: true },
    });
    const markAfter = (mark?.after ?? {}) as { type?: AgreementType; followUpDate?: string | null };

    let createdId: string | null = existing?.id ?? null;
    if (confirmed && !existing) {
      await upsertChoice({ proposalId, participantId: me, decision: 'WILLING' });
      createdId = await agreeIfEveryoneWilling({
        sessionId,
        proposalId,
        actor: me,
        type: markAfter.type ?? AgreementType.MICRO_EXPERIMENT,
        followUpAt: markAfter.followUpDate ? new Date(markAfter.followUpDate) : null,
      });
    }

    // The session resolves once every agreement proposed this way exists.
    const pending = await prisma.proposal.count({
      where: { sessionId, status: { in: ['ACTIVE', 'REVISED'] }, revisions: { some: { reason: 'Proposed as an agreement' } } },
    });
    const agreements = await loadAgreements(sessionId);
    const sessionCanResolve = agreements.length > 0 && pending === 0;
    if (sessionCanResolve && !(await loadClosure(sessionId))) {
      await closeSessionAsJob({
        sessionId,
        kind: Stage4ClosureKind.SHARED_AGREEMENT,
        reason: Stage4ClosureReason.MUTUAL_SELECTION,
        summary: `Closed with ${agreements.length} shared agreement${agreements.length === 1 ? '' : 's'}.`,
        closedByParticipantId: me,
        checkInAt: null,
      });
    }

    const agreement = createdId ? agreements.find((a) => a.id === createdId) : undefined;
    const dto = agreement
      ? { ...toAgreementDTO(agreement, me, partner), proposalId }
      : await pendingAgreementDTO(proposalId, me, partner, markAfter.followUpDate ?? null);

    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'agreement.confirmed', {
        agreementId: dto?.id ?? agreementId,
        confirmedBy: user.id,
        confirmed,
        bothConfirmed: Boolean(agreement),
      });
    }
    if (sessionCanResolve) {
      await publishSessionEvent(sessionId, 'session.resolved', { agreementId: dto?.id ?? agreementId });
    }
    successResponse(res, { agreement: dto, sessionCanResolve });
  } catch (error) {
    logger.error('[confirmAgreement] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to confirm agreement', 500);
  }
}

/**
 * POST /sessions/:id/strategies/suggest (and /stage4/proposals/suggest)
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
    const ctx = await stage4Context(req, sessionId, user.id);
    if (refuse(res, ctx, 'request suggestions', { stage: true, open: false })) return;

    // A shared need, named as this participant names it (own label / the partner's shared text).
    const needs = await loadStage4Needs(sessionId, ctx.participant.id);
    const target = needId ? needs.find((n) => n.id === needId) : undefined;
    if (needId && !target) {
      errorResponse(res, 'NOT_FOUND', 'Need not found', 404);
      return;
    }
    const needLabel = target?.label ?? focusNeeds?.find((n) => n.trim().length > 0)?.trim();
    if (!needLabel) {
      errorResponse(res, 'VALIDATION_ERROR', 'A needId or focusNeeds value is required', 400);
      return;
    }

    const drafts = await generateStage4SuggestionDrafts({ sessionId, needLabel, count });
    const created = [];
    for (const draft of drafts) {
      const p = await prisma.proposal.create({
        data: {
          sessionId,
          createdByParticipantId: null,
          description: draft.description,
          duration: draft.duration,
          measureOfSuccess: draft.measureOfSuccess,
          source: 'AI_SUGGESTED',
          kind: 'SHARED_PROPOSAL',
        },
        select: { id: true, description: true, duration: true, measureOfSuccess: true },
      });
      if (target) await setProposalNeeds(prisma, p.id, [target.id]);
      else await setProposalNeeds(prisma, p.id, [], [needLabel]);
      created.push({ ...p, needsAddressed: [needLabel] });
    }
    successResponse(res, { suggestions: created, source: 'AI_GENERATED', count: created.length });
  } catch (error) {
    logger.error('[requestSuggestions] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to request suggestions', 500);
  }
}

/**
 * Agreements, plus (legacy flow) the proposals proposed as agreements that
 * not every party has confirmed yet — their handle is the proposal id.
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
    const participant = req.participant ?? (await resolveParticipant(sessionId, user.id));
    if (!participant) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    const partner = (await getPartnerParticipant(participant.id))?.participantId ?? null;
    const [agreements, pendingProposals] = await Promise.all([
      loadAgreements(sessionId),
      prisma.proposal.findMany({
        where: { sessionId, status: { in: ['ACTIVE', 'REVISED'] }, revisions: { some: { reason: 'Proposed as an agreement' } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      }),
    ]);
    const pending = [];
    for (const p of pendingProposals) {
      const dto = await pendingAgreementDTO(p.id, participant.id, partner, null);
      if (dto) pending.push(dto);
    }
    successResponse(res, {
      agreements: [...agreements.map((a) => ({ ...toAgreementDTO(a, participant.id, partner), proposalId: a.proposalId })), ...pending],
    });
  } catch (error) {
    logger.error('[getAgreements] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get agreements', 500);
  }
}
