/**
 * Global Memory Service
 *
 * Consolidates session-level facts into a global user profile.
 * Per fact-ledger architecture, global facts are:
 * - Merged and deduplicated across sessions
 * - Pruned to max 50 facts (~500 tokens)
 * - Stored in User.globalFacts JSON column
 * - Injected at the top of context for all sessions
 */

import { getHaikuJson, BrainActivityCallType } from '../lib/bedrock';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { Prisma } from '../generated/prisma/client';
import { withHaikuCircuitBreaker } from '../utils/circuit-breaker';

// ============================================================================
// Types
// ============================================================================

/** A categorized fact from the fact-ledger */
export interface CategorizedFact {
  category: string;
  fact: string;
}

/** Global facts stored on User record */
export interface GlobalFacts {
  facts: CategorizedFact[];
  consolidatedAt: string;
  sessionCount: number;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_GLOBAL_FACTS = 50;

// ============================================================================
// Consolidation
// ============================================================================

/**
 * Build prompt for Haiku to consolidate facts.
 */
function buildConsolidationPrompt(
  existingGlobalFacts: CategorizedFact[],
  newSessionFacts: CategorizedFact[]
): string {
  const existingText = existingGlobalFacts.length > 0
    ? existingGlobalFacts.map((f) => `[${f.category}] ${f.fact}`).join('\n')
    : '(none)';

  const newText = newSessionFacts.length > 0
    ? newSessionFacts.map((f) => `[${f.category}] ${f.fact}`).join('\n')
    : '(none)';

  return `Consolidate these facts into a unified user profile. Maximum ${MAX_GLOBAL_FACTS} facts.

EXISTING GLOBAL FACTS:
${existingText}

NEW SESSION FACTS:
${newText}

CONSOLIDATION RULES:
1. Keep the most important, lasting facts about the user
2. Merge similar or duplicate facts into single entries
3. Update outdated facts with newer information (newer takes precedence)
4. Prioritize facts about: People (names, relationships), Emotional patterns, Conflict patterns, Key events
5. Remove session-specific details that won't be relevant in future sessions
6. Use these categories: People, Logistics, Conflict, Emotional, History
7. Keep each fact concise (1 sentence max)

OUTPUT JSON only:
{
  "consolidatedFacts": [
    { "category": "People", "fact": "..." },
    { "category": "Emotional", "fact": "..." }
  ]
}`;
}

/**
 * Normalize Haiku's consolidation response.
 */
function normalizeConsolidationResult(raw: unknown): CategorizedFact[] {
  if (!raw || typeof raw !== 'object') return [];

  const result = raw as Record<string, unknown>;
  const facts = result.consolidatedFacts;

  if (!Array.isArray(facts)) return [];

  return facts
    .filter((f): f is { category: string; fact: string } => {
      if (typeof f !== 'object' || f === null) return false;
      const obj = f as Record<string, unknown>;
      return typeof obj.category === 'string' && typeof obj.fact === 'string';
    })
    .slice(0, MAX_GLOBAL_FACTS);
}

/**
 * Consolidate global facts for a user.
 * Merges session facts into the user's global profile.
 *
 * @param userId - The user to consolidate facts for
 * @param sessionId - The session that triggered consolidation
 * @param turnId - Turn ID for cost attribution
 */
export async function consolidateGlobalFacts(
  userId: string,
  sessionId: string,
  turnId: string
): Promise<GlobalFacts | null> {
  const logPrefix = '[GlobalMemory]';

  try {
    logger.info(`${logPrefix} Starting consolidation for user ${userId}, session ${sessionId}`);

    // The user's current global facts (ai_memory GLOBAL_FACTS, user scope — spec §1.1 ai_memory)
    const existingGlobalFacts = factsOf((await loadGlobalFactsDoc(userId))?.facts);

    // The session facts of the user's participant in this session (ai_memory NOTABLE_FACTS)
    const notable = await prisma.aiMemory.findFirst({
      where: { kind: 'NOTABLE_FACTS', participant: { sessionId, userId } },
      select: { doc: true },
    });
    const sessionFacts = factsOf((notable?.doc as { facts?: unknown } | null)?.facts);

    // If no new facts and no existing facts, nothing to do
    if (sessionFacts.length === 0 && existingGlobalFacts.length === 0) {
      logger.info(`${logPrefix} No facts to consolidate`);
      return null;
    }

    // If we don't have many facts, just merge without AI
    const totalFacts = existingGlobalFacts.length + sessionFacts.length;
    let consolidatedFacts: CategorizedFact[];

    if (totalFacts <= MAX_GLOBAL_FACTS) {
      // Simple merge - no AI needed
      consolidatedFacts = [...existingGlobalFacts, ...sessionFacts];
      logger.info(`${logPrefix} Simple merge (${totalFacts} facts, no AI needed)`);
    } else {
      // Use Haiku to consolidate
      const systemPrompt = `You consolidate user facts into a unified profile. Output valid JSON only.`;
      const userPrompt = buildConsolidationPrompt(existingGlobalFacts, sessionFacts);

      const result = await withHaikuCircuitBreaker(
        async () => {
          return await getHaikuJson<Record<string, unknown>>({
            systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            maxTokens: 2048,
            sessionId,
            turnId,
            operation: 'global-facts-consolidation',
            callType: BrainActivityCallType.GLOBAL_MEMORY_CONSOLIDATION,
          });
        },
        null,
        'global-facts-consolidation'
      );

      if (!result) {
        logger.warn(`${logPrefix} Haiku consolidation failed, keeping existing facts`);
        consolidatedFacts = existingGlobalFacts;
      } else {
        consolidatedFacts = normalizeConsolidationResult(result);
        logger.info(`${logPrefix} Haiku consolidated ${totalFacts} -> ${consolidatedFacts.length} facts`);
      }
    }

    // Count sessions with facts for this user (their participants' NOTABLE_FACTS documents)
    const sessionsWithFacts = await prisma.aiMemory.count({
      where: { kind: 'NOTABLE_FACTS', participant: { userId } },
    });

    // Save as the user's GLOBAL_FACTS document (the CHECK requires `facts`)
    const globalFacts: GlobalFacts = {
      facts: consolidatedFacts,
      consolidatedAt: new Date().toISOString(),
      sessionCount: sessionsWithFacts,
    };

    await prisma.aiMemory.upsert({
      where: { userId_kind: { userId, kind: 'GLOBAL_FACTS' } },
      create: { userId, kind: 'GLOBAL_FACTS', doc: globalFacts as unknown as Prisma.InputJsonObject },
      update: { doc: globalFacts as unknown as Prisma.InputJsonObject },
    });

    logger.info(`${logPrefix} Saved ${consolidatedFacts.length} global facts for user ${userId}`);
    return globalFacts;
  } catch (error) {
    logger.error(`${logPrefix} Failed to consolidate global facts:`, error);
    return null;
  }
}

// ============================================================================
// Loading
// ============================================================================

/**
 * Load global facts for a user.
 * Returns formatted facts ready for context injection.
 */
export async function loadGlobalFacts(userId: string): Promise<CategorizedFact[] | undefined> {
  try {
    const facts = factsOf((await loadGlobalFactsDoc(userId))?.facts);
    return facts.length > 0 ? facts : undefined;
  } catch (error) {
    logger.error('[GlobalMemory] Failed to load global facts:', error);
    return undefined;
  }
}

// ============================================================================
// ai_memory documents (TS-12: `User.globalFacts` → ai_memory GLOBAL_FACTS)
// ============================================================================

/** The user's GLOBAL_FACTS document, or null. */
async function loadGlobalFactsDoc(userId: string): Promise<Partial<GlobalFacts> | null> {
  const row = await prisma.aiMemory.findUnique({
    where: { userId_kind: { userId, kind: 'GLOBAL_FACTS' } },
    select: { doc: true },
  });
  return (row?.doc as Partial<GlobalFacts> | null) ?? null;
}

/** The well-formed `{ category, fact }` entries of a stored facts array. */
function factsOf(raw: unknown): CategorizedFact[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is CategorizedFact => {
    if (typeof f !== 'object' || f === null) return false;
    const o = f as Record<string, unknown>;
    return typeof o.category === 'string' && typeof o.fact === 'string';
  });
}
