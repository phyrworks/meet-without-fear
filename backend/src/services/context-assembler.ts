/**
 * Context Assembler Service
 *
 * Builds stage-scoped context bundles for the AI.
 * The AI receives pre-assembled context - it does NOT decide what to retrieve.
 *
 * From architecture docs:
 * "The large model receives a pre-assembled context bundle. It does not decide what to retrieve."
 */

import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { EmpathyStatus, SharedContentDeliveryStatus } from '../generated/prisma/client';
import {
  type MemoryIntentResult,
  type RetrievalDepth,
  getTurnBufferSize,
} from './memory-intent';
import { searchInnerWorkSessionContent } from './embedding';
import { getSessionSummary } from './conversation-summarizer';
import { loadGlobalFacts, type CategorizedFact as GlobalFact } from './global-memory';

// ============================================================================
// Types
// ============================================================================

/**
 * A message in the conversation context
 */
export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface StageHistoryMessage {
  role: 'user' | 'assistant' | 'empathy_statement' | 'shared_context' | 'system';
  content: string;
  stage: number;
  timestamp: string;
}

export interface PriorStageSummary {
  stage: number;
  lifecycleStatus?: string;
  completedAt?: string;
  userTurnCount: number;
  assistantTurnCount: number;
  highlights: StageHistoryMessage[];
}

export interface PriorStageSummaries {
  stages: PriorStageSummary[];
}

export interface ConsentedShareStateItem {
  kind: 'empathy_attempt' | 'additional_context';
  direction: 'user_to_partner' | 'partner_to_user';
  lifecycleStatus: string;
  content?: string;
  sharedAt?: string;
  deliveredAt?: string;
  revealedAt?: string;
  validatedAt?: string;
}

export interface ConsentedShareState {
  items: ConsentedShareStateItem[];
}

/**
 * Emotional thread tracking for continuity
 */
export interface EmotionalThread {
  initialIntensity: number | null;
  currentIntensity: number | null;
  trend: 'escalating' | 'stable' | 'de-escalating' | 'unknown';
  notableShifts: Array<{
    turn: number;
    from: number;
    to: number;
    triggerSummary?: string;
  }>;
}

/**
 * Session summary for long sessions (>30 min)
 */
export interface SessionSummary {
  keyThemes: string[];
  emotionalJourney: string;
  currentFocus: string;
  userStatedGoals: string[];
  agreedFacts?: string[];
  userNeeds?: string[];
  partnerNeeds?: string[];
  openQuestions?: string[];
  agreements?: string[];
  /** Cliffhanger for long-idle resumption. Null when the user is at a milestone. */
  lastUnresolvedThread?: string | null;
}

/**
 * Prior themes from previous sessions in this relationship
 */
export interface PriorThemes {
  themes: string[];
  lastSessionDate: string | null;
  sessionCount: number;
}

/**
 * Inner Thoughts context - private reflections linked to this session
 */
export interface InnerThoughtsContext {
  /** Relevant messages from user's Inner Thoughts (with boost for linked sessions) */
  relevantReflections: Array<{
    content: string;
    similarity: number;
    isFromLinkedSession: boolean;
  }>;
  /** Whether a linked Inner Thoughts session exists */
  hasLinkedSession: boolean;
}

/**
 * User memories to honor in responses
 */
export interface UserMemoriesContext {
  global: Array<{ content: string; category: string }>;
  session: Array<{ content: string; category: string }>;
}

/**
 * The assembled context bundle provided to the AI
 */
export interface ContextBundle {
  // Conversation context
  conversationContext: {
    recentTurns: ContextMessage[];
    turnCount: number;
    sessionDurationMinutes: number;
    /**
     * Milliseconds since this user's own last USER message in the session.
     * Null when they haven't spoken yet (first-turn case), undefined when
     * the bundle was built by a caller that doesn't track this (e.g. mock
     * bundles in tests / replay harnesses). `assembleContextBundle` always
     * sets it. Used by the prompt layer to signal long-idle resumption
     * framing; measured on `senderId = userId` only so AI-side interrupts
     * don't age the clock.
     */
    timeSinceLastUserTurnMs?: number | null;
  };

  // Emotional state
  emotionalThread: EmotionalThread;

