/**
 * Sessions Controller
 *
 * Handles session-level operations:
 * - GET /sessions/:id - Get session details
 * - POST /sessions/:id/pause - Pause active session
 * - POST /sessions/:id/resume - Resume paused session
 * - GET /sessions/:id/progress - Get stage progress for both users
 * - POST /sessions/:id/resolve - Resolve session
 * - POST /sessions/:id/stages/advance - Advance to next stage
 * - GET /sessions/:id/invitation - Get invitation details
 * - POST /sessions/:id/invitation/confirm - Confirm invitation message
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { getJobPrisma, prisma } from '../lib/prisma';
import { ApiResponse, DEFAULT_PRIVACY_PREFERENCES, ErrorCode, MessageRole, PrivacyPreferencesDTO, Stage } from '@meet-without-fear/shared';
import { notifyPartner, publishSessionEvent, publishMessageAIResponse, publishMessageError } from '../services/realtime';
import { successResponse, errorResponse } from '../utils/response';
import { getPartnerUserId, isSessionCreator } from '../utils/session';
import { getPartnerParticipant } from '../services/participant-resolver';
import { loadMilestones, loadStageStates, progressDTO, rowForStage } from '../services/stage-shim';
import { reachMilestone } from '../services/milestone-writer';
import { displayStatus, isSessionPaused } from '../services/session-status';
import { createFacilitatorMessage, listConversationMessages } from '../services/message-store';
import { getOrchestratedResponse, type FullAIContext } from '../services/ai';
import { embedSessionContent } from '../services/embedding';
import { updateSessionSummary, getSessionSummary } from '../services/conversation-summarizer';
import { updateContext } from '../lib/request-context';

async function getShowActivityStatus(userId: string): Promise<boolean> {
  // The caller's own preferences document (user_preferences.doc, spec §1.7).
  const prefs = await prisma.userPreferences.findUnique({ where: { userId }, select: { doc: true } });
  const value = (prefs?.doc as { privacy?: { showActivityStatus?: unknown } } | null)?.privacy?.showActivityStatus;
  return typeof value === 'boolean' ? value : DEFAULT_PRIVACY_PREFERENCES.showActivityStatus;
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * Get session details
 * GET /sessions/:id
 */
