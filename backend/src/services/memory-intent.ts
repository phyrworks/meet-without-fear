/**
 * Memory Intent Layer
 *
 * Determines what kind of remembering is appropriate before any retrieval.
 * This is the first step in the AI integration flow - it decides whether
 * and how deeply to access memory based on stage, emotional state, and context.
 *
 * From the mental model docs:
 * "Before any retrieval, the system answers: What kind of remembering is appropriate right now?"
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Memory intent types that determine retrieval depth
 */
export type MemoryIntent =
  | 'emotional_validation' // Stay present, minimal recall
  | 'stage_enforcement' // No recall, enforce rules
  | 'recall_commitment' // Full structured retrieval (e.g., "we agreed...")
  | 'offer_continuity' // Light summary of last session
  | 'avoid_recall'; // Safety mode, no retrieval

/**
 * Retrieval depth based on intent
 */
export type RetrievalDepth = 'none' | 'minimal' | 'light' | 'full';

/**
 * Context for determining memory intent
 */
export interface MemoryIntentContext {
  stage: number;
  emotionalIntensity: number;
  userMessage: string;
  turnCount: number;
  sessionDurationMinutes?: number;
  isFirstTurnInSession?: boolean;
}

/**
 * Surface style for memory-based observations
 */
export type SurfaceStyle = 'silent' | 'tentative' | 'explicit';

/**
 * Stage-aware configuration for memory retrieval
 */
export interface StageMemoryConfig {
  threshold: number; // Similarity threshold (0.45-0.70)
  maxCrossSession: number; // Max cross-session messages (0-10)
  allowCrossSession: boolean; // Whether cross-session recall is allowed
  surfaceStyle: SurfaceStyle; // How to surface patterns
}

/**
 * Result of memory intent determination
 */
export interface MemoryIntentResult {
  intent: MemoryIntent;
  depth: RetrievalDepth;
  reason: string;
  // Stage-aware configuration
  threshold: number; // 0.45-0.70 based on stage
  maxCrossSession: number; // 0-10 based on stage
  allowCrossSession: boolean; // false in Stage 1 unless explicit reference
  surfaceStyle: SurfaceStyle; // How to surface observations
}

// ============================================================================
// Pattern Detection
// ============================================================================

/**
 * Patterns that indicate user is referencing a past commitment.
 *
 * NOTE: This is a fallback for when Haiku-based detection in context-retriever
 * fails. The primary detection happens in detectReferences() which uses Haiku
 * to catch implicit patterns like "But I thought...", "I assumed...", etc.
 *
 * These explicit patterns are kept here as a safety net.
 */
const COMMITMENT_PATTERNS = [
  /we agreed/i,
  /you said/i,
  /last time/i,
  /we decided/i,
  /remember when/i,
  /our agreement/i,
  /we promised/i,
  /the experiment/i,
  /we were trying/i,
];

/**
 * Patterns that indicate high distress (beyond numerical intensity)
 */
const DISTRESS_PATTERNS = [
  /i can't do this/i,
  /i can't take/i,
  /i'm done/i,
  /i give up/i,
  /i hate/i,
  /i want to die/i, // Safety critical
  /hurt myself/i, // Safety critical
  /can't go on/i,
  /falling apart/i,
];

/**
 * Patterns that indicate user is trying to skip ahead
 */
const SKIP_PATTERNS = [
  /let's just/i,
  /can we skip/i,
  /i don't want to/i,
  /this is pointless/i,
  /just tell me what to do/i,
  /get to the point/i,
];

// ============================================================================
// Stage Configuration
// ============================================================================

/**
 * Get stage-aware configuration for memory retrieval.
 *
 * Stage 1: Conservative - high threshold, no cross-session by default
 * Stage 2: Moderate - tentative observations allowed
 * Stage 3-4: Full - explicit pattern observations with evidence
 */
