/**
 * Stream Turn Persistence
 *
 * The message-row writes of a streaming chat turn, extracted
 * (behavior-preserving) from `sendMessageStream`, so the controller holds no
 * direct Prisma access:
 *
 * - `resolveStage3GateTurn` answers the Stage 3 "show me the lists" request
 *   from gate state instead of the model, persisting the canned AI message;
 * - `saveAiTurnMessage` persists the streamed AI response and broadcasts it;
 * - `cleanupFailedStreamTurn` deletes the user message and publishes the Ably
 *   error so a retry starts from a clean conversation turn.
 *
 * Each function performs its own writes and returns; SSE framing stays in the
 * controller.
 */

import type { Message } from '../generated/prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { brainService } from './brain-service';
import { publishMessageError } from './realtime';
import { getPartnerUserId } from '../utils/session';
import type { RefiningNeedContext } from './stream-turn-actions';

export function isReadyForStage3RevealText(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (/\bnot\s+ready\b/.test(normalized) || /\b(?:don'?t|do not)\s+(?:want|feel ready)\b/.test(normalized)) {
    return false;
  }
  return /\b(i'?m|i am|we are)?\s*ready\b/.test(normalized) &&
    /(list|lists|needs|side by side|reveal|see them|see it|show)/.test(normalized);
}

async function getStage3GateResponse(sessionId: string, userId: string): Promise<string | null> {
  const partnerId = await getPartnerUserId(sessionId, userId);
  const progress = await prisma.stageProgress.findUnique({
    where: {
      sessionId_userId_stage: {
        sessionId,
        userId,
        stage: 3,
      },
    },
  });
  if (!progress) return null;

  const vessel = await prisma.userVessel.findUnique({
    where: { userId_sessionId: { userId, sessionId } },
    include: { identifiedNeeds: { orderBy: { createdAt: 'asc' } } },
  });
  const needs = vessel?.identifiedNeeds ?? [];
  const gates = progress.gatesSatisfied as Record<string, unknown> | null;
  const ownShared = gates?.needsShared === true;
  const ownConfirmed = gates?.needsConfirmed === true || (needs.length > 0 && needs.every((need) => need.confirmed));

  if (needs.length === 0) {
    return "Let's first put words to what matters most for you here. What do you need in order to feel clear, grounded, or able to move forward from this?";
  }

  if (!ownConfirmed) {
    return "I've captured a draft of what matters to you. Please review and confirm your needs before we move any further.";
  }

  if (!ownShared) {
    return "Your needs are ready for your review. If they still feel right, you can choose to share them for the side-by-side step.";
  }

  if (!partnerId) {
    return "Your needs are shared. We'll wait until your partner has shared theirs before showing anything side by side.";
  }

  const partnerProgress = await prisma.stageProgress.findUnique({
    where: {
      sessionId_userId_stage: {
        sessionId,
        userId: partnerId,
        stage: 3,
      },
    },
  });
  const partnerGates = partnerProgress?.gatesSatisfied as Record<string, unknown> | null;
  if (partnerGates?.needsShared !== true) {
    return "Your needs are shared. We'll wait until your partner has shared theirs before showing anything side by side.";
  }

  return "Both needs lists are ready to review side by side. Take a look at them and notice what stands out before deciding whether they feel accurate.";
}

/**
 * Short-circuits a Stage 3 "I'm ready to see the lists" turn with a
 * gate-derived response, or returns null to let the model handle the turn.
 */
export async function resolveStage3GateTurn(params: {
  sessionId: string;
  userId: string;
  currentStage: number;
  content: string;
}): Promise<{ text: string; aiMessage: Message } | null> {
  const { sessionId, userId, currentStage, content } = params;

  if (currentStage !== 3 || !isReadyForStage3RevealText(content)) return null;

  const gateResponse = await getStage3GateResponse(sessionId, userId);
  if (!gateResponse) return null;

  const aiMessage = await prisma.message.create({
    data: {
      sessionId,
      senderId: null,
      forUserId: userId,
      role: 'AI',
      content: gateResponse,
      stage: 3,
    },
  });

  return { text: gateResponse, aiMessage };
}

/** Persists the streamed AI response and broadcasts it to the Status Site. */
export async function saveAiTurnMessage(params: {
  requestId: string;
  sessionId: string;
  userId: string;
  /** Visible response text; trimmed on the way in. */
  accumulatedText: string;
  /** Stage used for analytics (21 for Stage 2B). */
  effectiveStage: number;
  refiningNeedContext: RefiningNeedContext | null;
}): Promise<Message> {
  const { requestId, sessionId, userId, accumulatedText, effectiveStage, refiningNeedContext } = params;

  // Trim whitespace that Claude sometimes adds
  const aiMessage = await prisma.message.create({
    data: {
      sessionId,
      senderId: null,
      forUserId: userId,
      role: 'AI',
      content: accumulatedText.trim(),
      stage: effectiveStage, // Use effective stage (21 for Stage 2B) for analytics
      refiningNeedId: refiningNeedContext?.id ?? null,
    },
  });
  logger.info(`[sendMessageStream:${requestId}] AI message created: ${aiMessage.id}`);

  // Broadcast to Status Site
  brainService.broadcastMessage(aiMessage);

  return aiMessage;
}

/**
 * Deletes the user message and publishes the Ably error after a failed
 * stream, so the user can retry into a fresh conversation turn without
 * duplicating their message. No AI message is saved.
 */
export async function cleanupFailedStreamTurn(params: {
  requestId: string;
  sessionId: string;
  userId: string;
  userMessageId: string;
}): Promise<void> {
  const { requestId, sessionId, userId, userMessageId } = params;

  logger.error(`[sendMessageStream:${requestId}] Stream failed, cleaning up user message`);

  // Delete user message so retry creates fresh conversation turn
  await prisma.message.delete({ where: { id: userMessageId } }).catch((deleteErr) => {
    logger.warn(`[sendMessageStream:${requestId}] Failed to delete user message on error:`, deleteErr);
  });

  // Publish error via Ably so frontend can update UI (mark message as failed)
  await publishMessageError(
    sessionId,
    userId,
    userMessageId, // ID for frontend to identify which optimistic message failed
    'Sorry, I had trouble generating a response. Please try again.',
    true // canRetry
  ).catch((ablyErr) => {
    logger.warn(`[sendMessageStream:${requestId}] Failed to publish error via Ably:`, ablyErr);
  });
}
