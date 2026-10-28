/**
 * Token Budget Calculator
 *
 * Estimates token usage and helps manage context window size.
 * Uses conservative estimates based on Claude tokenization patterns.
 *
 * Key insight: Average English word ≈ 1.3 tokens
 * Conservative estimate: 4 characters ≈ 1 token
 */

import { logger } from '../lib/logger';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Model context limits
 * - Sonnet v2: 200k tokens input, but we'll be conservative
 * - For smooth operation, we target staying well under limits
 */
export const MODEL_LIMITS = {
  /** Maximum input tokens we'll use (leaving headroom) */
  maxInputTokens: 150_000,

  /** Reserved for system prompt */
  systemPromptBudget: 4_000,

  /** Reserved for AI response */
  outputReservation: 4_000,

  /** Target max for context injection */
  contextBudget: 40_000,
};

/**
 * Recommended limits per context type.
 * These are designed to balance relevance vs. token cost.
 */
export const CONTEXT_LIMITS = {
  /** Maximum recent conversation messages to include */
  maxConversationMessages: 32,

  /** Maximum characters per conversation message */
  maxMessageLength: 2_000,

  /** Maximum messages from other sessions (via embedding retrieval) */
  maxCrossSessionMessages: 10,

  /** Maximum messages from earlier in current session (via retrieval) */
  maxCurrentSessionRetrieved: 5,

  /** Maximum pre-session messages */
  maxPreSessionMessages: 10,
};

export const CONTEXT_WINDOW = {
  recentTurnsWithSummary: 12,
  recentTurnsWithoutSummary: 16,
};

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count for a string.
 * Uses conservative heuristic: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Conservative: 4 chars/token. Actual is usually 3.5-4.5 depending on content.
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a message array.
 */
export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  let tokens = 0;
  for (const msg of messages) {
    // Add overhead for role markup (~4 tokens per message)
    tokens += 4;
    tokens += estimateTokens(msg.content);
  }
  return tokens;
}

/**
 * Trim conversation history to the most recent N turns.
 */
export function trimConversationHistory<T extends { role: 'user' | 'assistant'; content: string }>(
  messages: T[],
  maxTurns: number,
): { trimmed: T[]; truncated: number } {
  if (messages.length === 0 || maxTurns <= 0) {
    return { trimmed: [], truncated: messages.length };
  }

  const maxMessages = maxTurns * 2;
  if (messages.length <= maxMessages) {
    return { trimmed: messages, truncated: 0 };
  }

  const trimmed = messages.slice(-maxMessages);
  return { trimmed, truncated: messages.length - trimmed.length };
}

// ============================================================================
// Context Budget Management
// ============================================================================

export interface ContextBudget {
  totalAvailable: number;
  systemPrompt: number;
  conversationHistory: number;
  retrievedContext: number;
  remaining: number;
}

export interface BudgetedContext {
  /** Messages to include in conversation history */
  conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }>;

  /** Retrieved context (formatted string) */
  retrievedContext: string;

  /** Tokens used by conversation history */
  conversationTokens: number;

  /** Tokens used by retrieved context */
  retrievedTokens: number;

  /** Total tokens used */
  totalTokens: number;

  /** Messages that were truncated/excluded */
  truncated: number;
}

/**
 * Calculate how many messages from conversation history to include.
 *
 * Strategy:
 * - Always include at least the last 4 messages for context continuity
 * - Include more if budget allows
 * - Prioritize recent messages
 */
export function calculateMessageBudget(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  minMessages: number = 4,
): { included: number; tokens: number } {
  if (messages.length === 0) {
    return { included: 0, tokens: 0 };
  }

  // Start from the most recent and work backwards
  let tokens = 0;
  let included = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content) + 4; // +4 for role overhead

    // Always include minimum messages, even if over budget
    if (included < minMessages) {
      tokens += msgTokens;
      included++;
      continue;
    }

    // For additional messages, check if we have budget
    if (tokens + msgTokens <= maxTokens) {
      tokens += msgTokens;
      included++;
    } else {
      break; // No more budget
    }
  }

  return { included, tokens };
}

/**
 * Build context within token budget.
 *
 * STRICT TOKEN EVICTION HIERARCHY (drop from bottom up):
 * 1. System/Stage Prompts (NEVER DROP - highest priority)
 * 2. Recent History (Last 10 turns - PROTECT)
 * 3. Retrieved Cross-Session Memories (Drop first if needed)
 * 4. Oldest Session History (Drop first)
 *
 * This ensures critical context (recent conversation, system prompts) is always preserved.
 *
 * @param systemPrompt - The system prompt being used
 * @param conversationHistory - Full conversation history
 * @param retrievedContext - Formatted retrieved context string
 * @param maxTotalTokens - Maximum tokens to use (default: MODEL_LIMITS.contextBudget)
 */
