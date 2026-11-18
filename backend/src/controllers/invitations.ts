import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { readPreferences } from '../services/user-settings';
import { notifyPartner, notifyPartnerWithFallback, publishSessionCreated } from '../services/realtime';
import { z } from 'zod';
import { SessionStatus, StageStatus, Stage } from '@meet-without-fear/shared';
import { successResponse, errorResponse } from '../utils/response';
import { getPgSqlState } from '../middleware/errors';
import { generateSessionStatusSummary, departedParticipantUsers, FORMER_PARTICIPANT_NAME } from '../utils/session';
import { getPartnerParticipant } from '../services/participant-resolver';
import { loadStageStates, progressDTO } from '../services/stage-shim';
import { displayStatus, parseStatusFilter, pausedSessionIds } from '../services/session-status';
import { createInvitationUrl } from '../utils/urls';
import { reachInvitationSentOnAccept } from '../services/milestone-writer';
import { repointInvitationDrafts } from '../services/empathy-store';
import { answerInvitation, peekInvitation } from '../services/invitation-peek';
import { lastSeenMessageIdOf } from '../services/message-store';
import {
  LIVE_SESSION_EXISTS_MESSAGE,
  findLiveSessionWith,
  getNickname,
  isLiveSessionPairViolation,
  loadSessionPartners,
  namesIGave,
  pendingInviteeNames,
  setNickname,
  sharesASession,
} from '../services/contacts';

// ============================================================================
// Types
// ============================================================================

// Note: AuthenticatedRequest uses the global Express.Request.user type
// defined in middleware/auth.ts via declare global

// ============================================================================
// Validation Schemas
// ============================================================================

const createSessionSchema = z
  .object({
    personId: z.string().optional(),
    inviteName: z.string().min(1).optional(),
    context: z.string().optional(),
    innerThoughtsId: z.string().optional(),
    linkedAtMessageId: z.string().optional(),
    forceCreate: z.boolean().optional(),
  })
  .refine(data => data.personId || data.inviteName, { message: 'Must provide personId or inviteName' });

const declineInvitationSchema = z.object({
  reason: z.string().optional(),
});

const updateNicknameSchema = z.object({
  // Trimmed: a blank nickname is refused here as the user_contact CHECK would (review round 1, F8).
  nickname: z.string().trim().min(1).max(100).nullable(),
});

