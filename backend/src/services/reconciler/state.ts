/**
 * Reconciler State Module
 *
 * Empathy status transitions, reveal logic, and orchestration of the full
 * reconciler flow including state transitions for a single direction.
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { EmpathyStatus, MessageRole } from '@meet-without-fear/shared';
import type { Prisma } from '../../generated/prisma/client';
import { publishMessageAIResponse } from '../realtime';
import { transition } from '../empathy-state-machine';
import {
  buildReconcilerSummaryPrompt,
  type ReconcilerSummaryContext,
} from '../stage-prompts';
import type {
  ReconcilerResult,
  ReconcilerSummary,
} from '@meet-without-fear/shared';

type EmpathyAttemptState = {
  sourceUserId: string | null;
  status: string;
};

type ReconcilerResultWithOffer = {
  recommendedAction: string;
  shareOffer?: { status: string } | null;
};

import {
  type UserInfo,
  getSonnetJson,
  dbResultToReconcilerResult,
  getEmpathyData,
  getWitnessingContent,
  analyzeEmpathyGap,
} from './analysis';
import { checkAttempts, hasContextAlreadyBeenShared, markResultHandledAlreadyShared } from './circuit-breaker';
import { generateShareSuggestion } from './sharing';

// ============================================================================
// Helper: Mark empathy as READY
// ============================================================================

/**
 * Mark guesser's empathy attempt as READY, create alignment message, and check reveal.
 * This helper extracts the common logic when no sharing is needed.
 *
 * @param circuitBreakerTripped - If true, uses a natural transition message instead of accuracy feedback
 */
async function markEmpathyReady(
  sessionId: string,
  guesserId: string,
  subjectName: string,
  circuitBreakerTripped = false
): Promise<void> {
  logger.info('Marking empathy as READY', { guesserId });

  // Choose message based on whether circuit breaker tripped
  const alignmentMessage = circuitBreakerTripped
    ? `You've shared your perspective on what ${subjectName} might be experiencing. ${subjectName} is also reflecting on your perspective — once they're done, you'll both see what each other shared.`
    : `${subjectName} has felt heard. Your attempt to imagine what they're feeling was quite accurate. ${subjectName} is now considering your perspective, and once they're done, you'll both see what each other shared.`;

  // De-dup guard: reconciliation iterates every time either side refines, so
  // the shortcut path can fire several times in a row with the same message
  // content. If the last AI message to this guesser already says the same
  // thing, just update the empathy status without re-posting the chat line.
  const lastAiMessageForGuesser = await prisma.message.findFirst({
    where: { sessionId, forUserId: guesserId, role: 'AI' },
    orderBy: { timestamp: 'desc' },
    select: { content: true },
  });
  const alreadyPosted = lastAiMessageForGuesser?.content?.trim() === alignmentMessage.trim();

  // Wrap state transition + status update + message creation in a transaction
  // to ensure atomicity — a partial write here could leave the attempt READY
  // without a corresponding alignment message, or vice versa.
  const savedMessage = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Validate state transition before updating
    const attempt = await tx.empathyAttempt.findFirst({
      where: { sessionId, sourceUserId: guesserId },
    });
    if (attempt) {
      transition(attempt.status as EmpathyStatus, 'MARK_READY');
    }

    // Update empathy attempt status to READY
    await tx.empathyAttempt.updateMany({
      where: { sessionId, sourceUserId: guesserId },
      data: { status: 'READY', statusVersion: { increment: 1 } },
    });

    if (alreadyPosted) {
      return null;
    }

    // Create alignment message
    const msg = await tx.message.create({
      data: {
        sessionId,
        senderId: null, // AI message
        forUserId: guesserId,
        role: 'AI',
        content: alignmentMessage,
        stage: 2,
      },
    });

    return msg;
  });

  if (!savedMessage) {
    logger.info('Skipping duplicate alignment message', { guesserId });
    // Still need to check mutual reveal after the status update above.
    await checkAndRevealBothIfReady(sessionId);
    return;
  }

  logger.debug('Created alignment message', { guesserId, alignmentMessage });

  // Side effects (Ably publish, reveal check) stay outside the transaction
  // so they don't hold the DB connection open during network I/O.
  await publishMessageAIResponse(
    sessionId,
    guesserId,
    {
      id: savedMessage.id,
      sessionId,
      senderId: null,
      content: savedMessage.content,
      timestamp: savedMessage.timestamp.toISOString(),
      role: MessageRole.AI,
      stage: savedMessage.stage,
    },
    {} // No metadata needed
  );

  // Check if both directions are now READY and reveal both if so
  await checkAndRevealBothIfReady(sessionId);
}

