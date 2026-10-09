/**
 * Stage 3 Controller
 *
 * Handles the What Matters stage endpoints:
 * - GET /sessions/:id/needs - Get identified needs (simple read)
 * - POST /sessions/:id/needs/capture - Capture needs from an AI summary card
 * - POST /sessions/:id/needs/confirm - Confirm needs
 * - POST /sessions/:id/needs/consent - Consent to share needs
 * - POST /sessions/:id/needs/validate - Validate revealed needs
 * - POST /sessions/:id/needs - Add custom need
 * - GET /sessions/:id/needs/comparison - Side-by-side needs comparison
 */

import { Request, Response } from 'express';
import { Prisma, StageProgress } from '../generated/prisma/client';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { confirmNeedsRequestSchema, ConsentContentType, MessageRole, NeedCategory } from '@meet-without-fear/shared';
import { notifyPartner, publishMessageAIResponse, publishSessionEvent } from '../services/realtime';
import { successResponse, errorResponse } from '../utils/response';
import { getPartnerUserId } from '../utils/session';
import { captureProposedNeedsForUser, toIdentifiedNeedDTO, withNeedReframingWarning } from '../services/needs';
import { interpretNeedEditRequest } from '../services/needs-edit-interpreter.service';
import {
  applyNeedEdits,
  deleteNeed,
  NeedEditForbiddenError,
  NeedEditValidationError,
} from '../services/needs-edit-applier.service';

// ============================================================================
// Helpers
// ============================================================================

function buildStage4TransitionContent(firstNeed?: string | null): string {
  const needText = firstNeed?.trim();
  const needLine = needText
    ? `Let's start with one of yours: ${needText}.`
    : "Let's start with one of yours.";

  return [
    'You have both sent your needs and can now see what each of you named.',
    `${needLine} The work now is not to decide everything, just to put ideas on the table. What might help honor that need?`,
  ].join('\n\n');
}

async function getFirstStage4NeedText(sessionId: string, userId: string): Promise<string | null> {
  const vessel = await getOrCreateUserVessel(sessionId, userId);
  const firstNeed = await prisma.identifiedNeed.findFirst({
    where: {
      vesselId: vessel.id,
      confirmed: true,
      deletedAt: null,
      supersededByNeedId: null,
    },
    orderBy: { createdAt: 'asc' },
    select: { need: true },
  });

  return firstNeed?.need ?? null;
}

async function createStage4TransitionMessage(
  sessionId: string,
  forUserId: string
): Promise<{ id: string; content: string; timestamp: Date; forUserId: string }> {
  const firstNeed = await getFirstStage4NeedText(sessionId, forUserId);
  const message = await prisma.message.create({
    data: {
      sessionId,
      senderId: null,
      forUserId,
      role: 'AI',
      content: buildStage4TransitionContent(firstNeed),
      stage: 4,
    },
  });

  return { id: message.id, content: message.content, timestamp: message.timestamp, forUserId };
}

/**
 * Get or create user vessel for a session
 */
async function getOrCreateUserVessel(
  sessionId: string,
  userId: string
): Promise<{ id: string }> {
  let vessel = await prisma.userVessel.findUnique({
    where: {
      userId_sessionId: { userId, sessionId },
    },
  });

  if (!vessel) {
    vessel = await prisma.userVessel.create({
      data: { userId, sessionId },
    });
  }

  return vessel;
}

/**
 * Check if partner has shared their needs (consented to share)
 */
async function hasPartnerSharedNeeds(
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
        stage: 3,
      },
    },
  });

  if (!partnerProgress) return false;

  const gates = partnerProgress.gatesSatisfied as Record<string, unknown> | null;
  return gates?.needsShared === true;
}

