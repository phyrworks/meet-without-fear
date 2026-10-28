/**
 * Reconciler State Module
 *
 * Empathy status transitions, reveal logic, and orchestration of the full
 * reconciler flow including state transitions for a single direction.
 *
 * Target shape (TS-10): every status move is `app.empathy_set_status` on the
 * JOB connection, guarded by the `status_version` the analysis started from
 * (a late result never overwrites a newer decision — spec §7 service rule).
 * The reveal is the job's: one Serializable transaction calls the function for
 * every READY current round; the function owns the reveal gate and writes the
 * subject's delivered EMPATHY_STATEMENT, and the job stamps the delivery.
 */

import { getJobPrisma, prisma } from '../../lib/prisma';
import { reencryptForSession } from '../../lib/share-moments';
import { logger } from '../../lib/logger';
import { pingStage2Refresh } from '../empathy-realtime';
import { transition } from '../empathy-state-machine';
import { createFacilitatorMessage } from '../message-store';
import { aiNote, lastAiNote } from '../empathy-messages';
import {
  directionOf,
  directionStatuses,
  jobMoveIfUnchanged,
  markAttemptDelivery,
  partyOf,
  READY_OR_LATER,
  sessionParties,
  type SessionParty,
  type TargetEmpathyStatus,
} from '../empathy-store';
import type { ReconcilerResult, ReconcilerSummary } from '@meet-without-fear/shared';

import {
  type UserInfo,
  getSonnetJson,
  dbResultToReconcilerResult,
  getEmpathyData,
  getWitnessingContent,
  analyzeEmpathyGap,
  persistAnalysis,
  generateAbstractGuidance,
  currentResultFor,
  guidanceFor,
  toUserInfo,
  RESULT_SELECT,
  type StoredReconcilerResult,
} from './analysis';
import { checkAttempts, hasContextAlreadyBeenShared } from './circuit-breaker';
import { generateShareSuggestion } from './sharing';

// ============================================================================
// Helper: resolve the two parties of a direction
// ============================================================================

export async function directionParties(
  sessionId: string,
  guesserUserId: string,
  subjectUserId: string,
): Promise<{ guesser: UserInfo; subject: UserInfo; guesserParty: SessionParty; subjectParty: SessionParty } | null> {
  // Analysis path: the job reads (Ruling R35).
  const parties = await sessionParties(sessionId, getJobPrisma());
  const g = partyOf(parties, { userId: guesserUserId });
  const s = partyOf(parties, { userId: subjectUserId });
  if (!g || !s) return null;
  return { guesser: toUserInfo(g, 'User'), subject: toUserInfo(s, 'User'), guesserParty: g, subjectParty: s };
}

// ============================================================================
// Helper: Mark empathy as READY
// ============================================================================

/**
 * Move the guesser's current round to READY (job, guarded by the status
 * version the caller read), write the alignment message into the guesser's
 * own conversation in the same job transaction, and check the reveal.
 *
 * @param circuitBreakerTripped - If true, uses a natural transition message instead of accuracy feedback
 */
async function markEmpathyReady(
  sessionId: string,
  guesser: SessionParty,
  subjectName: string,
  attempt: { attemptId: string; statusVersion: number; status: string },
  circuitBreakerTripped = false,
): Promise<boolean> {
  logger.info('Marking empathy as READY', { guesserParticipantId: guesser.participantId });

  const alignmentMessage = circuitBreakerTripped
    ? `You've shared your perspective on what ${subjectName} might be experiencing. ${subjectName} is also reflecting on your perspective — once they're done, you'll both see what each other shared.`
    : `${subjectName} has felt heard. Your attempt to imagine what they're feeling was quite accurate. ${subjectName} is now considering your perspective, and once they're done, you'll both see what each other shared.`;

  // Validates the move against the table before asking the database.
  transition(attempt.status, 'MARK_READY');

  // De-dup guard: the shortcut path can fire several times in a row with the
  // same text; do not re-post it.
  const conversationId = guesser.mainConversationId;
  const alreadyPosted = conversationId
    ? (await lastAiNote(conversationId, getJobPrisma()))?.trim() === alignmentMessage.trim()
    : true;

  let saved: Awaited<ReturnType<typeof createFacilitatorMessage>> | null = null;
  const moved = await jobMoveIfUnchanged(attempt.attemptId, attempt.statusVersion, 'READY', async tx => {
    if (alreadyPosted || !conversationId) return;
    saved = await createFacilitatorMessage({ conversationId, content: alignmentMessage, client: tx });
  });
  if (!moved) {
    logger.info('Attempt moved on since the analysis started; READY not written', { attemptId: attempt.attemptId });
    return false;
  }

  const note = saved as Awaited<ReturnType<typeof createFacilitatorMessage>> | null;
  if (note && guesser.userId) {
    // Content-free (I1/R36): the note is the guesser's private AI message.
    await pingStage2Refresh(sessionId, guesser.userId);
  }

  await checkAndRevealBothIfReady(sessionId);
  return true;
}

