/**
 * Reconciler Controller
 *
 * Handles endpoints for the Empathy Reconciler system:
 * - POST /sessions/:id/reconciler/run - Run reconciler analysis
 * - GET /sessions/:id/reconciler/status - Get reconciler status
 * - GET /sessions/:id/reconciler/share-offer - Get pending share offer for user
 * - POST /sessions/:id/reconciler/share-offer/respond - Respond to share offer
 * - GET /sessions/:id/reconciler/summary - Get reconciler summary
 *
 * Target shape (TS-10; spec §1.2): a `reconciler_result` is its SUBJECT's
 * only. Every handler returns the caller what the caller may see — their own
 * subject-side analyses, their own offers (as subject), and the direction
 * statuses — never the analysis of an attempt they authored nor the
 * existence of an offer made to their partner (golden R6, R7).
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import {
  runReconcilerRequestSchema,
  respondToShareOfferRequestSchema,
  type RunReconcilerResponse,
  type ReconcilerStatusResponse,
  type RespondToShareOfferResponse,
  type ReconcilerResult,
} from '@meet-without-fear/shared';
import {
  runReconciler,
  generateShareOffer,
  respondToShareSuggestion,
  shareAccepted,
  resumeUndeliveredShare,
  getReconcilerStatus,
  generateReconcilerSummary,
  generatePostShareContinuation,
  getFallbackContinuation,
  generateContextReceivedReflection,
} from '../services/reconciler';
import { successResponse, errorResponse } from '../utils/response';
import { notifyPartner } from '../services/realtime';
import { pingStage2Refresh } from '../services/empathy-realtime';
import { routeModel, scoreAmbiguity } from '../services/model-router';
import { suggestSendableRewrite } from '../services/attacking-language';
import { getModelCompletion, BrainActivityCallType } from '../lib/bedrock';
import { partyOf, sessionParties, type SessionParty } from '../services/empathy-store';
import { aiNote } from '../services/empathy-messages';
import { loadCurrentStages } from '../services/stage-shim';

// ============================================================================
// Helpers
// ============================================================================

interface ReconcilerCaller {
  userId: string;
  userName: string;
  sessionId: string;
  status: string;
  me: SessionParty;
  parties: SessionParty[];
}

/** The caller's participant (requireSessionAccess) and the session's status. */
async function reconcilerCaller(req: Request, res: Response): Promise<ReconcilerCaller | null> {
  const user = req.user;
  if (!user) {
    errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
    return null;
  }
  const sessionId = req.params.id;
  const [session, parties] = await Promise.all([
    prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } }),
    sessionParties(sessionId),
  ]);
  const me = partyOf(parties, { participantId: req.participant?.id }) ?? partyOf(parties, { userId: user.id });
  if (!session || !me) {
    errorResponse(res, 'NOT_FOUND', 'Session not found or access denied', 404);
    return null;
  }
  return { userId: user.id, userName: user.name || 'User', sessionId, status: session.status, me, parties };
}

const direction = (result: ReconcilerResult | null) =>
  result
    ? {
        guesserId: '',
        guesserName: '',
        subjectId: '',
        subjectName: '',
        result,
        shareOfferStatus: 'NOT_OFFERED' as const,
        analyzedAt: new Date().toISOString(),
      }
    : null;