// ============================================================================
// Main Function: runReconcilerForDirection
// ============================================================================

/**
 * Run the reconciler for a SINGLE direction when subject completes Stage 1.
 * This is the new asymmetric flow - reconciler runs as soon as:
 * 1. Guesser has submitted empathy (status = HELD)
 * 2. Subject completes Stage 1 (confirms feelHeard)
 *
 * @param sessionId - The session ID
 * @param guesserId - The user who submitted the empathy statement (guesser)
 * @param subjectId - The user whose Stage 1 content will be compared (subject)
 * @returns The reconciler result for this direction
 */
export async function runReconcilerForDirection(
  sessionId: string,
  guesserId: string,
  subjectId: string
): Promise<{
  result: ReconcilerResult | null;
  empathyStatus: 'READY' | 'AWAITING_SHARING';
  shareOffer: {
    suggestedContent: string;
    reason: string;
  } | null;
}> {
  logger.info('Running asymmetric reconciliation', { guesserId, subjectId });

  // Get user names
  const [guesser, subject] = await Promise.all([
    prisma.user.findUnique({
      where: { id: guesserId },
      select: { id: true, name: true, firstName: true },
    }),
    prisma.user.findUnique({
      where: { id: subjectId },
      select: { id: true, name: true, firstName: true },
    }),
  ]);

  if (!guesser || !subject) {
    logger.error('Guesser or subject not found in DB', { guesserId, subjectId });
    throw new Error('Guesser or subject not found');
  }

  const guesserInfo: UserInfo = {
    id: guesser.id,
    name: guesser.firstName || guesser.name || 'User',
  };
  const subjectInfo: UserInfo = {
    id: subject.id,
    name: subject.firstName || subject.name || 'User',
  };

  logger.debug('Reconciler participants', { guesserId: guesserInfo.id, subjectId: subjectInfo.id });

  // ============================================================================
  // CIRCUIT BREAKER CHECK
  // ============================================================================
  const { shouldSkipReconciler, attempts } = await checkAttempts(
    sessionId,
    guesserId,
    subjectId
  );

  if (shouldSkipReconciler) {
    logger.info('Circuit breaker tripped, forcing READY', { attempts, guesserId: guesserInfo.id, subjectId: subjectInfo.id });
    await markEmpathyReady(sessionId, guesserId, subjectInfo.name, true);
    return {
      result: null,
      empathyStatus: 'READY',
      shareOffer: null,
    };
  }

  // Get guesser's empathy statement
  const empathyData = await getEmpathyData(sessionId, guesserId);
  if (!empathyData) {
    logger.error('Guesser has not submitted empathy statement', { guesserId: guesserInfo.id, sessionId });
    throw new Error('Guesser has not submitted empathy statement');
  }
  logger.debug('Found guesser empathy statement', { length: empathyData.statement.length });

  // Get subject's witnessing content (Stage 1)
  const witnessingContent = await getWitnessingContent(sessionId, subjectId);
  if (!witnessingContent.userMessages) {
    logger.error('Subject has no Stage 1 content', { subjectId: subjectInfo.id, sessionId });
    throw new Error('Subject has no Stage 1 content');
  }
  logger.debug('Found subject witnessing content', { themes: witnessingContent.themes.length, chars: witnessingContent.userMessages.length });

  // Run the analysis
  const result = await analyzeEmpathyGap({
    sessionId,
    guesser: guesserInfo,
    subject: subjectInfo,
    empathyStatement: empathyData.statement,
    witnessingContent,
  });

  // Determine outcome based on gaps
  // OFFER_SHARING: Significant gaps - strongly recommend sharing
  // OFFER_OPTIONAL: Moderate gaps - optionally offer sharing (only if suggestedShareFocus exists)
  // PROCEED: No/minor gaps - proceed without sharing
  const action = result.recommendation.action;
  const hasSuggestedFocus = !!result.recommendation.suggestedShareFocus;

  // Treat OFFER_OPTIONAL with null suggestedShareFocus as PROCEED (US-8)
  const shouldOfferSharing =
    action === 'OFFER_SHARING' ||
    (action === 'OFFER_OPTIONAL' && hasSuggestedFocus);

  logger.info('Reconciler outcome', { severity: result.gaps.severity, action, hasSuggestedFocus, shouldOfferSharing });

  if (!shouldOfferSharing) {
    // No sharing needed - mark as READY (will reveal when both directions are ready)
    logger.info('No sharing needed, marking READY', { action, hasSuggestedFocus, guesserId: guesserInfo.id, subjectId: subjectInfo.id });
    await markEmpathyReady(sessionId, guesserId, subjectInfo.name);

    return {
      result,
      empathyStatus: 'READY',
      shareOffer: null,
    };
  }

  // Check if context has already been shared for this direction
  const contextAlreadyShared = await hasContextAlreadyBeenShared(sessionId, guesserId, subjectId);
  if (contextAlreadyShared) {
    logger.info('Context already shared, skipping AWAITING_SHARING and marking READY', { subjectId, guesserId });
    // Context was already shared but gaps remain after resubmission.
    // Mark READY to prevent infinite loop, using the circuit breaker message
    // (neutral waiting language) instead of the false "quite accurate" claim.
    await markEmpathyReady(sessionId, guesserId, subjectInfo.name, true);

    // Mark the reconciler result "handled" so the GET /share-offer fallback
    // (and any other downstream reader) won't synthesize a redundant suggestion.
    await markResultHandledAlreadyShared(sessionId, guesserId, subjectId);

    return {
      result,
      empathyStatus: 'READY',
      shareOffer: null,
    };
  }

  // Significant gaps - generate share suggestion for subject
  logger.info('Significant gaps found, generating share suggestion', { subjectId: subjectInfo.id });

  // Query the DB record once (it was just created in analyzeEmpathyGap)
  const dbReconcilerResult = await prisma.reconcilerResult.findFirst({
    where: {
      sessionId,
      guesserId,
      subjectId,
      supersededAt: null,
    },
  });

  const shareOffer = await generateShareSuggestion(
    sessionId,
    guesserInfo,
    subjectInfo,
    result,
    witnessingContent,
    dbReconcilerResult || undefined
  );

  // Validate and update empathy attempt status to AWAITING_SHARING atomically.
  // The read (for state-machine validation) and write must be in one transaction
  // to prevent a concurrent caller from seeing stale status.
  logger.info('Updating empathy status to AWAITING_SHARING', { guesserId: guesserInfo.id });
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const attemptForAwait = await tx.empathyAttempt.findFirst({
      where: { sessionId, sourceUserId: guesserId },
    });
    if (attemptForAwait) {
      transition(attemptForAwait.status as EmpathyStatus, 'GAPS_DETECTED');
    }
    await tx.empathyAttempt.updateMany({
      where: { sessionId, sourceUserId: guesserId },
      data: { status: 'AWAITING_SHARING', statusVersion: { increment: 1 } },
    });
  });

  // Notify the guesser that the subject is considering a share suggestion (US-5)
  // Include full empathy status to avoid extra HTTP round-trip
  const { notifyPartner } = await import('../realtime');
  const { buildEmpathyExchangeStatus } = await import('../empathy-status');
  const guesserEmpathyStatus = await buildEmpathyExchangeStatus(sessionId, guesserId);
  await notifyPartner(sessionId, guesserId, 'empathy.status_updated', {
    sessionId,
    timestamp: Date.now(),
    status: 'AWAITING_SHARING',
    forUserId: guesserId,
    empathyStatus: guesserEmpathyStatus,
    subjectName: subjectInfo.name,
    message: `${subjectInfo.name} is considering a suggestion to share more`,
  }).catch((err) => {
    logger.warn('Failed to notify guesser of AWAITING_SHARING status', { error: (err as Error).message });
  });

  return {
    result,
    empathyStatus: 'AWAITING_SHARING',
    shareOffer,
  };
}