export function getStageConfig(stage: number, turnCount: number): StageMemoryConfig {
  switch (stage) {
    case 1:
      return {
        threshold: 0.65,
        maxCrossSession: turnCount <= 3 ? 0 : 3,
        allowCrossSession: false,
        surfaceStyle: 'silent',
      };
    case 2:
      // Cross-session disabled until consent UI is implemented
      return {
        threshold: 0.55,
        maxCrossSession: 0, // was 5
        allowCrossSession: false, // was true
        surfaceStyle: 'tentative',
      };
    case 3:
      // Cross-session disabled until consent UI is implemented
      return {
        threshold: 0.5,
        maxCrossSession: 0, // was 10
        allowCrossSession: false, // was true
        surfaceStyle: 'explicit',
      };
    case 4:
      // Cross-session disabled until consent UI is implemented
      return {
        threshold: 0.5,
        maxCrossSession: 0, // was 10
        allowCrossSession: false, // was true
        surfaceStyle: 'explicit',
      };
    default:
      return {
        threshold: 0.6,
        maxCrossSession: 3,
        allowCrossSession: false,
        surfaceStyle: 'silent',
      };
  }
}

// ============================================================================
// Intent Determination
// ============================================================================

/**
 * Helper to build a complete MemoryIntentResult with stage config
 */
function buildResult(
  base: { intent: MemoryIntent; depth: RetrievalDepth; reason: string },
  stageConfig: StageMemoryConfig,
  overrides?: Partial<StageMemoryConfig>,
): MemoryIntentResult {
  return {
    ...base,
    threshold: overrides?.threshold ?? stageConfig.threshold,
    maxCrossSession: overrides?.maxCrossSession ?? stageConfig.maxCrossSession,
    allowCrossSession: overrides?.allowCrossSession ?? stageConfig.allowCrossSession,
    surfaceStyle: overrides?.surfaceStyle ?? stageConfig.surfaceStyle,
  };
}

/**
 * Determine what kind of memory access is appropriate for this turn.
 *
 * This is called BEFORE any retrieval to set the scope and depth.
 */
export function determineMemoryIntent(context: MemoryIntentContext): MemoryIntentResult {
  const { stage, emotionalIntensity, userMessage, turnCount, sessionDurationMinutes, isFirstTurnInSession } = context;

  // Get stage-aware config
  const stageConfig = getStageConfig(stage, turnCount);

  // Safety first: critical distress (intensity >= 9) means avoid deep recall
  // For intensities 8-9, we use a caution flag instead of hard block to allow
  // Sonnet to use memory if it helps de-escalate
  if (emotionalIntensity >= 9 || DISTRESS_PATTERNS.some(p => p.test(userMessage))) {
    return buildResult(
      {
        intent: 'avoid_recall',
        depth: 'none',
        reason: 'Critical emotional distress detected - staying present without triggering past content',
      },
      stageConfig,
      { allowCrossSession: false, maxCrossSession: 0, surfaceStyle: 'silent' },
    );
  }

  // High intensity (8-9) - minimal recall with caution flag
  // Sonnet will receive a caution_advised flag to be extra careful
  // but can still use memory if it helps de-escalate
  if (emotionalIntensity >= 8) {
    return buildResult(
      {
        intent: 'emotional_validation',
        depth: 'minimal',
        reason: 'High emotional intensity - focusing on validation with minimal context (caution advised)',
      },
      stageConfig,
      { allowCrossSession: false, maxCrossSession: 0, surfaceStyle: 'silent' },
    );
  }

  // User explicitly referencing past agreements/commitments
  if (COMMITMENT_PATTERNS.some(p => p.test(userMessage))) {
    return buildResult(
      {
        intent: 'recall_commitment',
        depth: 'full',
        reason: 'User referencing past commitment - full structured retrieval needed',
      },
      stageConfig,
      // Allow cross-session when user explicitly references past
      { allowCrossSession: true },
    );
  }

  // User trying to skip ahead
  if (SKIP_PATTERNS.some(p => p.test(userMessage))) {
    return buildResult(
      {
        intent: 'stage_enforcement',
        depth: 'none',
        reason: 'User attempting to skip stage - enforce process without deep recall',
      },
      stageConfig,
      { allowCrossSession: false, maxCrossSession: 0 },
    );
  }

  // First turn of a new session - offer continuity
  if (isFirstTurnInSession && sessionDurationMinutes === 0) {
    return buildResult(
      {
        intent: 'offer_continuity',
        depth: 'light',
        reason: 'New session start - light continuity from previous session',
      },
      stageConfig,
    );
  }

  // Stage-specific defaults
  return getDefaultIntentForStage(stage, turnCount, emotionalIntensity, stageConfig);
}

