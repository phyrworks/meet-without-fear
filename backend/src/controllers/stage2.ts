/**
 * Stage 2 Controller
 *
 * Handles the Perspective Stretch / Empathy stage endpoints:
 * - POST /sessions/:id/empathy/draft - Save empathy draft
 * - GET /sessions/:id/empathy/draft - Get current draft
 * - POST /sessions/:id/empathy/consent - Consent to share
 * - GET /sessions/:id/empathy/partner - Get partner's empathy
 * - POST /sessions/:id/empathy/validate - Validate partner's empathy
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import {
  EmpathyStatus,
  MessageRole,
  saveEmpathyDraftRequestSchema,
  consentToShareRequestSchema,
  validateEmpathyRequestSchema,
  skipRefinementRequestSchema,
  saveValidationFeedbackDraftRequestSchema,
  refineValidationFeedbackRequestSchema,
} from '@meet-without-fear/shared';
import { notifyPartner } from '../services/realtime';
import { successResponse, errorResponse } from '../utils/response';
import { getModelCompletion, getSonnetResponse, BrainActivityCallType } from '../lib/bedrock';
import { extractJsonFromResponse } from '../utils/json-extractor';
import { embedSessionContent } from '../services/embedding';
import { updateSessionSummary } from '../services/conversation-summarizer';
import {
  runReconciler,
  getShareSuggestionForUser,
  respondToShareSuggestion as reconcilerRespondToShareSuggestion,
  getSharedContextForGuesser,
  generateShareSuggestionForDirection,
  hasContextAlreadyBeenShared,
  markResultHandledAlreadyShared,
  incrementAttempts,
  generateValidationFeedbackReflection,
} from '../services/reconciler';
import { isSessionCreator } from '../utils/session';
import { publishSessionEvent } from '../services/realtime';
import { updateContext } from '../lib/request-context';
import { routeModel, scoreAmbiguity } from '../services/model-router';
import { transition } from '../services/empathy-state-machine';
import { cleanVisibleAIText } from '../utils/visible-text';
import { findMessageByContent } from '../utils/message-dedupe';

// ============================================================================
// Types
// ============================================================================

interface SessionWithRelationship {
  id: string;
  status: string;
  relationship: {
    members: Array<{ userId: string }>;
  };
}

// ============================================================================
// Helper: Trigger Reconciler and Update Statuses
// ============================================================================

/**
 * Runs the reconciler for both directions and updates empathy attempt statuses
 * based on the results. Called when both users have consented to share.
 */
