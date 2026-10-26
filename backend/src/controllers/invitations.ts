import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { notifyPartner, notifyPartnerWithFallback, publishSessionCreated } from '../services/realtime';
import { z } from 'zod';
import {
  ApiResponse,
  DEFAULT_PRIVACY_PREFERENCES,
  ErrorCode,
  PrivacyPreferencesDTO,
  SessionStatus,
  StageStatus,
  Stage,
} from '@meet-without-fear/shared';
import { successResponse, errorResponse } from '../utils/response';
import { generateSessionStatusSummary } from '../utils/session';
import { getPartnerParticipant } from '../services/participant-resolver';
import { loadStageStates, progressDTO } from '../services/stage-shim';
import { displayStatus, parseStatusFilter, pausedSessionIds } from '../services/session-status';
import { createInvitationUrl } from '../utils/urls';

// ============================================================================
// Types
// ============================================================================

// Note: AuthenticatedRequest uses the global Express.Request.user type
// defined in middleware/auth.ts via declare global

// ============================================================================
// Validation Schemas
// ============================================================================

const createSessionSchema = z.object({
  personId: z.string().optional(),
  inviteName: z.string().min(1).optional(),
  context: z.string().optional(),
  innerThoughtsId: z.string().optional(),
  linkedAtMessageId: z.string().optional(),
  forceCreate: z.boolean().optional(),
}).refine(
  (data) => data.personId || data.inviteName,
  { message: 'Must provide personId or inviteName' }
);

const declineInvitationSchema = z.object({
  reason: z.string().optional(),
});

const updateNicknameSchema = z.object({
  nickname: z.string().min(1).max(100).nullable(),
});

// ============================================================================
// Controllers
// ============================================================================

/**
 * List user's sessions
 * GET /sessions
 */
