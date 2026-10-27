/**
 * Stages Validation Schemas
 *
 * Zod schemas for stage-specific API endpoints.
 * Re-exports comprehensive stage contracts and adds validation-specific utilities.
 */

// Re-export all stage schemas from contracts
export {
  // Stage blocked reason
  stageBlockedReasonSchema,
  type StageBlockedReasonInput,

  // Stage 0: Curiosity Compact
  signCompactRequestSchema,
  signCompactResponseSchema,
  compactStatusResponseSchema,
  type SignCompactRequestInput,
  type SignCompactResponseInput,
  type CompactStatusResponseInput,

  // Stage 1: Feel Heard
  feelHeardRequestSchema,
  feelHeardResponseSchema,
  type FeelHeardRequestInput,
  type FeelHeardResponseInput,

  // Topic Frame (Stage 0 — drafted during invite)
  confirmTopicFrameRequestSchema,
  confirmTopicFrameResponseSchema,
  refineTopicFrameRequestSchema,
  refineTopicFrameResponseSchema,
  type ConfirmTopicFrameRequestInput,
  type ConfirmTopicFrameResponseInput,
  type RefineTopicFrameRequestInput,
  type RefineTopicFrameResponseInput,

  // Stage 2: Perspective Stretch / Empathy
  saveEmpathyDraftRequestSchema,
  saveEmpathyDraftResponseSchema,
  consentToShareRequestSchema,
  consentToShareResponseSchema,
  validateEmpathyRequestSchema,
  validateEmpathyResponseSchema,
  type SaveEmpathyDraftRequestInput,
  type SaveEmpathyDraftResponseInput,
  type ConsentToShareRequestInput,
  type ConsentToShareResponseInput,
  type ValidateEmpathyRequestInput,
  type ValidateEmpathyResponseInput,

  // Feedback validation (Not Quite flow)
  skipRefinementRequestSchema,
  skipRefinementResponseSchema,
  saveValidationFeedbackDraftRequestSchema,
  saveValidationFeedbackDraftResponseSchema,
  refineValidationFeedbackRequestSchema,
  refineValidationFeedbackResponseSchema,
  type SkipRefinementRequestInput,
  type SkipRefinementResponseInput,
  type SaveValidationFeedbackDraftRequestInput,
  type SaveValidationFeedbackDraftResponseInput,
  type RefineValidationFeedbackRequestInput,
  type RefineValidationFeedbackResponseInput,

  // Emotional barometer
  recordEmotionRequestSchema,
  recordEmotionResponseSchema,
  type RecordEmotionRequestInput,
  type RecordEmotionResponseInput,

  // Stage 3: Needs
  confirmNeedsRequestSchema,
  confirmNeedsResponseSchema,
  needsMappingResponseSchema,
  type ConfirmNeedsRequestInput,
  type ConfirmNeedsResponseInput,
  type NeedsMappingResponseInput,

  // Stage 4: Strategies
  proposeStrategyRequestSchema,
  proposeStrategyResponseSchema,
  strategiesRevealResponseSchema,
  confirmAgreementRequestSchema,
  // Follow-up check-in payload (target follow_up_checkin.payload)
  followUpCheckinPayloadSchema,
  emptyFollowUpCheckinPayload,
  type FollowUpCheckinPayload,
  type FollowUpEntryOutcome,
  type FollowUpNeedOutcome,
  type FollowUpAdjustment,
  type FollowUpPartialClosure,
  type FollowUpResponse,
  type FollowUpCarriedNote,
  confirmAgreementResponseSchema,
  type ProposeStrategyRequestInput,
  type ProposeStrategyResponseInput,
  type StrategiesRevealResponseInput,
  type ConfirmAgreementRequestInput,
  type ConfirmAgreementResponseInput,

  // Stage progress
  stageProgressDetailSchema,
  getProgressResponseSchema,
  type StageProgressDetailInput,
  type GetProgressResponseInput,
} from '../contracts/stages';

import { z } from 'zod';
import { Stage, StageStatus } from '../enums';

// ============================================================================
// Validation-specific Stage Schemas
// ============================================================================

/** Stage path parameter validation */
export const stageParamSchema = z.object({
  stage: z.coerce
    .number()
    .int()
    .min(0)
    .max(4)
    .transform(val => val as Stage),
});

export type StageParamInput = z.infer<typeof stageParamSchema>;

/** Advance to next stage request */
export const advanceStageRequestSchema = z.object({
  force: z.boolean().optional().default(false),
});

export type AdvanceStageRequestInput = z.infer<typeof advanceStageRequestSchema>;

/** Advance to next stage response */
export const advanceStageResponseSchema = z.object({
  advanced: z.boolean(),
  newStage: z.nativeEnum(Stage),
  newStatus: z.nativeEnum(StageStatus),
  advancedAt: z.string().datetime().nullable(),
  blockedReason: z.string().optional(),
});

export type AdvanceStageResponseInput = z.infer<typeof advanceStageResponseSchema>;

/** Get current stage status response */
export const stageStatusResponseSchema = z.object({
  stage: z.nativeEnum(Stage),
  status: z.nativeEnum(StageStatus),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  partnerStage: z.nativeEnum(Stage),
  partnerStatus: z.nativeEnum(StageStatus),
  canAdvance: z.boolean(),
  advanceBlockedReason: z.string().optional(),
  gates: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      satisfied: z.boolean(),
      requiredForAdvance: z.boolean(),
    }),
  ),
});

export type StageStatusResponseInput = z.infer<typeof stageStatusResponseSchema>;
