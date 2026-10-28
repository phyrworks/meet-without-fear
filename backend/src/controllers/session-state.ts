/**
 * Consolidated Session State Controller
 *
 * Single endpoint that returns core session data in one request.
 * Reduces initial load from 4+ requests to 1 for the base session view.
 *
 * GET /sessions/:id/state
 *
 * Returns:
 * - Session details
 * - Stage progress (both users)
 * - Messages (initial page)
 * - Invitation status
 * - Compact signing status
 *
 * Target shape (TS-9): the caller is `req.participant` (resolved once by
 * `requireSessionAccess`); messages are their MAIN conversation; progress and
 * the compact gate come from `participant_milestone` through the stage shim;
 * the partner is the co-participant from `v_co_participant`. Response shape
 * unchanged.
 */

import { departedParticipantUsers } from '../utils/session';
import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { ErrorCode } from '@meet-without-fear/shared';
import { successResponse, errorResponse } from '../utils/response';
import {
  getCoParticipantPresence,
  getPartnerParticipant,
  resolveParticipant,
  type ResolvedParticipant,
} from '../services/participant-resolver';
import { latestStageRow, loadStageStates, progressDTO, rowForStage } from '../services/stage-shim';
import { listConversationMessages, toMessageDTO } from '../services/message-store';
import { displayStatus, isSessionPaused } from '../services/session-status';

const INITIAL_SESSION_MESSAGE_LIMIT = 500;

function latestDate(...values: Array<Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!latest || value > latest) {
      latest = value;
    }
  }
  return latest;
}

/**
 * E2E only: a pending invitation for this session that the caller did not
 * send is accepted on first read — the caller becomes a participant (with a
 * MAIN conversation and a read state), the session ACTIVE.
 */
async function acceptPendingInvitationForE2ESession(sessionId: string, userId: string): Promise<boolean> {
  if (process.env.E2E_AUTH_BYPASS !== 'true' || process.env.NODE_ENV === 'production') {
    return false;
  }

  const invitation = await prisma.invitation.findFirst({
    where: {
      sessionId,
      status: 'PENDING',
      session: {
        status: 'INVITED',
        topicFrame: { not: null },
        topicFrameConfirmedAt: { not: null },
      },
      invitedByParticipant: { userId: { not: userId } },
      messageConfirmedAt: { not: null },
      expiresAt: { gt: new Date() },
    },
    include: {
      session: { select: { relationshipId: true } },
    },
  });

  if (!invitation) {
    return false;
  }

  await prisma.$transaction(async tx => {
    await tx.relationshipMember.upsert({
      where: {
        relationshipId_userId: {
          relationshipId: invitation.session.relationshipId,
          userId,
        },
      },
      create: {
        relationshipId: invitation.session.relationshipId,
        userId,
      },
      update: {},
    });

    const participant = await tx.participant.upsert({
      where: { sessionId_userId: { sessionId, userId } },
      create: { sessionId, userId, kind: 'human' },
      update: {},
      select: { id: true },
    });
    const main = await tx.conversation.findFirst({ where: { participantId: participant.id, kind: 'MAIN' } });
    if (!main) await tx.conversation.create({ data: { participantId: participant.id, kind: 'MAIN' } });
    await tx.conversationReadState.upsert({
      where: { participantId: participant.id },
      create: { participantId: participant.id },
      update: {},
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedByUserId: userId },
    });

    await tx.session.update({
      where: { id: sessionId },
      data: { status: 'ACTIVE' },
    });
  });

  logger.info('[getSessionState] E2E auto-accepted pending session invitation', {
    sessionId,
    userId,
    invitationId: invitation.id,
  });
  return true;
}

// ============================================================================
// Main Controller
// ============================================================================

/**
 * Get consolidated session state
 * GET /sessions/:id/state
 *
 * Returns core session data in a single request for efficient initial load.
 */
