/**
 * Stage 1 Controller
 *
 * Handles the Witness stage endpoints:
 * - POST /sessions/:id/messages - Send message and get AI response
 * - POST /sessions/:id/feel-heard - Confirm user feels heard
 * - GET /sessions/:id/messages - Get conversation history
 */

import { Request, Response } from 'express';
import { Prisma } from '../generated/prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getSonnetResponse, BrainActivityCallType } from '../lib/bedrock';
import { buildInitialMessagePrompt, buildStagePromptString } from '../services/stage-prompts';
import { parseMicroTagResponse } from '../utils/micro-tag-parser';
import { type SessionStateToolInput } from '../services/stage-tools';
import { applyStage3NeedActions, persistTurnState } from '../services/stream-turn-actions';
import { admitStreamTurn } from '../services/stream-turn-admission';
import { scheduleStreamTurnBackgroundJobs } from '../services/stream-turn-background';
import {
  cleanupFailedStreamTurn,
  isReadyForStage3RevealText,
  resolveStage3GateTurn,
  saveAiTurnMessage,
} from '../services/stream-turn-persistence';
import { assembleStreamTurnContext } from '../services/stream-turn-context';
import { runStreamTurnModel } from '../services/stream-turn-model';
import { resolveStreamTurn } from '../services/stream-turn-resolution';
import {
  feelHeardRequestSchema,
  getMessagesQuerySchema,
  type StreamEvent,
} from '@meet-without-fear/shared';
import { notifyPartner, publishSessionEvent } from '../services/realtime';
import { successResponse, errorResponse } from '../utils/response';
import { getPartnerUserId, isSessionCreator } from '../utils/session';
import { embedSessionContent } from '../services/embedding';
import { runReconcilerForDirection } from '../services/reconciler';
import { updateContext } from '../lib/request-context';
import { consolidateGlobalFacts } from '../services/global-memory';
import { finalizeTurnMetrics } from '../services/llm-telemetry';
import { scrubVisibleAIText } from '../utils/visible-text';
import { listConversationMessages, toMessageDTO } from '../services/message-store';
import { loadMilestones } from '../services/stage-shim';

// Re-exported for existing callers that import these from this controller.
export { scrubVisibleAIText, isReadyForStage3RevealText };

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if partner has completed stage 1 "feel heard"
 */
async function hasPartnerCompletedStage1(
  sessionId: string,
  currentUserId: string
): Promise<boolean> {
  const partnerId = await getPartnerUserId(sessionId, currentUserId);
  if (!partnerId) return false;

  const partnerProgress = await prisma.stageProgress.findUnique({
    where: {
      sessionId_userId_stage: {
        sessionId,
        userId: partnerId,
        stage: 1,
      },
    },
  });

  if (!partnerProgress) return false;

  const gates = partnerProgress.gatesSatisfied as Record<string, unknown> | null;
  return gates?.feelHeard === true || gates?.feelHeardConfirmed === true;
}
/**
 * Get a fallback initial message when AI is unavailable
 */
function getFallbackInitialMessage(
  userName: string,
  partnerName: string | undefined,
  isInvitationPhase: boolean,
  isInvitee: boolean
): string {
  const partner = partnerName || 'them';

  if (isInvitee) {
    return `I'd like to hear your side now. What's been happening from your point of view with ${partner}?`;
  }

  if (isInvitationPhase) {
    return `Hey ${userName}, what's going on with ${partner}?`;
  }

  return `Hey ${userName}, what's on your mind?`;
}

const STAGE2_ROADMAP_COPY =
  `Here's what comes next: there are a few more steps in this process. First, each of you tries to understand what the other person might be going through. Then you'll each explore what matters most to you, and eventually use that to get clearer about what is possible next, whether together or separately.`;

function buildStage2TransitionFallback(
  partnerName: string | undefined,
  partnerStatus: 'not_joined' | 'in_progress' | 'completed'
): string {
  const partner = partnerName || 'your partner';
  const mutualPhrase = partnerStatus === 'not_joined'
    ? `${partnerName || 'Your partner'} will be doing this same thing for you on their side.`
    : `${partnerName || 'Your partner'} is doing this same thing for you on their side.`;

  return `That gives us enough to move to the next step.\n\n${STAGE2_ROADMAP_COPY}\n\nThis next part may feel unusual: try to imagine what ${partner} might be experiencing, even if you are still upset with them. This is not about excusing, agreeing, softening your boundary, or deciding what happens next. It is a guess about how this may be landing for ${partner}, while keeping your own truth intact. ${mutualPhrase}\n\nWhat do you think might be going on for ${partner} in all of this?`;
}

