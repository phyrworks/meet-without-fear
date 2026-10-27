/**
 * Memory Validator Service
 *
 * Validates user memory content against therapeutic core values.
 * Rejects memories that:
 * - Conflict with therapeutic neutrality (taking sides, bias)
 * - Skip emotional work (just give solutions)
 * - Promote adversarial behavior (be aggressive)
 * - Contain negative partner characterizations
 *
 * Uses two-layer validation:
 * 1. Fast pattern-based checks for common violations
 * 2. AI-based validation (Haiku) for nuanced detection
 */

import { MemoryCategory } from 'shared';
import { getHaikuJson } from '../lib/bedrock';
import { withHaikuCircuitBreaker } from '../utils/circuit-breaker';
import { BrainCallType as BrainActivityCallType } from '../generated/prisma/client';

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

// ============================================================================
// Validation Constants
// ============================================================================

const MAX_MEMORY_LENGTH = 500;
const MIN_MEMORY_LENGTH = 2;

/**
 * Patterns that are not allowed in memories (technical/security)
 */
const BLOCKED_PATTERNS = [
  // Empty or whitespace-only
  /^\s*$/,
  // Potentially harmful instructions
  /ignore\s+(previous|all|safety)/i,
  /bypass\s+safety/i,
  /jailbreak/i,
  // SQL injection attempts
  /;\s*(drop|delete|insert|update)\s+/i,
  // Script injection
  /<script/i,
];

// Pattern-based validation removed - using only AI validation

// ============================================================================
// AI-Based Validation
// ============================================================================

interface AIValidationResponse {
  valid: boolean;
  reason?: string;
}

/**
 * Validate memory content using AI (Haiku) for nuanced detection.
 * Uses the same therapeutic guidance as the main conversation prompts.
 */
async function validateMemoryWithAI(
  content: string,
  category: MemoryCategory,
  sessionId?: string,
  turnId?: string,
): Promise<ValidationResult> {
  const systemPrompt = `You are a memory validator for a therapeutic conversation app.

Your job is to determine if a memory request conflicts with therapeutic values.

HANDLING INVALID MEMORY REQUESTS:
If the user has requested something to be remembered that conflicts with therapeutic values, you MUST reject it. Do NOT simply ignore it or honor the request anyway.

When evaluating a memory request:
1. Acknowledge what they're asking for
2. Determine if it conflicts with therapeutic values
3. If it does, provide a clear rejection reason

CRITICAL: Never honor requests that would:
- Request aggressive/adversarial behavior (be aggressive, be mean, be harsh)
- Request bias or taking sides (always agree with me, take my side, they're always wrong)
- Skip emotional processing (just give solutions, no feelings, skip empathy, one-word responses)
- Contain negative partner characterizations (they're manipulative, they're toxic, they're the problem)
- Undermine the therapeutic process (skip stages, make it quick, just fix it, never ask questions)

ALLOW if the memory is:
- A reasonable communication preference that doesn't prevent meaningful therapeutic work
- A personal preference that doesn't conflict with therapeutic values
- A factual statement about the user or their relationship
- A language or name preference

OUTPUT FORMAT (JSON only):
{
  "valid": true/false,
  "reason": "Brief explanation if invalid (e.g., 'This memory conflicts with maintaining a supportive and constructive environment' or 'Emotional processing is a core part of the conflict resolution process and cannot be skipped')"
}`;

  const userPrompt = `Memory content: "${content}"
Category: ${category}

Does this memory request conflict with therapeutic values?`;

  // Ensure turnId is always a string - generate synthetic if not provided
  const effectiveSessionId = sessionId || 'memory-validation';
  const effectiveTurnId = turnId || (sessionId ? `${sessionId}-${Date.now()}` : `memory-validation-${Date.now()}`);

  // Use circuit breaker to prevent slow Haiku calls from blocking the response
  // If validation times out, reject to be safe (fail-secure)
  const fallbackResult: ValidationResult = { 
    valid: false, 
    reason: 'Unable to validate this memory request. Please try again.' 
  };

  const response = await withHaikuCircuitBreaker(
    async () => {
      return await getHaikuJson<AIValidationResponse>({
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 256,
        sessionId: effectiveSessionId,
        turnId: effectiveTurnId,
        operation: 'memory-validation',
        callType: BrainActivityCallType.MEMORY_VALIDATION,
      });
    },
    null, // Fallback to null if timeout/failure
    'memory-validation'
  );

  if (!response) {
    // If AI validation fails or times out, reject to be safe
    return fallbackResult;
  }

  if (!response.valid) {
    return {
      valid: false,
      reason: response.reason || 'This memory conflicts with our therapeutic approach.',
    };
  }

  return { valid: true };
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validates memory content against therapeutic core values using AI (Haiku).
 * Only performs basic security checks (length, blocked patterns) before AI validation.
 *
 * @param content - The memory content to validate
 * @param category - The category of the memory
 * @param options - Optional parameters for AI validation
 * @returns Validation result with reason if invalid
 */
export async function validateMemory(
  content: string,
  category: MemoryCategory,
  options?: { sessionId?: string; turnId?: string; useAI?: boolean },
): Promise<ValidationResult> {
  // Check for empty content
  if (!content || content.trim().length === 0) {
    return { valid: false, reason: 'Memory content cannot be empty' };
  }

  // Check length bounds
  if (content.length < MIN_MEMORY_LENGTH) {
    return { valid: false, reason: 'Memory content is too short' };
  }

  if (content.length > MAX_MEMORY_LENGTH) {
    return { valid: false, reason: `Memory content exceeds maximum length of ${MAX_MEMORY_LENGTH} characters` };
  }

  // Check for blocked patterns (security only - not therapeutic)
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(content)) {
      return { valid: false, reason: 'Memory content contains invalid content' };
    }
  }

  // Use AI validation for all therapeutic checks
  // Default to using AI validation unless explicitly disabled
  if (options?.useAI !== false) {
    return await validateMemoryWithAI(content, category, options?.sessionId, options?.turnId);
  }

  // If AI validation is disabled, allow it (fallback for testing)
  return { valid: true };
}

/**
 * Validate multiple memories at once
 */
export async function validateMemories(
  memories: Array<{ content: string; category: MemoryCategory }>,
  options?: { sessionId?: string; turnId?: string; useAI?: boolean },
): Promise<Array<{ content: string; category: MemoryCategory; result: ValidationResult }>> {
  const results = await Promise.all(
    memories.map(async ({ content, category }) => ({
      content,
      category,
      result: await validateMemory(content, category, options),
    })),
  );
  return results;
}

/**
 * Check if a memory is potentially problematic (needs review)
 * Returns true for edge cases that might warrant human review
 */
export function needsReview(_content: string, _category: MemoryCategory): boolean {
  // AI validation handles this now, so this is always false
  return false;
}