async function triggerReconcilerAndUpdateStatuses(sessionId: string): Promise<void> {

  try {
    // Run reconciler for both directions
    const result = await runReconciler(sessionId);

    if (!result.bothCompleted) {
      logger.warn(`[triggerReconcilerAndUpdateStatuses] Reconciler incomplete: ${result.blockingReason}`);
      return;
    }

    // Get session participants to map results to attempts
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        relationship: {
          include: {
            members: {
              include: { user: { select: { id: true } } },
            },
          },
        },
      },
    });

    if (!session || session.relationship.members.length !== 2) {
      logger.warn('[triggerReconcilerAndUpdateStatuses] Session not found or invalid members');
      return;
    }

    const userAId = session.relationship.members[0].user.id;
    const userBId = session.relationship.members[1].user.id;

    // Fetch current empathy attempt statuses to avoid overriding statuses
    // already set by the asymmetric reconciler (runReconcilerForDirection).
    // When User A shares empathy before User B, the asymmetric reconciler runs
    // for A→B when B completes Stage 1. Later when B shares empathy, this
    // symmetric path runs for both directions. Without this guard, A's status
    // (already READY or AWAITING_SHARING) would be redundantly overwritten,
    // causing duplicate events and potential state confusion.
    const alreadyProcessed = new Set(['READY', 'AWAITING_SHARING', 'REFINING', 'REVEALED', 'VALIDATED']);
    const [currentAttemptA, currentAttemptB] = await Promise.all([
      prisma.empathyAttempt.findFirst({ where: { sessionId, sourceUserId: userAId } }),
      prisma.empathyAttempt.findFirst({ where: { sessionId, sourceUserId: userBId } }),
    ]);
    const shouldUpdateA = currentAttemptA && !alreadyProcessed.has(currentAttemptA.status);
    const shouldUpdateB = currentAttemptB && !alreadyProcessed.has(currentAttemptB.status);

    // Track new statuses for notification
    let statusA: EmpathyStatus | null = null;
    let statusB: EmpathyStatus | null = null;

    // Update empathy attempt for User A (A's guess about B)
    if (result.aUnderstandingB && shouldUpdateA) {
      const hasSignificantGapsA =
        result.aUnderstandingB.recommendation.action === 'OFFER_SHARING' ||
        (
          result.aUnderstandingB.recommendation.action === 'OFFER_OPTIONAL' &&
          !!result.aUnderstandingB.recommendation.suggestedShareFocus
        );

      // Check if B has already shared context with A to prevent infinite loop
      // When A has gaps guessing B, B (subject) should share with A (guesser)
      const contextAlreadySharedToA = hasSignificantGapsA
        ? await hasContextAlreadyBeenShared(sessionId, userAId, userBId)
        : false;

      // If context was already shared, treat as READY (skip sharing step)
      // Otherwise, use AWAITING_SHARING if gaps exist
      if (contextAlreadySharedToA) {
        logger.info(
          `[triggerReconcilerAndUpdateStatuses] Context already shared B→A, skipping AWAITING_SHARING for User A`
        );
        statusA = EmpathyStatus.READY;
        await markResultHandledAlreadyShared(sessionId, userAId, userBId);
      } else {
        statusA = hasSignificantGapsA ? EmpathyStatus.AWAITING_SHARING : EmpathyStatus.READY;
      }

      await prisma.empathyAttempt.updateMany({
        where: { sessionId, sourceUserId: userAId },
        data: {
          status: statusA,
          statusVersion: { increment: 1 },
        },
      });

      logger.info(
        `[triggerReconcilerAndUpdateStatuses] Updated User A's attempt to ${statusA} ` +
        `(alignment: ${result.aUnderstandingB.alignment.score}%, gaps: ${result.aUnderstandingB.gaps.severity})`
      );

      // Only generate share suggestion if AWAITING_SHARING and context not already shared
      if (statusA === EmpathyStatus.AWAITING_SHARING) {
        await generateShareSuggestionForDirection(sessionId, userAId, userBId);

        // Notify the subject (User B) about the share suggestion so their UI shows ShareTopicPanel
        const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
        const empathyStatusB = await buildEmpathyExchangeStatus(sessionId, userBId);
        await notifyPartner(sessionId, userBId, 'empathy.share_suggestion', {
          forUserId: userBId,
          guesserName: 'your partner',
          empathyStatus: empathyStatusB,
          triggeredByUserId: userBId,
        });
        logger.info(`[triggerReconcilerAndUpdateStatuses] Published share_suggestion for subject User B`);
      }
    } else if (result.aUnderstandingB && !shouldUpdateA) {
      // A→B direction already processed by asymmetric reconciler — preserve current status
      statusA = (currentAttemptA?.status as EmpathyStatus) ?? null;
      logger.info(
        `[triggerReconcilerAndUpdateStatuses] Skipping User A update — already processed by asymmetric reconciler (status: ${statusA})`
      );
    }

    // Update empathy attempt for User B (B's guess about A)
    if (result.bUnderstandingA && shouldUpdateB) {
      const hasSignificantGapsB =
        result.bUnderstandingA.recommendation.action === 'OFFER_SHARING' ||
        (
          result.bUnderstandingA.recommendation.action === 'OFFER_OPTIONAL' &&
          !!result.bUnderstandingA.recommendation.suggestedShareFocus
        );

      // Check if A has already shared context with B to prevent infinite loop
      // When B has gaps guessing A, A (subject) should share with B (guesser)
      const contextAlreadySharedToB = hasSignificantGapsB
        ? await hasContextAlreadyBeenShared(sessionId, userBId, userAId)
        : false;

      // If context was already shared, treat as READY (skip sharing step)
      // Otherwise, use AWAITING_SHARING if gaps exist
      if (contextAlreadySharedToB) {
        logger.info(
          `[triggerReconcilerAndUpdateStatuses] Context already shared A→B, skipping AWAITING_SHARING for User B`
        );
        statusB = EmpathyStatus.READY;
        await markResultHandledAlreadyShared(sessionId, userBId, userAId);
      } else {
        statusB = hasSignificantGapsB ? EmpathyStatus.AWAITING_SHARING : EmpathyStatus.READY;
      }

      await prisma.empathyAttempt.updateMany({
        where: { sessionId, sourceUserId: userBId },
        data: {
          status: statusB,
          statusVersion: { increment: 1 },
        },
      });

      logger.info(
        `[triggerReconcilerAndUpdateStatuses] Updated User B's attempt to ${statusB} ` +
        `(alignment: ${result.bUnderstandingA.alignment.score}%, gaps: ${result.bUnderstandingA.gaps.severity})`
      );

      // Only generate share suggestion if AWAITING_SHARING and context not already shared
      if (statusB === EmpathyStatus.AWAITING_SHARING) {
        await generateShareSuggestionForDirection(sessionId, userBId, userAId);

        // Notify the subject (User A) about the share suggestion so their UI shows ShareTopicPanel
        const { buildEmpathyExchangeStatus: buildStatusForA } = await import('../services/empathy-status');
        const empathyStatusA = await buildStatusForA(sessionId, userAId);
        await notifyPartner(sessionId, userAId, 'empathy.share_suggestion', {
          forUserId: userAId,
          guesserName: 'your partner',
          empathyStatus: empathyStatusA,
          triggeredByUserId: userAId,
        });
        logger.info(`[triggerReconcilerAndUpdateStatuses] Published share_suggestion for subject User A`);
      }
    } else if (result.bUnderstandingA && !shouldUpdateB) {
      // B→A direction already processed by asymmetric reconciler — preserve current status
      statusB = (currentAttemptB?.status as EmpathyStatus) ?? null;
      logger.info(
        `[triggerReconcilerAndUpdateStatuses] Skipping User B update — already processed by asymmetric reconciler (status: ${statusB})`
      );
    }

    // Notify both clients that empathy statuses have been updated
    // This allows the UI to immediately show share suggestions or reveal empathy
    // Include full empathy status for both users to avoid extra HTTP round-trips
    const { buildEmpathyExchangeStatusForBothUsers } = await import('../services/empathy-status');
    const allStatuses = await buildEmpathyExchangeStatusForBothUsers(sessionId);
    await publishSessionEvent(sessionId, 'empathy.status_updated', {
      stage: 2,
      statuses: {
        [userAId]: statusA,
        [userBId]: statusB,
      },
      empathyStatuses: allStatuses,
    });
    logger.info(`[triggerReconcilerAndUpdateStatuses] Published empathy.status_updated event with full status data`);

    // Always check if both are now READY and reveal both simultaneously
    const { checkAndRevealBothIfReady } = await import('../services/reconciler');
    await checkAndRevealBothIfReady(sessionId);
  } catch (error) {
    logger.error('[triggerReconcilerAndUpdateStatuses] Error:', error);
    throw error;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get partner's user ID from session data
 */
function getPartnerUserIdFromSession(
  session: SessionWithRelationship,
  currentUserId: string
): string | null {
  const partner = session.relationship.members.find(
    (m) => m.userId !== currentUserId
  );

  return partner?.userId ?? null;
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * Save or update empathy draft
 * POST /sessions/:id/empathy/draft
 */
export async function saveDraft(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Validate request body
    const parseResult = saveEmpathyDraftRequestSchema.safeParse(req.body);
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

    const { content, readyToShare } = parseResult.data;

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

    // Check session allows saving draft
    // Allow ACTIVE status for all users, and INVITED status for the session creator
    if (session.status !== 'ACTIVE') {
      if (session.status === 'INVITED') {
        const isCreator = await isSessionCreator(sessionId, user.id);
        if (!isCreator) {
          errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
          return;
        }
        // Creator can proceed while session is INVITED
      } else {
        errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
        return;
      }
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { stage: 'desc' },
    });

    // Check user is in stage 2
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 2) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot save empathy draft: you are in stage ${currentStage}, but stage 2 is required`,
        400
      );
      return;
    }

    // Upsert empathy draft
    // Important: if readyToShare is omitted, preserve existing readyToShare value.
    const updateData: { content: string; readyToShare?: boolean; version: { increment: number } } = {
      content,
      version: { increment: 1 },
    };
    if (typeof readyToShare === 'boolean') {
      updateData.readyToShare = readyToShare;
    }

    const draft = await prisma.empathyDraft.upsert({
      where: {
        sessionId_userId: {
          sessionId,
          userId: user.id,
        },
      },
      create: {
        sessionId,
        userId: user.id,
        content,
        readyToShare: typeof readyToShare === 'boolean' ? readyToShare : false,
        version: 1,
      },
      update: updateData,
    });

    successResponse(res, {
      draftId: draft.id,
      savedAt: draft.updatedAt.toISOString(),
      readyToShare: draft.readyToShare,
    });
  } catch (error) {
    logger.error('[saveDraft] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to save draft', 500);
  }
}

/**
 * Get current empathy draft
 * GET /sessions/:id/empathy/draft
 */
export async function getDraft(req: Request, res: Response): Promise<void> {
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

    // Get draft
    const draft = await prisma.empathyDraft.findUnique({
      where: {
        sessionId_userId: {
          sessionId,
          userId: user.id,
        },
      },
    });

    // Check if user has already consented to share
    const existingConsent = await prisma.consentRecord.findFirst({
      where: {
        userId: user.id,
        sessionId,
        targetType: 'EMPATHY_DRAFT',
        decision: 'GRANTED',
      },
    });

    // Check if user is in REFINING state (received shared context, revising empathy)
    const myAttempt = await prisma.empathyAttempt.findFirst({
      where: { sessionId, sourceUserId: user.id },
      select: { status: true },
    });
    const isRefining = myAttempt?.status === 'REFINING';

    // Can consent if draft exists and is ready to share AND:
    // - No existing consent (first time), OR
    // - User is in REFINING state (resubmission after receiving partner's shared context)
    const canConsent = !!(draft && draft.readyToShare && (!existingConsent || isRefining));
    const alreadyConsented = !!existingConsent;

    successResponse(res, {
      draft: draft
        ? {
          id: draft.id,
          content: draft.content,
          readyToShare: draft.readyToShare,
          version: draft.version,
          updatedAt: draft.updatedAt.toISOString(),
        }
        : null,
      canConsent,
      alreadyConsented,
    });
  } catch (error) {
    logger.error('[getDraft] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get draft', 500);
  }
}

/**
 * Consent to share empathy with partner
 * POST /sessions/:id/empathy/consent
 */
export async function consentToShare(
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
    const parseResult = consentToShareRequestSchema.safeParse(req.body);
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

    const { consent } = parseResult.data;

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
            members: true,
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check session allows consent
    // Allow ACTIVE status for all users, and INVITED status for the session creator
    if (session.status !== 'ACTIVE') {
      if (session.status === 'INVITED') {
        const isCreator = await isSessionCreator(sessionId, user.id);
        if (!isCreator) {
          errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
          return;
        }
        // Creator can proceed while session is INVITED
      } else {
        errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
        return;
      }
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { stage: 'desc' },
    });

    // Check user is in stage 2
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 2) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot consent to share: you are in stage ${currentStage}, but stage 2 is required`,
        400
      );
      return;
    }

    // Get draft and check it's ready to share
    const draft = await prisma.empathyDraft.findUnique({
      where: {
        sessionId_userId: {
          sessionId,
          userId: user.id,
        },
      },
    });

    if (!draft || !draft.readyToShare) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Draft must be marked as ready to share before consenting',
        400
      );
      return;
    }

    // Get partner ID from session data
    const partnerId = getPartnerUserIdFromSession(session, user.id);

    const respondWithExistingAttempt = async (existingAttempt: {
      id: string;
      content: string;
      sharedAt: Date;
      status: EmpathyStatus;
    }) => {
      const [partnerAttempt, existingEmpathyMessage] = await Promise.all([
        partnerId
          ? prisma.empathyAttempt.findFirst({
            where: {
              sessionId,
              sourceUserId: partnerId,
            },
          })
          : Promise.resolve(null),
        prisma.message.findFirst({
          where: {
            sessionId,
            senderId: user.id,
            forUserId: user.id,
            role: 'EMPATHY_STATEMENT',
            stage: 2,
          },
          orderBy: { timestamp: 'desc' },
        }),
      ]);

      successResponse(res, {
        consented: true,
        consentedAt: existingAttempt.sharedAt.toISOString(),
        partnerConsented: !!partnerAttempt,
        canReveal: !!partnerAttempt && consent,
        status: existingAttempt.status,
        empathyMessage: {
          id: existingEmpathyMessage?.id ?? existingAttempt.id,
          content: existingEmpathyMessage?.content ?? existingAttempt.content,
          timestamp: (existingEmpathyMessage?.timestamp ?? existingAttempt.sharedAt).toISOString(),
          stage: existingEmpathyMessage?.stage ?? 2,
        },
        transitionMessage: null,
      });
    };

    // Idempotency: if this user already shared an empathy attempt, treat a
    // retry/double-click as success instead of creating duplicate consent
    // records and returning a conflict.
    const existingAttempt = await prisma.empathyAttempt.findFirst({
      where: {
        sessionId,
        sourceUserId: user.id,
        status: { not: 'REFINING' },
      },
      orderBy: { sharedAt: 'desc' },
    });

    if (existingAttempt) {
      await respondWithExistingAttempt(existingAttempt);
      return;
    }

    // Create consent record
    await prisma.consentRecord.create({
      data: {
        userId: user.id,
        sessionId,
        targetType: 'EMPATHY_DRAFT',
        targetId: draft.id,
        requestedByUserId: user.id,
        decision: consent ? 'GRANTED' : 'DENIED',
        decidedAt: new Date(),
      },
    });

    // Create empathy attempt (shared copy) with HELD status
    // The status will transition to ANALYZING when partner also consents
    let empathyAttempt;
    try {
      empathyAttempt = await prisma.empathyAttempt.create({
        data: {
          draftId: draft.id,
          sessionId,
          sourceUserId: user.id,
          content: draft.content,
          sharedAt: new Date(),
          status: 'HELD', // Wait for partner to also consent
        },
      });
    } catch (err: any) {
      // Unique constraint violation (P2002) — duplicate empathy attempt for this user+session
      if (err?.code === 'P2002') {
        const concurrentAttempt = await prisma.empathyAttempt.findFirst({
          where: { sessionId, sourceUserId: user.id },
          orderBy: { sharedAt: 'desc' },
        });
        if (concurrentAttempt) {
          await respondWithExistingAttempt(concurrentAttempt);
          return;
        }
        errorResponse(res, 'CONFLICT', 'Empathy attempt already exists for this session', 409);
        return;
      }
      throw err;
    }

    // Get partner name for messages
    let partnerName: string | undefined;
    if (partnerId) {
      const partner = await prisma.user.findUnique({
        where: { id: partnerId },
        select: { firstName: true, name: true },
      });
      partnerName = partner?.firstName || partner?.name || undefined;
    }

    // Save empathy statement as a message in the chat history
    // This creates the "Empathy statement sent" line with the statement content
    const empathyMessage = await prisma.message.create({
      data: {
        sessionId,
        senderId: user.id,
        forUserId: user.id,
        role: 'EMPATHY_STATEMENT', // Special role for empathy statements
        content: draft.content,
        stage: 2,
      },
    });

    // Create turnId for this user action - all operations use the same turnId for cost attribution
    const turnId = `${sessionId}-${user.id}-consent-share`;
    // Update request context so all downstream code can access this turnId
    updateContext({ turnId, sessionId, userId: user.id });

    // Summarize and embed session content (non-blocking)
    // Per fact-ledger architecture, we embed at session level after summary updates
    updateSessionSummary(sessionId, user.id, turnId)
      .then(() => embedSessionContent(sessionId, user.id, turnId))
      .catch((err: unknown) =>
        logger.warn('[consentToShare] Failed to update summary/embedding:', err)
      );

    // Check if partner has also consented (only if we have a partner)
    let partnerAttempt = null;
    if (partnerId) {
      partnerAttempt = await prisma.empathyAttempt.findFirst({
        where: {
          sessionId,
          sourceUserId: partnerId,
        },
      });

      // If both have shared, transition both to ANALYZING and run reconciler
      if (partnerAttempt) {
        // Update both attempts to ANALYZING status
        await prisma.empathyAttempt.updateMany({
          where: {
            sessionId,
            sourceUserId: { in: [user.id, partnerId] },
            status: 'HELD',
          },
          data: {
            status: 'ANALYZING',
            statusVersion: { increment: 1 },
          },
        });

        // Update the local empathyAttempt object to reflect new status
        empathyAttempt.status = 'ANALYZING';

        // Kick off reconciler in background - it will update statuses to REVEALED or NEEDS_WORK
        triggerReconcilerAndUpdateStatuses(sessionId).catch((err) =>
          logger.warn('[consentToShare] Failed to run reconciler after both shared:', err)
        );
      }
    }

    // Notify partner via real-time - include full empathy status
    if (partnerId) {
      const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
      const partnerEmpathyStatus = await buildEmpathyExchangeStatus(sessionId, partnerId);
      await notifyPartner(sessionId, partnerId, 'partner.empathy_shared', {
        stage: 2,
        sharedBy: user.id,
        empathyStatus: partnerEmpathyStatus,
      });
    }

    // Generate transition message when user shares empathy
    let transitionMessage: {
      id: string;
      content: string;
      timestamp: string;
      stage: number;
    } | null = null;

    try {
      const bothShared = !!partnerAttempt;
      let transitionContent = bothShared
        ? `Your empathy attempt has been submitted. Both empathy statements are now submitted. We'll show the next review or waiting step once the privacy-protected review is ready.`
        : `Your empathy attempt has been submitted. ${partnerName || 'Your partner'} will do the same perspective-taking step on their side. While you wait, you can use Inner Thoughts if you want a private place to process what came up.`;

      transitionContent = cleanVisibleAIText(transitionContent)
        .replace(new RegExp(['once you both feel', 'move forward together'].join('[^.]*'), 'gi'),
          'If something feels off, you can say what is missing before the process continues.')
        .replace(new RegExp(['before', 'moving forward together'].join('\\s+'), 'gi'),
          'before the process continues');

      // Save the transition message to the database
      const aiMessage = await prisma.message.create({
        data: {
          sessionId,
          senderId: null,
          forUserId: user.id,
          role: 'AI',
          content: transitionContent,
          stage: 2,
        },
      });

      // Summarize and embed session content (non-blocking)
      // Per fact-ledger architecture, we embed at session level after summary updates
      updateSessionSummary(sessionId, user.id, turnId)
        .then(() => embedSessionContent(sessionId, user.id, turnId))
        .catch((err: unknown) =>
          logger.warn('[consentToShare] Failed to update summary/embedding after transition:', err)
        );

      transitionMessage = {
        id: aiMessage.id,
        content: aiMessage.content,
        timestamp: aiMessage.timestamp.toISOString(),
        stage: aiMessage.stage,
      };


      // Audit log the transition message
      /* auditLog('RESPONSE', 'Stage 2 transition message generated', {
        turnId,
        sessionId,
        userId: user.id,
        stage: 2,
        operation: 'stage2-transition',
        responseText: transitionContent,
        messageId: aiMessage.id,
      }); */
    } catch (error) {
      logger.error('[consentToShare] Failed to generate transition message:', error);
      // Continue without transition message - not a critical failure
    }

    successResponse(res, {
      consented: consent,
      consentedAt: empathyAttempt.sharedAt?.toISOString() ?? null,
      partnerConsented: !!partnerAttempt,
      canReveal: !!partnerAttempt && consent,
      status: empathyAttempt.status, // HELD if partner hasn't shared, ANALYZING if both shared
      empathyMessage: {
        id: empathyMessage.id,
        content: empathyMessage.content,
        timestamp: empathyMessage.timestamp.toISOString(),
        stage: empathyMessage.stage,
      },
      transitionMessage,
    });
  } catch (error) {
    logger.error('[consentToShare] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to consent to share', 500);
  }
}

