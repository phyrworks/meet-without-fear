/**
 * Need Mapping DTOs (Stage 3)
 *
 * Data Transfer Objects for need identification, capture, and validation.
 */

import { NeedCategory } from '../enums';

// ============================================================================
// Identified Needs
// ============================================================================

export interface IdentifiedNeedDTO {
  id: string;
  need: string; // e.g., "Recognition"
  category: NeedCategory;
  description: string; // Specific description for this user
  evidence: string[]; // Quotes/references supporting this
  confirmed: boolean;
  lockedAt?: string | null;
  deletedAt?: string | null;
  supersededByNeedId?: string | null;
  status?: 'draft' | 'locked' | 'superseded' | 'deleted';
  aiConfidence: number; // 0-1
  createdAt?: string;
  needsReframing?: boolean;
  reframingWarning?: string;
}

export interface GetNeedsResponse {
  needs: IdentifiedNeedDTO[];
  synthesizedAt: string | null;
  extracting?: boolean; // True if AI extraction is currently in progress
  isDirty?: boolean; // True if content changed since synthesis
  /**
   * When the caller shared their needs (earliest live need_share of theirs),
   * null before they share. This is the per-participant "I shared" fact: the
   * `needs_shared` milestone is session-scoped and is reached by everyone only
   * once ALL have shared (ruling R33), so it cannot say "I shared, waiting".
   */
  sharedAt: string | null;
}

// ============================================================================
// Need Confirmation
// ============================================================================

export interface NeedAdjustment {
  needId: string;
  confirmed: boolean;
  correction?: string; // If user wants to rephrase
}

/**
 * @deprecated Use ConfirmNeedsRequestInput from contracts/stages for Zod-validated type.
 * Kept for backward compatibility - aligns with the Zod schema (needIds + adjustments).
 */
export interface ConfirmNeedsRequest {
  needIds: string[];
  adjustments?: NeedAdjustment[];
}

export interface ConfirmNeedsResponse {
  confirmed: boolean;
  confirmedAt: string;
  partnerConfirmed: boolean;
  canAdvance: boolean;
}

// ============================================================================
// Add Custom Need
// ============================================================================

export interface AddNeedRequest {
  need: string;
  category: NeedCategory;
  description: string;
}

export interface AddNeedResponse {
  need: IdentifiedNeedDTO;
}

// ============================================================================
// Consent to Share Needs
// ============================================================================

export interface ConsentShareNeedsRequest {
  needIds: string[];
}

export interface ConsentShareNeedsResponse {
  consented: boolean;
  sharedAt: string;
  waitingForPartner: boolean;
  needsRevealReady?: boolean;
}

// ============================================================================
// Capture Needs (from AI summary card)
// ============================================================================

export interface CapturedNeedInput {
  need: string;
  category: NeedCategory;
  description: string;
  evidence: string[];
}

export interface CapturedSingleNeedInput extends CapturedNeedInput {}

export interface CaptureNeedsRequest {
  needs: CapturedNeedInput[];
}

export interface CaptureNeedsResponse {
  needs: IdentifiedNeedDTO[];
  capturedAt: string;
}

export type NeedActionType = 'refine' | 'delete' | 'lock';

export interface ParsedNeedAction {
  type: NeedActionType;
  needId?: string;
  supersedes?: string;
  need?: string;
  category?: NeedCategory;
  description?: string;
  evidence?: string[];
}

export interface ApplyNeedActionResponse {
  action: NeedActionType;
  oldNeed?: IdentifiedNeedDTO;
  need?: IdentifiedNeedDTO;
  needs: IdentifiedNeedDTO[];
}

// ============================================================================
// Validate Needs (user affirms both lists as valid)
// ============================================================================

export interface ValidateNeedsResponse {
  validated: boolean;
  validatedAt: string | null;
  partnerValidated: boolean;
  canAdvance: boolean;
}

// ============================================================================
// Legacy Common Ground Compatibility
// ============================================================================

/**
 * @deprecated Common ground is being removed in the Stage 3 redesign.
 * Kept as a type-only compatibility shim while downstream clients migrate.
 */
export interface CommonGroundDTO {
  id: string;
  need: string;
  category: NeedCategory;
  description: string;
  confirmedByMe: boolean;
  confirmedByPartner: boolean;
  confirmedAt: string | null;
}

/**
 * @deprecated Common ground is being removed in the Stage 3 redesign.
 * Kept as a type-only compatibility shim while downstream clients migrate.
 */
export interface GetCommonGroundResponse {
  commonGround: CommonGroundDTO[];
  analysisComplete: boolean;
  bothConfirmed: boolean;
  noOverlap?: boolean;
}

/**
 * @deprecated Common ground is being removed in the Stage 3 redesign.
 * Kept as a type-only compatibility shim while downstream clients migrate.
 */
export interface ConfirmCommonGroundRequest {
  confirmations: {
    commonGroundId: string;
    confirmed: boolean;
  }[];
}

/**
 * @deprecated Common ground is being removed in the Stage 3 redesign.
 * Kept as a type-only compatibility shim while downstream clients migrate.
 */
export interface ConfirmCommonGroundResponse {
  updated: CommonGroundDTO[];
  allConfirmedByMe: boolean;
  allConfirmedByBoth: boolean;
  canAdvance: boolean;
}

// ============================================================================
// Needs Comparison (Side-by-Side Reveal)
// ============================================================================

export interface NeedsComparisonNeedDTO {
  id: string;
  category: NeedCategory;
  need: string;
  confirmed: boolean;
}

export interface GetNeedsComparisonResponse {
  myNeeds: NeedsComparisonNeedDTO[];
  partnerNeeds: NeedsComparisonNeedDTO[];
  myValidated?: boolean;
  partnerValidated?: boolean;
  canAdvance?: boolean;
}
