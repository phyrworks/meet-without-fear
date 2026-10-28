/**
 * Background Classifier Service
 *
 * Consolidates multiple background Haiku calls into a single call for better
 * latency, cost, and coherence. Used by Inner Thoughts to run non-blocking
 * classification tasks after the response is sent.
 *
 * Consolidates:
 * - Memory intent detection
 * - Theme extraction for embedding
 * - Session metadata update (title, mood, topics)
 * - Summary update
 */

import { logger } from '../lib/logger';
import { getHaikuJson, BrainActivityCallType } from '../lib/bedrock';
import { withHaikuCircuitBreaker } from '../utils/circuit-breaker';
import type { MemorySuggestion, MemoryCategory } from '@meet-without-fear/shared';
import { prisma } from '../lib/prisma';
import { embedInnerWorkSessionContent } from './embedding';

// ============================================================================
// Types
// ============================================================================

/** A categorized fact from the fact-ledger */
export interface CategorizedFact {
  category: string;
  fact: string;
}

export interface BackgroundClassifierResult {
  memoryIntent: {
    detected: boolean;
    suggestedMemory?: string;
    category?: MemoryCategory;
    confidence: 'high' | 'medium' | 'low';
    evidence?: string;
  };
  themes: string[];
  sessionMetadata: {
    title?: string;
    mood?: string;
    topics?: string[];
  };
  summary?: string;
  /** Notable facts about the user's situation, emotions, and circumstances (categorized) */
  notableFacts?: CategorizedFact[];
}

export interface BackgroundClassifierInput {
  /** The user's message to analyze */
  userMessage: string;
  /** Recent conversation history for context */
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Session ID for logging */
  sessionId: string;
  /** User ID for database updates */
  userId: string;
  /** Turn ID for cost attribution */
  turnId: string;
  /** Current session title (if any) */
  currentTitle?: string;
  /** Current session summary (if any) */
  currentSummary?: string;
  /** Existing notable facts (to update/consolidate) */
  existingFacts?: string[];
}

// ============================================================================
// Constants
// ============================================================================

const VALID_CATEGORIES: MemoryCategory[] = [
  'AI_NAME',
  'LANGUAGE',
  'COMMUNICATION',
  'PERSONAL_INFO',
  'RELATIONSHIP',
  'PREFERENCE',
];

// ============================================================================
// Classifier
// ============================================================================

/** Valid categories for notable facts */
const VALID_FACT_CATEGORIES = ['People', 'Logistics', 'Conflict', 'Emotional', 'History'];

/**
 * Build the unified classification prompt.
 */