// ============================================================================
// Check Partner Stage 1 Completion
// ============================================================================

/**
 * Check if partner has completed Stage 1 (used to determine if reconciler should run).
 */
export async function hasPartnerCompletedStage1(
  sessionId: string,
  partnerId: string
): Promise<boolean> {
  const progress = await prisma.stageProgress.findUnique({
    where: {
      sessionId_userId_stage: {
        sessionId,
        userId: partnerId,
        stage: 1,
      },
    },
  });

  if (!progress) return false;

  const gates = progress.gatesSatisfied as Record<string, unknown> | null;
  return gates?.feelHeard === true || gates?.feelHeardConfirmed === true;
}

// ============================================================================
// Mutual Reveal: Both directions must be READY before revealing either
// ============================================================================

/**
 * Check if both empathy attempts are ready for review and reveal any unrevealed
 * READY attempt. This also handles the refinement path where one direction was
 * already VALIDATED and the other partner resubmits a READY revision.
 *
 * @returns true if both were revealed, false otherwise
 */
export async function checkAndRevealBothIfReady(sessionId: string): Promise<boolean> {
  logger.debug('checkAndRevealBothIfReady called', { sessionId });

  // Use a Serializable transaction to prevent the TOCTOU race where two
  // concurrent callers both read "both READY" and both try to reveal.
  // Serializable isolation ensures the read-check-write is atomic.
  const revealResult = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Get both empathy attempts for this session
    const attempts = await tx.empathyAttempt.findMany({
      where: { sessionId },
    });

    if (attempts.length !== 2) {
      logger.debug('Not enough empathy attempts for mutual reveal', { sessionId, count: attempts.length });
      return null;
    }

    const readyStatuses = new Set(['READY', 'VALIDATED']);
    const readyForReview = attempts.every((a: EmpathyAttemptState) => readyStatuses.has(a.status));
    const hasUnrevealedReadyAttempt = attempts.some((a: EmpathyAttemptState) => a.status === 'READY');
    if (!readyForReview || !hasUnrevealedReadyAttempt) {
      const statuses = Object.fromEntries(attempts.map((a: EmpathyAttemptState) => [a.sourceUserId, a.status]));
      logger.debug('Not ready to reveal empathy attempts yet', { statuses });
      return null;
    }

    logger.info('Empathy attempts ready for review, revealing READY attempts', { sessionId });

    // Validate state transition for unrevealed attempts.
    for (const attempt of attempts.filter((a: EmpathyAttemptState) => a.status === 'READY')) {
      transition(attempt.status as EmpathyStatus, 'MUTUAL_REVEAL');
    }

    const attemptsToReveal = attempts.filter((a: EmpathyAttemptState) => a.status === 'READY');

    // Reveal any READY attempt. VALIDATED attempts were already revealed and
    // seen; leave their terminal state intact.
    const revealedNow = new Date();
    await tx.empathyAttempt.updateMany({
      where: {
        sessionId,
        status: 'READY',
      },
      data: {
        status: 'REVEALED',
        statusVersion: { increment: 1 },
        revealedAt: revealedNow,
        deliveryStatus: 'DELIVERED',
        deliveredAt: revealedNow,
      },
    });

    return { allAttempts: attempts, revealedAttempts: attemptsToReveal };
  }, {
    isolationLevel: 'Serializable',
  });

  if (!revealResult) {
    return false;
  }

  const { allAttempts, revealedAttempts } = revealResult;

  // Notifications stay outside the transaction to avoid holding the DB
  // connection open during network I/O.
  const { notifyPartner } = await import('../realtime');
  const { buildEmpathyExchangeStatusForBothUsers } = await import('../empathy-status');
  const allStatuses = await buildEmpathyExchangeStatusForBothUsers(sessionId);

  for (const attempt of revealedAttempts) {
    const userId = attempt.sourceUserId!;
    // Notify the guesser that their empathy was revealed to their partner
    // Include guesserUserId so mobile can filter - only the SUBJECT (non-guesser) should see validation_needed modal
    await notifyPartner(sessionId, userId, 'empathy.revealed', {
      direction: 'outgoing',
      guesserUserId: userId,
      forUserId: userId,
      empathyStatus: allStatuses[userId],
    });
  }

  // Create quality commentary messages so each subject knows what to expect
  // when reviewing their partner's empathy attempt (issue #497)
  try {
    const justRevealed = revealedAttempts;
    if (justRevealed.length > 0) {
      const allUserIds = allAttempts.map((a: EmpathyAttemptState) => a.sourceUserId!);

      // Get reconciler results and user names
      const [reconcilerResults, users] = await Promise.all([
        prisma.reconcilerResult.findMany({
          where: { sessionId, supersededAt: null },
        }),
        prisma.user.findMany({
          where: { id: { in: allUserIds } },
          select: { id: true, firstName: true, name: true },
        }),
      ]);

      const nameOf = (id: string) => {
        const match = users.find((u: { id: string }) => u.id === id);
        return match?.firstName || match?.name || 'Your partner';
      };

      for (const attempt of justRevealed) {
        const guesserId = attempt.sourceUserId!;
        const subjectId = allUserIds.find((uid: string) => uid !== guesserId);
        if (!subjectId) continue;

        // Find the reconciler result for this direction (guesser → subject)
        const result = reconcilerResults.find(
          (r: { guesserId: string; subjectId: string }) => r.guesserId === guesserId && r.subjectId === subjectId
        );

        const guesserName = nameOf(guesserId);
        const hasGaps = result && (result.gapSeverity === 'moderate' || result.gapSeverity === 'significant');

        const qualityMessage = hasGaps
          ? `${guesserName}'s attempt to understand your experience is ready for you to review. It may not fully capture everything you shared — if something feels off or missing, you can share feedback to help them understand better.`
          : `${guesserName}'s attempt to understand your experience is ready for you to review. Take a moment to read it and let us know how it feels.`;

        const savedMsg = await prisma.message.create({
          data: {
            sessionId,
            senderId: null,
            forUserId: subjectId,
            role: 'AI',
            content: qualityMessage,
            stage: 2,
          },
        });

        await publishMessageAIResponse(
          sessionId,
          subjectId,
          {
            id: savedMsg.id,
            sessionId,
            senderId: null,
            content: savedMsg.content,
            timestamp: savedMsg.timestamp.toISOString(),
            role: MessageRole.AI,
            stage: savedMsg.stage,
          },
          {}
        );

        logger.debug('Created reveal quality message', { subjectId, gapSeverity: result?.gapSeverity ?? 'unknown' });
      }
    }
  } catch (err) {
    // Not critical — don't block the reveal flow
    logger.warn('Failed to create reveal quality messages', { error: (err as Error).message });
  }

  logger.info('Both empathy attempts revealed and notifications sent', { sessionId });
  return true;
}

