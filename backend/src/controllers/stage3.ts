/**
 * Stage 3 Controller (TS-11: needs on the target — `need`, `need_share`,
 * `consent`, milestones).
 *
 * - GET    /sessions/:id/needs                  - the caller's own needs
 * - POST   /sessions/:id/needs/capture          - capture needs from an AI summary card
 * - POST   /sessions/:id/needs/confirm          - confirm needs (needs_confirmed)
 * - POST   /sessions/:id/needs/consent          - share needs (consent GRANTED, then the job's
 *                                                 app.need_share with transformed text)
 * - POST   /sessions/:id/needs/validate         - validate the revealed lists (needs_validated)
 * - POST   /sessions/:id/needs                  - add a custom need
 * - POST   /sessions/:id/needs/interpret-edit-request, /apply-edits, DELETE /needs/:needId
 * - GET    /sessions/:id/needs/comparison       - side by side: the caller's own needs and the
 *                                                 partner's SHARED needs (v_need_shared: shared
 *                                                 text and category, never the label)
 *
 * "Shared" is a fact of `need_share`: a participant has shared once a live
 * share of theirs exists. The session-scoped `needs_shared` milestone (stage
 * 3's terminal) is written by the job for everyone once all present humans
 * have shared (services/needs-share.ts).
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { confirmNeedsRequestSchema, MessageRole, NeedCategory } from '@meet-without-fear/shared';
import { notifyPartner, publishMessageAIResponse, publishSessionEvent, publishUserEvent } from '../services/realtime';
import { successResponse, errorResponse } from '../utils/response';
import { getPartnerUserId } from '../utils/session';
import {
  captureProposedNeedsForUser,
  listOwnNeeds,
  NEED_SELECT,
  toIdentifiedNeedDTO,
  withNeedReframingWarning,
  type NeedRecord,
} from '../services/needs';
import { interpretNeedEditRequest } from '../services/needs-edit-interpreter.service';
import {
  applyNeedEdits,
  deleteNeed,
  NeedEditForbiddenError,
  NeedEditValidationError,
} from '../services/needs-edit-applier.service';
import {
  completeNeedsSharingIfReady,
  listSharedNeeds,
  participantsWhoShared,
  shareNeeds,
} from '../services/needs-share';
import { getPartnerParticipant, resolveParticipant, type ResolvedParticipant } from '../services/participant-resolver';
import { loadStageStates } from '../services/stage-shim';
import { reachMilestone } from '../services/milestone-writer';
import { createFacilitatorMessage } from '../services/message-store';

// ============================================================================
// Helpers
// ============================================================================

function buildStage4TransitionContent(firstNeed?: string | null): string {
  const needText = firstNeed?.trim();
  const needLine = needText ? `Let's start with one of yours: ${needText}.` : "Let's start with one of yours.";
  return [
    'You have both sent your needs and can now see what each of you named.',
    `${needLine} The work now is not to decide everything, just to put ideas on the table. What might help honor that need?`,
  ].join('\n\n');
}

/** The participant's first live confirmed need (their own label, in their own conversation). */
async function firstNeedText(participantId: string): Promise<string | null> {
  const [first] = await listOwnNeeds(participantId, { live: true, confirmed: true });
  return first?.label ?? null;
}

interface NeedsContext {
  participant: ResolvedParticipant;
  sessionStatus: string;
  stage: number;
}

async function needsContext(req: Request, sessionId: string, userId: string): Promise<NeedsContext | null> {
  const participant = req.participant ?? (await resolveParticipant(sessionId, userId));
  if (!participant) return null;
  const [session, states] = await Promise.all([
    prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } }),
    loadStageStates([{ id: participant.id, joinedAt: participant.joinedAt }]),
  ]);
  if (!session) return null;
  return { participant, sessionStatus: session.status, stage: states.get(participant.id)?.current.stage ?? 0 };
}

async function hasMilestone(participantId: string, key: string): Promise<boolean> {
  return (await prisma.participantMilestone.count({ where: { participantId, milestoneKey: key } })) > 0;
}

/** A participant has shared once a live `need_share` of theirs exists. */
async function hasShared(sessionId: string, participantId: string): Promise<boolean> {
  return (await participantsWhoShared(sessionId)).has(participantId);
}

function isNeedCategory(value: unknown): value is NeedCategory {
  return typeof value === 'string' && Object.values(NeedCategory).includes(value as NeedCategory);
}

