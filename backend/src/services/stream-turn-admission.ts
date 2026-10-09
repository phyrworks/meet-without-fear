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
 */

import { Request } from 'express';
import type { Message, Session, StageProgress } from '../generated/prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { brainService } from './brain-service';
import { publishSessionEvent } from './realtime';
import { isSessionCreator, touchUserSessionActivity } from '../utils/session';
import {
  sendMessageRequestSchema,
  DEFAULT_PRIVACY_PREFERENCES,
  PrivacyPreferencesDTO,
} from '@meet-without-fear/shared';
import type { AuthUser } from '../middleware/auth';
import type { RefiningNeedContext } from './stream-turn-actions';

async function getShowActivityStatus(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { privacyPreferences: true } as any,
  });
  const preferences = ((user as { privacyPreferences?: unknown } | null)?.privacyPreferences as PrivacyPreferencesDTO | null) ?? DEFAULT_PRIVACY_PREFERENCES;
  return preferences.showActivityStatus;
}

/** A turn that cleared admission; the SSE stream may now be opened. */
export interface AdmittedStreamTurn {
  user: AuthUser;
  sessionId: string;
  /** The user's message content for this turn. */
  content: string;
  session: Session;
  /** Highest IN_PROGRESS/GATE_PENDING stage progress row, if any. */
  progress: StageProgress | null;
  currentStage: number;
  refiningNeedContext: RefiningNeedContext | null;
  /** The persisted user message row. */
  userMessage: Message;
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
    return { admitted: false, status: 404, body: { error: 'Session not found' } };
  }

  // Check session allows messaging. RESOLVED remains open for private
  // Tending/listen-first conversation after Stage 4 closes.
  if (session.status !== 'ACTIVE') {
    if (session.status === 'CREATED') {
      const isCreator = await isSessionCreator(sessionId, user.id);
      if (!isCreator) {
        return { admitted: false, status: 400, body: { error: 'Session is not active' } };
      }
    } else if (session.status !== 'INVITED' && session.status !== 'RESOLVED') {
      return { admitted: false, status: 400, body: { error: 'Session is not active' } };
    }
  }

  // Get user's current stage progress
  const progress = await prisma.stageProgress.findFirst({
    where: {
      sessionId,
      userId: user.id,
      status: { in: ['IN_PROGRESS', 'GATE_PENDING'] },
    },
    orderBy: { stage: 'desc' },
  });

  const currentStage = progress?.stage ?? 0;

  let refiningNeedContext: RefiningNeedContext | null = null;
  if (currentStage === 3 && refiningNeedId) {
    const vessel = await prisma.userVessel.findUnique({
      where: { userId_sessionId: { userId: user.id, sessionId } },
      select: { id: true },
    });
    const refiningNeed = vessel
      ? await prisma.identifiedNeed.findFirst({
          where: { id: refiningNeedId, vesselId: vessel.id },
          select: { id: true, need: true, category: true },
        })
      : null;
    if (!refiningNeed) {
      return { admitted: false, status: 400, body: { error: 'Invalid refiningNeedId' } };
    }
    refiningNeedContext = {
      id: refiningNeed.id,
      need: refiningNeed.need,
      category: refiningNeed.category,
    };
  }

  // ===========================================================================
  // Save user message
  // ===========================================================================
  const userMessage = await prisma.message.create({
    data: {
      sessionId,
      senderId: user.id,
      role: 'USER',
      content,
      stage: currentStage,
      refiningNeedId: refiningNeedContext?.id ?? null,
    },
  });
  await touchUserSessionActivity(sessionId, user.id, userMessage.timestamp);
  getShowActivityStatus(user.id)
    .then((showActivityStatus) => {
      if (!showActivityStatus) return;
      return publishSessionEvent(sessionId, 'partner.activity', {
        activeAt: userMessage.timestamp.toISOString(),
      }, user.id);
    })
    .catch((err) =>
      logger.warn(`[sendMessageStream:${requestId}] Failed to publish partner activity:`, err)
    );
  logger.info(`[sendMessageStream:${requestId}] User message created: ${userMessage.id}`);

  // Broadcast to Status Site
  brainService.broadcastMessage(userMessage);

  return {
    admitted: true,
    user,
    sessionId,
    content,
    session,
    progress,
    currentStage,
    refiningNeedContext,
    userMessage,
  };
}
