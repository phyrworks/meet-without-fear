/**
 * Universal Context Retriever
 *
 * This service runs on EVERY message to ensure the AI always has
 * awareness of relevant history. It:
 *
 * 1. Analyzes the user's message for references to past content
 * 2. Searches embeddings across all accessible content
 * 3. Returns relevant context snippets to inject into prompts
 *
 * This layer runs REGARDLESS of stage, session, or intent.
 * It's the "memory backbone" that ensures nothing is forgotten.
 */

import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { resolveParticipant } from './participant-resolver';
import { getHaikuJson } from '../lib/bedrock';
import { MemoryIntentResult } from './memory-intent';
import { MemoryPreferencesDTO } from '@meet-without-fear/shared';
import { getTimeContext, getRecencyGuidance, type TimeContext } from '../utils/time-language';
import { CONTEXT_LIMITS } from '../utils/token-budget';
import { withHaikuCircuitBreaker } from '../utils/circuit-breaker';
import { brainService } from '../services/brain-service';
import { ActivityType } from '../generated/prisma/client';
import { BrainActivityCallType } from './brain-service';
import { searchSessionContent, searchInnerWorkSessionContent } from './embedding';

// ============================================================================
// Types
// ============================================================================

export interface RetrievedContext {
  /** Messages from current conversation (full history, not limited) */
  conversationHistory: ConversationMessage[];

  /** Semantically relevant messages from other sessions */
  relevantFromOtherSessions: RelevantMessage[];

  /** Semantically relevant messages from current session's history */
  relevantFromCurrentSession: RelevantMessage[];

  /** Pre-session messages not yet associated */
  preSessionMessages: ConversationMessage[];

  /** Detected references to past content */
  detectedReferences: DetectedReference[];

  /** Summary of what was retrieved */
  retrievalSummary: string;

  /** AI guidance for how to reference retrieved content based on recency */
  recencyGuidance?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  sessionId?: string;
  partnerName?: string;
}

export interface RelevantMessage {
  content: string;
  sessionId: string;
  partnerName: string;
  similarity: number;
  timestamp: string;
  role: 'user' | 'assistant';
  /** Time context for this message (how long ago, phrasing) */
  timeContext?: TimeContext;
  /** Source of the message: partner-session or inner-thoughts */
  source?: 'partner-session' | 'inner-thoughts';
}