async function completeStage3AfterMutualNeedsShare(
  sessionId: string,
  currentUserId: string,
  partnerId: string,
  now: Date,
  currentProgress: Pick<StageProgress, 'gatesSatisfied'> | null | undefined,
  partnerProgress: Pick<StageProgress, 'gatesSatisfied'> | null | undefined
): Promise<void> {
  const reviewedAt = now.toISOString();
  const mergeGates = (progress: Pick<StageProgress, 'gatesSatisfied'> | null | undefined) => ({
    ...((progress?.gatesSatisfied as Record<string, unknown> | null) || {}),
    needsShared: true,
    needsValidated: true,
    needsValidatedAt: reviewedAt,
    needsRevealReviewedAt: reviewedAt,
  }) satisfies Prisma.InputJsonValue;

  for (const uid of [currentUserId, partnerId]) {
    const progress = uid === currentUserId ? currentProgress : partnerProgress;
    await prisma.stageProgress.update({
      where: {
        sessionId_userId_stage: {
          sessionId,
          userId: uid,
          stage: 3,
        },
      },
      data: {
        gatesSatisfied: mergeGates(progress),
        status: 'COMPLETED',
        completedAt: now,
      },
    });

    await prisma.stageProgress.upsert({
      where: {
        sessionId_userId_stage: {
          sessionId,
          userId: uid,
          stage: 4,
        },
      },
      create: {
        sessionId,
        userId: uid,
        stage: 4,
        status: 'IN_PROGRESS',
        startedAt: now,
      },
      update: {},
    });
  }

  const transitionMessages: Array<{ id: string; content: string; timestamp: Date; forUserId: string }> = [];
  for (const uid of [currentUserId, partnerId]) {
    transitionMessages.push(await createStage4TransitionMessage(sessionId, uid));
  }

  for (const transitionMessage of transitionMessages) {
    await publishSessionEvent(sessionId, 'partner.stage_completed', {
      forUserId: transitionMessage.forUserId,
      previousStage: 3,
      currentStage: 4,
      userId: currentUserId,
      triggeredByUserId: currentUserId,
      message: {
        id: transitionMessage.id,
        content: transitionMessage.content,
        timestamp: transitionMessage.timestamp,
        forUserId: transitionMessage.forUserId,
      },
    });
  }
}

async function hasPartnerValidatedNeeds(
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
        stage: 3,
      },
    },
  });

  const gates = partnerProgress?.gatesSatisfied as Record<string, unknown> | null;
  return gates?.needsValidated === true;
}

function isNeedCategory(value: unknown): value is NeedCategory {
  return typeof value === 'string' && Object.values(NeedCategory).includes(value as NeedCategory);
}