  // Prior session context (if depth allows)
  priorThemes?: PriorThemes;

  // Global facts consolidated across all sessions for this user
  // Injected at top of context per fact-ledger architecture
  globalFacts?: GlobalFact[];

  // Session summary (for long sessions)
  sessionSummary?: SessionSummary;

  // Inner Thoughts reflections (if depth allows)
  innerThoughtsContext?: InnerThoughtsContext;

  // User memories ("Things to Always Remember")
  userMemories?: UserMemoriesContext;

  // Notable facts extracted from the conversation
  // (emotional context, situational facts, people & relationships)
  // Stored as CategorizedFact[] - array of { category, fact } objects
  notableFacts?: CategorizedFact[];

  // Stage-specific data
  stageContext: {
    stage: number;
    gatesSatisfied: Record<string, unknown>;
  };

  // Confirmed conversation topic. This is orientation context only; the
  // confirmation timestamp on Session remains the source of truth.
  topicFrame?: {
    text: string;
    confirmedAt: string;
  };

  // Condensed prior-stage context from this user's own lane only.
  // StageProgress remains the gate source of truth; these summaries are only
  // continuity context for what has already been said and persisted.
  priorStageSummaries?: PriorStageSummaries;

  // Typed consent/share lifecycle state for orientation only.
  // Content is included only when owned by this user or delivered/revealed to
  // them; StageProgress and lifecycle tables remain the gate source of truth.
  consentedShareState?: ConsentedShareState;

  // Full current-stage history for this user's own lane only.
  // This is prompt orientation context, not a replacement for StageProgress or
  // lifecycle tables when deciding gates.
  currentStageHistory?: {
    stage: number;
    messages: StageHistoryMessage[];
  };

  // User info
  userName: string;
  partnerName?: string;

  // Metadata
  intent: MemoryIntentResult;
  assembledAt: string;
}

// ============================================================================
// Context Assembly
// ============================================================================

/**
 * Assemble a context bundle for the AI based on the memory intent.
 */
export async function assembleContextBundle(
  sessionId: string,
  userId: string,
  stage: number,
  intent: MemoryIntentResult
): Promise<ContextBundle> {
  const now = new Date();
  const depth = intent.depth;

  // Get session and user info
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      relationship: {
        include: {
          members: {
            include: { user: true },
          },
        },
      },
      stageProgress: {
        where: { userId },
        orderBy: { stage: 'desc' },
        take: 1,
      },
    },
  });

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // Get user and partner names.
  // Partner name MUST prefer the nickname this user gave their partner, so the AI
  // refers to the partner by the name the user knows them by (not their real
  // first name, which may be sensitive or unfamiliar). Nickname is stored on the
  // current user's RelationshipMember row ("what this member calls their partner").
  const currentMember = session.relationship.members.find((m) => m.userId === userId);
  const partnerMember = session.relationship.members.find((m) => m.userId !== userId);
  const userName = currentMember?.user.name || 'there';
  const partnerName =
    currentMember?.nickname ||
    partnerMember?.user.firstName ||
    partnerMember?.user.name ||
    'your partner';

  // Get stage progress
  const progress = session.stageProgress[0];
  const gatesSatisfied = (progress?.gatesSatisfied as Record<string, unknown>) || {};

  // PARALLEL EXECUTION of context assembly steps
  // All these operations are independent and can run simultaneously to reduce latency.
  // Note: buildInnerThoughtsContext depends on conversationContext, so it runs after.
  const turnBufferSize = getTurnBufferSize(stage, intent.intent);

  const [conversationContext, currentStageHistory, priorStageSummaries, consentedShareState, emotionalThread, priorThemes, sessionSummary, userMemories, notableFacts, globalFacts, lastUserTurnAt] = await Promise.all([
    buildConversationContext(sessionId, userId, turnBufferSize, depth),
    buildCurrentUserStageHistory(sessionId, userId, stage, depth),
    buildPriorStageSummaries(sessionId, userId, stage, depth),
    buildConsentedShareState(sessionId, userId, depth),
    buildEmotionalThread(sessionId, userId, depth),
    (depth === 'full' || depth === 'light')
      ? buildPriorThemes(sessionId, userId, session.relationshipId)
      : Promise.resolve(undefined),
    (depth !== 'none')
      ? buildSessionSummary(sessionId, userId)
      : Promise.resolve(undefined),
    buildUserMemoriesContext(userId, sessionId),
    loadNotableFacts(sessionId, userId),
    // Global facts disabled until consent UI is implemented
    // loadGlobalFacts(userId),
    Promise.resolve(undefined),
    findLastUserTurnTimestamp(sessionId, userId),
  ]);

  // Debug logging for notable facts
  logger.info(`[Context Assembler] assembleContextBundle: session=${sessionId}, notableFacts=${notableFacts ? `${notableFacts.length} facts` : 'undefined'}`);

  // Build Inner Thoughts context after we have conversation context (it needs the last user message)
  const finalInnerThoughts = (depth === 'full' || depth === 'light')
    ? await buildInnerThoughtsContext(sessionId, userId, conversationContext)
    : undefined;

  const sessionDurationMinutes = Math.floor(
    (now.getTime() - session.createdAt.getTime()) / 60000
  );

  const timeSinceLastUserTurnMs = lastUserTurnAt
    ? now.getTime() - lastUserTurnAt.getTime()
    : null;

  return {
    conversationContext: {
      recentTurns: conversationContext,
      turnCount: conversationContext.length,
      sessionDurationMinutes,
      timeSinceLastUserTurnMs,
    },
    emotionalThread,
    priorThemes,
    globalFacts,
    sessionSummary,
    innerThoughtsContext: finalInnerThoughts,
    userMemories,
    notableFacts,
    stageContext: {
      stage,
      gatesSatisfied,
    },
    topicFrame: session.topicFrame && session.topicFrameConfirmedAt
      ? {
          text: session.topicFrame,
          confirmedAt: session.topicFrameConfirmedAt.toISOString(),
        }
      : undefined,
    priorStageSummaries,
    consentedShareState,
    currentStageHistory,
    userName,
    partnerName,
    intent,
    assembledAt: now.toISOString(),
  };
}