function scrubStage2RepairFraming(content: string): string {
  const researchToRepairRegex = new RegExp(
    [
      "there is a lot of research|there's a lot of research|research shows",
      'genuinely tr(?:y|ies)ing to see',
      'work things out',
    ].join('[^.]*'),
    'gi'
  );
  const moveForwardTogetherRegex = new RegExp(
    ['once you both feel', 'move forward together'].join('[^.]*'),
    'gi'
  );

  return content
    .replace(
      researchToRepairRegex,
      "This is not about excusing, agreeing, or deciding what happens next"
    )
    .replace(moveForwardTogetherRegex,
      "If something feels off, you can say what is missing before the process continues."
    );
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * Send a message in Stage 1 and get AI witness response
 * POST /sessions/:id/messages
 *
 * @deprecated This endpoint is deprecated. Use POST /sessions/:id/messages/stream instead.
 * The streaming endpoint provides real-time token streaming and better error handling.
 */
export async function sendMessage(req: Request, res: Response): Promise<void> {
  logger.warn('[sendMessage] DEPRECATED: Fire-and-forget endpoint called. Clients should use /messages/stream instead.');

  errorResponse(
    res,
    'ENDPOINT_DEPRECATED',
    'This endpoint is deprecated. Please use POST /sessions/:id/messages/stream for SSE streaming.',
    410 // HTTP 410 Gone
  );
}


/**
 * Confirm that user feels heard and can proceed
 * POST /sessions/:id/feel-heard
 */
export async function confirmFeelHeard(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Validate request body
    const parseResult = feelHeardRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Invalid request body',
        400,
        parseResult.error.issues
      );
      return;
    }

    const { confirmed, feedback } = parseResult.data;

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
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Get user's current stage progress (needed for both status check and stage validation)
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
      },
      orderBy: { stage: 'desc' },
    });

    // Check session allows feel-heard confirmation
    // Allow ACTIVE status for all users, and INVITED status for:
    // 1. The session creator, OR
    // 2. Users who have already joined (have stage progress) - defensive check for edge cases
    if (session.status !== 'ACTIVE') {
      if (session.status === 'INVITED') {
        const isCreator = await isSessionCreator(sessionId, user.id);
        const hasJoined = !!progress; // User has stage progress, meaning they've joined

        if (!isCreator && !hasJoined) {
          errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
          return;
        }

        // If user has joined but session status is still INVITED, update it to ACTIVE
        // This handles edge cases where status wasn't updated on invitation acceptance
        if (hasJoined && !isCreator) {
          await prisma.session.update({
            where: { id: sessionId },
            data: { status: 'ACTIVE' },
          });
          logger.info(`[confirmFeelHeard] Updated session ${sessionId} status to ACTIVE (user has joined)`);
        }
        // Creator can proceed while session is INVITED
      } else {
        errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
        return;
      }
    }

    // Check user is in stage 1
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 1) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot confirm feel-heard: you are in stage ${currentStage}, but stage 1 is required`,
        400
      );
      return;
    }

    // Generate turnId for this user action
    const turnId = `${sessionId}-${user.id}-feel-heard`;
    // Update request context so all downstream code can access this turnId
    updateContext({ turnId, sessionId, userId: user.id });

    // Build gates satisfied data (use names that match Stage1Gates interface)
    const gatesSatisfied = {
      feelHeardConfirmed: confirmed,
      feelHeardConfirmedAt: new Date().toISOString(),
      finalEmotionalReading: null, // Can be updated later with final barometer reading
      ...(feedback ? { feedback } : {}),
    } satisfies Prisma.InputJsonValue;

    const now = new Date();
    const confirmedAt = now.toISOString();

    // Update stage progress - mark Stage 1 as COMPLETED when confirmed
    await prisma.stageProgress.update({
      where: {
        sessionId_userId_stage: {
          sessionId,
          userId: user.id,
          stage: 1,
        },
      },
      data: {
        gatesSatisfied,
        status: confirmed ? 'COMPLETED' : 'IN_PROGRESS',
        completedAt: confirmed ? now : null,
      },
    });

    // When confirmed, advance user to Stage 2 immediately
    // This ensures they get Stage 2 prompts with empathy statement capability
    let advancedToStage2 = false;
    if (confirmed) {
      // Check if Stage 2 record already exists (shouldn't, but be safe)
      const existingStage2 = await prisma.stageProgress.findUnique({
        where: {
          sessionId_userId_stage: {
            sessionId,
            userId: user.id,
            stage: 2,
          },
        },
      });

      if (!existingStage2) {
        await prisma.stageProgress.create({
          data: {
            sessionId,
            userId: user.id,
            stage: 2,
            status: 'IN_PROGRESS',
            startedAt: now,
            gatesSatisfied: {},
          },
        });
        advancedToStage2 = true;
        logger.info(`[confirmFeelHeard] Advanced user ${user.id} to Stage 2`);
      }
    }

    // Generate AI transition message when user confirms they feel heard
    let transitionMessage: {
      id: string;
      content: string;
      timestamp: string;
      stage: number;
    } | null = null;

    if (confirmed) {
      try {
        // Get partner name (using nickname) and status for the transition message
        const myMember = session.relationship.members.find(
          (m) => m.userId === user.id
        );
        const partnerMember = session.relationship.members.find(
          (m) => m.userId !== user.id
        );

        let partnerName: string | undefined;
        let partnerStatus: 'not_joined' | 'in_progress' | 'completed' = 'not_joined';

        if (partnerMember) {
          // Use nickname (what I call my partner) → firstName → name
          partnerName = myMember?.nickname ||
            partnerMember.user.firstName ||
            partnerMember.user.name ||
            undefined;

          // Check partner's stage progress to determine their status
          const partnerProgress = await prisma.stageProgress.findFirst({
            where: {
              sessionId,
              userId: partnerMember.userId,
            },
            orderBy: { stage: 'desc' },
          });

          if (partnerProgress) {
            partnerStatus = 'in_progress';
          }
        } else {
          // Partner hasn't joined yet - get name from invitation
          const invitation = await prisma.invitation.findFirst({
            where: { sessionId, invitedById: user.id },
            select: { name: true },
          });
          partnerName = myMember?.nickname || invitation?.name || undefined;
        }

        const transitionContent = scrubStage2RepairFraming(
          buildStage2TransitionFallback(partnerName, partnerStatus)
        );

        // Save the transition message to the database as Stage 2
        // This is the first message in the perspective-taking phase
        const aiMessage = await prisma.message.create({
          data: {
            sessionId,
            senderId: null,
            forUserId: user.id, // Track which user this AI response is for (data isolation)
            role: 'AI',
            content: transitionContent.trim(),
            stage: 2, // Stage 2 - perspective stretch begins
          },
        });

        // Embed session content for cross-session retrieval (non-blocking)
        // Per fact-ledger architecture, we embed at session level
        embedSessionContent(sessionId, user.id, turnId).catch((err: unknown) =>
          logger.warn('[confirmFeelHeard] Failed to embed session content:', err)
        );

        transitionMessage = {
          id: aiMessage.id,
          content: aiMessage.content,
          timestamp: aiMessage.timestamp.toISOString(),
          stage: 2, // Stage 2 transition message
        };

        logger.info(`[confirmFeelHeard] Generated transition message for session ${sessionId}`);

        // Audit log the transition message
        /* auditLog('RESPONSE', 'Stage transition message generated', {
          turnId,
          sessionId,
          userId: user.id,
          stage: 2,
          operation: 'stage1-transition',
          responseText: transitionContent,
          messageId: aiMessage.id,
        }); */
      } catch (error) {
        logger.error('[confirmFeelHeard] Failed to generate transition message:', error);
        // Continue without transition message - not a critical failure
      }
    }

    // Check if partner has also completed
    const partnerCompleted = await hasPartnerCompletedStage1(sessionId, user.id);
    const canAdvance = confirmed && partnerCompleted;

    // Notify partner of stage completion
    if (confirmed) {
      const partnerId = await getPartnerUserId(sessionId, user.id);
      if (partnerId) {
        await notifyPartner(sessionId, partnerId, 'partner.stage_completed', {
          stage: 1,
          completedBy: user.id,
        });
      }

      // Consolidate global facts when Stage 1 completes (fire-and-forget)
      // Per fact-ledger architecture, we merge session facts into user's global profile
      consolidateGlobalFacts(user.id, sessionId, turnId).catch((err: unknown) =>
        logger.warn('[confirmFeelHeard] Failed to consolidate global facts:', err)
      );
    }

    // If both partners are ready, publish advancement event
    if (canAdvance) {
      await publishSessionEvent(sessionId, 'partner.advanced', {
        fromStage: 1,
        toStage: 2,
      });
    }

    // NEW: Check if partner has an empathy attempt in HELD status
    // If so, trigger the asymmetric reconciler for that direction
    // (Partner = guesser, current user = subject whose Stage 1 is now complete)
    let reconcilerTriggered = false;
    let reconcilerResult: {
      empathyStatus: 'REVEALED' | 'AWAITING_SHARING';
      shareOffer: { suggestedContent: string; reason: string } | null;
    } | null = null;

    if (confirmed) {
      const partnerId = await getPartnerUserId(sessionId, user.id);
      if (partnerId) {
        // Check if partner has an empathy attempt in HELD status (waiting for us)
        const partnerEmpathyAttempt = await prisma.empathyAttempt.findFirst({
          where: {
            sessionId,
            sourceUserId: partnerId,
            status: 'HELD',
          },
        });

        if (partnerEmpathyAttempt) {
          logger.info(`[confirmFeelHeard] Partner ${partnerId} has HELD empathy - triggering reconciler (non-blocking)`);

          // Trigger reconciler in the background
          (async () => {
            try {
              logger.info(`[confirmFeelHeard] Calling runReconcilerForDirection for sessionId=${sessionId}, guesserId=${partnerId}, subjectId=${user.id}`);
              const result = await runReconcilerForDirection(sessionId, partnerId, user.id);

              logger.info(`[confirmFeelHeard] Reconciler completed: status=${result.empathyStatus}, hasSuggestion=${!!result.shareOffer}`);

              // If there's a share suggestion, notify the current user (subject)
              // Note: We DON'T exclude the user here because they ARE the intended recipient
              // Include full empathy status to avoid extra HTTP round-trip
              if (result.empathyStatus === 'AWAITING_SHARING' && result.shareOffer) {
                logger.info(`[confirmFeelHeard] Significant gaps found - notifying subject ${user.id} of share suggestion`);
                const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
                const empathyStatus = await buildEmpathyExchangeStatus(sessionId, user.id);
                await notifyPartner(sessionId, user.id, 'empathy.share_suggestion', {
                  // Include forUserId so mobile can filter - only the subject should see the modal
                  forUserId: user.id,
                  guesserName: session.relationship.members.find(m => m.userId === partnerId)
                    ? 'your partner'
                    : 'your partner',
                  suggestedContent: result.shareOffer.suggestedContent,
                  suggestedReason: (result.shareOffer as any).reason || (result.shareOffer as any).suggestedReason,
                  empathyStatus,
                  // Include triggeredByUserId for event tracing
                  triggeredByUserId: user.id,
                });
              }

              // If empathy is READY (no gaps), the guesser already got the alignment message.
              // The reveal notification will be sent when both directions are READY.
              if (result.empathyStatus === 'READY') {
                logger.info(`[confirmFeelHeard] No significant gaps - empathy marked READY, waiting for partner to complete Stage 2`);
              }
            } catch (error) {
              logger.error('[confirmFeelHeard] Reconciler background task failed:', error);
            }
          })();
          reconcilerTriggered = true;
        } else {
          logger.info(`[confirmFeelHeard] Partner ${partnerId} does not have HELD empathy - reconciler NOT triggered`);
        }
      }
    }

    successResponse(res, {
      confirmed,
      confirmedAt,
      canAdvance,
      partnerCompleted,
      transitionMessage,
      advancedToStage: advancedToStage2 ? 2 : null,
      reconcilerTriggered,
    });
  } catch (error) {
    logger.error('[confirmFeelHeard] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to confirm feel-heard', 500);
  }
}

/**
 * Get conversation history for the current user in a session
 * GET /sessions/:id/messages
 */
export async function getConversationHistory(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = `get-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  try {
    logger.info(`[getConversationHistory:${requestId}] ========== REQUEST START ==========`);
    const user = req.user;
    if (!user) {
      logger.info(`[getConversationHistory:${requestId}] ERROR: No user in request`);
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    logger.info(`[getConversationHistory:${requestId}] Session ID: ${sessionId}, User ID: ${user.id}`);

    // Validate query params
    const parseResult = getMessagesQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Invalid query parameters',
        400,
        parseResult.error.issues
      );
      return;
    }

    const { limit, before, after, order } = parseResult.data;

    // The caller's participant, resolved once by requireSessionAccess (TS-9).
    // No participant (the invitee fallback) has no conversation to read.
    const participant = req.participant;
    if (!participant?.mainConversationId) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // The caller's MAIN conversation IS the audience: no sender/recipient
    // filter exists any more (target shape; `forUserId` is gone).
    logger.info(`[getConversationHistory:${requestId}] Fetching messages with limit=${limit}, before=${before || 'none'}, after=${after || 'none'}, order=${order}`);
    const [messages, milestones] = await Promise.all([
      listConversationMessages({
        conversationId: participant.mainConversationId,
        limit,
        order,
        before: before ? new Date(before) : undefined,
        after: after ? new Date(after) : undefined,
      }),
      loadMilestones([participant.id]),
    ]);

    logger.info(`[getConversationHistory:${requestId}] Fetched ${messages.length} messages from database`);

    // Check if there are more messages
    const hasMore = messages.length > limit;
    let resultMessages = hasMore ? messages.slice(0, limit) : messages;

    logger.info(`[getConversationHistory:${requestId}] Returning ${resultMessages.length} messages (hasMore=${hasMore})`);

    // If fetched in descending order, reverse to return chronological order for display
    // This allows us to fetch the latest N messages but display them oldest-first
    if (order === 'desc') {
      resultMessages = resultMessages.reverse();
    }

    const ownerMilestones = milestones.get(participant.id) ?? [];
    successResponse(res, {
      messages: resultMessages.map((m) => ({
        ...toMessageDTO(m, { sessionId, ownerMilestones }),
        refiningNeedId: m.refiningNeedId ?? null,
      })),
      hasMore,
    });
  } catch (error) {
    logger.error('[getConversationHistory] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get messages', 500);
  }
}

