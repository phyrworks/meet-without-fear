/**
 * Partner Session Background Classifier
 *
 * Extracts notable facts from partner session conversations.
 * Runs AFTER the AI response is sent to the user.
 *
 * Extracts:
 * - Topic context extraction
 * - Notable facts (facts about user's situation, emotions, circumstances)
 *
 * This mirrors the pattern from background-classifier.ts (for Inner Thoughts)
 * but is tailored for partner session context.
 */

import { randomUUID } from 'crypto';
import { getHaikuJson, BrainActivityCallType } from '../lib/bedrock';
import { logger } from '../lib/logger';
import { withHaikuCircuitBreaker } from '../utils/circuit-breaker';
import { getJobPrisma } from '../lib/prisma';
import { embedSessionContent } from './embedding';

// ============================================================================
// Types
// ============================================================================

/** A categorized fact from the fact-ledger */
export interface CategorizedFact {
  category: string;
  fact: string;
}

/** A categorized fact with a stable unique ID for diff-based updates */
export interface CategorizedFactWithId extends CategorizedFact {
  id: string;
}

/** LLM output format for diff-based fact updates */
export interface FactUpdatePayload {
  /** Facts to add (no ID) or update (with ID) */
  upsert: Array<CategorizedFact & { id?: string }>;
  /** IDs of facts to remove */
  delete: string[];
}

// ============================================================================
// Diff-Based Fact Reconciliation
// ============================================================================

/** Maximum number of facts to store per session */
const MAX_FACTS_LIMIT = 20;

/**
 * Ensure all facts have stable unique IDs.
 * Legacy facts from DB (without IDs) get UUIDs assigned.
 * Facts that already have IDs are preserved.
 */
export function ensureFactIds(
  facts: CategorizedFactWithId[] | CategorizedFact[] | null | undefined
): CategorizedFactWithId[] {
  if (!facts || !Array.isArray(facts)) {
    return [];
  }

  return facts.map((fact) => {
    const factWithId = fact as CategorizedFactWithId;
    if (factWithId.id) {
      return factWithId;
    }
    return {
      ...fact,
      id: randomUUID(),
    };
  });
}

/**
 * Apply diff-based updates to the existing facts.
 *
 * This function implements a deterministic reconciliation that:
 * 1. Creates a map of existing facts by ID
 * 2. Removes facts whose IDs are in the `delete` array
 * 3. Updates existing facts when upsert contains matching ID
 * 4. Adds new facts (generates UUID for ID-less items)
 * 5. Enforces the soft limit of 20 facts
 *
 * @param currentFacts - Current facts with IDs from the database
 * @param llmOutput - The LLM's diff payload with upsert/delete arrays
 * @returns Merged facts array ready to save to DB
 */
export function applyFactUpdates(
  currentFacts: CategorizedFactWithId[],
  llmOutput: FactUpdatePayload | null | undefined
): CategorizedFactWithId[] {
  // If no LLM output, preserve existing facts
  if (!llmOutput) {
    return currentFacts;
  }

  const { upsert = [], delete: deleteIds = [] } = llmOutput;

  // Create a map of current facts by ID for O(1) lookups
  const factMap = new Map<string, CategorizedFactWithId>();
  for (const fact of currentFacts) {
    factMap.set(fact.id, fact);
  }

  // Step 1: Remove facts marked for deletion
  for (const idToDelete of deleteIds) {
    factMap.delete(idToDelete);
  }

  // Step 2: Process upserts (updates and additions)
  for (const upsertItem of upsert) {
    // Validate the item has non-empty category and fact
    if (!upsertItem.category?.trim() || !upsertItem.fact?.trim()) {
      continue; // Skip invalid items
    }

    const normalizedItem: CategorizedFactWithId = {
      id: upsertItem.id || randomUUID(),
      category: upsertItem.category.trim(),
      fact: upsertItem.fact.trim(),
    };

    // If has ID, this is an update (overwrites existing) or add with specific ID
    // If no ID was provided, a new UUID was generated, so it's an addition
    factMap.set(normalizedItem.id, normalizedItem);
  }

  // Step 3: Convert map back to array and enforce limit
  const result = Array.from(factMap.values());

  // Enforce soft limit (keep first MAX_FACTS_LIMIT facts)
  if (result.length > MAX_FACTS_LIMIT) {
    return result.slice(0, MAX_FACTS_LIMIT);
  }

  return result;
}