function needEditErrorResponse(res: Response, error: unknown): boolean {
  if (error instanceof NeedEditValidationError) {
    errorResponse(res, 'VALIDATION_ERROR', error.message, error.statusCode);
    return true;
  }
  if (error instanceof NeedEditForbiddenError) {
    errorResponse(res, 'FORBIDDEN', error.message, error.statusCode);
    return true;
  }
  return false;
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * Get identified needs for the current user (simple read, no auto-extraction)
 * GET /sessions/:id/needs
 */
export async function getNeeds(req: Request, res: Response): Promise<void> {
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

    // Return empty data for non-active sessions (allows parallel fetching)
    if (session.status !== 'ACTIVE') {
      successResponse(res, {
        needs: [],
        synthesizedAt: null,
        isDirty: false,
      });
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

    // If not in stage 3 yet, return empty data instead of error
    const currentStage = progress?.stage ?? 0;
    if (currentStage < 3) {
      successResponse(res, {
        needs: [],
        synthesizedAt: null,
        isDirty: false,
      });
      return;
    }

    // Get user's vessel
    const userVessel = await getOrCreateUserVessel(sessionId, user.id);

    // Get existing needs for this user
    const needs = await prisma.identifiedNeed.findMany({
      where: {
        vesselId: userVessel.id,
      },
      orderBy: { createdAt: 'asc' },
    });

    successResponse(res, {
      needs: needs.map((need) => toIdentifiedNeedDTO({
        ...need,
        category: need.category as NeedCategory,
      })),
      extracting: false,
      synthesizedAt: needs[0]?.createdAt.toISOString() ?? null,
    });
  } catch (error) {
    logger.error('[getNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get needs', 500);
  }
}

/**
 * Capture needs from an AI summary card
 * POST /sessions/:id/needs/capture
 */
export async function captureNeeds(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const { needs } = req.body as {
      needs?: Array<{
        need?: string;
        category?: unknown;
        description?: string;
        evidence?: unknown;
      }>;
    };

    if (!Array.isArray(needs) || needs.length === 0) {
      errorResponse(res, 'VALIDATION_ERROR', 'needs array is required', 400);
      return;
    }
    if (needs.length > 50) {
      errorResponse(res, 'VALIDATION_ERROR', 'A maximum of 50 needs can be captured at once', 400);
      return;
    }

    for (const need of needs) {
      if (!need.need || !need.description || !isNeedCategory(need.category)) {
        errorResponse(
          res,
          'VALIDATION_ERROR',
          'Each need requires need, description, and a valid category',
          400
        );
        return;
      }
    }

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

    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    const progress = await prisma.stageProgress.findFirst({
      where: { sessionId, userId: user.id },
      orderBy: { stage: 'desc' },
    });

    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot capture needs: you are in stage ${currentStage}, but stage 3 is required`,
        400
      );
      return;
    }

    const { needs: capturedNeeds, capturedAt } = await captureProposedNeedsForUser(
      sessionId,
      user.id,
      needs.map((item) => ({
        need: item.need!,
        category: item.category as NeedCategory,
        description: item.description!,
        evidence: Array.isArray(item.evidence)
          ? item.evidence.filter((entry): entry is string => typeof entry === 'string')
          : [],
      }))
    );

    successResponse(
      res,
      {
        needs: capturedNeeds.map((n) => ({
          id: n.id,
          need: n.need,
          category: n.category,
          description: n.need,
          evidence: n.evidence,
          confirmed: n.confirmed,
          aiConfidence: n.aiConfidence,
          needsReframing: n.needsReframing,
          reframingWarning: n.reframingWarning,
        })),
        capturedAt: capturedAt.toISOString(),
      },
      201
    );
  } catch (error) {
    logger.error('[captureNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to capture needs', 500);
  }
}

/**
 * Confirm user's needs
 * POST /sessions/:id/needs/confirm
 */
export async function confirmNeeds(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;

    // Validate request body
    const parseResult = confirmNeedsRequestSchema.safeParse(req.body);
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

    const { needIds, adjustments } = parseResult.data;

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

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
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

    // Check user is in stage 3
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot confirm needs: you are in stage ${currentStage}, but stage 3 is required`,
        400
      );
      return;
    }

    const gates = (progress?.gatesSatisfied as Record<string, unknown> | null) ?? {};
    if (gates.needsShared === true) {
      errorResponse(res, 'FORBIDDEN', 'Needs have already been shared and can no longer be edited', 403);
      return;
    }

    // Get user's vessel
    const userVessel = await getOrCreateUserVessel(sessionId, user.id);

    // Verify the needs belong to this user's vessel
    const userNeeds = await prisma.identifiedNeed.findMany({
      where: {
        id: { in: needIds },
        vesselId: userVessel.id,
      },
    });

    if (userNeeds.length !== needIds.length) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Some need IDs are invalid or do not belong to you',
        400
      );
      return;
    }

    // Process adjustments if provided
    if (adjustments && adjustments.length > 0) {
      const userNeedIds = new Set(userNeeds.map((need) => need.id));
      if (adjustments.some((adj) => !userNeedIds.has(adj.needId))) {
        errorResponse(
          res,
          'VALIDATION_ERROR',
          'Some adjustment need IDs are invalid or do not belong to you',
          400
        );
        return;
      }

      for (const adj of adjustments) {
        if (adj.correction) {
          await prisma.identifiedNeed.updateMany({
            where: { id: adj.needId, vesselId: userVessel.id },
            data: {
              need: adj.correction,
              confirmed: adj.confirmed,
            },
          });
        }
      }
    }

    // Confirm all specified needs
    const now = new Date();
    await prisma.identifiedNeed.updateMany({
      where: {
        id: { in: needIds },
        vesselId: userVessel.id,
      },
      data: { confirmed: true, lockedAt: now },
    });

    // Update stage progress with needsIdentifiedAt milestone
    const gatesSatisfied = {
      ...(progress?.gatesSatisfied as Record<string, unknown> || {}),
      needsConfirmed: true,
      confirmedAt: now.toISOString(),
      needsIdentifiedAt: now.toISOString(),
    } satisfies Prisma.InputJsonValue;

    await prisma.stageProgress.update({
      where: {
        sessionId_userId_stage: {
          sessionId,
          userId: user.id,
          stage: 3,
        },
      },
      data: {
        gatesSatisfied,
      },
    });

    // Notify partner that needs were confirmed
    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'partner.needs_confirmed', {
        stage: 3,
        confirmedBy: user.id,
      });
    }

    // Check if partner has also shared
    const partnerShared = await hasPartnerSharedNeeds(sessionId, user.id);

    successResponse(res, {
      confirmed: true,
      confirmedAt: now.toISOString(),
      partnerConfirmed: partnerShared,
      canAdvance: false, // Need to share needs first
    });
  } catch (error) {
    logger.error('[confirmNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to confirm needs', 500);
  }
}