export async function listSessions(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { status, limit = '20', cursor } = req.query;
    const takeLimit = parseInt(limit as string, 10);

    // `?status=` onto the target (PAUSED is ACTIVE + a `paused` milestone).
    const filter = parseStatusFilter(status);
    if (filter.kind === 'invalid') {
      errorResponse(res, 'VALIDATION_ERROR', `Unknown session status: ${filter.value}`, 400);
      return;
    }
    const pausedWhere = { some: { leftAt: null, milestones: { some: { milestoneKey: 'paused' } } } };

    // Target shape (TS-9): the list is the caller's participants — one per
    // session — that they have not archived (conversation_read_state).
    const mine = await prisma.participant.findMany({
      where: {
        userId: user.id,
        leftAt: null,
        OR: [{ readState: null }, { readState: { archivedAt: null } }],
        ...(filter.kind === 'status' && {
          session: {
            status: filter.status,
            ...(filter.paused === true ? { participants: pausedWhere } : {}),
            ...(filter.paused === false ? { participants: { none: pausedWhere.some } } : {}),
          },
        }),
      },
      include: {
        session: {
          include: {
            relationship: {
              include: {
                members: {
                  include: { user: { select: { id: true, name: true, firstName: true, email: true } } },
                },
              },
            },
          },
        },
        readState: { select: { lastViewedAt: true, lastSeenMessageId: true } },
      },
      orderBy: { session: { updatedAt: 'desc' } },
      take: takeLimit + 1,
      ...(cursor && { cursor: { sessionId_userId: { sessionId: cursor as string, userId: user.id } }, skip: 1 }),
    });

    const hasMore = mine.length > takeLimit;
    const items = hasMore ? mine.slice(0, -1) : mine;

    // Partners (v_co_participant), progress (stage shim), unread
    // (v_conversation_unread) and Stage 2 directions, for the whole page.
    const partners = new Map(
      await Promise.all(items.map(async p => [p.id, await getPartnerParticipant(p.id)] as const)),
    );
    const stageStates = await loadStageStates([
      ...items.map(p => ({ id: p.id, joinedAt: p.joinedAt })),
      ...[...partners.values()].flatMap(c => (c ? [{ id: c.participantId, joinedAt: c.joinedAt }] : [])),
    ]);
    const ids = items.map(p => p.id);
    const paused = await pausedSessionIds(items.map(p => p.sessionId));
    const unread = ids.length
      ? await prisma.$queryRaw<Array<{ participant_id: string; unread_count: bigint }>>`
          SELECT participant_id, unread_count FROM v_conversation_unread WHERE participant_id = ANY(${ids}::uuid[])`
      : [];
    const unreadOf = new Map(unread.map(u => [u.participant_id, Number(u.unread_count)]));
    // Own attempts directly; the partner's direction only as a content-free
    // status (v_empathy_direction_status, identity-bound).
    const ownAttempts = ids.length
      ? await prisma.empathyAttempt.findMany({
          where: { authorParticipantId: { in: ids }, status: { not: 'SUPERSEDED' } },
          select: { authorParticipantId: true, status: true },
        })
      : [];
    const directions = ids.length
      ? await prisma.$queryRaw<Array<{ author_participant_id: string; subject_participant_id: string; status: string }>>`
          SELECT author_participant_id, subject_participant_id, status::text AS status
          FROM v_empathy_direction_status WHERE subject_participant_id = ANY(${ids}::uuid[])`
      : [];

    const formattedSessions = items.map((me) => {
      const session = me.session;
      const partner = partners.get(me.id) ?? null;
      // Find my membership record (for nickname I use for partner)
      const myMember = session.relationship.members.find(m => m.userId === user.id);
      const partnerMember = session.relationship.members.find(m => m.userId !== user.id);

      const myProgress = progressDTO(stageStates.get(me.id), { gates: false });
      const partnerProgress = progressDTO(partner ? stageStates.get(partner.participantId) : undefined, { gates: false });
      const dto = (p: typeof myProgress) => ({
        stage: p.stage,
        status: p.status,
        startedAt: p.startedAt,
        completedAt: p.completedAt,
      });

      // Compute action needed arrays
      const selfActionNeeded: string[] = [];
      const partnerActionNeeded: string[] = [];

      if (myProgress.status === 'NOT_STARTED') {
        selfActionNeeded.push('complete_stage');
      }

      // If user is in progress, check Stage 2 sub-state to avoid showing
      // "Ready for you" when user is actually waiting on partner/system
      const userEmpathy = ownAttempts.find(a => a.authorParticipantId === me.id);
      const partnerEmpathy = directions.find(d => d.subject_participant_id === me.id);
      if (myProgress.status === 'IN_PROGRESS') {
        if (myProgress.stage === Stage.PERSPECTIVE_STRETCH && (userEmpathy || partnerEmpathy)) {
          const userNeedsToRefine = userEmpathy?.status === 'REFINING';
          const userNeedsToValidate = partnerEmpathy?.status === 'REVEALED';
          const userNeedsToRespondToShare = partnerEmpathy?.status === 'AWAITING_SHARING';
          if (userNeedsToRefine || userNeedsToValidate || userNeedsToRespondToShare) {
            selfActionNeeded.push('complete_stage');
          } else if (!userEmpathy) {
            selfActionNeeded.push('complete_stage');
          }
        } else {
          selfActionNeeded.push('complete_stage');
        }
      }

      if (partnerProgress.status === 'IN_PROGRESS' || partnerProgress.status === 'NOT_STARTED') {
        partnerActionNeeded.push('complete_stage');
      }

      // Nickname (what I call them), then their names.
      const partnerDisplayName = partnerMember
        ? myMember?.nickname || partnerMember.user.firstName || partnerMember.user.name
        : myMember?.nickname || null;

      const sessionStatus = displayStatus(session.status, paused.has(session.id));
      const statusSummary = generateSessionStatusSummary(
        sessionStatus as SessionStatus,
        { ...dto(myProgress), stage: myProgress.stage as Stage, status: myProgress.status as StageStatus },
        { ...dto(partnerProgress), stage: partnerProgress.stage as Stage, status: partnerProgress.status as StageStatus },
        partnerDisplayName || 'Partner',
        { userHasSentEmpathy: !!userEmpathy, partnerHasSentEmpathy: !!partnerEmpathy },
      );

      const lastViewedAt = me.readState?.lastViewedAt ?? null;
      const lastSeenChatItemId = me.readState?.lastSeenMessageId ?? null;

      return {
        id: session.id,
        relationshipId: session.relationshipId,
        status: sessionStatus,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        partner: partnerMember
          ? { id: partnerMember.user.id, name: partnerDisplayName, nickname: myMember?.nickname || null }
          : { id: '', name: partnerDisplayName, nickname: myMember?.nickname || null },
        myProgress: dto(myProgress),
        partnerProgress: dto(partnerProgress),
        statusSummary,
        selfActionNeeded,
        partnerActionNeeded,
        // Unread: messages in my conversation after my last view, not mine.
        hasUnread: (unreadOf.get(me.id) ?? 0) > 0,
        lastViewedAt: lastViewedAt?.toISOString() ?? null,
        lastSeenChatItemId,
      };
    });

    successResponse(res, {
      items: formattedSessions,
      hasMore,
      cursor: hasMore ? items[items.length - 1]?.sessionId : undefined,
    });
  } catch (error) {
    logger.error('[listSessions] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to list sessions', 500);
  }
}