/**
 * Get AI-generated initial message for a session/stage
 * POST /sessions/:id/messages/initial
 */
export async function getInitialMessage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

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
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check if there are already messages in this session for this user (data isolation)
    const existingMessages = await prisma.message.findFirst({
      where: {
        sessionId,
        OR: [
          // Messages user sent without a specific recipient
          { senderId: user.id, forUserId: null },
          // Messages specifically for this user
          { forUserId: user.id },
        ],
      },
    });

    if (existingMessages) {
      // Already has messages, don't generate a new initial message
      errorResponse(res, 'VALIDATION_ERROR', 'Session already has messages', 400);
      return;
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
      },
      orderBy: { stage: 'desc' },
    });

    const currentStage = progress?.stage ?? 0;

    // Determine if this is the invitation phase
    const isInvitationPhase = session.status === 'CREATED';

    // Get user's first name
    const userName = user.firstName || user.name || 'there';

    // Find the session's invitation to determine inviter/invitee status
    const invitation = await prisma.invitation.findFirst({
      where: { sessionId },
      select: { name: true, invitedById: true },
    });

    // Determine if the current user is the invitee (NOT the person who sent the invitation)
    const isInvitee = invitation ? invitation.invitedById !== user.id : false;

    // Get partner name - for inviter it's from the invitation, for invitee it's from the inviter
    let partnerName: string | undefined;
    if (isInvitee) {
      // Invitee: partner is the inviter
      const inviter = await prisma.user.findUnique({
        where: { id: invitation?.invitedById },
        select: { firstName: true, name: true },
      });
      partnerName = inviter?.firstName || inviter?.name || undefined;
    } else {
      // Inviter: partner name is from the invitation
      partnerName = invitation?.name || undefined;

      // Older sessions created from an existing person may have a blank
      // invitation name. Recover the display name from the relationship so the
      // opening prompt does not ask who the user already selected.
      if (!partnerName) {
        const inviterMembership = await prisma.relationshipMember.findUnique({
          where: {
            relationshipId_userId: {
              relationshipId: session.relationshipId,
              userId: user.id,
            },
          },
          select: { nickname: true },
        });
        const partnerMember = await prisma.relationshipMember.findFirst({
          where: {
            relationshipId: session.relationshipId,
            userId: { not: user.id },
          },
          select: {
            user: {
              select: {
                firstName: true,
                name: true,
              },
            },
          },
        });

        partnerName =
          inviterMembership?.nickname ||
          partnerMember?.user.firstName ||
          partnerMember?.user.name ||
          undefined;
      }
    }

    // Check if this session originated from an Inner Thoughts session
    let innerThoughtsContext: { summary: string; themes: string[]; fullContext?: string } | undefined;
    if (!isInvitee && isInvitationPhase) {
      const originInnerThoughts = await prisma.innerWorkSession.findFirst({
        where: {
          linkedPartnerSessionId: sessionId,
          userId: user.id,
          linkedTrigger: 'suggestion_start',
        },
        select: {
          summary: true,
          theme: true,
          messages: {
            orderBy: { timestamp: 'asc' },
            select: { role: true, content: true }
          }
        },
      });

      if (originInnerThoughts) {
        // Build a richer context from the messages if available
        let fullContext = '';
        if (originInnerThoughts.messages.length > 0) {
          fullContext = originInnerThoughts.messages
            .map(m => `${m.role === 'USER' ? 'User' : 'AI'}: ${m.content}`)
            .join('\n\n');
        }

        innerThoughtsContext = {
          summary: originInnerThoughts.summary || '',
          themes: originInnerThoughts.theme ? [originInnerThoughts.theme] : [],
          fullContext: fullContext || undefined
        };
      }
    }

    // Build the initial message prompt
    let prompt: string;
    if (!isInvitee && isInvitationPhase && innerThoughtsContext) {
      // Use the actual invitation crafting prompt with extra context
      // This allows the AI to propose an invitation in the first message
      prompt = buildStagePromptString(0, {
        userName,
        partnerName,
        turnCount: 1,
        emotionalIntensity: 5,
        contextBundle: {
          conversationContext: {
            recentTurns: [],
            turnCount: 0,
            sessionDurationMinutes: 0,
          },
          emotionalThread: {
            initialIntensity: null,
            currentIntensity: null,
            trend: 'unknown',
            notableShifts: [],
          },
          stageContext: {
            stage: 0,
            gatesSatisfied: {},
          },
          userName,
          partnerName,
          intent: {
            intent: 'stage_enforcement',
            depth: 'minimal',
            reason: 'Stage 0 - onboarding with minimal context',
            threshold: 0.60,
            maxCrossSession: 0,
            allowCrossSession: false,
            surfaceStyle: 'silent',
          },
          assembledAt: new Date().toISOString(),
        },
        innerThoughtsContext,
      }, { isInvitationPhase: true });
    } else {
      prompt = buildInitialMessagePrompt(
        currentStage,
        { userName, partnerName, isInvitee, topicFrame: session.topicFrame, innerThoughtsContext },
        isInvitationPhase
      );
    }

    // Generate turnId for this user action - the invitee accessing their session
    const turnId = `${sessionId}-${user.id}-welcome`;
    // Update request context so all downstream code can access this turnId
    updateContext({ turnId, sessionId, userId: user.id });

    // Get AI response
    let responseContent: string;
    try {
      // AWS Bedrock requires conversations to start with a user message
      const aiResponse = await getSonnetResponse({
        systemPrompt: prompt,
        messages: [{ role: 'user', content: 'Please generate an initial greeting.' }],
        maxTokens: 512,
        sessionId,
        turnId,
        operation: 'stage1-initial-message',
        callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
      });

      if (aiResponse) {
        // Parse the semantic tag response (micro-tag format)
        const parsed = parseMicroTagResponse(aiResponse);
        responseContent = parsed.response.trim() || getFallbackInitialMessage(userName, partnerName, isInvitationPhase, isInvitee);
      } else {
        // Fallback if AI unavailable
        responseContent = getFallbackInitialMessage(userName, partnerName, isInvitationPhase, isInvitee);
      }
    } catch (error) {
      logger.error('[getInitialMessage] AI response error:', error);
      responseContent = getFallbackInitialMessage(userName, partnerName, isInvitationPhase, isInvitee);
    }

    // Save the AI message (trim whitespace that Claude sometimes adds).
    // This endpoint can be called twice during the Ready/compact transition;
    // make the final write idempotent so concurrent calls do not create twins.
    let aiMessage;
    try {
      aiMessage = await prisma.$transaction(async (tx) => {
        const existing = await tx.message.findFirst({
          where: {
            sessionId,
            forUserId: user.id,
          },
          orderBy: { timestamp: 'asc' },
        });

        if (existing) {
          return existing;
        }

        return tx.message.create({
          data: {
            sessionId,
            senderId: null,
            forUserId: user.id, // Track which user this AI response is for (data isolation)
            role: 'AI',
            content: responseContent.trim(),
            stage: currentStage,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        const existing = await prisma.message.findFirst({
          where: {
            sessionId,
            forUserId: user.id,
          },
          orderBy: { timestamp: 'asc' },
        });
        if (existing) {
          aiMessage = existing;
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    // Embed session content for cross-session retrieval (non-blocking)
    // Per fact-ledger architecture, we embed at session level
    embedSessionContent(sessionId, user.id, turnId).catch((err: unknown) =>
      logger.warn('[getInitialMessage] Failed to embed session content:', err)
    );

    logger.info(`[getInitialMessage] Generated initial message for session ${sessionId}, stage ${currentStage}`);

    successResponse(res, {
      message: {
        id: aiMessage.id,
        sessionId: aiMessage.sessionId,
        senderId: aiMessage.senderId,
        role: aiMessage.role,
        content: aiMessage.content,
        stage: aiMessage.stage,
        timestamp: aiMessage.timestamp.toISOString(),
      },
    });
  } catch (error) {
    logger.error('[getInitialMessage] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get initial message', 500);
  }
}

// ============================================================================
// Streaming Endpoint (SSE)
// ============================================================================

/**
 * Send SSE event to client.
 *
 * The event vocabulary and payload shapes are defined once in
 * `shared/src/contracts/stream.ts` (`StreamEvent`); both this emitter and the
 * mobile consumer compile against that contract.
 */
function sendSSE(res: Response, event: StreamEvent): void {
  res.write(`event: ${event.event}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

/**
 * Send a message with streaming AI response
 * POST /sessions/:id/messages/stream
 *
 * Uses Server-Sent Events (SSE) to stream the AI response in real-time.
 * Events:
 * - user_message: User message saved (includes ID)
 * - chunk: Text delta from AI
 * - text_complete: AI text finished streaming (sent before DB saves)
 * - complete: AI response complete (includes messageId and metadata)
 * - error: Error occurred (includes retryable flag)
 */
export async function sendMessageStream(req: Request, res: Response): Promise<void> {
  const requestId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Track if client disconnected
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    logger.info(`[sendMessageStream:${requestId}] Client disconnected`);
  });

  try {
    logger.info(`[sendMessageStream:${requestId}] ========== SSE STREAM REQUEST START ==========`);

    // Rejections here are plain JSON — no SSE header has been flushed yet.
    const admission = await admitStreamTurn({ requestId, req });
    if (!admission.admitted) {
      res.status(admission.status).json(admission.body);
      return;
    }

    const {
      user,
      sessionId,
      content,
      session,
      progress,
      currentStage,
      refiningNeedContext,
      userMessage,
    } = admission;

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send user_message event
    sendSSE(res, {
      event: 'user_message',
      data: {
        id: userMessage.id,
        content: userMessage.content,
        timestamp: userMessage.timestamp.toISOString(),
        refiningNeedId: userMessage.refiningNeedId ?? null,
      },
    });

    const stage3Gate = await resolveStage3GateTurn({ sessionId, userId: user.id, currentStage, content });
    if (stage3Gate) {
      if (!clientDisconnected) {
        sendSSE(res, { event: 'chunk', data: { text: stage3Gate.text } });
        sendSSE(res, { event: 'metadata', data: { metadata: {} } });
        sendSSE(res, { event: 'text_complete', data: { metadata: {} } });
        sendSSE(res, { event: 'complete', data: { messageId: stage3Gate.aiMessage.id, metadata: {} } });
      }
      res.end();
      logger.info(`[sendMessageStream:${requestId}] Stage 3 ready text handled via gate response`);
      return;
    }

    const {
      history,
      userTurnCount,
      turnId,
      partnerName,
      userName,
      isInvitationPhase,
      effectiveStage,
      prompt,
      messagesWithContext,
    } = await assembleStreamTurnContext({
      requestId,
      sessionId,
      user,
      session,
      currentStage,
      refiningNeedContext,
    });

    let accumulatedText = '';
    let metadata: SessionStateToolInput = {};
    let streamError: Error | null = null;
    let isDispatchMessage = false; // Track if this is a dispatch response (skip processing)

    try {
      const modelResult = await runStreamTurnModel({
        requestId,
        sessionId,
        turnId,
        currentStage,
        isInvitationPhase,
        userTurnCount,
        prompt,
        messagesWithContext,
        emitVisibleChunk: (text) => sendSSE(res, { event: 'chunk', data: { text } }),
        isClientDisconnected: () => clientDisconnected,
      });

      // The empty-response guard inside throws into the stream error path below.
      const resolution = await resolveStreamTurn({
        requestId,
        sessionId,
        turnId,
        currentStage,
        isInvitationPhase,
        content,
        history,
        userName,
        partnerName,
        session,
        accumulatedText: modelResult.accumulatedText,
        metadata: modelResult.metadata,
        captured: modelResult.captured,
        emitVisibleChunk: (text) => sendSSE(res, { event: 'chunk', data: { text } }),
      });
      accumulatedText = resolution.accumulatedText;
      metadata = resolution.metadata;
      isDispatchMessage = resolution.isDispatchMessage;

      finalizeTurnMetrics(turnId);

    } catch (error) {
      logger.error(`[sendMessageStream:${requestId}] Stream error:`, error);
      streamError = error instanceof Error ? error : new Error(String(error));
    }

    // On stream failure the user message is removed so a retry starts fresh,
    // and no AI message is saved.
    if (streamError) {
      await cleanupFailedStreamTurn({
        requestId,
        sessionId,
        userId: user.id,
        userMessageId: userMessage.id,
      });

      // Send SSE error event if client still connected
      if (!clientDisconnected) {
        sendSSE(res, {
          event: 'error',
          data: {
            message: 'An error occurred while generating the response.',
            retryable: true,
          },
        });
      }

      // End response and return early - do NOT save fallback AI message
      res.end();
      logger.info(`[sendMessageStream:${requestId}] ========== SSE STREAM ENDED (ERROR) ==========`);
      return;
    }

    await applyStage3NeedActions({
      requestId,
      sessionId,
      userId: user.id,
      currentStage,
      refiningNeedContext,
      userContent: content,
      aiResponseText: accumulatedText,
      metadata,
    });

    // Signal that text streaming is complete (before DB saves for faster UX)
    if (!clientDisconnected) {
      sendSSE(res, { event: 'metadata', data: { metadata } });
      sendSSE(res, { event: 'text_complete', data: { metadata } });
    }

    const aiMessage = await saveAiTurnMessage({
      requestId,
      sessionId,
      userId: user.id,
      accumulatedText,
      effectiveStage,
      refiningNeedContext,
    });

    await persistTurnState({
      requestId,
      sessionId,
      userId: user.id,
      currentStage,
      effectiveStage,
      isInvitationPhase,
      session,
      progress,
      userMessageId: userMessage.id,
      userContent: content,
      aiMessageContent: aiMessage.content,
      metadata,
    });

    // Send complete event (streamError case is handled above with early return)
    if (!clientDisconnected) {
      sendSSE(res, { event: 'complete', data: { messageId: aiMessage.id, metadata } });
    }

    scheduleStreamTurnBackgroundJobs({
      requestId,
      sessionId,
      userId: user.id,
      turnId,
      isDispatchMessage,
      content,
      history,
      partnerName,
    });

    // End response
    res.end();
    logger.info(`[sendMessageStream:${requestId}] ========== SSE STREAM COMPLETE ==========`);

  } catch (error) {
    logger.error(`[sendMessageStream:${requestId}] Error:`, error);

    // If headers already sent, try to send error event
    if (res.headersSent) {
      try {
        sendSSE(res, {
          event: 'error',
          data: {
            message: 'An unexpected error occurred.',
            retryable: true,
          },
        });
        res.end();
      } catch {
        // Ignore - client may have disconnected
      }
    } else {
      res.status(500).json({ error: 'Failed to process message' });
    }
  }
}