/**
 * Consent to share needs with partner
 * POST /sessions/:id/needs/consent
 */
export async function consentToShareNeeds(
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
    const { needIds } = req.body as { needIds?: string[] };

    if (!needIds || !Array.isArray(needIds) || needIds.length === 0) {
      errorResponse(res, 'VALIDATION_ERROR', 'needIds array is required', 400);
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

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
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

    // Check user is in stage 3
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot consent to share: you are in stage ${currentStage}, but stage 3 is required`,
        400
      );
      return;
    }

    // Get user's vessel
    const userVessel = await getOrCreateUserVessel(sessionId, user.id);

    // Verify every shared need is a live confirmed need owned by this user.
    const confirmedLiveNeeds = await prisma.identifiedNeed.findMany({
      where: {
        id: { in: needIds },
        vesselId: userVessel.id,
        confirmed: true,
        deletedAt: null,
        supersededByNeedId: null,
      },
    });

    if (confirmedLiveNeeds.length !== needIds.length) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'All live needs must be confirmed before sharing',
        400
      );
      return;
    }

    const liveNeeds = await prisma.identifiedNeed.findMany({
      where: {
        vesselId: userVessel.id,
        deletedAt: null,
        supersededByNeedId: null,
      },
      select: { id: true },
    });
    const requestedNeedIds = new Set(needIds);
    const allLiveNeedsRequested = liveNeeds.every((need) => requestedNeedIds.has(need.id));
    if (liveNeeds.length !== needIds.length || !allLiveNeedsRequested) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Every live need must be shared together',
        400
      );
      return;
    }

    const now = new Date();
    const gatesSatisfied = {
      ...(progress?.gatesSatisfied as Record<string, unknown> || {}),
      needsShared: true,
      sharedAt: now.toISOString(),
    } satisfies Prisma.InputJsonValue;

    await prisma.$transaction(async (tx) => {
      for (const needId of needIds) {
        await tx.consentRecord.create({
          data: {
            sessionId,
            userId: user.id,
            targetType: ConsentContentType.IDENTIFIED_NEED,
            targetId: needId,
            requestedByUserId: user.id,
            decision: 'GRANTED',
            decidedAt: now,
          },
        });
      }

      await tx.stageProgress.update({
        where: {
          sessionId_userId_stage: {
            sessionId,
            userId: user.id,
            stage: 3,
          },
        },
        data: {
          gatesSatisfied,
          status: 'GATE_PENDING',
        },
      });
    });

    // Notify partner via real-time
    const partnerId = await getPartnerUserId(sessionId, user.id);
    const partnerProgress = partnerId
      ? await prisma.stageProgress.findUnique({
          where: {
            sessionId_userId_stage: {
              sessionId,
              userId: partnerId,
              stage: 3,
            },
          },
        })
      : null;
    const partnerGates = partnerProgress?.gatesSatisfied as Record<string, unknown> | null;
    const partnerShared = partnerGates?.needsShared === true;

    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'partner.needs_shared', {
        stage: 3,
        sharedBy: user.id,
        needsRevealReady: partnerShared,
      });
    }

    // If both have shared, notify clients that the side-by-side reveal is ready.
    if (partnerShared && partnerId) {
      await publishSessionEvent(sessionId, 'session.needs_reveal_ready', {
        stage: 3,
        needsRevealReady: true,
      });
      await completeStage3AfterMutualNeedsShare(
        sessionId,
        user.id,
        partnerId,
        now,
        { gatesSatisfied },
        partnerProgress
      );
    }

    if (!partnerShared) {
      const guidanceMessage = await prisma.message.create({
        data: {
          sessionId,
          senderId: null,
          forUserId: user.id,
          role: 'AI',
          content: 'Your needs have been shared. Once your partner shares theirs, you\'ll be able to review them side by side.',
          stage: 3,
        },
      });

      await publishMessageAIResponse(sessionId, user.id, {
        id: guidanceMessage.id,
        sessionId,
        senderId: null,
        content: guidanceMessage.content,
        timestamp: guidanceMessage.timestamp.toISOString(),
        role: MessageRole.AI,
        stage: guidanceMessage.stage,
      });
    }

    successResponse(res, {
      consented: true,
      sharedAt: now.toISOString(),
      waitingForPartner: !partnerShared,
      needsRevealReady: partnerShared,
      advancedToStage4: partnerShared,
    });
  } catch (error) {
    logger.error('[consentToShareNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to consent to share needs', 500);
  }
}

/**
 * Validate revealed needs lists.
 * POST /sessions/:id/needs/validate
 */
export async function validateNeeds(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const { validated = true } = req.body as { validated?: boolean };

    if (typeof validated !== 'boolean') {
      errorResponse(res, 'VALIDATION_ERROR', 'validated boolean is required', 400);
      return;
    }

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
              orderBy: { joinedAt: 'asc' },
            },
          },
        },
      },
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    const progress = await prisma.stageProgress.findFirst({
      where: { sessionId, userId: user.id },
      orderBy: { stage: 'desc' },
    });

    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot validate needs: you are in stage ${currentStage}, but stage 3 is required`,
        400
      );
      return;
    }

    const userGates = progress?.gatesSatisfied as Record<string, unknown> | null;
    if (userGates?.needsShared !== true || !(await hasPartnerSharedNeeds(sessionId, user.id))) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        'Both partners must consent to reveal needs before validation',
        400
      );
      return;
    }

    const now = new Date();
    const gatesSatisfied = {
      ...(progress?.gatesSatisfied as Record<string, unknown> || {}),
      needsValidated: validated,
      needsValidatedAt: validated ? now.toISOString() : null,
    } satisfies Prisma.InputJsonValue;

    await prisma.stageProgress.update({
      where: {
        sessionId_userId_stage: {
          sessionId,
          userId: user.id,
          stage: 3,
        },
      },
      data: {
        gatesSatisfied,
        status: 'GATE_PENDING',
        completedAt: null,
      },
    });

    const partnerValidated = await hasPartnerValidatedNeeds(sessionId, user.id);
    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (partnerId) {
      await notifyPartner(sessionId, partnerId, 'partner.needs_validated', {
        stage: 3,
        validatedBy: user.id,
        validated,
        allValidatedByBoth: validated && partnerValidated,
      });
    }

    const canAdvance = validated && partnerValidated;
    if (canAdvance && partnerId) {
      const transitionInputs = await Promise.all(
        [user.id, partnerId].map(async (uid) => ({
          uid,
          firstNeed: await getFirstStage4NeedText(sessionId, uid),
        }))
      );

      const transitionMessages = await prisma.$transaction(async (tx) => {
        await tx.stageProgress.updateMany({
          where: {
            sessionId,
            stage: 3,
            userId: { in: [user.id, partnerId] },
          },
          data: {
            status: 'COMPLETED',
            completedAt: now,
          },
        });

        for (const uid of [user.id, partnerId]) {
          await tx.stageProgress.upsert({
            where: {
              sessionId_userId_stage: {
                sessionId,
                userId: uid,
                stage: 4,
              },
            },
            create: {
              sessionId,
              userId: uid,
              stage: 4,
              status: 'IN_PROGRESS',
              startedAt: now,
            },
            update: {},
          });
        }

        const createdMessages: Array<{ id: string; content: string; timestamp: Date; forUserId: string }> = [];
        for (const input of transitionInputs) {
          const message = await tx.message.create({
            data: {
              sessionId,
              senderId: null,
              forUserId: input.uid,
              role: 'AI',
              content: buildStage4TransitionContent(input.firstNeed),
              stage: 4,
            },
          });
          createdMessages.push({ id: message.id, content: message.content, timestamp: message.timestamp, forUserId: input.uid });
        }
        return createdMessages;
      });

      for (const transitionMessage of transitionMessages) {
        const eventData = {
          forUserId: transitionMessage.forUserId,
          previousStage: 3,
          currentStage: 4,
          stage: 3,
          userId: user.id,
          triggeredByUserId: user.id,
          message: {
            id: transitionMessage.id,
            content: transitionMessage.content,
            timestamp: transitionMessage.timestamp,
            forUserId: transitionMessage.forUserId,
          },
        };

        if (transitionMessage.forUserId === partnerId) {
          // Use notifyPartner so the partner gets a push notification if offline
          await notifyPartner(sessionId, partnerId, 'partner.stage_completed', eventData);
        } else {
          await publishSessionEvent(sessionId, 'partner.stage_completed', eventData);
        }
      }
    }

    // Send AI guidance for the "not reviewed yet" path
    if (!validated) {
      const guidanceContent =
        'No problem — take your time reviewing. You can chat about anything that doesn\'t feel right, and review the needs again when you\'re ready.';

      const guidanceMessage = await prisma.message.create({
        data: {
          sessionId,
          senderId: null,
          forUserId: user.id,
          role: 'AI',
          content: guidanceContent,
          stage: 3,
        },
      });

      await publishMessageAIResponse(sessionId, user.id, {
        id: guidanceMessage.id,
        sessionId,
        senderId: null,
        content: guidanceMessage.content,
        timestamp: guidanceMessage.timestamp.toISOString(),
        role: MessageRole.AI,
        stage: guidanceMessage.stage,
      });
    }

    successResponse(res, {
      validated,
      validatedAt: validated ? now.toISOString() : null,
      partnerValidated,
      canAdvance,
    });
  } catch (error) {
    logger.error('[validateNeeds] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to validate needs', 500);
  }
}