function needEditErrorResponse(res: Response, error: unknown): boolean {
  if (error instanceof NeedEditValidationError) {
    errorResponse(res, 'VALIDATION_ERROR', error.message, error.statusCode);
    return true;
  }
  if (error instanceof NeedEditForbiddenError) {
    errorResponse(res, 'FORBIDDEN', error.message, error.statusCode);
    return true;
  }
  return false;
}

/**
 * The mutual share completed: one Stage 4 transition message into each
 * present human's MAIN conversation (job), and the stage-completed events.
 */
async function announceStage4(sessionId: string, triggeredBy: { userId: string }): Promise<void> {
  const humans = await prisma.participant.findMany({
    where: { sessionId, kind: 'human', leftAt: null },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, userId: true, conversations: { where: { kind: 'MAIN' }, select: { id: true } } },
  });
  for (const h of humans) {
    const conversationId = h.conversations[0]?.id;
    if (!conversationId || !h.userId) continue;
    const message = await createFacilitatorMessage({
      conversationId,
      content: buildStage4TransitionContent(await firstNeedText(h.id)),
    });
    const eventData = {
      forUserId: h.userId,
      previousStage: 3,
      currentStage: 4,
      userId: triggeredBy.userId,
      triggeredByUserId: triggeredBy.userId,
      message: { id: message.id, content: message.content, timestamp: message.createdAt, forUserId: h.userId },
    };
    if (h.userId === triggeredBy.userId) {
      await publishSessionEvent(sessionId, 'partner.stage_completed', eventData);
    } else {
      await notifyPartner(sessionId, h.userId, 'partner.stage_completed', eventData);
    }
  }
}

/** An AI line in the caller's own conversation (job), published to them. */
async function guidance(
  sessionId: string,
  participant: ResolvedParticipant,
  userId: string,
  content: string,
): Promise<void> {
  if (!participant.mainConversationId) return;
  const message = await createFacilitatorMessage({ conversationId: participant.mainConversationId, content });
  await publishMessageAIResponse(sessionId, userId, {
    id: message.id,
    sessionId,
    senderId: null,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    role: MessageRole.AI,
    stage: 3,
  });
}

const EMPTY_COMPARISON = { myNeeds: [], partnerNeeds: [], commonGround: [], analysisComplete: false, noOverlap: false };

// ============================================================================
// Controllers
// ============================================================================

/**
 * GET /sessions/:id/needs — the caller's own needs (no auto-extraction).
 */
export async function getNeeds(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const ctx = await needsContext(req, req.params.id, user.id);
    if (!ctx) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (ctx.sessionStatus !== 'ACTIVE' || ctx.stage < 3) {
      successResponse(res, { needs: [], synthesizedAt: null, isDirty: false });
      return;
    }
    const needs = await listOwnNeeds(ctx.participant.id);
    successResponse(res, {
      needs: needs.map(need => toIdentifiedNeedDTO(need)),
      extracting: false,
      synthesizedAt: needs[0]?.createdAt.toISOString() ?? null,
    });
  } catch (error) {
    logger.error('[getNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get needs', 500);
  }
}

/**
 * POST /sessions/:id/needs/capture
 */
