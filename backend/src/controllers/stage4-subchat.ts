/**
 * Stage 4 Sub-chat controller (Phase 3).
 *
 * Endpoints:
 *   POST   /sessions/:id/stage4/subchat                  — open or get ACTIVE
 *   GET    /sessions/:id/stage4/subchat/:subChatId       — fetch
 *   POST   /sessions/:id/stage4/subchat/:subChatId/messages  — append user message + AI reply
 *   POST   /sessions/:id/stage4/subchat/:subChatId/resolve   — resolve with structured payload
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { Stage4SubChatAnchor, ResolveStage4SubChatRequest } from '@meet-without-fear/shared';
import { errorResponse, successResponse } from '../utils/response';
import { getPartnerUserId } from '../utils/session';
import { notifyPartner, publishSessionEvent } from '../services/realtime';
import { logger } from '../lib/logger';
import {
  appendUserMessageAndRespond,
  getSubChatById,
  openOrGetActiveSubChat,
  resolveSubChat,
  SubChatForbiddenError,
  SubChatNotFoundError,
  SubChatResolvedError,
  toSubChatDTO,
} from '../services/stage4-subchat.service';

const openSchema = z.object({
  anchorKind: z.nativeEnum(Stage4SubChatAnchor),
  anchorId: z.string().min(1).nullable().optional(),
});

const sendSchema = z.object({
  content: z.string().min(1).max(4000),
});

const proposalDraftSchema = z.object({
  proposalId: z.string().optional(),
  description: z.string().min(1),
  needsAddressed: z.array(z.string()).optional(),
  duration: z.string().nullable().optional(),
  measureOfSuccess: z.string().nullable().optional(),
});

const resolveSchema = z.object({
  acceptedProposals: z.array(proposalDraftSchema).optional(),
  updatedProposals: z.array(proposalDraftSchema).optional(),
}) satisfies z.ZodType<ResolveStage4SubChatRequest>;

export async function openStage4SubChat(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
    return;
  }
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 'VALIDATION_ERROR', 'Invalid open request', 400, parsed.error.flatten());
    return;
  }
  const { id: sessionId } = req.params;
  try {
    const record = await openOrGetActiveSubChat({
      sessionId,
      userId: user.id,
      anchorKind: parsed.data.anchorKind,
      anchorId: parsed.data.anchorId ?? null,
    });
    successResponse(res, { subChat: toSubChatDTO(record) });
  } catch (err) {
    if (err instanceof SubChatNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Sub-chat anchor not found', 404);
      return;
    }
    logger.error('[openStage4SubChat]', err);
    errorResponse(res, 'INTERNAL_ERROR', 'Could not open sub-chat', 500);
  }
}

export async function getStage4SubChat(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
    return;
  }
  const { subChatId } = req.params;
  const record = await getSubChatById(subChatId);
  if (!record) {
    errorResponse(res, 'NOT_FOUND', 'Sub-chat not found', 404);
    return;
  }
  if (record.userId !== user.id) {
    errorResponse(res, 'FORBIDDEN', 'Sub-chat belongs to a different user', 403);
    return;
  }
  successResponse(res, { subChat: toSubChatDTO(record) });
}

export async function sendStage4SubChatMessage(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
    return;
  }
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 'VALIDATION_ERROR', 'Invalid message', 400, parsed.error.flatten());
    return;
  }
  const { subChatId } = req.params;
  try {
    const record = await appendUserMessageAndRespond({
      subChatId,
      userId: user.id,
      content: parsed.data.content,
    });
    successResponse(res, { subChat: toSubChatDTO(record) });
  } catch (err) {
    if (err instanceof SubChatNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Sub-chat not found', 404);
      return;
    }
    if (err instanceof SubChatForbiddenError) {
      errorResponse(res, 'FORBIDDEN', 'Sub-chat belongs to a different user', 403);
      return;
    }
    if (err instanceof SubChatResolvedError) {
      errorResponse(res, 'CONFLICT', 'Sub-chat is already resolved', 409);
      return;
    }
    logger.error('[sendStage4SubChatMessage]', err);
    errorResponse(res, 'INTERNAL_ERROR', 'Could not send message', 500);
  }
}

export async function resolveStage4SubChat(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user) {
    errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
    return;
  }
  const parsed = resolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    errorResponse(res, 'VALIDATION_ERROR', 'Invalid resolve payload', 400, parsed.error.flatten());
    return;
  }
  const { id: sessionId, subChatId } = req.params;
  try {
    const result = await resolveSubChat({
      subChatId,
      userId: user.id,
      acceptedProposals: parsed.data.acceptedProposals,
      updatedProposals: parsed.data.updatedProposals,
    });

    const inventoryChanged = result.createdProposalIds.length > 0 || result.updatedProposalIds.length > 0;
    if (inventoryChanged) {
      try {
        await publishSessionEvent(sessionId, 'session.strategies_updated', {
          stage: 4,
          submittedBy: user.id,
          change: 'stage4_subchat_resolved',
        });
        const partnerId = await getPartnerUserId(sessionId, user.id);
        if (partnerId) {
          await notifyPartner(sessionId, partnerId, 'session.strategies_updated', {
            stage: 4,
            submittedBy: user.id,
            change: 'stage4_subchat_resolved',
          });
        }
      } catch (e) {
        logger.warn('[resolveStage4SubChat] realtime emit failed', e);
      }
    }

    successResponse(res, {
      subChat: toSubChatDTO(result.subChat),
      createdProposalIds: result.createdProposalIds,
      updatedProposalIds: result.updatedProposalIds,
    });
  } catch (err) {
    if (err instanceof SubChatNotFoundError) {
      errorResponse(res, 'NOT_FOUND', 'Sub-chat not found', 404);
      return;
    }
    if (err instanceof SubChatForbiddenError) {
      errorResponse(res, 'FORBIDDEN', 'Sub-chat belongs to a different user', 403);
      return;
    }
    logger.error('[resolveStage4SubChat]', err);
    errorResponse(res, 'INTERNAL_ERROR', 'Could not resolve sub-chat', 500);
  }
}