/**
 * Create a new session with an invitation
 * POST /sessions
 */
export async function createSession(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const parseResult = createSessionSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    const {
      personId,
      inviteName,
      innerThoughtsId,
      linkedAtMessageId,
      context,
      forceCreate,
    } = parseResult.data;
    let inviteeDisplayName = inviteName?.trim() || undefined;

    if (personId === user.id) {
      errorResponse(res, 'VALIDATION_ERROR', 'Cannot start a session with yourself', 400);
      return;
    }

    // Create or find relationship
    let relationship;
    if (personId) {
      // Find existing relationship with this person
      const existingMember = await prisma.relationshipMember.findFirst({
        where: {
          userId: personId,
          relationship: {
            members: {
              some: { userId: user.id },
            },
          },
        },
        include: {
          user: {
            select: {
              firstName: true,
              name: true,
            },
          },
          relationship: {
            include: {
              members: {
                where: { userId: user.id },
                select: { nickname: true },
              },
            },
          },
        },
      });

      if (existingMember) {
        relationship = existingMember.relationship;
        inviteeDisplayName =
          inviteeDisplayName ||
          existingMember.relationship.members[0]?.nickname ||
          existingMember.user.firstName ||
          existingMember.user.name ||
          undefined;
      } else {
        const existingUser = await prisma.user.findUnique({
          where: { id: personId },
          select: {
            firstName: true,
            name: true,
          },
        });

        if (!existingUser) {
          errorResponse(res, 'NOT_FOUND', 'Person not found', 404);
          return;
        }

        inviteeDisplayName =
          inviteeDisplayName ||
          existingUser.firstName ||
          existingUser.name ||
          undefined;
      }
    }

    // If no existing relationship, create a new one
    if (!relationship) {
      relationship = await prisma.relationship.create({
        data: {
          members: {
            create: personId
              ? [
                  {
                    userId: user.id,
                    nickname: inviteName || null, // Store what inviter calls the invitee
                  },
                  { userId: personId },
                ]
              : {
                  userId: user.id,
                  nickname: inviteName || null, // Store what inviter calls the invitee
                },
          },
        },
      });
    } else {
      // Update nickname on existing membership if inviteName provided
      if (inviteName) {
        await prisma.relationshipMember.update({
          where: {
            relationshipId_userId: {
              relationshipId: relationship.id,
              userId: user.id,
            },
          },
          data: { nickname: inviteName },
        });
      }
    }

    // Check for existing active session with this person
    const existingActiveSession = await prisma.session.findFirst({
      where: {
        relationshipId: relationship.id,
        status: { in: ['CREATED', 'INVITED', 'ACTIVE', 'PAUSED', 'WAITING'] },
      },
      select: { id: true, status: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (existingActiveSession && !forceCreate) {
      successResponse(res, {
        existingActiveSession: {
          id: existingActiveSession.id,
          status: existingActiveSession.status,
          updatedAt: existingActiveSession.updatedAt.toISOString(),
        },
      });
      return;
    }

    // Create session, invitation, stage progress, and vessels atomically
    const { session, invitation } = await prisma.$transaction(async (tx) => {
      const sess = await tx.session.create({
        data: {
          relationshipId: relationship.id,
          status: 'CREATED',
        },
      });

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const inv = await tx.invitation.create({
        data: {
          sessionId: sess.id,
          invitedById: user.id,
          name: inviteeDisplayName,
          expiresAt,
        },
      });

      await tx.stageProgress.create({
        data: {
          sessionId: sess.id,
          userId: user.id,
          stage: 0,
          status: 'IN_PROGRESS',
        },
      });

      await tx.userVessel.create({
        data: {
          sessionId: sess.id,
          userId: user.id,
        },
      });

      await tx.sharedVessel.create({
        data: {
          sessionId: sess.id,
        },
      });

      return { session: sess, invitation: inv };
    });

    // If originated from Inner Thoughts, link it back (non-critical, outside transaction)
    if (innerThoughtsId) {
      try {
        const validLinkedAtMessage = linkedAtMessageId
          ? await prisma.innerWorkMessage.findFirst({
              where: {
                id: linkedAtMessageId,
                sessionId: innerThoughtsId,
              },
              select: { id: true },
            })
          : null;

        await prisma.innerWorkSession.updateMany({
          where: {
            id: innerThoughtsId,
            userId: user.id,
          },
          data: {
            linkedPartnerSessionId: session.id,
            linkedTrigger: 'suggestion_start',
            ...(validLinkedAtMessage ? { linkedAtMessageId: validLinkedAtMessage.id } : {}),
            ...(context ? { contextSummarySnapshot: context } : {}),
          },
        });
        logger.info(`[createSession] Linked session ${session.id} to origin inner thoughts ${innerThoughtsId}`);
      } catch (err) {
        logger.warn(`[createSession] Failed to link inner thoughts session:`, err);
      }
    }

    // Generate invitation URL (user shares via their own channels)
    const invitationUrl = createInvitationUrl(invitation.id);

    // Note: Initial AI message is now generated via POST /messages/initial
    // when the user first enters the session (fetched by mobile app)

    // Publish to audit stream for monitoring dashboard (non-blocking)
    publishSessionCreated(session.id, {
      type: 'CONFLICT_RESOLUTION',
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      members: [{ userId: user.id, name: user.firstName || user.name || undefined }],
    }).catch(() => {}); // Ignore failures

    successResponse(
      res,
      {
        session: {
          id: session.id,
          status: session.status,
          createdAt: session.createdAt,
          // Include partner info with nickname for immediate display
          partner: {
            id: personId || '',
            name: inviteeDisplayName || null,
            nickname: inviteName || null,
          },
        },
        invitationId: invitation.id,
        invitationUrl,
      },
      201
    );
  } catch (error) {
    logger.error('[createSession] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to create session', 500);
  }
}

/**
 * Get invitation details
 * GET /invitations/:id
 */
export async function getInvitation(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const invitation = await prisma.invitation.findUnique({
      where: { id },
      include: {
        invitedBy: {
          select: {
            id: true,
            name: true,
          },
        },
        session: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!invitation) {
      errorResponse(res, 'NOT_FOUND', 'Invitation not found', 404);
      return;
    }

    // Check if expired
    const isExpired = new Date() > invitation.expiresAt;
    const status = isExpired && invitation.status === 'PENDING' ? 'EXPIRED' : invitation.status;

    successResponse(res, {
      invitation: {
        id: invitation.id,
        invitedBy: {
          name: invitation.invitedBy.name,
        },
        name: invitation.name,
        status,
        createdAt: invitation.createdAt,
        expiresAt: invitation.expiresAt,
        session: {
          id: invitation.session.id,
          status: invitation.session.status,
        },
      },
    });
  } catch (error) {
    logger.error('[getInvitation] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get invitation', 500);
  }
}

/**
 * Accept an invitation and join the session
 * POST /invitations/:id/accept
 */
export async function acceptInvitation(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id } = req.params;

    const invitation = await prisma.invitation.findUnique({
      where: { id },
      include: {
        session: true,
        invitedBy: {
          select: { id: true, name: true },
        },
      },
    });

    if (!invitation) {
      errorResponse(res, 'NOT_FOUND', 'Invitation not found', 404);
      return;
    }

    // Prevent self-acceptance
    if (invitation.invitedById === user.id) {
      errorResponse(res, 'VALIDATION_ERROR', 'Cannot accept your own invitation', 400);
      return;
    }

    // Check if already processed
    if (invitation.status !== 'PENDING') {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Invitation has already been ${invitation.status.toLowerCase()}`,
        400
      );
      return;
    }

    // Check if expired
    if (new Date() > invitation.expiresAt) {
      await prisma.invitation.update({
        where: { id },
        data: { status: 'EXPIRED' },
      });
      errorResponse(res, 'EXPIRED', 'Invitation has expired', 410);
      return;
    }

    if (
      invitation.session.status !== 'INVITED' ||
      !invitation.messageConfirmed ||
      !invitation.session.topicFrame ||
      !invitation.session.topicFrameConfirmedAt
    ) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invitation is not ready to accept', 400);
      return;
    }

    const acceptingUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { privacyPreferences: true } as any,
    });
    const privacyPreferences = ((acceptingUser as { privacyPreferences?: unknown } | null)?.privacyPreferences as PrivacyPreferencesDTO | null) ?? DEFAULT_PRIVACY_PREFERENCES;
    if (!privacyPreferences.allowSessionInvites) {
      errorResponse(res, 'VALIDATION_ERROR', 'You have disabled session invitations in Privacy settings', 403);
      return;
    }

    // Accept invitation, activate session, create stage progress + vessel atomically
    await prisma.$transaction(async (tx) => {
      // Join the relationship
      const existingMembership = await tx.relationshipMember.findUnique({
        where: {
          relationshipId_userId: {
            relationshipId: invitation.session.relationshipId,
            userId: user.id,
          },
        },
      });

      if (!existingMembership) {
        await tx.relationshipMember.create({
          data: {
            relationshipId: invitation.session.relationshipId,
            userId: user.id,
          },
        });
      }

      await tx.invitation.update({
        where: { id },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
      });

      await tx.session.update({
        where: { id: invitation.sessionId },
        data: { status: 'ACTIVE' },
      });

      await tx.stageProgress.create({
        data: {
          sessionId: invitation.sessionId,
          userId: user.id,
          stage: 0,
          status: 'IN_PROGRESS',
        },
      });

      await tx.userVessel.create({
        data: {
          sessionId: invitation.sessionId,
          userId: user.id,
        },
      });
    });

    // Get session summary for response
    const session = await prisma.session.findUnique({
      where: { id: invitation.sessionId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        relationship: {
          select: {
            id: true,
            members: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Notify inviter via realtime that partner joined
    // Use notifyPartnerWithFallback to ensure Ably message is always published
    // and push is sent if user is offline
    await notifyPartnerWithFallback(invitation.sessionId, invitation.invitedById, 'session.joined', {
      joinedBy: user.id,
      userId: user.id,
      userName: user.name,
    });

    successResponse(res, {
      session: {
        id: session?.id,
        status: session?.status,
        createdAt: session?.createdAt,
        members: session?.relationship.members.map((m) => ({
          id: m.user.id,
          name: m.user.name,
        })),
      },
    });
  } catch (error) {
    logger.error('[acceptInvitation] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to accept invitation', 500);
  }
}

/**
 * Decline an invitation
 * POST /invitations/:id/decline
 */
export async function declineInvitation(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id } = req.params;

    const parseResult = declineInvitationSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    const { reason } = parseResult.data;

    const invitation = await prisma.invitation.findUnique({
      where: { id },
    });

    if (!invitation) {
      errorResponse(res, 'NOT_FOUND', 'Invitation not found', 404);
      return;
    }

    // Check if already processed
    if (invitation.status !== 'PENDING') {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Invitation has already been ${invitation.status.toLowerCase()}`,
        400
      );
      return;
    }

    // Update invitation status
    await prisma.invitation.update({
      where: { id },
      data: {
        status: 'DECLINED',
        declinedAt: new Date(),
        declineReason: reason,
      },
    });

    // Update session status to indicate abandonment
    await prisma.session.update({
      where: { id: invitation.sessionId },
      data: { status: 'ABANDONED' },
    });

    // Notify inviter via realtime that invitation was declined
    await notifyPartner(invitation.sessionId, invitation.invitedById, 'invitation.declined', {
      reason,
    });

    successResponse(res, { declined: true });
  } catch (error) {
    logger.error('[declineInvitation] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to decline invitation', 500);
  }
}