export async function captureNeeds(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { id: sessionId } = req.params;
    const { needs } = req.body as {
      needs?: Array<{ need?: string; category?: unknown; description?: string; evidence?: unknown }>;
    };
    if (!Array.isArray(needs) || needs.length === 0) {
      errorResponse(res, 'VALIDATION_ERROR', 'needs array is required', 400);
      return;
    }
    if (needs.length > 50) {
      errorResponse(res, 'VALIDATION_ERROR', 'A maximum of 50 needs can be captured at once', 400);
      return;
    }
    for (const need of needs) {
      if (!need.need || !need.description || !isNeedCategory(need.category)) {
        errorResponse(res, 'VALIDATION_ERROR', 'Each need requires need, description, and a valid category', 400);
        return;
      }
    }
    const ctx = await needsContext(req, sessionId, user.id);
    if (!ctx) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (ctx.sessionStatus !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (ctx.stage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot capture needs: you are in stage ${ctx.stage}, but stage 3 is required`,
        400,
      );
      return;
    }
    const { needs: captured, capturedAt } = await captureProposedNeedsForUser(
      sessionId,
      user.id,
      needs.map(item => ({
        need: item.need!,
        category: item.category as NeedCategory,
        description: item.description!,
        evidence: Array.isArray(item.evidence) ? item.evidence.filter((e): e is string => typeof e === 'string') : [],
      })),
    );
    successResponse(
      res,
      {
        needs: captured.map(n => ({
          id: n.id,
          need: n.need,
          category: n.category,
          description: n.need,
          evidence: n.evidence,
          confirmed: n.confirmed,
          aiConfidence: n.aiConfidence,
          needsReframing: n.needsReframing,
          reframingWarning: n.reframingWarning,
        })),
        capturedAt: capturedAt.toISOString(),
      },
      201,
    );
  } catch (error) {
    logger.error('[captureNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to capture needs', 500);
  }
}

/**
 * POST /sessions/:id/needs/confirm
 */
export async function confirmNeeds(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { id: sessionId } = req.params;
    const parseResult = confirmNeedsRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    const { needIds, adjustments } = parseResult.data;
    const ctx = await needsContext(req, sessionId, user.id);
    if (!ctx) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (ctx.sessionStatus !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (ctx.stage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot confirm needs: you are in stage ${ctx.stage}, but stage 3 is required`,
        400,
      );
      return;
    }
    const me = ctx.participant.id;
    if (await hasShared(sessionId, me)) {
      errorResponse(res, 'FORBIDDEN', 'Needs have already been shared and can no longer be edited', 403);
      return;
    }
    const own = await prisma.need.findMany({ where: { id: { in: needIds }, participantId: me }, select: { id: true } });
    if (own.length !== needIds.length) {
      errorResponse(res, 'VALIDATION_ERROR', 'Some need IDs are invalid or do not belong to you', 400);
      return;
    }
    const now = new Date();
    if (adjustments && adjustments.length > 0) {
      const ownIds = new Set(own.map(n => n.id));
      if (adjustments.some(adj => !ownIds.has(adj.needId))) {
        errorResponse(res, 'VALIDATION_ERROR', 'Some adjustment need IDs are invalid or do not belong to you', 400);
        return;
      }
      for (const adj of adjustments) {
        if (adj.correction) {
          await prisma.need.updateMany({
            where: { id: adj.needId, participantId: me },
            data: { label: adj.correction, confirmedAt: adj.confirmed ? now : null },
          });
        }
      }
    }
    // Confirm all specified needs: confirmed_at (kept when already set) and locked_at.
    await prisma.need.updateMany({
      where: { id: { in: needIds }, participantId: me, confirmedAt: null },
      data: { confirmedAt: now },
    });
    await prisma.need.updateMany({ where: { id: { in: needIds }, participantId: me }, data: { lockedAt: now } });
    await reachMilestone(me, 'needs_confirmed', now);

    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'partner.needs_confirmed', { stage: 3, confirmedBy: user.id });
    }
    const partner = await getPartnerParticipant(me);
    successResponse(res, {
      confirmed: true,
      confirmedAt: now.toISOString(),
      partnerConfirmed: partner ? await hasShared(sessionId, partner.participantId) : false,
      canAdvance: false, // Need to share needs first
    });
  } catch (error) {
    logger.error('[confirmNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to confirm needs', 500);
  }
}

/**
 * Share the caller's needs with their partner.
 * POST /sessions/:id/needs/consent
 */