export async function getSession(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;

    // The caller's participant (requireSessionAccess); no participant, no session.
    const participant = req.participant;
    const session = participant
      ? await prisma.session.findUnique({
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
        })
      : null;

    if (!participant || !session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    // Get my membership (for nickname I use for partner)
    const myMember = session.relationship.members.find((m) => m.userId === user.id);

    // Get partner info
    const partnerMember = session.relationship.members.find((m) => m.userId !== user.id);

    // Current progress (stage shim)
    const state = (await loadStageStates([{ id: participant.id, joinedAt: participant.joinedAt }])).get(participant.id);
    const currentProgress = progressDTO(state, { gates: false });

    // Use nickname (what I call my partner) with fallback to their actual name
    const partnerDisplayName = myMember?.nickname ||
      partnerMember?.user.firstName ||
      partnerMember?.user.name ||
      null;

    successResponse(res, {
      session: {
        id: session.id,
        status: displayStatus(session.status, await isSessionPaused(sessionId)),
        currentStage: currentProgress.stage,
        stageStatus: currentProgress.status,
        relationshipId: session.relationshipId,
        partner: partnerMember
          ? {
              id: partnerMember.userId,
              name: partnerDisplayName,
              nickname: myMember?.nickname || null,
            }
          : { id: '', name: myMember?.nickname || null, nickname: myMember?.nickname || null },
        myProgress: {
          stage: currentProgress.stage,
          status: currentProgress.status,
        },
        createdAt: session.createdAt.toISOString(),
        resolvedAt: session.resolvedAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    logger.error('[getSession] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to get session', 500);
  }
}

/**
 * Pause an active session
 * POST /sessions/:id/pause
 *
 * Target shape (TS-9): PAUSED is not a session status any more; a paused
 * session is one whose present participants have reached the `paused`
 * milestone (spec §1.1 participant_milestone, "Absorbs … Session.status
 * PAUSED"). `paused` is a system key: written through the job connection.
 * The response keeps its shape (`status: 'PAUSED'`).
 */
export async function pauseSession(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;
    const participant = req.participant;
    const session = participant ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
    if (!participant || !session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    const paused = await isSessionPaused(sessionId);
    if (session.status !== 'ACTIVE' || paused) {
      errorResponse(
        res,
        ErrorCode.SESSION_NOT_ACTIVE,
        `Cannot pause session: current status is ${paused ? 'PAUSED' : session.status}`,
        400
      );
      return;
    }

    const now = new Date();
    const present = await prisma.participant.findMany({
      where: { sessionId, leftAt: null },
      select: { id: true },
    });
    for (const p of present) await reachMilestone(p.id, 'paused', now);

    // Notify partner
    const partner = await getPartnerParticipant(participant.id);
    if (partner?.userId) {
      await notifyPartner(sessionId, partner.userId, 'session.paused', {
        pausedBy: user.id,
        pausedAt: now.toISOString(),
      });
    }

    successResponse(res, {
      paused: true,
      pausedAt: now.toISOString(),
      status: 'PAUSED',
    });
  } catch (error) {
    logger.error('[pauseSession] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to pause session', 500);
  }
}

/**
 * Resume a paused session
 * POST /sessions/:id/resume
 *
 * Un-reaching a milestone is a DELETE by the job (spec §1.1).
 */
export async function resumeSession(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;
    const participant = req.participant;
    const session = participant ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
    if (!participant || !session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    if (!(await isSessionPaused(sessionId))) {
      errorResponse(
        res,
        ErrorCode.VALIDATION_ERROR,
        `Cannot resume session: current status is ${session.status}`,
        400
      );
      return;
    }

    await getJobPrisma().participantMilestone.deleteMany({
      where: { milestoneKey: 'paused', participant: { sessionId } },
    });
    const now = new Date();

    // Notify partner
    const partner = await getPartnerParticipant(participant.id);
    if (partner?.userId) {
      await notifyPartner(sessionId, partner.userId, 'session.resumed', {
        resumedBy: user.id,
        resumedAt: now.toISOString(),
      });
    }

    successResponse(res, {
      resumed: true,
      resumedAt: now.toISOString(),
      status: displayStatus(session.status, false),
    });
  } catch (error) {
    logger.error('[resumeSession] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to resume session', 500);
  }
}

/**
 * Get stage progress for both users
 * GET /sessions/:id/progress
 */
export async function getProgress(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;

    const participant = req.participant;
    const session = participant ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
    if (!participant || !session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    // Both participants' progress (stage shim). `gatesSatisfied` is DERIVED
    // from milestones (StageProgressDetailDTO unchanged; the keys the target
    // dropped — feelHeardCheckOffered, readyToRank, rankingSubmitted,
    // finalEmotionalReading — are never produced).
    const partner = await getPartnerParticipant(participant.id);
    const states = await loadStageStates([
      { id: participant.id, joinedAt: participant.joinedAt },
      ...(partner ? [{ id: partner.participantId, joinedAt: partner.joinedAt }] : []),
    ]);
    const myState = states.get(participant.id);
    const partnerState = partner ? states.get(partner.participantId) : undefined;

    const myProgress = progressDTO(myState, { gates: true });
    const partnerProgress = progressDTO(partnerState, { gates: true });

    // Milestones (old: the stage-1 and stage-3 rows and their gates). The two
    // stage-3 instants the old gates carried (needsIdentifiedAt,
    // commonGroundFoundAt) have no milestone: needs_confirmed is the
    // identification instant; common ground is not a milestone (null).
    const myStage1 = rowForStage(myState, 1);
    const needsConfirmed = myState?.milestones.find((m) => m.key === 'needs_confirmed');
    const milestones = {
      witnessStartedAt: myStage1?.startedAt?.toISOString() ?? null,
      feelHeardConfirmedAt: (myStage1?.gatesSatisfied.feelHeardConfirmedAt as string | undefined) ?? null,
      needsIdentifiedAt: needsConfirmed?.reachedAt.toISOString() ?? null,
      commonGroundFoundAt: null,
    };

    successResponse(res, {
      myProgress,
      partnerProgress,
      sessionStatus: session.status,
      milestones,
    });
  } catch (error) {
    logger.error('[getProgress] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to get progress', 500);
  }
}

/**
 * Resolve session
 * POST /sessions/:id/resolve
 */
export async function resolveSession(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;

    // requireSessionAccess resolved the caller's present participant
    const session = req.participant ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;

    if (!session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(
        res,
        ErrorCode.SESSION_NOT_ACTIVE,
        `Cannot resolve session: current status is ${session.status}`,
        400
      );
      return;
    }

    // Check if there are agreed agreements (agreement rows exist only once every party was WILLING)
    const agreements = await prisma.agreement.findMany({
      where: { sessionId, status: 'AGREED' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, description: true, type: true, status: true, createdAt: true, followUpAt: true },
    });

    if (agreements.length === 0) {
      errorResponse(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Cannot resolve session: no agreed agreements found',
        400
      );
      return;
    }

    const now = new Date();

    // RESOLVED through the sole status writer (it stamps resolved_at), then
    // every present human reaches `closed` (a system milestone: the job's) —
    // the old "mark all stage progress COMPLETED".
    await getJobPrisma().$executeRaw`SELECT app.session_set_status(${sessionId}::uuid, 'RESOLVED'::session_status)`;
    const present = await prisma.participant.findMany({
      where: { sessionId, kind: 'human', leftAt: null },
      select: { id: true },
    });
    for (const p of present) await reachMilestone(p.id, 'closed', now);

    // Notify partner
    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'session.resolved', {
        resolvedBy: user.id,
        resolvedAt: now.toISOString(),
      });
    }

    // Get agreements with follow-up dates
    const followUpScheduled = agreements.some((a) => a.followUpAt !== null);

    successResponse(res, {
      resolved: true,
      resolvedAt: now.toISOString(),
      agreements: agreements.map((a) => ({
        id: a.id,
        description: a.description,
        type: a.type,
        status: a.status,
        // An agreement row is created at the moment all parties agreed
        agreedAt: a.createdAt.toISOString(),
        followUpDate: a.followUpAt?.toISOString() ?? null,
      })),
      followUpScheduled,
    });
  } catch (error) {
    logger.error('[resolveSession] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to resolve session', 500);
  }
}