/**
 * Build conversation context with recent messages
 */
async function buildConversationContext(
  sessionId: string,
  userId: string,
  bufferSize: number,
  depth: RetrievalDepth
): Promise<ContextMessage[]> {
  if (depth === 'none' || bufferSize === 0) {
    return [];
  }

  const messages = await prisma.message.findMany({
    where: {
      sessionId,
      // Only get messages from this user's conversation (not partner's Stage 1)
      // Fixed: AI messages must also be filtered by forUserId to prevent partner leakage
      OR: [
        { senderId: userId }, // User's own messages
        { senderId: null, forUserId: userId }, // AI messages directed to this user
      ],
    },
    orderBy: { timestamp: 'desc' },
    take: bufferSize * 2, // Get more to account for both user and assistant
    select: {
      content: true,
      role: true,
      timestamp: true,
    },
  });

  // Reverse to chronological order
  const chronological = messages.reverse();

  // Take last N turns (user + assistant pairs)
  const recentTurns = chronological.slice(-bufferSize * 2);

  return recentTurns.map((m) => ({
    role: m.role === 'USER' ? 'user' as const : 'assistant' as const,
    content: m.content,
    timestamp: m.timestamp.toISOString(),
  }));
}

async function buildCurrentUserStageHistory(
  sessionId: string,
  userId: string,
  stage: number,
  depth: RetrievalDepth
): Promise<ContextBundle['currentStageHistory'] | undefined> {
  if (depth === 'none') return undefined;

  const messages = await prisma.message.findMany({
    where: {
      sessionId,
      stage,
      OR: [
        { senderId: userId },
        { senderId: null, forUserId: userId },
        { forUserId: userId, role: { in: ['EMPATHY_STATEMENT', 'SHARED_CONTEXT'] } },
      ],
    },
    orderBy: { timestamp: 'asc' },
    select: {
      content: true,
      role: true,
      timestamp: true,
      stage: true,
    },
  });

  if (messages.length === 0) return undefined;

  return {
    stage,
    messages: messages.map((message) => ({
      role: mapStageHistoryRole(message.role),
      content: message.content,
      stage: message.stage,
      timestamp: message.timestamp.toISOString(),
    })),
  };
}

