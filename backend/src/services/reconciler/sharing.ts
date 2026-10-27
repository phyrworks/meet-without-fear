/**
 * Reconciler Sharing Module
 *
 * Share suggestion generation, refinement, and response handling.
 * Manages the flow of sharing context between users when empathy gaps are detected.
 *
 * Target shape (TS-10, spec §1.2 context_share_offer, §1.3 consent):
 *   - the offer is the SUBJECT's: the job inserts it; only the subject reads it;
 *   - the subject responds on the app connection: the offer's response columns
 *     plus a `consent` row naming the offer (no requester — CHECK; a DENIED
 *     decision can never be read by the author, spec §7 "declining leaves no
 *     author-visible trace");
 *   - the shared text is delivered by the job as a `message(kind
 *     SHARED_CONTEXT)` in the AUTHOR's conversation, with the delivery stamp on
 *     the offer; the author's round moves through `app.empathy_set_status`
 *     (job).
 */

import type { PrismaClient } from '../../generated/prisma/client';
import { getJobPrisma, prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { getSonnetResponse } from '../../lib/bedrock';
import { canTransition, transition } from '../empathy-state-machine';
import {
  buildShareOfferPrompt,
  buildStagePrompt,
  type ShareOfferContext,
  type PromptContext,
} from '../stage-prompts';
import type { ContextBundle } from '../context-assembler';
import { extractJsonFromResponse } from '../../utils/json-extractor';
import { cleanVisibleAIText } from '../../utils/visible-text';
import type { ReconcilerResult, ShareOfferMessage } from '@meet-without-fear/shared';
import { createFacilitatorMessage, deliverMessage } from '../message-store';
import { loadCurrentStages } from '../stage-shim';
import {
  currentAttempt,
  jobMoveIfUnchanged,
  partyOf,
  sessionParties,
  type SessionParty,
} from '../empathy-store';

import {
  type UserInfo,
  type WitnessingContent,
  getSonnetJson,
  getWitnessingContent,
  persistAnalysis,
  generateAbstractGuidance,
  currentResultFor,
  dbResultToReconcilerResult,
  toUserInfo,
} from './analysis';
import { hasContextAlreadyBeenShared } from './circuit-breaker';
import { checkAndRevealBothIfReady } from './state';

// ============================================================================
// Helpers
// ============================================================================

/** The name `viewer` uses for `other` (their relationship nickname, else the other's name). */
async function displayNameForViewer(sessionId: string, viewer: SessionParty, other: SessionParty, fallback: string): Promise<string> {
  try {
    if (viewer.userId) {
      const member = await prisma.relationshipMember.findFirst({
        where: { userId: viewer.userId, relationship: { sessions: { some: { id: sessionId } } } },
        select: { nickname: true },
      });
      if (member?.nickname?.trim()) return member.nickname.trim();
    }
    return other.name?.trim() || fallback;
  } catch (error) {
    logger.warn('Failed to resolve partner display name, using fallback', { sessionId, error: (error as Error).message });
    return fallback;
  }
}

/** The open (PENDING/OFFERED) offer of a subject in a session, with its attempt's author. */
async function openOfferOf(sessionId: string, subjectParticipantId: string) {
  return prisma.contextShareOffer.findFirst({
    where: {
      subjectParticipantId,
      status: { in: ['OFFERED', 'PENDING'] },
      attempt: { authorParticipant: { sessionId } },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      attempt: { select: { id: true, authorParticipantId: true, status: true, statusVersion: true } },
      result: true,
    },
  });
}

// ============================================================================
// Helper: Generate Post-Share Continuation
// ============================================================================

/**
 * A stage-appropriate continuation for the subject after they share context.
 */
export async function generatePostShareContinuation(
  sessionId: string,
  subject: SessionParty,
  subjectName: string,
  partnerName: string,
  sharedContent: string,
  partner?: SessionParty,
): Promise<string> {
  logger.info('Generating post-share continuation', { subjectParticipantId: subject.participantId });

  const currentStage = (await loadCurrentStages([subject.participantId])).get(subject.participantId)?.stage ?? 2;

  if (currentStage === 2) {
    const ownAttempt = partner ? await currentAttempt(subject.participantId, partner.participantId) : null;
    if (ownAttempt?.status === 'REFINING') {
      return `Thank you for sharing that with ${partnerName}. They'll have the chance to sit with it and refine their understanding. You also have an updated draft of your own empathy statement to review. When you're ready, use "Revisit what you'll share" and resubmit it so ${partnerName} can see your updated understanding.`;
    }
    return `Thank you for sharing that with ${partnerName}. They'll have the chance to sit with it and refine their understanding. If your own empathy draft asks for review, use "Revisit what you'll share" before waiting. Otherwise, you don't need to do anything more on their behalf.`;
  }

  // The subject's own recent chat (their MAIN conversation).
  const recentMessages = subject.mainConversationId
    ? await prisma.message.findMany({
        where: { conversationId: subject.mainConversationId, kind: 'CHAT', role: { in: ['USER', 'AI'] } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { role: true, content: true },
      })
    : [];
  const conversationHistory = recentMessages
    .reverse()
    .map(m => ({ role: (m.role === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content }));

  const turnId = `${sessionId}-${Date.now()}`;
  const minimalContextBundle: ContextBundle = {
    conversationContext: {
      recentTurns: conversationHistory.map(m => ({ role: m.role, content: m.content, timestamp: new Date().toISOString() })),
      turnCount: conversationHistory.filter(m => m.role === 'user').length,
      sessionDurationMinutes: 0,
    },
    emotionalThread: { initialIntensity: 5, currentIntensity: 5, trend: 'stable' as const, notableShifts: [] },
    stageContext: { stage: currentStage, gatesSatisfied: {} },
    userName: subjectName,
    partnerName,
    intent: {
      intent: 'emotional_validation' as const,
      depth: 'minimal' as const,
      reason: 'Post-share continuation',
      threshold: 0.5,
      maxCrossSession: 0,
      allowCrossSession: false,
      surfaceStyle: 'silent' as const,
    },
    assembledAt: new Date().toISOString(),
  };

  const promptContext: PromptContext = {
    userName: subjectName,
    partnerName,
    turnCount: conversationHistory.filter(m => m.role === 'user').length,
    emotionalIntensity: 5,
    contextBundle: minimalContextBundle,
    justSharedWithPartner: { sharedContent },
  };

  const response = await getSonnetResponse({
    systemPrompt: buildStagePrompt(currentStage, promptContext),
    messages: conversationHistory,
    maxTokens: 512,
    sessionId,
    turnId,
    operation: 'reconciler-post-share-continuation',
  });

  if (!response) return getFallbackContinuation(currentStage, partnerName);

  try {
    const parsed = extractJsonFromResponse(response) as { response?: string };
    if (parsed && typeof parsed.response === 'string') return parsed.response;
  } catch (error) {
    logger.warn('Failed to parse JSON response, attempting fallback extraction', { error: (error as Error).message });
  }
  const stripped = response.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  const responseMatch = stripped.match(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (responseMatch) {
    return responseMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  return getFallbackContinuation(currentStage, partnerName);
}

/**
 * Get a stage-appropriate fallback message (acknowledgment + continuation) if AI generation fails
 */
export function getFallbackContinuation(stage: number, partnerName: string): string {
  const acknowledgment = `Thank you for sharing that with ${partnerName}. They'll have the chance to refine their understanding of what you're going through.`;

  let continuation: string;
  switch (stage) {
    case 1:
      continuation = `Is there anything else about how this situation has affected you that feels important to express?`;
      break;
    case 2:
      continuation = `If your own empathy draft asks for review, use "Revisit what you'll share" before waiting. Otherwise, you don't need to do anything more on their behalf.`;
      break;
    case 3:
      continuation = `Let's continue identifying what you truly need here. What feels most important to you?`;
      break;
    case 4:
      continuation = `Let's continue thinking about what could work for both of you. What small step might help?`;
      break;
    default:
      continuation = `Let's continue our conversation. What's on your mind?`;
      break;
  }

  return `${acknowledgment}\n\n${continuation}`;
}

// ============================================================================
// Helper: Generate Context-Received Reflection
// ============================================================================

/**
 * A reflection AI message for the guesser after they receive shared context.
 */
export async function generateContextReceivedReflection(
  sessionId: string,
  guesserName: string,
  subjectName: string,
): Promise<string> {
  void sessionId;
  void guesserName;
  return `${subjectName} shared this because there may be a part of their experience your first understanding did not fully catch. Take a moment with it, then tell me what stands out or what shifts in your understanding.`;
}

// ============================================================================
// Helper: Generate Validation-Feedback Reflection
// ============================================================================

/**
 * A reflection AI message for the guesser after they receive validation feedback.
 */
export async function generateValidationFeedbackReflection(
  sessionId: string,
  guesserName: string,
  subjectName: string,
): Promise<string> {
  const fallback = `${subjectName} shared some thoughts about what didn't feel fully captured in your empathy attempt. Take a moment to read their feedback — it can help you understand their experience more deeply before you revise.`;

  try {
    const turnId = `${sessionId}-val-feedback-reflection-${Date.now()}`;
    const prompt = `${guesserName}'s partner ${subjectName} just provided feedback on ${guesserName}'s empathy attempt, indicating that it didn't fully capture their experience. The feedback will appear directly below your message in a labeled card.

Generate a short message (1-3 sentences) that frames the situation for ${guesserName}. Explain that ${subjectName} has shared thoughts about what didn't feel fully captured, and invite ${guesserName} to read the feedback and reflect on it before revising their understanding.

Tone: warm, encouraging, non-judgmental. This is a normal part of the process — getting feedback is how understanding deepens.
Do NOT paraphrase or reveal the feedback content. Do NOT use the word "reconciler".

Respond with ONLY the message text, no additional formatting.`;

    const response = await getSonnetResponse({
      systemPrompt: prompt,
      messages: [{ role: 'user', content: 'Generate the validation feedback reflection message.' }],
      maxTokens: 256,
      sessionId,
      turnId,
      operation: 'reconciler-validation-feedback-reflection',
    });

    const trimmed = response?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : fallback;
  } catch (error) {
    logger.error('generateValidationFeedbackReflection failed', { error: (error as Error).message });
    return fallback;
  }
}

// ============================================================================
// Share Suggestion Generation
// ============================================================================

/**
 * The job's offer insert (trailer T7, TS-10 block): the next iteration of the
 * attempt's offers.
 */
async function insertOffer(
  client: PrismaClient,
  opts: {
    attemptId: string;
    resultId: string;
    subjectParticipantId: string;
    status: 'PENDING' | 'OFFERED';
    offerMessage?: string | null;
    suggestedContent: string;
    suggestedReason: string | null;
  },
): Promise<string> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    INSERT INTO context_share_offer (attempt_id, result_id, subject_participant_id, iteration, status, offer_message,
                                     suggested_content, suggested_reason, offered_at)
    VALUES (${opts.attemptId}::uuid, ${opts.resultId}::uuid, ${opts.subjectParticipantId}::uuid,
            coalesce((SELECT max(o.iteration) FROM context_share_offer o WHERE o.attempt_id = ${opts.attemptId}::uuid), 0) + 1,
            ${opts.status}::share_offer_status, ${opts.offerMessage ?? null}, ${opts.suggestedContent}, ${opts.suggestedReason},
            ${opts.status === 'OFFERED' ? new Date() : null}::timestamptz)
    RETURNING id`;
  return rows[0].id;
}

/**
 * Generate a share suggestion for a direction after the symmetric reconciler
 * moved it to AWAITING_SHARING, so the subject sees it without a reload.
 * User ids in (the caller's signature); participants inside.
 */
export async function generateShareSuggestionForDirection(
  sessionId: string,
  guesserId: string,
  subjectId: string,
): Promise<void> {
  const parties = await sessionParties(sessionId);
  const g = partyOf(parties, { userId: guesserId });
  const s = partyOf(parties, { userId: subjectId });
  if (!g || !s) {
    logger.error('generateShareSuggestionForDirection: guesser or subject not found', { guesserId, subjectId });
    return;
  }
  const attempt = await currentAttempt(g.participantId, s.participantId);
  if (!attempt) return;
  const stored = await currentResultFor(attempt.id);
  if (!stored) {
    logger.warn('generateShareSuggestionForDirection: No reconciler result found', { guesserId, subjectId });
    return;
  }
  const existing = await prisma.contextShareOffer.findFirst({
    where: { resultId: stored.id, suggestedContent: { not: null } },
    select: { id: true },
  });
  if (existing) return;

  const witnessingContent = await getWitnessingContent(sessionId, s.participantId, s.userId ?? undefined);
  await generateShareSuggestion(
    sessionId,
    toUserInfo(g, 'User'),
    toUserInfo(s, 'User'),
    dbResultToReconcilerResult(stored),
    witnessingContent,
    { attemptId: attempt.id, storedResultId: stored.id, fresh: false },
  );
}

/**
 * Generate the suggestion for the subject and persist it: a fresh analysis is
 * written with the suggestion (`persistAnalysis`), then the subject's offer
 * (PENDING) — both by the job. A suggestion that fails to generate leaves the
 * analysis stored and no offer, as before.
 */
export async function generateShareSuggestion(
  sessionId: string,
  guesser: UserInfo,
  subject: UserInfo,
  reconcilerResult: ReconcilerResult,
  witnessingContent: WitnessingContent,
  persist: { attemptId: string; storedResultId?: string; fresh: boolean },
): Promise<{ suggestedContent: string; reason: string } | null> {
  logger.info('Generating share suggestion', { subjectId: subject.id, guesserId: guesser.id });
  const turnId = `${sessionId}-${Date.now()}`;

  const response = await getSonnetJson<{ suggestedContent: string; reason: string }>({
    systemPrompt: `You are helping ${subject.name} understand what context they could share to help ${guesser.name} understand them better.

${guesser.name} tried to express empathy for ${subject.name}'s experience, but missed some important aspects:

Gap Analysis:
- Severity: ${reconcilerResult.gaps.severity}
- Summary: ${reconcilerResult.gaps.summary}
- Missed feelings: ${reconcilerResult.gaps.missedFeelings.join(', ')}
${reconcilerResult.gaps.mostImportantGap ? `- Most important gap: ${reconcilerResult.gaps.mostImportantGap}` : ''}

${subject.name}'s actual witnessing content (what they shared in Stage 1):
---
${witnessingContent.userMessages}
---

Generate a brief, specific suggestion for what ${subject.name} could share to help ${guesser.name} understand better. The suggestion should:
1. Be 1-3 sentences that ${subject.name} would say directly TO ${guesser.name}
2. Draw from what they actually shared (don't invent new content)
3. Address the most important gap in understanding
4. Feel natural and not forced

IMPORTANT GUIDELINES for the suggestion:
- Never start with confrontational phrases like "Look," or "Listen,"
- Focus on sharing ${subject.name}'s experience, not making claims about ${guesser.name}'s behavior
- Do not say or imply what ${guesser.name} thinks, believes, or has already understood
- Do not escalate ambiguity into permanent rupture, departure, rejection, or leaving unless ${subject.name} explicitly said that
- Use "I" statements, never "you" accusations
- Keep the tone warm and vulnerable, not defensive or aggressive

Also explain briefly WHY sharing this would help (1 sentence).

Respond in JSON:
\`\`\`json
{
  "suggestedContent": "The suggestion text",
  "reason": "Why this would help"
}
\`\`\``,
    messages: [{ role: 'user', content: 'Generate the share suggestion.' }],
    maxTokens: 512,
    sessionId,
    turnId,
    operation: 'reconciler-share-suggestion',
  });

  const suggestion = response
    ? { suggestedContent: cleanVisibleAIText(response.suggestedContent), reason: cleanVisibleAIText(response.reason) }
    : null;
  if (!suggestion) logger.warn('AI failed to generate share suggestion');

  let resultId = persist.storedResultId ?? null;
  if (persist.fresh) {
    resultId = await persistAnalysis({
      attemptId: persist.attemptId,
      authorParticipantId: guesser.participantId,
      subjectParticipantId: subject.participantId,
      result: reconcilerResult,
      guidance: reconcilerResult.abstractGuidance ?? generateAbstractGuidance(reconcilerResult),
      suggestion: suggestion ? { content: suggestion.suggestedContent, reason: suggestion.reason } : null,
    });
  }
  if (!suggestion || !resultId) return suggestion ? { suggestedContent: suggestion.suggestedContent, reason: suggestion.reason } : null;

  const open = await prisma.contextShareOffer.findFirst({
    where: { resultId, status: { in: ['PENDING', 'OFFERED'] } },
    select: { id: true },
  });
  if (!open) {
    await insertOffer(getJobPrisma(), {
      attemptId: persist.attemptId,
      resultId,
      subjectParticipantId: subject.participantId,
      status: 'PENDING',
      suggestedContent: suggestion.suggestedContent,
      suggestedReason: suggestion.reason,
    });
  }
  return { suggestedContent: suggestion.suggestedContent, reason: suggestion.reason };
}

/**
 * Refine a share suggestion based on user feedback.
 */
async function refineShareSuggestion(
  originalContent: string,
  refinementRequest: string,
  guesserName: string,
  subjectName: string,
  gapContext: { severity: string; summary: string; missedFeelings: string[]; mostImportantGap: string | null },
  sessionId: string,
): Promise<string | null> {
  const turnId = `${sessionId}-refine-${Date.now()}`;
  const response = await getSonnetJson<{ refinedContent: string }>({
    systemPrompt: `You are helping ${subjectName} refine a message they want to share with ${guesserName}.

${guesserName} tried to express empathy for ${subjectName}'s experience but missed some important aspects:

Gap Analysis:
- Severity: ${gapContext.severity}
- Summary: ${gapContext.summary}
- Missed feelings: ${gapContext.missedFeelings.join(', ') || 'None specified'}
${gapContext.mostImportantGap ? `- Most important gap: ${gapContext.mostImportantGap}` : ''}

The AI previously generated this suggestion for ${subjectName} to share:
---
${originalContent}
---

${subjectName} wants to modify this suggestion. Their feedback is:
---
${refinementRequest}
---

Generate a refined version of the sharing suggestion that incorporates ${subjectName}'s feedback while still addressing the gaps in ${guesserName}'s understanding.

Guidelines:
1. Keep it 1-3 sentences that ${subjectName} would say directly TO ${guesserName}
2. Honor the user's specific feedback about what to change
3. Maintain the focus on sharing feelings and experience (not accusations)
4. Use "I" statements, keep the tone warm and vulnerable
5. Never start with confrontational phrases like "Look," or "Listen,"

Respond in JSON:
\`\`\`json
{
  "refinedContent": "The refined suggestion text"
}
\`\`\``,
    messages: [{ role: 'user', content: 'Generate the refined share suggestion.' }],
    maxTokens: 512,
    sessionId,
    turnId,
    operation: 'reconciler-refine-suggestion',
  });
  if (!response || !response.refinedContent) {
    logger.warn('AI failed to refine share suggestion');
    return null;
  }
  return response.refinedContent;
}

// ============================================================================
// Get Share Suggestion for User
// ============================================================================

/**
 * The subject's PENDING offer (marked OFFERED now that it is viewed).
 */
export async function getShareSuggestionForUser(
  sessionId: string,
  userId: string,
): Promise<{
  hasSuggestion: boolean;
  suggestion: { guesserName: string; suggestedContent: string; reason: string; canRefine: boolean } | null;
}> {
  const parties = await sessionParties(sessionId);
  const me = partyOf(parties, { userId });
  if (!me) return { hasSuggestion: false, suggestion: null };

  const offer = await prisma.contextShareOffer.findFirst({
    where: { subjectParticipantId: me.participantId, status: 'PENDING', attempt: { authorParticipant: { sessionId } } },
    orderBy: { createdAt: 'desc' },
    include: { attempt: { select: { authorParticipantId: true } } },
  });
  if (!offer || !offer.suggestedContent) return { hasSuggestion: false, suggestion: null };

  // The subject's own row: OFFERED once viewed (app connection).
  await prisma.contextShareOffer.update({
    where: { id: offer.id },
    data: { status: 'OFFERED', offeredAt: offer.offeredAt ?? new Date() },
    select: { id: true },
  });

  const author = partyOf(parties, { participantId: offer.attempt.authorParticipantId });
  return {
    hasSuggestion: true,
    suggestion: {
      guesserName: author?.name || 'Your partner',
      suggestedContent: offer.suggestedContent,
      reason: offer.suggestedReason || 'This would help them understand you better.',
      canRefine: true,
    },
  };
}

// ============================================================================
// Respond to Share Suggestion
// ============================================================================

/**
 * The subject answers their offer (accept / refine / decline).
 *
 *  - decline: the offer DECLINED + a DENIED consent naming it (subject, app
 *    connection, one transaction); the author's round → READY (job,
 *    status-version guarded); then the reveal check. Nothing the author can
 *    read changes except the direction's status.
 *  - accept / refine: the offer ACCEPTED with the exact shared text + a
 *    GRANTED consent (subject, app); then the job delivers: SHARED_CONTEXT into
 *    the author's conversation, the reflection prompt for the author, the
 *    acknowledgement for the subject, the offer's delivery stamp, and the
 *    author's round → REFINING — one job transaction.
 */
export async function respondToShareSuggestion(
  sessionId: string,
  userId: string,
  response: { action: 'accept' | 'decline' | 'refine'; refinedContent?: string },
): Promise<{ status: 'shared' | 'declined'; sharedContent: string | null; guesserUpdated: boolean }> {
  logger.info('respondToShareSuggestion called', { userId, action: response.action });

  const parties = await sessionParties(sessionId);
  const me = partyOf(parties, { userId });
  if (!me) throw new Error('No pending share offer found');

  const offer = await openOfferOf(sessionId, me.participantId);
  if (!offer) {
    const processed = await prisma.contextShareOffer.findFirst({
      where: {
        subjectParticipantId: me.participantId,
        status: { in: ['ACCEPTED', 'DECLINED'] },
        attempt: { authorParticipant: { sessionId } },
      },
      orderBy: { updatedAt: 'desc' },
      select: { status: true, sharedContent: true },
    });
    if (processed?.status === 'ACCEPTED' && response.action !== 'decline') {
      return { status: 'shared', sharedContent: processed.sharedContent, guesserUpdated: false };
    }
    if (processed?.status === 'DECLINED' && response.action === 'decline') {
      return { status: 'declined', sharedContent: null, guesserUpdated: false };
    }
    throw new Error('No pending share offer found');
  }

  const author = partyOf(parties, { participantId: offer.attempt.authorParticipantId });
  if (!author) throw new Error('No pending share offer found');
  const attempt = offer.attempt;

  if (response.action === 'decline') {
    const now = new Date();
    await prisma.$transaction(async tx => {
      const updated = await tx.contextShareOffer.updateMany({
        where: { id: offer.id, status: { in: ['OFFERED', 'PENDING'] } },
        data: { status: 'DECLINED', declinedAt: now },
      });
      if (updated.count === 0) throw new Error('Share offer already processed');
      await tx.consent.create({
        data: { participantId: me.participantId, shareOfferId: offer.id, decision: 'DENIED', decidedAt: now },
        select: { id: true },
      });
      // The subject's own pending suggestion card, if any.
      if (me.mainConversationId) {
        await tx.message.deleteMany({ where: { conversationId: me.mainConversationId, kind: 'SHARE_SUGGESTION' } });
      }
    });

    if (canTransition(attempt.status, 'DECLINE_SHARING')) {
      await jobMoveIfUnchanged(attempt.id, attempt.statusVersion, transition(attempt.status, 'DECLINE_SHARING'));
    } else if (attempt.status !== 'VALIDATED') {
      transition(attempt.status, 'DECLINE_SHARING');
    }

    await checkAndRevealBothIfReady(sessionId);
    return { status: 'declined', sharedContent: null, guesserUpdated: true };
  }

  // accept / refine — AI calls first, outside any transaction.
  let sharedContent: string;
  if (response.action === 'refine' && response.refinedContent) {
    const refined = await refineShareSuggestion(
      offer.suggestedContent || '',
      response.refinedContent,
      author.name || 'your partner',
      me.name || 'you',
      {
        severity: offer.result.gapSeverity.toLowerCase(),
        summary: offer.result.gapSummary,
        missedFeelings: offer.result.missedFeelings,
        mostImportantGap: offer.result.mostImportantGap,
      },
      sessionId,
    );
    sharedContent = refined ?? offer.suggestedContent ?? '';
  } else {
    sharedContent = offer.suggestedContent || '';
  }
  sharedContent = cleanVisibleAIText(sharedContent);
  if (!sharedContent.trim()) {
    logger.error('suggestedContent was empty, cannot proceed', { shareOfferId: offer.id });
    throw new Error('Share suggestion content is empty - cannot share');
  }

  const [subjectSeesGuesserName, guesserSeesSubjectName] = await Promise.all([
    displayNameForViewer(sessionId, me, author, author.name || 'your partner'),
    displayNameForViewer(sessionId, author, me, me.name || 'your partner'),
  ]);

  const priorShareCount = await prisma.contextShareOffer.count({
    where: { subjectParticipantId: me.participantId, status: 'ACCEPTED', attempt: { authorParticipant: { sessionId } } },
  });
  const [subjectAckMessage, reflectionMessage] = await Promise.all([
    priorShareCount > 0
      ? Promise.resolve(`Thanks for sharing that additional context with ${subjectSeesGuesserName}.`)
      : generatePostShareContinuation(sessionId, me, me.name || 'You', subjectSeesGuesserName, sharedContent, author),
    generateContextReceivedReflection(sessionId, author.name || 'User', guesserSeesSubjectName),
  ]);

  await shareAccepted({
    sessionId,
    offerId: offer.id,
    subject: me,
    author,
    attempt,
    sharedContent,
    refinement: response.action === 'refine' ? response.refinedContent ?? null : null,
    subjectAckMessage,
    reflectionMessage,
  });

  return { status: 'shared', sharedContent, guesserUpdated: true };
}

/**
 * The accept path's writes (shared by respondToShareSuggestion and the
 * refinement-finalize endpoint): the subject's answer (app), then the job's
 * delivery.
 */
export async function shareAccepted(opts: {
  sessionId: string;
  offerId: string;
  subject: SessionParty;
  author: SessionParty;
  attempt: { id: string; status: string; statusVersion: number };
  sharedContent: string;
  refinement: string | null;
  subjectAckMessage: string;
  reflectionMessage: string;
}): Promise<{ sharedMessageId: string | null }> {
  const now = new Date();
  await prisma.$transaction(async tx => {
    const updated = await tx.contextShareOffer.updateMany({
      where: { id: opts.offerId, status: { in: ['OFFERED', 'PENDING'] } },
      data: { status: 'ACCEPTED', sharedContent: opts.sharedContent, sharedAt: now },
    });
    if (updated.count === 0) throw new Error('Share offer already processed');
    await tx.consent.create({
      data: { participantId: opts.subject.participantId, shareOfferId: opts.offerId, decision: 'GRANTED', decidedAt: now },
      select: { id: true },
    });
    if (opts.subject.mainConversationId) {
      await tx.message.deleteMany({ where: { conversationId: opts.subject.mainConversationId, kind: 'SHARE_SUGGESTION' } });
    }
  });
  if (opts.refinement) {
    // spec §1.2: the refined text is the subject's SHARE_CONTEXT draft.
    await prisma.$executeRaw`
      INSERT INTO draft (participant_id, kind, share_offer_id, content, ready_to_share, version)
      VALUES (${opts.subject.participantId}::uuid, 'SHARE_CONTEXT'::draft_kind, ${opts.offerId}::uuid, ${opts.refinement}, true, 1)
      ON CONFLICT (participant_id, kind, (coalesce(about_participant_id, attempt_id, share_offer_id)))
      DO UPDATE SET content = EXCLUDED.content, version = draft.version + 1`;
  }

  // The job's delivery, in one transaction; messages 100 ms apart for a stable order.
  let sharedMessageId: string | null = null;
  const base = now.getTime();
  await getJobPrisma().$transaction(async tx => {
    const client = tx as unknown as PrismaClient;
    if (opts.author.mainConversationId) {
      const delivered = await deliverMessage({
        toConversationId: opts.author.mainConversationId,
        fromParticipantId: opts.subject.participantId,
        kind: 'SHARED_CONTEXT',
        content: opts.sharedContent,
        createdAt: new Date(base),
        client,
      });
      sharedMessageId = delivered.id;
      await createFacilitatorMessage({
        conversationId: opts.author.mainConversationId,
        content: opts.reflectionMessage,
        createdAt: new Date(base + 100),
        client,
      });
    }
    if (opts.subject.mainConversationId) {
      await createFacilitatorMessage({
        conversationId: opts.subject.mainConversationId,
        content: opts.subjectAckMessage,
        createdAt: new Date(base + 200),
        client,
      });
    }
    await tx.$executeRaw`
      UPDATE context_share_offer SET delivery_status = 'DELIVERED', delivered_at = ${now}
      WHERE id = ${opts.offerId}::uuid`;
    // The author's round → REFINING (CONTEXT_SHARED); a VALIDATED round keeps its terminal status.
    if (canTransition(opts.attempt.status, 'CONTEXT_SHARED')) {
      await tx.$queryRaw`SELECT app.empathy_set_status(${opts.attempt.id}::uuid, 'REFINING'::empathy_status, NULL::text)`;
    }
  });
  return { sharedMessageId };
}

// ============================================================================
// Get Shared Context for Guesser
// ============================================================================

/**
 * The newest context delivered to the guesser (SHARED_CONTEXT or
 * VALIDATION_FEEDBACK in their own conversation). The offer itself is the
 * subject's and is not read.
 */
export async function getSharedContextForGuesser(
  sessionId: string,
  guesserId: string,
): Promise<{ hasSharedContext: boolean; content: string | null; sharedAt: string | null }> {
  const parties = await sessionParties(sessionId);
  const me = partyOf(parties, { userId: guesserId });
  if (!me?.mainConversationId) return { hasSharedContext: false, content: null, sharedAt: null };
  const contextMessage = await prisma.message.findFirst({
    where: { conversationId: me.mainConversationId, kind: { in: ['SHARED_CONTEXT', 'VALIDATION_FEEDBACK'] } },
    orderBy: { createdAt: 'desc' },
    select: { content: true, createdAt: true },
  });
  if (!contextMessage) return { hasSharedContext: false, content: null, sharedAt: null };
  return { hasSharedContext: true, content: contextMessage.content, sharedAt: contextMessage.createdAt.toISOString() };
}

// ============================================================================
// Get Shared Content Delivery Status
// ============================================================================

/**
 * The delivery status of what the subject shared: 'delivered' once the job
 * delivered it, 'seen' once the recipient viewed their Share tab after it.
 */
export async function getSharedContentDeliveryStatus(
  sessionId: string,
  subjectId: string,
): Promise<{
  hasSharedContent: boolean;
  deliveryStatus: 'pending' | 'delivered' | 'seen' | null;
  sharedAt: string | null;
  sharedContent: string | null;
}> {
  const parties = await sessionParties(sessionId);
  const me = partyOf(parties, { userId: subjectId });
  if (!me) return { hasSharedContent: false, deliveryStatus: null, sharedAt: null, sharedContent: null };
  const offer = await prisma.contextShareOffer.findFirst({
    where: { subjectParticipantId: me.participantId, status: 'ACCEPTED', attempt: { authorParticipant: { sessionId } } },
    orderBy: { sharedAt: 'desc' },
    include: { attempt: { select: { authorParticipantId: true } } },
  });
  if (!offer || !offer.sharedContent || !offer.sharedAt) {
    return { hasSharedContent: false, deliveryStatus: null, sharedAt: null, sharedContent: null };
  }
  // The recipient's Share-tab instant (an instant, never content — as TS-9's presence read).
  const readState = await prisma.conversationReadState.findUnique({
    where: { participantId: offer.attempt.authorParticipantId },
    select: { lastViewedShareTabAt: true },
  });
  const seen = !!readState?.lastViewedShareTabAt && readState.lastViewedShareTabAt >= offer.sharedAt;
  return {
    hasSharedContent: true,
    deliveryStatus: seen ? 'seen' : 'delivered',
    sharedAt: offer.sharedAt.toISOString(),
    sharedContent: offer.sharedContent,
  };
}

// ============================================================================
// Generate Share Offer
// ============================================================================

/**
 * The share-offer fallback for a subject with an analysed direction about
 * them and no offer yet: crafts one and writes it OFFERED (job).
 */
export async function generateShareOffer(
  sessionId: string,
  subjectId: string,
): Promise<{ offerMessage: string; suggestedContent: string; suggestedReason: string; gapDescription: string } | null> {
  const parties = await sessionParties(sessionId);
  const me = partyOf(parties, { userId: subjectId });
  if (!me) return null;

  const result = await prisma.reconcilerResult.findFirst({
    where: {
      subjectParticipantId: me.participantId,
      supersededAt: null,
      attempt: { status: { notIn: ['SUPERSEDED'] }, authorParticipant: { sessionId } },
    },
    orderBy: { createdAt: 'desc' },
    include: { shareOffers: { select: { id: true } }, attempt: { select: { authorParticipantId: true } } },
  });
  if (!result) return null;
  if (result.shareOffers.length > 0) return null;

  const author = partyOf(parties, { participantId: result.attempt.authorParticipantId });
  if (!author) return null;
  if (await hasContextAlreadyBeenShared(author.participantId, me.participantId)) {
    logger.info('generateShareOffer: context already shared, skipping redundant suggestion', { sessionId });
    return null;
  }

  const witnessingContent = await getWitnessingContent(sessionId, me.participantId, me.userId ?? undefined);
  const partnerName = author.name || 'your partner';
  const userName = me.name || 'you';
  const shareOfferContext: ShareOfferContext = {
    userName,
    partnerName,
    gapSummary: result.gapSummary,
    mostImportantGap: result.mostImportantGap || result.gapSummary,
  };

  const [offerResult, suggestionResult] = await Promise.all([
    getSonnetJson<ShareOfferMessage>({
      systemPrompt: buildShareOfferPrompt(shareOfferContext),
      messages: [{ role: 'user', content: 'Generate the share offer message.' }],
      maxTokens: 512,
      sessionId,
      operation: 'reconciler-share-offer',
    }),
    getSonnetJson<{ suggestedContent: string; reason: string }>({
      systemPrompt: `You are helping ${userName} express their feelings to ${partnerName} in a way that builds understanding.

${partnerName} tried to understand ${userName}'s experience but missed some important aspects:
- Gap summary: ${result.gapSummary}
${result.mostImportantGap ? `- Most important gap: ${result.mostImportantGap}` : ''}

Here is what ${userName} actually shared about their experience:
---
${witnessingContent.userMessages}
---

Your job is to CRAFT a feelings-focused message that ${userName} would say directly TO ${partnerName}. This is NOT about extracting quotes - you must transform their raw expression into something that:

1. FOCUSES ON FEELINGS AND NEEDS
   - Transform complaints into expressions of underlying feelings
   - Example: "They never listen!" -> "I feel unheard when I share something important and don't get a response"
   - Example: "They're so controlling!" -> "I feel anxious when decisions are made without including me"

2. USES SIMPLE, CONVERSATIONAL LANGUAGE
   - No psychology jargon or "NVC speak"
   - Write like a wise friend would talk, not a textbook
   - Keep it natural and genuine

3. REMOVES ATTACKING OR BLAMING LANGUAGE
   - No "you always" or "you never" accusations
   - No character judgments about ${partnerName}
   - Focus on ${userName}'s internal experience, not ${partnerName}'s behavior

4. STAYS TRUE TO WHAT THEY SHARED
   - Draw from their actual content (don't invent new feelings)
   - But express it in a way that invites understanding rather than defensiveness

5. IS BRIEF AND FOCUSED
   - 1-3 sentences maximum
   - Address the most important gap in understanding

6. PRESERVES ACCOUNTABILITY AND SAFETY
   - If anger, temper, volatility, escalation, or loss of control is part of the conflict, never imply ${userName} cannot control themselves
   - Do not ask ${partnerName} to accept unsafe behavior or minimize harm
   - It is okay to name defensiveness or anger, but pair it with ownership (for example: "my anger is still mine to handle")
   - Recognition needs must never override ${partnerName}'s need for safety or boundaries

IMPORTANT GUIDELINES:
- Never start with confrontational phrases like "Look," or "Listen,"
- Never include accusations or blame
- The goal is to help ${partnerName} understand, not to convince them they're wrong

Respond in JSON:
\`\`\`json
{
  "suggestedContent": "The feelings-focused message",
  "reason": "Brief explanation of why this helps bridge the gap"
}
\`\`\``,
      messages: [{ role: 'user', content: 'Craft a feelings-focused share suggestion.' }],
      maxTokens: 512,
      sessionId,
      operation: 'reconciler-share-suggestion-craft',
    }),
  ]);

  if (!offerResult || !suggestionResult) {
    logger.warn('Failed to generate share offer or suggestion');
    return null;
  }

  const offerMessage = cleanVisibleAIText(offerResult.message);
  const suggestedContent = cleanVisibleAIText(suggestionResult.suggestedContent);
  const suggestedReason = cleanVisibleAIText(suggestionResult.reason);

  await insertOffer(getJobPrisma(), {
    attemptId: result.attemptId,
    resultId: result.id,
    subjectParticipantId: me.participantId,
    status: 'OFFERED',
    offerMessage,
    suggestedContent,
    suggestedReason,
  });

  return { offerMessage, suggestedContent, suggestedReason, gapDescription: result.mostImportantGap || result.gapSummary };
}

