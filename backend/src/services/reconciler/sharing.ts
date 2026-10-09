/**
 * Reconciler Sharing Module
 *
 * Share suggestion generation, refinement, and response handling.
 * Manages the flow of sharing context between users when empathy gaps are detected.
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { EmpathyStatus, MessageRole } from '@meet-without-fear/shared';
import type { Prisma } from '../../generated/prisma/client';
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
import type {
  ReconcilerResult,
  ShareOfferMessage,
} from '@meet-without-fear/shared';

type ConversationPromptMessage = {
  role: string;
  content: string;
};

import {
  type UserInfo,
  type WitnessingContent,
  getSonnetJson,
  dbResultToReconcilerResult,
  getWitnessingContent,
} from './analysis';
import { hasContextAlreadyBeenShared } from './circuit-breaker';
import { checkAndRevealBothIfReady } from './state';

// ============================================================================
// Helper: Find ReconcilerResult with retry
// ============================================================================

/**
 * Retry up to 3 times to find ReconcilerResult to handle potential race condition
 * where the record might not be immediately visible after creation.
 * This is only used as a fallback when the DB record is not passed by reference.
 */
async function findReconcilerResultWithRetry(
  sessionId: string,
  guesserId: string,
  subjectId: string
): Promise<any | null> {
  let dbResult = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    logger.debug('Looking up ReconcilerResult', { attempt, guesserId, subjectId });
    dbResult = await prisma.reconcilerResult.findFirst({
      where: {
        sessionId,
        guesserId,
        subjectId,
        supersededAt: null,
      },
    });
    if (dbResult) {
      break;
    }
    if (attempt < 3) {
      logger.warn('ReconcilerResult not found, retrying', { attempt, guesserId, subjectId });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if (!dbResult) {
    logger.error('CRITICAL: Could not find reconcilerResult after 3 attempts', { guesserId, subjectId, sessionId });
  }

  return dbResult;
}

// ============================================================================
// Helper: Generate Post-Share Continuation
// ============================================================================

async function getPartnerDisplayNameForViewer(
  sessionId: string,
  viewerId: string,
  partnerId: string,
  fallbackName: string
): Promise<string> {
  try {
    const membership = await prisma.relationshipMember.findFirst({
      where: {
        userId: viewerId,
        relationship: {
          sessions: { some: { id: sessionId } },
        },
      },
      select: {
        nickname: true,
      },
    });

    if (membership?.nickname?.trim()) {
      return membership.nickname.trim();
    }

    const partner = await prisma.user.findUnique({
      where: { id: partnerId },
      select: {
        firstName: true,
        name: true,
      },
    });

    return partner?.firstName?.trim() || partner?.name?.trim() || fallbackName;
  } catch (error) {
    logger.warn('Failed to resolve partner display name, using fallback', {
      sessionId,
      viewerId,
      partnerId,
      error: (error as Error).message,
    });
    return fallbackName;
  }
}

/**
 * Generate a stage-appropriate continuation message after a user shares context.
 * Uses the actual stage prompts with justSharedWithPartner context for consistency.
 * The stage prompt handles acknowledging the share and continuing appropriately.
 */
export async function generatePostShareContinuation(
  sessionId: string,
  subjectId: string,
  subjectName: string,
  partnerName: string,
  sharedContent: string
): Promise<string> {
  logger.info('Generating post-share continuation', { subjectId });

  // Get subject's current stage
  const stageProgress = await prisma.stageProgress.findFirst({
    where: { sessionId, userId: subjectId },
    orderBy: { stage: 'desc' },
  });
  const currentStage = stageProgress?.stage ?? 2; // Default to 2 if not found

  if (currentStage === 2) {
    const ownAttempt = await prisma.empathyAttempt.findFirst({
      where: {
        sessionId,
        sourceUserId: subjectId,
      },
      select: {
        status: true,
      },
    });

    if (ownAttempt?.status === EmpathyStatus.REFINING) {
      return `Thank you for sharing that with ${partnerName}. They'll have the chance to sit with it and refine their understanding. You also have an updated draft of your own empathy statement to review. When you're ready, use "Revisit what you'll share" and resubmit it so ${partnerName} can see your updated understanding.`;
    }

    return `Thank you for sharing that with ${partnerName}. They'll have the chance to sit with it and refine their understanding. If your own empathy draft asks for review, use "Revisit what you'll share" before waiting. Otherwise, you don't need to do anything more on their behalf.`;
  }

  // Get recent conversation history for context
  const recentMessages = await prisma.message.findMany({
    where: {
      sessionId,
      OR: [
        { senderId: subjectId },
        { role: 'AI', forUserId: subjectId },
      ],
    },
    orderBy: { timestamp: 'desc' },
    take: 10,
  });

  // Convert to format expected by prompt (reverse to chronological order)
  // Only include USER and AI messages - exclude EMPATHY_STATEMENT, SHARED_CONTEXT, etc.
  const conversationHistory = recentMessages
    .filter((m: ConversationPromptMessage) => m.role === 'USER' || m.role === 'AI')
    .reverse()
    .map((m: ConversationPromptMessage) => ({
      role: (m.role === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }));

  const turnId = `${sessionId}-${Date.now()}`;

  // Create a minimal context bundle for the stage prompt
  // We don't need full memory/pattern context for post-share continuation
  const minimalContextBundle: ContextBundle = {
    conversationContext: {
      recentTurns: conversationHistory.map((m: { role: 'user' | 'assistant'; content: string }) => ({
        role: m.role,
        content: m.content,
        timestamp: new Date().toISOString(), // Approximate
      })),
      turnCount: conversationHistory.filter((m: { role: 'user' | 'assistant'; content: string }) => m.role === 'user').length,
      sessionDurationMinutes: 0, // Not critical for this use case
    },
    emotionalThread: {
      initialIntensity: 5,
      currentIntensity: 5, // Default moderate
      trend: 'stable' as const,
      notableShifts: [],
    },
    stageContext: {
      stage: currentStage,
      gatesSatisfied: {},
    },
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

  // Build prompt context with justSharedWithPartner flag
  // This injects the share acknowledgment into the normal stage prompt
  const promptContext: PromptContext = {
    userName: subjectName,
    partnerName,
    turnCount: conversationHistory.filter((m: { role: 'user' | 'assistant'; content: string }) => m.role === 'user').length,
    emotionalIntensity: 5, // Default moderate
    contextBundle: minimalContextBundle,
    justSharedWithPartner: {
      sharedContent,
    },
  };

  // Get the stage-appropriate prompt with post-share context injected
  const systemPrompt = buildStagePrompt(currentStage, promptContext);

  // Call Sonnet with conversation history
  const response = await getSonnetResponse({
    systemPrompt,
    messages: conversationHistory,
    maxTokens: 512,
    sessionId,
    turnId,
    operation: 'reconciler-post-share-continuation',
  });

  if (!response) {
    logger.warn('Failed to generate continuation, using fallback', { stage: currentStage });
    return getFallbackContinuation(currentStage, partnerName);
  }

  // Parse the JSON response and extract just the response field
  // The stage prompt returns: { "response": "...", "analysis": "...", ... }
  try {
    const parsed = extractJsonFromResponse(response) as { response?: string };
    if (parsed && typeof parsed.response === 'string') {
      logger.debug('Generated continuation', { stage: currentStage, preview: parsed.response.substring(0, 50) });
      return parsed.response;
    }
  } catch (error) {
    logger.warn('Failed to parse JSON response, attempting fallback extraction', { error: (error as Error).message });
  }

  // Fallback: strip analysis tags and try to extract response field via regex
  const stripped = response.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  const responseMatch = stripped.match(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (responseMatch) {
    const extracted = responseMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    logger.debug('Extracted response via regex', { preview: extracted.substring(0, 50) });
    return extracted;
  }

  // Last resort: use fallback
  logger.warn('All parsing failed, using fallback', { stage: currentStage });
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
 * Generate a reflection AI message for the guesser after they receive shared context.
 * Placed after the SHARED_CONTEXT card to invite the guesser to process what they read.
 *
 * Falls back to hardcoded message on AI failure.
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
 * Generate a reflection AI message for the guesser after they receive validation feedback.
 * Placed before the VALIDATION_FEEDBACK card to frame the situation and invite reflection.
 *
 * Falls back to hardcoded message on AI failure.
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

    if (!response) {
      logger.warn('generateValidationFeedbackReflection: Sonnet returned null, using fallback');
      return fallback;
    }

    const trimmed = response.trim();
    if (trimmed.length > 0) {
      logger.debug('Generated validation feedback reflection message', { sessionId });
      return trimmed;
    }

    return fallback;
  } catch (error) {
    logger.error('generateValidationFeedbackReflection failed', { error: (error as Error).message });
    return fallback;
  }
}

// ============================================================================
// Share Suggestion Generation
// ============================================================================

/**
 * Generate a share suggestion for a specific direction after reconciler analysis.
 * Called when empathy status is set to AWAITING_SHARING to proactively create
 * the share offer so users see it immediately without needing to reload.
 *
 * @param sessionId - The session ID
 * @param guesserId - The user who made the empathy guess
 * @param subjectId - The user being guessed about (who will receive the share suggestion)
 */
export async function generateShareSuggestionForDirection(
  sessionId: string,
  guesserId: string,
  subjectId: string
): Promise<void> {
  logger.info('generateShareSuggestionForDirection called', { guesserId, subjectId });

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
    logger.error('generateShareSuggestionForDirection: Guesser or subject not found', { guesserId, subjectId });
    return;
  }

  const guesserInfo: UserInfo = {
    id: guesser.id,
    name: guesser.firstName || guesser.name || 'User',
  };
  const subjectInfo: UserInfo = {
    id: subject.id,
    name: subject.firstName || subject.name || 'User',
  };

  // Get the reconciler result
  const dbResult = await prisma.reconcilerResult.findFirst({
    where: {
      sessionId,
      guesserId,
      subjectId,
      supersededAt: null,
    },
    include: {
      shareOffer: true,
    },
  });

  if (!dbResult) {
    logger.warn('generateShareSuggestionForDirection: No reconciler result found', { guesserId, subjectId });
    return;
  }

  // If share offer already exists, don't regenerate
  if (dbResult.shareOffer && dbResult.shareOffer.suggestedContent) {
    logger.debug('Share offer already exists, skipping generation', { guesserId, subjectId });
    return;
  }

  // Convert DB result to ReconcilerResult type
  const reconcilerResult = dbResultToReconcilerResult(dbResult);

  // Get subject's witnessing content
  const witnessingContent = await getWitnessingContent(sessionId, subjectId);

  // Generate the share suggestion (calls the private function)
  await generateShareSuggestion(
    sessionId,
    guesserInfo,
    subjectInfo,
    reconcilerResult,
    witnessingContent
  );

  logger.info('Share suggestion created', { subjectId: subjectInfo.id, guesserId });
}

/**
 * Generate a share suggestion for the subject based on reconciler gaps.
 * This creates a human-readable suggestion that the subject can accept, refine, or decline.
 *
 * @param dbReconcilerResult - Optional DB record to avoid retry loop (passed from runReconcilerForDirection)
 */
export async function generateShareSuggestion(
  sessionId: string,
  guesser: UserInfo,
  subject: UserInfo,
  reconcilerResult: ReconcilerResult,
  witnessingContent: WitnessingContent,
  dbReconcilerResult?: any
): Promise<{
  suggestedContent: string;
  reason: string;
} | null> {
  logger.info('Generating share suggestion', { subjectId: subject.id, guesserId: guesser.id });

  // Generate turnId upfront so COST and RECONCILER logs group together
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

  if (!response) {
    logger.warn('AI failed to generate share suggestion');
    // Return null to signal failure - let caller handle the error state
    return null;
  }
  response.suggestedContent = cleanVisibleAIText(response.suggestedContent);
  response.reason = cleanVisibleAIText(response.reason);
  logger.info('Share suggestion generated', { contentLength: response.suggestedContent.length, reasonLength: response.reason.length });

  // Use provided DB record or fall back to retry loop
  const dbResult = dbReconcilerResult || await findReconcilerResultWithRetry(sessionId, guesser.id, subject.id);

  if (dbResult) {
    logger.debug('Updating DB result and creating share offer', { resultId: dbResult.id });
    await prisma.reconcilerResult.update({
      where: { id: dbResult.id },
      data: {
        suggestedShareContent: response.suggestedContent,
        suggestedShareReason: response.reason,
      },
    });

    // Create share offer record
    await prisma.reconcilerShareOffer.upsert({
      where: { resultId: dbResult.id },
      create: {
        resultId: dbResult.id,
        userId: subject.id,
        status: 'PENDING',
        suggestedContent: response.suggestedContent,
        suggestedReason: response.reason,
      },
      update: {
        status: 'PENDING',
        suggestedContent: response.suggestedContent,
        suggestedReason: response.reason,
      },
    });

    // Note: We don't create a SHARE_SUGGESTION message in chat.
    // The suggestion is stored in reconcilerShareOffer and displayed via the drawer only.
    logger.debug('Share suggestion stored (drawer only)', { subjectId: subject.id });
  } else {
    logger.error('CRITICAL: Could not find reconcilerResult, share suggestion will not be displayed', { guesserId: guesser.id, subjectId: subject.id, sessionId });
  }

  return response;
}

/**
 * Refine a share suggestion based on user feedback.
 * This regenerates the suggestion using AI, incorporating the user's refinement request.
 */
async function refineShareSuggestion(
  originalContent: string,
  refinementRequest: string,
  guesserName: string,
  subjectName: string,
  gapContext: {
    severity: string;
    summary: string;
    missedFeelings: string[];
    mostImportantGap: string | null;
  },
  sessionId: string
): Promise<string | null> {
  logger.info('Refining share suggestion', { sessionId });

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

  logger.debug('Refined suggestion generated', { contentLength: response.refinedContent.length });
  return response.refinedContent;
}

// ============================================================================
// Get Share Suggestion for User
// ============================================================================

/**
 * Get share suggestion for a user (called when they need to respond).
 */
export async function getShareSuggestionForUser(
  sessionId: string,
  userId: string
): Promise<{
  hasSuggestion: boolean;
  suggestion: {
    guesserName: string;
    suggestedContent: string;
    reason: string;
    canRefine: boolean;
  } | null;
}> {
  logger.debug('getShareSuggestionForUser called', { userId, sessionId });

  // Find share offer for this user in PENDING status
  const shareOffer = await prisma.reconcilerShareOffer.findFirst({
    where: {
      userId,
      status: 'PENDING',
      result: { sessionId },
    },
    include: {
      result: true,
    },
  });

  if (!shareOffer || !shareOffer.suggestedContent) {
    logger.debug('No PENDING share offer found', { userId });
    return { hasSuggestion: false, suggestion: null };
  }

  logger.info('Found PENDING share offer, marking as OFFERED', { shareOfferId: shareOffer.id });

  // Mark as OFFERED now that it's being viewed
  await prisma.reconcilerShareOffer.update({
    where: { id: shareOffer.id },
    data: { status: 'OFFERED' },
  });

  return {
    hasSuggestion: true,
    suggestion: {
      guesserName: shareOffer.result.guesserName,
      suggestedContent: shareOffer.suggestedContent,
      reason: shareOffer.suggestedReason || 'This would help them understand you better.',
      canRefine: true,
    },
  };
}

// ============================================================================
// Respond to Share Suggestion
// ============================================================================

/**
 * Respond to a share suggestion (new flow with accept/refine/decline).
 */
export async function respondToShareSuggestion(
  sessionId: string,
  userId: string,
  response: {
    action: 'accept' | 'decline' | 'refine';
    refinedContent?: string;
  }
): Promise<{
  status: 'shared' | 'declined';
  sharedContent: string | null;
  guesserUpdated: boolean;
}> {
  logger.info('respondToShareSuggestion called', { userId, action: response.action });

  // Get the share offer - allow both OFFERED and PENDING status to handle race conditions
  // where the user responds before the GET endpoint marked it as OFFERED
  const shareOffer = await prisma.reconcilerShareOffer.findFirst({
    where: {
      userId,
      status: { in: ['OFFERED', 'PENDING'] },
      result: { sessionId },
    },
    include: {
      result: true,
    },
  });

  if (!shareOffer) {
    const processedOffer = await prisma.reconcilerShareOffer.findFirst({
      where: {
        userId,
        result: { sessionId },
        status: { in: ['ACCEPTED', 'DECLINED'] },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (processedOffer?.status === 'ACCEPTED' && response.action !== 'decline') {
      logger.info('Share offer already accepted; returning idempotent response', {
        userId,
        sessionId,
      });
      return {
        status: 'shared',
        sharedContent: processedOffer.sharedContent,
        guesserUpdated: false,
      };
    }

    if (processedOffer?.status === 'DECLINED' && response.action === 'decline') {
      logger.info('Share offer already declined; returning idempotent response', {
        userId,
        sessionId,
      });
      return {
        status: 'declined',
        sharedContent: null,
        guesserUpdated: false,
      };
    }

    logger.warn('No OFFERED/PENDING share offer found', { userId, sessionId });
    throw new Error('No pending share offer found');
  }

  // If status was PENDING (user responded before fetching), mark as OFFERED first for proper tracking
  if (shareOffer.status === 'PENDING') {
    logger.debug('Share offer was PENDING, marking as OFFERED before processing');
    await prisma.reconcilerShareOffer.update({
      where: { id: shareOffer.id },
      data: { status: 'OFFERED' },
    });
  }

  if (response.action === 'decline') {
    logger.info('User declined share offer, marking guesser empathy as READY', { userId });

    // Wrap decline DB writes in a transaction for consistency
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Idempotency guard: only update if still in OFFERED/PENDING state
      const updated = await tx.reconcilerShareOffer.updateMany({
        where: {
          id: shareOffer.id,
          status: { in: ['OFFERED', 'PENDING'] },
        },
        data: {
          status: 'DECLINED',
          declinedAt: new Date(),
        },
      });
      if (updated.count === 0) {
        throw new Error('Share offer already processed');
      }

      // Validate and mark guesser's empathy as READY (will reveal when both directions are ready)
      const attemptForDecline = await tx.empathyAttempt.findFirst({
        where: { sessionId, sourceUserId: shareOffer.result.guesserId },
      });
      const currentStatus = attemptForDecline?.status as EmpathyStatus | undefined;
      if (currentStatus && canTransition(currentStatus, 'DECLINE_SHARING')) {
        transition(currentStatus, 'DECLINE_SHARING');
        await tx.empathyAttempt.updateMany({
          where: { sessionId, sourceUserId: shareOffer.result.guesserId },
          data: {
            status: 'READY',
            statusVersion: { increment: 1 },
          },
        });
      } else if (currentStatus === EmpathyStatus.VALIDATED) {
        logger.info('Share offer declined after empathy validation; leaving terminal status unchanged', {
          sessionId,
          guesserId: shareOffer.result.guesserId,
        });
      } else if (currentStatus) {
        transition(currentStatus, 'DECLINE_SHARING');
      }

      // Delete the SHARE_SUGGESTION message now that user has responded
      await tx.message.deleteMany({
        where: {
          sessionId,
          forUserId: userId,
          role: MessageRole.SHARE_SUGGESTION,
        },
      });
    });

    logger.info('Declined share offer committed', { userId });

    // Check if both directions are now READY and reveal both if so (outside transaction)
    await checkAndRevealBothIfReady(sessionId);

    return {
      status: 'declined',
      sharedContent: null,
      guesserUpdated: true,
    };
  }

  // User accepted or refined — do AI calls first (outside transaction)
  let sharedContent: string;

  if (response.action === 'refine' && response.refinedContent) {
    // Call AI to regenerate the suggestion based on user's feedback
    const refinedContent = await refineShareSuggestion(
      shareOffer.suggestedContent || '',
      response.refinedContent,
      shareOffer.result.guesserName,
      shareOffer.result.subjectName,
      {
        severity: shareOffer.result.gapSeverity,
        summary: shareOffer.result.gapSummary,
        missedFeelings: shareOffer.result.missedFeelings,
        mostImportantGap: shareOffer.result.mostImportantGap,
      },
      sessionId
    );

    if (!refinedContent) {
      logger.warn('AI failed to refine suggestion, falling back to original');
      sharedContent = shareOffer.suggestedContent || '';
    } else {
      sharedContent = refinedContent;
    }
  } else {
    sharedContent = shareOffer.suggestedContent || '';
  }
  sharedContent = cleanVisibleAIText(sharedContent);

  // Error if suggestedContent was somehow empty - this is a data integrity issue
  if (!sharedContent.trim()) {
    logger.error('suggestedContent was empty, cannot proceed', { shareOfferId: shareOffer.id });
    throw new Error('Share suggestion content is empty - cannot share');
  }

  logger.info('User responded to share offer', { userId, action: response.action, contentLength: sharedContent.length });

  const subjectName = shareOffer.result.subjectName;
  const guesserName = shareOffer.result.guesserName;
  const [subjectSeesGuesserName, guesserSeesSubjectName] = await Promise.all([
    getPartnerDisplayNameForViewer(sessionId, userId, shareOffer.result.guesserId, guesserName),
    getPartnerDisplayNameForViewer(sessionId, shareOffer.result.guesserId, userId, subjectName),
  ]);

  // Check if this is a subsequent share (subject has already shared context before)
  const priorShareCount = await prisma.message.count({
    where: {
      sessionId,
      senderId: userId,
      role: 'SHARED_CONTEXT',
    },
  });

  // Generate AI messages outside transaction (AI calls can be slow)
  // For subsequent shares, use a short static ack to avoid repetitive messages
  const subjectAckPromise = priorShareCount > 0
    ? Promise.resolve(`Thanks for sharing that additional context with ${subjectSeesGuesserName}.`)
    : generatePostShareContinuation(sessionId, userId, subjectName, subjectSeesGuesserName, sharedContent);

  const [subjectAckMessage, reflectionMessage] = await Promise.all([
    subjectAckPromise,
    generateContextReceivedReflection(sessionId, guesserName, guesserSeesSubjectName),
  ]);

  // Get subject's current stage for the message
  const subjectProgress = await prisma.stageProgress.findFirst({
    where: { sessionId, userId },
    orderBy: { stage: 'desc' },
  });
  const subjectCurrentStage = subjectProgress?.stage ?? 2;

  // Wrap all DB writes in a transaction for atomicity
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const now = new Date();

    // Idempotency guard: only update if still in OFFERED/PENDING state
    const updated = await tx.reconcilerShareOffer.updateMany({
      where: {
        id: shareOffer.id,
        status: { in: ['OFFERED', 'PENDING'] },
      },
      data: {
        status: 'ACCEPTED',
        refinedContent: response.action === 'refine' ? response.refinedContent : null,
        sharedContent,
        sharedAt: now,
        deliveryStatus: 'DELIVERED',
        deliveredAt: now,
      },
    });
    if (updated.count === 0) {
      throw new Error('Share offer already processed');
    }

    // Delete the SHARE_SUGGESTION message
    await tx.message.deleteMany({
      where: {
        sessionId,
        forUserId: userId,
        role: MessageRole.SHARE_SUGGESTION,
      },
    });

    // Validate and update guesser's empathy attempt to REFINING
    const attemptForRefine = await tx.empathyAttempt.findFirst({
      where: { sessionId, sourceUserId: shareOffer.result.guesserId },
    });
    const currentStatus = attemptForRefine?.status as EmpathyStatus | undefined;
    const shouldMoveToRefining = currentStatus && canTransition(currentStatus, 'CONTEXT_SHARED');
    if (shouldMoveToRefining) {
      transition(currentStatus, 'CONTEXT_SHARED');
      await tx.empathyAttempt.updateMany({
        where: { sessionId, sourceUserId: shareOffer.result.guesserId },
        data: { status: 'REFINING', statusVersion: { increment: 1 } },
      });
    } else if (currentStatus === EmpathyStatus.VALIDATED) {
      logger.info('Share offer accepted after empathy validation; delivering context without changing terminal status', {
        sessionId,
        guesserId: shareOffer.result.guesserId,
      });
    } else if (currentStatus) {
      transition(currentStatus, 'CONTEXT_SHARED');
    }

    // Create messages with guaranteed ordering (100ms apart)
    const baseTime = now.getTime();
    const sharedContextTimestamp = new Date(baseTime);
    const reflectionTimestamp = new Date(baseTime + 100);
    const subjectAckTimestamp = new Date(baseTime + 200);

    // SHARED_CONTEXT message (the actual content shared by subject)
    // Renders as a labeled card ("NEW CONTEXT FROM {name}") in the guesser's chat
    await tx.message.create({
      data: {
        sessionId,
        senderId: userId,
        forUserId: shareOffer.result.guesserId,
        role: MessageRole.SHARED_CONTEXT,
        content: sharedContent,
        stage: 2,
        timestamp: sharedContextTimestamp,
      },
    });

    // Reflection prompt for guesser (Sonnet-generated, invites processing)
    await tx.message.create({
      data: {
        sessionId,
        senderId: null,
        forUserId: shareOffer.result.guesserId,
        role: 'AI',
        content: reflectionMessage,
        stage: 2,
        timestamp: reflectionTimestamp,
      },
    });

    // Subject acknowledgment message
    await tx.message.create({
      data: {
        sessionId,
        senderId: null,
        forUserId: userId,
        role: 'AI',
        content: subjectAckMessage,
        stage: subjectCurrentStage,
        timestamp: subjectAckTimestamp,
      },
    });
  });

  logger.info('Share accepted and committed', { userId });

  return {
    status: 'shared',
    sharedContent,
    guesserUpdated: true,
  };
}

// ============================================================================
// Get Shared Context for Guesser
// ============================================================================

/**
 * Get shared context for a guesser (if subject shared something).
 */
export async function getSharedContextForGuesser(
  sessionId: string,
  guesserId: string
): Promise<{
  hasSharedContext: boolean;
  content: string | null;
  sharedAt: string | null;
}> {
  // During REFINING, the most recent targeted message is the actionable context
  // for the guesser. Validation feedback intentionally supersedes older shared
  // context because it reflects the subject's latest response to the revealed
  // empathy attempt.
  const contextMessage = await prisma.message.findFirst({
    where: {
      sessionId,
      forUserId: guesserId,
      role: { in: [MessageRole.SHARED_CONTEXT, MessageRole.VALIDATION_FEEDBACK] },
    },
    orderBy: { timestamp: 'desc' },
  });

  if (contextMessage) {
    return {
      hasSharedContext: true,
      content: contextMessage.content,
      sharedAt: contextMessage.timestamp.toISOString(),
    };
  }

  const shareOffer = await prisma.reconcilerShareOffer.findFirst({
    where: {
      result: {
        sessionId,
        guesserId,
      },
      status: 'ACCEPTED',
    },
  });

  if (!shareOffer || !shareOffer.sharedContent) {
    return { hasSharedContext: false, content: null, sharedAt: null };
  }

  return {
    hasSharedContext: true,
    content: shareOffer.sharedContent,
    sharedAt: shareOffer.sharedAt?.toISOString() || null,
  };
}

// ============================================================================
// Get Shared Content Delivery Status
// ============================================================================

/**
 * Get the delivery status of shared content for the subject (person who shared).
 * Uses the same mechanism as message read tracking (lastViewedAt on UserVessel).
 *
 * Returns the delivery status:
 * - 'pending': Share not yet accepted (no SHARED_CONTEXT message created)
 * - 'delivered': Message created but guesser hasn't viewed since then
 * - 'seen': Guesser has viewed the session after the message was created
 */
export async function getSharedContentDeliveryStatus(
  sessionId: string,
  subjectId: string
): Promise<{
  hasSharedContent: boolean;
  deliveryStatus: 'pending' | 'delivered' | 'seen' | null;
  sharedAt: string | null;
  sharedContent: string | null;
}> {
  // Find the share offer to get the guesser ID
  const shareOffer = await prisma.reconcilerShareOffer.findFirst({
    where: {
      userId: subjectId,
      result: { sessionId },
      status: 'ACCEPTED',
    },
    include: {
      result: true,
    },
  });

  if (!shareOffer || !shareOffer.sharedContent || !shareOffer.sharedAt) {
    return { hasSharedContent: false, deliveryStatus: null, sharedAt: null, sharedContent: null };
  }

  const guesserId = shareOffer.result.guesserId;
  const sharedAt = shareOffer.sharedAt;

  // Check if the guesser has viewed the Share/Partner tab after the content was shared
  // We use lastViewedShareTabAt (not lastViewedAt) so content is only "seen" when
  // the user actually views the Partner tab, not just the AI chat
  const guesserVessel = await prisma.userVessel.findUnique({
    where: {
      userId_sessionId: {
        userId: guesserId,
        sessionId,
      },
    },
    select: {
      lastViewedShareTabAt: true,
    },
  });

  let deliveryStatus: 'pending' | 'delivered' | 'seen' = 'delivered';

  if (guesserVessel?.lastViewedShareTabAt && guesserVessel.lastViewedShareTabAt >= sharedAt) {
    // Guesser has viewed the Share tab after the content was shared
    deliveryStatus = 'seen';
  }

  return {
    hasSharedContent: true,
    deliveryStatus,
    sharedAt: sharedAt.toISOString(),
    sharedContent: shareOffer.sharedContent,
  };
}

// ============================================================================
// Generate Share Offer
// ============================================================================

/**
 * Generate a share offer for a user based on reconciler results.
 */
export async function generateShareOffer(
  sessionId: string,
  subjectId: string
): Promise<{
  offerMessage: string;
  suggestedContent: string;
  suggestedReason: string;
  gapDescription: string;
} | null> {
  // Get the reconciler result for this direction
  const result = await prisma.reconcilerResult.findFirst({
    where: {
      sessionId,
      subjectId,
      supersededAt: null,
    },
    include: {
      shareOffer: true,
    },
  });

  if (!result) {
    logger.warn('No reconciler result found for subject', { subjectId });
    return null;
  }

  // If share offer already exists and was processed, return null
  if (result.shareOffer && result.shareOffer.status !== 'NOT_OFFERED') {
    return null;
  }

  // If the subject has already shared context in this direction, don't synthesize
  // another suggestion. The asymmetric reconciler shortcuts to READY in this case
  // (state.ts hasContextAlreadyBeenShared branch), but the GET /share-offer
  // fallback would otherwise keep re-drafting near-identical share suggestions
  // every time the guesser refines, making the UX feel redundant and stuck.
  const contextAlreadyShared = await hasContextAlreadyBeenShared(
    sessionId,
    result.guesserId,
    subjectId
  );
  if (contextAlreadyShared) {
    logger.info('generateShareOffer: context already shared, skipping redundant suggestion', {
      sessionId,
      guesserId: result.guesserId,
      subjectId,
    });
    return null;
  }

  // Get the subject's witnessing content for crafting the suggestion
  const witnessingContent = await getWitnessingContent(sessionId, subjectId);

  // Get partner name
  const guesser = await prisma.user.findUnique({
    where: { id: result.guesserId },
    select: { firstName: true, name: true },
  });
  const partnerName = guesser?.firstName || guesser?.name || 'your partner';

  const subject = await prisma.user.findUnique({
    where: { id: subjectId },
    select: { firstName: true, name: true },
  });
  const userName = subject?.firstName || subject?.name || 'you';

  // Generate the offer message and AI-crafted share suggestion in parallel
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
    // Generate an AI-crafted, feelings-focused suggestion (not direct quotes)
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

  logger.debug('Generated feelings-focused suggestion', { contentLength: suggestedContent.length });

  // Create or update share offer record with the crafted suggestion
  await prisma.reconcilerShareOffer.upsert({
    where: { resultId: result.id },
    create: {
      resultId: result.id,
      userId: subjectId,
      status: 'OFFERED',
      offerMessage,
      suggestedContent,
      suggestedReason,
    },
    update: {
      status: 'OFFERED',
      offerMessage,
      suggestedContent,
      suggestedReason,
    },
  });

  return {
    offerMessage,
    suggestedContent,
    suggestedReason,
    gapDescription: result.mostImportantGap || result.gapSummary,
  };
}