function mapStageHistoryRole(role: string): StageHistoryMessage['role'] {
  switch (role) {
    case 'USER':
      return 'user';
    case 'AI':
      return 'assistant';
    case 'EMPATHY_STATEMENT':
      return 'empathy_statement';
    case 'SHARED_CONTEXT':
      return 'shared_context';
    default:
      return 'system';
  }
}

async function buildPriorStageSummaries(
  sessionId: string,
  userId: string,
  currentStage: number,
  depth: RetrievalDepth
): Promise<ContextBundle['priorStageSummaries'] | undefined> {
  if (depth === 'none' || currentStage <= 0) return undefined;

  const [messages, progressRows] = await Promise.all([
    prisma.message.findMany({
      where: {
        sessionId,
        stage: { lt: currentStage },
        OR: [
          { senderId: userId },
          { senderId: null, forUserId: userId },
          { forUserId: userId, role: { in: ['EMPATHY_STATEMENT', 'SHARED_CONTEXT'] } },
        ],
      },
      orderBy: [{ stage: 'asc' }, { timestamp: 'asc' }],
      select: {
        content: true,
        role: true,
        timestamp: true,
        stage: true,
      },
    }),
    prisma.stageProgress.findMany({
      where: {
        sessionId,
        userId,
        stage: { lt: currentStage },
      },
      orderBy: { stage: 'asc' },
      select: {
        stage: true,
        status: true,
        completedAt: true,
      },
    }),
  ]);

  if (messages.length === 0 && progressRows.length === 0) return undefined;

  const byStage = new Map<number, PriorStageSummary>();
  const ensureStage = (stage: number): PriorStageSummary => {
    const existing = byStage.get(stage);
    if (existing) return existing;
    const summary: PriorStageSummary = {
      stage,
      userTurnCount: 0,
      assistantTurnCount: 0,
      highlights: [],
    };
    byStage.set(stage, summary);
    return summary;
  };

  for (const progress of progressRows) {
    const summary = ensureStage(progress.stage);
    summary.lifecycleStatus = progress.status;
    if (progress.completedAt) {
      summary.completedAt = progress.completedAt.toISOString();
    }
  }

  for (const message of messages) {
    const summary = ensureStage(message.stage);
    if (message.role === 'USER') {
      summary.userTurnCount += 1;
    } else if (message.role === 'AI') {
      summary.assistantTurnCount += 1;
    }

    summary.highlights.push({
      role: mapStageHistoryRole(message.role),
      content: message.content,
      stage: message.stage,
      timestamp: message.timestamp.toISOString(),
    });
  }

  const stages = [...byStage.values()]
    .sort((a, b) => a.stage - b.stage)
    .map((summary) => ({
      ...summary,
      highlights: summary.highlights.slice(-4),
    }));

  return stages.length > 0 ? { stages } : undefined;
}