export interface DetectedReference {
  type: 'person' | 'event' | 'agreement' | 'feeling' | 'time';
  text: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface RetrievalOptions {
  /** User ID */
  userId: string;

  /** Current message being processed */
  currentMessage: string;

  /** Current session ID (if in a session) */
  currentSessionId?: string;

  /** Relationship ID for filtering cross-session search to same partner */
  relationshipId?: string;

  /** Turn ID for grouping logs and cost attribution (format: `${sessionId}-${turnCount}`) - REQUIRED */
  turnId: string;

  /** Maximum messages to retrieve from other sessions */
  maxCrossSessionMessages?: number;

  /** Minimum similarity threshold for retrieval */
  similarityThreshold?: number;

  /** Whether to include pre-session messages */
  includePreSession?: boolean;

  /** Memory intent result from intent determination (provides stage-aware config) */
  memoryIntent?: MemoryIntentResult;

  /** User's memory preferences (controls cross-session recall permission) */
  userPreferences?: MemoryPreferencesDTO;

  // Inner Thoughts retrieval options

  /** Include InnerWorkMessage search (for Inner Thoughts sessions) */
  includeInnerThoughts?: boolean;

  /** Current Inner Thoughts session ID to exclude from search */
  excludeInnerThoughtsSessionId?: string;

  /** Linked partner session ID for similarity boost */
  linkedPartnerSessionId?: string;

  /** Skip reference detection - always search (for Inner Thoughts) */
  skipDetection?: boolean;
}

// ============================================================================
// Reference Detection
// ============================================================================

interface ReferenceDetectionResult {
  references: DetectedReference[];
  needsRetrieval: boolean;
  searchQueries: string[];
}

/**
 * Detect references to past content in the user's message.
 * Uses Haiku for fast detection with circuit breaker protection.
 *
 * Enhanced to catch commitment patterns like "But I thought...", "I thought we...",
 * "I assumed...", "I believed..." which are more common than explicit "we agreed".
 */
async function detectReferences(message: string, sessionId: string, turnId: string): Promise<ReferenceDetectionResult> {
  const prompt = `Analyze this message for references to past events, people, agreements, or time periods.

Message: "${message}"

Look for:
- References to specific people (names, relationships like "my mom", "my partner")
- References to past events ("last time", "when we talked", "remember when")
- References to agreements or commitments:
  * Explicit: "we agreed", "you said", "I promised", "we decided", "our agreement"
  * Implicit: "But I thought...", "I thought we...", "I assumed...", "I believed...", 
    "I was under the impression...", "I understood that...", "I thought you meant..."
- References to past feelings ("I felt", "that time I was")
- Time references ("yesterday", "last week", "before")

IMPORTANT: Implicit commitment references (like "I thought...") are very common and should
trigger needsRetrieval=true to help clarify misunderstandings.

Respond with JSON:
{
  "references": [
    { "type": "person|event|agreement|feeling|time", "text": "the reference text", "confidence": "high|medium|low" }
  ],
  "needsRetrieval": true/false (true if references suggest looking up past content),
  "searchQueries": ["query 1", "query 2"] (semantic search queries to find relevant content)
}

If no references, return empty arrays and needsRetrieval: false.`;

  // Use circuit breaker: if Haiku fails or times out, return safe fallback
  const fallback: ReferenceDetectionResult = {
    references: [],
    needsRetrieval: false,
    searchQueries: [],
  };

  return withHaikuCircuitBreaker(
    async () => {
      const result = await getHaikuJson<ReferenceDetectionResult>({
        systemPrompt: 'You detect references to past content in messages. Output JSON only.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        sessionId,
        turnId,
        operation: 'retrieval-planning',
        callType: BrainActivityCallType.REFERENCE_DETECTION,
        ownContent: true, // R40: the caller's own content only
      });
      return result;
    },
    fallback,
    'detectReferences',
  );
}

// ============================================================================
// Semantic Search
// ============================================================================

/**
 * Search for semantically similar session content across sessions.
 * Uses session-level content embeddings (facts + summary) instead of message-level.
 *
 * @deprecated Internal use only - use searchSessionContent from embedding.ts directly
 */
async function searchAcrossSessionsContent(
  userId: string,
  queryText: string,
  _relationshipId: string,
  limit: number = 5,
  threshold: number = 0.5,
  turnId?: string,
): Promise<RelevantMessage[]> {
  // Use session-level search
  const sessionMatches = await searchSessionContent(userId, queryText, limit, threshold, turnId);

  // Convert session matches to RelevantMessage format for backward compatibility
  // Note: This is a lossy conversion - we no longer have individual messages
  return sessionMatches.map(match => {
    // Format facts as content if available
    const factsContent =
      match.facts && match.facts.length > 0
        ? match.facts.map(f => `[${f.category}] ${f.fact}`).join('; ')
        : 'No facts available';

    return {
      content: factsContent,
      sessionId: match.sessionId,
      partnerName: match.partnerName,
      similarity: match.similarity,
      timestamp: new Date().toISOString(), // No specific timestamp for session-level
      role: 'assistant' as const, // Facts are AI-extracted
      timeContext: getTimeContext(new Date().toISOString()),
      source: 'partner-session' as const,
    };
  });
}

// ============================================================================
// Conversation History
// ============================================================================

/**
 * Get full conversation history for current session.
 * No arbitrary limits - we trust the model's context window.
 * Data isolation: only returns this user's messages and AI responses to them.
 *
 * IMPORTANT: This fetches raw rows from the database, NOT from the vector store.
 * This ensures the AI sees messages sent 1 second ago even if they haven't been
 * embedded yet. This prevents the "async blind spot" where recent messages
 * might be missing from context.
 */
async function getSessionHistory(sessionId: string, userId: string): Promise<ConversationMessage[]> {
  // Target shape (TS-9): the user's participant's MAIN conversation — their
  // own turns and the AI's replies (delivered items excluded, as before).
  const participant = await resolveParticipant(sessionId, userId);
  if (!participant?.mainConversationId) return [];
  const messages = await prisma.message.findMany({
    where: {
      conversationId: participant.mainConversationId,
      OR: [{ senderParticipantId: participant.id }, { role: 'AI' }],
    },
    orderBy: { createdAt: 'asc' },
    select: {
      content: true,
      role: true,
      createdAt: true,
    },
  });

  return messages.map(m => ({
    role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
    content: m.content,
    timestamp: m.createdAt.toISOString(),
  }));
}

/**
 * Get unassociated pre-session messages for the user.
 */
async function getPreSessionMessages(_userId: string): Promise<ConversationMessage[]> {
  // Target shape (TS-9): pre-session chat is dropped (spec A-Q6 — PreSessionMessage
  // was never populated); there is nothing to read.
  return [];
}

// ============================================================================
// Inner Thoughts Retrieval
// ============================================================================

/**
 * Search for semantically similar Inner Thoughts session content.
 * Uses session-level content embeddings (theme + summary) instead of message-level.
 */
async function searchInnerWorkSessionsContent(
  userId: string,
  queryText: string,
  linkedPartnerSessionId?: string,
  boostFactor: number = 1.3,
  limit: number = 15,
  threshold: number = 0.75,
  turnId?: string,
): Promise<RelevantMessage[]> {
  // Use session-level search with linked session boosting
  const sessionMatches = await searchInnerWorkSessionContent(
    userId,
    queryText,
    linkedPartnerSessionId,
    boostFactor,
    limit,
    threshold,
    turnId,
  );

  // Convert session matches to RelevantMessage format
  return sessionMatches.map(match => ({
    content: match.theme || 'Inner reflection session',
    sessionId: match.sessionId,
    partnerName: 'Your reflections',
    similarity: match.similarity,
    timestamp: new Date().toISOString(),
    role: 'assistant' as const,
    timeContext: getTimeContext(new Date().toISOString()),
    source: 'inner-thoughts' as const,
  }));
}

// ============================================================================
// Main Retrieval Function
// ============================================================================

/**
 * Retrieve all relevant context for a message.
 * This is the main entry point - call this for EVERY message.
 */
export async function retrieveContext(options: RetrievalOptions): Promise<RetrievedContext> {
  const {
    userId,
    currentMessage,
    currentSessionId,
    relationshipId: providedRelationshipId,
    turnId,
    maxCrossSessionMessages = 10,
    similarityThreshold = 0.5,
    includePreSession = true,
    memoryIntent,
    userPreferences,
    // Inner Thoughts options
    includeInnerThoughts = false,
    excludeInnerThoughtsSessionId,
    linkedPartnerSessionId,
    skipDetection = false,
  } = options;

  const startTime = Date.now();

  // Get relationshipId - if not provided, look it up from the session
  let relationshipId = providedRelationshipId;
  if (!relationshipId && currentSessionId) {
    try {
      const session = await prisma.session.findUnique({
        where: { id: currentSessionId },
        select: { relationshipId: true },
      });
      relationshipId = session?.relationshipId;
    } catch (error) {
      logger.warn('[ContextRetriever] Failed to fetch session relationship:', error);
    }
  }

  // Use memory intent to override thresholds and limits if provided
  const effectiveThreshold = memoryIntent?.threshold ?? similarityThreshold;
  const effectiveMaxCrossSession = memoryIntent?.maxCrossSession ?? maxCrossSessionMessages;

  // For Inner Thoughts, use effective threshold (was hardcoded 0.75)
  const innerThoughtsThreshold = effectiveThreshold;

  // Fetch user preferences if not provided
  let effectiveUserPrefs = userPreferences;
  if (!effectiveUserPrefs) {
    try {
      // user_preferences.doc absorbs User.memoryPreferences (spec §1.7), under `memory`.
      const prefs = await prisma.userPreferences.findUnique({
        where: { userId },
        select: { doc: true },
      });
      effectiveUserPrefs =
        ((prefs?.doc as { memory?: unknown } | null)?.memory as MemoryPreferencesDTO | undefined) ?? undefined;
    } catch (error) {
      logger.warn('[ContextRetriever] Failed to fetch user preferences:', error);
    }
  }

  // Run detection and basic retrieval in parallel using Promise.all()
  // This is critical for performance - sequential execution would kill user experience
  // All three operations are independent and can run simultaneously
  // When skipDetection is true (for Inner Thoughts), we bypass Haiku detection and always search
  const fallbackReferenceResult: ReferenceDetectionResult = {
    references: [],
    needsRetrieval: false,
    searchQueries: [],
  };
  const alwaysSearchResult: ReferenceDetectionResult = {
    references: [],
    needsRetrieval: true,
    searchQueries: [currentMessage],
  };
  const [referenceDetection, conversationHistory, preSessionMessages] = await Promise.all([
    skipDetection
      ? Promise.resolve(alwaysSearchResult) // Skip Haiku detection - always search with current message
      : currentSessionId
        ? detectReferences(currentMessage, currentSessionId, turnId) // Haiku call (with circuit breaker)
        : Promise.resolve(fallbackReferenceResult), // No session context - skip detection
    currentSessionId ? getSessionHistory(currentSessionId, userId) : Promise.resolve([]), // DB query
    includePreSession ? getPreSessionMessages(userId) : Promise.resolve([]), // DB query
  ]);

  // If we detected references that need retrieval, do semantic search
  let relevantFromOtherSessions: RelevantMessage[] = [];
  let relevantFromCurrentSession: RelevantMessage[] = [];

  if (referenceDetection.needsRetrieval && referenceDetection.searchQueries.length > 0) {
    // Log the search queries being used
    // Log the search queries being used via simplified metadata tracking in the main retrieval activity
    // or we can allow the main retrieval activity to capturing this detail.
    // For now, removing the partial auditLog call to avoid clutter and relying on the final complete log.

    // Cross-session disabled until consent UI is implemented
    // Previously this was:
    // const shouldSearchCrossSession =
    //   (memoryIntent?.allowCrossSession ?? true) ||
    //   referenceDetection.needsRetrieval ||
    //   (effectiveUserPrefs?.crossSessionRecall ?? false);
    const shouldSearchCrossSession = false;

    // Search using the generated queries
    // Per fact-ledger architecture, we now search at session level (facts + summary)
    const searchPromises = referenceDetection.searchQueries.map(async query => {
      // Build search operations array
      const searchOps: Promise<RelevantMessage[]>[] = [];

      // Search partner session content (cross-session) - uses session-level embeddings
      if (shouldSearchCrossSession && relationshipId) {
        searchOps.push(
          searchAcrossSessionsContent(
            userId,
            query,
            relationshipId,
            effectiveMaxCrossSession,
            effectiveThreshold,
            turnId,
          ),
        );
      } else {
        searchOps.push(Promise.resolve([]));
      }

      // Within-session search is deprecated - facts are available via assembleContextBundle
      searchOps.push(Promise.resolve([]));

      // Add Inner Thoughts search if enabled
      if (includeInnerThoughts) {
        searchOps.push(
          searchInnerWorkSessionsContent(
            userId,
            query,
            linkedPartnerSessionId,
            1.3, // boost factor for linked sessions
            15, // limit
            innerThoughtsThreshold,
            turnId,
          ),
        );
      }

      const [crossSession, withinSession, innerThoughts = []] = await Promise.all(searchOps);
      return { query, crossSession, withinSession, innerThoughts };
    });

    const searchResults = await Promise.all(searchPromises);

    // Deduplicate and merge results
    const seenCross = new Set<string>();
    const seenWithin = new Set<string>();

    for (const result of searchResults) {
      for (const msg of result.crossSession) {
        const key = `${msg.sessionId}:${msg.content.slice(0, 50)}`;
        if (!seenCross.has(key)) {
          seenCross.add(key);
          // Mark source as partner-session
          relevantFromOtherSessions.push({ ...msg, source: 'partner-session' });
        }
      }
      // Add Inner Thoughts results to relevantFromOtherSessions
      // They're treated as "other sessions" for context purposes
      for (const msg of result.innerThoughts || []) {
        const key = `inner:${msg.sessionId}:${msg.content.slice(0, 50)}`;
        if (!seenCross.has(key)) {
          seenCross.add(key);
          relevantFromOtherSessions.push(msg); // Already has source: 'inner-thoughts'
        }
      }
      for (const msg of result.withinSession) {
        const key = msg.content.slice(0, 50);
        if (!seenWithin.has(key)) {
          seenWithin.add(key);
          relevantFromCurrentSession.push(msg);
        }
      }
    }

    // Log search results via BrainService (fire-and-forget — telemetry must not block AI response)
    brainService
      .startActivity({
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
        ...(excludeInnerThoughtsSessionId ? { innerWorkSessionId: excludeInnerThoughtsSessionId } : {}),
        turnId,
        activityType: ActivityType.RETRIEVAL,
        model: 'system-retrieval',
        input: {
          userId,
          searchQueries: referenceDetection.searchQueries,
          referencesDetected: referenceDetection.references,
          threshold: effectiveThreshold,
          maxCrossSession: effectiveMaxCrossSession,
        },
        metadata: {
          queryCount: referenceDetection.searchQueries.length,
        },
      })
      .then(async activity => {
        // Complete immediately as we already have results
        await brainService.completeActivity(activity.id, {
          output: {
            crossSessionResultsCount: relevantFromOtherSessions.length,
            withinSessionResultsCount: relevantFromCurrentSession.length,
            topMatches: [
              ...relevantFromOtherSessions.slice(0, 5).map(m => ({
                content: m.content, // Full content, NO TRUNCATION
                similarity: m.similarity,
                source: 'cross-session',
                timestamp: m.timestamp,
              })),
              ...relevantFromCurrentSession.slice(0, 5).map(m => ({
                content: m.content, // Full content, NO TRUNCATION
                similarity: m.similarity,
                source: 'within-session',
                timestamp: m.timestamp,
              })),
            ],
          },
          durationMs: 0, // Already elapsed in search time effectively
        });
      })
      .catch(err => logger.warn('[ContextRetriever] Brain activity logging failed:', err));

    // Sort by similarity and limit
    relevantFromOtherSessions = relevantFromOtherSessions
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, effectiveMaxCrossSession);

    relevantFromCurrentSession = relevantFromCurrentSession.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  }