/**
 * Add custom need
 * POST /sessions/:id/needs
 */
export async function addCustomNeed(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const { need, category, description } = req.body as {
      need?: string;
      category?: unknown;
      description?: string;
    };

    if (!need || !isNeedCategory(category)) {
      errorResponse(res, 'VALIDATION_ERROR', 'need and valid category are required', 400);
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
    });

    if (!session) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }

    // Check session is active
    if (session.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
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

    // Check user is in stage 3
    const currentStage = progress?.stage ?? 0;
    if (currentStage !== 3) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        `Cannot add need: you are in stage ${currentStage}, but stage 3 is required`,
        400
      );
      return;
    }

    // Get user's vessel
    const userVessel = await getOrCreateUserVessel(sessionId, user.id);

    // Create custom need
    const customNeed = await prisma.identifiedNeed.create({
      data: {
        vesselId: userVessel.id,
        need,
        category,
        evidence: [],
        aiConfidence: 1.0, // User-added needs are considered 100% confident
        confirmed: true, // User-added needs are auto-confirmed
      },
    });

    const warning = withNeedReframingWarning({ need: customNeed.need });

    successResponse(res, {
      need: {
        id: customNeed.id,
        need: customNeed.need,
        category: customNeed.category,
        description: customNeed.need,
        evidence: customNeed.evidence,
        aiConfidence: customNeed.aiConfidence,
        confirmed: customNeed.confirmed,
        needsReframing: warning.needsReframing,
        reframingWarning: warning.reframingWarning,
      },
    }, 201);
  } catch (error) {
    logger.error('[addCustomNeed] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to add custom need', 500);
  }
}