// ============================================================================
// Reconciler Status
// ============================================================================

/**
 * Get the reconciler status for a session.
 */
export async function getReconcilerStatus(sessionId: string): Promise<{
  hasRun: boolean;
  aUnderstandingB: ReconcilerResult | null;
  bUnderstandingA: ReconcilerResult | null;
  pendingShareOffers: number;
  readyForStage3: boolean;
}> {
  const results = await prisma.reconcilerResult.findMany({
    where: { sessionId, supersededAt: null },
    include: { shareOffer: true },
    orderBy: { guesserId: 'asc' },
  });

  if (results.length === 0) {
    return {
      hasRun: false,
      aUnderstandingB: null,
      bUnderstandingA: null,
      pendingShareOffers: 0,
      readyForStage3: false,
    };
  }

  // Count pending share offers (status = OFFERED)
  const pendingShareOffers = results.filter(
    (r: ReconcilerResultWithOffer) => r.shareOffer?.status === 'OFFERED'
  ).length;

  // Ready for Stage 3 if:
  // 1. Both directions have been analyzed
  // 2. No pending share offers
  // 3. All recommendations are PROCEED, or sharing was completed/declined
  const readyForStage3 =
    results.length === 2 &&
    pendingShareOffers === 0 &&
    results.every(
      (r: ReconcilerResultWithOffer) =>
        r.recommendedAction === 'PROCEED' ||
        !r.shareOffer ||
        r.shareOffer.status === 'ACCEPTED' ||
        r.shareOffer.status === 'DECLINED' ||
        r.shareOffer.status === 'SKIPPED'
    );

  return {
    hasRun: true,
    aUnderstandingB: results[0] ? dbResultToReconcilerResult(results[0]) : null,
    bUnderstandingA: results[1] ? dbResultToReconcilerResult(results[1]) : null,
    pendingShareOffers,
    readyForStage3,
  };
}