  // Build retrieval summary
  const parts: string[] = [];
  if (conversationHistory.length > 0) {
    parts.push(`${conversationHistory.length} messages in current conversation`);
  }
  if (preSessionMessages.length > 0) {
    parts.push(`${preSessionMessages.length} pre-session messages`);
  }
  if (relevantFromOtherSessions.length > 0) {
    parts.push(`${relevantFromOtherSessions.length} relevant from other sessions`);
  }
  if (relevantFromCurrentSession.length > 0) {
    parts.push(`${relevantFromCurrentSession.length} relevant from earlier in session`);
  }
  if (referenceDetection.references.length > 0) {
    parts.push(`${referenceDetection.references.length} references detected`);
  }

  const duration = Date.now() - startTime;
  logger.info(`[ContextRetriever] Retrieved in ${duration}ms: ${parts.join(', ') || 'no additional context'}`);

  // Generate recency guidance for retrieved content
  const allTimestamps = [
    ...relevantFromOtherSessions.map(m => m.timestamp),
    ...relevantFromCurrentSession.map(m => m.timestamp),
  ];
  const recencyGuidance = allTimestamps.length > 0 ? getRecencyGuidance(allTimestamps) : undefined;

  return {
    conversationHistory,
    relevantFromOtherSessions,
    relevantFromCurrentSession,
    preSessionMessages,
    detectedReferences: referenceDetection.references,
    retrievalSummary: parts.join('; ') || 'No additional context retrieved',
    recencyGuidance,
  };
}

