/**
 * Topic Frame Controller
 *
 * Handles the topic frame lifecycle during Stage 0 (topic articulation):
 * - POST /sessions/:id/topic-frame/confirm - User confirms the AI-proposed topic
 *
 * The topic frame itself is proposed by the AI via update_session_state.topicFrame
 * during normal Stage 0 chat (legacy <draft> parsing is retained as fallback).
 * The session row is the single source of truth for `topicFrame`. This endpoint
 * only flips `topicFrameConfirmedAt` to mark it confirmed.
 *
 * Refinement happens through normal Stage 0 chat (the AI re-emits a fresh
 * <draft> with each revision). There is no manual "generate" or "refine" HTTP
 * endpoint anymore.
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { getJobPrisma, prisma } from '../lib/prisma';
import { successResponse, errorResponse } from '../utils/response';
import { isSessionCreator } from '../utils/session';

/**
 * Confirm the topic frame currently on the session.
 * POST /sessions/:id/topic-frame/confirm
 *
 * No body required. Returns updated session state. Idempotent.
 */
export async function confirmTopicFrame(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;

    const isCreator = await isSessionCreator(sessionId, user.id);
    if (!isCreator) {
      errorResponse(res, 'FORBIDDEN', 'Only the session creator can confirm the topic frame', 403);
      return;
    }

    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: { members: { some: { userId: user.id } } },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    if (!session.topicFrame) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'No topic frame to confirm — keep chatting until the coach proposes one',
        400,
      );
      return;
    }

    // Idempotent: if already confirmed, just return current state
    const now = session.topicFrameConfirmedAt ?? new Date();
    let updated = session;
    if (!session.topicFrameConfirmedAt) {
      updated = await prisma.session.update({
        where: { id: sessionId },
        data: { topicFrameConfirmedAt: now },
      });
      logger.info(`[confirmTopicFrame] Topic frame confirmed for session ${sessionId}: "${updated.topicFrame}"`);
    }

    // Make the invitation immediately acceptable. Mark the invitation row
    // messageConfirmed and flip session.status to INVITED so the partner can
    // join via the link as soon as the topic is locked — without waiting for
    // the inviter to close the share modal. Stage advancement (Stage 0→1) and
    // the AI transition message remain gated to confirmInvitationMessage,
    // which the inviter triggers when they close the modal.
    if (updated.status === 'CREATED') {
      // CREATED → INVITED through the sole status writer (TS-12; spec §4)
      await getJobPrisma().$executeRaw`SELECT app.session_set_status(${sessionId}::uuid, 'INVITED'::session_status)`;
    }
    await prisma.invitation.updateMany({
      where: { sessionId, messageConfirmedAt: null },
      data: { messageConfirmedAt: now },
    });

    successResponse(res, {
      topicFrame: updated.topicFrame,
      confirmedAt: now.toISOString(),
    });
  } catch (error) {
    logger.error('[confirmTopicFrame] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to confirm topic frame', 500);
  }
}