// ============================================================================
// Stage Advancement
// ============================================================================

/**
 * Gate requirements for each stage
 */
const STAGE_GATES: Record<number, string[]> = {
  0: ['compactSigned'],
  1: ['feelHeardConfirmed'],
  2: ['empathyValidated'],
  3: ['needsConfirmed', 'needsShared', 'needsValidated'],
  4: ['rankingSubmitted', 'agreementCreated'],
};

/**
 * Check if all gates for a stage are satisfied
 */
function checkGates(
  stage: number,
  gatesSatisfied: Record<string, unknown> | null
): { satisfied: boolean; unsatisfiedGates: string[] } {
  const requiredGates = STAGE_GATES[stage] || [];
  const unsatisfiedGates: string[] = [];

  for (const gate of requiredGates) {
    if (!gatesSatisfied || !gatesSatisfied[gate]) {
      unsatisfiedGates.push(gate);
    }
  }

  return {
    satisfied: unsatisfiedGates.length === 0,
    unsatisfiedGates,
  };
}

/**
 * Advance to the next stage
 * POST /sessions/:id/stages/advance
 *
 * Target shape (TS-9): there is no stage row to complete or create. A stage
 * is complete when its terminal milestone is reached (stage shim), and the
 * next stage is current from that instant — so this endpoint writes nothing
 * and never reports `advanced: true` (fix round 1: it reported it for any
 * stage > 0, and fired partner.advanced on every call). It answers with the
 * participant's current stage and that stage's unsatisfied (derived) gates.
 * No mobile screen calls it (useAdvanceStage is exported, unused).
 */
export async function advanceStage(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;
    const participant = req.participant;
    const session = participant ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
    if (!participant || !session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    const state = (await loadStageStates([{ id: participant.id, joinedAt: participant.joinedAt }])).get(participant.id);
    const current = progressDTO(state, { gates: true });
    const currentStage = current.stage;

    // Check session status allows advancement (ACTIVE; the creator from
    // stage 0 while INVITED).
    if (session.status !== 'ACTIVE') {
      const creatorAtStart = session.status === 'INVITED' && currentStage <= 1 && (await isSessionCreator(sessionId, user.id));
      if (!creatorAtStart) {
        errorResponse(
          res,
          ErrorCode.SESSION_NOT_ACTIVE,
          `Cannot advance stage: session status is ${session.status}`,
          400
        );
        return;
      }
    }

    // Nothing changes here, so nothing is reported as advanced and no
    // partner.advanced event is sent (the milestone writers are where a stage
    // changes). The current stage's unsatisfied gates say what is missing.
    const gateCheck = checkGates(currentStage, (current.gatesSatisfied as Record<string, unknown> | null) ?? null);
    successResponse(res, {
      advanced: false,
      newStage: currentStage,
      newStatus: current.status,
      advancedAt: null,
      blockedReason: 'GATES_NOT_SATISFIED',
      unsatisfiedGates: gateCheck.unsatisfiedGates,
    });
  } catch (error) {
    logger.error('[advanceStage] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to advance stage', 500);
  }
}

