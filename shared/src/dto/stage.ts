/**
 * Stage DTOs
 *
 * Data Transfer Objects for stage progression (progress is participant milestones).
 */

import { Stage, StageStatus } from '../enums';
import type { MilestoneKey, MilestoneMap, PartnerMilestoneMap } from './milestones';

// ============================================================================
// Stage Progress
// ============================================================================

/**
 * The caller's progress. `milestones` is every milestone the caller has
 * reached (participant_milestone), keyed by milestone key.
 */
export interface StageProgressDetailDTO {
  stage: Stage;
  status: StageStatus;
  startedAt: string;
  completedAt: string | null;
  milestones: MilestoneMap;
}

/**
 * The partner's progress. `milestones` is NOT every milestone the partner
 * reached: only those of the partner's current stage that the old per-stage
 * gate JSON exposed (`PARTNER_VISIBLE_MILESTONES` in the backend stage shim),
 * with `invitation_sent` as `true`, never its instant (PartnerMilestoneMap).
 */
export interface PartnerStageStatusDTO {
  stage: Stage;
  status: StageStatus;
  milestones: PartnerMilestoneMap;
}

// ============================================================================
// Stage Advancement
// ============================================================================

export interface AdvanceStageRequest {
  sessionId: string;
  fromStage: Stage;
  toStage: Stage;
}

export interface AdvanceStageResponse {
  success: boolean;
  newProgress: StageProgressDetailDTO;

  // If advancement failed, explain why
  blockedReason?: StageBlockedReason;
  /** The current stage's required milestones the caller has not reached. */
  unreachedMilestones?: MilestoneKey[];
}

export enum StageBlockedReason {
  GATES_NOT_SATISFIED = 'GATES_NOT_SATISFIED',
  PARTNER_NOT_READY = 'PARTNER_NOT_READY',
  SESSION_NOT_ACTIVE = 'SESSION_NOT_ACTIVE',
  INVALID_STAGE_TRANSITION = 'INVALID_STAGE_TRANSITION',
}

// ============================================================================
// Stage Progress (API Responses)
// ============================================================================

export interface GetProgressResponse {
  sessionId: string;
  myProgress: StageProgressDetailDTO;
  partnerProgress: PartnerStageStatusDTO;
  canAdvance: boolean;
  advanceBlockedReason?: StageBlockedReason;
  /**
   * When the caller's Stage 1 (witness) began: the end of Stage 0, which is the
   * later of compact_signed and invitation_sent for an inviter — not a single
   * milestone, so it is computed by the stage shim. Null before Stage 1.
   */
  witnessStartedAt: string | null;
}

// ============================================================================
// Stage 0: Curiosity Compact
// ============================================================================

export interface SignCompactRequest {
  sessionId: string;
}

export interface SignCompactResponse {
  signed: boolean;
  signedAt: string;
  partnerSigned: boolean;
  canAdvance: boolean;
}

export interface CompactStatusResponse {
  mySigned: boolean;
  mySignedAt: string | null;
  partnerSigned: boolean;
  partnerSignedAt: string | null;
  canAdvance: boolean;
  /** Whether this is the first session for this relationship (no prior resolved sessions) */
  isFirstSession: boolean;
}

// ============================================================================
// Stage 1: Feel Heard Confirmation
// ============================================================================

export interface ConfirmFeelHeardRequest {
  sessionId: string;
  confirmed: boolean; // false = "not yet"
}

export interface ConfirmFeelHeardResponse {
  confirmed: boolean;
  confirmedAt: string | null;
  canAdvance: boolean;
  partnerCompleted: boolean;

  // Transition message from AI when user confirms they feel heard
  transitionMessage?: {
    id: string;
    content: string;
    timestamp: string;
    stage: number;
  } | null;

  // Stage the user was advanced to (2 if confirmed, null otherwise)
  advancedToStage?: number | null;
}
