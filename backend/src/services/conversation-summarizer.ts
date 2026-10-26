/**
 * Conversation Summarizer Service
 *
 * Generates rolling summaries of long conversations to maintain context
 * without exceeding token limits. Uses fire-and-forget pattern for non-blocking
 * summarization.
 *
 * Strategy:
 * - When a conversation exceeds a threshold (e.g., 30 messages), summarize older portions
 * - Store summaries in the session/vessel for retrieval
 * - New prompts get: [Summary of older messages] + [Recent full messages] + [Retrieved context]
 */

import { logger } from '../lib/logger';
import { getJobPrisma, prisma } from '../lib/prisma';
import { getPartnerParticipant, resolveParticipant } from './participant-resolver';
import { loadCurrentStages } from './stage-shim';
import { getHaikuJson, BrainActivityCallType } from '../lib/bedrock';
import { estimateTokens } from '../utils/token-budget';

// ============================================================================
// Types
// ============================================================================

export interface ConversationSummary {
  /** Summary text covering older messages */
  text: string;

  /** Number of messages summarized */
  messageCount: number;

  /** Timestamp of the oldest message included */
  oldestMessageAt: Date;

  /** Timestamp of the newest message included */
  newestMessageAt: Date;

  /** Token count of the summary */
  tokenCount: number;

  /** When this summary was generated */
  generatedAt: Date;
}

export interface SummarizationResult {
  summary: string;
  keyThemes: string[];
  emotionalJourney: string;
  unresolvedTopics: string[];
  agreedFacts?: string[];
  userNeeds?: string[];
  partnerNeeds?: string[];
  openQuestions?: string[];
  agreements?: string[];
  /**
   * A single-sentence "cliffhanger" describing where the user's emotional
   * tension was left hanging — used by the long-idle resumption prompt to
   * anchor the re-orientation message. Null when the user just crossed a
   * stage gate / reached a milestone (nothing is unresolved) or when the
   * partner hasn't joined yet (no two-sided dynamic to leave unresolved).
   */
  lastUnresolvedThread?: string | null;
}

/**
 * Structural hints the summarizer needs so it doesn't hallucinate unresolved
 * drama when there genuinely is none. Passed in by callers who know the
 * session state (stage just advanced? partner hasn't joined?).
 */
export interface SummarizationHints {
  /**
   * True when the user just crossed a stage gate (e.g. both confirmed "I feel
   * heard" → advanced to Stage 2). In that case the `lastUnresolvedThread`
   * MUST be null — tension resolved, not a cliffhanger.
   */
  stageJustAdvanced?: boolean;
  /**
   * Where the partner is in their own flow. `'not_joined'` means the user is
   * essentially soloing; the summarizer must frame the cliffhanger as
   * internal processing without anticipating a partner response.
   */
  partnerStatus?: 'not_joined' | 'in_progress' | 'completed';
}

type SummaryMessageRecord = {
  role: string;
  content: string;
  timestamp: Date;
};

type RelationshipMemberWithUser = {
  userId: string;
  nickname?: string | null;
  user: {
    name: string | null;
    firstName: string | null;
  };
};

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for when to trigger summarization
 */
export const SUMMARIZATION_CONFIG = {
  /** Minimum messages before summarization kicks in */
  minMessagesForSummary: 25,

  /** How many recent messages to keep in full (not summarized) */
  recentMessagesToKeep: 15,

  /** Target token count for summaries */
  targetSummaryTokens: 500,

  /** How often to re-summarize (every N new messages after initial summary) */
  resummaryInterval: 25,

  /** Summarize early if total tokens exceed this threshold */
  tokenThreshold: 6_000,
};

// ============================================================================
// Summary Generation
// ============================================================================

/**
 * Generate a summary of conversation messages using Haiku.
 * Designed for quick execution with structured output.
 */
