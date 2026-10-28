/**
 * Stream Turn Background Jobs
 *
 * The fire-and-forget tail of a streaming chat turn, extracted
 * (behavior-preserving) from `sendMessageStream`: the session
 * summary + embedding refresh and the partner session classifier.
 *
 * This function is deliberately synchronous and returns void. It schedules
 * work and returns immediately, exactly as the inline block did — the
 * controller must not await it, or the `complete` frame would be held back
 * behind a classifier round trip.
 *
 * Both jobs are skipped for dispatch messages (system responses, not user
 * conversation) and in mock-LLM mode.
 */

import { logger } from '../lib/logger';
import { loadOwnNotableFacts } from './participant-memory';
import { isMockLLMEnabled } from '../lib/bedrock';
import { embedSessionContent } from './embedding';
import { updateSessionSummary } from './conversation-summarizer';
import { runPartnerSessionClassifier, ensureFactIds, CategorizedFactWithId } from './partner-session-classifier';

export interface StreamTurnBackgroundParams {
  requestId: string;
  sessionId: string;
  userId: string;
  turnId: string;
  /** True when a dispatch tag produced the response. */
  isDispatchMessage: boolean;
  /** The user's message content for this turn. */
  content: string;
  /** Chronological recent history; the classifier reads the last 5 entries. */
  history: Array<{ role: string; content: string }>;
  partnerName: string | undefined;
}

export function scheduleStreamTurnBackgroundJobs(params: StreamTurnBackgroundParams): void {
  const { requestId, sessionId, userId, turnId, isDispatchMessage, content, history, partnerName } = params;

  if (isDispatchMessage) {
    logger.info(`[sendMessageStream:${requestId}] Skipping background tasks for dispatch message`);
    return;
  }

  if (isMockLLMEnabled()) {
    logger.info(`[sendMessageStream:${requestId}] Skipping background tasks in mock LLM mode`);
    return;
  }

  // Summarize and embed session content for cross-session retrieval
  // Per fact-ledger architecture, we embed at session level after summary updates
  updateSessionSummary(sessionId, userId, turnId)
    .then(() => embedSessionContent(sessionId, userId, turnId))
    .catch((err: unknown) => logger.warn(`[sendMessageStream:${requestId}] Failed to update summary/embedding:`, err));

  // Run partner session classifier (fire-and-forget)
  // This extracts notable facts and detects memory intents
  logger.info(`[sendMessageStream:${requestId}] 🚀 Triggering background classification...`);
  (async () => {
    try {
      // Fetch existing facts for the classifier: the participant's own
      // ai_memory NOTABLE_FACTS document (`{ facts: [...] }`; TS-9/TS-12).
      const storedFacts = await loadOwnNotableFacts(sessionId, userId);
      // Extract existing facts with IDs for diff-based updates
      // Legacy facts (without IDs) get UUIDs assigned via ensureFactIds
      const existingFactsWithIds: CategorizedFactWithId[] = (() => {
        const facts = storedFacts;
        if (!facts) return [];
        if (Array.isArray(facts)) {
          // Check if it's CategorizedFact[] or CategorizedFactWithId[] format
          if (facts.length > 0 && typeof facts[0] === 'object' && 'fact' in facts[0]) {
            // New format with category/fact (may or may not have IDs)
            return ensureFactIds(facts as CategorizedFactWithId[]);
          }
          // Old format: string[] - convert to CategorizedFactWithId
          return ensureFactIds(
            facts.filter((f): f is string => typeof f === 'string').map(f => ({ category: 'Unknown', fact: f })),
          );
        }
        return [];
      })();

      const result = await runPartnerSessionClassifier({
        userMessage: content,
        conversationHistory: history.slice(-5).map(m => ({
          role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
          content: m.content,
        })),
        sessionId,
        userId,
        turnId,
        partnerName,
        existingFactsWithIds,
      });

      logger.info(`[sendMessageStream:${requestId}] ✅ Classification finished:`, {
        factsCount: result?.notableFacts?.length ?? 0,
        topicContext: result?.topicContext?.substring(0, 50),
      });
    } catch (err) {
      logger.error(`[sendMessageStream:${requestId}] ❌ Classification failed:`, err);
    }
  })();
}