export async function consentToShareNeeds(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { id: sessionId } = req.params;
    const { needIds } = req.body as { needIds?: string[] };
    if (!needIds || !Array.isArray(needIds) || needIds.length === 0) {
      errorResponse(res, 'VALIDATION_ERROR', 'needIds array is required', 400);
      return;
    }
    const ctx = await needsContext(req, sessionId, user.id);
    if (!ctx) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (ctx.sessionStatus !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (ctx.stage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot consent to share: you are in stage ${ctx.stage}, but stage 3 is required`,
        400,
      );
      return;
    }
    const me = ctx.participant.id;
    // Every shared need is a live confirmed need of the caller's, and every live need is shared together.
    const live = (await listOwnNeeds(me, { live: true })) as NeedRecord[];
    const requested = new Set(needIds);
    const chosen = live.filter(n => requested.has(n.id) && n.confirmedAt !== null);
    if (chosen.length !== needIds.length) {
      errorResponse(res, 'VALIDATION_ERROR', 'All live needs must be confirmed before sharing', 400);
      return;
    }
    if (live.length !== needIds.length || !live.every(n => requested.has(n.id))) {
      errorResponse(res, 'VALIDATION_ERROR', 'Every live need must be shared together', 400);
      return;
    }

    const result = await shareNeeds({
      sessionId,
      participantId: me,
      needs: chosen.map(n => ({ id: n.id, label: n.label, category: n.category, evidence: n.evidence })),
    });

    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'partner.needs_shared', {
        stage: 3,
        sharedBy: user.id,
        needsRevealReady: result.allShared,
      });
    }
    if (result.completedNow) {
      await publishSessionEvent(sessionId, 'session.needs_reveal_ready', { stage: 3, needsRevealReady: true });
      await announceStage4(sessionId, { userId: user.id });
    }
    if (!result.allShared) {
      await guidance(
        sessionId,
        ctx.participant,
        user.id,
        "Your needs have been shared. Once your partner shares theirs, you'll be able to review them side by side.",
      );
    }
    successResponse(res, {
      consented: true,
      sharedAt: result.sharedAt.toISOString(),
      waitingForPartner: !result.allShared,
      needsRevealReady: result.allShared,
      advancedToStage4: result.allShared,
    });
  } catch (error) {
    logger.error('[consentToShareNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to consent to share needs', 500);
  }
}

/**
 * Validate the revealed needs lists (needs_validated, by the job: a system key).
 * POST /sessions/:id/needs/validate
 */
export async function validateNeeds(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { id: sessionId } = req.params;
    const { validated = true } = req.body as { validated?: boolean };
    if (typeof validated !== 'boolean') {
      errorResponse(res, 'VALIDATION_ERROR', 'validated boolean is required', 400);
      return;
    }
    const ctx = await needsContext(req, sessionId, user.id);
    if (!ctx) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (ctx.sessionStatus !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (ctx.stage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot validate needs: you are in stage ${ctx.stage}, but stage 3 is required`,
        400,
      );
      return;
    }
    const me = ctx.participant.id;
    const partner = await getPartnerParticipant(me);
    const shared = await participantsWhoShared(sessionId);
    if (!shared.has(me) || !partner || !shared.has(partner.participantId)) {
      errorResponse(res, 'VALIDATION_ERROR', 'Both partners must consent to reveal needs before validation', 400);
      return;
    }
    const now = new Date();
    if (validated) await reachMilestone(me, 'needs_validated', now);
    const partnerValidated = await hasMilestone(partner.participantId, 'needs_validated');
    const partnerId = partner.userId;
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'partner.needs_validated', {
        stage: 3,
        validatedBy: user.id,
        validated,
        allValidatedByBoth: validated && partnerValidated,
      });
    }
    const canAdvance = validated && partnerValidated;
    if (canAdvance && (await completeNeedsSharingIfReady(sessionId, now))) {
      await announceStage4(sessionId, { userId: user.id });
    }
    if (!validated) {
      await guidance(
        sessionId,
        ctx.participant,
        user.id,
        "No problem — take your time reviewing. You can chat about anything that doesn't feel right, and review the needs again when you're ready.",
      );
    }
    successResponse(res, {
      validated,
      validatedAt: validated ? now.toISOString() : null,
      partnerValidated,
      canAdvance,
    });
  } catch (error) {
    logger.error('[validateNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to validate needs', 500);
  }
}

/**
 * POST /sessions/:id/needs — a custom need (auto-confirmed).
 */