// ============================================================================
// Main Function: runReconcilerForDirection
// ============================================================================

/**
 * Run the reconciler for a SINGLE direction when the subject completes Stage 1
 * (or after the guesser resubmits). User ids in, as before (realtime and the
 * e2e hook are user-keyed); participants inside.
 */
export async function runReconcilerForDirection(
  sessionId: string,
  guesserId: string,
  subjectId: string,
): Promise<{
  result: ReconcilerResult | null;
  empathyStatus: 'READY' | 'AWAITING_SHARING';
  shareOffer: { suggestedContent: string; reason: string } | null;
}> {
  logger.info('Running asymmetric reconciliation', { guesserId, subjectId });

  const parties = await directionParties(sessionId, guesserId, subjectId);
  if (!parties) {
    logger.error('Guesser or subject is not a participant of the session', { guesserId, subjectId });
    throw new Error('Guesser or subject not found');
  }
  const { guesser, subject, guesserParty } = parties;

  const empathyData = await getEmpathyData(guesser.participantId, subject.participantId);
  if (!empathyData) {
    logger.error('Guesser has not submitted empathy statement', { guesserId, sessionId });
    throw new Error('Guesser has not submitted empathy statement');
  }

  // CIRCUIT BREAKER: rounds − 1 resubmissions (spec §1.2 RefinementAttemptCounter → rounds).
  const { shouldSkipReconciler, attempts } = await checkAttempts(guesser.participantId, subject.participantId);
  if (shouldSkipReconciler) {
    logger.info('Circuit breaker tripped, forcing READY', { attempts, guesserId, subjectId });
    await markEmpathyReady(sessionId, guesserParty, subject.name, empathyData, true);
    return { result: null, empathyStatus: 'READY', shareOffer: null };
  }

  const witnessingContent = await getWitnessingContent(sessionId, subject.participantId, subject.id);
  if (!witnessingContent.userMessages) {
    logger.error('Subject has no Stage 1 content', { subjectId, sessionId });
    throw new Error('Subject has no Stage 1 content');
  }

  const result = await analyzeEmpathyGap({
    sessionId,
    guesser,
    subject,
    empathyStatement: empathyData.statement,
    witnessingContent,
    attemptId: empathyData.attemptId,
  });

  const action = result.recommendation.action;
  const hasSuggestedFocus = !!result.recommendation.suggestedShareFocus;
  const shouldOfferSharing = action === 'OFFER_SHARING' || (action === 'OFFER_OPTIONAL' && hasSuggestedFocus);
  logger.info('Reconciler outcome', { severity: result.gaps.severity, action, hasSuggestedFocus, shouldOfferSharing });

  const contextAlreadyShared =
    shouldOfferSharing && (await hasContextAlreadyBeenShared(guesser.participantId, subject.participantId));

  if (!shouldOfferSharing || contextAlreadyShared) {
    if (result.fresh) {
      const stored = await persistAnalysis({
        attemptId: empathyData.attemptId,
        authorParticipantId: guesser.participantId,
        subjectParticipantId: subject.participantId,
        result,
        guidance: result.abstractGuidance ?? generateAbstractGuidance(result),
      });
      if (!stored) return { result, empathyStatus: 'READY', shareOffer: null };
    }
    // Context already shared but gaps remain after resubmission: READY, with
    // the neutral circuit-breaker text instead of the false "quite accurate".
    await markEmpathyReady(sessionId, guesserParty, subject.name, empathyData, contextAlreadyShared);
    return { result, empathyStatus: 'READY', shareOffer: null };
  }

  // Significant gaps: the share suggestion for the subject, persisted with the
  // analysis (job), then the guesser's round → AWAITING_SHARING (guarded).
  const shareOffer = await generateShareSuggestion(sessionId, guesser, subject, result, witnessingContent, {
    attemptId: empathyData.attemptId,
    storedResultId: result.storedResultId,
    fresh: !!result.fresh,
  });

  const moved = await jobMoveIfUnchanged(empathyData.attemptId, empathyData.statusVersion, 'AWAITING_SHARING');
  if (!moved) {
    logger.info('Attempt moved on since the analysis started; AWAITING_SHARING not written', {
      attemptId: empathyData.attemptId,
    });
  }

  // Notify the guesser that the subject is considering a share suggestion (US-5).
  if (guesser.id) {
    const { notifyPartner } = await import('../realtime');
    // Content-free (I1/R36): no status DTO on the shared session channel.
    await notifyPartner(sessionId, guesser.id, 'empathy.status_updated', {
      sessionId,
      timestamp: Date.now(),
      status: 'AWAITING_SHARING',
      forUserId: guesser.id,
      subjectName: subject.name,
      message: `${subject.name} is considering a suggestion to share more`,
    }).catch(err => {
      logger.warn('Failed to notify guesser of AWAITING_SHARING status', { error: (err as Error).message });
    });
  }

  return { result, empathyStatus: 'AWAITING_SHARING', shareOffer };
}