// ============================================================================
// Reconciler Summary
// ============================================================================

/**
 * Generate a summary after reconciliation is complete.
 */
export async function generateReconcilerSummary(
  sessionId: string
): Promise<ReconcilerSummary | null> {
  const results = await prisma.reconcilerResult.findMany({
    where: { sessionId, supersededAt: null },
    include: { shareOffer: true },
    orderBy: { guesserId: 'asc' },
  });

  if (results.length !== 2) {
    return null;
  }

  const [resultA, resultB] = results;

  const context: ReconcilerSummaryContext = {
    userAName: resultA.guesserName,
    userBName: resultB.guesserName,
    aUnderstandingB: {
      alignmentScore: resultA.alignmentScore,
      alignmentSummary: resultA.alignmentSummary,
      gapSeverity: resultA.gapSeverity as 'none' | 'minor' | 'moderate' | 'significant',
    },
    bUnderstandingA: {
      alignmentScore: resultB.alignmentScore,
      alignmentSummary: resultB.alignmentSummary,
      gapSeverity: resultB.gapSeverity as 'none' | 'minor' | 'moderate' | 'significant',
    },
    additionalSharingOccurred:
      resultA.shareOffer?.status === 'ACCEPTED' ||
      resultB.shareOffer?.status === 'ACCEPTED',
  };

  const summary = await getSonnetJson<ReconcilerSummary>({
    systemPrompt: buildReconcilerSummaryPrompt(context),
    messages: [{ role: 'user', content: 'Generate the reconciler summary.' }],
    maxTokens: 512,
    sessionId,
    operation: 'reconciler-summary',
  });

  return summary;
}
