/**
 * Stage 2 Controller
 *
 * Handles the Perspective Stretch / Empathy stage endpoints:
 * - POST /sessions/:id/empathy/draft - Save empathy draft
 * - GET /sessions/:id/empathy/draft - Get current draft
 * - POST /sessions/:id/empathy/consent - Consent to share
 * - GET /sessions/:id/empathy/partner - Get partner's empathy
 * - POST /sessions/:id/empathy/validate - Validate partner's empathy
 *
 * Target shape (TS-10; spec §1.2, §6 "Empathy & reconciler"): see
 * services/empathy-store.ts for the rules — immutable rounds, every status
 * move through app.empathy_set_status (the caller's own on the app
 * connection, the reconciler's and the reveal on the job connection), the
 * waiting state from v_empathy_direction_status, drafts in `draft`, the
 * subject's verdict in `empathy_review` (feedback only on explicit send).
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import {
  EmpathyStatus,
  saveEmpathyDraftRequestSchema,
  consentToShareRequestSchema,
  validateEmpathyRequestSchema,
  skipRefinementRequestSchema,
  saveValidationFeedbackDraftRequestSchema,
  refineValidationFeedbackRequestSchema,
} from '@meet-without-fear/shared';
import { notifyPartner, publishSessionEvent } from '../services/realtime';
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
  generateShareSuggestion,
  hasContextAlreadyBeenShared,
  generateValidationFeedbackReflection,
  persistAnalysis,
  supersedeCurrentResult,
} from '../services/reconciler';
import { generateAbstractGuidance, getWitnessingContent } from '../services/reconciler/analysis';
import { isSessionCreator } from '../utils/session';
import { updateContext } from '../lib/request-context';
import { routeModel, scoreAmbiguity } from '../services/model-router';
import { canTransition, transition } from '../services/empathy-state-machine';
import { cleanVisibleAIText } from '../utils/visible-text';
import { reachMilestone } from '../services/milestone-writer';
import { loadCurrentStages } from '../services/stage-shim';
import { getJobPrisma } from '../lib/prisma';
import { aiNote, aiNoteExists, deliver, messageDTO, ownStatementCopy } from '../services/empathy-messages';
import {
  currentAttempt,
  directionOf,
  directionStatuses,
  findDraft,
  grantedSubmissionConsent,
  jobMoveIfUnchanged,
  markAttemptDelivery,
  partyOf,
  recordReview,
  resubmitAttempt,
  revealedAttemptAbout,
  reviewOf,
  sessionParties,
  setAttemptStatus,
  submitAttempt,
  upsertDraft,
  type AttemptRow,
  type SessionParty,
  type TargetEmpathyStatus,
} from '../services/empathy-store';
import { attemptDTO } from '../services/empathy-status';

// ============================================================================
// Helpers
// ============================================================================

interface Stage2Caller {
  userId: string;
  sessionId: string;
  me: SessionParty;
  partner: SessionParty | null;
  parties: SessionParty[];
}

/**
 * The caller's participant and the partner (the one other present human), from
 * `req.participant` (resolved once by requireSessionAccess, TS-9). Answers 404
 * itself when the caller is not a participant.
 */
async function stage2Caller(req: Request, res: Response): Promise<Stage2Caller | null> {
  const user = req.user;
  if (!user) {
    errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
    return null;
  }
  const sessionId = req.params.id;
  const parties = await sessionParties(sessionId);
  const me = partyOf(parties, { participantId: req.participant?.id }) ?? partyOf(parties, { userId: user.id });
  if (!me) {
    errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
    return null;
  }
  const others = parties.filter(p => p.participantId !== me.participantId);
  return { userId: user.id, sessionId, me, partner: others.length === 1 ? others[0] : null, parties };
}

/** ACTIVE for everyone; INVITED for the session's creator only (as before). */
async function sessionAllowsStage2(sessionId: string, userId: string, res: Response): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } });
  if (!session) {
    errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
    return false;
  }
  if (session.status === 'ACTIVE') return true;
  if (session.status === 'INVITED' && (await isSessionCreator(sessionId, userId))) return true;
  errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
  return false;
}

async function stageOf(participantId: string): Promise<number> {
  return (await loadCurrentStages([participantId])).get(participantId)?.stage ?? 0;
}

// ============================================================================
// Helper: Trigger Reconciler and Update Statuses (symmetric path)
// ============================================================================

/**
 * Runs the reconciler for both directions and moves each still-HELD current
 * round to READY or AWAITING_SHARING (job, status-version guarded). Called when
 * both participants have submitted. A direction the asymmetric reconciler
 * already processed (not HELD) keeps its status.
 */