/** The caller's open offer (as subject), with its result and the attempt's author. */
async function myOpenOffer(sessionId: string, me: SessionParty, where: { id?: string } = {}) {
  return prisma.contextShareOffer.findFirst({
    where: {
      ...(where.id ? { id: where.id } : {}),
      subjectParticipantId: me.participantId,
      status: { in: ['OFFERED', 'PENDING'] },
      attempt: { authorParticipant: { sessionId } },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      result: true,
      attempt: { select: { id: true, authorParticipantId: true, status: true, statusVersion: true } },
    },
  });
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * Run reconciler analysis for a session
 * POST /sessions/:id/reconciler/run
 *
 * The analysis runs for both directions (the job's), but the response carries
 * only the directions whose SUBJECT is the caller.
 */
export async function runReconcilerHandler(req: Request, res: Response): Promise<void> {
  try {
    const parseResult = runReconcilerRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    const caller = await reconcilerCaller(req, res);
    if (!caller) return;
    if (caller.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    const result = await runReconciler(caller.sessionId, parseResult.data.forUserId, {
      forParticipantId: caller.me.participantId,
      persist: true,
    });

    const response: RunReconcilerResponse = {
      sessionId: caller.sessionId,
      aUnderstandingB: direction(result.aUnderstandingB),
      bUnderstandingA: direction(result.bUnderstandingA),
      bothCompleted: result.bothCompleted,
      readyToProceed: result.readyToProceed,
      blockingReason: result.blockingReason,
    };
    successResponse(res, response);
  } catch (error) {
    logger.error('[runReconcilerHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to run reconciler', 500);
  }
}

/**
 * Get reconciler status for a session
 * GET /sessions/:id/reconciler/status
 */
export async function getReconcilerStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const caller = await reconcilerCaller(req, res);
    if (!caller) return;
    const status = await getReconcilerStatus(caller.sessionId, caller.me.participantId);
    const response: ReconcilerStatusResponse = {
      sessionId: caller.sessionId,
      hasRun: status.hasRun,
      aUnderstandingB: direction(status.aUnderstandingB),
      bUnderstandingA: direction(status.bUnderstandingA),
      pendingShareOffers: status.pendingShareOffers,
      readyForStage3: status.readyForStage3,
    };
    successResponse(res, response);
  } catch (error) {
    logger.error('[getReconcilerStatusHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get reconciler status', 500);
  }
}

/**
 * Get pending share offer for the current user (as subject)
 * GET /sessions/:id/reconciler/share-offer
 */
export async function getShareOfferHandler(req: Request, res: Response): Promise<void> {
  try {
    const caller = await reconcilerCaller(req, res);
    if (!caller) return;
    const { sessionId, me, parties } = caller;

    const shareOffer = await myOpenOffer(sessionId, me);
    if (!shareOffer) {
      const offer = await generateShareOffer(sessionId, caller.userId);
      if (offer) {
        successResponse(res, {
          hasSuggestion: true,
          suggestion: {
            guesserName: 'Your partner',
            suggestedContent: offer.suggestedContent,
            reason: offer.suggestedReason || offer.gapDescription || 'To help them understand better',
            canRefine: true,
          },
        });
        return;
      }
      successResponse(res, { hasSuggestion: false, suggestion: null });
      return;
    }

    const guesser = partyOf(parties, { participantId: shareOffer.attempt.authorParticipantId });
    if (shareOffer.status === 'PENDING') {
      // The subject's own row (app connection).
      await prisma.contextShareOffer.update({
        where: { id: shareOffer.id },
        data: { status: 'OFFERED', offeredAt: shareOffer.offeredAt ?? new Date() },
        select: { id: true },
      });
      logger.info(`[Reconciler] Marked share offer ${shareOffer.id} as OFFERED`);
    }

    successResponse(res, {
      hasSuggestion: true,
      suggestion: {
        offerId: shareOffer.id,
        guesserName: guesser?.name || 'Your partner',
        suggestedShareFocus: shareOffer.result.suggestedShareFocus || null,
        suggestedContent: shareOffer.suggestedContent || shareOffer.offerMessage || '',
        reason:
          shareOffer.suggestedReason ||
          shareOffer.result.mostImportantGap ||
          'This will help them understand your perspective more fully.',
        canRefine: true,
        action: shareOffer.result.recommendedAction as 'PROCEED' | 'OFFER_OPTIONAL' | 'OFFER_SHARING',
      },
    });
  } catch (error) {
    logger.error('[getShareOfferHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get share offer', 500);
  }
}

/** Tell the guesser that context arrived (realtime; user-keyed envelope). */
async function notifyContextShared(sessionId: string, actorUserId: string, guesser: SessionParty | undefined) {
  if (!guesser?.userId) return;
  // Content-free (I1/R36): no status DTO (the guesser's unrevealed round) and
  // no shared text on the session channel; mobile refetches messages + status.
  await notifyPartner(
    sessionId,
    guesser.userId,
    'empathy.context_shared',
    {
      stage: 2,
      sharedBy: actorUserId,
      forUserId: guesser.userId,
      triggeredByUserId: actorUserId,
    },
    { excludeUserId: actorUserId },
  );
}

/**
 * Respond to a share offer
 * POST /sessions/:id/reconciler/share-offer/respond
 */
export async function respondToShareOfferHandler(req: Request, res: Response): Promise<void> {
  try {
    const parseResult = respondToShareOfferRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      errorResponse(res, 'VALIDATION_ERROR', 'Invalid request body', 400, parseResult.error.issues);
      return;
    }
    const caller = await reconcilerCaller(req, res);
    if (!caller) return;
    if (caller.status !== 'ACTIVE') {
      errorResponse(res, 'SESSION_NOT_ACTIVE', 'Session is not active', 400);
      return;
    }

    const result = await respondToShareSuggestion(caller.sessionId, caller.userId, {
      action: parseResult.data.action as 'accept' | 'decline' | 'refine',
      refinedContent: parseResult.data.refinedContent,
    });

    if (result.status === 'shared' && result.guesserUpdated) {
      const guesser = caller.parties.find(p => p.participantId !== caller.me.participantId);
      await notifyContextShared(caller.sessionId, caller.userId, guesser);
    }

    const response: RespondToShareOfferResponse = {
      status: result.status as RespondToShareOfferResponse['status'],
      sharedContent: result.sharedContent,
      guesserUpdated: result.guesserUpdated,
    };
    successResponse(res, response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Share offer already processed') {
      errorResponse(res, 'CONFLICT', 'Share offer has already been processed', 409);
      return;
    }
    logger.error('[respondToShareOfferHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to respond to share offer', 500);
  }
}

