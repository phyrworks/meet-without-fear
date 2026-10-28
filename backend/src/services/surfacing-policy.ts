/**
 * Surfacing Policy Layer
 *
 * Determines when and how to surface pattern observations to users.
 * This layer enforces the therapeutic principle that Stage 1 is for
 * felt-safety and accuracy; interpretation belongs later and only by invitation.
 *
 * Key constraints:
 * - Stage 1: Never surface patterns unless user explicitly asks
 * - Stage 2: Tentative observations allowed with 2+ evidence points
 * - Stage 3-4: Explicit observations with evidence, requires consent for patterns
 */

import { SurfaceStyle } from './memory-intent';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of surfacing decision
 */
export interface SurfacingDecision {
  /** Whether to surface the observation */
  shouldSurface: boolean;
  /** How to phrase the observation */
  style: SurfaceStyle;
  /** Whether consent is required before surfacing */
  requiresConsent: boolean;
  /** Number of evidence points supporting the pattern */
  evidenceCount: number;
}

// ============================================================================
// Pattern Detection
// ============================================================================

/**
 * Patterns that indicate user is asking about their own patterns
 */
const PATTERN_REQUEST_PATTERNS = [
  /do you see a pattern/i,
  /am i always/i,
  /do i often/i,
  /is this a pattern/i,
  /what patterns/i,
  /have you noticed/i,
  /do i do this a lot/i,
  /is this similar to/i,
  /have we talked about this before/i,
  /does this come up a lot/i,
];

/**
 * Check if user is explicitly asking about patterns
 */
export function userAskedForPattern(message: string): boolean {
  return PATTERN_REQUEST_PATTERNS.some(p => p.test(message));
}

// ============================================================================
// Surfacing Decision
// ============================================================================

/**
 * Decide whether and how to surface a pattern observation.
 *
 * This function enforces therapeutic pacing:
 * - Stage 1: Never surface unless explicitly asked
 * - Stage 2: Tentative questions with 2+ evidence
 * - Stage 3-4: Explicit observations with 3+ evidence and consent
 * - Cooldown: Minimum 5 turns between surfacing to prevent nagging
 */
export function decideSurfacing(
  stage: number,
  turnCount: number,
  userAskedForPatternFlag: boolean,
  patternInsightsEnabled: boolean,
  evidenceCount: number,
  lastSurfacingTurn?: number,
): SurfacingDecision {
  // Cooldown: Don't surface if we surfaced recently (within last 5 turns)
  // This prevents the AI from nagging the user with insights on every turn
  if (lastSurfacingTurn !== undefined && turnCount - lastSurfacingTurn < 5) {
    return {
      shouldSurface: false,
      style: 'silent',
      requiresConsent: false,
      evidenceCount,
    };
  }
  // Stage 1: Never unless user explicitly asks
  if (stage === 1 && !userAskedForPatternFlag) {
    return {
      shouldSurface: false,
      style: 'silent',
      requiresConsent: false,
      evidenceCount,
    };
  }

  // If user asked for patterns, allow surfacing at any stage with evidence
  if (userAskedForPatternFlag && evidenceCount >= 1) {
    return {
      shouldSurface: true,
      // Use stage-appropriate style even when user asks
      style: stage <= 1 ? 'tentative' : stage === 2 ? 'tentative' : 'explicit',
      requiresConsent: false, // User initiated, no consent needed
      evidenceCount,
    };
  }

  // Stage 2: Tentative observations with 2+ evidence
  if (stage === 2 && evidenceCount >= 2) {
    return {
      shouldSurface: true,
      style: 'tentative',
      requiresConsent: false,
      evidenceCount,
    };
  }

  // Stage 3-4: Explicit with 3+ evidence + consent for pattern insights
  if (stage >= 3 && evidenceCount >= 3 && patternInsightsEnabled) {
    return {
      shouldSurface: true,
      style: 'explicit',
      requiresConsent: true, // Require consent before explicit pattern claims
      evidenceCount,
    };
  }

  // Stage 3-4 but pattern insights not enabled - fall back to silent
  if (stage >= 3 && evidenceCount >= 3 && !patternInsightsEnabled) {
    return {
      shouldSurface: false,
      style: 'silent',
      requiresConsent: false,
      evidenceCount,
    };
  }

  // Default: don't surface
  return {
    shouldSurface: false,
    style: 'silent',
    requiresConsent: false,
    evidenceCount,
  };
}

// ============================================================================
// Evidence Counting
// ============================================================================

/**
 * Count pattern evidence in retrieved context.
 *
 * Evidence is based on the number of semantically similar messages retrieved
 * from other sessions or earlier in the current session. More relevant
 * messages = more evidence of recurring themes/patterns.
 *
 * This is a simplified heuristic: if the retrieval system found multiple
 * relevant messages across sessions, it suggests recurring themes.
 */
export function countPatternEvidence(
  retrievedContext: {
    relevantFromCurrentSession?: Array<{ content: string }>;
    relevantFromOtherSessions?: Array<{ content: string }>;
  } | null,
): number {
  if (!retrievedContext) {
    return 0;
  }

  // Count relevant messages as evidence
  // Cross-session messages are stronger evidence of patterns
  const crossSessionCount = retrievedContext.relevantFromOtherSessions?.length ?? 0;
  const currentSessionCount = retrievedContext.relevantFromCurrentSession?.length ?? 0;

  // Cross-session matches are weighted more heavily (evidence of recurring patterns)
  // Current session matches add some evidence but less weight
  const evidenceCount = crossSessionCount + Math.floor(currentSessionCount / 2);

  return evidenceCount;
}
