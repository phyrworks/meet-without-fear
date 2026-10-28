/**
 * Retrieval Planner Service
 *
 * Uses Haiku to plan what data should be retrieved for the current turn.
 * The planner outputs structured JSON that is validated against the retrieval contract.
 *
 * From retrieval-contracts.md:
 * "The retrieval planner (Claude 3.5 Haiku) outputs structured JSON that is validated before execution."
 */

import { z } from 'zod';
import { getHaikuJson, BrainActivityCallType } from '../lib/bedrock';
import { logger } from '../lib/logger';
import { withHaikuCircuitBreaker } from '../utils/circuit-breaker';

// ============================================================================
// Retrieval Query Schema (from retrieval-contracts.md)
// ============================================================================

/**
 * Valid query sources
 */
const QuerySourceSchema = z.enum(['structured', 'vector', 'metadata']);
/**
 * All valid retrieval query shapes
 * These are the ONLY queries that can be executed
 */
const RetrievalQuerySchema = z.discriminatedUnion('type', [
  // Metadata queries (Stage 0+)
  z.object({ type: z.literal('session_metadata'), source: z.literal('metadata') }),
  z.object({ type: z.literal('relationship_metadata'), source: z.literal('metadata') }),
  z.object({ type: z.literal('session_outcomes'), source: z.literal('structured') }),

  // User Vessel queries (Stage 1+)
  z.object({
    type: z.literal('user_event'),
    vessel: z.literal('user'),
    source: QuerySourceSchema,
    userId: z.string(),
  }),
  z.object({
    type: z.literal('emotional_reading'),
    vessel: z.literal('user'),
    source: QuerySourceSchema,
    userId: z.string(),
  }),
  z.object({
    type: z.literal('need'),
    vessel: z.literal('user'),
    source: QuerySourceSchema,
    userId: z.string(),
  }),
  z.object({
    type: z.literal('boundary'),
    vessel: z.literal('user'),
    source: z.literal('structured'),
    userId: z.string(),
  }),

  // Shared Vessel queries (Stage 2+)
  z.object({
    type: z.literal('consented_content'),
    vessel: z.literal('shared'),
    source: z.literal('structured'),
    consentActive: z.literal(true),
  }),
  z.object({
    type: z.literal('common_ground'),
    vessel: z.literal('shared'),
    source: z.literal('structured'),
  }),
  z.object({
    type: z.literal('agreement'),
    vessel: z.literal('shared'),
    source: z.literal('structured'),
  }),
  z.object({
    type: z.literal('micro_experiment'),
    vessel: z.literal('shared'),
    source: z.literal('structured'),
  }),

  // Global queries (Stage 4 only)
  z.object({
    type: z.literal('experiment_suggestion'),
    vessel: z.literal('global'),
    source: z.literal('vector'),
  }),
]);

export type RetrievalQuery = z.infer<typeof RetrievalQuerySchema>;

/**
 * Schema for the full retrieval plan
 */
const RetrievalPlanSchema = z.object({
  queries: z.array(RetrievalQuerySchema),
  reasoning: z.string().optional(),
});

export type RetrievalPlan = z.infer<typeof RetrievalPlanSchema>;

// ============================================================================
// Stage Contract Validation
// ============================================================================

/**
 * Validate that a query is allowed for the given stage
 */