/** A path user id must be a uuid before it reaches a uuid7 column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        session: true,
        readState: { select: { lastViewedAt: true, lastSeenConversationId: true, lastSeenSeq: true } },
      },
      orderBy: { session: { updatedAt: 'desc' } },
      take: takeLimit + 1,
      ...(cursor && { cursor: { sessionId_userId: { sessionId: cursor as string, userId: user.id } }, skip: 1 }),
    });

    const hasMore = mine.length > takeLimit;
    const items = hasMore ? mine.slice(0, -1) : mine;

    // Each session's other human and the caller's own nickname for them
    // (user_contact; work-k5fk.2, no relationship), for the whole page.
    const sessionPartners = await loadSessionPartners(
      items.map(p => p.sessionId),
      user.id,
    );

    // Partners (v_co_participant), progress (stage shim), unread
    // (v_conversation_unread) and Stage 2 directions, for the whole page.
    // Every item is the caller's one participant of its session, so these are keyed by session.
    const partners = new Map(
      await Promise.all(items.map(async p => [p.sessionId, await getPartnerParticipant(p)] as const)),
    );
    const stageStates = await loadStageStates([
      ...items.map(p => ({ sessionId: p.sessionId, userId: p.userId, joinedAt: p.joinedAt })),
      ...[...partners.entries()].flatMap(([sessionId, c]) =>
        c ? [{ sessionId, userId: c.userId, joinedAt: c.joinedAt }] : [],
      ),
    ]);
    const sessionIds = items.map(p => p.sessionId);
    const paused = await pausedSessionIds(sessionIds);
    const unread = sessionIds.length
      ? await prisma.$queryRaw<Array<{ session_id: string; unread_count: bigint }>>`
          SELECT session_id, unread_count FROM v_conversation_unread
          WHERE user_id = ${user.id}::uuid AND session_id = ANY(${sessionIds}::uuid[])`
      : [];
    const unreadOf = new Map(unread.map(u => [u.session_id, Number(u.unread_count)]));
    // Own attempts directly; the partner's direction only as a content-free
    // status (v_empathy_direction_status, identity-bound).
    const ownAttempts = sessionIds.length
      ? await prisma.empathyAttempt.findMany({
          where: { sessionId: { in: sessionIds }, authorUserId: user.id, status: { not: 'SUPERSEDED' } },
          select: { sessionId: true, status: true },
        })
      : [];
    const directions = sessionIds.length
      ? await prisma.$queryRaw<Array<{ session_id: string; status: string }>>`
          SELECT session_id, status::text AS status
          FROM v_empathy_direction_status
          WHERE subject_user_id = ${user.id}::uuid AND session_id = ANY(${sessionIds}::uuid[])`
      : [];

    // Partners who left (account deletion, leaving) show no name (TS-12, R5).
    const departed = await departedParticipantUsers(items.map(p => p.sessionId));
    // Before the invitee joins there is no partner: the inviter's name for them is on their invitation.
    const inviteeNames = await pendingInviteeNames(
      items.filter(p => !sessionPartners.get(p.sessionId)).map(p => p.sessionId),
      user.id,
    );

    const formattedSessions = items.map(me => {
      const session = me.session;
      const partner = partners.get(me.sessionId) ?? null;
      // The other human, and what I call them (my user_contact entry)
      const partnerMember = sessionPartners.get(session.id) ?? null;
      const myNickname = partnerMember?.nickname ?? null;

      const myProgress = progressDTO(stageStates.get(me), { milestones: 'none' });
      const partnerProgress = progressDTO(
        partner ? stageStates.get({ sessionId: me.sessionId, userId: partner.userId }) : undefined,
        {
          milestones: 'none',
        },
      );
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
      const userEmpathy = ownAttempts.find(a => a.sessionId === me.sessionId);
      const partnerEmpathy = directions.find(d => d.session_id === me.sessionId);
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

      // Nickname (what I call them), then their names — none for a partner who left.
      const partnerLeft = !!partnerMember && departed.has(`${session.id}:${partnerMember.userId}`);
      const partnerDisplayName = partnerLeft
        ? null
        : partnerMember
          ? myNickname || partnerMember.firstName || partnerMember.name
          : inviteeNames.get(session.id) || null;

      const sessionStatus = displayStatus(session.status, paused.has(session.id));
      const statusSummary = generateSessionStatusSummary(
        sessionStatus as SessionStatus,
        { ...dto(myProgress), stage: myProgress.stage as Stage, status: myProgress.status as StageStatus },
        {
          ...dto(partnerProgress),
          stage: partnerProgress.stage as Stage,
          status: partnerProgress.status as StageStatus,
        },
        partnerLeft ? FORMER_PARTICIPANT_NAME : partnerDisplayName || 'Partner',
        { userHasSentEmpathy: !!userEmpathy, partnerHasSentEmpathy: !!partnerEmpathy },
      );

      const lastViewedAt = me.readState?.lastViewedAt ?? null;
      const lastSeenChatItemId = lastSeenMessageIdOf(me.readState);

      return {
        id: session.id,
        status: sessionStatus,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        partner: partnerMember
          ? {
              id: partnerMember.userId,
              name: partnerDisplayName,
              nickname: partnerLeft ? null : myNickname,
            }
          : { id: '', name: partnerDisplayName, nickname: inviteeNames.get(session.id) || null },
        myProgress: dto(myProgress),
        partnerProgress: dto(partnerProgress),
        statusSummary,
        selfActionNeeded,
        partnerActionNeeded,
        // Unread: messages in my conversation after my last view, not mine.
        hasUnread: (unreadOf.get(me.sessionId) ?? 0) > 0,
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

    const { personId, inviteName, innerThoughtsId, linkedAtMessageId, context, forceCreate } = parseResult.data;
    let inviteeDisplayName = inviteName?.trim() || undefined;

    if (personId === user.id) {
      errorResponse(res, 'VALIDATION_ERROR', 'Cannot start a session with yourself', 400);
      return;
    }

    // work-k5fk.2: no relationship. A known person must exist; what the
    // inviter calls them is the inviter's own user_contact entry, else the
    // name they last went by in a session the two shared
    // (participant.display_name — never the other user's own row, spec §7).
    if (personId) {
      const existingUser = await prisma.user.findFirst({
        where: { id: personId, deletedAt: null, kind: 'human' },
        select: { id: true },
      });
      if (!existingUser) {
        errorResponse(res, 'NOT_FOUND', 'Person not found', 404);
        return;
      }
      const lastShared = await prisma.participant.findFirst({
        where: {
          userId: personId,
          displayName: { not: null },
          session: { participants: { some: { userId: user.id } } },
        },
        orderBy: { joinedAt: 'desc' },
        select: { displayName: true },
      });
      inviteeDisplayName =
        inviteeDisplayName || (await getNickname(user.id, personId)) || lastShared?.displayName || undefined;

      // The invite-time pre-check (owner decision Q3): one live session per
      // pair of humans is live_session_pair's key, which the database enforces
      // when the second human joins. Asked here so the inviter hears it now.
      const existingActiveSession = await findLiveSessionWith(user.id, personId);
      if (existingActiveSession) {
        if (forceCreate) {
          errorResponse(res, 'CONFLICT', LIVE_SESSION_EXISTS_MESSAGE, 409, {
            existingActiveSession: { id: existingActiveSession.id, status: existingActiveSession.status },
          });
          return;
        }
        successResponse(res, {
          existingActiveSession: {
            id: existingActiveSession.id,
            status: existingActiveSession.status,
            updatedAt: existingActiveSession.updatedAt.toISOString(),
          },
        });
        return;
      }
    }

    // Create the session, the inviter's participant (with its MAIN
    // conversation and read state) and the invitation atomically. The inviter
    // is in stage 0 from joined_at (stage shim: a present participant with no
    // milestones); invitation_sent is reached when the inviter confirms the
    // invitation message (sessions.ts confirmInvitationMessage).
    const { session, invitation } = await prisma.$transaction(async tx => {
      const sess = await tx.session.create({
        data: { status: 'CREATED' },
      });
      // A known person's invite name is the inviter's own nickname for them (written with the session, so a failed
      // create leaves no nickname behind).
      const nickname = inviteName?.trim().slice(0, 100);
      if (personId && nickname) await setNickname(user.id, personId, nickname, tx);

      await tx.participant.create({
        data: {
          sessionId: sess.id,
          userId: user.id,
          kind: 'human',
          // The initiator: the one participant nobody added (work-k5fk.2)
          addedByUserId: null,
          // The only user fact a co-participant sees (spec §7)
          displayName: user.name || user.firstName || null,
        },
        select: { sessionId: true },
      });
      const seat = { sessionId: sess.id, userId: user.id };
      await tx.conversation.create({ data: { ...seat, kind: 'MAIN' } });
      await tx.conversationReadState.create({ data: { ...seat } });

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const inv = await tx.invitation.create({
        data: {
          sessionId: sess.id,
          invitedByUserId: user.id,
          inviteeName: inviteeDisplayName,
          expiresAt,
        },
      });

      return { session: sess, invitation: inv };
    });

    // If originated from Inner Thoughts, link it back (non-critical, outside transaction)
    if (innerThoughtsId) {
      try {
        // The caller's own reflection (spec §1.6: linked_session_id is context
        // only; the branching message and the trigger are not carried).
        void linkedAtMessageId;
        await prisma.reflection.updateMany({
          where: {
            id: innerThoughtsId,
            userId: user.id,
          },
          data: {
            linkedSessionId: session.id,
            linkedAt: new Date(),
            ...(context ? { contextSnapshot: context } : {}),
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
      201,
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

    // The invitee is no participant yet: app.invitation_peek (work-k5fk.10.7). The inviter as the
    // invitee sees them: their participant's display name.
    const invitation = await peekInvitation(id);

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
          name: invitation.inviterDisplayName,
        },
        name: invitation.inviteeName,
        status,
        createdAt: invitation.createdAt,
        expiresAt: invitation.expiresAt,
        session: {
          id: invitation.sessionId,
          status: invitation.sessionStatus,
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

    // Before accepting, the invitee is no participant: app.invitation_peek (work-k5fk.10.7).
    const invitation = await peekInvitation(id);

    if (!invitation) {
      errorResponse(res, 'NOT_FOUND', 'Invitation not found', 404);
      return;
    }
    const inviterUserId = invitation.invitedByUserId;

    // Prevent self-acceptance
    if (inviterUserId === user.id) {
      errorResponse(res, 'VALIDATION_ERROR', 'Cannot accept your own invitation', 400);
      return;
    }

    // Check if already processed
    if (invitation.status !== 'PENDING') {
      errorResponse(res, 'VALIDATION_ERROR', `Invitation has already been ${invitation.status.toLowerCase()}`, 400);
      return;
    }

    // Check if expired
    const now = new Date();
    if (now > invitation.expiresAt) {
      // The inviter's row, written for the invitee: app.invitation_answer (work-k5fk.10.7).
      await answerInvitation(prisma, id, 'EXPIRED', now);
      errorResponse(res, 'EXPIRED', 'Invitation has expired', 410);
      return;
    }

    if (invitation.sessionStatus !== 'INVITED' || !invitation.messageConfirmedAt || !invitation.topicFrameConfirmed) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invitation is not ready to accept', 400);
      return;
    }

    // user_preferences.doc.privacy (spec §1.7)
    const privacyPreferences = (await readPreferences(user.id)).privacy;
    if (!privacyPreferences.allowSessionInvites) {
      errorResponse(res, 'VALIDATION_ERROR', 'You have disabled session invitations in Privacy settings', 403);
      return;
    }

    const acceptedAt = new Date();

    // Accept the invitation, join as a participant (with a MAIN conversation
    // and read state), and activate the session — atomically. ACTIVE goes
    // through app.session_set_status (the sole writer; identity-bound: the new
    // participant row makes the caller a member in this transaction), and the
    // deferred T-cardinality-1 checks two participants at COMMIT.
    await prisma.$transaction(async tx => {
      // work-99k2: first, the invitation FOR UPDATE — a concurrent pre-join
      // empathy draft save (FOR SHARE) commits before the move below reads the
      // drafts, or runs after this commits and writes against the participant.
      // app.invitation_answer takes that lock and records the accept (the
      // inviter's row, written for the invitee: a definer, work-k5fk.10.7).
      // work-k5fk.2 (review Q1): nothing is written for the inviter here. What
      // they call the invitee is resolved when they read it: their own
      // user_contact nickname, else this invitation's invitee_name once it is
      // accepted_by the invitee (services/contacts.ts namesIGave).
      await answerInvitation(tx, id, 'ACCEPTED', acceptedAt);

      // The inviter added the invitee (work-k5fk.2). The join is where the
      // database applies the pair rule: a second live session of these two
      // humans fails here with unique_violation (live_session_pair_pkey).
      await tx.participant.create({
        data: {
          sessionId: invitation.sessionId,
          userId: user.id,
          kind: 'human',
          addedByUserId: inviterUserId,
          displayName: user.name || user.firstName || null,
        },
        select: { sessionId: true },
      });
      const seat = { sessionId: invitation.sessionId, userId: user.id };
      await tx.conversation.create({ data: { ...seat, kind: 'MAIN' } });
      await tx.conversationReadState.create({ data: { ...seat } });
      // work-99k2: the inviter's empathy draft written before this join is
      // about the invitation; it becomes about the new participant (the
      // invitee's seat) here, in the same transaction. Nothing is sent: the
      // inviter reviews it first.
      await repointInvitationDrafts(tx, id, seat);

      await tx.$executeRaw`SELECT app.session_set_status(${invitation.sessionId}::uuid, 'ACTIVE'::session_status)`;
    });

    // An accepted invitation was necessarily sent: the inviter's stage 0 ends here even if their app
    // never called POST /invitation/confirm (work-qmgc).
    await reachInvitationSentOnAccept({ sessionId: invitation.sessionId, userId: inviterUserId }, acceptedAt);

    // Get session summary for response
    const session = await prisma.session.findUnique({
      where: { id: invitation.sessionId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        participants: {
          where: { kind: 'human', leftAt: null },
          orderBy: { joinedAt: 'asc' },
          select: { userId: true, displayName: true },
        },
      },
    });

    // Notify inviter via realtime that partner joined
    // Use notifyPartnerWithFallback to ensure Ably message is always published
    // and push is sent if user is offline
    if (inviterUserId) {
      await notifyPartnerWithFallback(invitation.sessionId, inviterUserId, 'session.joined', {
        joinedBy: user.id,
        userId: user.id,
        userName: user.name,
      });
    }

    successResponse(res, {
      session: {
        id: session?.id,
        status: session?.status,
        createdAt: session?.createdAt,
        // The session's members as each other sees them (participant display names)
        members: session?.participants.map(m => ({
          id: m.userId,
          name: m.displayName,
        })),
      },
    });
  } catch (error) {
    if (isLiveSessionPairViolation(error)) {
      // The pair rule (work-k5fk.2): these two already share a live session.
      errorResponse(res, 'CONFLICT', LIVE_SESSION_EXISTS_MESSAGE, 409);
      return;
    }
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

    // Before answering, the invitee is no participant: app.invitation_peek (work-k5fk.10.7).
    const invitation = await peekInvitation(id);

    if (!invitation) {
      errorResponse(res, 'NOT_FOUND', 'Invitation not found', 404);
      return;
    }
    const inviterUserId = invitation.invitedByUserId;

    // The inviter cannot decline their own invitation
    if (inviterUserId === user.id) {
      errorResponse(res, 'VALIDATION_ERROR', 'Cannot decline your own invitation', 400);
      return;
    }

    // Check if already processed
    if (invitation.status !== 'PENDING') {
      errorResponse(res, 'VALIDATION_ERROR', `Invitation has already been ${invitation.status.toLowerCase()}`, 400);
      return;
    }

    // Update invitation status: the inviter's row, written for the invitee (app.invitation_answer, work-k5fk.10.7)
    await answerInvitation(prisma, id, 'DECLINED', new Date(), reason ?? null);

    // The session ends (INVITED/CREATED → ABANDONED). The decliner is no participant, so
    // app.session_abandon_declined moves it on the strength of the DECLINED invitation just
    // written (work-k5fk.10.5: was the job's session_set_status, R35).
    await prisma.$executeRaw`SELECT app.session_abandon_declined(${id}::uuid)`;

    // Notify inviter via realtime that invitation was declined
    if (inviterUserId) {
      await notifyPartner(invitation.sessionId, inviterUserId, 'invitation.declined', {
        reason,
      });
    }

    successResponse(res, { declined: true });
  } catch (error) {
    logger.error('[declineInvitation] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to decline invitation', 500);
  }
}

/**
 * List the people the user shares a session with (work-k5fk.2: no relationship)
 * GET /people
 */