async function generateConversationSummary(
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>,
  userName: string,
  partnerName: string,
  stage: number,
  sessionId: string,
  turnId: string,
  hints: SummarizationHints = {}
): Promise<SummarizationResult | null> {
  if (messages.length === 0) {
    return null;
  }

  // Build conversation text
  const conversationText = messages
    .map((m) => `${m.role === 'user' ? userName : 'MWF'}: ${m.content}`)
    .join('\n\n');

  const stageContext = getStageContext(stage);

  // Emit structural context so the model doesn't invent phantom cliffhangers
  // when the session is actually at a clean milestone / still one-sided.
  const structuralHints = [
    hints.stageJustAdvanced
      ? 'STRUCTURAL CONTEXT: The user just crossed a stage gate (milestone reached). `lastUnresolvedThread` MUST be null.'
      : '',
    hints.partnerStatus === 'not_joined'
      ? `STRUCTURAL CONTEXT: ${partnerName} has not yet joined this session. Frame cliffhangers and unresolved threads strictly in terms of ${userName}'s own internal processing — do NOT anticipate a direct partner response.`
      : '',
    hints.partnerStatus === 'completed'
      ? `STRUCTURAL CONTEXT: ${partnerName} has completed their side of this stage. Unresolved threads should reflect what the user alone still needs to work through.`
      : '',
  ].filter(Boolean).join('\n');

  const systemPrompt = `You are summarizing a conflict resolution conversation to preserve context for an AI assistant.

STAGE CONTEXT: ${stageContext}
${structuralHints ? `\n${structuralHints}\n` : ''}
OUTPUT FORMAT (JSON):
{
  "summary": "2-3 paragraph narrative summary capturing the emotional journey and key points discussed",
  "keyThemes": ["theme1", "theme2"],
  "emotionalJourney": "One sentence describing how the user's emotional state evolved",
  "unresolvedTopics": ["topic1", "topic2"],
  "agreedFacts": ["facts both parties agree on (if any)"],
  "userNeeds": ["needs the user stated or implied"],
  "partnerNeeds": ["needs the partner stated or implied"],
  "openQuestions": ["open questions to revisit"],
  "agreements": ["explicit agreements or experiments (if any)"],
  "lastUnresolvedThread": "One sentence describing where the user's emotional tension was left hanging — this is the 'cliffhanger' the AI will use to re-orient the user after a long gap. MUST be null when the user just reached a milestone (stage gate crossed, mutual agreement), or when you'd have to invent partner dynamics to satisfy it."
}

GUIDELINES:
- Capture emotional tone and key facts.
- Keep language compact and concrete.
- Do not invent consent state or partner data unless it was explicitly shared.
- Keep the summary under 500 words.
- lastUnresolvedThread: prefer null over fabrication. If you'd have to stretch to name a cliffhanger, it's null.`;

  const userPrompt = `Summarize this conversation between ${userName} and Meet Without Fear:

${conversationText}`;

  const result = await getHaikuJson<SummarizationResult>({
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 1500,
    sessionId,
    operation: 'conversation-summary',
    turnId,
    callType: BrainActivityCallType.SUMMARIZATION,
  });

  return result;
}

function getStageContext(stage: number): string {
  switch (stage) {
    case 0:
      return 'Invitation crafting - user is preparing to invite their partner';
    case 1:
      return 'Witnessing - user is sharing their experience and being heard';
    case 2:
      return 'Perspective Stretch - user is trying to understand their partner\'s viewpoint';
    case 3:
      return 'What Matters - user is identifying underlying needs';
    case 4:
      return 'Strategic Repair - user is designing experiments and agreements';
    default:
      return 'Ongoing conversation';
  }
}

// ============================================================================
// Session Summarization
// ============================================================================

/**
 * Check if a session needs summarization based on message count.
 */