// ============================================================================
// Check Partner Stage 1 Completion
// ============================================================================

/** Has this user (a participant of the session) reached `feel_heard`? */
export async function hasPartnerCompletedStage1(sessionId: string, partnerId: string): Promise<boolean> {
  const n = await prisma.participantMilestone.count({
    where: { milestoneKey: 'feel_heard', participant: { sessionId, userId: partnerId } },
  });
  return n > 0;
}

// ============================================================================
// Mutual Reveal: every direction must be ready before revealing any
// ============================================================================

interface CurrentRound {
  id: string;
  author_participant_id: string;
  subject_participant_id: string;
  status: TargetEmpathyStatus;
}

/**
 * Reveal every READY current round once every direction of the session is
 * READY or VALIDATED (the refinement path: one direction already validated,
 * the other resubmitted). JOB connection, one Serializable transaction: the
 * read, the `app.empathy_set_status(…, 'REVEALED')` calls (the function
 * re-checks the gate and writes each subject's delivered copy) and the
 * delivery stamps.
 *
 * @returns true if anything was revealed
 */
export async function checkAndRevealBothIfReady(sessionId: string): Promise<boolean> {
  logger.debug('checkAndRevealBothIfReady called', { sessionId });
  const parties = await sessionParties(sessionId, getJobPrisma());
  if (parties.length !== 2) return false;
  const pids = parties.map(p => p.participantId);

  const revealed = await getJobPrisma().$transaction(
    async tx => {
      const rounds = await tx.$queryRaw<
        CurrentRound[]
      >`SELECT DISTINCT ON (a.author_participant_id, a.subject_participant_id)
               a.id, a.author_participant_id, a.subject_participant_id, a.status::text AS status
        FROM empathy_attempt a
        WHERE a.author_participant_id = ANY(${pids}::uuid[])
        ORDER BY a.author_participant_id, a.subject_participant_id,
                 (a.status NOT IN ('SUPERSEDED', 'VALIDATED')) DESC, a.round DESC`;
      if (rounds.length !== 2) {
        logger.debug('Not enough empathy attempts for mutual reveal', { sessionId, count: rounds.length });
        return null;
      }
      const ready = rounds.every(r => r.status === 'READY' || r.status === 'VALIDATED');
      const toReveal = rounds.filter(r => r.status === 'READY');
      if (!ready || toReveal.length === 0) return null;

      const at = new Date();
      for (const r of toReveal) {
        transition(r.status, 'MUTUAL_REVEAL');
        await tx.$queryRaw`SELECT app.empathy_set_status(${r.id}::uuid, 'REVEALED'::empathy_status, NULL::text)`;
        await markAttemptDelivery(r.id, 'DELIVERED', at, tx);
      }
      // Share moment (writer-principal rule; spec §1.2 empathy_attempt: "re-encrypted
      // under the session key by the reveal job"; ruling R26): the revealed rounds'
      // content, and the EMPATHY_STATEMENT copies app.empathy_set_status wrote with
      // that ciphertext verbatim, become the subject's to read. Under the single key
      // there is nothing to re-encrypt; W13 re-encrypts here, in this job
      // transaction, with the same plaintext (T-message-immutable exempts mwf_job).
      await reencryptForSession(
        { moment: 'empathy-reveal', sessionId, rows: toReveal.map(r => ({ table: 'empathy_attempt', id: r.id })) },
        tx,
      );
      return toReveal;
    },
    { isolationLevel: 'Serializable' },
  );

  if (!revealed) return false;

  const byPid = new Map(parties.map(p => [p.participantId, p]));
  const { notifyPartner } = await import('../realtime');

  // Content-free (I1/R36): both devices are on the session channel; mobile
  // refetches the addressed user's status on this event.
  for (const r of revealed) {
    const author = byPid.get(r.author_participant_id);
    if (!author?.userId) continue;
    await notifyPartner(sessionId, author.userId, 'empathy.revealed', {
      direction: 'outgoing',
      guesserUserId: author.userId,
      forUserId: author.userId,
    });
  }

  // Quality commentary so each subject knows what to expect (issue #497):
  // into the SUBJECT's conversation, from the subject's own result.
  try {
    for (const r of revealed) {
      const author = byPid.get(r.author_participant_id);
      const subject = byPid.get(r.subject_participant_id);
      if (!author || !subject?.mainConversationId) continue;
      const result = await currentResultFor(r.id);
      const hasGaps = result && (result.gapSeverity === 'MODERATE' || result.gapSeverity === 'SIGNIFICANT');
      const guesserName = author.name || 'Your partner';
      const qualityMessage = hasGaps
        ? `${guesserName}'s attempt to understand your experience is ready for you to review. It may not fully capture everything you shared — if something feels off or missing, you can share feedback to help them understand better.`
        : `${guesserName}'s attempt to understand your experience is ready for you to review. Take a moment to read it and let us know how it feels.`;
      await aiNote(subject.mainConversationId, qualityMessage);
      if (subject.userId) {
        // Content-free (I1/R36): the text follows the subject-only result's
        // gap severity, so it must not reach the author's device.
        await pingStage2Refresh(sessionId, subject.userId);
      }
    }
  } catch (err) {
    logger.warn('Failed to create reveal quality messages', { error: (err as Error).message });
  }

  logger.info('Empathy attempts revealed and notifications sent', { sessionId });
  return true;
}