export interface PartnerSessionClassifierResult {
  topicContext?: string;
  /** Notable facts about the user's situation, emotions, and circumstances (categorized) */
  notableFacts?: CategorizedFact[];
  /** Diff-based update payload (when using new format) */
  factUpdates?: FactUpdatePayload;
  /** Whether the response used the new diff-based format */
  usedDiffFormat?: boolean;
}

export interface PartnerSessionClassifierInput {
  /** The user's message to analyze */
  userMessage: string;
  /** Recent conversation history for context */
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Session ID for logging */
  sessionId: string;
  /** User ID for publishing suggestions */
  userId: string;
  /** Turn ID for cost attribution */
  turnId: string;
  /** Partner's name for context */
  partnerName?: string;
  /** @deprecated Use existingFactsWithIds for diff-based updates */
  existingFacts?: string[];
  /** Existing notable facts WITH stable IDs for diff-based updates */
  existingFactsWithIds?: CategorizedFactWithId[];
  /** Sonnet's analysis of the conversation (when available) */
  sonnetAnalysis?: string;
  /** Sonnet's response to the user (when available) */
  sonnetResponse?: string;
}

// ============================================================================
// Short ID Mapping (for token efficiency)
// ============================================================================

/** Bidirectional mapping between short IDs and full UUIDs */
export interface IdMapping {
  shortToFull: Map<string, string>;
  fullToShort: Map<string, string>;
}

/**
 * Generate a random 5-character alphanumeric short ID.
 * Uses base36 (0-9, a-z) for visually distinct, non-sequential IDs.
 * Non-sequential IDs prevent LLM pattern completion (e.g., inventing "ad0003" after "ac0002").
 * @internal Exported for testing
 */
export function generateRandomShortId(): string {
  return Math.random().toString(36).substring(2, 7);
}

/**
 * Create bidirectional mapping from full UUIDs to random short IDs.
 * This reduces token overhead in prompts and improves Haiku accuracy.
 * Random IDs force the model to copy exact strings rather than auto-complete patterns.
 * @internal Exported for testing
 */
export function createIdMapping(facts: CategorizedFactWithId[]): IdMapping {
  const shortToFull = new Map<string, string>();
  const fullToShort = new Map<string, string>();
  const usedIds = new Set<string>();

  facts.forEach((fact) => {
    let shortId = generateRandomShortId();

    // Collision check (statistically unlikely for ~20 items, but safe)
    while (usedIds.has(shortId)) {
      shortId = generateRandomShortId();
    }

    usedIds.add(shortId);
    shortToFull.set(shortId, fact.id);
    fullToShort.set(fact.id, shortId);
  });

  return { shortToFull, fullToShort };
}

/**
 * Resolve short IDs back to full UUIDs in the LLM response.
 * @internal Exported for testing
 */
export function resolveShortIds(
  factUpdates: FactUpdatePayload,
  mapping: IdMapping
): FactUpdatePayload {
  const { shortToFull } = mapping;

  return {
    upsert: factUpdates.upsert.map((item) => {
      if (item.id && shortToFull.has(item.id)) {
        return { ...item, id: shortToFull.get(item.id)! };
      }
      return item;
    }),
    delete: factUpdates.delete.map((id) => shortToFull.get(id) || id),
  };
}

// ============================================================================
// Classifier
// ============================================================================

interface BuildPromptResult {
  prompt: string;
  idMapping: IdMapping | null;
}

/**
 * Build the classification prompt for notable facts extraction.
 * Supports both legacy format (existingFacts as strings) and new diff-based format (existingFactsWithIds).
 * Returns the prompt and an ID mapping for resolving short IDs back to full UUIDs.
 */