export async function listPeople(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    // work-k5fk.2: the people are the other humans the caller shares a
    // session with (participant), named by the caller's own nickname
    // (user_contact). A tombstone (spec §4 walk step 6) is not a person.
    const mine = await prisma.participant.findMany({
      where: { userId: user.id },
      orderBy: { joinedAt: 'asc' },
      select: {
        joinedAt: true,
        session: {
          select: {
            id: true,
            status: true,
            updatedAt: true,
            participants: {
              where: { kind: 'human', userId: { not: user.id } },
              select: {
                userId: true,
                user: { select: { id: true, name: true, firstName: true, deletedAt: true } },
              },
            },
          },
        },
      },
    });
    type Person = {
      userId: string;
      firstName: string | null;
      name: string | null;
      connectedSince: Date;
      sessions: Array<{ id: string; status: string; updatedAt: Date }>;
    };
    const byPerson = new Map<string, Person>();
    for (const p of mine) {
      for (const o of p.session.participants) {
        if (!o.userId || !o.user || o.user.deletedAt) continue;
        const entry = byPerson.get(o.userId) ?? {
          userId: o.userId,
          firstName: o.user.firstName,
          name: o.user.name,
          connectedSince: p.joinedAt,
          sessions: [],
        };
        entry.sessions.push({ id: p.session.id, status: p.session.status, updatedAt: p.session.updatedAt });
        byPerson.set(o.userId, entry);
      }
    }
    // What I call each of them (my user_contact nickname, else the invite name they accepted).
    const nicknames = await namesIGave(user.id, [...byPerson.keys()]);

    const ACTIVE_STATUSES = ['CREATED', 'INVITED', 'ACTIVE', 'PAUSED', 'WAITING'];
    const people = [...byPerson.values()]
      .map(person => {
        const sessions = [...person.sessions].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        const latestSession = sessions[0];
        const activeSessionCount = sessions.filter(s => ACTIVE_STATUSES.includes(s.status)).length;
        const nickname = nicknames.get(person.userId) ?? null;
        // Compute display name: nickname I gave them > their first name > their full name
        const displayName = nickname || person.firstName || person.name || 'Unknown';
        const initials = displayName
          .split(' ')
          .map(n => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2);
        return {
          id: person.userId,
          name: displayName,
          nickname,
          initials,
          connectedSince: person.connectedSince.toISOString(),
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
      .sort((a, b) => (b.lastSession?.updatedAt ?? '').localeCompare(a.lastSession?.updatedAt ?? ''));

    successResponse(res, { people });
  } catch (error) {
    logger.error('[listPeople] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to list people', 500);
  }
}

/**
 * Archive a session
 * POST /sessions/:id/archive
 *
 * Through app.session_archive (work-k5fk.10.12), identity-bound on the app
 * connection: the database checks that the caller is a CURRENT participant of
 * the session (not an invitee who never joined, not one who left),
 * that the session is CREATED, INVITED, RESOLVED or ABANDONED, and records
 * who archived it and when. mwf_app holds no UPDATE of session.status.
 */
export async function archiveSession(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id } = req.params;

    const [row] = await prisma.$queryRaw<Array<{ archived_at: Date }>>`
      SELECT app.session_archive(${id}::uuid) AS archived_at`;

    successResponse(res, {
      archived: true,
      archivedAt: row.archived_at.toISOString(),
    });
  } catch (error) {
    const sqlState = getPgSqlState(error);
    const refusal = archiveRefusal(sqlState);
    if (refusal) {
      errorResponse(res, refusal.code, refusal.message, refusal.status);
      return;
    }
    if (sqlState === 'MWA00') {
      logger.error('[archiveSession] app.session_archive saw no identity (MWA00): the identity binding is off');
      errorResponse(res, 'INTERNAL_ERROR', 'Failed to archive session', 500);
      return;
    }
    if (sqlState) logger.warn(`[archiveSession] unexpected SQLSTATE ${sqlState} from app.session_archive`);
    throw error;
  }
}