/**
 * Get partner's empathy attempt
 * GET /sessions/:id/empathy/partner
 */
export async function getPartnerEmpathy(
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
      include: {
        relationship: {
          include: {
            members: true,
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Get partner's user ID from session data
    const partnerId = getPartnerUserIdFromSession(session, user.id);

    // Get partner's empathy attempt (only if we have a partner)
    const partnerAttempt = partnerId
      ? await prisma.empathyAttempt.findFirst({
          where: {
            sessionId,
            sourceUserId: partnerId,
          },
        })
      : null;

    // Only reveal partner's attempt if status is REVEALED or VALIDATED
    // This is the key change from the reconciler flow design
    const canRevealPartnerAttempt = partnerAttempt &&
      (partnerAttempt.status === 'REVEALED' || partnerAttempt.status === 'VALIDATED');

    // Determine whether current user has validated partner attempt
    const validation = canRevealPartnerAttempt
      ? await prisma.empathyValidation.findUnique({
        where: {
          attemptId_userId: {
            attemptId: partnerAttempt.id,
            userId: user.id,
          },
        },
      })
      : null;

    successResponse(res, {
      // Only return the attempt content if it's REVEALED or VALIDATED
      attempt: canRevealPartnerAttempt
        ? {
          id: partnerAttempt.id,
          sourceUserId: partnerAttempt.sourceUserId ?? '',
          content: partnerAttempt.content,
          sharedAt: partnerAttempt.sharedAt.toISOString(),
          consentRecordId: partnerAttempt.consentRecordId ?? '',
          status: partnerAttempt.status,
          revealedAt: partnerAttempt.revealedAt?.toISOString() ?? null,
          validatedAt: validation?.validated ? validation.validatedAt?.toISOString() ?? null : null,
          revisionCount: partnerAttempt.revisionCount,
          statusVersion: partnerAttempt.statusVersion,
        }
        : null,
      // Waiting if no attempt exists, or if it exists but isn't revealed yet
      waitingForPartner: !partnerAttempt || !canRevealPartnerAttempt,
      // Partner's current status (even if not revealed, so UI can show appropriate message)
      partnerStatus: partnerAttempt?.status ?? null,
      validated: validation ? validation.validated : false,
      validatedAt: validation?.validatedAt?.toISOString() ?? null,
      awaitingRevision: validation ? validation.validated === false : false,
    });
  } catch (error) {
    logger.error('[getPartnerEmpathy] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get partner empathy', 500);
  }
}

/**
 * Validate partner's empathy attempt
 * POST /sessions/:id/empathy/validate
 */
export async function validateEmpathy(
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
    const parseResult = validateEmpathyRequestSchema.safeParse(req.body);
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

    const { validated, feedback } = parseResult.data;
    const trimmedFeedback = feedback?.trim();

    if (!validated && !trimmedFeedback) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Feedback is required when empathy is not validated',
        400
      );
      return;
    }

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
            members: true,
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check session allows validation
    // Allow ACTIVE status for all users, and INVITED status for the session creator
    if (session.status !== 'ACTIVE') {
      if (session.status === 'INVITED') {
        const isCreator = await isSessionCreator(sessionId, user.id);
        if (!isCreator) {
          errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
          return;
        }
        // Creator can proceed while session is INVITED
      } else {
        errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
        return;
      }
    }

    // Get user's current stage progress
    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { stage: 'desc' },
    });

    // Check user is in stage 2
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 2) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot validate empathy: you are in stage ${currentStage}, but stage 2 is required`,
        400
      );
      return;
    }

    // Get partner ID from session data
    const partnerId = getPartnerUserIdFromSession(session, user.id);

    // Get partner's empathy attempt (only if we have a partner)
    const partnerAttempt = partnerId
      ? await prisma.empathyAttempt.findFirst({
          where: {
            sessionId,
            sourceUserId: partnerId,
          },
        })
      : null;

    if (!partnerAttempt) {
      errorResponse(res, 'NOT_FOUND', 'Partner empathy attempt not found', 404);
      return;
    }

    if (partnerAttempt.status !== 'REVEALED' && partnerAttempt.status !== 'VALIDATED') {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Partner empathy is not ready for validation yet',
        409
      );
      return;
    }

    const now = new Date();

    // Create or update validation record (unique on attemptId+userId)
    const validationRecord = await prisma.empathyValidation.upsert({
      where: {
        attemptId_userId: {
          attemptId: partnerAttempt.id,
          userId: user.id,
        },
      },
      create: {
        attemptId: partnerAttempt.id,
        sessionId,
        userId: user.id,
        validated,
        feedback: trimmedFeedback,
        feedbackShared: !validated,
        validatedAt: now,
      },
      update: {
        validated,
        feedback: trimmedFeedback,
        feedbackShared: !validated,
        validatedAt: now,
      },
    });

    // If validated, update partner's empathy attempt status to VALIDATED and mark as SEEN
    if (validated) {
      await prisma.empathyAttempt.update({
        where: { id: partnerAttempt.id },
        data: {
          status: 'VALIDATED',
          statusVersion: { increment: 1 },
          deliveryStatus: 'SEEN',
          seenAt: new Date(),
        },
      });
    } else if (trimmedFeedback && partnerId) {
      const newStatus = transition(
        partnerAttempt.status as EmpathyStatus,
        'VALIDATION_FEEDBACK_SENT'
      );
      await prisma.empathyAttempt.update({
        where: { id: partnerAttempt.id },
        data: {
          status: newStatus,
          statusVersion: { increment: 1 },
          deliveryStatus: 'DELIVERED',
          deliveredAt: now,
        },
      });

      // Get names for AI framing message
      const [validatorUser, guesserUser] = await Promise.all([
        prisma.user.findUnique({
          where: { id: user.id },
          select: { firstName: true, name: true },
        }),
        prisma.user.findUnique({
          where: { id: partnerId },
          select: { firstName: true, name: true },
        }),
      ]);
      const validatorName = validatorUser?.firstName || validatorUser?.name || 'your partner';
      const guesserName = guesserUser?.firstName || guesserUser?.name || 'User';

      // Generate AI framing message before showing feedback card
      const framingMessage = await generateValidationFeedbackReflection(
        sessionId,
        guesserName,
        validatorName,
      );

      // Create messages with guaranteed ordering (100ms apart)
      const baseTime = now.getTime();
      const framingTimestamp = new Date(baseTime);
      const feedbackTimestamp = new Date(baseTime + 100);

      // AI framing message — introduces the feedback to the guesser
      await prisma.message.create({
        data: {
          sessionId,
          senderId: null,
          forUserId: partnerId,
          role: MessageRole.AI,
          content: framingMessage,
          stage: 2,
          timestamp: framingTimestamp,
        },
      });

      // VALIDATION_FEEDBACK card — the actual feedback content
      await prisma.message.create({
        data: {
          sessionId,
          senderId: user.id,
          forUserId: partnerId,
          role: MessageRole.VALIDATION_FEEDBACK,
          content: trimmedFeedback,
          stage: 2,
          timestamp: feedbackTimestamp,
        },
      });
    }

    // Update stage progress gates
    await prisma.stageProgress.update({
      where: {
        sessionId_userId_stage: {
          sessionId,
          userId: user.id,
          stage: 2,
        },
      },
      data: {
        gatesSatisfied: {
          empathyValidated: validated,
          validatedAt: now.toISOString(),
        },
      },
    });

    // Notify partner via realtime - include empathy status for cache update
    if (partnerId) {
      const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
      const partnerEmpathyStatus = await buildEmpathyExchangeStatus(sessionId, partnerId);

      if (validated) {
        await notifyPartner(sessionId, partnerId, 'partner.stage_completed', {
          stage: 2,
          validated,
          completedBy: user.id,
          empathyStatus: partnerEmpathyStatus,
          // Include triggeredByUserId so frontend can filter out events triggered by self
          triggeredByUserId: user.id,
        }, { excludeUserId: user.id }); // Exclude actor to prevent race conditions
      }

      await notifyPartner(sessionId, partnerId, 'empathy.status_updated', {
        status: validated ? 'VALIDATED' : 'REFINING',
        // Include forUserId so mobile can filter - only the guesser whose empathy was validated/refined should see modal
        forUserId: partnerId,
        empathyStatus: partnerEmpathyStatus,
        validatedBy: user.id,
        feedbackShared: !validated,
        validationFeedback: !validated ? trimmedFeedback : undefined,
        // Include triggeredByUserId so frontend can filter out events triggered by self
        triggeredByUserId: user.id,
      }, { excludeUserId: user.id }); // Exclude actor to prevent race conditions
    }

    // Determine whether partner has validated my empathy attempt
    const myAttempt = await prisma.empathyAttempt.findFirst({
      where: {
        sessionId,
        sourceUserId: user.id,
      },
    });
    const partnerValidation = partnerId && myAttempt
      ? await prisma.empathyValidation.findUnique({
        where: {
          attemptId_userId: {
            attemptId: myAttempt.id,
            userId: partnerId,
          },
        },
      })
      : null;

    const partnerHasValidatedMyAttempt = partnerValidation?.validated === true;
    if (validated && !partnerHasValidatedMyAttempt) {
      const waitMessage =
        "You confirmed this feels right. We'll hold here while your partner reviews what you shared. Once they respond, we'll move you into the next step.";

      // Matched on contentHash, not content: the content column is encrypted with
      // a random IV per write, so equality on it can never match. See
      // utils/message-dedupe.ts.
      const existingWaitMessage = await findMessageByContent(prisma.message, {
        sessionId,
        forUserId: user.id,
        role: MessageRole.AI,
        content: waitMessage,
      });

      if (!existingWaitMessage) {
        await prisma.message.create({
          data: {
            sessionId,
            senderId: null,
            forUserId: user.id,
            role: MessageRole.AI,
            content: waitMessage,
            stage: 2,
            timestamp: now,
          },
        });
      }
    }

    successResponse(res, {
      validated,
      validatedAt: now.toISOString(),
      feedbackShared: validationRecord.feedbackShared,
      awaitingRevision: validated === false,
      canAdvance: validated,
      partnerValidated: partnerHasValidatedMyAttempt,
    });

    // Check if both have validated (Accurate/Partial) and trigger transition
    if (validated && partnerHasValidatedMyAttempt) {
      triggerStage3Transition(sessionId, user.id, partnerId).catch(err =>
        logger.error('[validateEmpathy] Failed to trigger stage 3 transition:', err)
      );
    }

  } catch (error) {
    logger.error('[validateEmpathy] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to validate empathy', 500);
  }
}

/**
 * Handle "Skip Refinement" / "Acceptance Check"
 * POST /sessions/:id/empathy/skip-refinement
 */
export async function skipRefinement(
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

    const parseResult = skipRefinementRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400);
      return;
    }

    const { willingToAccept, reason } = parseResult.data;

    // Get user's empathy attempt
    const attempt = await prisma.empathyAttempt.findFirst({
      where: { sessionId, sourceUserId: user.id },
    });

    if (!attempt) {
      errorResponse(res, 'NOT_FOUND', 'Empathy attempt not found', 404);
      return;
    }

    // Create validation record with skip status
    await prisma.empathyValidation.upsert({
      where: {
        attemptId_userId: {
          attemptId: attempt.id,
          userId: user.id
        }
      },
      create: {
        attemptId: attempt.id,
        sessionId,
        userId: user.id,
        validated: true, // Treated as validated for gate purposes
        feedback: willingToAccept ? 'ACCEPTED_DIFFERENCE' : `REJECTED_OTHER_EXPERIENCE: ${reason || ''}`,
      },
      update: {
        validated: true,
        feedback: willingToAccept ? 'ACCEPTED_DIFFERENCE' : `REJECTED_OTHER_EXPERIENCE: ${reason || ''}`,
      }
    });

    // Update attempt status to SKIPPED_REFINEMENT
    await prisma.empathyAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'VALIDATED', // Treat as validated for collecting purposes
        statusVersion: { increment: 1 },
        deliveryStatus: 'SEEN',
      },
    });

    // Mark gate as satisfied
    await prisma.stageProgress.update({
      where: {
        sessionId_userId_stage: {
          sessionId,
          userId: user.id,
          stage: 2,
        },
      },
      data: {
        gatesSatisfied: {
          empathyValidated: true, // Gate passed via skip
          skippedRefinement: true,
          willingToAccept,
          skipReason: reason,
        },
      },
    });

    // Notify partner
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { relationship: { include: { members: true } } }
    });
    const partnerId = getPartnerUserIdFromSession(session as any, user.id);

    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'partner.skipped_refinement', {
        willingToAccept,
      });

      const partnerStage2Progress = await prisma.stageProgress.findUnique({
        where: {
          sessionId_userId_stage: {
            sessionId,
            userId: partnerId,
            stage: 2,
          },
        },
      });
      const partnerGates = partnerStage2Progress?.gatesSatisfied as Record<string, unknown> | null | undefined;
      const partnerCompletedEmpathy = partnerGates?.empathyValidated === true;

      if (partnerCompletedEmpathy) {
        triggerStage3Transition(sessionId, user.id, partnerId).catch((e) => logger.error('[Stage2] Stage 3 transition failed:', e));
      } else {
        logger.info('[skipRefinement] Waiting for partner Stage 2 empathy completion before Stage 3 transition', {
          sessionId,
          userId: user.id,
          partnerId,
        });
      }
    }

    successResponse(res, { success: true });

  } catch (error) {
    logger.error('[skipRefinement] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to skip refinement', 500);
  }
}

/**
 * Save Validation Feedback Draft (Feedback Coach Flow)
 * POST /sessions/:id/empathy/validation-feedback/draft
 */
export async function saveValidationFeedbackDraft(
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

    const parseResult = saveValidationFeedbackDraftRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400);
      return;
    }

    const { content, readyToShare } = parseResult.data;

    const draft = await prisma.validationFeedbackDraft.upsert({
      where: {
        sessionId_userId: {
          sessionId,
          userId: user.id,
        },
      },
      create: {
        sessionId,
        userId: user.id,
        content,
        readyToShare: readyToShare ?? false,
      },
      update: {
        content,
        readyToShare: readyToShare ?? false,
      },
    });

    successResponse(res, {
      draftId: draft.id,
      savedAt: draft.updatedAt.toISOString(),
      readyToShare: draft.readyToShare,
    });
  } catch (error) {
    logger.error('[saveValidationFeedbackDraft] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to save feedback draft', 500);
  }
}

/**
 * Refine Validation Feedback (Feedback Coach Flow)
 * POST /sessions/:id/empathy/validation-feedback/refine
 */
export async function refineValidationFeedback(
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

    const parseResult = refineValidationFeedbackRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400);
      return;
    }

    const { message, history } = parseResult.data;

    // Create turnId
    const turnId = `${sessionId}-${user.id}-feedback-refine-${Date.now()}`;
    updateContext({ turnId, sessionId, userId: user.id });

    const isRefinement = history && history.length > 0;

    // Prompt for feedback coaching
    const systemPrompt = `You are a Feedback Coach for Meet Without Fear.
