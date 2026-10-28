/**
 * Stage 0 Controller - Curiosity Compact Signing
 *
 * Handles the compact signing process where both parties agree to
 * engage in the Meet Without Fear conflict resolution process.
 *
 * Target shape (TS-9): signing is the participant reaching the
 * `compact_signed` milestone (self-assertable: the request path writes it).
 * Reaching it completes stage 0 in the stage shim, so the old "advance to
 * Stage 1" rows are implied. The partner's signature is their milestone
 * (participant_milestone is visible to co-participants).
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { getJobPrisma, prisma } from '../lib/prisma';
import { notifyPartner } from '../services/realtime';
import { ErrorCode, signCompactRequestSchema } from '@meet-without-fear/shared';
import { successResponse, errorResponse } from '../utils/response';
import { getPartnerParticipant, type ResolvedParticipant } from '../services/participant-resolver';
import { loadMilestones } from '../services/stage-shim';
import { reachMilestone } from '../services/milestone-writer';

// ============================================================================
// Helper Functions
// ============================================================================

/** When `participantId` signed the compact, or null. */
async function signedAt(participantId: string): Promise<Date | null> {
  const milestones = (await loadMilestones([participantId])).get(participantId) ?? [];
  return milestones.find(m => m.key === 'compact_signed')?.reachedAt ?? null;
}

/** The caller's participant, or a 404 written to `res`. */
function participantOr404(req: Request, res: Response): ResolvedParticipant | null {
  if (!req.participant) {
    errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
    return null;
  }
  return req.participant;
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * Sign the Curiosity Compact
 * POST /sessions/:id/compact/sign
 */
export async function signCompact(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;

    // Validate request body
    const parseResult = signCompactRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Invalid request: agreed must be true',
        400,
        parseResult.error.issues,
      );
      return;
    }

    const participant = participantOr404(req, res);
    if (!participant) return;

    const now = new Date();
    const recorded = await reachMilestone(participant.id, 'compact_signed', now);
    if (!recorded) {
      errorResponse(res, ErrorCode.CONFLICT, 'Compact already signed', 409);
      return;
    }
    const signedAtIso = now.toISOString();

    // Check if partner has signed
    const partner = await getPartnerParticipant(participant.id);
    const partnerSigned = partner ? (await signedAt(partner.participantId)) !== null : false;
    const canAdvance = partnerSigned;

    // If both have signed, ensure the session is ACTIVE — through
    // app.session_set_status, the only writer of session.status, as the job.
    if (partnerSigned) {
      const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } });
      if (session && session.status !== 'ACTIVE' && session.status !== 'RESOLVED') {
        await getJobPrisma()
          .$executeRaw`SELECT app.session_set_status(${sessionId}::uuid, 'ACTIVE'::public.session_status)`
          .then(() => logger.info(`[signCompact] Updated session ${sessionId} status to ACTIVE (both signed)`))
          .catch((err: unknown) => logger.warn(`[signCompact] Session ${sessionId} not moved to ACTIVE:`, err));
      }
      logger.info(`[signCompact] Advanced user ${user.id} to Stage 1`);
    }

    // Determine who to notify: if the signing user is the invitee, notify the
    // inviter; otherwise the partner.
    const invitation = await prisma.invitation.findFirst({
      where: { sessionId },
      select: { invitedByParticipant: { select: { id: true, userId: true } } },
    });
    let notificationTargetId: string | null = null;
    if (invitation && invitation.invitedByParticipant.id !== participant.id) {
      notificationTargetId = invitation.invitedByParticipant.userId;
    } else if (partner?.userId) {
      notificationTargetId = partner.userId;
    }

    // Notify via real-time and create in-app notification
    if (notificationTargetId) {
      await notifyPartner(sessionId, notificationTargetId, 'partner.signed_compact', {
        signedBy: user.id,
        signedAt: signedAtIso,
        triggeredByUserId: user.id,
      });
    }

    successResponse(res, {
      signed: true,
      signedAt: signedAtIso,
      partnerSigned,
      canAdvance,
    });
  } catch (error) {
    logger.error('[signCompact] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to sign compact', 500);
  }
}

/**
 * Get Compact signing status
 * GET /sessions/:id/compact/status
 */
export async function getCompactStatus(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
      return;
    }

    const sessionId = req.params.id;
    const participant = participantOr404(req, res);
    if (!participant) return;
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { relationshipId: true } });
    if (!session) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
      return;
    }

    const mine = await signedAt(participant.id);
    const mySigned = mine !== null;
    const mySignedAt = mine?.toISOString() ?? null;

    // Only show partner status if user has signed (privacy constraint)
    let partnerSigned = false;
    let partnerSignedAt: string | null = null;

    if (mySigned) {
      const partner = await getPartnerParticipant(participant.id);
      const theirs = partner ? await signedAt(partner.participantId) : null;
      partnerSigned = theirs !== null;
      partnerSignedAt = theirs?.toISOString() ?? null;
    }

    // Check if this is the first session for this relationship
    const priorResolvedCount = await prisma.session.count({
      where: {
        relationshipId: session.relationshipId,
        id: { not: sessionId },
        status: 'RESOLVED',
      },
    });

    successResponse(res, {
      mySigned,
      mySignedAt,
      partnerSigned,
      partnerSignedAt,
      canAdvance: mySigned && partnerSigned,
      isFirstSession: priorResolvedCount === 0,
    });
  } catch (error) {
    logger.error('[getCompactStatus] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to get compact status', 500);
  }
}
