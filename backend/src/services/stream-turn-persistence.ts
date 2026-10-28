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
 *
 * Target shape (TS-9): AI rows go into the participant's MAIN conversation
 * through the job connection (`createFacilitatorMessage`).
 */

import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { brainService } from './brain-service';
import { publishMessageError } from './realtime';
import type { RefiningNeedContext } from './stream-turn-actions';
import { getPartnerParticipant, type ResolvedParticipant } from './participant-resolver';
import { createFacilitatorMessage, deleteMessage, type StoredMessage } from './message-store';
import { loadStageStates, rowForStage } from './stage-shim';

export function isReadyForStage3RevealText(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (/\bnot\s+ready\b/.test(normalized) || /\b(?:don'?t|do not)\s+(?:want|feel ready)\b/.test(normalized)) {
    return false;
  }
  return (
    /\b(i'?m|i am|we are)?\s*ready\b/.test(normalized) &&
    /(list|lists|needs|side by side|reveal|see them|see it|show)/.test(normalized)
  );
}

async function getStage3GateResponse(participant: ResolvedParticipant): Promise<string | null> {
  const partner = await getPartnerParticipant(participant.id);
  const states = await loadStageStates([
    { id: participant.id, joinedAt: participant.joinedAt },
    ...(partner ? [{ id: partner.participantId, joinedAt: partner.joinedAt }] : []),
  ]);
  // The old gate read the stage-3 StageProgress row: none before stage 3.
  const stage3 = rowForStage(states.get(participant.id), 3);
  if (!stage3) return null;

  const needs = await prisma.need.findMany({
    where: { participantId: participant.id, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { confirmedAt: true },
  });
  const gates = stage3.gatesSatisfied;
  const ownShared = gates.needsShared === true;
  const ownConfirmed =
    gates.needsConfirmed === true || (needs.length > 0 && needs.every(need => need.confirmedAt !== null));

  if (needs.length === 0) {
    return "Let's first put words to what matters most for you here. What do you need in order to feel clear, grounded, or able to move forward from this?";
  }

  if (!ownConfirmed) {
    return "I've captured a draft of what matters to you. Please review and confirm your needs before we move any further.";
  }

  if (!ownShared) {
    return 'Your needs are ready for your review. If they still feel right, you can choose to share them for the side-by-side step.';
  }

  if (!partner) {
    return "Your needs are shared. We'll wait until your partner has shared theirs before showing anything side by side.";
  }

  // The partner's milestones are S-class (participant_milestone is visible to co-participants).
  const partnerShared = states.get(partner.participantId)?.milestones.some(m => m.key === 'needs_shared') ?? false;
  if (!partnerShared) {
    return "Your needs are shared. We'll wait until your partner has shared theirs before showing anything side by side.";
  }

  return 'Both needs lists are ready to review side by side. Take a look at them and notice what stands out before deciding whether they feel accurate.';
}

/**
 * Short-circuits a Stage 3 "I'm ready to see the lists" turn with a
 * gate-derived response, or returns null to let the model handle the turn.
 */
export async function resolveStage3GateTurn(params: {
  participant: ResolvedParticipant;
  currentStage: number;
  content: string;
}): Promise<{ text: string; aiMessage: StoredMessage } | null> {
  const { participant, currentStage, content } = params;

  if (currentStage !== 3 || !isReadyForStage3RevealText(content)) return null;
  if (!participant.mainConversationId) return null;

  const gateResponse = await getStage3GateResponse(participant);
  if (!gateResponse) return null;

  // The facilitator's reply, into the participant's conversation (job connection).
  const aiMessage = await createFacilitatorMessage({
    conversationId: participant.mainConversationId,
    content: gateResponse,
  });

  return { text: gateResponse, aiMessage };
}

/** Persists the streamed AI response and broadcasts it to the Status Site. */
export async function saveAiTurnMessage(params: {
  requestId: string;
  sessionId: string;
  participant: ResolvedParticipant;
  /** Visible response text; trimmed on the way in. */
  accumulatedText: string;
  /** Stage used for analytics (21 for Stage 2B); the target stores no stage. */
  effectiveStage: number;
  refiningNeedContext: RefiningNeedContext | null;
}): Promise<StoredMessage> {
  const { requestId, sessionId, participant, accumulatedText, effectiveStage, refiningNeedContext } = params;
  if (!participant.mainConversationId) throw new Error(`Participant ${participant.id} has no MAIN conversation`);

  // Trim whitespace that Claude sometimes adds. The AI row is written through
  // the JOB connection (spec §1.1 message, writer-principal rule).
  const aiMessage = await createFacilitatorMessage({
    conversationId: participant.mainConversationId,
    content: accumulatedText.trim(),
    refiningNeedId: refiningNeedContext?.id ?? null,
  });
  logger.info(`[sendMessageStream:${requestId}] AI message created: ${aiMessage.id}`);

  // Broadcast to Status Site
  brainService.broadcastMessage({
    id: aiMessage.id,
    sessionId,
    senderId: null,
    role: 'AI',
    content: aiMessage.content,
    stage: effectiveStage,
    timestamp: aiMessage.createdAt,
  });

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
  await deleteMessage(userMessageId).catch(deleteErr => {
    logger.warn(`[sendMessageStream:${requestId}] Failed to delete user message on error:`, deleteErr);
  });

  // Publish error via Ably so frontend can update UI (mark message as failed)
  await publishMessageError(
    sessionId,
    userId,
    userMessageId, // ID for frontend to identify which optimistic message failed
    'Sorry, I had trouble generating a response. Please try again.',
    true, // canRetry
  ).catch(ablyErr => {
    logger.warn(`[sendMessageStream:${requestId}] Failed to publish error via Ably:`, ablyErr);
  });
}