/**
 * Get reconciler summary after completion
 * GET /sessions/:id/reconciler/summary
 *
 * Ruling R24: built for the caller from their own results (as subject), their
 * own attempt and the direction statuses.
 */
export async function getReconcilerSummaryHandler(req: Request, res: Response): Promise<void> {
  try {
    const caller = await reconcilerCaller(req, res);
    if (!caller) return;
    const status = await getReconcilerStatus(caller.sessionId, caller.me.participantId);
    if (!status.hasRun) {
      errorResponse(res, 'VALIDATION_ERROR', 'Reconciler has not run yet', 400);
      return;
    }
    if (!status.readyForStage3) {
      errorResponse(res, 'VALIDATION_ERROR', 'Reconciliation not yet complete - pending share offers', 400);
      return;
    }
    const summary = await generateReconcilerSummary(caller.sessionId, caller.me.participantId);
    if (!summary) {
      errorResponse(res, 'INTERNAL_ERROR', 'Failed to generate reconciler summary', 500);
      return;
    }
    successResponse(res, summary);
  } catch (error) {
    logger.error('[getReconcilerSummaryHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get reconciler summary', 500);
  }
}

/**
 * Skip share offer
 * POST /sessions/:id/reconciler/share-offer/skip
 *
 * The target has no SKIPPED status (spec §3 share_offer_status): a skip is the
 * subject's decline — the offer DECLINED with a DENIED consent, the author's
 * direction released. The response keeps its shape.
 */
export async function skipShareOfferHandler(req: Request, res: Response): Promise<void> {
  try {
    const caller = await reconcilerCaller(req, res);
    if (!caller) return;
    const open = await prisma.contextShareOffer.findFirst({
      where: {
        subjectParticipantId: caller.me.participantId,
        status: 'OFFERED',
        attempt: { authorParticipant: { sessionId: caller.sessionId } },
      },
      select: { id: true },
    });
    if (!open) {
      errorResponse(res, 'NOT_FOUND', 'No pending share offer found', 404);
      return;
    }
    await respondToShareSuggestion(caller.sessionId, caller.userId, { action: 'decline' });
    successResponse(res, { status: 'SKIPPED', message: 'Share offer skipped. You can proceed to the next stage.' });
  } catch (error) {
    logger.error('[skipShareOfferHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to skip share offer', 500);
  }
}