/**
 * Get default intent based on stage and turn count
 */
function getDefaultIntentForStage(
  stage: number,
  turnCount: number,
  emotionalIntensity: number,
  stageConfig: StageMemoryConfig,
): MemoryIntentResult {
  switch (stage) {
    case 0:
      // Stage 0: Onboarding - minimal recall, just metadata
      return buildResult(
        {
          intent: 'stage_enforcement',
          depth: 'minimal',
          reason: 'Stage 0 - onboarding with minimal context',
        },
        stageConfig,
        { allowCrossSession: false, maxCrossSession: 0 },
      );

    case 1:
      // Stage 1: Witnessing - stay present, minimal recall
      // Early turns especially should focus on presence
      if (turnCount <= 3 || emotionalIntensity >= 6) {
        return buildResult(
          {
            intent: 'emotional_validation',
            depth: 'minimal',
            reason: 'Stage 1 witnessing - prioritizing presence over recall',
          },
          stageConfig,
        );
      }
      return buildResult(
        {
          intent: 'emotional_validation',
          depth: 'light',
          reason: 'Stage 1 witnessing - light context for continuity',
        },
        stageConfig,
      );

    case 2:
      // Stage 2: Perspective stretch - need more context
      return buildResult(
        {
          intent: 'recall_commitment',
          depth: 'light',
          reason: 'Stage 2 perspective - context needed for empathy building',
        },
        stageConfig,
      );

    case 3:
      // Stage 3: What Matters - moderate recall
      return buildResult(
        {
          intent: 'recall_commitment',
          depth: 'full',
          reason: 'Stage 3 What Matters - full context for needs exploration',
        },
        stageConfig,
      );

    case 4:
      // Stage 4: Strategic repair - full recall for agreements
      return buildResult(
        {
          intent: 'recall_commitment',
          depth: 'full',
          reason: 'Stage 4 repair - full context for negotiation',
        },
        stageConfig,
      );

    default:
      return buildResult(
        {
          intent: 'emotional_validation',
          depth: 'minimal',
          reason: 'Unknown stage - defaulting to minimal recall',
        },
        stageConfig,
      );
  }
}

/**
 * Map intent to retrieval depth
 */
export function getRetrievalDepth(intent: MemoryIntent): RetrievalDepth {
  switch (intent) {
    case 'avoid_recall':
    case 'stage_enforcement':
      return 'none';
    case 'emotional_validation':
      return 'minimal';
    case 'offer_continuity':
      return 'light';
    case 'recall_commitment':
      return 'full';
    default:
      return 'minimal';
  }
}

/**
 * Get turn buffer size based on stage and intent
 *
 * REDUCED BUFFER SIZES (notable-facts-extraction feature):
 * Now that notable facts are extracted and maintained per-user, we can reduce
 * the conversation history buffer. Facts provide emotional context, situational
 * facts, and relationship info that would otherwise require extensive history.
 *
 * Target: 8-10 messages total (4-5 turns)
 * - Stage 1: 5 turns (witnessing needs some thread memory)
 * - Stage 2: 4 turns (empathy building is structured)
 * - Stage 3: 4 turns (need confirmation is procedural)
 * - Stage 4: 5 turns (negotiation with facts context)
 */
export function getTurnBufferSize(stage: number, intent: MemoryIntent): number {
  // No buffer for avoid_recall
  if (intent === 'avoid_recall') {
    return 0;
  }

  // Minimal buffer for stage_enforcement
  if (intent === 'stage_enforcement') {
    return 2;
  }

  // Expanded buffer sizes (prompt caching makes input tokens ~90% cheaper)
  switch (stage) {
    case 1:
      return 10; // was 5: more witnessing context helps emotional continuity
    case 2:
      return 8; // was 4: empathy building benefits from more shared context
    case 3:
      return 8; // was 4: need mapping benefits from seeing the full arc
    case 4:
      return 10; // was 5: negotiation needs full context for agreements
    default:
      return 8; // was 4
  }
}
