/**
 * AI Service
 *
 * Provides AI-powered responses for the Meet Without Fear process.
 * Uses the AI Orchestrator for the full pipeline:
 * - Memory Intent → Context Assembly → Retrieval Planning → Response Generation
 *
 * Two-model stratification:
 * - Haiku: Fast mechanics (retrieval planning, classification)
 * - Sonnet: Empathetic user-facing responses
 */

import { getCompletion, resetBedrockClient, getBedrockClient } from '../lib/bedrock';
import { orchestrateResponse, type OrchestratorContext, type OrchestratorResult } from './ai-orchestrator';

// ============================================================================
// Types
// ============================================================================

export interface WitnessContext {
  userName: string;
  sessionContext?: string;
  turnCount: number;
  emotionalIntensity?: number;
  priorThemes?: string[];
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Extended context for full orchestration
 */
export interface FullAIContext extends WitnessContext {
  sessionId: string;
  userId: string;
  /**
   * Unique identifier for this user action/turn.
   * Format: `${sessionId}-${turnCount}` for chat messages.
   * All AI operations triggered by this turn should use the same turnId for cost attribution.
   */
  turnId: string;
  partnerName?: string;
  stage: number;
  sessionDurationMinutes?: number;
  isFirstTurnInSession?: boolean;
  /** Whether we're in the invitation crafting phase (stage 0, before partner joins) */
  isInvitationPhase?: boolean;
  /** Whether this is the first turn after advancing to a new stage (stage transition intro) */
  isStageTransition?: boolean;
  /** The stage we just transitioned from (for context gathering) */
  previousStage?: number;
  /** Current empathy draft (for refinement in Stage 2) */
  currentEmpathyDraft?: string | null;
  /** Whether the user is actively refining their empathy draft */
  isRefiningEmpathy?: boolean;
  /** Shared context from partner (when guesser is in REFINING status from reconciler flow) */
  sharedContextFromPartner?: string | null;
  /** Whether the user is in onboarding mode (compact not yet signed) */
  isOnboarding?: boolean;
  /** Confirmed topic of the conversation (only set when topicFrameConfirmedAt is non-null) */
  topicFrame?: string | null;
  /**
   * Topic/area the subject should focus on when generating a share draft.
   * Set when user taps "Yes, help me share" in the ShareTopicDrawer.
   * The AI will use this to generate a draft focused on this specific topic.
   */
  suggestedShareFocus?: string | null;
  /**
   * Whether this is a request to generate a share draft.
   * When true, the AI should generate content focused on suggestedShareFocus
   * and include a "Review and share" action button.
   */
  isGeneratingShareDraft?: boolean;
}

// Re-export orchestrator types for convenience
export type { OrchestratorResult } from './ai-orchestrator';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Reset the client (useful for testing)
 */
export function resetAIClient(): void {
  resetBedrockClient();
}

// ============================================================================
// Orchestrated Response (Full Pipeline)
// ============================================================================

/**
 * Get an AI response using the full orchestration pipeline.
 * This is the recommended method for production use.
 *
 * Pipeline:
 * 1. Memory Intent → determines retrieval depth
 * 2. Context Assembly → builds stage-scoped context
 * 3. Retrieval Planning (Haiku) → plans data queries
 * 4. Response Generation (Sonnet) → empathetic response
 *
 * @param messages - The conversation history
 * @param context - Full context including session/user IDs
 * @returns The orchestrator result with response and metadata
 */
export async function getOrchestratedResponse(
  messages: ConversationMessage[],
  context: FullAIContext,
): Promise<OrchestratorResult> {
  const lastMessage = messages[messages.length - 1];
  const userMessage = lastMessage?.content || '';

  const orchestratorContext: OrchestratorContext = {
    sessionId: context.sessionId,
    userId: context.userId,
    turnId: context.turnId,
    userName: context.userName,
    partnerName: context.partnerName,
    stage: context.stage,
    userMessage,
    conversationHistory: messages.slice(0, -1), // Exclude current message
    turnCount: context.turnCount,
    emotionalIntensity: context.emotionalIntensity ?? 5,
    sessionDurationMinutes: context.sessionDurationMinutes,
    isFirstTurnInSession: context.isFirstTurnInSession,
    isInvitationPhase: context.isInvitationPhase,
    isStageTransition: context.isStageTransition,
    previousStage: context.previousStage,
    currentEmpathyDraft: context.currentEmpathyDraft,
    isRefiningEmpathy: context.isRefiningEmpathy,
    sharedContextFromPartner: context.sharedContextFromPartner,
    isOnboarding: context.isOnboarding,
    topicFrame: context.topicFrame,
  };

  return orchestrateResponse(orchestratorContext);
}

// ============================================================================
// AI Service Health Check
// ============================================================================

/**
 * Check if the AI service is properly configured and accessible.
 */
export async function checkAIServiceHealth(): Promise<{
  configured: boolean;
  accessible: boolean;
  error?: string;
}> {
  const client = getBedrockClient();

  if (!client) {
    return {
      configured: false,
      accessible: false,
      error: 'AWS credentials not configured',
    };
  }

  try {
    // Make a minimal API call to verify connectivity
    // Use dummy values for health check
    const response = await getCompletion({
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 10,
      sessionId: 'health-check',
      operation: 'health-check',
      turnId: 'health-check-0',
    });

    return {
      configured: true,
      accessible: response !== null,
    };
  } catch (error) {
    return {
      configured: true,
      accessible: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