/**
 * Generate a share draft for the user based on suggestedShareFocus.
 * POST /sessions/:id/reconciler/share-offer/generate-draft
 */
export async function generateShareDraftHandler(req: Request, res: Response): Promise<void> {
  try {
    const caller = await reconcilerCaller(req, res);
    if (!caller) return;
    const { sessionId, me, parties, userName } = caller;

    const shareOffer = await myOpenOffer(sessionId, me);
    if (!shareOffer) {
      errorResponse(res, 'NOT_FOUND', 'No pending share offer found', 404);
      return;
    }
    const suggestedShareFocus = shareOffer.result.suggestedShareFocus;
    const guesser = partyOf(parties, { participantId: shareOffer.attempt.authorParticipantId });
    const guesserName = guesser?.name || 'your partner';
    if (!suggestedShareFocus) {
      errorResponse(res, 'VALIDATION_ERROR', 'No share focus available', 400);
      return;
    }

    // The caller's own conversation (their turns and the AI's replies to them).
    const conversationMessages = me.mainConversationId
      ? await prisma.message.findMany({
          where: { conversationId: me.mainConversationId, kind: 'CHAT' },
          orderBy: { createdAt: 'asc' },
          take: 30,
          select: { content: true, role: true },
        })
      : [];
    const conversationTranscript = conversationMessages
      .map(m => `${m.role === 'USER' ? userName : 'AI'}: ${m.content}`)
      .join('\n\n');

    const turnId = `${sessionId}-share-draft-${Date.now()}`;
    const routingDecision = routeModel({
      requestType: 'draft',
      conflictIntensity: 4,
      ambiguityScore: scoreAmbiguity(suggestedShareFocus),
      messageLength: suggestedShareFocus.length,
    });

    const prompt = `You are helping ${userName} prepare something to share with ${guesserName} to help them understand ${userName}'s perspective better.

The reconciler identified this topic as important for ${guesserName} to understand:
"${suggestedShareFocus}"

Conversation history (${userName}'s messages and AI responses):
---
${conversationTranscript || 'No previous conversation available.'}
---

Generate a brief, personal message (1-3 sentences) that ${userName} could share with ${guesserName} about the topic above. The message should:
1. Be written in first person as if ${userName} is speaking directly to ${guesserName}
2. Draw from what ${userName} actually shared in the conversation above (don't invent new content)
3. Address the specific topic mentioned
4. Feel natural and genuine, not forced

Respond with ONLY the message text, no additional formatting or explanation.`;

    const draftContent = await getModelCompletion(routingDecision.model, {
      systemPrompt: prompt,
      messages: [{ role: 'user', content: 'Generate the share message.' }],
      maxTokens: 512,
      sessionId,
      turnId,
      operation: `share-draft-generation-${routingDecision.model}`,
      callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
    });
    if (!draftContent) {
      errorResponse(res, 'INTERNAL_ERROR', 'Failed to generate draft', 500);
      return;
    }

    const rewriteResult = await suggestSendableRewrite({
      text: draftContent.trim(),
      sessionId,
      turnId,
      requesterName: userName,
      targetName: guesserName,
    });

    // The subject's own offer row (app connection).
    await prisma.contextShareOffer.update({
      where: { id: shareOffer.id },
      data: { suggestedContent: draftContent.trim() },
      select: { id: true },
    });

    if (!me.mainConversationId) {
      errorResponse(res, 'INTERNAL_ERROR', 'Failed to generate share draft', 500);
      return;
    }
    const aiMessage = await aiNote(
      me.mainConversationId,
      `Here's what you could share with ${guesserName}:\n\n"${draftContent.trim()}"`,
    );
    // Content-free (I1/R36): the draft is the subject's private offer text.
    await pingStage2Refresh(sessionId, caller.userId);

    successResponse(res, {
      success: true,
      draft: draftContent.trim(),
      messageId: aiMessage.id,
      guesserName,
      suggestedShareFocus,
      rewriteSuggestions: rewriteResult?.needsRewrite ? rewriteResult.variants : [],
      rewriteNote: rewriteResult?.needsRewrite ? rewriteResult.note : null,
    });
  } catch (error) {
    logger.error('[generateShareDraftHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to generate share draft', 500);
  }
}