// ============================================================================
// Invitation Message Endpoints
// ============================================================================

/**
 * Get invitation details for a session
 * GET /sessions/:id/invitation
 */
export async function getInvitation(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;
    const participant = req.participant;
    const session = participant ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
    if (!participant || !session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    // The session's latest invitation (both inviter and invitee may see it)
    const invitation = await prisma.invitation.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });
    if (!invitation) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Invitation not found', 404);
      return;
    }

    successResponse(res, {
      invitation: {
        id: invitation.id,
        name: invitation.name,
        messageConfirmed: invitation.messageConfirmedAt !== null,
        messageConfirmedAt: invitation.messageConfirmedAt?.toISOString() ?? null,
        acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
        status: invitation.status,
        expiresAt: invitation.expiresAt.toISOString(),
        isInviter: invitation.invitedByParticipantId === participant.id,
        topicFrame: session.topicFrame ?? null,
        topicFrameConfirmedAt: session.topicFrameConfirmedAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    logger.error('[getInvitation] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to get invitation', 500);
  }
}

/**
 * Confirm invitation message (ready to share)
 * POST /sessions/:id/invitation/confirm
 *
 * Target shape (TS-9): the inviter reaches `compact_signed` (self-assertable,
 * app connection) and `invitation_sent` (a system fact, job connection) — the
 * old `{ compactSigned, invitationSent }` gates of the completed stage-0 row —
 * which moves them to stage 1 in the stage shim. Session status moves to
 * INVITED through app.session_set_status. The transition message is written
 * into the inviter's conversation through the job connection.
 */
export async function confirmInvitationMessage(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;
    const participant = req.participant;
    const session = participant ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
    if (!participant || !session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    // The invitation this participant sent
    const invitation = await prisma.invitation.findFirst({
      where: { sessionId, invitedByParticipantId: participant.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!invitation) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Invitation not found', 404);
      return;
    }

    // Idempotent short-circuit: only when the message is confirmed AND the
    // inviter already sent it (invitation_sent). message_confirmed_at alone is
    // not enough: confirmTopicFrame sets it eagerly so the partner can accept
    // the link before the inviter closes the share modal.
    const milestones = (await loadMilestones([participant.id])).get(participant.id) ?? [];
    if (invitation.messageConfirmedAt && milestones.some((m) => m.key === 'invitation_sent')) {
      successResponse(res, {
        confirmed: true,
        invitation: {
          id: invitation.id,
          messageConfirmed: true,
          messageConfirmedAt: invitation.messageConfirmedAt.toISOString(),
          topicFrame: session.topicFrame ?? null,
        },
      });
      return;
    }

    if (!session.topicFrame || !session.topicFrameConfirmedAt) {
      errorResponse(res, ErrorCode.VALIDATION_ERROR, 'Topic frame must be confirmed before sharing invitation', 400);
      return;
    }

    const now = new Date();

    // Confirm — only the message_confirmed_at timestamp.
    const updatedInvitation = await prisma.invitation.update({
      where: { id: invitation.id },
      data: { messageConfirmedAt: invitation.messageConfirmedAt ?? now },
    });

    // Session → INVITED (ready for partner to accept), through its only writer.
    if (session.status === 'CREATED') {
      await getJobPrisma().$executeRaw`SELECT app.session_set_status(${sessionId}::uuid, 'INVITED'::public.session_status)`;
    }

    // Stage 0 complete: compact signed (if not yet) and invitation sent.
    await reachMilestone(participant.id, 'compact_signed', now);
    await reachMilestone(participant.id, 'invitation_sent', now);

    // Proactive transition message from the AI, from this participant's own
    // conversation (summary-aware: only messages after the summary boundary).
    const existingSummary = await getSessionSummary(sessionId, user.id);
    const summaryBoundary = existingSummary?.summary.newestMessageAt;
    const historyLimit = summaryBoundary ? 30 : 20;
    const conversationId = participant.mainConversationId;
    const historyDesc = conversationId
      ? await listConversationMessages({ conversationId, limit: historyLimit - 1, order: 'desc', newerThan: summaryBoundary })
      : [];
    const history = historyDesc.slice().reverse();

    // Get partner name for context
    const partnerName = invitation.name || undefined;

    // Generate turnId for this user action - used for cost attribution
    // Includes userId to differentiate between users in the same session
    const turnId = `${sessionId}-${user.id}-invitation-confirm`;
    // Update request context so all downstream code can access this turnId
    updateContext({ turnId, sessionId, userId: user.id, participantId: participant.id });

    // Build AI context for transition
    const aiContext: FullAIContext = {
      sessionId,
      userId: user.id,
      turnId,
      userName: user.name || 'there',
      partnerName,
      stage: 1,
      turnCount: 0, // Starting fresh in Stage 1
      emotionalIntensity: 5,
      sessionDurationMinutes: 0,
      isFirstTurnInSession: false,
      isInvitationPhase: false,
      isStageTransition: true,
      previousStage: 0,
      topicFrame: session.topicFrameConfirmedAt ? session.topicFrame : undefined,
    };

    // Notify session that invitation was confirmed
    await publishSessionEvent(sessionId, 'invitation.confirmed', {
      confirmedBy: user.id,
      triggeredByUserId: user.id,
      timestamp: new Date().toISOString(),
    });

    // Return HTTP response IMMEDIATELY — don't block on AI generation.
    // The transition message will arrive via Ably (message.ai_response event).
    successResponse(res, {
      confirmed: true,
      invitation: {
        id: updatedInvitation.id,
        messageConfirmed: updatedInvitation.messageConfirmedAt !== null,
        messageConfirmedAt: updatedInvitation.messageConfirmedAt?.toISOString() ?? null,
        topicFrame: session.topicFrame,
      },
      advancedToStage: 1,
    });

    // Generate transition message in background (fire-and-forget)
    (async () => {
      try {
        const historyWithTrigger = [
          ...history.map((m) => ({
            role: m.role === 'USER' && m.kind === 'CHAT' ? 'user' as const : 'assistant' as const,
            content: m.content,
          })),
          { role: 'user' as const, content: '[I just sent the invitation and am ready to continue.]' },
        ];

        const orchestratorResult = await getOrchestratedResponse(historyWithTrigger, aiContext);
        if (!conversationId) throw new Error(`Participant ${participant.id} has no MAIN conversation`);

        const aiMessage = await createFacilitatorMessage({
          conversationId,
          content: orchestratorResult.response,
        });

        logger.info('[confirmInvitationMessage] Generated transition message:', aiMessage.id);

        // Deliver via Ably so the mobile client picks it up
        await publishMessageAIResponse(sessionId, user.id, {
          id: aiMessage.id,
          sessionId,
          senderId: null,
          role: MessageRole.AI,
          content: aiMessage.content,
          stage: Stage.WITNESS,
          timestamp: aiMessage.createdAt.toISOString(),
        });

        // Summarize and embed (non-blocking)
        updateSessionSummary(sessionId, user.id, turnId)
          .then(() => embedSessionContent(sessionId, user.id, turnId))
          .catch((err: unknown) =>
            logger.warn('[confirmInvitationMessage] Failed to update summary/embedding:', err)
          );
      } catch (err) {
        logger.error('[confirmInvitationMessage] Failed to generate transition message:', err);
        // Notify client of the error so they can retry
        await publishMessageError(sessionId, user.id, '', 'Failed to generate transition message', true).catch(() => {});
      }
    })();
  } catch (error) {
    logger.error('[confirmInvitationMessage] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to confirm invitation message', 500);
  }
}

// ============================================================================
// Session Read State
// ============================================================================

/**
 * Mark session as viewed
 * POST /sessions/:id/viewed
 *
 * Updates lastViewedAt and optionally lastSeenChatItemId on the participant's
 * conversation_read_state (target shape, TS-9). This is called when the user
 * opens/views a session to mark it as "read".
 */
export async function markSessionViewed(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;
    const participant = req.participant;
    if (!participant) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }
    const { lastSeenChatItemId } = req.body;

    const now = new Date();

    // last_seen_message_id is an FK to message: only a message of the
    // participant's own conversation is kept (a mobile chat-item id that is
    // not a message — e.g. `context-shared-…` — reads as null, as the target
    // migration mapped it).
    const seenMessage =
      typeof lastSeenChatItemId === 'string' && participant.mainConversationId
        ? await prisma.message.findFirst({
            where: { id: lastSeenChatItemId, conversationId: participant.mainConversationId },
            select: { id: true },
          }).catch(() => null)
        : null;

    const readState = await prisma.conversationReadState.upsert({
      where: { participantId: participant.id },
      update: { lastViewedAt: now, lastActiveAt: now, lastSeenMessageId: seenMessage?.id ?? null },
      create: { participantId: participant.id, lastViewedAt: now, lastActiveAt: now, lastSeenMessageId: seenMessage?.id ?? null },
    });

    // Notify partner that this user viewed the session (for delivery status updates)
    // Fire-and-forget - don't block the response. Include empathy status for cache update.
    (async () => {
      try {
        const { buildEmpathyExchangeStatusForBothUsers } = await import('../services/empathy-status');
        const allStatuses = await buildEmpathyExchangeStatusForBothUsers(sessionId);
        const showActivityStatus = await getShowActivityStatus(user.id);
        await publishSessionEvent(sessionId, 'partner.session_viewed', {
          viewedAt: showActivityStatus ? now.toISOString() : null,
          activeAt: showActivityStatus ? now.toISOString() : null,
          presenceVisible: showActivityStatus,
          empathyStatuses: allStatuses,
        }, user.id);
      } catch (err) {
        logger.error('[markSessionViewed] Failed to publish session_viewed event:', err);
      }
    })();

    successResponse(res, {
      success: true,
      lastViewedAt: readState.lastViewedAt?.toISOString() ?? now.toISOString(),
      lastSeenChatItemId: readState.lastSeenMessageId,
    });
  } catch (error) {
    logger.error('[markSessionViewed] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to mark session as viewed', 500);
  }
}

