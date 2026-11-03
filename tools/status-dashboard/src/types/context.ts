/**
 * Context types for the Neural Monitor dashboard.
 * These mirror the backend ContextBundle types for displaying assembled AI context.
 */

// ============================================================================
// Context Message Types
// ============================================================================

export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
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
    triggerSummary?: string;
  }>;
}

// ============================================================================
// Session Summary Types
// ============================================================================

export interface SessionSummaryContext {
  keyThemes: string[];
  emotionalJourney: string;
  currentFocus: string;
  userStatedGoals: string[];
}

// ============================================================================
// Prior Themes Types
// ============================================================================

export interface PriorThemes {
  themes: string[];
  lastSessionDate: string | null;
  sessionCount: number;
}

// ============================================================================
// Inner Thoughts Types
// ============================================================================

export interface InnerThoughtsContext {
  relevantReflections: Array<{
    content: string;
    similarity: number;
    isFromLinkedSession: boolean;
  }>;
  hasLinkedSession: boolean;
}

// ============================================================================
// User Memories Types
// ============================================================================

export interface UserMemoriesContext {
  global: Array<{ content: string; category: string }>;
  session: Array<{ content: string; category: string }>;
}

// ============================================================================
// Notable Facts Types
// ============================================================================

export interface CategorizedFact {
  category: string;
  fact: string;
}

// ============================================================================
// Global Facts Types
// ============================================================================

export interface GlobalFact {
  category: string;
  fact: string;
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
  };

  // Emotional state
  emotionalThread: EmotionalThread;

  // Prior session context
  priorThemes?: PriorThemes;

  // Global facts across all sessions
  globalFacts?: GlobalFact[];

  // Session summary
  sessionSummary?: SessionSummaryContext;

  // Inner Thoughts reflections
  innerThoughtsContext?: InnerThoughtsContext;

  // User memories
  userMemories?: UserMemoriesContext;

  // Notable facts from this session
  notableFacts?: CategorizedFact[];

  // Stage-specific data
  stageContext: {
    stage: number;
    /** The prompt owner's reached milestones: key → reachedAt ISO. */
    milestones: Record<string, string>;
  };

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