export function buildBudgetedContext<T extends { role: 'user' | 'assistant'; content: string }>(
  systemPrompt: string,
  conversationHistory: T[],
  retrievedContext: string,
  maxTotalTokens: number = MODEL_LIMITS.contextBudget,
): BudgetedContext {
  const systemTokens = estimateTokens(systemPrompt);
  const availableForContext = maxTotalTokens - systemTokens - MODEL_LIMITS.outputReservation;

  // STRICT HIERARCHY: Protect last N turns at all costs
  const PROTECTED_TURNS = 8;
  const PROTECTED_MESSAGES = PROTECTED_TURNS * 2; // user + assistant pairs

  // Split conversation into protected (last 10 turns) and evictable (older)
  const protectedMessages = conversationHistory.slice(-PROTECTED_MESSAGES);
  const evictableMessages = conversationHistory.slice(0, -PROTECTED_MESSAGES);

  // Calculate tokens for protected messages (these are NEVER dropped)
  const protectedTokens = estimateMessagesTokens(protectedMessages);

  // Remaining budget after protecting recent history
  const remainingBudget = availableForContext - protectedTokens;

  // Allocate remaining budget: 60% to older conversation, 40% to retrieved context
  // If we're over budget, retrieved context gets dropped first (lowest priority)
  const olderConversationBudget = Math.floor(remainingBudget * 0.6);
  const retrievedBudget = Math.floor(remainingBudget * 0.4);

  // Calculate how many older messages to include
  const olderConversationPlan = calculateMessageBudget(evictableMessages, olderConversationBudget, 0);
  const includedOlderMessages = evictableMessages.slice(-olderConversationPlan.included);

  // Combine protected + older messages
  const includedMessages = [...includedOlderMessages, ...protectedMessages];

  // Truncate retrieved context if needed (lowest priority - drop first)
  let finalRetrievedContext = retrievedContext;
  let retrievedTokens = estimateTokens(retrievedContext);
  let truncatedRetrieved = false;

  if (retrievedTokens > retrievedBudget) {
    // Truncate retrieved context to fit budget
    const maxChars = retrievedBudget * 4; // Rough character limit
    finalRetrievedContext = truncateContextIntelligently(retrievedContext, maxChars);
    retrievedTokens = estimateTokens(finalRetrievedContext);
    truncatedRetrieved = true;
  }

  // If still over budget after truncating retrieved context, drop oldest conversation
  const totalUsed = protectedTokens + olderConversationPlan.tokens + retrievedTokens;
  let finalIncludedMessages = includedMessages;
  let truncatedConversation = 0;

  if (totalUsed > availableForContext) {
    // We're still over budget - drop oldest messages (but keep protected ones)
    const overage = totalUsed - availableForContext;
    const overageMessages = Math.ceil(overage / 50); // Rough estimate: ~50 tokens per message

    // Drop from the oldest (beginning of includedOlderMessages)
    finalIncludedMessages = [...includedOlderMessages.slice(overageMessages), ...protectedMessages];
    truncatedConversation = overageMessages;
  }

  const finalConversationTokens = estimateMessagesTokens(finalIncludedMessages);
  const totalTokens = systemTokens + finalConversationTokens + retrievedTokens;
  const totalTruncated = evictableMessages.length - includedOlderMessages.length + truncatedConversation;

  if (totalTruncated > 0 || truncatedRetrieved) {
    logger.info(
      `[TokenBudget] Truncated: ${totalTruncated} conversation messages, ` +
        `${truncatedRetrieved ? 'retrieved context' : 'none'} | ` +
        `Protected: ${protectedMessages.length} messages (last ${PROTECTED_TURNS} turns)`,
    );
  }

  return {
    conversationMessages: finalIncludedMessages,
    retrievedContext: finalRetrievedContext,
    conversationTokens: finalConversationTokens,
    retrievedTokens,
    totalTokens,
    truncated: totalTruncated,
  };
}

/**
 * Truncate context string intelligently, trying to preserve complete sections.
 */
function truncateContextIntelligently(context: string, maxChars: number): string {
  if (context.length <= maxChars) {
    return context;
  }

  // Try to break at section boundaries (=== headers)
  const sections = context.split(/(?=^===)/m);

  let result = '';
  for (const section of sections) {
    if (result.length + section.length <= maxChars) {
      result += section;
    } else if (result.length === 0) {
      // First section is too long, truncate it
      result = section.slice(0, maxChars - 50) + '\n[...truncated for length]';
      break;
    } else {
      // Add truncation notice
      result += '\n[...additional context truncated for length]';
      break;
    }
  }

  return result;
}

// ============================================================================
// Recommendations
// ============================================================================

/**
 * Get recommended limits based on current usage patterns.
 *
 * These are evidence-based recommendations:
 * - Conversation: 20-30 messages gives great context without bloat
 * - Cross-session: 5-10 semantically similar messages is usually enough
 * - Pre-session: 5-10 messages captures recent routing context
 */
export function getRecommendedLimits(): {
  conversationMessages: { min: number; recommended: number; max: number };
  crossSessionMessages: { min: number; recommended: number; max: number };
  currentSessionRetrieved: { min: number; recommended: number; max: number };
  preSessionMessages: { min: number; recommended: number; max: number };
  rationale: string;
} {
  return {
    conversationMessages: {
      min: 4,
      recommended: 20,
      max: 50,
    },
    crossSessionMessages: {
      min: 3,
      recommended: 5,
      max: 10,
    },
    currentSessionRetrieved: {
      min: 3,
      recommended: 5,
      max: 10,
    },
    preSessionMessages: {
      min: 3,
      recommended: 5,
      max: 10,
    },
    rationale: `
CONVERSATION HISTORY (20 recommended, max 50):
- Most recent messages are critical for maintaining conversational flow
- 20 messages (~10 turns) gives excellent context for emotional continuity
- Beyond 30-40, diminishing returns on relevance
- Always include at least 4 for basic turn continuity

CROSS-SESSION RETRIEVAL (5 recommended, max 10):
- These are semantically similar, so quality > quantity
- 5 high-similarity matches usually capture key patterns
- More risks injecting tangentially related but distracting content
- Stage-dependent: Stage 1 uses 0-3, Stage 3-4 uses up to 10

CURRENT SESSION RETRIEVAL (5 recommended):
- Catches relevant earlier content not in recent window
- Helpful for long sessions where early context matters
- 5 is usually enough since it's topically focused

PRE-SESSION MESSAGES (5 recommended, max 10):
- Captures routing context before session assignment
- Important for invitation phase and session discovery
- Expires after 24h so usually small set
    `.trim(),
  };
}