async function buildConsentedShareState(
  sessionId: string,
  userId: string,
  depth: RetrievalDepth
): Promise<ContextBundle['consentedShareState'] | undefined> {
  if (depth === 'none') return undefined;

  const [empathyAttempts, shareOffers] = await Promise.all([
    prisma.empathyAttempt.findMany({
      where: { sessionId },
      orderBy: { sharedAt: 'asc' },
      select: {
        sourceUserId: true,
        content: true,
        status: true,
        sharedAt: true,
        deliveredAt: true,
        revealedAt: true,
        validations: {
          where: { validated: true },
          select: { validatedAt: true },
          orderBy: { validatedAt: 'asc' },
          take: 1,
        },
      },
    }),
    prisma.reconcilerShareOffer.findMany({
      where: {
        result: { sessionId },
        sharedContent: { not: null },
        sharedAt: { not: null },
      },
      orderBy: { sharedAt: 'asc' },
      select: {
        userId: true,
        status: true,
        deliveryStatus: true,
        sharedContent: true,
        sharedAt: true,
        deliveredAt: true,
      },
    }),
  ]);

  const items: ConsentedShareStateItem[] = [];

  for (const attempt of empathyAttempts) {
    const isOwnAttempt = attempt.sourceUserId === userId;
    const isVisiblePartnerAttempt =
      attempt.revealedAt !== null ||
      attempt.status === EmpathyStatus.REVEALED ||
      attempt.status === EmpathyStatus.VALIDATED;

    items.push({
      kind: 'empathy_attempt',
      direction: isOwnAttempt ? 'user_to_partner' : 'partner_to_user',
      lifecycleStatus: attempt.status,
      ...(isOwnAttempt || isVisiblePartnerAttempt ? { content: attempt.content } : {}),
      sharedAt: attempt.sharedAt.toISOString(),
      ...(attempt.deliveredAt ? { deliveredAt: attempt.deliveredAt.toISOString() } : {}),
      ...(attempt.revealedAt ? { revealedAt: attempt.revealedAt.toISOString() } : {}),
      ...(attempt.validations[0]?.validatedAt ? { validatedAt: attempt.validations[0].validatedAt.toISOString() } : {}),
    });
  }

  for (const offer of shareOffers) {
    const isOwnShare = offer.userId === userId;
    const isDeliveredToUser =
      offer.deliveredAt !== null ||
      offer.deliveryStatus === SharedContentDeliveryStatus.DELIVERED ||
      offer.deliveryStatus === SharedContentDeliveryStatus.SEEN;

    items.push({
      kind: 'additional_context',
      direction: isOwnShare ? 'user_to_partner' : 'partner_to_user',
      lifecycleStatus: `${offer.status}/${offer.deliveryStatus}`,
      ...(isOwnShare || isDeliveredToUser ? { content: offer.sharedContent ?? undefined } : {}),
      ...(offer.sharedAt ? { sharedAt: offer.sharedAt.toISOString() } : {}),
      ...(offer.deliveredAt ? { deliveredAt: offer.deliveredAt.toISOString() } : {}),
    });
  }

  if (items.length === 0) return undefined;

  items.sort((a, b) => {
    const aTime = a.revealedAt ?? a.deliveredAt ?? a.sharedAt ?? '';
    const bTime = b.revealedAt ?? b.deliveredAt ?? b.sharedAt ?? '';
    return aTime.localeCompare(bTime);
  });

  return { items };
}

/**
 * Build emotional thread tracking
 */
async function buildEmotionalThread(
  sessionId: string,
  userId: string,
  depth: RetrievalDepth
): Promise<EmotionalThread> {
  if (depth === 'none') {
    return {
      initialIntensity: null,
      currentIntensity: null,
      trend: 'unknown',
      notableShifts: [],
    };
  }

  // Get the user's vessel for this session
  const vessel = await prisma.userVessel.findUnique({
    where: {
      userId_sessionId: {
        userId,
        sessionId,
      },
    },
    select: { id: true },
  });

  if (!vessel) {
    return {
      initialIntensity: null,
      currentIntensity: null,
      trend: 'unknown',
      notableShifts: [],
    };
  }

  // Get emotional readings from the vessel
  const readings = await prisma.emotionalReading.findMany({
    where: {
      vesselId: vessel.id,
    },
    orderBy: { timestamp: 'asc' },
    select: {
      intensity: true,
      timestamp: true,
    },
  });

  if (readings.length === 0) {
    return {
      initialIntensity: null,
      currentIntensity: null,
      trend: 'unknown',
      notableShifts: [],
    };
  }

  const initialIntensity = readings[0].intensity;
  const currentIntensity = readings[readings.length - 1].intensity;

  // Calculate trend
  let trend: EmotionalThread['trend'] = 'stable';
  if (readings.length >= 2) {
    const recent = readings.slice(-3);
    const avgRecent = recent.reduce((sum, r) => sum + r.intensity, 0) / recent.length;
    const earlier = readings.slice(0, Math.min(3, readings.length));
    const avgEarlier = earlier.reduce((sum, r) => sum + r.intensity, 0) / earlier.length;

    if (avgRecent - avgEarlier >= 2) {
      trend = 'escalating';
    } else if (avgEarlier - avgRecent >= 2) {
      trend = 'de-escalating';
    }
  }

  // Find notable shifts (changes of 3+ points)
  const notableShifts: EmotionalThread['notableShifts'] = [];
  for (let i = 1; i < readings.length && notableShifts.length < 3; i++) {
    const diff = Math.abs(readings[i].intensity - readings[i - 1].intensity);
    if (diff >= 3) {
      notableShifts.push({
        turn: i,
        from: readings[i - 1].intensity,
        to: readings[i].intensity,
      });
    }
  }

  return {
    initialIntensity,
    currentIntensity,
    trend,
    notableShifts,
  };
}