The user wants to give feedback to their partner about an empathy statement that felt "off" or inaccurate.
Your goal is to help them rephrase their feedback to be constructive, specific, and non-blaming (Non-Violent Communication style).

CRITICAL: Preserve the user's concrete meaning: their specific facts, descriptions, and intensity. The goal is to restructure how they say it, not what they need understood. Do not replace concrete details with vague summaries or softer language. Keep the Meet Without Fear process guardrails: do not preserve personal attacks, threats, ultimatums, or requests for an outside side conversation verbatim; translate those into direct, non-blaming language while preserving the substance.

User's current message: "${message}"

1. Keep the conversational coaching response concise: 1-2 short sentences, no more than 45 words.
2. Acknowledge the validity of their feeling without over-explaining or giving a long lesson.
3. Explicitly tell them they can keep refining or send the proposed feedback as-is.
4. Draft a "Proposed Feedback" statement that they can send inside Meet Without Fear. This should be:
   - Direct and honest — preserve the user's specific words and details.
   - Focus on what was missed or misunderstood.
   - Use "I" framing ("I felt...", "My experience was...") but keep the user's actual details intact.
   - Ask the partner to revise their empathy attempt in the app, not to start a direct side conversation.
   - Do not include wording like "ask me directly", "can we talk about this", "can we try that", or other language that implies the next step is an outside conversation.
   - End with an in-app revision request, such as "Could you revise your understanding with that in mind?"