async function triggerReconcilerAndUpdateStatuses(sessionId: string): Promise<void> {
  try {
    const result = await runReconciler(sessionId);
    if (!result.bothCompleted) {
      logger.warn(`[triggerReconcilerAndUpdateStatuses] Reconciler incomplete: ${result.blockingReason}`);
      return;
    }

    const statuses: Record<string, TargetEmpathyStatus | null> = {};
    for (const d of result.directions) {
      if (!d) continue;
      if (d.data.status !== 'HELD') {
        statuses[d.guesser.id] = d.data.status as TargetEmpathyStatus;
        logger.info('[triggerReconcilerAndUpdateStatuses] Direction already processed; status kept', {
          status: d.data.status,
        });
        continue;
      }
      const rec = d.result.recommendation;
      const hasSignificantGaps = rec.action === 'OFFER_SHARING' || (rec.action === 'OFFER_OPTIONAL' && !!rec.suggestedShareFocus);
      const alreadyShared =
        hasSignificantGaps && (await hasContextAlreadyBeenShared(d.guesser.participantId, d.subject.participantId));
      const next: TargetEmpathyStatus = hasSignificantGaps && !alreadyShared ? 'AWAITING_SHARING' : 'READY';

      if (next === 'AWAITING_SHARING') {
        const witnessing = await getWitnessingContent(sessionId, d.subject.participantId, d.subject.id);
        await generateShareSuggestion(sessionId, d.guesser, d.subject, d.result, witnessing, {
          attemptId: d.data.attemptId,
          storedResultId: d.result.storedResultId,
          fresh: !!d.result.fresh,
        });
      } else if (d.result.fresh) {
        await persistAnalysis({
          attemptId: d.data.attemptId,
          authorParticipantId: d.guesser.participantId,
          subjectParticipantId: d.subject.participantId,
          result: d.result,
          guidance: d.result.abstractGuidance ?? generateAbstractGuidance(d.result),
        });
      }

      const moved = await jobMoveIfUnchanged(d.data.attemptId, d.data.statusVersion, next);
      statuses[d.guesser.id] = moved ? next : null;
      logger.info(`[triggerReconcilerAndUpdateStatuses] Direction → ${next}`, {
        moved,
        alignment: d.result.alignment.score,
        gaps: d.result.gaps.severity,
      });

      if (moved && next === 'AWAITING_SHARING' && d.subject.id) {
        const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
        const subjectStatus = await buildEmpathyExchangeStatus(sessionId, d.subject.id);
        await notifyPartner(sessionId, d.subject.id, 'empathy.share_suggestion', {
          forUserId: d.subject.id,
          guesserName: 'your partner',
          empathyStatus: subjectStatus,
          triggeredByUserId: d.subject.id,
        });
      }
    }

    const { buildEmpathyExchangeStatusForBothUsers } = await import('../services/empathy-status');
    const allStatuses = await buildEmpathyExchangeStatusForBothUsers(sessionId);
    await publishSessionEvent(sessionId, 'empathy.status_updated', {
      stage: 2,
      statuses: statuses as Record<string, EmpathyStatus | null>,
      empathyStatuses: allStatuses,
    });

    const { checkAndRevealBothIfReady } = await import('../services/reconciler');
    await checkAndRevealBothIfReady(sessionId);
  } catch (error) {
    logger.error('[triggerReconcilerAndUpdateStatuses] Error:', error);
    throw error;
  }
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
    const parseResult = saveEmpathyDraftRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    const { content, readyToShare } = parseResult.data;

    const caller = await stage2Caller(req, res);
    if (!caller) return;
    if (!(await sessionAllowsStage2(caller.sessionId, caller.userId, res))) return;

    const currentStage = await stageOf(caller.me.participantId);
    if (currentStage !== 2) {
      errorResponse(res, 'VALIDATION_ERROR', `Cannot save empathy draft: you are in stage ${currentStage}, but stage 2 is required`, 400);
      return;
    }
    // spec §1.1 draft: an EMPATHY draft is about a participant (CHECK) — there
    // must be a partner to imagine.
    if (!caller.partner) {
      errorResponse(res, 'VALIDATION_ERROR', 'Cannot save empathy draft before your partner has joined', 400);
      return;
    }

    const draft = await upsertDraft({
      participantId: caller.me.participantId,
      kind: 'EMPATHY',
      aboutParticipantId: caller.partner.participantId,
      content,
      readyToShare,
    });

    successResponse(res, { draftId: draft.id, savedAt: draft.updatedAt.toISOString(), readyToShare: draft.readyToShare });
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
    const caller = await stage2Caller(req, res);
    if (!caller) return;
    const { me, partner } = caller;

    const draft = partner
      ? await findDraft({ participantId: me.participantId, kind: 'EMPATHY', aboutParticipantId: partner.participantId })
      : null;
    const alreadyConsented = partner ? await grantedSubmissionConsent(me.participantId, partner.participantId) : false;
    const myAttempt = partner ? await currentAttempt(me.participantId, partner.participantId) : null;
    const isRefining = myAttempt?.status === 'REFINING';

    const canConsent = !!(draft && draft.readyToShare && (!alreadyConsented || isRefining));

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

/** The caller's own newest EMPATHY_STATEMENT copy, as the consent response's empathyMessage. */
async function ownStatementMessage(me: SessionParty) {
  if (!me.mainConversationId) return null;
  return prisma.message.findFirst({
    where: { conversationId: me.mainConversationId, kind: 'EMPATHY_STATEMENT', senderParticipantId: me.participantId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, content: true, createdAt: true },
  });
}

/**
 * Consent to share empathy with partner
 * POST /sessions/:id/empathy/consent
 *
 * Inserts round 1 of the caller's direction (HELD) with its submission
 * consent, the caller's own statement copy, and the `empathy_submitted`
 * milestone. When the partner's direction is already submitted the reconciler
 * runs for both (in the background); the response then reports the display
 * status ANALYZING ("both submitted, the review is running" — the target has
 * no ANALYZING row status; ruling R32).
 */
export async function consentToShare(req: Request, res: Response): Promise<void> {
  try {
    const parseResult = consentToShareRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    const { consent } = parseResult.data;

    const caller = await stage2Caller(req, res);
    if (!caller) return;
    const { sessionId, me, partner, userId } = caller;
    if (!(await sessionAllowsStage2(sessionId, userId, res))) return;

    const currentStage = await stageOf(me.participantId);
    if (currentStage !== 2) {
      errorResponse(res, 'VALIDATION_ERROR', `Cannot consent to share: you are in stage ${currentStage}, but stage 2 is required`, 400);
      return;
    }
    if (!partner) {
      errorResponse(res, 'VALIDATION_ERROR', 'Cannot share an empathy statement before your partner has joined', 400);
      return;
    }

    const draft = await findDraft({ participantId: me.participantId, kind: 'EMPATHY', aboutParticipantId: partner.participantId });
    if (!draft || !draft.readyToShare) {
      errorResponse(res, 'VALIDATION_ERROR', 'Draft must be marked as ready to share before consenting', 400);
      return;
    }

    const partnerSubmitted = async () => !!directionOf(await directionStatuses(sessionId), partner.participantId, me.participantId);

    const respondWithExistingAttempt = async (existing: AttemptRow) => {
      const [partnerHas, message] = await Promise.all([partnerSubmitted(), ownStatementMessage(me)]);
      successResponse(res, {
        consented: true,
        consentedAt: existing.submittedAt.toISOString(),
        partnerConsented: partnerHas,
        canReveal: partnerHas && consent,
        status: existing.status,
        empathyMessage: {
          id: message?.id ?? existing.id,
          content: message?.content ?? existing.content,
          timestamp: (message?.createdAt ?? existing.submittedAt).toISOString(),
          stage: 2,
        },
        transitionMessage: null,
      });
    };

    // Idempotency: a retry/double-click answers with the existing round.
    const existing = await currentAttempt(me.participantId, partner.participantId);
    if (existing) {
      await respondWithExistingAttempt(existing);
      return;
    }

    const now = new Date();
    const attempt = await submitAttempt({
      authorParticipantId: me.participantId,
      subjectParticipantId: partner.participantId,
      content: draft.content,
      granted: consent,
      at: now,
    });
    if (!attempt) {
      const concurrent = await currentAttempt(me.participantId, partner.participantId);
      if (concurrent) {
        await respondWithExistingAttempt(concurrent);
        return;
      }
      errorResponse(res, 'CONFLICT', 'Empathy attempt already exists for this session', 409);
      return;
    }

    // The submission milestone (a system fact: the job).
    await reachMilestone(me.participantId, 'empathy_submitted', now);

    // "Empathy statement sent" line in the author's own chat, naming the round.
    const empathyMessage = me.mainConversationId
      ? await ownStatementCopy({
          conversationId: me.mainConversationId,
          participantId: me.participantId,
          userId,
          content: draft.content,
          attemptId: attempt.id,
        })
      : null;

    const turnId = `${sessionId}-${userId}-consent-share`;
    updateContext({ turnId, sessionId, userId });
    updateSessionSummary(sessionId, userId, turnId)
      .then(() => embedSessionContent(sessionId, userId, turnId))
      .catch((err: unknown) => logger.warn('[consentToShare] Failed to update summary/embedding:', err));

    const bothShared = await partnerSubmitted();
    if (bothShared) {
      triggerReconcilerAndUpdateStatuses(sessionId).catch(err =>
        logger.warn('[consentToShare] Failed to run reconciler after both shared:', err),
      );
    }

    if (partner.userId) {
      const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
      const partnerEmpathyStatus = await buildEmpathyExchangeStatus(sessionId, partner.userId);
      await notifyPartner(sessionId, partner.userId, 'partner.empathy_shared', {
        stage: 2,
        sharedBy: userId,
        empathyStatus: partnerEmpathyStatus,
      });
    }

    let transitionMessage: { id: string; content: string; timestamp: string; stage: number } | null = null;
    try {
      let transitionContent = bothShared
        ? `Your empathy attempt has been submitted. Both empathy statements are now submitted. We'll show the next review or waiting step once the privacy-protected review is ready.`
        : `Your empathy attempt has been submitted. ${partner.name || 'Your partner'} will do the same perspective-taking step on their side. While you wait, you can use Inner Thoughts if you want a private place to process what came up.`;
      transitionContent = cleanVisibleAIText(transitionContent)
        .replace(
          new RegExp(['once you both feel', 'move forward together'].join('[^.]*'), 'gi'),
          'If something feels off, you can say what is missing before the process continues.',
        )
        .replace(new RegExp(['before', 'moving forward together'].join('\\s+'), 'gi'), 'before the process continues');

      if (me.mainConversationId) {
        const aiMessage = await aiNote(me.mainConversationId, transitionContent);
        updateSessionSummary(sessionId, userId, turnId)
          .then(() => embedSessionContent(sessionId, userId, turnId))
          .catch((err: unknown) => logger.warn('[consentToShare] Failed to update summary/embedding after transition:', err));
        const dto = await messageDTO(aiMessage, sessionId, me.participantId);
        transitionMessage = { id: dto.id, content: dto.content, timestamp: dto.timestamp, stage: dto.stage };
      }
    } catch (error) {
      logger.error('[consentToShare] Failed to generate transition message:', error);
    }

    const statementDto = empathyMessage ? await messageDTO(empathyMessage, sessionId, me.participantId) : null;
    successResponse(res, {
      consented: consent,
      consentedAt: attempt.submittedAt.toISOString(),
      partnerConsented: bothShared,
      canReveal: bothShared && consent,
      // Display status: HELD, or ANALYZING once both directions are submitted.
      status: bothShared ? 'ANALYZING' : attempt.status,
      empathyMessage: {
        id: statementDto?.id ?? attempt.id,
        content: statementDto?.content ?? attempt.content,
        timestamp: statementDto?.timestamp ?? attempt.submittedAt.toISOString(),
        stage: statementDto?.stage ?? 2,
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
 *
 * The attempt is the partner's latest round about the caller with
 * `revealed_at` set; the status shown while nothing is revealed comes from
 * v_empathy_direction_status (no content).
 */
export async function getPartnerEmpathy(req: Request, res: Response): Promise<void> {
  try {
    const caller = await stage2Caller(req, res);
    if (!caller) return;
    const { me, partner, sessionId } = caller;

    const revealed = partner ? await revealedAttemptAbout(me.participantId, partner.participantId) : null;
    const direction = partner ? directionOf(await directionStatuses(sessionId), partner.participantId, me.participantId) : undefined;
    const review = revealed ? await reviewOf(revealed.id, me.participantId) : null;

    successResponse(res, {
      attempt: revealed && partner ? attemptDTO(revealed, partner, review, { statusVersion: true }) : null,
      waitingForPartner: !revealed,
      partnerStatus: direction?.status ?? null,
      validated: review ? review.validated : false,
      validatedAt: review ? review.updatedAt.toISOString() : null,
      awaitingRevision: review ? review.validated === false : false,
    });
  } catch (error) {
    logger.error('[getPartnerEmpathy] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get partner empathy', 500);
  }
}

/**
 * Validate partner's empathy attempt
 * POST /sessions/:id/empathy/validate
 *
 * The caller is the SUBJECT of the partner's revealed round. Their verdict is
 * the `empathy_review` row; feedback is written only on this explicit send
 * (with its consent, arc review_id). The round moves as the subject's own
 * move (app connection): VALIDATED, or REFINING when feedback is sent; the
 * job stamps the delivery and delivers the feedback into the author's
 * conversation.
 */
export async function validateEmpathy(req: Request, res: Response): Promise<void> {
  try {
    const parseResult = validateEmpathyRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    const { validated, feedback } = parseResult.data;
    const trimmedFeedback = feedback?.trim();
    if (!validated && !trimmedFeedback) {
      errorResponse(res, 'VALIDATION_ERROR', 'Feedback is required when empathy is not validated', 400);
      return;
    }

    const caller = await stage2Caller(req, res);
    if (!caller) return;
    const { sessionId, me, partner, userId } = caller;
    if (!(await sessionAllowsStage2(sessionId, userId, res))) return;

    const currentStage = await stageOf(me.participantId);
    if (currentStage !== 2) {
      errorResponse(res, 'VALIDATION_ERROR', `Cannot validate empathy: you are in stage ${currentStage}, but stage 2 is required`, 400);
      return;
    }

    const partnerAttempt = partner ? await revealedAttemptAbout(me.participantId, partner.participantId) : null;
    if (!partner || !partnerAttempt) {
      errorResponse(res, 'NOT_FOUND', 'Partner empathy attempt not found', 404);
      return;
    }
    if (partnerAttempt.status !== 'REVEALED' && partnerAttempt.status !== 'VALIDATED') {
      errorResponse(res, 'VALIDATION_ERROR', 'Partner empathy is not ready for validation yet', 409);
      return;
    }

    const now = new Date();
    const sentFeedback = validated ? null : trimmedFeedback ?? null;
    const review = await recordReview({
      attemptId: partnerAttempt.id,
      reviewerParticipantId: me.participantId,
      validated,
      sentFeedback,
      at: now,
    });
    if (sentFeedback) {
      // The explicit send's consent (spec §1.3: arc review_id, no requester).
      await prisma.consent.create({
        data: { participantId: me.participantId, reviewId: review.id, decision: 'GRANTED', decidedAt: now },
        select: { id: true },
      });
    }

    if (validated) {
      if (partnerAttempt.status === 'REVEALED') {
        await setAttemptStatus(partnerAttempt.id, 'VALIDATED', { actor: 'participant' });
      }
      await markAttemptDelivery(partnerAttempt.id, 'SEEN', now);
    } else if (sentFeedback) {
      if (canTransition(partnerAttempt.status, 'VALIDATION_FEEDBACK_SENT')) {
        await setAttemptStatus(partnerAttempt.id, transition(partnerAttempt.status, 'VALIDATION_FEEDBACK_SENT'), {
          actor: 'participant',
        });
      }
      await markAttemptDelivery(partnerAttempt.id, 'DELIVERED', now);

      const validatorName = me.name || 'your partner';
      const guesserName = partner.name || 'User';
      const framingMessage = await generateValidationFeedbackReflection(sessionId, guesserName, validatorName);
      if (partner.mainConversationId) {
        // Guaranteed ordering (100 ms apart): the framing, then the feedback card.
        await aiNote(partner.mainConversationId, framingMessage, new Date(now.getTime()));
        await deliver({
          toConversationId: partner.mainConversationId,
          fromParticipantId: me.participantId,
          kind: 'VALIDATION_FEEDBACK',
          content: sentFeedback,
          sourceAttemptId: partnerAttempt.id,
          createdAt: new Date(now.getTime() + 100),
        });
      }
    }

    if (partner.userId) {
      const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
      const partnerEmpathyStatus = await buildEmpathyExchangeStatus(sessionId, partner.userId);
      if (validated) {
        await notifyPartner(
          sessionId,
          partner.userId,
          'partner.stage_completed',
          { stage: 2, validated, completedBy: userId, empathyStatus: partnerEmpathyStatus, triggeredByUserId: userId },
          { excludeUserId: userId },
        );
      }
      await notifyPartner(
        sessionId,
        partner.userId,
        'empathy.status_updated',
        {
          status: validated ? 'VALIDATED' : 'REFINING',
          forUserId: partner.userId,
          empathyStatus: partnerEmpathyStatus,
          validatedBy: userId,
          feedbackShared: !validated,
          validationFeedback: !validated ? trimmedFeedback : undefined,
          triggeredByUserId: userId,
        },
        { excludeUserId: userId },
      );
    }

    // Has the partner validated MY attempt? My own round's status says so.
    const myAttempt = await currentAttempt(me.participantId, partner.participantId);
    const partnerHasValidatedMyAttempt = myAttempt?.status === 'VALIDATED';
    if (validated && !partnerHasValidatedMyAttempt && me.mainConversationId) {
      const waitMessage =
        "You confirmed this feels right. We'll hold here while your partner reviews what you shared. Once they respond, we'll move you into the next step.";
      if (!(await aiNoteExists(me.mainConversationId, waitMessage))) {
        await aiNote(me.mainConversationId, waitMessage, now);
      }
    }

    successResponse(res, {
      validated,
      validatedAt: now.toISOString(),
      feedbackShared: !!review.feedbackSentAt,
      awaitingRevision: validated === false,
      canAdvance: validated,
      partnerValidated: partnerHasValidatedMyAttempt,
    });

    if (validated && partnerHasValidatedMyAttempt) {
      triggerStage3Transition(sessionId, userId, caller.parties).catch(err =>
        logger.error('[validateEmpathy] Failed to trigger stage 3 transition:', err),
      );
    }
  } catch (error) {
    logger.error('[validateEmpathy] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to validate empathy', 500);
  }
}

/**
 * The job's walk of an author's current round to VALIDATED along the table
 * (REFINING/AWAITING_SHARING/HELD → READY → REVEALED → VALIDATED); the reveal
 * re-checks its gate and keeps the first revealed_at.
 */
async function jobWalkToValidated(attempt: AttemptRow): Promise<boolean> {
  let status = attempt.status;
  const job = getJobPrisma();
  try {
    if (status === 'HELD' || status === 'AWAITING_SHARING' || status === 'REFINING') {
      await setAttemptStatus(attempt.id, 'READY', { actor: 'job', client: job });
      status = 'READY';
    }
    if (status === 'READY') {
      await setAttemptStatus(attempt.id, 'REVEALED', { actor: 'job', client: job });
      await markAttemptDelivery(attempt.id, 'DELIVERED');
      status = 'REVEALED';
    }
    if (status === 'REVEALED') {
      await setAttemptStatus(attempt.id, 'VALIDATED', { actor: 'job', client: job });
      await markAttemptDelivery(attempt.id, 'SEEN');
      status = 'VALIDATED';
    }
  } catch (error) {
    logger.warn('[skipRefinement] Could not walk the round to VALIDATED', { error: (error as Error).message, status });
  }
  return status === 'VALIDATED';
}

/**
 * Handle "Skip Refinement" / "Acceptance Check"
 * POST /sessions/:id/empathy/skip-refinement
 *
 * The author accepts the difference and moves on: the job walks their round to
 * VALIDATED (the author may not validate their own round; spec §1.2 table).
 * There is no review row — the reviewer of an attempt is its subject (trigger).
 */
export async function skipRefinement(req: Request, res: Response): Promise<void> {
  try {
    const parseResult = skipRefinementRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400);
      return;
    }
    const { willingToAccept } = parseResult.data;

    const caller = await stage2Caller(req, res);
    if (!caller) return;
    const { sessionId, me, partner, userId } = caller;

    const attempt = partner ? await currentAttempt(me.participantId, partner.participantId) : null;
    if (!partner || !attempt) {
      errorResponse(res, 'NOT_FOUND', 'Empathy attempt not found', 404);
      return;
    }

    await jobWalkToValidated(attempt);

    if (partner.userId) {
      await notifyPartner(sessionId, partner.userId, 'partner.skipped_refinement', { willingToAccept });
    }

    // The partner's round about me is VALIDATED too → Stage 3.
    const partnerAboutMe = await revealedAttemptAbout(me.participantId, partner.participantId);
    if (partnerAboutMe?.status === 'VALIDATED') {
      triggerStage3Transition(sessionId, userId, caller.parties).catch(e => logger.error('[Stage2] Stage 3 transition failed:', e));
    } else {
      logger.info('[skipRefinement] Waiting for partner Stage 2 empathy completion before Stage 3 transition', { sessionId });
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
 *
 * The unsent text is the subject's private `draft(kind VALIDATION_FEEDBACK)`
 * pointing at the attempt it answers (participant key; spec §1.2 empathy_review
 * "the unsent coached text is a draft"). The author never reads it.
 */
export async function saveValidationFeedbackDraft(req: Request, res: Response): Promise<void> {
  try {
    const parseResult = saveValidationFeedbackDraftRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400);
      return;
    }
    const { content, readyToShare } = parseResult.data;

    const caller = await stage2Caller(req, res);
    if (!caller) return;
    const { me, partner } = caller;
    // The attempt the feedback answers: the revealed round about me, else the
    // partner's current round (its id only — the subject never reads an
    // unrevealed row's content).
    const target = partner
      ? (await revealedAttemptAbout(me.participantId, partner.participantId)) ??
        (await currentAttempt(partner.participantId, me.participantId))
      : null;
    if (!target) {
      errorResponse(res, 'NOT_FOUND', 'Partner empathy attempt not found', 404);
      return;
    }

    const draft = await upsertDraft({
      participantId: me.participantId,
      kind: 'VALIDATION_FEEDBACK',
      attemptId: target.id,
      content,
      readyToShare: readyToShare ?? false,
    });

    successResponse(res, { draftId: draft.id, savedAt: draft.updatedAt.toISOString(), readyToShare: draft.readyToShare });
  } catch (error) {
    logger.error('[saveValidationFeedbackDraft] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to save feedback draft', 500);
  }
}

/**
 * Refine Validation Feedback (Feedback Coach Flow)
 * POST /sessions/:id/empathy/validation-feedback/refine
 */
export async function refineValidationFeedback(req: Request, res: Response): Promise<void> {
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

    const turnId = `${sessionId}-${user.id}-feedback-refine-${Date.now()}`;
    updateContext({ turnId, sessionId, userId: user.id });
    const isRefinement = history && history.length > 0;

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

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (isRefinement) {
      for (const entry of history) {
        messages.push({ role: entry.role === 'coach' ? 'assistant' : 'user', content: entry.content });
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
    let proposedFeedback = '';
    if (aiResponse) {
      try {
        const parsed = extractJsonFromResponse(aiResponse) as Record<string, unknown>;
        response = typeof parsed.response === 'string' ? parsed.response : aiResponse;
        proposedFeedback = typeof parsed.proposedFeedback === 'string' ? parsed.proposedFeedback : '';
      } catch {
        response = aiResponse;
      }
    }

    successResponse(res, { response, proposedFeedback });
  } catch (error) {
    logger.error('[refineValidationFeedback] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to refine feedback', 500);
  }
}

/**
 * Both directions validated: each participant's transition message (job),
 * the session-scoped `empathy_validated` milestone for both (written once all
 * have validated — the stage-shim writer contract), and the end of the Stage 2
 * sharing window (open offers EXPIRED, job).
 */
async function triggerStage3Transition(sessionId: string, userId: string, parties: SessionParty[]) {
  try {
    const actor = partyOf(parties, { userId });
    const nameOf = (p?: SessionParty) => p?.name || 'User';
    const messages: Array<{ id: string; content: string; timestamp: string; forUserId: string }> = [];

    for (const p of parties) {
      const other = parties.find(o => o.participantId !== p.participantId);
      const uName = nameOf(p);
      const pName = other ? nameOf(other) : 'Partner';

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

      const aiResponse = await getSonnetResponse({
        systemPrompt: transitionPrompt,
        messages: [{ role: 'user', content: 'Generate transition message.' }],
        maxTokens: 512,
        sessionId,
        operation: 'stage3-transition',
        turnId: `${sessionId}-stage3-transition-${p.userId}-${Date.now()}`,
        callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
      });

      let content = `${uName}, you did something meaningful — you really tried to understand ${pName}'s experience. Now it's your turn: let's explore what you need most from this situation.`;
      if (aiResponse) {
        try {
          const parsed = extractJsonFromResponse(aiResponse) as Record<string, unknown>;
          if (typeof parsed.response === 'string') content = cleanVisibleAIText(parsed.response);
        } catch (e) {
          logger.warn('Failed to parse transition AI response', e);
        }
      }

      // The milestone first: the transition message is the participant's first stage-3 row.
      await reachMilestone(p.participantId, 'empathy_validated');
      if (p.mainConversationId && p.userId) {
        const msg = await aiNote(p.mainConversationId, content);
        messages.push({ id: msg.id, content: msg.content, timestamp: msg.createdAt.toISOString(), forUserId: p.userId });
      }
    }

    // Stage 2 sharing window closed: open offers expire (job).
    const pids = parties.map(p => p.participantId);
    await getJobPrisma().$executeRaw`UPDATE context_share_offer SET status = 'EXPIRED'
      WHERE subject_participant_id = ANY(${pids}::uuid[]) AND status IN ('PENDING', 'OFFERED')`;

    if (parties.length > 1) {
      for (const m of messages) {
        await publishSessionEvent(sessionId, 'partner.stage_completed', {
          forUserId: m.forUserId,
          previousStage: 2,
          currentStage: 3,
          userId,
          triggeredByUserId: userId,
          message: { id: m.id, content: m.content, timestamp: m.timestamp, forUserId: m.forUserId },
        });
      }
      await publishSessionEvent(sessionId, 'stage.progress', { previousStage: 2, stage: 3, userId, triggeredByUserId: userId });
    }

    void actor;
    const embedTurnId = `${sessionId}-stage3-transition-${Date.now()}`;
    embedSessionContent(sessionId, userId, embedTurnId).catch((err: unknown) =>
      logger.warn('[Stage2] Failed to embed session content:', err),
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
export async function getEmpathyExchangeStatus(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
    successResponse(res, await buildEmpathyExchangeStatus(req.params.id, user.id));
  } catch (error) {
    logger.error('[getEmpathyExchangeStatus] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get empathy exchange status', 500);
  }
}

/** The statuses in which the author refines and resubmits (NEEDS_WORK ≡ AWAITING_SHARING on the target). */
const REFINABLE: ReadonlySet<string> = new Set(['AWAITING_SHARING', 'REFINING']);

/**
 * Refine empathy statement through conversation with AI
 * POST /sessions/:id/empathy/refine
 *
 * Uses only the abstract guidance (reconciler_guidance, author-visible) and the
 * context delivered into the author's own conversation.
 */
export async function refineEmpathy(req: Request, res: Response): Promise<void> {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      errorResponse(res, 'VALIDATION_ERROR', 'Message is required', 400);
      return;
    }
    const caller = await stage2Caller(req, res);
    if (!caller) return;
    const { sessionId, me, partner, userId } = caller;

    const attempt = partner ? await currentAttempt(me.participantId, partner.participantId) : null;
    if (!attempt) {
      errorResponse(res, 'NOT_FOUND', 'Empathy attempt not found', 404);
      return;
    }
    if (!REFINABLE.has(attempt.status)) {
      errorResponse(res, 'VALIDATION_ERROR', 'Empathy refinement is only available when status is NEEDS_WORK or REFINING', 400);
      return;
    }

    const guidance = await prisma.reconcilerGuidance.findFirst({
      where: { authorParticipantId: me.participantId, result: { attemptId: attempt.id, supersededAt: null } },
      select: { areaHint: true, promptSeed: true },
    });
    const partnerName = partner?.name ?? 'your partner';
    const areaHint = guidance?.areaHint ?? 'deeper emotional experiences';
    const promptSeed = guidance?.promptSeed ?? 'what might be underneath the surface';

    let sharedContextSection = '';
    if (attempt.status === 'REFINING') {
      const contextResult = await getSharedContextForGuesser(sessionId, userId);
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

    const turnId = `${sessionId}-${userId}-empathy-refinement-${Date.now()}`;
    updateContext({ turnId, sessionId, userId });

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
        response = aiResponse;
      }
    }

    successResponse(res, { response, proposedRevision, canResubmit });
  } catch (error) {
    logger.error('[refineEmpathy] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to refine empathy', 500);
  }
}

/**
 * Resubmit revised empathy statement for re-analysis
 * POST /sessions/:id/empathy/resubmit
 *
 * A NEW ROUND: `app.empathy_set_status(round n, 'SUPERSEDED', content)` (the
 * author, app connection) retires round n and inserts round n+1 HELD; the
 * author's chat gains the new statement naming round n+1; the reconciler runs
 * for this direction in the background.
 */
export async function resubmitEmpathy(req: Request, res: Response): Promise<void> {
  try {
    const { content } = req.body;
    if (!content || typeof content !== 'string') {
      errorResponse(res, 'VALIDATION_ERROR', 'Content is required', 400);
      return;
    }
    const caller = await stage2Caller(req, res);
    if (!caller) return;
    const { sessionId, me, partner, userId } = caller;

    const attempt = partner ? await currentAttempt(me.participantId, partner.participantId) : null;
    if (!partner || !attempt) {
      errorResponse(res, 'NOT_FOUND', 'Empathy attempt not found', 404);
      return;
    }
    if (!REFINABLE.has(attempt.status)) {
      errorResponse(res, 'VALIDATION_ERROR', 'Can only resubmit when status is NEEDS_WORK or REFINING', 400);
      return;
    }

    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalize(content) === normalize(attempt.content)) {
      errorResponse(
        res,
        'VALIDATION_ERROR',
        "Your empathy statement hasn't changed. Please revise it based on the feedback you received before resubmitting.",
        400,
      );
      return;
    }

    const newRoundId = await resubmitAttempt(attempt.id, content);
    // The retired round's analysis is no longer current (job).
    await supersedeCurrentResult(attempt.id);

    const newMessage = me.mainConversationId
      ? await ownStatementCopy({
          conversationId: me.mainConversationId,
          participantId: me.participantId,
          userId,
          content,
          attemptId: newRoundId,
        })
      : null;
    logger.info(`[resubmitEmpathy] Round ${attempt.round + 1} (${newRoundId}) supersedes round ${attempt.round}`);

    const turnId = `${sessionId}-${userId}-resubmit-empathy`;
    updateContext({ turnId, sessionId, userId });
    embedSessionContent(sessionId, userId, turnId).catch((err: unknown) =>
      logger.warn('[resubmitEmpathy] Failed to embed session content:', err),
    );

    if (partner.userId) {
      triggerReconcilerForUser(sessionId, userId, partner.userId).catch(err =>
        logger.warn('[resubmitEmpathy] Failed to run reconciler:', err),
      );
    }

    let transitionMessage: { id: string; content: string; timestamp: string; stage: number } | null = null;
    try {
      const transitionContent = `You're showing real understanding here. We'll send this through a separate privacy-protected review to check whether your updated perspective is ready to share.`;
      if (me.mainConversationId) {
        const aiMessage = await aiNote(me.mainConversationId, transitionContent);
        embedSessionContent(sessionId, userId, turnId).catch((err: unknown) =>
          logger.warn('[resubmitEmpathy] Failed to embed session content:', err),
        );
        updateSessionSummary(sessionId, userId, turnId).catch(err =>
          logger.warn('[resubmitEmpathy] Failed to update session summary after transition:', err),
        );
        const dto = await messageDTO(aiMessage, sessionId, me.participantId);
        transitionMessage = { id: dto.id, content: dto.content, timestamp: dto.timestamp, stage: dto.stage };
      }
    } catch (error) {
      logger.error('[resubmitEmpathy] Failed to generate transition message:', error);
    }

    const statementDto = newMessage ? await messageDTO(newMessage, sessionId, me.participantId) : null;
    successResponse(res, {
      // Display status (the target round is HELD while the review runs).
      status: 'ANALYZING',
      message:
        'We are sending this through a separate privacy-protected review to check whether your updated understanding is ready to share...',
      empathyMessage: {
        id: statementDto?.id ?? newRoundId,
        content,
        timestamp: statementDto?.timestamp ?? new Date().toISOString(),
        stage: statementDto?.stage ?? 2,
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
 * Run the reconciler for a single direction after a resubmit (asymmetric
 * flow: the partner may not have submitted), then check the reveal.
 */
async function triggerReconcilerForUser(sessionId: string, guesserId: string, subjectId: string): Promise<void> {
  const { runReconcilerForDirection, checkAndRevealBothIfReady } = await import('../services/reconciler');
  try {
    const result = await runReconcilerForDirection(sessionId, guesserId, subjectId);
    if (!result.result) {
      logger.warn('[triggerReconcilerForUser] No reconciler result returned');
      return;
    }
    logger.info(`[triggerReconcilerForUser] Reconciler complete: empathyStatus=${result.empathyStatus}`);
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
 */
export async function getShareSuggestion(req: Request, res: Response): Promise<void> {
  try {
    const caller = await stage2Caller(req, res);
    if (!caller) return;
    if ((await stageOf(caller.me.participantId)) !== 2) {
      successResponse(res, { hasSuggestion: false, suggestion: null });
      return;
    }
    const result = await getShareSuggestionForUser(caller.sessionId, caller.userId);
    if (!result.hasSuggestion || !result.suggestion) {
      successResponse(res, { hasSuggestion: false, suggestion: null });
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
 */
export async function respondToShareSuggestion(req: Request, res: Response): Promise<void> {
  try {
    const { action, refinedContent } = req.body;
    if (!action || !['accept', 'decline', 'refine'].includes(action)) {
      errorResponse(res, 'VALIDATION_ERROR', 'Action must be one of: accept, decline, refine', 400);
      return;
    }
    if (action === 'refine' && (!refinedContent || typeof refinedContent !== 'string')) {
      errorResponse(res, 'VALIDATION_ERROR', 'refinedContent is required when action is refine', 400);
      return;
    }
    const caller = await stage2Caller(req, res);
    if (!caller) return;
    const { sessionId, partner, userId } = caller;

    let result;
    try {
      result = await reconcilerRespondToShareSuggestion(sessionId, userId, {
        action: action as 'accept' | 'decline' | 'refine',
        refinedContent: action === 'refine' ? refinedContent : undefined,
      });
    } catch {
      errorResponse(res, 'VALIDATION_ERROR', 'No pending share suggestion found or already responded', 400);
      return;
    }

    if ((action === 'accept' || action === 'refine') && partner?.userId) {
      const { buildEmpathyExchangeStatus } = await import('../services/empathy-status');
      const guesserEmpathyStatus = await buildEmpathyExchangeStatus(sessionId, partner.userId);
      await publishSessionEvent(sessionId, 'empathy.refining', {
        guesserId: partner.userId,
        forUserId: partner.userId,
        empathyStatus: guesserEmpathyStatus,
        hasNewContext: true,
      });
    }

    successResponse(res, { success: true, status: result.status, sharedContent: result.sharedContent });
  } catch (error) {
    logger.error('[respondToShareSuggestion] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to respond to share suggestion', 500);
  }
}
