/**
 * Memory Detector Service
 *
 * Uses Haiku to detect implicit memory requests in user messages.
 * Detects patterns like "I'll call you X", language preferences,
 * communication style preferences, and relationship context.
 */

import { getHaikuJson } from '../lib/bedrock';
import { logger } from '../lib/logger';
import { withHaikuCircuitBreaker, HAIKU_TIMEOUT_MS } from '../utils/circuit-breaker';
import type { MemoryDetectionResult, MemoryCategory } from 'shared';
import { BrainActivityCallType } from '../generated/prisma/client';

// ============================================================================
// Types
// ============================================================================

/**
 * Raw detection result from Haiku (matches expected JSON output)
 */
interface HaikuDetectionResponse {
  hasMemoryIntent: boolean;
  suggestions: Array<{
    suggestedContent: string;
    category: string;
    confidence: string;
    evidence: string;
  }>;
  topicContext: string;
}

// ============================================================================
// Detection Prompt
// ============================================================================

/**
 * Build the detection prompt for Haiku
 */
function buildDetectionPrompt(
  message: string,
  recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  let contextSection = '';

  if (recentMessages && recentMessages.length > 0) {
    // Include last 3-5 messages for context (enough to resolve pronouns and references)
    const contextMessages = recentMessages.slice(-5);
    contextSection = '\n\nRECENT CONVERSATION CONTEXT:\n';
    contextMessages.forEach(msg => {
      const roleLabel = msg.role === 'user' ? 'User' : 'AI';
      contextSection += `${roleLabel}: ${escapeForPrompt(msg.content)}\n`;
    });
    contextSection += '\nUse this context to resolve pronouns and references.';
  }

  return `Analyze this message for explicit memory requests - ONLY when the user DIRECTLY ASKS you to remember something.

THIS IS A THERAPY/MEDIATION CONTEXT. Users share personal information as part of conversation, NOT as memory requests. Be EXTREMELY conservative.

ONLY DETECT if the user uses EXPLICIT memory-request language:
- "Remember that..." or "Remember this..."
- "Always remember..." or "Never forget..."
- "From now on..." or "Going forward..."
- "I'll call you X" or "Can I call you X" (explicit AI naming)
- "Call me X" (direct instruction about their name)
- "My pronouns are..." or "Use X pronouns for me"

ABSOLUTELY DO NOT DETECT (even if sharing personal information):
- Information shared during normal conversation: "My brother Jason doesn't respect my boundaries" = just sharing, NOT a memory request
- Desires or wishes: "I want him to respect me", "I wish she would listen" = expressing feelings, NOT asking you to remember
- Facts about relationships: "My partner is Sarah", "I have two kids" = contextual info, NOT memory requests
- Emotional expressions: "I feel hurt", "I'm frustrated with..." = sharing feelings, NOT memory requests
- One-time requests: "Can you...", "Could you...", "Would you..." = single conversation requests
- Statements about preferences: "I prefer X over Y" = just stating preference, NOT asking to remember

THE KEY TEST: Did the user use words like "remember", "always", "from now on", "going forward"? 
If not, it's almost certainly NOT a memory request. Default to hasMemoryIntent: false.

CATEGORIES (only when EXPLICIT memory-request language is present):
- AI_NAME: Only "I'll call you X", "Can I call you Y" with explicit naming intent
- LANGUAGE: Only explicit "Please respond in [language] from now on"
- COMMUNICATION: Only explicit "Always keep responses brief", "From now on be more casual"
- PERSONAL_INFO: Only explicit "Call me X", "My pronouns are X, please use them"
- RELATIONSHIP: Only explicit "Remember that my partner's name is X"
- PREFERENCE: Only explicit "From now on, don't use analogies"

Be EXTREMELY conservative. When in doubt, hasMemoryIntent = false.${contextSection}

User message: "${escapeForPrompt(message)}"

OUTPUT JSON only (no markdown):
{
  "hasMemoryIntent": boolean,
  "suggestions": [
    {
      "suggestedContent": "Remember to...",
      "category": "AI_NAME|LANGUAGE|COMMUNICATION|PERSONAL_INFO|RELATIONSHIP|PREFERENCE",
      "confidence": "high|medium|low",
      "evidence": "What in the message suggests this"
    }
  ],
  "topicContext": "What user was discussing (for returning to topic)"
}`;
}

/**
 * Escape special characters for prompt inclusion
 */