${isRefinement ? `
IMPORTANT — This is a refinement round. The user has already seen your previous proposed feedback and is now telling you what to adjust. Their current message is a correction directed at YOU (the coach), not new raw feedback about the partner. Apply their adjustment to the most recent proposed feedback, using the history for the original context.` : ''}

Respond in JSON format:
\`\`\`json
{
  "response": "Your conversational coaching response to the user",
  "proposedFeedback": "The refined feedback statement ready to be sent"
}
\`\`\``;

    const routingDecision = routeModel({
      requestType: 'rewrite',
      conflictIntensity: 4,
      ambiguityScore: scoreAmbiguity(message),
      messageLength: message.length,
    });

    // Build message history for context continuity
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (isRefinement) {
      for (const entry of history) {
        messages.push({
          role: entry.role === 'coach' ? 'assistant' : 'user',
          content: entry.content,
        });
      }
      messages.push({ role: 'user', content: message });
    } else {
      messages.push({ role: 'user', content: 'Help me refine this.' });
    }

    const aiResponse = await getModelCompletion(routingDecision.model, {
      systemPrompt,
      messages,
      maxTokens: 512,
      sessionId,
      operation: `feedback-refinement-${routingDecision.model}`,
      turnId,
      callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
    });

    let response = "I'm here to help you phrase that.";
    let proposedFeedback = "";

    if (aiResponse) {
      try {
        const parsed = extractJsonFromResponse(aiResponse) as Record<string, unknown>;
        response = typeof parsed.response === 'string' ? parsed.response : aiResponse;
        proposedFeedback = typeof parsed.proposedFeedback === 'string' ? parsed.proposedFeedback : "";
      } catch {
        response = aiResponse;
      }
    }

    successResponse(res, {
      response,
      proposedFeedback,
    });

  } catch (error) {
    logger.error('[refineValidationFeedback] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to refine feedback', 500);
  }
}