function buildClassifierPrompt(input: PartnerSessionClassifierInput): BuildPromptResult {
  const {
    userMessage,
    conversationHistory,
    partnerName,
    existingFacts,
    existingFactsWithIds,
    sonnetAnalysis,
    sonnetResponse,
  } = input;

  // Format conversation history
  const historyText = conversationHistory
    .slice(-5)
    .map((m) => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
    .join('\n');

  const personContext = partnerName ? `Person discussed: ${partnerName}` : '';

  // Determine if we're using new diff-based format or legacy format
  const useDiffFormat = existingFactsWithIds && existingFactsWithIds.length > 0;

  // Create ID mapping for token efficiency (only for diff-based format)
  let idMapping: IdMapping | null = null;

  // Format existing facts based on format
  let existingFactsText: string;
  if (useDiffFormat) {
    // New format: use short IDs for token efficiency and better Haiku accuracy
    idMapping = createIdMapping(existingFactsWithIds);
    existingFactsText = `CURRENT NOTABLE FACTS (with IDs for reference):
${existingFactsWithIds.map((f) => `- [${idMapping!.fullToShort.get(f.id)}] ${f.category}: ${f.fact}`).join('\n')}`;
  } else if (existingFacts && existingFacts.length > 0) {
    // Legacy format: plain strings
    existingFactsText = `CURRENT NOTABLE FACTS:\n${existingFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
  } else {
    existingFactsText = 'CURRENT NOTABLE FACTS: (none yet)';
  }

  // Format Sonnet's analysis if available (Phase 5 enhancement)
  const sonnetAnalysisText = sonnetAnalysis || sonnetResponse
    ? `
SONNET'S ANALYSIS (use this to inform your fact extraction):
${sonnetAnalysis || '(no analysis available)'}

SONNET'S RESPONSE:
${sonnetResponse || '(no response available)'}

Use the analysis above to help identify facts. The analysis contains Sonnet's
interpretation of the user's situation, which can help you extract accurate facts.
`
    : '';

  // Use diff-based output format when we have facts with IDs
  if (useDiffFormat) {
    const prompt = `Update the notable facts for this conversation using DIFF-BASED updates.

CONVERSATION CONTEXT:
${personContext}

RECENT MESSAGES:
${historyText}

CURRENT MESSAGE:
User: ${userMessage}

${existingFactsText}
${sonnetAnalysisText}
YOUR TASK - DIFF-BASED NOTABLE FACTS UPDATE:
Instead of outputting the full list, output ONLY the changes needed.

CATEGORIES (use these exact names):
- People: names and ONLY explicitly stated roles/relationships
- Logistics: scheduling, location, practical circumstances
- Conflict: specific disagreements, triggers, patterns
- Emotional: feelings, frustrations, fears, hopes
- History: past events, relationship timeline, backstory

WHAT TO EXCLUDE:
- Meta-commentary about the session/process
- Questions to the AI
- Session style preferences
- Requests to "remember" things (ignore these)

CRITICAL - NEVER ASSUME:
- Do NOT assume the relationship type between the user and the person discussed
- Only record relationships the user EXPLICITLY states

RULES FOR DIFF-BASED UPDATES:
- To ADD a new fact: include it in "upsert" WITHOUT an id field
- To UPDATE an existing fact: Copy the exact 5-character ID (e.g., k9x2m) into the id field with new category/fact text
- To DELETE an outdated fact: Copy the exact ID into the "delete" array
- Facts NOT mentioned in upsert or delete are AUTOMATICALLY PRESERVED (no action needed)
- Keep facts concise (1 sentence each)
- Soft limit: 15-20 total facts. If nearing limit, delete less important facts.

OUTPUT JSON only:
{
  "topicContext": "brief description of what user is discussing",
  "upsert": [
    { "id": "k9x2m", "category": "People", "fact": "updated fact text" },
    { "category": "Emotional", "fact": "brand new fact without id" }
  ],
  "delete": ["p4r9s", "m2n8z"]
}

IMPORTANT: Only include facts that are NEW or CHANGED. Do NOT repeat unchanged facts.
If nothing needs to change, return empty arrays: { "topicContext": "...", "upsert": [], "delete": [] }`;
    return { prompt, idMapping };
  }

  // Legacy format: full list replacement (backward compatibility)
  const prompt = `Extract notable facts from this conversation.

CONVERSATION CONTEXT:
${personContext}

RECENT MESSAGES:
${historyText}

CURRENT MESSAGE:
User: ${userMessage}

${existingFactsText}
${sonnetAnalysisText}
YOUR TASK - NOTABLE FACTS EXTRACTION:
Maintain a curated list of CATEGORIZED facts about the user's situation. Output the COMPLETE updated list.

CATEGORIES (use these exact names):
- People: names and ONLY explicitly stated roles/relationships (e.g., "daughter Emma is 14", "Darryl is a person the user wants to discuss")
- Logistics: scheduling, location, practical circumstances
- Conflict: specific disagreements, triggers, patterns
- Emotional: feelings, frustrations, fears, hopes
- History: past events, relationship timeline, backstory

WHAT TO EXCLUDE:
- Meta-commentary about the session/process
- Questions to the AI
- Session style preferences
- Requests to "remember" things (ignore these)

CRITICAL - NEVER ASSUME:
- Do NOT assume the relationship type between the user and the person discussed
- The other person could be a friend, coworker, family member, roommate, romantic partner, or anyone else
- Only record relationships the user EXPLICITLY states (e.g., "my partner", "my mom", "my coworker")
- If the user hasn't stated the relationship, use neutral language like "Darryl is a person the user is discussing" or simply record the name

RULES:
- Each fact MUST have a category and fact text
- Keep facts concise (1 sentence each)
- Update/replace outdated facts with newer information
- Soft limit: 15-20 facts. If exceeding, consolidate/merge similar facts
- Output the FULL list each time (not just new facts)

OUTPUT JSON only:
{
  "topicContext": "brief description of what user is discussing",
  "notableFacts": [
    { "category": "People", "fact": "daughter Emma is 14" },
    { "category": "Emotional", "fact": "feeling overwhelmed by work demands" },
    { "category": "People", "fact": "Alex is a person the user wants to discuss (relationship not specified)" }
  ]
}`;
  return { prompt, idMapping: null };
}

/** Valid categories for notable facts */
const VALID_FACT_CATEGORIES = ['People', 'Logistics', 'Conflict', 'Emotional', 'History'];

/**
 * Normalize a fact's category to title case if it's a known category
 */
function normalizeCategory(category: string): string {
  return VALID_FACT_CATEGORIES.find(
    (c) => c.toLowerCase() === category.toLowerCase()
  ) || category.trim();
}

/**
 * Validate a fact object has required fields
 */
function isValidFact(f: unknown): f is { category: string; fact: string; id?: string } {
  if (typeof f !== 'object' || f === null) return false;
  const obj = f as Record<string, unknown>;
  return typeof obj.category === 'string' && typeof obj.fact === 'string' &&
         obj.category.trim().length > 0 && obj.fact.trim().length > 0;
}

/**
 * Normalize the classifier response.
 * Handles both new diff-based format (upsert/delete) and legacy format (notableFacts array).
 */
function normalizeResult(raw: unknown): PartnerSessionClassifierResult {
  const result = raw as Record<string, unknown>;
  const topicContext = result.topicContext as string | undefined;

  // Check if response uses new diff-based format
  const hasUpsert = Array.isArray(result.upsert);
  const hasDelete = Array.isArray(result.delete);
  const usedDiffFormat = hasUpsert || hasDelete;

  if (usedDiffFormat) {
    // New diff-based format
    const upsert = (result.upsert as unknown[] || [])
      .filter(isValidFact)
      .map((f) => ({
        ...(f.id ? { id: f.id } : {}),
        category: normalizeCategory(f.category),
        fact: f.fact.trim(),
      }));

    const deleteIds = (result.delete as unknown[] || [])
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());

    return {
      topicContext,
      factUpdates: { upsert, delete: deleteIds },
      usedDiffFormat: true,
    };
  }

  // Legacy format: full list replacement
  const rawFacts = result.notableFacts;
  let notableFacts: CategorizedFact[] | undefined;
  if (Array.isArray(rawFacts)) {
    notableFacts = rawFacts
      .filter(isValidFact)
      .map((f) => ({
        category: normalizeCategory(f.category),
        fact: f.fact.trim(),
      }))
      .slice(0, 20); // Limit to 20 facts
  }

  return {
    topicContext,
    notableFacts,
    usedDiffFormat: false,
  };
}

/**
 * Run the background classifier for partner sessions.
 * This is a fire-and-forget function - errors are logged but not thrown.
 *
 * Extracts notable facts about the user's situation and saves them to UserVessel.
 */
export async function runPartnerSessionClassifier(
  input: PartnerSessionClassifierInput
): Promise<PartnerSessionClassifierResult | null> {
  const logPrefix = '[PartnerSessionClassifier]';

  try {
    logger.info(`${logPrefix} Starting classification for session ${input.sessionId}`);

    const systemPrompt = `You are an AI assistant analyzing a conversation about interpersonal dynamics.
Your job is to extract and maintain notable facts about the user's situation.
Focus on emotional context, situational facts, and people involved.
IMPORTANT: Never assume relationship types - only record what the user explicitly states.
Output only valid JSON.`;

    const { prompt: userPrompt, idMapping } = buildClassifierPrompt(input);

    // Use circuit breaker to prevent blocking
    // Fallback returns undefined for facts (caller can preserve existing facts)
    const fallback: PartnerSessionClassifierResult = {
      notableFacts: undefined, // On failure, don't overwrite existing facts
    };

    const result = await withHaikuCircuitBreaker(
      async () => {
        return await getHaikuJson<Record<string, unknown>>({
          systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          maxTokens: 1024,
          sessionId: input.sessionId,
          turnId: input.turnId,
          operation: 'partner-session-classifier',
          callType: BrainActivityCallType.PARTNER_SESSION_CLASSIFICATION,
        });
      },
      null,
      'partner-session-classifier'
    );

    if (!result) {
      logger.warn(`${logPrefix} Haiku timed out or returned null`);
      return fallback;
    }

    let normalized = normalizeResult(result);

    // Resolve short IDs back to full UUIDs if we used diff-based format with ID mapping
    if (idMapping && normalized.usedDiffFormat && normalized.factUpdates) {
      normalized = {
        ...normalized,
        factUpdates: resolveShortIds(normalized.factUpdates, idMapping),
      };
    }

    // Determine the final facts to save based on format used
    let factsToSave: CategorizedFactWithId[] | CategorizedFact[] | undefined;

    if (normalized.usedDiffFormat && normalized.factUpdates) {
      // New diff-based format: apply reconciliation
      const existingFactsWithIds = input.existingFactsWithIds || [];
      factsToSave = applyFactUpdates(existingFactsWithIds, normalized.factUpdates);
      logger.info(`${logPrefix} Diff-based classification complete:`, {
        topicContext: normalized.topicContext?.substring(0, 50),
        upsertCount: normalized.factUpdates.upsert.length,
        deleteCount: normalized.factUpdates.delete.length,
        resultingFactsCount: factsToSave.length,
      });
    } else if (normalized.notableFacts && normalized.notableFacts.length > 0) {
      // Legacy format: full replacement (backward compatibility)
      // Assign IDs to facts for future diff-based updates
      factsToSave = ensureFactIds(normalized.notableFacts);
      logger.info(`${logPrefix} Legacy classification complete:`, {
        topicContext: normalized.topicContext?.substring(0, 50),
        factsCount: factsToSave.length,
      });
    }

    // Save notable facts as the participant's NOTABLE_FACTS document
    // (ai_memory; spec §1.1 "in practice written by mwf_job" — the job's
    // INSERT … ON CONFLICT DO UPDATE, as the SUMMARY writer does; TS-12)
    if (factsToSave && factsToSave.length > 0) {
      try {
        const job = getJobPrisma();
        const [participant] = await job.$queryRaw<Array<{ id: string }>>`SELECT id FROM participant
          WHERE session_id = ${input.sessionId}::uuid AND user_id = ${input.userId}::uuid`;
        if (participant) {
          await job.$executeRaw`INSERT INTO ai_memory (participant_id, kind, doc)
            VALUES (${participant.id}::uuid, 'NOTABLE_FACTS'::ai_memory_kind, ${JSON.stringify({ facts: factsToSave })}::jsonb)
            ON CONFLICT (participant_id, kind) DO UPDATE SET doc = EXCLUDED.doc`;
          logger.info(`${logPrefix} Saved ${factsToSave.length} notable facts for participant ${participant.id}`);

          // Trigger session content embedding (fire-and-forget)
          // Per fact-ledger architecture, we embed at session level after facts update
          embedSessionContent(input.sessionId, input.userId, input.turnId).catch((err: unknown) =>
            logger.warn(`${logPrefix} Failed to embed session content:`, err)
          );
        } else {
          logger.warn(`${logPrefix} No participant found for session=${input.sessionId}, user=${input.userId}. Facts not saved.`);
        }
      } catch (err) {
        logger.error(`${logPrefix} Failed to save notable facts:`, err);
      }
    } else if (normalized.usedDiffFormat && factsToSave?.length === 0) {
      // Diff format with no changes - still a valid response, preserve existing
      logger.info(`${logPrefix} Diff-based update with no changes, preserving existing facts`);
    }

    // For API compatibility, also return notableFacts in the result
    // Convert back to the legacy format if we used diff format
    const resultNotableFacts = factsToSave?.map(({ category, fact }) => ({ category, fact }));

    return {
      ...normalized,
      notableFacts: resultNotableFacts,
    };
  } catch (error) {
    logger.error(`${logPrefix} Classification failed:`, error);
    return null;
  }
}
