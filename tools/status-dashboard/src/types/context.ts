/**
 * Context types for the Neural Monitor dashboard: the backend's MonitorContext (routes/brain.ts), each participant's
 * context structure read on the monitor's own connection — stage, milestones, turn count, latest mood intensity and
 * the memory intent. Never the AI's context bundle, its text or its memory (review r1 F3, work-k5fk.9).
 */

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
// Monitor Context
// ============================================================================

export interface MonitorContext {
  stage: number;
  /** Milestone key → reachedAt ISO. */
  milestones: Record<string, string>;
  turnCount: number;
  latestIntensity: number | null;
  intent: MemoryIntentResult;
  assembledAt: string;
}

// ============================================================================
// API Response Type
// ============================================================================

export interface ContextUserData {
  userId: string;
  userName: string;
  context: MonitorContext;
}

export interface ContextResponse {
  sessionId: string;
  sessionType: 'partner' | 'inner_thoughts';
  assembledAt: string;
  users: ContextUserData[];
}