async function triggerStage3Transition(sessionId: string, userId: string, partnerId: string | null) {
  try {
    // 1. Get user names for personalization
    const users = await prisma.user.findMany({
      where: {
        id: { in: [userId, partnerId].filter((id): id is string => id !== null) }
      },
      select: { id: true, firstName: true, name: true }
    });

    const userMap = new Map(users.map((u: { id: string; firstName: string | null; name: string | null }) => [u.id, u.firstName || u.name || 'User']));
    const nameA = userMap.get(userId) || 'User';
    const nameB = partnerId ? (userMap.get(partnerId) || 'Partner') : 'Partner';

    // 2. Generate and save per-user transition messages — each user gets their own personalized message
    const userIds = [userId, partnerId].filter((id): id is string => id !== null);
    const messages: Array<{ id: string; content: string; timestamp: Date; forUserId: string }> = [];
    for (const uid of userIds) {
      const uName = userMap.get(uid) || 'User';
      const pName = uid === userId ? nameB : nameA;

      const transitionPrompt = `You are Meet Without Fear, a Process Guardian.
You are speaking PRIVATELY to ${uName} alone. Address them as "you" — never "both of you" or any group language.
${uName} has just completed the Empathy Exchange (Stage 2), where they worked to understand ${pName}'s experience.

Your goal is to transition ${uName} into Stage 3: Needs Mapping.
In Stage 3, ${uName} will explore what they themselves need most from this situation.

Generate a warm, personal transition message (2-3 sentences) that:
1. Acknowledges the effort ${uName} put into understanding ${pName}.
2. Invites ${uName} personally to now turn inward and share what they need most.

Respond in JSON format:
\`\`\`json
{
  "response": "Your message addressed to ${uName} personally, using 'you'"
}
\`\`\``;

      const turnId = `${sessionId}-stage3-transition-${uid}-${Date.now()}`;

      const aiResponse = await getSonnetResponse({
        systemPrompt: transitionPrompt,
        messages: [{ role: 'user', content: 'Generate transition message.' }],
        maxTokens: 512,
        sessionId,
        operation: 'stage3-transition',
        turnId,
        callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
      });

      let content = `${uName}, you did something meaningful — you really tried to understand ${pName}'s experience. Now it's your turn: let's explore what you need most from this situation.`;

      if (aiResponse) {
        try {
          const parsed = extractJsonFromResponse(aiResponse) as Record<string, unknown>;
          if (typeof parsed.response === 'string') {
            content = cleanVisibleAIText(parsed.response);
          }
        } catch (e) {
          logger.warn('Failed to parse transition AI response', e);
        }
      }

      const msg = await prisma.message.create({
        data: {
          sessionId,
          senderId: null, // AI
          forUserId: uid,
          role: 'AI',
          content,
          stage: 3,
        }
      });
      messages.push({ id: msg.id, content: msg.content, timestamp: msg.timestamp, forUserId: uid });
    }

    // 4. Update Stage Progress for both to Stage 3
    // Backfill missing prior stage records (defensive — handles cases where
    // session initialization failed to create StageProgress atomically)
    const now = new Date();
    for (const uid of userIds) {
      for (const priorStage of [0, 1, 2]) {
        await prisma.stageProgress.upsert({
          where: {
            sessionId_userId_stage: { sessionId, userId: uid, stage: priorStage }
          },
          create: {
            sessionId,
            userId: uid,
            stage: priorStage,
            status: 'COMPLETED',
            completedAt: now,
          },
          update: {}
        });
      }
    }

    // Mark Stage 2 as COMPLETED
    await prisma.stageProgress.updateMany({
      where: {
        sessionId,
        stage: 2,
        userId: { in: userIds },
        status: { not: 'COMPLETED' }
      },
      data: {
        status: 'COMPLETED',
        completedAt: now
      }
    });

    // Create Stage 3 records if not exist
    for (const uid of userIds) {
      await prisma.stageProgress.upsert({
        where: {
          sessionId_userId_stage: {
            sessionId,
            userId: uid,
            stage: 3
          }
        },
        create: {
          sessionId,
          userId: uid,
          stage: 3,
          status: 'IN_PROGRESS',
          startedAt: now,
        },
        update: {}
      });
    }

    // Expire any outstanding share offers — Stage 2 sharing window is closed
    await prisma.reconcilerShareOffer.updateMany({
      where: {
        result: { sessionId },
        status: { in: ['OFFERED', 'PENDING'] },
      },
      data: { status: 'EXPIRED' },
    });

    // 5. Notify Realtime. Transition messages are private, so publish one
    // addressed payload per recipient on the session channel.
    if (partnerId) {
      for (const recipientMessage of messages) {
        await publishSessionEvent(sessionId, 'partner.stage_completed', {
          forUserId: recipientMessage.forUserId,
          previousStage: 2,
          currentStage: 3,
          userId,
          triggeredByUserId: userId,
          message: {
            id: recipientMessage.id,
            content: recipientMessage.content,
            timestamp: recipientMessage.timestamp,
            forUserId: recipientMessage.forUserId,
          }
        });
      }
      await publishSessionEvent(sessionId, 'stage.progress', {
        previousStage: 2,
        stage: 3,
        userId,
        triggeredByUserId: userId,
      });
    }

    // Embed session content (non-blocking)
    // Per fact-ledger architecture, we embed at session level
    const embedTurnId = `${sessionId}-stage3-transition-${Date.now()}`;
    embedSessionContent(sessionId, userId, embedTurnId).catch((err: unknown) =>
      logger.warn('[Stage2] Failed to embed session content:', err)
    );

  } catch (error) {
    logger.error('[triggerStage3Transition] Error:', error);
  }
}