// ============================================================================
// Refinement Chat (Stateless, Haiku-powered)
// ============================================================================

/**
 * Refinement chat message — stateless AI coaching for refining shared content.
 * POST /sessions/:id/reconciler/refinement/message
 */
export async function refinementChatMessageHandler(req: Request, res: Response): Promise<void> {
  try {
    const { offerId, messages, proposedContent } = req.body as {
      offerId: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      proposedContent?: string;
    };
    if (!offerId || !messages || !Array.isArray(messages)) {
      errorResponse(res, 'VALIDATION_ERROR', 'offerId and messages are required', 400);
      return;
    }
    const caller = await reconcilerCaller(req, res);
    if (!caller) return;
    const { sessionId, me, parties, userName } = caller;

    const shareOffer = await prisma.contextShareOffer.findFirst({
      where: { id: offerId, subjectParticipantId: me.participantId, attempt: { authorParticipant: { sessionId } } },
      include: { result: true, attempt: { select: { authorParticipantId: true } } },
    });
    if (!shareOffer) {
      errorResponse(res, 'NOT_FOUND', 'Share offer not found', 404);
      return;
    }
    const partnerName =
      partyOf(parties, { participantId: shareOffer.attempt.authorParticipantId })?.name || 'your partner';

    const systemPrompt = `You are Meet Without Fear, a brief coaching companion helping ${userName} refine what to share with ${partnerName}.

CONTEXT:
${userName}'s partner tried to understand their perspective but missed something important.
Gap: ${shareOffer.result.gapSummary}
${shareOffer.result.mostImportantGap ? `Most important gap: ${shareOffer.result.mostImportantGap}` : ''}

AI's initial suggestion for what to share:
"${shareOffer.suggestedContent || ''}"

${proposedContent ? `Current proposed content:\n"${proposedContent}"` : ''}

YOUR APPROACH:
1. UNDERSTAND FIRST: If ${userName}'s message is vague, emotional, or exploratory, ask a focused question to understand what feels off about the current suggestion. Do NOT propose new content yet.
2. DRAFT ONLY WHEN CLEAR: Only include a revised version when ${userName} has clearly expressed what they want to change (e.g., "make it shorter", "add the part about X", "remove the blame").
3. ALWAYS DRAFT WHEN ASKED: If they explicitly ask for a new version or say something like "can you rewrite it", always provide one.

WHEN PROVIDING A REVISED VERSION:
- Put the revised text between <content> and </content> tags, like: <content>I feel stuck because...</content>
- Keep it 1-3 sentences, personal, in their own voice
- Explain briefly what you changed and why

WHEN NOT PROVIDING A REVISED VERSION:
- Ask one focused question
- Keep your response to 1-2 sentences
- Sound like a thoughtful friend, not a therapist`;

    const aiResponse = await getModelCompletion('haiku', {
      systemPrompt,
      messages: messages.length > 0 ? messages : [{ role: 'user', content: 'Help me refine what to share.' }],
      maxTokens: 512,
      sessionId,
      turnId: `${sessionId}-refinement-${Date.now()}`,
      operation: 'refinement-chat',
      callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
    });
    if (!aiResponse) {
      errorResponse(res, 'INTERNAL_ERROR', 'Failed to generate response', 500);
      return;
    }

    const contentMatch =
      aiResponse.match(/<content>([\s\S]*?)<\/content>/i) ||
      aiResponse.match(/<revised[_ ]?text>([\s\S]*?)<\/revised[_ ]?text>/i) ||
      aiResponse.match(/<revised>([\s\S]*?)<\/revised>/i) ||
      aiResponse.match(/<draft>([\s\S]*?)<\/draft>/i);
    const extractedContent = contentMatch ? contentMatch[1].trim() : null;
    const visibleResponse = aiResponse
      .replace(
        /<(?:content|revised[_ ]?text|revised|draft)>[\s\S]*?<\/(?:content|revised[_ ]?text|revised|draft)>/gi,
        '',
      )
      .trim();

    successResponse(res, { response: visibleResponse, proposedContent: extractedContent });
  } catch (error) {
    logger.error('[refinementChatMessageHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to process refinement message', 500);
  }
}