export function needsSummarization(
  messageCount: number,
  existingSummary?: string,
  totalTokens?: number
): boolean {
  if (messageCount < SUMMARIZATION_CONFIG.minMessagesForSummary && !totalTokens) {
    return false;
  }

  // If no summary exists yet, we need one
  if (!existingSummary) {
    return messageCount >= SUMMARIZATION_CONFIG.minMessagesForSummary
      || (totalTokens ?? 0) >= SUMMARIZATION_CONFIG.tokenThreshold;
  }

  // Check if we've accumulated enough new messages since last summary
  // This would require tracking when the summary was made
  // For simplicity, we re-summarize every resummaryInterval messages beyond the threshold
  const messagesOverThreshold = Math.max(
    messageCount - SUMMARIZATION_CONFIG.minMessagesForSummary,
    0
  );
  const shouldResummarizeByCount = messagesOverThreshold % SUMMARIZATION_CONFIG.resummaryInterval === 0;
  const shouldResummarizeByTokens = (totalTokens ?? 0) >= SUMMARIZATION_CONFIG.tokenThreshold;
  return shouldResummarizeByCount || shouldResummarizeByTokens;
}

/**
 * Summarize older messages in a session and update the vessel.
 * Call this as fire-and-forget: updateSessionSummary(sessionId, userId, turnId).catch(e => logger.warn(...))
 *
 * @param turnId - The turn that triggered this summarization (for cost attribution)
 */
export async function updateSessionSummary(
  sessionId: string,
  userId: string,
  turnId: string,
  hints: SummarizationHints = {}
): Promise<ConversationSummary | null> {
  try {
    // Target shape (TS-9): the participant's MAIN conversation is the audience —
    // their own turns and the AI's replies to them (delivered items excluded,
    // as before: they were never part of the summarised dialogue).
    const participant = await resolveParticipant(sessionId, userId);
    if (!participant?.mainConversationId) return null;

    const messages = (await prisma.message.findMany({
      where: {
        conversationId: participant.mainConversationId,
        OR: [{ senderParticipantId: participant.id }, { role: 'AI' }],
      },
      orderBy: { createdAt: 'asc' },
      select: { role: true, kind: true, content: true, createdAt: true },
    })).map((m): SummaryMessageRecord => ({ role: m.kind === 'CHAT' ? m.role : m.kind, content: m.content, timestamp: m.createdAt }));
    const messageCount = messages.length;

    // Check if we actually need to summarize
    const existing = await readSummaryDoc(participant.id);
    const totalTokens = messages.reduce((sum: number, msg: SummaryMessageRecord) => sum + estimateTokens(msg.content), 0);
    if (!needsSummarization(messageCount, existing ? JSON.stringify(existing) : undefined, totalTokens)) {
      return null;
    }

    // Names: the participant's own, and the co-participant's.
    const partner = await getPartnerParticipant(participant.id);
    const userName = participant.displayName || 'User';
    const partnerName = partner?.displayName || 'Partner';

    // Get current stage (stage shim)
    const stage = (await loadCurrentStages([participant.id])).get(participant.id)?.stage ?? 1;

    // Determine which messages to summarize (older ones, keeping recent in full)
    const messagesToSummarize = messages.slice(0, -SUMMARIZATION_CONFIG.recentMessagesToKeep);

    if (messagesToSummarize.length < 10) {
      // Not enough old messages to summarize
      return null;
    }

    // Generate summary
    const summaryResult = await generateConversationSummary(
      messagesToSummarize.map((m: SummaryMessageRecord) => ({
        role: m.role === 'USER' ? 'user' as const : 'assistant' as const,
        content: m.content,
        timestamp: m.timestamp,
      })),
      userName,
      partnerName,
      stage,
      sessionId,
      turnId,
      hints
    );

    if (!summaryResult) {
      return null;
    }

    // Build the stored summary object
    const summary: ConversationSummary = {
      text: summaryResult.summary,
      messageCount: messagesToSummarize.length,
      oldestMessageAt: messagesToSummarize[0].timestamp,
      newestMessageAt: messagesToSummarize[messagesToSummarize.length - 1].timestamp,
      tokenCount: estimateTokens(summaryResult.summary),
      generatedAt: new Date(),
    };

    // Structural guardrail: if the caller told us the stage just advanced,
    // force lastUnresolvedThread to null regardless of what the model emitted.
    // This is defense-in-depth against prompt-following lapses.
    const lastUnresolvedThread =
      hints.stageJustAdvanced
        ? null
        : summaryResult.lastUnresolvedThread ?? null;

    // Stored as the participant's ai_memory SUMMARY document (spec §1.1:
    // `text, messageCount, generatedAt` required), written by the job
    // connection — background classifiers write ai_memory as mwf_job.
    const doc = JSON.parse(JSON.stringify({
      ...summary,
      keyThemes: summaryResult.keyThemes,
      emotionalJourney: summaryResult.emotionalJourney,
      unresolvedTopics: summaryResult.unresolvedTopics,
      agreedFacts: summaryResult.agreedFacts ?? [],
      userNeeds: summaryResult.userNeeds ?? [],
      partnerNeeds: summaryResult.partnerNeeds ?? [],
      openQuestions: summaryResult.openQuestions ?? [],
      agreements: summaryResult.agreements ?? [],
      lastUnresolvedThread,
    }));
    await getJobPrisma().aiMemory.upsert({
      where: { participantId_kind: { participantId: participant.id, kind: 'SUMMARY' } },
      create: { participantId: participant.id, kind: 'SUMMARY', doc },
      update: { doc },
    });

    logger.info(
      `[ConversationSummarizer] Summarized ${messagesToSummarize.length} messages for session ${sessionId}`
    );

    return summary;
  } catch (error) {
    logger.error('[ConversationSummarizer] Failed to summarize session:', error);
    return null;
  }
}