function escapeForPrompt(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ============================================================================
// Category Validation
// ============================================================================

const VALID_CATEGORIES: MemoryCategory[] = [
  'AI_NAME',
  'LANGUAGE',
  'COMMUNICATION',
  'PERSONAL_INFO',
  'RELATIONSHIP',
  'PREFERENCE',
];

const VALID_CONFIDENCES = ['high', 'medium', 'low'] as const;

/**
 * Validate and normalize a category string to MemoryCategory
 */
function normalizeCategory(category: string): MemoryCategory | null {
  const upper = category.toUpperCase();
  if (VALID_CATEGORIES.includes(upper as MemoryCategory)) {
    return upper as MemoryCategory;
  }
  return null;
}

/**
 * Validate and normalize confidence
 */
function normalizeConfidence(confidence: string): 'high' | 'medium' | 'low' {
  const lower = confidence.toLowerCase();
  if (VALID_CONFIDENCES.includes(lower as (typeof VALID_CONFIDENCES)[number])) {
    return lower as 'high' | 'medium' | 'low';
  }
  // Default to medium for unknown confidence
  return 'medium';
}

// ============================================================================
// Main Detection Function
// ============================================================================

/**
 * Detect memory intent in a user message using Haiku.
 *
 * @param message - The user's message to analyze
 * @param sessionId - Optional session ID for context (not used in current implementation)
 * @param turnId - Optional turn ID for logging
 * @param context - Optional context label for logging (e.g., 'partner-session', 'inner-thoughts')
 * @param recentMessages - Optional recent conversation history to provide context for resolving pronouns and references
 * @returns Detection result with any memory suggestions found
 */
export async function detectMemoryIntent(
  message: string,
  sessionId?: string,
  turnId?: string,
  context: string = 'unknown',
  recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<MemoryDetectionResult> {
  const logPrefix = `[Memory Detector][${context}]`;

  // Skip detection for null/undefined/very short messages
  if (!message || message.trim().length < 3) {
    logger.info(`${logPrefix} Skipping - message missing or too short (${message?.trim().length || 0} chars)`);
    return {
      hasMemoryIntent: false,
      suggestions: [],
      topicContext: '',
    };
  }

  const contextInfo = recentMessages ? ` with ${recentMessages.length} recent messages for context` : '';
  logger.info(
    `${logPrefix} Starting detection for message (${message.length} chars)${contextInfo}: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`,
  );

  const systemPrompt = `You are a memory detection assistant in a therapy/mediation context. 
ONLY detect EXPLICIT memory requests where the user DIRECTLY asks you to remember something using words like "remember", "always", "from now on", "going forward".
DO NOT flag normal conversation, emotional sharing, or information given as context.
Be EXTREMELY conservative - when in doubt, return hasMemoryIntent: false.
Output only valid JSON with no markdown formatting or extra text.`;

  const userPrompt = buildDetectionPrompt(message, recentMessages);

  logger.info(`${logPrefix} Sending to Haiku...`);

  // Generate synthetic turnId if not provided
  const effectiveTurnId = turnId || (sessionId ? `${sessionId}-${Date.now()}` : `memory-detection-${Date.now()}`);

  // Use circuit breaker to prevent slow Haiku calls from blocking the entire response
  const fallbackResult: MemoryDetectionResult = {
    hasMemoryIntent: false,
    suggestions: [],
    topicContext: '',
  };

  const response = await withHaikuCircuitBreaker(
    async () => {
      return await getHaikuJson<HaikuDetectionResponse>({
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 512,
        ...(context === 'inner-thoughts'
          ? { innerWorkSessionId: sessionId }
          : { sessionId }),
        turnId: effectiveTurnId,
        operation: 'memory-detection',
        callType: BrainActivityCallType.MEMORY_DETECTION,
      });
    },
    null, // Fallback to null if timeout/failure
    'memory-detection'
  );

  if (!response) {
    logger.warn(`${logPrefix} Haiku timed out or returned null, using fallback`);
    return fallbackResult;
  }

  logger.info(`${logPrefix} Haiku raw response:`, JSON.stringify(response, null, 2));

  // Validate and normalize the response
  const result = normalizeDetectionResult(response);

  logger.info(`${logPrefix} Detection result:`, {
    hasMemoryIntent: result.hasMemoryIntent,
    suggestionCount: result.suggestions.length,
    suggestions: result.suggestions.map(s => ({
      category: s.category,
      content: s.suggestedContent,
      confidence: s.confidence,
    })),
    topicContext: result.topicContext,
  });

  return result;
}

/**
 * Normalize and validate the raw detection result from Haiku
 */
function normalizeDetectionResult(raw: HaikuDetectionResponse): MemoryDetectionResult {
  const validSuggestions = (raw.suggestions || [])
    .map(suggestion => {
      const category = normalizeCategory(suggestion.category);
      if (!category) {
        logger.warn('[Memory Detector] Invalid category:', suggestion.category);
        return null;
      }

      return {
        suggestedContent: suggestion.suggestedContent || '',
        category,
        confidence: normalizeConfidence(suggestion.confidence),
        evidence: suggestion.evidence || '',
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return {
    hasMemoryIntent: raw.hasMemoryIntent === true && validSuggestions.length > 0,
    suggestions: validSuggestions,
    topicContext: raw.topicContext || '',
  };
}

// ============================================================================
// Mock Detection (for testing without Haiku)
// ============================================================================

/**
 * Pattern-based fallback detection for when Haiku is unavailable.
 * This is a simple heuristic-based approach.
 */
export function detectMemoryIntentMock(message: string): MemoryDetectionResult {
  const suggestions: MemoryDetectionResult['suggestions'] = [];
  const lowerMessage = message.toLowerCase();

  // AI_NAME patterns
  const callMeMatch = message.match(/(?:call you|i'll call you|can i call you)\s+["']?(\w+)["']?/i);
  if (callMeMatch) {
    suggestions.push({
      suggestedContent: `The user wants to call the AI "${callMeMatch[1]}"`,
      category: 'AI_NAME',
      confidence: 'high',
      evidence: callMeMatch[0],
    });
  }

  // PERSONAL_INFO patterns - match name introductions
  // "call me X", "my name is X", "I'm X" (where X is a proper name, not a state like "feeling")
  const callMeNameMatch = message.match(/call me\s+["']?([A-Z][a-zA-Z]+)["']?/i);
  const myNameIsMatch = message.match(/my name is\s+["']?([A-Z][a-zA-Z]+)["']?/i);
  // For "I'm X" or "I am X", only match if followed by a capitalized name (likely a proper noun)
  const iAmMatch = message.match(/(?:i'm|i am)\s+([A-Z][a-z]+)(?:\s|$|[.,!?])/);

  const nameMatch = callMeNameMatch || myNameIsMatch || iAmMatch;
  if (nameMatch && !lowerMessage.includes('call you')) {
    suggestions.push({
      suggestedContent: `The user's name is ${nameMatch[1]}`,
      category: 'PERSONAL_INFO',
      confidence: 'high',
      evidence: nameMatch[0],
    });
  }

  // Pronoun patterns - match various ways to express pronoun preferences
  const pronounMatch = message.match(/(?:use|my|i prefer|pronouns are|pronouns:?)\s*(he\/him|she\/her|they\/them)/i);
  if (pronounMatch) {
    suggestions.push({
      suggestedContent: `The user uses ${pronounMatch[1]} pronouns`,
      category: 'PERSONAL_INFO',
      confidence: 'high',
      evidence: pronounMatch[0],
    });
  }

  // COMMUNICATION patterns
  const shortResponsePatterns = [
    /(?:keep|make).+(?:short|brief|concise)/i,
    /(?:shorter|briefer)\s+responses?/i,
    /be\s+(?:more\s+)?(?:direct|concise|brief)/i,
    /(?:more|be)\s+casual/i,
  ];

  for (const pattern of shortResponsePatterns) {
    const match = message.match(pattern);
    if (match) {
      suggestions.push({
        suggestedContent: 'Keep responses brief and direct',
        category: 'COMMUNICATION',
        confidence: 'medium',
        evidence: match[0],
      });
      break;
    }
  }

  // RELATIONSHIP patterns - require explicit name introduction
  const partnerNameMatch = message.match(
    /(?:my partner(?:'s name)?|my (?:husband|wife|spouse|boyfriend|girlfriend)(?:'s name)?)\s+(?:is\s+)?(?:named\s+)?["']?([A-Z][a-zA-Z]+)["']?/i,
  );
  // Only match if we found a capitalized name (not just any word after "my partner")
  if (partnerNameMatch && partnerNameMatch[1]) {
    suggestions.push({
      suggestedContent: `The user's partner is named ${partnerNameMatch[1]}`,
      category: 'RELATIONSHIP',
      confidence: 'high',
      evidence: partnerNameMatch[0],
    });
  }

  // PREFERENCE patterns
  const preferencePatterns = [
    { pattern: /don't use (?:analogies|metaphors)/i, content: 'Avoid using analogies or metaphors' },
    { pattern: /(?:give|use|include)\s+(?:more\s+)?examples?/i, content: 'Include examples when explaining' },
    { pattern: /(?:don't|no)\s+(?:bullet\s+)?(?:points|lists)/i, content: 'Avoid using bullet points or lists' },
  ];

  for (const { pattern, content } of preferencePatterns) {
    const match = message.match(pattern);
    if (match) {
      suggestions.push({
        suggestedContent: content,
        category: 'PREFERENCE',
        confidence: 'medium',
        evidence: match[0],
      });
    }
  }

  return {
    hasMemoryIntent: suggestions.length > 0,
    suggestions,
    topicContext: '', // Mock doesn't infer topic context
  };
}