// ============================================================================
// Refinement Flow (Phase 4)
// ============================================================================

/**
 * Get empathy exchange status for UI state management
 * GET /sessions/:id/empathy/status
 */
export async function getEmpathyExchangeStatus(
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

    // Use the shared service function to build the status
    const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
    const status = await buildEmpathyExchangeStatus(sessionId, user.id);

    successResponse(res, status);
  } catch (error) {
    logger.error('[getEmpathyExchangeStatus] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get empathy exchange status', 500);
  }
}

/**
 * Refine empathy statement through conversation with AI
 * POST /sessions/:id/empathy/refine
 *
 * When status is NEEDS_WORK, user can engage in refinement conversation.
 * Uses standard full retrieval + abstract area hint from reconciler.
 */
export async function refineEmpathy(
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
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      errorResponse(res, 'VALIDATION_ERROR', 'Message is required', 400);
      return;
    }

    // Get user's empathy attempt
    const attempt = await prisma.empathyAttempt.findFirst({
      where: {
        sessionId,
        sourceUserId: user.id,
      },
    });

    if (!attempt) {
      errorResponse(res, 'NOT_FOUND', 'Empathy attempt not found', 404);
      return;
    }

    // Allow refinement when status is NEEDS_WORK or REFINING
    if (attempt.status !== 'NEEDS_WORK' && attempt.status !== 'REFINING') {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Empathy refinement is only available when status is NEEDS_WORK or REFINING',
        400
      );
      return;
    }

    // Get the reconciler result for abstract guidance
    const reconcilerResult = await prisma.reconcilerResult.findFirst({
      where: {
        sessionId,
        guesserId: user.id,
        supersededAt: null,
      },
      select: {
        areaHint: true,
        guidanceType: true,
        promptSeed: true,
        subjectName: true,
      },
    });

    // Build refinement prompt
    // Key: Uses standard full retrieval context but only abstract hints from reconciler
    const partnerName = reconcilerResult?.subjectName ?? 'your partner';
    const areaHint = reconcilerResult?.areaHint ?? 'deeper emotional experiences';
    const promptSeed = reconcilerResult?.promptSeed ?? 'what might be underneath the surface';

    // If status is REFINING, include the shared context from the subject
    let sharedContextSection = '';
    if (attempt.status === 'REFINING') {
      const contextResult = await getSharedContextForGuesser(sessionId, user.id);
      if (contextResult.hasSharedContext && contextResult.content) {
        sharedContextSection = `

IMPORTANT: ${partnerName} has shared something additional to help you understand:
"${contextResult.content}"

Use this shared context to help the user deepen their empathy and incorporate this insight into their empathy statement.`;
      }
    }

    const systemPrompt = `You are Meet Without Fear, a compassionate Process Guardian helping someone deepen their empathy for ${partnerName}.

The user has shared their attempt to imagine ${partnerName}'s perspective, but there may be more to explore. Your role is to gently help them think more deeply.

Area to explore: ${areaHint}
Guiding question theme: ${promptSeed}${sharedContextSection}

Guidelines:
- Ask curious, open-ended questions
- Help them imagine ${partnerName}'s experience${attempt.status === 'REFINING' ? `
- You CAN reference the shared context above to help them refine their understanding` : `
- DO NOT reveal specific things ${partnerName} said
- DO NOT tell them what they "missed"`}
- Validate their insights while encouraging deeper exploration
- If they express new understanding, offer to help incorporate it

When they seem ready to revise their statement, propose a revision in JSON format:
\`\`\`json
{
  "response": "Your conversational response",
  "proposedRevision": "The revised empathy statement (or null if not proposing)",
  "canResubmit": true/false
}
\`\`\``;

    // Create turnId for this refinement conversation message
    const turnId = `${sessionId}-${user.id}-empathy-refinement-${Date.now()}`;
    // Update request context so all downstream code can access this turnId
    updateContext({ turnId, sessionId, userId: user.id });

    const aiResponse = await getSonnetResponse({
      systemPrompt,
      messages: [{ role: 'user', content: message }],
      maxTokens: 1024,
      sessionId,
      operation: 'empathy-refinement',
      turnId,
      callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
    });

    let response = "I'd love to help you explore this further. What do you think might be going on for them beneath the surface?";
    let proposedRevision: string | null = null;
    let canResubmit = false;

    if (aiResponse) {
      try {
        const parsed = extractJsonFromResponse(aiResponse) as Record<string, unknown>;
        response = typeof parsed.response === 'string' ? parsed.response : aiResponse;
        proposedRevision = typeof parsed.proposedRevision === 'string' ? parsed.proposedRevision : null;
        canResubmit = typeof parsed.canResubmit === 'boolean' ? parsed.canResubmit : !!proposedRevision;
      } catch {
        // If JSON parsing fails, use raw response
        response = aiResponse;
      }
    }

    successResponse(res, {
      response,
      proposedRevision,
      canResubmit,
    });
  } catch (error) {
    logger.error('[refineEmpathy] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to refine empathy', 500);
  }
}

/**
 * Resubmit revised empathy statement for re-analysis
 * POST /sessions/:id/empathy/resubmit
 */