/**
 * app.session_archive's own refusals (trailer.sql; class MW SQLSTATEs, so a
 * grant drift or an unrelated CHECK is never one of them) as HTTP answers.
 * Anything else, MWA00 (no identity) included, is not a refusal: null.
 */
export function archiveRefusal(
  sqlState: string | undefined,
): { status: 400 | 403 | 404; code: 'VALIDATION_ERROR' | 'FORBIDDEN' | 'NOT_FOUND'; message: string } | null {
  switch (sqlState) {
    case 'MWA01': // no such session, or the caller is not a participant of it
      return { status: 404, code: 'NOT_FOUND', message: 'Session not found' };
    case 'MWA02': // a participant who left
      return { status: 403, code: 'FORBIDDEN', message: 'Access to this session denied' };
    case 'MWA03': // not archivable from its state
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Only resolved, abandoned, or pending sessions can be archived',
      };
    default:
      return null;
  }
}

/**
 * Set (or clear) what the caller calls another user — the caller's own
 * user_contact entry, never shown to that user (work-k5fk.2).
 * PATCH /contacts/:userId/nickname
 *
 * Only for someone the caller shares a session with; anyone else is not found
 * (the endpoint never confirms that an arbitrary user id exists).
 */
export async function updateNickname(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const contactUserId = req.params.userId;

    const parseResult = updateNicknameSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    if (contactUserId === user.id) {
      errorResponse(res, 'VALIDATION_ERROR', 'You cannot give yourself a nickname', 400);
      return;
    }
    if (!UUID_RE.test(contactUserId) || !(await sharesASession(user.id, contactUserId))) {
      errorResponse(res, 'NOT_FOUND', 'Contact not found', 404);
      return;
    }

    const nickname = await setNickname(user.id, contactUserId, parseResult.data.nickname);
    successResponse(res, { nickname });
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

    // Get invitation details (the viewer is no participant yet: app.invitation_peek, work-k5fk.10.7)
    const invitation = await peekInvitation(id);

    if (!invitation) {
      errorResponse(res, 'NOT_FOUND', 'Invitation not found', 404);
      return;
    }
    // The inviter as the invitee sees them (participant display name, spec §7)
    const invitedBy = {
      id: invitation.invitedByUserId,
      name: invitation.inviterDisplayName,
    };

    // Can't acknowledge your own invitation
    if (invitedBy.id === user.id) {
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
          invitedBy,
        },
      });
      return;
    }

    successResponse(res, {
      acknowledged: true,
      invitation: {
        id: invitation.id,
        status: invitation.status,
        invitedBy,
        session: {
          id: invitation.sessionId,
          status: invitation.sessionStatus,
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
