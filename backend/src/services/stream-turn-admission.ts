/**
 * Stream Turn Admission
 *
 * Everything a streaming chat turn must clear before the SSE stream opens,
 * extracted (behavior-preserving) from `sendMessageStream`: authentication,
 * request-body validation, session lookup + status gate, stage-progress load,
 * `refiningNeedId` validation, user-message persistence, activity touch +
 * partner-activity publish, and the Status Site broadcast.
 *
 * The result is a discriminated union so the controller either writes a
 * plain JSON rejection (headers not yet sent) or proceeds with a fully typed
 * admitted turn. All rejections happen before any SSE header is flushed.
 *
 * Target shape (TS-9): the caller is `req.participant`; the stage is the stage
 * shim's; the user's turn is written into their MAIN conversation
 * (`createParticipantMessage`, app connection); activity goes to their
 * `conversation_read_state`.
 */

import { Request } from 'express';
import type { Session } from '../generated/prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { brainService } from './brain-service';
import { publishSessionEvent } from './realtime';
import { sendMessageRequestSchema, DEFAULT_PRIVACY_PREFERENCES } from '@meet-without-fear/shared';
import type { AuthUser } from '../middleware/auth';
import type { RefiningNeedContext } from './stream-turn-actions';
import type { ResolvedParticipant } from './participant-resolver';
import { createParticipantMessage, toMessageDTO, type StoredMessage } from './message-store';
import { currentRow, loadStageStates, type ShimStageRow } from './stage-shim';
import { touchParticipantActivity } from '../utils/session';

/** The caller's own `privacy.showActivityStatus` (user_preferences.doc; default true). */
async function getShowActivityStatus(userId: string): Promise<boolean> {
  const prefs = await prisma.userPreferences.findUnique({ where: { userId }, select: { doc: true } });
  const value = (prefs?.doc as { privacy?: { showActivityStatus?: unknown } } | null)?.privacy?.showActivityStatus;
  return typeof value === 'boolean' ? value : DEFAULT_PRIVACY_PREFERENCES.showActivityStatus;
}

/** A turn that cleared admission; the SSE stream may now be opened. */
export interface AdmittedStreamTurn {
  user: AuthUser;
  sessionId: string;
  /** The caller's participant (requireSessionAccess). */
  participant: ResolvedParticipant;
  /** The user's message content for this turn. */
  content: string;
  session: Session;
  /** The participant's current stage row (stage shim), if they have begun. */
  progress: ShimStageRow | null;
  currentStage: number;
  refiningNeedContext: RefiningNeedContext | null;
  /** The persisted user message row. */
  userMessage: StoredMessage;
}

/** A rejection the controller renders as a plain JSON response. */
export interface RejectedStreamTurn {
  status: number;
  body: Record<string, unknown>;
}

export type StreamTurnAdmissionResult =
  | ({ admitted: true } & AdmittedStreamTurn)
  | ({ admitted: false } & RejectedStreamTurn);

export interface StreamTurnAdmissionParams {
  requestId: string;
  req: Request;
}

export async function admitStreamTurn(
  params: StreamTurnAdmissionParams
): Promise<StreamTurnAdmissionResult> {
  const { requestId, req } = params;

  const user = req.user;
  if (!user) {
    return { admitted: false, status: 401, body: { error: 'Authentication required' } };
  }

  const { id: sessionId } = req.params;

  // Validate request body
  const parseResult = sendMessageRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return {
      admitted: false,
      status: 400,
      body: { error: 'Invalid request body', details: parseResult.error.issues },
    };
  }

  const { content, refiningNeedId } = parseResult.data;

  // The caller's participant (resolved once by requireSessionAccess). The
  // invitee fallback has none, and nothing to write into.
  const participant = req.participant;
  const session = participant ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
  if (!participant || !participant.mainConversationId || !session) {
    return { admitted: false, status: 404, body: { error: 'Session not found' } };
  }

  // Check session allows messaging. RESOLVED remains open for private
  // Tending/listen-first conversation after Stage 4 closes. Before the
  // partner joins, only the inviter may talk.
  if (session.status !== 'ACTIVE') {
    if (session.status === 'CREATED') {
      const isInviter = await prisma.invitation.count({
        where: { sessionId, invitedByParticipantId: participant.id },
      });
      if (!isInviter) {
        return { admitted: false, status: 400, body: { error: 'Session is not active' } };
      }
    } else if (session.status !== 'INVITED' && session.status !== 'RESOLVED') {
      return { admitted: false, status: 400, body: { error: 'Session is not active' } };
    }
  }

  // The participant's current stage (stage shim)
  const stages = await loadStageStates([{ id: participant.id, joinedAt: participant.joinedAt }]);
  const state = stages.get(participant.id);
  const progress = state ? currentRow(state) : null;
  const currentStage = state?.current.stage ?? 0;

  let refiningNeedContext: RefiningNeedContext | null = null;
  if (currentStage === 3 && refiningNeedId) {
    // Only one of the participant's own live needs can be refined.
    const refiningNeed = await prisma.need.findFirst({
      where: { id: refiningNeedId, participantId: participant.id, deletedAt: null },
      select: { id: true, label: true, category: true },
    });
    if (!refiningNeed) {
      return { admitted: false, status: 400, body: { error: 'Invalid refiningNeedId' } };
    }
    refiningNeedContext = {
      id: refiningNeed.id,
      need: refiningNeed.label,
      category: refiningNeed.category,
    };
  }

  // ===========================================================================
  // Save user message — into the participant's own conversation
  // ===========================================================================
  const userMessage = await createParticipantMessage({
    conversationId: participant.mainConversationId,
    participantId: participant.id,
    content,
    refiningNeedId: refiningNeedContext?.id ?? null,
  });
  await touchParticipantActivity(participant.id, userMessage.createdAt);
  getShowActivityStatus(user.id)
    .then((showActivityStatus) => {
      if (!showActivityStatus) return;
      return publishSessionEvent(sessionId, 'partner.activity', {
        activeAt: userMessage.createdAt.toISOString(),
      }, user.id);
    })
    .catch((err) =>
      logger.warn(`[sendMessageStream:${requestId}] Failed to publish partner activity:`, err)
    );
  logger.info(`[sendMessageStream:${requestId}] User message created: ${userMessage.id}`);

  // Broadcast to Status Site
  brainService.broadcastMessage(toMessageDTO(userMessage, { sessionId, ownerMilestones: state?.milestones ?? [] }));

  return {
    admitted: true,
    user,
    sessionId,
    participant,
    content,
    session,
    progress,
    currentStage,
    refiningNeedContext,
    userMessage,
  };
}