/**
 * Build prior themes from previous sessions in this relationship
 */
async function buildPriorThemes(
  sessionId: string,
  userId: string,
  relationshipId: string
): Promise<PriorThemes> {
  // Get previous completed sessions in this relationship
  const previousSessions = await prisma.session.findMany({
    where: {
      relationshipId,
      id: { not: sessionId },
      status: 'RESOLVED',
    },
    orderBy: { updatedAt: 'desc' },
    take: 3,
    select: {
      id: true,
      updatedAt: true,
    },
  });

  if (previousSessions.length === 0) {
    return {
      themes: [],
      lastSessionDate: null,
      sessionCount: 0,
    };
  }

  // For now, return placeholder - will be populated by need extraction later
  // This would come from UserVessel needs/themes in full implementation
  return {
    themes: [], // TODO: Extract from UserVessel
    lastSessionDate: previousSessions[0].updatedAt.toISOString(),
    sessionCount: previousSessions.length,
  };
}

/**
 * Build session summary for long sessions
 */
async function buildSessionSummary(
  sessionId: string,
  userId: string
): Promise<SessionSummary | undefined> {
  // NOTE: Summaries are generated asynchronously by ConversationSummarizer and stored
  // in UserVessel.conversationSummary. This function just loads and formats them.
  const summaryData = await getSessionSummary(sessionId, userId);
  if (!summaryData) return undefined;

  return {
    keyThemes: summaryData.keyThemes ?? [],
    emotionalJourney: summaryData.emotionalJourney ?? '',
    // The summarizer's narrative summary becomes our "currentFocus" block.
    currentFocus: summaryData.summary.text ?? '',
    // These are "unresolved topics" (follow-ups) rather than literal goals, but they serve
    // the same purpose for continuity and future prompt grounding.
    userStatedGoals: summaryData.unresolvedTopics ?? [],
    agreedFacts: summaryData.agreedFacts ?? [],
    userNeeds: summaryData.userNeeds ?? [],
    partnerNeeds: summaryData.partnerNeeds ?? [],
    openQuestions: summaryData.openQuestions ?? [],
    agreements: summaryData.agreements ?? [],
    lastUnresolvedThread: summaryData.lastUnresolvedThread ?? null,
  };
}

/**
 * Build Inner Thoughts context - private reflections that may inform the partner session.
 * Sessions linked to this partner session get a similarity boost.
 *
 * NOTE: Per fact-ledger architecture, we now search at session level (theme + summary)
 * instead of message level. This provides better context with lower token cost.
 */
async function buildInnerThoughtsContext(
  sessionId: string,
  userId: string,
  conversationContext: ContextMessage[]
): Promise<InnerThoughtsContext | undefined> {
  // Check if user has a linked Inner Thoughts session
  const linkedSession = await prisma.innerWorkSession.findFirst({
    where: {
      userId,
      linkedPartnerSessionId: sessionId,
      status: 'ACTIVE',
    },
    select: {
      id: true,
      theme: true,
      summary: true,
    },
  });

  // If no recent conversation to search with, skip retrieval
  if (conversationContext.length === 0) {
    return {
      relevantReflections: [],
      hasLinkedSession: !!linkedSession,
    };
  }

  // Use the last user message as search query
  const lastUserMessage = [...conversationContext]
    .reverse()
    .find((m) => m.role === 'user');

  if (!lastUserMessage) {
    return {
      relevantReflections: [],
      hasLinkedSession: !!linkedSession,
    };
  }

  try {
    // Search Inner Work sessions with boost for linked sessions
    // Per fact-ledger architecture, we search session-level content (theme + summary)
    const results = await searchInnerWorkSessionContent(
      userId,
      lastUserMessage.content,
      sessionId, // Partner session ID - linked sessions get boost
      1.3, // 30% boost
      3, // Top 3 results
      0.5, // Threshold
      undefined, // turnId
      sessionId // sessionId for BrainActivity logging
    );

    // For each matching session, get the summary to use as reflection content
    const reflections = await Promise.all(
      results.map(async (r) => {
        // Get the session's summary/theme for content
        const session = await prisma.innerWorkSession.findUnique({
          where: { id: r.sessionId },
          select: { theme: true, summary: true },
        });

        // Build reflection content from session summary
        const content = session?.summary || session?.theme || 'Private reflection';

        return {
          content,
          similarity: r.similarity,
          isFromLinkedSession: r.isLinked,
        };
      })
    );

    return {
      relevantReflections: reflections,
      hasLinkedSession: !!linkedSession,
    };
  } catch (error) {
    logger.warn('[Context Assembler] Failed to retrieve Inner Thoughts:', error);
    return {
      relevantReflections: [],
      hasLinkedSession: !!linkedSession,
    };
  }
}