/** The participant's stored SUMMARY document (ai_memory), or null. */
async function readSummaryDoc(participantId: string): Promise<Record<string, unknown> | null> {
  const row = await prisma.aiMemory.findUnique({
    where: { participantId_kind: { participantId, kind: 'SUMMARY' } },
    select: { doc: true },
  });
  const doc = row?.doc;
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
}

/**
 * Threshold beyond which the Slack flow treats a user as "long-idle" and may
 * trigger a synchronous summary refresh before assembling context for their
 * return turn. See `maybeRefreshSummaryForResumption`.
 */
export const LONG_IDLE_RESUMPTION_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Force a synchronous summary refresh when a user is returning after a long
 * idle and their stored summary pre-dates their own last message. This gives
 * the re-orientation prompt a fresh `lastUnresolvedThread` to anchor on.
 *
 * - No-op when the user hasn't been idle >24h (returns `'not_idle'`).
 * - No-op when the stored summary is already newer than the user's last own
 *   message — there's nothing new to summarize (returns `'summary_fresh'`).
 * - Otherwise awaits `updateSessionSummary` and returns `'refreshed'`.
 *
 * Callers (like the Slack turn runner) should fire this BEFORE building the
 * context bundle so the bundle's `sessionSummary.lastUnresolvedThread`
 * reflects the fresh state on the critical first-return turn.
 */
export async function maybeRefreshSummaryForResumption(params: {
  sessionId: string;
  userId: string;
  turnId: string;
  /**
   * When this user last spoke (USER-role message with senderId=userId).
   * Computed by the caller BEFORE persisting the current incoming message,
   * so this represents the previous turn's timestamp, not this one's.
   */
  lastUserTurnAt: Date | null;
  hints?: SummarizationHints;
  now?: Date;
}): Promise<'refreshed' | 'summary_fresh' | 'not_idle' | 'no_user_activity'> {
  const { sessionId, userId, turnId, lastUserTurnAt, hints, now = new Date() } = params;

  if (!lastUserTurnAt) return 'no_user_activity';

  const idleMs = now.getTime() - lastUserTurnAt.getTime();
  if (idleMs < LONG_IDLE_RESUMPTION_THRESHOLD_MS) return 'not_idle';

  // Cheap guard: look up existing summary timestamp. Skip the Haiku call if
  // it's already newer than the user's last message — nothing has changed.
  const participant = await resolveParticipant(sessionId, userId);
  const existing = participant ? await readSummaryDoc(participant.id) : null;
  if (existing) {
    const generatedAt = typeof existing.generatedAt === 'string' ? new Date(existing.generatedAt) : null;
    if (generatedAt && !Number.isNaN(generatedAt.getTime()) && generatedAt.getTime() >= lastUserTurnAt.getTime()) {
      return 'summary_fresh';
    }
  }

  await updateSessionSummary(sessionId, userId, turnId, hints);
  return 'refreshed';
}