/**
 * Interpret a natural-language edit request without mutating needs.
 * POST /sessions/:id/needs/interpret-edit-request
 */
export async function interpretNeedEdit(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const { request, targetNeedId, conversationHistory } = req.body as {
      request?: string;
      targetNeedId?: string;
      conversationHistory?: unknown;
    };

    if (!request || typeof request !== 'string') {
      errorResponse(res, 'VALIDATION_ERROR', 'request is required', 400);
      return;
    }

    const result = await interpretNeedEditRequest(sessionId, user.id, {
      request,
      targetNeedId,
      conversationHistory: Array.isArray(conversationHistory) ? conversationHistory as any : undefined,
    });
    successResponse(res, result);
  } catch (error) {
    if (needEditErrorResponse(res, error)) return;
    logger.error('[interpretNeedEdit] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to interpret need edit request', 500);
  }
}

/**
 * Apply a previously previewed need edit plan.
 * POST /sessions/:id/needs/apply-edits
 */
export async function applyNeedEditPlan(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId } = req.params;
    const { operations } = req.body as { operations?: unknown };

    if (!Array.isArray(operations)) {
      errorResponse(res, 'VALIDATION_ERROR', 'operations array is required', 400);
      return;
    }

    const result = await applyNeedEdits(sessionId, user.id, operations as any);
    successResponse(res, result);
  } catch (error) {
    if (needEditErrorResponse(res, error)) return;
    logger.error('[applyNeedEditPlan] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to apply need edits', 500);
  }
}

/**
 * Remove a need before it has been shared.
 * DELETE /sessions/:id/needs/:needId
 */