// ============================================================================
// Context Formatting
// ============================================================================

/**
 * Format retrieved context for injection into prompts.
 * Uses natural time language instead of formulaic headers.
 */
export function formatRetrievedContext(context: RetrievedContext): string {
  const sections: string[] = [];
  const truncate = (text: string, maxChars: number = 500) =>
    text.length > maxChars ? `${text.slice(0, maxChars - 20)}…[truncated]` : text;

  // Add recency guidance at the top if we have retrieved content
  if (
    context.recencyGuidance &&
    (context.relevantFromOtherSessions.length > 0 || context.relevantFromCurrentSession.length > 0)
  ) {
    sections.push(`[MEMORY CONTEXT GUIDANCE: ${context.recencyGuidance}]`);
  }

  // Pre-session messages (if any and not in a session)
  if (context.preSessionMessages.length > 0) {
    sections.push('\n[Earlier in this conversation]');
    for (const msg of context.preSessionMessages.slice(-CONTEXT_LIMITS.maxPreSessionMessages)) {
      sections.push(`${msg.role === 'user' ? 'User' : 'Assistant'}: ${truncate(msg.content)}`);
    }
  }

  // Relevant messages from other sessions - with time context
  // Now includes both partner sessions AND inner thoughts
  if (context.relevantFromOtherSessions.length > 0) {
    sections.push('\n[Related content from previous sessions]');
    for (const msg of context.relevantFromOtherSessions) {
      // Use the time context for natural phrasing
      const timePhrase = msg.timeContext?.phrase ?? new Date(msg.timestamp).toLocaleDateString();
      const useMemoryLanguage = msg.timeContext?.useRememberingLanguage ?? true;

      // Format differently based on source
      if (msg.source === 'inner-thoughts') {
        // Inner Thoughts formatting
        if (useMemoryLanguage) {
          sections.push(`[Your reflections, ${timePhrase}]`);
        } else {
          sections.push(`[Your reflections]`);
        }
      } else {
        // Partner session formatting (default)
        if (useMemoryLanguage) {
          sections.push(`[Session with ${msg.partnerName}, ${timePhrase}]`);
        } else {
          // For very recent content, minimal framing
          sections.push(`[${msg.partnerName}]`);
        }
      }
      sections.push(`${msg.role === 'user' ? 'User' : 'AI'}: ${truncate(msg.content)}`);
    }
  }

  // Relevant from current session (older messages) - with time context
  if (context.relevantFromCurrentSession.length > 0) {
    sections.push('\n[Related content from earlier in this session]');
    for (const msg of context.relevantFromCurrentSession) {
      const timePhrase = msg.timeContext?.phrase;
      if (timePhrase && msg.timeContext?.useRememberingLanguage) {
        sections.push(`[${timePhrase}]`);
      }
      sections.push(`${msg.role === 'user' ? 'User' : 'AI'}: ${truncate(msg.content)}`);
    }
  }

  // Detected references (for AI awareness)
  if (context.detectedReferences.length > 0) {
    sections.push('\n[Detected references in user message]');
    for (const ref of context.detectedReferences) {
      sections.push(`- ${ref.type}: "${ref.text}" (${ref.confidence} confidence)`);
    }
  }

  return sections.join('\n');
}

/**
 * Build messages array with full context for AI.
 */
export function buildMessagesWithFullContext(
  context: RetrievedContext,
  currentMessage: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // Add conversation history (full, not limited)
  for (const msg of context.conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // If we have relevant context from retrieval, inject it
  const retrievedContext = formatRetrievedContext({
    ...context,
    conversationHistory: [], // Don't duplicate history
    preSessionMessages: context.conversationHistory.length === 0 ? context.preSessionMessages : [],
  });

  // Add current message with retrieved context
  if (retrievedContext.trim()) {
    messages.push({
      role: 'user',
      content: `[Retrieved context:\n${retrievedContext}]\n\n${currentMessage}`,
    });
  } else {
    messages.push({ role: 'user', content: currentMessage });
  }

  return messages;
}