export function validateStageContract(query: RetrievalQuery, stage: number, currentUserId: string): boolean {
  // Stage 0: Only metadata and outcomes
  if (stage === 0) {
    return (
      query.type === 'session_metadata' || query.type === 'relationship_metadata' || query.type === 'session_outcomes'
    );
  }

  // Stage 1: User's own data only, no shared vessel
  if (stage === 1) {
    // No shared vessel access
    if ('vessel' in query && query.vessel === 'shared') {
      return false;
    }
    // Must be user's own data
    if ('userId' in query && query.userId !== currentUserId) {
      return false;
    }
    return true;
  }

  // Stage 2: User's own data + consented shared content
  if (stage === 2) {
    // User vessel: must be current user
    if ('vessel' in query && query.vessel === 'user') {
      return 'userId' in query && query.userId === currentUserId;
    }
    // Shared vessel: consented content, common ground, agreement allowed
    if ('vessel' in query && query.vessel === 'shared') {
      if (query.type === 'consented_content') {
        return 'consentActive' in query && query.consentActive === true;
      }
      return query.type === 'common_ground' || query.type === 'agreement';
    }
    // Metadata always allowed
    if (query.type === 'session_metadata' || query.type === 'relationship_metadata') {
      return true;
    }
    return false;
  }

  // Stage 3: Similar to Stage 2 + needs
  if (stage === 3) {
    // User vessel needs: must be current user
    if (query.type === 'need' && 'vessel' in query && query.vessel === 'user') {
      return 'userId' in query && query.userId === currentUserId;
    }
    // Shared vessel
    if ('vessel' in query && query.vessel === 'shared') {
      if (query.type === 'common_ground') return true;
      if (query.type === 'consented_content') {
        return 'consentActive' in query && query.consentActive === true;
      }
    }
    return false;
  }

  // Stage 4: Shared vessel + global suggestions
  if (stage === 4) {
    // Shared vessel structured queries
    if ('vessel' in query && query.vessel === 'shared') {
      if (query.type === 'agreement' || query.type === 'common_ground') return true;
      if (query.type === 'consented_content') {
        return 'consentActive' in query && query.consentActive === true;
      }
      if (query.type === 'micro_experiment') {
        return query.source === 'structured';
      }
    }
    // Global library vector search allowed
    if (query.type === 'experiment_suggestion') {
      return query.vessel === 'global' && query.source === 'vector';
    }
    return false;
  }

  return false;
}

// ============================================================================
// Retrieval Planning
// ============================================================================

/**
 * Plan what data to retrieve for the current turn.
 * Uses Haiku for fast, structured output.
 */
export async function planRetrieval(
  stage: number,
  userId: string,
  sessionId: string,
  turnId: string,
  userMessage: string,
  memoryIntent: string,
): Promise<RetrievalPlan> {
  // Build the planning prompt
  const systemPrompt = buildPlanningPrompt(stage, userId);
  const userPrompt = buildUserPrompt(userMessage, memoryIntent, stage);

  // Get structured plan from Haiku with circuit breaker protection
  const fallbackPlan: RetrievalPlan = { queries: [], reasoning: 'Fallback: Haiku unavailable or timed out' };

  const rawPlan = await withHaikuCircuitBreaker(
    async () => {
      return await getHaikuJson<RetrievalPlan>({
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 512,
        sessionId,
        turnId,
        operation: 'retrieval-planning',
        callType: BrainActivityCallType.RETRIEVAL_PLANNING,
        ownContent: true, // R40: the caller's own content only
      });
    },
    fallbackPlan,
    'planRetrieval',
  );

  // If Haiku fails, return empty plan (fallback)
  if (!rawPlan) {
    logger.warn('[Retrieval Planner] Haiku unavailable, using empty plan');
    return fallbackPlan;
  }

  // Validate schema first
  const schemaResult = RetrievalPlanSchema.safeParse(rawPlan);
  if (!schemaResult.success) {
    logger.warn('[Retrieval Planner] Schema validation failed, using empty plan:', schemaResult.error);
    return fallbackPlan;
  }

  // Validate the plan against stage contract
  const validated = validateRetrievalPlan(schemaResult.data, stage, userId);

  return validated;
}

/**
 * Validate and filter a retrieval plan
 */
export function validateRetrievalPlan(plan: RetrievalPlan, stage: number, userId: string): RetrievalPlan {
  const validQueries: RetrievalQuery[] = [];
  const invalidCount = { schema: 0, contract: 0 };

  for (const query of plan.queries) {
    // Validate schema
    const schemaResult = RetrievalQuerySchema.safeParse(query);
    if (!schemaResult.success) {
      logger.warn('[Retrieval Planner] Schema validation failed:', query);
      invalidCount.schema++;
      continue;
    }

    // Validate stage contract
    if (!validateStageContract(schemaResult.data, stage, userId)) {
      logger.warn('[Retrieval Planner] Stage contract violation:', query);
      invalidCount.contract++;
      continue;
    }

    validQueries.push(schemaResult.data);
  }

  // Log violations for monitoring
  if (invalidCount.schema > 0 || invalidCount.contract > 0) {
    logger.info(
      `[Retrieval Planner] Filtered ${invalidCount.schema} schema + ${invalidCount.contract} contract violations from ${plan.queries.length} queries`,
    );
  }

  return {
    queries: validQueries,
    reasoning: plan.reasoning,
  };
}

