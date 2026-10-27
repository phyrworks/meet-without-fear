/**
 * Memory Formatter Service
 *
 * Uses Haiku to format natural language memory requests into proper memories,
 * and to process update requests. All outputs are validated against therapeutic values.
 */

import { getHaikuJson } from '../lib/bedrock';
import { logger } from '../lib/logger';
import { validateMemory } from './memory-validator';
import type {
  MemoryCategory,
  FormatMemoryResponse,
  FormattedMemorySuggestion,
  UpdateMemoryAIResponse,
} from '@meet-without-fear/shared';
import { BrainCallType as BrainActivityCallType } from '../generated/prisma/client';

// ============================================================================
// Types
// ============================================================================

interface HaikuFormatResponse {
  valid: boolean;
  content?: string;
  category?: string;
  scope?: string;
  reasoning?: string;
  rejectionReason?: string;
}

interface HaikuUpdateResponse {
  valid: boolean;
  updatedContent?: string;
  updatedCategory?: string;
  changesSummary?: string;
  rejectionReason?: string;
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
// Format Memory (Create New)
// ============================================================================

/**
 * Format a natural language memory request into a proper memory.
 * Validates against therapeutic values.
 * All memories are global (no session-scoped memories).
 */
export async function formatMemoryRequest(
  userInput: string
): Promise<FormatMemoryResponse> {
  const logPrefix = '[Memory Formatter]';

  logger.info(`${logPrefix} Formatting user input: "${userInput.substring(0, 100)}..."`);

  if (!userInput || userInput.trim().length < 3) {
    return {
      valid: false,
      rejectionReason: 'Please provide more detail about what you want remembered.',
    };
  }

  const systemPrompt = `You are a memory formatting assistant for a therapeutic conversation app.
Your job is to convert natural language requests into structured memories that the AI will honor.

VALID CATEGORIES:
- AI_NAME: User wants to give the AI a name ("Call you Alex")
- LANGUAGE: Language preferences ("Respond in Spanish")
- COMMUNICATION: Communication style ("Keep responses brief", "Be more casual")
- PERSONAL_INFO: User's personal info ("My name is Sam", "I use they/them")
- RELATIONSHIP: Facts about user's relationship ("Partner's name is Jordan")
- PREFERENCE: Other preferences ("Use examples", "Don't use analogies")

NOTE: All memories are global and apply to all sessions.

REJECTION CRITERIA - MUST REJECT if request:
- Asks AI to be aggressive, hostile, or harsh
- Asks AI to always agree or take sides
- Asks AI to skip emotional processing ("just give solutions")
- Contains negative characterizations of partner ("remember they're a narcissist")
- Undermines therapeutic neutrality
- Is inappropriate or offensive

OUTPUT FORMAT (JSON only, no markdown):
{
  "valid": true/false,
  "content": "Formatted memory statement (if valid)",
  "category": "CATEGORY_NAME",
  "reasoning": "Why this format/category was chosen",
  "rejectionReason": "Why rejected (if invalid)"
}`;

  const userPrompt = `Format this memory request: "${userInput}"

Note: This memory will apply globally to all sessions.`;

  // Generate synthetic IDs for standalone memory formatting
  const syntheticSessionId = 'memory-format';
  const syntheticTurnId = `memory-format-${Date.now()}`;

  try {
    const response = await getHaikuJson<HaikuFormatResponse>({
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 512,
      sessionId: syntheticSessionId,
      operation: 'memory-format',
      turnId: syntheticTurnId,
      callType: BrainActivityCallType.MEMORY_FORMATTING,
    });

    logger.info(`${logPrefix} Haiku response:`, JSON.stringify(response, null, 2));

    if (!response) {
      return {
        valid: false,
        rejectionReason: 'Unable to process your request. Please try again.',
      };
    }

    // Handle rejection from Haiku
    if (!response.valid || !response.content) {
      return {
        valid: false,
        rejectionReason: response.rejectionReason ||
          'This request conflicts with our therapeutic approach.',
      };
    }

    // Validate category
    const category = normalizeCategory(response.category || '');
    if (!category) {
      logger.warn(`${logPrefix} Invalid category from Haiku: ${response.category}`);
      return {
        valid: false,
        rejectionReason: 'Unable to categorize this memory. Please rephrase.',
      };
    }

    // Run through memory validator for double-check
    const validationResult = await validateMemory(response.content, category, { useAI: true });
    if (!validationResult.valid) {
      logger.info(`${logPrefix} Validation failed: ${validationResult.reason}`);
      return {
        valid: false,
        rejectionReason: validationResult.reason ||
          'This memory conflicts with our therapeutic values.',
      };
    }

    const suggestion: FormattedMemorySuggestion = {
      content: response.content,
      category,
      reasoning: response.reasoning || '',
    };

    logger.info(`${logPrefix} Successfully formatted memory:`, suggestion);

    return {
      valid: true,
      suggestion,
    };
  } catch (error) {
    logger.error(`${logPrefix} Error formatting memory:`, error);
    return {
      valid: false,
      rejectionReason: 'An error occurred. Please try again.',
    };
  }
}

// ============================================================================
// Update Memory (AI-assisted edit)
// ============================================================================

/**
 * Process a natural language update request for an existing memory.
 * Validates the updated content against therapeutic values.
 */
export async function processMemoryUpdate(
  originalContent: string,
  originalCategory: MemoryCategory,
  changeRequest: string
): Promise<UpdateMemoryAIResponse> {
  const logPrefix = '[Memory Formatter]';

  logger.info(`${logPrefix} Processing update request:`, {
    original: originalContent,
    changeRequest: changeRequest.substring(0, 100),
  });

  if (!changeRequest || changeRequest.trim().length < 3) {
    return {
      valid: false,
      originalContent,
      originalCategory,
      rejectionReason: 'Please describe how you want to change this memory.',
    };
  }

  const systemPrompt = `You are a memory update assistant for a therapeutic conversation app.
Your job is to apply a user's change request to an existing memory.

VALID CATEGORIES:
- AI_NAME: User wants to give the AI a name
- LANGUAGE: Language preferences
- COMMUNICATION: Communication style
- PERSONAL_INFO: User's personal info
- RELATIONSHIP: Facts about user's relationship
- PREFERENCE: Other preferences

REJECTION CRITERIA - MUST REJECT if the updated memory would:
- Ask AI to be aggressive, hostile, or harsh
- Ask AI to always agree or take sides
- Ask AI to skip emotional processing
- Contain negative characterizations of partner
- Undermine therapeutic neutrality
- Be inappropriate or offensive

OUTPUT FORMAT (JSON only, no markdown):
{
  "valid": true/false,
  "updatedContent": "The updated memory (if valid)",
  "updatedCategory": "CATEGORY_NAME (if changed, otherwise same as original)",
  "changesSummary": "Brief description of what changed",
  "rejectionReason": "Why rejected (if invalid)"
}`;

  const userPrompt = `Current memory: "${originalContent}"
Category: ${originalCategory}

User's change request: "${changeRequest}"

Apply the requested changes while keeping the memory clear and concise.`;

  // Generate synthetic IDs for standalone memory update
  const syntheticSessionId = 'memory-update';
  const syntheticTurnId = `memory-update-${Date.now()}`;

  try {
    const response = await getHaikuJson<HaikuUpdateResponse>({
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 512,
      sessionId: syntheticSessionId,
      operation: 'memory-update',
      turnId: syntheticTurnId,
      callType: BrainActivityCallType.MEMORY_FORMATTING,
    });

    logger.info(`${logPrefix} Haiku update response:`, JSON.stringify(response, null, 2));

    if (!response) {
      return {
        valid: false,
        originalContent,
        originalCategory,
        rejectionReason: 'Unable to process your request. Please try again.',
      };
    }

    // Handle rejection from Haiku
    if (!response.valid || !response.updatedContent) {
      return {
        valid: false,
        originalContent,
        originalCategory,
        rejectionReason: response.rejectionReason ||
          'This change conflicts with our therapeutic approach.',
      };
    }

    // Validate category (use original if not changed)
    const updatedCategory = response.updatedCategory
      ? normalizeCategory(response.updatedCategory) || originalCategory
      : originalCategory;

    // Run through memory validator for double-check
    const validationResult = await validateMemory(response.updatedContent, updatedCategory, { useAI: true });
    if (!validationResult.valid) {
      logger.info(`${logPrefix} Validation failed: ${validationResult.reason}`);
      return {
        valid: false,
        originalContent,
        originalCategory,
        rejectionReason: validationResult.reason ||
          'This update conflicts with our therapeutic values.',
      };
    }

    logger.info(`${logPrefix} Successfully processed update:`, {
      updatedContent: response.updatedContent,
      updatedCategory,
      changesSummary: response.changesSummary,
    });

    return {
      valid: true,
      originalContent,
      originalCategory,
      updatedContent: response.updatedContent,
      updatedCategory,
      changesSummary: response.changesSummary,
    };
  } catch (error) {
    logger.error(`${logPrefix} Error processing update:`, error);
    return {
      valid: false,
      originalContent,
      originalCategory,
      rejectionReason: 'An error occurred. Please try again.',
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeCategory(category: string): MemoryCategory | null {
  const upper = category.toUpperCase().replace(/\s+/g, '_');
  if (VALID_CATEGORIES.includes(upper as MemoryCategory)) {
    return upper as MemoryCategory;
  }
  return null;
}