/**
 * Load active user memories for context
 */
async function buildUserMemoriesContext(
  userId: string,
  sessionId: string
): Promise<UserMemoriesContext> {
  const memories = await prisma.userMemory.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      OR: [
        { sessionId: null }, // Global
        { sessionId },       // This session
      ],
    },
    select: {
      content: true,
      category: true,
      sessionId: true,
    },
  });

  return {
    global: memories
      .filter((m) => m.sessionId === null)
      .map((m) => ({ content: m.content, category: m.category })),
    session: memories
      .filter((m) => m.sessionId === sessionId)
      .map((m) => ({ content: m.content, category: m.category })),
  };
}

/** Categorized fact format */
interface CategorizedFact {
  category: string;
  fact: string;
}

/**
 * Load notable facts from UserVessel
 * These are facts about the user's situation, emotions, and circumstances
 * extracted by Haiku during the conversation.
 *
 * Facts are stored as JSON: [{ category: string, fact: string }]
 */
async function loadNotableFacts(
  sessionId: string,
  userId: string
): Promise<CategorizedFact[] | undefined> {
  const vessel = await prisma.userVessel.findUnique({
    where: {
      userId_sessionId: { userId, sessionId },
    },
    select: { notableFacts: true },
  });

  // Debug logging to track notable facts loading
  if (!vessel) {
    logger.debug(`[Context Assembler] loadNotableFacts: No UserVessel found for session=${sessionId}, user=${userId}`);
    return undefined;
  }

  const rawFacts = vessel.notableFacts;
  if (!rawFacts) {
    logger.debug(`[Context Assembler] loadNotableFacts: UserVessel exists but no facts for session=${sessionId}, user=${userId}`);
    return undefined;
  }

  if (!Array.isArray(rawFacts)) {
    logger.warn(`[Context Assembler] loadNotableFacts: notableFacts is not an array for session=${sessionId}, user=${userId}`);
    return undefined;
  }

  // Cast through unknown for JSON type safety
  const facts = rawFacts as unknown;

  // Validate and filter to CategorizedFact[]
  const categorizedFacts: CategorizedFact[] = (facts as unknown[])
    .filter((f): f is CategorizedFact => {
      if (typeof f !== 'object' || f === null) return false;
      const obj = f as Record<string, unknown>;
      return typeof obj.category === 'string' && typeof obj.fact === 'string';
    });

  if (categorizedFacts.length === 0) {
    return undefined;
  }

  logger.info(`[Context Assembler] loadNotableFacts: Loaded ${categorizedFacts.length} facts for session=${sessionId}, user=${userId}`);
  return categorizedFacts;
}

export {
  formatContextForPrompt,
  formatContextForPromptLegacy,
  type ContextFormattingOptions,
} from './context-formatters';

/**
 * Return the timestamp of this user's most recent own USER message in the
 * session. Measures engagement specifically — AI-side posts (gentle
 * interrupts, welcome-backs) intentionally don't age the idle clock.
 * Returns null when the user hasn't spoken yet.
 */
async function findLastUserTurnTimestamp(
  sessionId: string,
  userId: string
): Promise<Date | null> {
  const last = await prisma.message.findFirst({
    where: { sessionId, senderId: userId, role: 'USER' },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
  return last?.timestamp ?? null;
}