/**
 * Mark the Share/Partner tab as viewed
 * POST /sessions/:id/viewed-share-tab
 *
 * Updates last_viewed_share_tab_at on the participant's conversation_read_state.
 * This is used to determine "seen" status for shared content (empathy, context).
 * Content is only marked as "seen" when the user actually views the Share tab.
 */
export async function markShareTabViewed(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;
    const participant = req.participant;
    if (!participant) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }
    const now = new Date();

    const readState = await prisma.conversationReadState.upsert({
      where: { participantId: participant.id },
      update: { lastViewedShareTabAt: now, lastActiveAt: now },
      create: { participantId: participant.id, lastViewedShareTabAt: now, lastActiveAt: now },
    });

    // Notify partner that this user viewed the Share tab (for delivery status updates)
    // Fire-and-forget - don't block the response. Include empathy status for cache update.
    (async () => {
      try {
        const { buildEmpathyExchangeStatusForBothUsers } = await import('../services/empathy-status');
        const allStatuses = await buildEmpathyExchangeStatusForBothUsers(sessionId);
        const showActivityStatus = await getShowActivityStatus(user.id);
        await publishSessionEvent(sessionId, 'partner.share_tab_viewed', {
          viewedAt: showActivityStatus ? now.toISOString() : null,
          activeAt: showActivityStatus ? now.toISOString() : null,
          presenceVisible: showActivityStatus,
          empathyStatuses: allStatuses,
        }, user.id);
      } catch (err) {
        logger.error('[markShareTabViewed] Failed to publish share_tab_viewed event:', err);
      }
    })();

    successResponse(res, {
      success: true,
      lastViewedShareTabAt: readState.lastViewedShareTabAt?.toISOString() ?? now.toISOString(),
    });
  } catch (error) {
    logger.error('[markShareTabViewed] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to mark share tab as viewed', 500);
  }
}

/**
 * Get count of sessions with unread content
 * GET /sessions/unread-count
 *
 * The number of the caller's live, unarchived sessions whose MAIN conversation
 * has messages after their last view that they did not send
 * (`v_conversation_unread`, target shape). Used for the Sessions tab badge.
 */
export async function getUnreadSessionCount(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
      FROM v_conversation_unread u
      JOIN participant p ON p.id = u.participant_id
      JOIN session s ON s.id = p.session_id
      LEFT JOIN conversation_read_state r ON r.participant_id = p.id
      WHERE p.user_id = ${user.id}::uuid AND p.left_at IS NULL
        AND s.status IN ('ACTIVE', 'INVITED', 'CREATED')
        AND r.archived_at IS NULL
        AND u.unread_count > 0`;

    successResponse(res, { count: Number(rows[0]?.n ?? 0) });
  } catch (error) {
    logger.error('[getUnreadSessionCount] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to get unread count', 500);
  }
}