/**
 * Finalize refinement — share the refined content with partner.
 * POST /sessions/:id/reconciler/refinement/finalize
 */
export async function refinementFinalizeHandler(req: Request, res: Response): Promise<void> {
  try {
    const { offerId, content } = req.body as { offerId: string; content: string };
    if (!offerId || !content) {
      errorResponse(res, 'VALIDATION_ERROR', 'offerId and content are required', 400);
      return;
    }
    const caller = await reconcilerCaller(req, res);
    if (!caller) return;
    const { sessionId, me, parties, userId } = caller;

    const shareOffer = await myOpenOffer(sessionId, me, { id: offerId });
    if (!shareOffer) {
      // I2: an earlier finalize accepted this offer but its delivery failed —
      // deliver it now (idempotent) rather than answer 404 with nothing sent.
      const resumed = await resumeUndeliveredShare(sessionId, me, parties, { offerId });
      if (resumed) {
        const guesser = parties.find(p => p.participantId !== me.participantId);
        await notifyContextShared(sessionId, userId, guesser);
        successResponse(res, {
          status: 'shared',
          messageId: resumed.sharedMessageId,
          sharedContent: resumed.sharedContent,
        });
        return;
      }
      errorResponse(res, 'NOT_FOUND', 'Share offer not found or already finalized', 404);
      return;
    }
    const guesser = partyOf(parties, { participantId: shareOffer.attempt.authorParticipantId });
    if (!guesser) {
      errorResponse(res, 'NOT_FOUND', 'Share offer not found or already finalized', 404);
      return;
    }
    const subjectName = me.name || 'You';
    const guesserName = guesser.name || 'your partner';

    const priorShareCount = await prisma.contextShareOffer.count({
      where: {
        subjectParticipantId: me.participantId,
        status: 'ACCEPTED',
        attempt: { authorParticipant: { sessionId } },
      },
    });
    let subjectAckMessage: string;
    if (priorShareCount > 0) {
      subjectAckMessage = `Thanks for sharing that additional context with ${guesserName}.`;
    } else {
      try {
        subjectAckMessage = await generatePostShareContinuation(
          sessionId,
          me,
          subjectName,
          guesserName,
          content,
          guesser,
        );
      } catch (error) {
        logger.error('[refinementFinalizeHandler] generatePostShareContinuation failed:', error);
        const stage = (await loadCurrentStages([me.participantId])).get(me.participantId)?.stage ?? 2;
        subjectAckMessage = getFallbackContinuation(stage, guesserName);
      }
    }
    const reflectionMessage = await generateContextReceivedReflection(sessionId, guesserName, subjectName);

    const { sharedMessageId } = await shareAccepted({
      sessionId,
      offerId: shareOffer.id,
      subject: me,
      author: guesser,
      attempt: shareOffer.attempt,
      sharedContent: content,
      refinement: content,
      subjectAckMessage,
      reflectionMessage,
    });

    await notifyContextShared(sessionId, userId, guesser);
    successResponse(res, { status: 'shared', messageId: sharedMessageId, sharedContent: content });
  } catch (error) {
    logger.error('[refinementFinalizeHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to finalize refinement', 500);
  }
}
