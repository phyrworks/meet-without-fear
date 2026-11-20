/**
 * Context types for the Neural Monitor dashboard: the backend's MonitorContext (routes/brain.ts), the structure of
 * an assembled context bundle — counts, roles, instants, stages, intent, the emotional numbers — and never a word
 * a user or the AI wrote, nor any memory (owner decision, work-k5fk.9: "close all").
 */

// ============================================================================
// Context Message Types
// ============================================================================

export interface ContextMessage {
  role: 'user' | 'assistant';
  timestamp: string;
  /** The turn's length; its text is never sent. */
  chars: number;
}

// ============================================================================
// Emotional Thread Types
// ============================================================================

export interface EmotionalThread {
  initialIntensity: number | null;
  currentIntensity: number | null;
  trend: 'escalating' | 'stable' | 'de-escalating' | 'unknown';
  notableShifts: Array<{
    turn: number;
    from: number;
    to: number;
  }>;
}

// ============================================================================
// Prior Themes Types
// ============================================================================

export interface PriorThemes {
  /** How many themes the prior sessions carried; the themes themselves are never sent. */
  themeCount: number;
  lastSessionDate: string | null;
  sessionCount: number;
}

// ============================================================================
// Inner Thoughts Types
// ============================================================================

export interface InnerThoughtsContext {
  relevantReflections: Array<{
    similarity: number;
    isFromLinkedSession: boolean;
  }>;
  hasLinkedSession: boolean;
}

// ============================================================================
// Memory Intent Types
// ============================================================================

export type MemoryIntent =
  | 'emotional_validation'
  | 'stage_enforcement'
  | 'recall_commitment'
  | 'offer_continuity'
  | 'avoid_recall';

export type RetrievalDepth = 'none' | 'minimal' | 'light' | 'full';

export type SurfaceStyle = 'silent' | 'tentative' | 'explicit';

export interface MemoryIntentResult {
  intent: MemoryIntent;
  depth: RetrievalDepth;
  reason: string;
  threshold: number;
  maxCrossSession: number;
  allowCrossSession: boolean;
  surfaceStyle: SurfaceStyle;
}

// ============================================================================
// Context Bundle (Main Type)
// ============================================================================

export interface ContextBundle {
  // Conversation context
  conversationContext: {
    recentTurns: ContextMessage[];
    turnCount: number;
    sessionDurationMinutes: number;
    timeSinceLastUserTurnMs?: number | null;
  };

  // Emotional state
  emotionalThread: EmotionalThread;

  // Prior session context
  priorThemes?: PriorThemes;

  // Inner Thoughts reflections
  innerThoughtsContext?: InnerThoughtsContext;

  // Stage-specific data
  stageContext: {
    stage: number;
    /** The prompt owner's reached milestones: key → reachedAt ISO. */
    milestones: Record<string, string>;
  };

  /** Whether the session has a confirmed topic frame (its text is never sent). */
  hasTopicFrame: boolean;

  // User info
  userName: string;
  partnerName?: string;

  // Metadata
  intent: MemoryIntentResult;
  assembledAt: string;
}

// ============================================================================
// API Response Type
// ============================================================================

export interface ContextUserData {
  userId: string;
  userName: string;
  context: ContextBundle;
}

export interface ContextResponse {
  sessionId: string;
  sessionType: 'partner' | 'inner_thoughts';
  assembledAt: string;
  users: ContextUserData[];
}