// ============================================================================
// Reconciler Status
// ============================================================================

/**
 * The reconciler status AS SEEN BY one participant (spec §1.2: a result is
 * its subject's only). A direction's analysis is returned only where the
 * caller is its subject; `pendingShareOffers` counts the caller's own open
 * offers (as subject); `hasRun` is whether an analysis the caller may see
 * exists (their own as subject, or guidance); `readyForStage3` adds the
 * content-free direction statuses (`v_empathy_direction_status`).
 *
 * A/B are the session's participants in join order (A→B = A's attempt about B).
 */
export async function getReconcilerStatus(
  sessionId: string,
  callerParticipantId: string,
): Promise<{
  hasRun: boolean;
  aUnderstandingB: ReconcilerResult | null;
  bUnderstandingA: ReconcilerResult | null;
  pendingShareOffers: number;
  readyForStage3: boolean;
}> {
  const parties = await sessionParties(sessionId);
  const statuses = await directionStatuses(sessionId);
  if (parties.length !== 2) {
    return {
      hasRun: false,
      aUnderstandingB: null,
      bUnderstandingA: null,
      pendingShareOffers: 0,
      readyForStage3: false,
    };
  }
  const [a, b] = parties;

  const visibleResult = async (author: SessionParty, subject: SessionParty): Promise<ReconcilerResult | null> => {
    if (subject.participantId !== callerParticipantId) return null;
    const stored = (await prisma.reconcilerResult.findFirst({
      where: {
        subjectParticipantId: subject.participantId,
        supersededAt: null,
        attempt: { authorParticipantId: author.participantId },
      },
      orderBy: { createdAt: 'desc' },
      select: RESULT_SELECT,
    })) as StoredReconcilerResult | null;
    return stored ? dbResultToReconcilerResult(stored, await guidanceFor(stored.id)) : null;
  };

  const [aUnderstandingB, bUnderstandingA, pendingShareOffers, ownResults, ownGuidance] = await Promise.all([
    visibleResult(a, b),
    visibleResult(b, a),
    prisma.contextShareOffer.count({
      where: {
        subjectParticipantId: callerParticipantId,
        status: 'OFFERED',
        attempt: { authorParticipant: { sessionId } },
      },
    }),
    // What the caller may see of the analyses: their own as subject, and the
    // guidance (author + subject) — never the existence of a result on an
    // attempt they authored (spec §1.2 reconciler_result RLS: subject only).
    prisma.reconcilerResult.count({ where: { subjectParticipantId: callerParticipantId, supersededAt: null } }),
    prisma.reconcilerGuidance.count({
      where: {
        OR: [{ authorParticipantId: callerParticipantId }, { subjectParticipantId: callerParticipantId }],
        result: { supersededAt: null },
      },
    }),
  ]);

  const ab = directionOf(statuses, a.participantId, b.participantId);
  const ba = directionOf(statuses, b.participantId, a.participantId);
  const hasRun = ownResults > 0 || ownGuidance > 0;
  // Complete once an analysis the caller can see exists, both directions are
  // READY or later, and the caller has no open offer.
  const readyForStage3 =
    hasRun &&
    !!ab &&
    !!ba &&
    READY_OR_LATER.has(ab.status) &&
    READY_OR_LATER.has(ba.status) &&
    pendingShareOffers === 0;

  return { hasRun, aUnderstandingB, bUnderstandingA, pendingShareOffers, readyForStage3 };
}