export async function resubmitEmpathy(
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
    const { content } = req.body;

    if (!content || typeof content !== 'string') {
      errorResponse(res, 'VALIDATION_ERROR', 'Content is required', 400);
      return;
    }

    // Get user's empathy attempt
    const attempt = await prisma.empathyAttempt.findFirst({
      where: {
        sessionId,
        sourceUserId: user.id,
      },
    });

    if (!attempt) {
      errorResponse(res, 'NOT_FOUND', 'Empathy attempt not found', 404);
      return;
    }

    // Allow resubmit from NEEDS_WORK (reconciler found gaps) or REFINING (received shared context)
    if (attempt.status !== 'NEEDS_WORK' && attempt.status !== 'REFINING') {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Can only resubmit when status is NEEDS_WORK or REFINING',
        400
      );
      return;
    }

    // Block identical resubmission — user must actually revise the content
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalize(content) === normalize(attempt.content)) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Your empathy statement hasn\'t changed. Please revise it based on the feedback you received before resubmitting.',
        400
      );
      return;
    }

    const previousRevision = attempt.revisionCount;

    // Update the attempt with new content and set status to ANALYZING
    await prisma.empathyAttempt.update({
      where: { id: attempt.id },
      data: {
        content,
        status: 'ANALYZING',
        statusVersion: { increment: 1 },
        revisionCount: attempt.revisionCount + 1,
      },
    });

    // Mark old reconciler results as superseded (preserves audit trail)
    await prisma.reconcilerResult.updateMany({
      where: {
        sessionId,
        guesserId: user.id,
        supersededAt: null,
      },
      data: {
        supersededAt: new Date(),
      },
    });

    // Get session to find partner ID
    const session = await prisma.session.findFirst({
      where: { id: sessionId },
      include: {
        relationship: {
          include: {
            members: true,
          },
        },
      },
    });

    const partnerId = session
      ? getPartnerUserIdFromSession(session, user.id)
      : null;

    // Create a new EMPATHY_STATEMENT message with the updated content
    // This allows the old message to show as "superseded" in the UI
    // while the new message shows the current delivery status
    const newMessage = await prisma.message.create({
      data: {
        sessionId,
        senderId: user.id,
        forUserId: user.id, // For the user's own chat (shows "What you shared")
        role: 'EMPATHY_STATEMENT',
        content,
        stage: 2,
      },
    });

    logger.info(`[resubmitEmpathy] Created new EMPATHY_STATEMENT message ${newMessage.id} (revision ${previousRevision + 1})`);

    // Create turnId for this user action
    const turnId = `${sessionId}-${user.id}-resubmit-empathy`;
    updateContext({ turnId, sessionId, userId: user.id });

    // Embed for cross-session retrieval (non-blocking)
    embedSessionContent(sessionId, user.id, turnId).catch((err: unknown) =>
      logger.warn('[resubmitEmpathy] Failed to embed session content:', err)
    );

    // Increment circuit breaker counter (only resubmits increment, not initial runs)
    if (partnerId) {
      await incrementAttempts(sessionId, user.id, partnerId);
    }

    // Run reconciler for just this direction
    if (partnerId) {
      triggerReconcilerForUser(sessionId, user.id, partnerId).catch((err) =>
        logger.warn('[resubmitEmpathy] Failed to run reconciler:', err)
      );
    }

    // Generate acknowledgment message for the revision.
    let transitionMessage: {
      id: string;
      content: string;
      timestamp: string;
      stage: number;
    } | null = null;

    try {
      const transitionContent = `You're showing real understanding here. We'll send this through a separate privacy-protected review to check whether your updated perspective is ready to share.`;

      // Save the transition message to the database
      const aiMessage = await prisma.message.create({
        data: {
          sessionId,
          senderId: null,
          forUserId: user.id,
          role: 'AI',
          content: transitionContent,
          stage: 2,
        },
      });

      // Embed for cross-session retrieval (non-blocking)
      embedSessionContent(sessionId, user.id, turnId).catch((err: unknown) =>
        logger.warn('[resubmitEmpathy] Failed to embed session content:', err)
      );

      // Summarize older parts of the conversation (non-blocking)
      updateSessionSummary(sessionId, user.id, turnId).catch((err) =>
        logger.warn('[resubmitEmpathy] Failed to update session summary after transition:', err)
      );

      transitionMessage = {
        id: aiMessage.id,
        content: aiMessage.content,
        timestamp: aiMessage.timestamp.toISOString(),
        stage: aiMessage.stage,
      };

      // Audit log the transition message
      /* auditLog('RESPONSE', 'Stage 2 revision acknowledgment generated', {
        turnId,
        sessionId,
        userId: user.id,
        stage: 2,
        operation: 'stage2-revision-acknowledgment',
        responseText: transitionContent,
        messageId: aiMessage.id,
        revisionCount: previousRevision + 1,
      }); */
    } catch (error) {
      logger.error('[resubmitEmpathy] Failed to generate transition message:', error);
      // Continue without transition message - not a critical failure
    }

    successResponse(res, {
      status: 'ANALYZING',
      message: 'We are sending this through a separate privacy-protected review to check whether your updated understanding is ready to share...',
      empathyMessage: {
        id: newMessage.id,
        content: newMessage.content,
        timestamp: newMessage.timestamp.toISOString(),
        stage: newMessage.stage,
        deliveryStatus: 'pending',
      },
      transitionMessage,
    });
  } catch (error) {
    logger.error('[resubmitEmpathy] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to resubmit empathy', 500);
  }
}

/**
 * Helper: Run reconciler for a single user's direction after resubmit.
 *
 * IMPORTANT: Uses runReconcilerForDirection (asymmetric flow) instead of runReconciler,
 * because at this point only the guesser may have shared their empathy statement.
 * The symmetric runReconciler requires BOTH users to have shared, which blocks this flow.
 */
async function triggerReconcilerForUser(
  sessionId: string,
  guesserId: string,
  subjectId: string
): Promise<void> {
  const { runReconcilerForDirection, checkAndRevealBothIfReady } = await import('../services/reconciler');

  try {
    logger.info(`[triggerReconcilerForUser] Running reconciler for direction: guesser=${guesserId} → subject=${subjectId}`);

    // Use runReconcilerForDirection for asymmetric flow (only guesser has shared empathy)
    // The function now has built-in guard for context already shared, so no post-hoc override needed
    const result = await runReconcilerForDirection(sessionId, guesserId, subjectId);

    if (!result.result) {
      logger.warn('[triggerReconcilerForUser] No reconciler result returned');
      return;
    }

    logger.info(
      `[triggerReconcilerForUser] Reconciler complete: ` +
      `alignment=${result.result.alignment.score}%, gaps=${result.result.gaps.severity}, ` +
      `empathyStatus=${result.empathyStatus}`
    );

    // Check if both are now READY and reveal both simultaneously
    await checkAndRevealBothIfReady(sessionId);
  } catch (error) {
    logger.error('[triggerReconcilerForUser] Error:', error);
    throw error;
  }
}

// ============================================================================
// Share Suggestion Flow (Asymmetric Reconciler)
// ============================================================================

/**
 * Get share suggestion for current user
 * GET /sessions/:id/empathy/share-suggestion
 *
 * Called by the subject when partner (guesser) has gaps in their empathy statement.
 * Returns a suggested piece of context the subject can share to help the guesser.
 */
export async function getShareSuggestion(
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

    const progress = await prisma.stageProgress.findFirst({
      where: {
        sessionId,
        userId: user.id,
        status: { in: ['IN_PROGRESS', 'GATE_PENDING'] },
      },
      orderBy: { stage: 'desc' },
      select: { stage: true },
    });

    if ((progress?.stage ?? 0) !== 2) {
      successResponse(res, {
        hasSuggestion: false,
        suggestion: null,
      });
      return;
    }

    // Get share suggestion from reconciler service
    const result = await getShareSuggestionForUser(sessionId, user.id);

    if (!result.hasSuggestion || !result.suggestion) {
      successResponse(res, {
        hasSuggestion: false,
        suggestion: null,
      });
      return;
    }

    successResponse(res, {
      hasSuggestion: true,
      suggestion: {
        guesserName: result.suggestion.guesserName,
        suggestedContent: result.suggestion.suggestedContent,
        reason: result.suggestion.reason,
        canRefine: result.suggestion.canRefine,
      },
    });
  } catch (error) {
    logger.error('[getShareSuggestion] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get share suggestion', 500);
  }
}

/**
 * Respond to share suggestion
 * POST /sessions/:id/empathy/share-suggestion/respond
 *
 * Called by the subject to accept, decline, or refine the share suggestion.
 * Body: { action: 'accept' | 'decline' | 'refine', refinedContent?: string }
 */
export async function respondToShareSuggestion(
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
    const { action, refinedContent } = req.body;

    // Validate action
    if (!action || !['accept', 'decline', 'refine'].includes(action)) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Action must be one of: accept, decline, refine',
        400
      );
      return;
    }

    // Validate refinedContent for 'refine' action
    if (action === 'refine' && (!refinedContent || typeof refinedContent !== 'string')) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'refinedContent is required when action is refine',
        400
      );
      return;
    }

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
            members: true,
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Get partner ID
    const partnerId = getPartnerUserIdFromSession(session, user.id);

    // Call reconciler service to process the response
    // The service throws if no pending offer is found
    let result;
    try {
      result = await reconcilerRespondToShareSuggestion(sessionId, user.id, {
        action: action as 'accept' | 'decline' | 'refine',
        refinedContent: action === 'refine' ? refinedContent : undefined,
      });
    } catch (err) {
      // Service throws when no pending share offer exists
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'No pending share suggestion found or already responded',
        400
      );
      return;
    }

    // If accepted or refined, notify partner (guesser) that they have new context
    // Include full empathy status to avoid extra HTTP round-trip
    if ((action === 'accept' || action === 'refine') && partnerId) {
      const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
      const guesserEmpathyStatus = await buildEmpathyExchangeStatus(sessionId, partnerId);
      // Publish realtime event to notify guesser
      await publishSessionEvent(sessionId, 'empathy.refining', {
        guesserId: partnerId,
        forUserId: partnerId,
        empathyStatus: guesserEmpathyStatus,
        hasNewContext: true,
      });

      logger.info(`[respondToShareSuggestion] Notified guesser ${partnerId} of new shared context with full status data`);
    }

    successResponse(res, {
      success: true,
      status: result.status,
      sharedContent: result.sharedContent,
    });
  } catch (error) {
    logger.error('[respondToShareSuggestion] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to respond to share suggestion', 500);
  }
}