/**
 * Build the system prompt for retrieval planning
 */
function buildPlanningPrompt(stage: number, userId: string): string {
  return `You are a retrieval planner for the Meet Without Fear conflict resolution system.
Your job is to decide what data should be retrieved to help respond to the user's message.

CRITICAL RULES:
1. Output ONLY valid JSON matching the schema below
2. Only output query types that are allowed for Stage ${stage}
3. For user data, always use userId: "${userId}"
4. When uncertain, output fewer queries (minimal context is better than wrong context)
5. If no retrieval is needed, output an empty queries array

VALID QUERY TYPES FOR STAGE ${stage}:
${getValidQueryTypesForStage(stage)}

OUTPUT SCHEMA:
{
  "queries": [
    // Array of query objects matching the allowed types
  ],
  "reasoning": "Brief explanation of why these queries are needed"
}

Example output:
{
  "queries": [
    { "type": "emotional_reading", "vessel": "user", "source": "structured", "userId": "${userId}" }
  ],
  "reasoning": "User seems activated, checking emotional history"
}`;
}

/**
 * Get valid query types description for a stage
 */
function getValidQueryTypesForStage(stage: number): string {
  if (stage === 0) {
    return `- { "type": "session_metadata", "source": "metadata" }
- { "type": "relationship_metadata", "source": "metadata" }
- { "type": "session_outcomes", "source": "structured" }`;
  }

  if (stage === 1) {
    return `- { "type": "session_metadata", "source": "metadata" }
- { "type": "emotional_reading", "vessel": "user", "source": "structured", "userId": "<user_id>" }
- { "type": "user_event", "vessel": "user", "source": "structured"|"vector", "userId": "<user_id>" }
- { "type": "need", "vessel": "user", "source": "structured", "userId": "<user_id>" }
NOTE: Only the user's own data. No partner data. No shared vessel.`;
  }

  if (stage === 2) {
    return `- All Stage 1 queries (user's own data)
- { "type": "consented_content", "vessel": "shared", "source": "structured", "consentActive": true }
- { "type": "common_ground", "vessel": "shared", "source": "structured" }
NOTE: Shared content only if consent is active.`;
  }

  if (stage === 3) {
    return `- { "type": "need", "vessel": "user", "source": "structured", "userId": "<user_id>" }
- { "type": "consented_content", "vessel": "shared", "source": "structured", "consentActive": true }
- { "type": "common_ground", "vessel": "shared", "source": "structured" }`;
  }

  if (stage === 4) {
    return `- { "type": "common_ground", "vessel": "shared", "source": "structured" }
- { "type": "agreement", "vessel": "shared", "source": "structured" }
- { "type": "micro_experiment", "vessel": "shared", "source": "structured" }
- { "type": "experiment_suggestion", "vessel": "global", "source": "vector" }
NOTE: No user vessel queries. Focus on shared decisions and agreements.`;
  }

  return 'Unknown stage - output empty queries array';
}

/**
 * Build the user prompt for retrieval planning
 */
function buildUserPrompt(userMessage: string, memoryIntent: string, stage: number): string {
  return `MEMORY INTENT: ${memoryIntent}
STAGE: ${stage}
USER MESSAGE: "${userMessage}"

Based on the memory intent and user message, plan what data (if any) should be retrieved.
Output valid JSON only.`;
}

/**
 * Get mock retrieval plan for development without Haiku
 */
export function getMockRetrievalPlan(stage: number, userId: string): RetrievalPlan {
  // Minimal retrieval based on stage
  if (stage === 0) {
    return {
      queries: [{ type: 'session_metadata', source: 'metadata' }],
      reasoning: 'Mock: Stage 0 metadata only',
    };
  }

  if (stage === 1) {
    return {
      queries: [{ type: 'emotional_reading', vessel: 'user', source: 'structured', userId }],
      reasoning: 'Mock: Stage 1 emotional context',
    };
  }

  // Stage 2+
  return {
    queries: [
      { type: 'emotional_reading', vessel: 'user', source: 'structured', userId },
      { type: 'common_ground', vessel: 'shared', source: 'structured' },
    ],
    reasoning: 'Mock: Stage 2+ with shared context',
  };
}