export async function removeNeed(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    const { id: sessionId, needId } = req.params;
    if (!needId) {
      errorResponse(res, 'VALIDATION_ERROR', 'needId is required', 400);
      return;
    }

    const need = await deleteNeed(sessionId, user.id, needId);
    await publishSessionEvent(sessionId, 'need.deleted', {
      forUserId: user.id,
      userId: user.id,
      oldId: need.id,
      need,
    }).catch((err) =>
      logger.warn('[removeNeed] Failed to publish need.deleted:', err)
    );
    successResponse(res, { deleted: true, needId, need });
  } catch (error) {
    if (needEditErrorResponse(res, error)) return;
    logger.error('[removeNeed] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to remove need', 500);
  }
}

/**
 * Get needs comparison (side-by-side view of both users' needs)
 * GET /sessions/:id/needs/comparison
 *
 * Only available after both users have shared their needs.
 */
export async function getNeedsComparison(
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

    if (session.status !== 'ACTIVE') {
      successResponse(res, {
        myNeeds: [],
        partnerNeeds: [],
        commonGround: [],
        analysisComplete: false,
        noOverlap: false,
      });
      return;
    }

    // The latest progress determines whether the user has reached Stage 3,
    // while the Stage 3 record remains the source of truth for needs gates
    // after automatic advancement creates a Stage 4 progress record.
    const [latestProgress, stage3Progress] = await Promise.all([
      prisma.stageProgress.findFirst({
        where: { sessionId, userId: user.id },
        orderBy: { stage: 'desc' },
      }),
      prisma.stageProgress.findUnique({
        where: {
          sessionId_userId_stage: {
            sessionId,
            userId: user.id,
            stage: 3,
          },
        },
      }),
    ]);

    const currentStage = latestProgress?.stage ?? 0;
    if (currentStage < 3) {
      successResponse(res, {
        myNeeds: [],
        partnerNeeds: [],
        commonGround: [],
        analysisComplete: false,
        noOverlap: false,
      });
      return;
    }

    // Get partner ID
    const partnerId = await getPartnerUserId(sessionId, user.id);
    if (!partnerId) {
      errorResponse(res, 'INTERNAL_ERROR', 'Could not find partner', 500);
      return;
    }

    // Check both users have shared needs
    const userGates = stage3Progress?.gatesSatisfied as Record<string, unknown> | null;
    const userShared = userGates?.needsShared === true;
    const partnerShared = await hasPartnerSharedNeeds(sessionId, user.id);

    if (!userShared || !partnerShared) {
      successResponse(res, {
        myNeeds: [],
        partnerNeeds: [],
        commonGround: [],
        analysisComplete: false,
        noOverlap: false,
      });
      return;
    }

    // Fetch both users' vessels and needs
    const [myVessel, partnerVessel] = await Promise.all([
      getOrCreateUserVessel(sessionId, user.id),
      getOrCreateUserVessel(sessionId, partnerId),
    ]);

    const [myNeeds, partnerNeeds] = await Promise.all([
      prisma.identifiedNeed.findMany({
        where: { vesselId: myVessel.id, confirmed: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.identifiedNeed.findMany({
        where: { vesselId: partnerVessel.id, confirmed: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (myNeeds.length === 0 || partnerNeeds.length === 0) {
      successResponse(res, {
        myNeeds: [],
        partnerNeeds: [],
        commonGround: [],
        analysisComplete: false,
        noOverlap: false,
      });
      return;
    }

    const partnerProgress = await prisma.stageProgress.findUnique({
      where: {
        sessionId_userId_stage: {
          sessionId,
          userId: partnerId,
          stage: 3,
        },
      },
    });
    const partnerGates = partnerProgress?.gatesSatisfied as Record<string, unknown> | null;

    successResponse(res, {
      myNeeds: myNeeds.map((n) => ({
        id: n.id,
        category: n.category,
        need: n.need,
        confirmed: n.confirmed,
      })),
      partnerNeeds: partnerNeeds.map((n) => ({
        id: n.id,
        category: n.category,
        need: n.need,
        confirmed: n.confirmed,
      })),
      myValidated: userGates?.needsValidated === true,
      partnerValidated: partnerGates?.needsValidated === true,
      canAdvance: userGates?.needsValidated === true && partnerGates?.needsValidated === true,
      commonGround: [],
      analysisComplete: true,
      noOverlap: false,
    });
  } catch (error) {
    logger.error('[getNeedsComparison] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get needs comparison', 500);
  }
}