// ============================================================================
// Summary Retrieval
// ============================================================================

/**
 * Get the conversation summary for a session vessel, if one exists.
 */
export async function getSessionSummary(
  sessionId: string,
  userId: string
): Promise<{
  summary: ConversationSummary;
  keyThemes: string[];
  emotionalJourney: string;
  unresolvedTopics: string[];
  agreedFacts: string[];
  userNeeds: string[];
  partnerNeeds: string[];
  openQuestions: string[];
  agreements: string[];
  lastUnresolvedThread: string | null;
} | null> {
  const participant = await resolveParticipant(sessionId, userId);
  const doc = participant ? await readSummaryDoc(participant.id) : null;
  if (!doc) {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = doc as any;
    return {
      summary: {
        text: parsed.text,
        messageCount: parsed.messageCount,
        oldestMessageAt: new Date(parsed.oldestMessageAt),
        newestMessageAt: new Date(parsed.newestMessageAt),
        tokenCount: parsed.tokenCount,
        generatedAt: new Date(parsed.generatedAt),
      },
      keyThemes: parsed.keyThemes || [],
      emotionalJourney: parsed.emotionalJourney || '',
      unresolvedTopics: parsed.unresolvedTopics || [],
      agreedFacts: parsed.agreedFacts || [],
      userNeeds: parsed.userNeeds || [],
      partnerNeeds: parsed.partnerNeeds || [],
      openQuestions: parsed.openQuestions || [],
      agreements: parsed.agreements || [],
      lastUnresolvedThread: parsed.lastUnresolvedThread ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Format a conversation summary for prompt injection.
 */
export function formatSummaryForPrompt(
  summaryData: {
    summary: ConversationSummary;
    keyThemes: string[];
    emotionalJourney: string;
    unresolvedTopics: string[];
    agreedFacts?: string[];
    userNeeds?: string[];
    partnerNeeds?: string[];
    openQuestions?: string[];
    agreements?: string[];
  }
): string {
  const parts: string[] = [];

  parts.push('[ROLLING SUMMARY]');
  parts.push(summaryData.summary.text);

  if (summaryData.keyThemes?.length) {
    parts.push(`Key themes: ${summaryData.keyThemes.join(', ')}`);
  }

  if (summaryData.emotionalJourney) {
    parts.push(`Emotional journey: ${summaryData.emotionalJourney}`);
  }

  if (summaryData.agreedFacts?.length) {
    parts.push(`Agreed facts: ${summaryData.agreedFacts.join('; ')}`);
  }

  if (summaryData.userNeeds?.length || summaryData.partnerNeeds?.length) {
    const userNeeds = summaryData.userNeeds?.length ? summaryData.userNeeds.join('; ') : 'Not yet named';
    const partnerNeeds = summaryData.partnerNeeds?.length ? summaryData.partnerNeeds.join('; ') : 'Not yet named';
    parts.push(`Needs: User → ${userNeeds}. Partner → ${partnerNeeds}.`);
  }

  if (summaryData.agreements?.length) {
    parts.push(`Agreements/experiments: ${summaryData.agreements.join('; ')}`);
  }

  if (summaryData.openQuestions?.length || summaryData.unresolvedTopics?.length) {
    const openQuestions = summaryData.openQuestions?.length
      ? summaryData.openQuestions.join('; ')
      : summaryData.unresolvedTopics?.join('; ') ?? '';
    if (openQuestions) {
      parts.push(`Open questions: ${openQuestions}`);
    }
  }

  parts.push(`[Summary covers ${summaryData.summary.messageCount} earlier messages]`);

  return parts.join('\n');
}

// ============================================================================
// Inner Thoughts Session Summarization
// ============================================================================

/**
 * Configuration for Inner Thoughts summarization (same strategy as partner sessions).
 */
export const INNER_THOUGHTS_SUMMARIZATION_CONFIG = {
  /** Minimum messages before summarization kicks in */
  minMessagesForSummary: 20,

  /** How many recent messages to keep in full (not summarized) */
  recentMessagesToKeep: 12,

  /** Target token count for summaries */
  targetSummaryTokens: 500,

  /** How often to re-summarize (every N new messages after initial summary) */
  resummaryInterval: 15,
};

/**
 * Generate a summary for Inner Thoughts conversation using Haiku.
 */
async function generateInnerThoughtsSummary(
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>,
  userName: string,
  existingTheme: string | null | undefined,
  sessionId: string,
  turnId: string
): Promise<SummarizationResult | null> {
  if (messages.length === 0) {
    return null;
  }

  // Build conversation text
  const conversationText = messages
    .map((m) => `${m.role === 'user' ? userName : 'MWF'}: ${m.content}`)
    .join('\n\n');

  const themeContext = existingTheme
    ? `The session has been themed as "${existingTheme}".`
    : 'No theme has been identified yet.';

  const systemPrompt = `You are summarizing a private Inner Thoughts self-reflection conversation to preserve context for an AI assistant.

CONTEXT: This is a solo self-reflection session - there is no partner involved. ${themeContext}

OUTPUT FORMAT (JSON):
{
  "summary": "2-3 paragraph narrative summary capturing the emotional journey, key realizations, and main topics discussed",
  "keyThemes": ["theme1", "theme2", ...],
  "emotionalJourney": "One sentence describing how the user's emotional state evolved during this conversation",
  "unresolvedTopics": ["topic1", "topic2", ...]
}

GUIDELINES:
- Capture the emotional tone, not just facts
- Note any patterns or recurring concerns
- Identify what seems unresolved or needs follow-up
- Note any realizations or insights the user had
- Write the summary as if briefing a companion who will continue listening
- Keep the summary under 500 words
- This is private self-reflection - treat the content with appropriate care`;

  const userPrompt = `Summarize this Inner Thoughts conversation between ${userName} and Meet Without Fear:

${conversationText}`;

  const result = await getHaikuJson<SummarizationResult>({
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 1500,
    innerWorkSessionId: sessionId,
    operation: 'inner-thoughts-summary',
    turnId,
    callType: BrainActivityCallType.SUMMARIZATION,
  });
  return result;
}

/**
 * Check if an Inner Thoughts session needs summarization.
 */
export function innerThoughtsNeedsSummarization(
  messageCount: number,
  existingSummary?: string | null
): boolean {
  if (messageCount < INNER_THOUGHTS_SUMMARIZATION_CONFIG.minMessagesForSummary) {
    return false;
  }

  // If no summary exists yet, we need one
  if (!existingSummary) {
    return true;
  }

  // Check if we've accumulated enough new messages since last summary
  const messagesOverThreshold = messageCount - INNER_THOUGHTS_SUMMARIZATION_CONFIG.minMessagesForSummary;
  return messagesOverThreshold % INNER_THOUGHTS_SUMMARIZATION_CONFIG.resummaryInterval === 0;
}

/**
 * Summarize older messages in an Inner Thoughts session and store in the session.
 * Call this as fire-and-forget: updateInnerThoughtsSummary(sessionId, turnId).catch(e => logger.warn(...))
 *
 * @param turnId - The turn that triggered this summarization (for cost attribution)
 */
export async function updateInnerThoughtsSummary(
  sessionId: string,
  turnId: string
): Promise<ConversationSummary | null> {
  try {
    // Get session with messages
    const session = await prisma.innerWorkSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' },
        },
        user: {
          select: { name: true, firstName: true },
        },
      },
    });

    if (!session) {
      return null;
    }

    const messageCount = session.messages.length;

    // Check if we actually need to summarize
    const existingSummary = session.conversationSummary as string | null;
    if (!innerThoughtsNeedsSummarization(messageCount, existingSummary)) {
      return null;
    }

    // Get user name
    const userName = session.user.firstName || session.user.name || 'User';

    // Determine which messages to summarize (older ones, keeping recent in full)
    const messagesToSummarize = session.messages.slice(
      0,
      -INNER_THOUGHTS_SUMMARIZATION_CONFIG.recentMessagesToKeep
    );

    if (messagesToSummarize.length < 8) {
      // Not enough old messages to summarize
      return null;
    }

    // Generate summary
    const summaryResult = await generateInnerThoughtsSummary(
      messagesToSummarize.map((m: SummaryMessageRecord) => ({
        role: m.role === 'USER' ? 'user' as const : 'assistant' as const,
        content: m.content,
        timestamp: m.timestamp,
      })),
      userName,
      session.theme,
      sessionId,
      turnId
    );

    if (!summaryResult) {
      return null;
    }

    // Build the stored summary object
    const summary: ConversationSummary = {
      text: summaryResult.summary,
      messageCount: messagesToSummarize.length,
      oldestMessageAt: messagesToSummarize[0].timestamp,
      newestMessageAt: messagesToSummarize[messagesToSummarize.length - 1].timestamp,
      tokenCount: estimateTokens(summaryResult.summary),
      generatedAt: new Date(),
    };

    // Store in session
    await prisma.innerWorkSession.update({
      where: { id: sessionId },
      data: {
        conversationSummary: JSON.stringify({
          ...summary,
          keyThemes: summaryResult.keyThemes,
          emotionalJourney: summaryResult.emotionalJourney,
          unresolvedTopics: summaryResult.unresolvedTopics,
        }),
      },
    });

    logger.info(
      `[ConversationSummarizer] Summarized ${messagesToSummarize.length} Inner Thoughts messages for session ${sessionId}`
    );

    return summary;
  } catch (error) {
    logger.error('[ConversationSummarizer] Failed to summarize Inner Thoughts session:', error);
    return null;
  }
}

