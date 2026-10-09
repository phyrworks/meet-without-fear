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
 * Stage-specific data (empathy drafts, needs, strategies, agreements) are
 * still fetched via individual endpoints to avoid duplicating complex logic.
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { DEFAULT_PRIVACY_PREFERENCES, ErrorCode, PrivacyPreferencesDTO } from '@meet-without-fear/shared';
import { successResponse, errorResponse } from '../utils/response';
import { getPartnerUserId } from '../utils/session';

const INITIAL_SESSION_MESSAGE_LIMIT = 500;

// ============================================================================
// Types
// ============================================================================

interface CompactGates {
  compactSigned: boolean;
  signedAt?: string;
}

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
      NOT: { invitedById: userId },
      messageConfirmed: true,
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

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });

    await tx.session.update({
      where: { id: sessionId },
      data: { status: 'ACTIVE' },
    });

    await tx.stageProgress.upsert({
      where: { sessionId_userId_stage: { sessionId, userId, stage: 0 } },
      create: { sessionId, userId, stage: 0, status: 'IN_PROGRESS' },
      update: {},
    });

    await tx.userVessel.upsert({
      where: { userId_sessionId: { userId, sessionId } },
      create: { sessionId, userId },
      update: {},
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

    // Fetch core session data in parallel
    const [sessionWithRelations, latestInvitation, linkedInnerThoughts, messages, userVessel] = await Promise.all([
      // 1. Session with all core relations
      prisma.session.findFirst({
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
                select: {
                  userId: true,
                  nickname: true,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      firstName: true,
                    },
                  },
                },
              },
            },
          },
          stageProgress: true,
        },
      }),

      // 1b/1c. Latest invitation and the linked inner-thoughts session, each as its
      // own findFirst rather than a nested `take: 1` include. Prisma 7 no longer
      // pushes a nested to-many `take` into SQL: it reads every matching child row
      // and trims in JS, so the cost grew with the session's history. findFirst
      // emits LIMIT. Both are used only after the session query above has passed
      // the membership check; on a miss they are discarded with it.
      prisma.invitation.findFirst({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.innerWorkSession.findFirst({
        where: {
          linkedPartnerSessionId: sessionId,
          userId: user.id,
          linkedTrigger: 'suggestion_start',
          status: { not: 'ARCHIVED' },
        },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          title: true,
          summary: true,
          theme: true,
          contextSummarySnapshot: true,
        },
      }),

      // 2. Messages (initial page - full practical transcript for this user)
      // Uses data isolation: messages with forUserId only show to that specific user
      prisma.message.findMany({
        where: {
          sessionId,
          OR: [
            // Messages user sent without a specific recipient
            { senderId: user.id, forUserId: null },
            // Messages specifically for this user (AI, SHARED_CONTEXT, EMPATHY_STATEMENT, etc.)
            // EMPATHY_STATEMENT messages have forUserId set to author, so they're included
            // here for the correct user only — never leak partner's empathy statements
            { forUserId: user.id },
          ],
        },
        orderBy: { timestamp: 'desc' },
        take: INITIAL_SESSION_MESSAGE_LIMIT + 1, // Take one extra to check if there are more
      }),

      // 3. User's vessel for this session (for lastSeenChatItemId)
      prisma.userVessel.findUnique({
        where: {
          userId_sessionId: {
            userId: user.id,
            sessionId,
          },
        },
        select: {
          lastViewedAt: true,
          lastActiveAt: true,
          lastSeenChatItemId: true,
        },
      }),
    ]);

    // Check session exists
    if (!sessionWithRelations) {
      const acceptedForE2E = await acceptPendingInvitationForE2ESession(sessionId, user.id);
      if (acceptedForE2E) {
        await getSessionState(req, res);
        return;
      }
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    const session = sessionWithRelations;
    const sourceInnerThoughts = linkedInnerThoughts;
    const partnerId = await getPartnerUserId(sessionId, user.id);

    // Get my membership (for nickname I use for partner)
    const myMember = session.relationship.members.find(m => m.userId === user.id);
    const partnerMember = session.relationship.members.find(m => m.userId !== user.id);

    // Build progress response
    const myProgressRecord = session.stageProgress
      .filter(sp => sp.userId === user.id)
      .sort((a, b) => b.stage - a.stage)[0];
    const partnerProgressRecord = partnerId
      ? session.stageProgress.filter(sp => sp.userId === partnerId).sort((a, b) => b.stage - a.stage)[0]
      : null;

    // Get Stage 1 record for milestones
    const myStage1Record = session.stageProgress.find(sp => sp.userId === user.id && sp.stage === 1);

    const defaultProgress = {
      stage: 0,
      status: 'NOT_STARTED' as const,
      startedAt: null,
      completedAt: null,
      gatesSatisfied: null,
    };

    const myProgress = myProgressRecord
      ? {
          stage: myProgressRecord.stage,
          status: myProgressRecord.status,
          startedAt: myProgressRecord.startedAt?.toISOString() ?? null,
          completedAt: myProgressRecord.completedAt?.toISOString() ?? null,
          gatesSatisfied: myProgressRecord.gatesSatisfied,
        }
      : defaultProgress;

    const partnerProgress = partnerProgressRecord
      ? {
          stage: partnerProgressRecord.stage,
          status: partnerProgressRecord.status,
          startedAt: partnerProgressRecord.startedAt?.toISOString() ?? null,
          completedAt: partnerProgressRecord.completedAt?.toISOString() ?? null,
        }
      : defaultProgress;

    // Extract milestones from Stage 1 gates
    const stage1Gates = myStage1Record?.gatesSatisfied as {
      feelHeardConfirmedAt?: string;
    } | null;
    const milestones = {
      witnessStartedAt: myStage1Record?.startedAt?.toISOString() ?? null,
      feelHeardConfirmedAt: stage1Gates?.feelHeardConfirmedAt ?? null,
    };

    // Partner display name
    const partnerDisplayName = myMember?.nickname || partnerMember?.user.firstName || partnerMember?.user.name || null;
    const partnerVessel = partnerId
      ? await prisma.userVessel.findUnique({
          where: {
            userId_sessionId: {
              userId: partnerId,
              sessionId,
            },
          },
          select: {
            lastViewedAt: true,
            lastActiveAt: true,
          },
        })
      : null;
    const partnerLastMessage = partnerId
      ? await prisma.message.findFirst({
          where: {
            sessionId,
            senderId: partnerId,
            role: 'USER',
          },
          orderBy: { timestamp: 'desc' },
          select: { timestamp: true },
        })
      : null;
    const partnerLastStageProgress = partnerId
      ? await prisma.stageProgress.findFirst({
          where: { sessionId, userId: partnerId },
          orderBy: [
            { completedAt: 'desc' },
            { startedAt: 'desc' },
          ],
          select: {
            startedAt: true,
            completedAt: true,
          },
        })
      : null;
    const partnerPrivacyUser = partnerId
      ? await prisma.user.findUnique({
          where: { id: partnerId },
          select: { privacyPreferences: true } as any,
        })
      : null;
    const partnerPrivacyPreferences = (partnerPrivacyUser as { privacyPreferences?: unknown } | null)?.privacyPreferences as PrivacyPreferencesDTO | null;
    const partnerShowsActivity = (partnerPrivacyPreferences ?? DEFAULT_PRIVACY_PREFERENCES).showActivityStatus;
    const partnerLastActiveAt = partnerShowsActivity ? latestDate(
      partnerVessel?.lastActiveAt,
      partnerLastMessage?.timestamp,
      partnerLastStageProgress?.completedAt,
      partnerLastStageProgress?.startedAt
    ) : null;

    // Build messages response (reverse to chronological order)
    const hasMoreMessages = messages.length > INITIAL_SESSION_MESSAGE_LIMIT;
    const messageSlice = hasMoreMessages ? messages.slice(0, INITIAL_SESSION_MESSAGE_LIMIT) : messages;
    const messagesResponse = {
      messages: messageSlice.reverse().map(m => ({
        id: m.id,
        sessionId: m.sessionId,
        senderId: m.senderId,
        role: m.role,
        content: m.content,
        stage: m.stage,
        timestamp: m.timestamp.toISOString(),
      })),
      hasMore: hasMoreMessages,
      cursor: hasMoreMessages ? messageSlice[0]?.id : undefined,
    };

    // Build invitation response
    const invitation = latestInvitation;
    const isInviter = invitation?.invitedById === user.id;
    const invitationResponse = invitation
      ? {
          id: invitation.id,
          sessionId: invitation.sessionId,
          invitedBy: {
            id: invitation.invitedById,
            name: null as string | null,
          },
          status: invitation.status,
          createdAt: invitation.createdAt.toISOString(),
          expiresAt: invitation.expiresAt.toISOString(),
          messageConfirmed: invitation.messageConfirmed,
          messageConfirmedAt: invitation.messageConfirmedAt?.toISOString() ?? null,
          topicFrame: session.topicFrame ?? null,
          topicFrameConfirmedAt: session.topicFrameConfirmedAt?.toISOString() ?? null,
          acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
          isInviter,
        }
      : null;

    // Build compact status from Stage 0 progress gatesSatisfied
    const myStage0Record = session.stageProgress.find(sp => sp.userId === user.id && sp.stage === 0);
    const partnerStage0Record = partnerId
      ? session.stageProgress.find(sp => sp.userId === partnerId && sp.stage === 0)
      : null;

    const myGates = myStage0Record?.gatesSatisfied as CompactGates | null;
    const partnerGates = partnerStage0Record?.gatesSatisfied as CompactGates | null;

    // Check if this is the first session for this relationship
    const priorResolvedCount = await prisma.session.count({
      where: {
        relationshipId: session.relationshipId,
        id: { not: sessionId },
        status: 'RESOLVED',
      },
    });

    const compactResponse = {
      mySigned: myGates?.compactSigned ?? false,
      mySignedAt: myGates?.signedAt ?? null,
      partnerSigned: partnerGates?.compactSigned ?? false,
      partnerSignedAt: partnerGates?.signedAt ?? null,
      canAdvance: (myGates?.compactSigned ?? false) && ((partnerGates?.compactSigned ?? false) || !partnerId),
      isFirstSession: priorResolvedCount === 0,
    };

    // Return consolidated response
    successResponse(res, {
      // Core session data
      session: {
        id: session.id,
        status: session.status,
        currentStage: myProgress.stage,
        stageStatus: myProgress.status,
        relationshipId: session.relationshipId,
        partner: partnerMember
          ? {
              id: partnerMember.userId,
              name: partnerDisplayName,
              nickname: myMember?.nickname || null,
            }
          : { id: '', name: myMember?.nickname || null, nickname: myMember?.nickname || null },
        myProgress: {
          stage: myProgress.stage,
          status: myProgress.status,
        },
        createdAt: session.createdAt.toISOString(),
        resolvedAt: session.resolvedAt?.toISOString() ?? null,
        lastViewedAt: userVessel?.lastViewedAt?.toISOString() ?? null,
        partnerLastViewedAt: partnerShowsActivity ? partnerVessel?.lastViewedAt?.toISOString() ?? null : null,
        partnerLastActiveAt: partnerLastActiveAt?.toISOString() ?? null,
        lastSeenChatItemId: userVessel?.lastSeenChatItemId ?? null,
        sourceInnerThoughts: sourceInnerThoughts
          ? {
              id: sourceInnerThoughts.id,
              title: sourceInnerThoughts.title,
              summary: sourceInnerThoughts.summary,
              theme: sourceInnerThoughts.theme,
              contextSummarySnapshot: sourceInnerThoughts.contextSummarySnapshot,
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