export async function addCustomNeed(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { id: sessionId } = req.params;
    const { need, category } = req.body as { need?: string; category?: unknown; description?: string };
    if (!need || !isNeedCategory(category)) {
      errorResponse(res, 'VALIDATION_ERROR', 'need and valid category are required', 400);
      return;
    }
    const ctx = await needsContext(req, sessionId, user.id);
    if (!ctx) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (ctx.sessionStatus !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }
    if (ctx.stage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot add need: you are in stage ${ctx.stage}, but stage 3 is required`,
        400,
      );
      return;
    }
    const custom = (await prisma.need.create({
      data: {
        participantId: ctx.participant.id,
        label: need,
        category,
        evidence: [],
        aiConfidence: 1.0, // User-added needs are considered 100% confident
        confirmedAt: new Date(), // User-added needs are auto-confirmed
      },
      select: NEED_SELECT,
    })) as NeedRecord;
    const warning = withNeedReframingWarning({ need: custom.label });
    successResponse(
      res,
      {
        need: {
          id: custom.id,
          need: custom.label,
          category: custom.category,
          description: custom.label,
          evidence: custom.evidence,
          aiConfidence: custom.aiConfidence,
          confirmed: true,
          needsReframing: warning.needsReframing,
          reframingWarning: warning.reframingWarning,
        },
      },
      201,
    );
  } catch (error) {
    logger.error('[addCustomNeed] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to add custom need', 500);
  }
}

/**
 * POST /sessions/:id/needs/interpret-edit-request
 */
export async function interpretNeedEdit(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { id: sessionId } = req.params;
    const { request, targetNeedId, conversationHistory } = req.body as {
      request?: string;
      targetNeedId?: string;
      conversationHistory?: unknown;
    };
    if (!request || typeof request !== 'string') {
      errorResponse(res, 'VALIDATION_ERROR', 'request is required', 400);
      return;
    }
    const result = await interpretNeedEditRequest(sessionId, user.id, {
      request,
      targetNeedId,
      conversationHistory: Array.isArray(conversationHistory) ? (conversationHistory as never) : undefined,
    });
    successResponse(res, result);
  } catch (error) {
    if (needEditErrorResponse(res, error)) return;
    logger.error('[interpretNeedEdit] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to interpret need edit request', 500);
  }
}

/**
 * POST /sessions/:id/needs/apply-edits
 */
export async function applyNeedEditPlan(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { operations } = req.body as { operations?: unknown };
    if (!Array.isArray(operations)) {
      errorResponse(res, 'VALIDATION_ERROR', 'operations array is required', 400);
      return;
    }
    successResponse(res, await applyNeedEdits(req.params.id, user.id, operations as never));
  } catch (error) {
    if (needEditErrorResponse(res, error)) return;
    logger.error('[applyNeedEditPlan] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to apply need edits', 500);
  }
}

/**
 * DELETE /sessions/:id/needs/:needId — remove a need before it is shared (soft delete).
 */
export async function removeNeed(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { id: sessionId, needId } = req.params;
    if (!needId) {
      errorResponse(res, 'VALIDATION_ERROR', 'needId is required', 400);
      return;
    }
    const need = await deleteNeed(sessionId, user.id, needId);
    // Fix round 1 (Important 6): the deleted need's label and evidence are the
    // owner's alone — a session-channel event reaches the partner's device
    // too. The owner's own device patches its cache from this response; other
    // devices of the owner get a content-free nudge on the owner's channel.
    await publishUserEvent(user.id, 'session.updated', { sessionId, kind: 'need.deleted', userId: user.id }).catch(
      err => logger.warn('[removeNeed] Failed to publish need.deleted:', err),
    );
    successResponse(res, { deleted: true, needId, need });
  } catch (error) {
    if (needEditErrorResponse(res, error)) return;
    logger.error('[removeNeed] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to remove need', 500);
  }
}

/**
 * Side by side, once both have shared: the caller's own confirmed needs
 * (their labels), and the partner's SHARED needs — `v_need_shared`, the
 * job's transformed text and the category; the partner's `need` row is never
 * read (work-a39h.11.21: the old code returned the partner's private label).
 * GET /sessions/:id/needs/comparison
 */
export async function getNeedsComparison(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { id: sessionId } = req.params;
    const ctx = await needsContext(req, sessionId, user.id);
    if (!ctx) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (ctx.sessionStatus !== 'ACTIVE' || ctx.stage < 3) {
      successResponse(res, EMPTY_COMPARISON);
      return;
    }
    const me = ctx.participant.id;
    const partner = await getPartnerParticipant(me);
    if (!partner) {
      errorResponse(res, 'INTERNAL_ERROR', 'Could not find partner', 500);
      return;
    }
    const shared = await listSharedNeeds(sessionId);
    const mineShared = shared.some(n => n.participantId === me);
    const partnerShared = shared.filter(n => n.participantId === partner.participantId);
    if (!mineShared || partnerShared.length === 0) {
      successResponse(res, EMPTY_COMPARISON);
      return;
    }
    const myNeeds = await listOwnNeeds(me, { confirmed: true });
    if (myNeeds.length === 0) {
      successResponse(res, EMPTY_COMPARISON);
      return;
    }
    const [myValidated, partnerValidated] = await Promise.all([
      hasMilestone(me, 'needs_validated'),
      hasMilestone(partner.participantId, 'needs_validated'),
    ]);
    successResponse(res, {
      myNeeds: myNeeds.map(n => ({ id: n.id, category: n.category, need: n.label, confirmed: true })),
      partnerNeeds: partnerShared.map(n => ({
        id: n.needId,
        category: n.category,
        need: n.sharedText,
        confirmed: true,
      })),
      myValidated,
      partnerValidated,
      canAdvance: myValidated && partnerValidated,
      commonGround: [],
      analysisComplete: true,
      noOverlap: false,
    });
  } catch (error) {
    logger.error('[getNeedsComparison] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get needs comparison', 500);
  }
}