/**
 * List people the user has relationships with
 * GET /people
 */
export async function listPeople(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    // Find all relationships where user is a member
    const memberships = await prisma.relationshipMember.findMany({
      where: { userId: user.id },
      include: {
        relationship: {
          include: {
            members: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
            sessions: {
              orderBy: { updatedAt: 'desc' },
              select: {
                id: true,
                status: true,
                updatedAt: true,
              },
            },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    // Transform to person DTOs
    const people = memberships
      .map((membership) => {
        // Find the partner (the other member in the relationship)
        const partnerMember = membership.relationship.members.find(
          (m) => m.userId !== user.id
        );

        // Skip if no partner yet (invitation not accepted)
        if (!partnerMember) return null;

        const sessions = membership.relationship.sessions;
        const latestSession = sessions[0];

        // Count active (non-terminal) sessions
        const ACTIVE_STATUSES = ['CREATED', 'INVITED', 'ACTIVE', 'PAUSED', 'WAITING'];
        const activeSessionCount = sessions.filter(
          (s) => ACTIVE_STATUSES.includes(s.status)
        ).length;

        // Compute display name: nickname I gave them > their first name > their full name
        const displayName = membership.nickname ||
          partnerMember.user.firstName ||
          partnerMember.user.name ||
          'Unknown';

        // Generate initials
        const initials = displayName
          .split(' ')
          .map((n) => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2);

        return {
          id: partnerMember.userId,
          relationshipId: membership.relationshipId,
          name: displayName,
          nickname: membership.nickname,
          initials,
          connectedSince: membership.joinedAt.toISOString(),
          lastSession: latestSession
            ? {
                id: latestSession.id,
                status: latestSession.status,
                updatedAt: latestSession.updatedAt.toISOString(),
              }
            : null,
          activeSessionCount,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    successResponse(res, { people });
  } catch (error) {
    logger.error('[listPeople] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to list people', 500);
  }
}

/**
 * Archive a session
 * POST /sessions/:id/archive
 */
export async function archiveSession(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id } = req.params;

    // Find the session and verify user has access
    const session = await prisma.session.findFirst({
      where: {
        id,
        relationship: {
          members: {
            some: { userId: user.id },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Only allow archiving of sessions that are RESOLVED, ABANDONED, CREATED, or INVITED
    const archivableStatuses = ['RESOLVED', 'ABANDONED', 'CREATED', 'INVITED'];
    if (!archivableStatuses.includes(session.status)) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Only resolved, abandoned, or pending sessions can be archived',
        400
      );
      return;
    }

    // Update session status to ARCHIVED
    const updatedSession = await prisma.session.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });

    successResponse(res, {
      archived: true,
      archivedAt: updatedSession.updatedAt.toISOString(),
    });
  } catch (error) {
    logger.error('[archiveSession] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to archive session', 500);
  }
}

/**
 * Update nickname for partner in a relationship
 * PATCH /relationships/:relationshipId/nickname
 */
export async function updateNickname(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { relationshipId } = req.params;

    const parseResult = updateNicknameSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }

    const { nickname } = parseResult.data;

    // Verify user is a member of this relationship
    const member = await prisma.relationshipMember.findUnique({
      where: {
        relationshipId_userId: {
          relationshipId,
          userId: user.id,
        },
      },
    });

    if (!member) {
      errorResponse(res, 'NOT_FOUND', 'Relationship not found', 404);
      return;
    }

    // Update the nickname
    const updatedMember = await prisma.relationshipMember.update({
      where: { id: member.id },
      data: { nickname },
    });

    successResponse(res, {
      nickname: updatedMember.nickname,
    });
  } catch (error) {
    logger.error('[updateNickname] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to update nickname', 500);
  }
}

/**
 * Acknowledge a pending invitation (creates notification if not exists)
 * POST /invitations/:id/acknowledge
 *
 * Called when a user views a pending invitation (e.g., from home screen).
 * Creates a notification for the user so they can see the invitation in their inbox.
 * Idempotent - won't create duplicate notifications.
 */
export async function acknowledgeInvitation(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id } = req.params;

    // Get invitation details
    const invitation = await prisma.invitation.findUnique({
      where: { id },
      include: {
        invitedBy: {
          select: {
            id: true,
            name: true,
            firstName: true,
          },
        },
        session: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });

    if (!invitation) {
      errorResponse(res, 'NOT_FOUND', 'Invitation not found', 404);
      return;
    }

    // Can't acknowledge your own invitation
    if (invitation.invitedById === user.id) {
      errorResponse(res, 'VALIDATION_ERROR', 'Cannot acknowledge your own invitation', 400);
      return;
    }

    // Check if expired
    const isExpired = new Date() > invitation.expiresAt;
    if (isExpired || invitation.status !== 'PENDING') {
      // Return the invitation status but don't create notification
      successResponse(res, {
        acknowledged: false,
        reason: isExpired ? 'expired' : invitation.status.toLowerCase(),
        invitation: {
          id: invitation.id,
          status: isExpired ? 'EXPIRED' : invitation.status,
          invitedBy: {
            id: invitation.invitedBy.id,
            name: invitation.invitedBy.firstName || invitation.invitedBy.name,
          },
        },
      });
      return;
    }

    successResponse(res, {
      acknowledged: true,
      invitation: {
        id: invitation.id,
        status: invitation.status,
        invitedBy: {
          id: invitation.invitedBy.id,
          name: invitation.invitedBy.firstName || invitation.invitedBy.name,
        },
        session: {
          id: invitation.session.id,
          status: invitation.session.status,
        },
        expiresAt: invitation.expiresAt.toISOString(),
      },
    });
  } catch (error) {
    logger.error('[acknowledgeInvitation] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to acknowledge invitation', 500);
  }
}

/**
 * Delete a session for the current user
 * DELETE /sessions/:id
 *
 * This removes the user's data from the session but leaves the session
 * available for the partner. The partner keeps access to their own data
 * and any content that was shared.
 */
export async function deleteSession(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id } = req.params;

    // Import the deletion service
    const { deleteSessionForUser } = await import('../services/session-deletion');

    // Get user display name for notifications
    const displayName = user.firstName || user.name || 'Your partner';

    // Perform the deletion
    const summary = await deleteSessionForUser(id, user.id, displayName);

    successResponse(res, {
      deleted: true,
      summary,
    });
  } catch (error) {
    logger.error('[deleteSession] Error:', error);
    if (error instanceof Error && error.message === 'Session not found or access denied') {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to delete session', 500);
  }
}