export async function getSessionState(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;

    let participant: ResolvedParticipant | null | undefined = req.participant;
    if (!participant) {
      // The invitee fallback of requireSessionAccess: no participant yet.
      const acceptedForE2E = await acceptPendingInvitationForE2ESession(sessionId, user.id);
      participant = acceptedForE2E ? await resolveParticipant(sessionId, user.id) : null;
      if (participant) req.participant = participant;
    }
    if (!participant || !participant.mainConversationId) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }
    const me = participant;
    const conversationId = participant.mainConversationId;

    // Fetch core session data in parallel
    const [session, latestInvitation, linkedReflection, messages, readState, partner] = await Promise.all([
      prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          relationship: {
            include: {
              members: {
                select: {
                  userId: true,
                  nickname: true,
                  user: { select: { id: true, name: true, firstName: true } },
                },
              },
            },
          },
        },
      }),
      prisma.invitation.findFirst({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        include: { invitedByParticipant: { select: { userId: true } } },
      }),
      // The caller's own reflection linked to this session (Inner Work is
      // private to its author: filtered by the caller's user id).
      prisma.reflection.findFirst({
        where: { linkedSessionId: sessionId, userId: user.id, status: { not: 'ARCHIVED' } },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true, summary: true, theme: true, contextSnapshot: true },
      }),
      // Messages (initial page): the caller's own conversation is the audience.
      listConversationMessages({ conversationId, limit: INITIAL_SESSION_MESSAGE_LIMIT, order: 'desc' }),
      prisma.conversationReadState.findUnique({
        where: { participantId: me.id },
        select: { lastViewedAt: true, lastActiveAt: true, lastSeenMessageId: true },
      }),
      getPartnerParticipant(me.id),
    ]);

    if (!session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    const paused = await isSessionPaused(sessionId);
    const stages = await loadStageStates([
      { id: me.id, joinedAt: me.joinedAt },
      ...(partner ? [{ id: partner.participantId, joinedAt: partner.joinedAt }] : []),
    ]);
    const myState = stages.get(me.id);
    const partnerState = partner ? stages.get(partner.participantId) : undefined;

    // Get my membership (for nickname I use for partner)
    const myMember = session.relationship.members.find(m => m.userId === user.id);
    const partnerMember = session.relationship.members.find(m => m.userId !== user.id);

    const myProgress = progressDTO(myState, { gates: true });
    const partnerProgress = progressDTO(partnerState, { gates: false });

    // Stage 1 milestones (old: the stage-1 StageProgress row and its gates)
    const myStage1 = rowForStage(myState, 1);
    const milestones = {
      witnessStartedAt: myStage1?.startedAt?.toISOString() ?? null,
      feelHeardConfirmedAt: (myStage1?.gatesSatisfied.feelHeardConfirmedAt as string | undefined) ?? null,
    };

    // Partner display name
    // A partner who left (account deletion, leaving) shows no name (TS-12, R5).
    const partnerLeft = !!partnerMember && (await departedParticipantUsers([sessionId])).has(`${sessionId}:${partnerMember.userId}`);
    const partnerDisplayName = partnerLeft
      ? null
      : myMember?.nickname || partnerMember?.user.firstName || partnerMember?.user.name || null;

    const presence = partner ? await getCoParticipantPresence(partner.participantId) : null;
    const partnerShowsActivity = presence?.showsActivity ?? true;
    const partnerLastRow = partnerState ? latestStageRow(partnerState.rows) : null;
    const partnerLastActiveAt = partnerShowsActivity
      ? latestDate(presence?.lastActiveAt, presence?.lastTurnAt, partnerLastRow?.completedAt, partnerLastRow?.startedAt)
      : null;

    // Build messages response (reverse to chronological order)
    const hasMoreMessages = messages.length > INITIAL_SESSION_MESSAGE_LIMIT;
    const messageSlice = hasMoreMessages ? messages.slice(0, INITIAL_SESSION_MESSAGE_LIMIT) : messages;
    const ownerMilestones = myState?.milestones ?? [];
    const messagesResponse = {
      messages: messageSlice.reverse().map(m => toMessageDTO(m, { sessionId, ownerMilestones })),
      hasMore: hasMoreMessages,
      cursor: hasMoreMessages ? messageSlice[0]?.id : undefined,
    };

    // Build invitation response
    const invitation = latestInvitation;
    const invitedByUserId = invitation?.invitedByParticipant.userId ?? null;
    const isInviter = invitedByUserId === user.id;
    const invitationResponse = invitation
      ? {
          id: invitation.id,
          sessionId: invitation.sessionId,
          invitedBy: {
            id: invitedByUserId,
            name: null as string | null,
          },
          status: invitation.status,
          createdAt: invitation.createdAt.toISOString(),
          expiresAt: invitation.expiresAt.toISOString(),
          messageConfirmed: invitation.messageConfirmedAt !== null,
          messageConfirmedAt: invitation.messageConfirmedAt?.toISOString() ?? null,
          topicFrame: session.topicFrame ?? null,
          topicFrameConfirmedAt: session.topicFrameConfirmedAt?.toISOString() ?? null,
          acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
          isInviter,
        }
      : null;

    // Compact status: the stage-0 gates, derived from compact_signed.
    const myGates = rowForStage(myState, 0)?.gatesSatisfied;
    const partnerGates = rowForStage(partnerState, 0)?.gatesSatisfied;
    const mySigned = myGates?.compactSigned === true;
    const partnerSigned = partnerGates?.compactSigned === true;

    // Check if this is the first session for this relationship
    const priorResolvedCount = await prisma.session.count({
      where: {
        relationshipId: session.relationshipId,
        id: { not: sessionId },
        status: 'RESOLVED',
      },
    });

    const compactResponse = {
      mySigned,
      mySignedAt: (myGates?.signedAt as string | undefined) ?? null,
      partnerSigned,
      partnerSignedAt: (partnerGates?.signedAt as string | undefined) ?? null,
      canAdvance: mySigned && (partnerSigned || !partner),
      isFirstSession: priorResolvedCount === 0,
    };

    // Return consolidated response
    successResponse(res, {
      // Core session data
      session: {
        id: session.id,
        status: displayStatus(session.status, paused),
        currentStage: myProgress.stage,
        stageStatus: myProgress.status,
        relationshipId: session.relationshipId,
        partner: partnerMember
          ? {
              id: partnerMember.userId,
              name: partnerDisplayName,
              nickname: partnerLeft ? null : myMember?.nickname || null,
            }
          : { id: '', name: myMember?.nickname || null, nickname: myMember?.nickname || null },
        myProgress: {
          stage: myProgress.stage,
          status: myProgress.status,
        },
        createdAt: session.createdAt.toISOString(),
        resolvedAt: session.resolvedAt?.toISOString() ?? null,
        lastViewedAt: readState?.lastViewedAt?.toISOString() ?? null,
        partnerLastViewedAt: partnerShowsActivity ? (presence?.lastViewedAt?.toISOString() ?? null) : null,
        partnerLastActiveAt: partnerLastActiveAt?.toISOString() ?? null,
        lastSeenChatItemId: readState?.lastSeenMessageId ?? null,
        sourceInnerThoughts: linkedReflection
          ? {
              id: linkedReflection.id,
              title: linkedReflection.title,
              summary: linkedReflection.summary,
              theme: linkedReflection.theme,
              contextSummarySnapshot: linkedReflection.contextSnapshot,
            }
          : null,
      },

      // Stage progress
      progress: {
        sessionId,
        myProgress,
        partnerProgress,
        canAdvance: myProgress.status === 'COMPLETED' || myProgress.stage === 0,
        milestones,
      },

      // Messages (initial page)
      messages: messagesResponse,

      // Stage 0: Invitation and Compact
      invitation: invitationResponse,
      compact: compactResponse,
    });
  } catch (error) {
    logger.error('[getSessionState] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to get session state', 500);
  }
}