// ============================================================================
// Reconciler Summary (Ruling R24)
// ============================================================================

const SEVERITY = (s: string) => s.toLowerCase() as 'none' | 'minor' | 'moderate' | 'significant';

/**
 * The summary built FOR participant X (ruling R24): from X's own
 * `reconciler_result` rows (X as subject — how the partner understood X),
 * X's own attempt, and the direction statuses. Never the co-participant's
 * result (how X understood them — subject-private to the partner) nor the
 * co-participant's unrevealed attempt.
 */
export async function generateReconcilerSummary(
  sessionId: string,
  callerParticipantId: string,
): Promise<ReconcilerSummary | null> {
  const parties = await sessionParties(sessionId);
  const me = parties.find(p => p.participantId === callerParticipantId);
  const partner = parties.find(p => p.participantId !== callerParticipantId);
  if (!me || !partner) return null;

  const [aboutMe, statuses, sharedAboutMe, sharedByMe] = await Promise.all([
    prisma.reconcilerResult.findFirst({
      where: {
        subjectParticipantId: me.participantId,
        supersededAt: null,
        attempt: { authorParticipantId: partner.participantId },
      },
      orderBy: { createdAt: 'desc' },
      select: { alignmentScore: true, alignmentSummary: true, gapSeverity: true },
    }),
    directionStatuses(sessionId),
    // Sharing that reached me (delivered to my conversation) / that I did (my offers).
    prisma.message.count({ where: { conversation: { participantId: me.participantId }, kind: 'SHARED_CONTEXT' } }),
    prisma.contextShareOffer.count({ where: { subjectParticipantId: me.participantId, status: 'ACCEPTED' } }),
  ]);
  if (!aboutMe) return null;
  const mine = directionOf(statuses, me.participantId, partner.participantId);
  const meName = me.name || 'You';
  const partnerName = partner.name || 'your partner';

  const prompt = `You are Meet Without Fear, summarizing the empathy exchange for ${meName}, speaking to ${meName} privately.

EMPATHY EXCHANGE (what ${meName} may know):

${partnerName}'s understanding of ${meName}:
- Alignment: ${aboutMe.alignmentScore}%
- ${aboutMe.alignmentSummary}
- Gap severity: ${SEVERITY(aboutMe.gapSeverity)}

${meName}'s own understanding of ${partnerName}:
- Status: ${mine?.status ?? 'not submitted'} (round ${mine?.round ?? 0})
- The analysis of it is ${partnerName}'s to read; do not guess at it.

Additional sharing occurred: ${sharedAboutMe + sharedByMe > 0 ? 'Yes' : 'No'}

YOUR TASK:
Generate a brief, warm summary (3-4 sentences) that:
1. Acknowledges the empathy work both have done
2. Highlights what went well (without specific scores)
3. If gaps existed, note that understanding deepened through sharing
4. Transitions toward the next stage (What Matters)

Keep it encouraging without being effusive. Focus on progress, not perfection.

Respond in JSON:
\`\`\`json
{
  "summary": "The summary text",
  "readyForNextStage": true
}
\`\`\``;

  return getSonnetJson<ReconcilerSummary>({
    systemPrompt: prompt,
    messages: [{ role: 'user', content: 'Generate the reconciler summary.' }],
    maxTokens: 512,
    sessionId,
    operation: 'reconciler-summary',
  });
}

export type { UserInfo };