/**
 * Get the conversation summary for an Inner Thoughts session, if one exists.
 */
export async function getInnerThoughtsSummary(
  sessionId: string
): Promise<{
  summary: ConversationSummary;
  keyThemes: string[];
  emotionalJourney: string;
  unresolvedTopics: string[];
} | null> {
  const session = await prisma.innerWorkSession.findUnique({
    where: { id: sessionId },
    select: { conversationSummary: true },
  });

  if (!session?.conversationSummary) {
    return null;
  }

  try {
    const parsed = JSON.parse(session.conversationSummary as string);
    return {
      summary: {
        text: parsed.text,
        messageCount: parsed.messageCount,
        oldestMessageAt: new Date(parsed.oldestMessageAt),
        newestMessageAt: new Date(parsed.newestMessageAt),
        tokenCount: parsed.tokenCount,
        generatedAt: new Date(parsed.generatedAt),
      },
      keyThemes: parsed.keyThemes || [],
      emotionalJourney: parsed.emotionalJourney || '',
      unresolvedTopics: parsed.unresolvedTopics || [],
    };
  } catch {
    return null;
  }
}

/**
 * Format an Inner Thoughts conversation summary for prompt injection.
 */
export function formatInnerThoughtsSummaryForPrompt(
  summaryData: {
    summary: ConversationSummary;
    keyThemes: string[];
    emotionalJourney: string;
    unresolvedTopics: string[];
  }
): string {
  const parts: string[] = [];

  parts.push('[EARLIER IN THIS CONVERSATION]');
  parts.push(summaryData.summary.text);

  if (summaryData.keyThemes.length > 0) {
    parts.push(`\nKey themes explored: ${summaryData.keyThemes.join(', ')}`);
  }

  if (summaryData.emotionalJourney) {
    parts.push(`Their journey: ${summaryData.emotionalJourney}`);
  }

  if (summaryData.unresolvedTopics.length > 0) {
    parts.push(`Topics that may need follow-up: ${summaryData.unresolvedTopics.join(', ')}`);
  }

  parts.push(`\n[This covers ${summaryData.summary.messageCount} earlier messages - recent messages follow below]`);

  return parts.join('\n');
}