function buildClassifierPrompt(input: BackgroundClassifierInput): string {
  const { userMessage, conversationHistory, currentTitle, currentSummary, existingFacts } = input;

  // Format conversation history
  const historyText = conversationHistory
    .slice(-5)
    .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
    .join('\n');

  // Format existing facts if any
  const existingFactsText =
    existingFacts && existingFacts.length > 0
      ? `CURRENT NOTABLE FACTS:\n${existingFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
      : 'CURRENT NOTABLE FACTS: (none yet)';

  return `Analyze this Inner Thoughts conversation and provide:

1. MEMORY INTENT: Only if user EXPLICITLY asks to remember something using words like "remember", "always", "from now on"
2. THEMES: 2-3 key themes being explored
3. SESSION METADATA: Title (if ${currentTitle ? 'needs update' : 'not yet set'}), mood, topics
4. SUMMARY: Brief 1-2 sentence summary of the session focus
5. NOTABLE FACTS: Categorized facts about the user's situation

CONVERSATION:
${historyText}

CURRENT MESSAGE:
User: ${userMessage}

${currentTitle ? `Current Title: ${currentTitle}` : ''}
${currentSummary ? `Current Summary: ${currentSummary}` : ''}

${existingFactsText}

MEMORY INTENT RULES - BE CONSERVATIVE:
- ONLY detect if user uses explicit memory-request language: "remember", "always", "from now on", "going forward"
- DO NOT flag normal sharing of information, feelings, or preferences
- Categories: AI_NAME, LANGUAGE, COMMUNICATION, PERSONAL_INFO, RELATIONSHIP, PREFERENCE

NOTABLE FACTS EXTRACTION:
Maintain a curated list of CATEGORIZED facts about the user's situation. Output the COMPLETE updated list.

CATEGORIES (use these exact names):
- People: names, roles, relationships mentioned
- Logistics: scheduling, location, practical circumstances
- Conflict: specific disagreements, triggers, patterns
- Emotional: feelings, frustrations, fears, hopes
- History: past events, relationship timeline, backstory

RULES:
- Each fact MUST have a category and fact text
- Keep facts concise (1 sentence each)
- Update/replace outdated facts with newer information
- Soft limit: 15-20 facts. If exceeding, consolidate/merge similar facts
- Output the FULL list each time (not just new facts)

OUTPUT JSON only:
{
  "memoryIntent": {
    "detected": boolean,
    "suggestedMemory": "what to remember (only if detected=true)",
    "category": "category (only if detected=true)",
    "confidence": "high|medium|low",
    "evidence": "quote from message (only if detected=true)"
  },
  "themes": ["theme1", "theme2"],
  "sessionMetadata": {
    "title": "short descriptive title or null",
    "mood": "emotional tone (e.g., anxious, reflective, processing)",
    "topics": ["topic1", "topic2"]
  },
  "summary": "Brief summary of what user is processing",
  "notableFacts": [
    { "category": "People", "fact": "..." },
    { "category": "Emotional", "fact": "..." }
  ]
}`;
}

/**
 * Normalize the classifier response
 */
function normalizeResult(raw: unknown): BackgroundClassifierResult {
  const result = raw as Record<string, unknown>;

  // Normalize memory intent
  const memoryIntent = result.memoryIntent as Record<string, unknown> | undefined;
  const category = memoryIntent?.category as string | undefined;
  const normalizedCategory =
    category && VALID_CATEGORIES.includes(category.toUpperCase() as MemoryCategory)
      ? (category.toUpperCase() as MemoryCategory)
      : undefined;

  // Normalize notable facts to CategorizedFact[] format
  const rawFacts = result.notableFacts;
  let notableFacts: CategorizedFact[] | undefined;
  if (Array.isArray(rawFacts)) {
    notableFacts = rawFacts
      .filter((f): f is { category: string; fact: string } => {
        // Validate shape: must have category and fact strings
        if (typeof f !== 'object' || f === null) return false;
        const obj = f as Record<string, unknown>;
        return (
          typeof obj.category === 'string' &&
          typeof obj.fact === 'string' &&
          obj.category.trim().length > 0 &&
          obj.fact.trim().length > 0
        );
      })
      .map(f => ({
        // Normalize category to title case if it's a known category
        category: VALID_FACT_CATEGORIES.find(c => c.toLowerCase() === f.category.toLowerCase()) || f.category.trim(),
        fact: f.fact.trim(),
      }))
      .slice(0, 20); // Limit to 20 facts
  }

  return {
    memoryIntent: {
      detected: Boolean(memoryIntent?.detected),
      suggestedMemory: memoryIntent?.suggestedMemory as string | undefined,
      category: normalizedCategory,
      confidence: (['high', 'medium', 'low'].includes(memoryIntent?.confidence as string)
        ? memoryIntent?.confidence
        : 'low') as 'high' | 'medium' | 'low',
      evidence: memoryIntent?.evidence as string | undefined,
    },
    themes: Array.isArray(result.themes)
      ? (result.themes as string[]).filter((t): t is string => typeof t === 'string')
      : [],
    sessionMetadata: {
      title: (result.sessionMetadata as Record<string, unknown>)?.title as string | undefined,
      mood: (result.sessionMetadata as Record<string, unknown>)?.mood as string | undefined,
      topics: Array.isArray((result.sessionMetadata as Record<string, unknown>)?.topics)
        ? ((result.sessionMetadata as Record<string, unknown>)?.topics as string[]).filter(
            (t): t is string => typeof t === 'string',
          )
        : undefined,
    },
    summary: result.summary as string | undefined,
    notableFacts,
  };
}

/**
 * Run the consolidated background classifier.
 * This is a fire-and-forget function - errors are logged but not thrown.
 */
export async function runBackgroundClassifier(
  input: BackgroundClassifierInput,
): Promise<BackgroundClassifierResult | null> {
  const logPrefix = '[BackgroundClassifier]';

  try {
    logger.info(`${logPrefix} Starting classification for session ${input.sessionId}`);

    const systemPrompt = `CRITICAL: You are a classification engine. Output ONLY valid JSON. No conversational text, no empathy, no advice, no preamble. Your ENTIRE response must be a single JSON object.

You are an AI assistant analyzing an Inner Thoughts (self-reflection) session.
Your job is to:
1. Extract themes and suggest session metadata
2. Detect ONLY explicit memory requests
3. Extract notable facts about the user's situation and emotions
Be conservative with memory detection - most messages are NOT memory requests.
Output only valid JSON.`;

    const userPrompt = buildClassifierPrompt(input);

    // Use circuit breaker to prevent blocking
    // Fallback returns undefined for facts (caller can preserve existing facts)
    const fallback: BackgroundClassifierResult = {
      memoryIntent: { detected: false, confidence: 'low' },
      themes: [],
      sessionMetadata: {},
      notableFacts: undefined, // On failure, don't overwrite existing facts
    };

    const result = await withHaikuCircuitBreaker(
      async () => {
        return await getHaikuJson<Record<string, unknown>>({
          systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          maxTokens: 1024, // Increased to accommodate notable facts
          sessionId: input.sessionId,
          turnId: input.turnId,
          operation: 'background-classifier',
          callType: BrainActivityCallType.BACKGROUND_CLASSIFICATION,
        });
      },
      null,
      'background-classifier',
    );

    if (!result) {
      logger.warn(`${logPrefix} Haiku timed out or returned null`);
      return fallback;
    }

    const normalized = normalizeResult(result);
    logger.info(`${logPrefix} Classification complete:`, {
      memoryDetected: normalized.memoryIntent.detected,
      themes: normalized.themes,
      hasMetadata: Boolean(normalized.sessionMetadata.title),
      factsCount: normalized.notableFacts?.length ?? 0,
    });

    // Trigger session content embedding (fire-and-forget)
    // Per fact-ledger architecture, we embed at session level after summary/facts update
    embedInnerWorkSessionContent(input.sessionId, input.turnId).catch((err: unknown) =>
      logger.warn(`${logPrefix} Failed to embed session content:`, err),
    );

    return normalized;
  } catch (error) {
    logger.error(`${logPrefix} Classification failed:`, error);
    return null;
  }
}

/**
 * Apply the classifier results to the database.
 * Updates session metadata and potentially creates a memory suggestion.
 */
export async function applyClassifierResults(
  sessionId: string,
  results: BackgroundClassifierResult,
): Promise<{ memorySuggestion?: MemorySuggestion }> {
  const output: { memorySuggestion?: MemorySuggestion } = {};

  try {
    // Update session metadata if we have new data
    const updateData: Record<string, string | null> = {};

    if (results.sessionMetadata.title) {
      updateData.title = results.sessionMetadata.title;
    }
    if (results.summary) {
      updateData.summary = results.summary;
    }
    if (results.themes.length > 0) {
      updateData.theme = results.themes[0];
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.reflection.update({
        where: { id: sessionId },
        data: updateData,
      });
    }

    // Create memory suggestion if detected
    if (results.memoryIntent.detected && results.memoryIntent.suggestedMemory && results.memoryIntent.category) {
      output.memorySuggestion = {
        suggestedContent: results.memoryIntent.suggestedMemory,
        category: results.memoryIntent.category,
        confidence: results.memoryIntent.confidence,
        evidence: results.memoryIntent.evidence || '',
      };
    }
  } catch (error) {
    logger.error('[BackgroundClassifier] Failed to apply results:', error);
  }

  return output;
}
