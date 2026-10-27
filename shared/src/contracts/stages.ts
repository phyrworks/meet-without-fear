/**
 * Stages API Contracts
 *
 * Zod schemas for stage progression API endpoints.
 */

import { z } from 'zod';
import {
  Stage,
  StageStatus,
  TendingBlockerCategory,
  TendingFollowThroughStatus,
  TendingHelpfulnessStatus,
  TendingNeedResolutionStatus,
  TendingNextAction,
  TendingReminderScope,
} from '../enums';
import { ContinueChoice, PartialClosureResolution } from '../dto/strategy';

// ============================================================================
// Stage Blocked Reason
// ============================================================================

export const stageBlockedReasonSchema = z.enum([
  'GATES_NOT_SATISFIED',
  'PARTNER_NOT_READY',
  'SESSION_NOT_ACTIVE',
  'INVALID_STAGE_TRANSITION',
]);

export type StageBlockedReasonInput = z.infer<typeof stageBlockedReasonSchema>;

// ============================================================================
// Stage 0: Curiosity Compact
// ============================================================================

export const signCompactRequestSchema = z.object({
  agreed: z.literal(true),
});

export type SignCompactRequestInput = z.infer<typeof signCompactRequestSchema>;

export const signCompactResponseSchema = z.object({
  signed: z.boolean(),
  signedAt: z.string().datetime(),
  partnerSigned: z.boolean(),
  canAdvance: z.boolean(),
});

export type SignCompactResponseInput = z.infer<typeof signCompactResponseSchema>;

export const compactStatusResponseSchema = z.object({
  mySigned: z.boolean(),
  mySignedAt: z.string().datetime().nullable(),
  partnerSigned: z.boolean(),
  partnerSignedAt: z.string().datetime().nullable(),
  canAdvance: z.boolean(),
});

export type CompactStatusResponseInput = z.infer<typeof compactStatusResponseSchema>;

// ============================================================================
// Stage 1: Feel Heard
// ============================================================================

export const feelHeardRequestSchema = z.object({
  confirmed: z.boolean(),
  feedback: z.string().max(500, 'Feedback too long').optional(),
});

export type FeelHeardRequestInput = z.infer<typeof feelHeardRequestSchema>;

export const feelHeardResponseSchema = z.object({
  confirmed: z.boolean(),
  confirmedAt: z.string().datetime().nullable(),
  canAdvance: z.boolean(),
  partnerCompleted: z.boolean(),
  finalEmotionalReading: z.number().int().min(1).max(10).nullable().optional(),
});

export type FeelHeardResponseInput = z.infer<typeof feelHeardResponseSchema>;

// ============================================================================
// Topic Frame (Stage 0 — drafted during invite, before Stage 1)
// ============================================================================

export const confirmTopicFrameRequestSchema = z.object({
  // Optional steering direction from the user. The AI has final say on the
  // 3-5 word frame; the user can only suggest a direction, not set the text directly.
  steer: z.string().min(2, 'Steer too short').max(100, 'Steer too long').optional(),
});

export type ConfirmTopicFrameRequestInput = z.infer<typeof confirmTopicFrameRequestSchema>;

export const refineTopicFrameRequestSchema = z.object({
  message: z.string().min(1, 'Message required').max(500, 'Message too long'),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(1000),
  })).max(10).optional(),
});

export type RefineTopicFrameRequestInput = z.infer<typeof refineTopicFrameRequestSchema>;

export const refineTopicFrameResponseSchema = z.object({
  response: z.string(),
  topicFrame: z.string(),
});

export type RefineTopicFrameResponseInput = z.infer<typeof refineTopicFrameResponseSchema>;

export const confirmTopicFrameResponseSchema = z.object({
  topicFrame: z.string(),
  confirmedAt: z.string().datetime(),
});

export type ConfirmTopicFrameResponseInput = z.infer<typeof confirmTopicFrameResponseSchema>;

// ============================================================================
// Stage 2: Perspective Stretch / Empathy
// ============================================================================

export const saveEmpathyDraftRequestSchema = z.object({
  content: z.string().min(1, 'Content is required').max(2000, 'Draft too long'),
  // Optional so that "save draft content" doesn't accidentally reset readiness.
  // When omitted, backend should preserve the existing readyToShare value.
  readyToShare: z.boolean().optional(),
});

export type SaveEmpathyDraftRequestInput = z.infer<typeof saveEmpathyDraftRequestSchema>;

export const saveEmpathyDraftResponseSchema = z.object({
  draftId: z.string(),
  savedAt: z.string().datetime(),
  readyToShare: z.boolean(),
});

export type SaveEmpathyDraftResponseInput = z.infer<typeof saveEmpathyDraftResponseSchema>;

export const consentToShareRequestSchema = z.object({
  consent: z.boolean(),
});

export type ConsentToShareRequestInput = z.infer<typeof consentToShareRequestSchema>;

export const consentToShareResponseSchema = z.object({
  consented: z.boolean(),
  consentedAt: z.string().datetime().nullable(),
  partnerConsented: z.boolean(),
  canReveal: z.boolean(),
});

export type ConsentToShareResponseInput = z.infer<typeof consentToShareResponseSchema>;

export const validateEmpathyRequestSchema = z.object({
  validated: z.boolean(),
  feedback: z.string().max(500, 'Feedback too long').optional(),
}).superRefine((value, ctx) => {
  if (!value.validated && !value.feedback?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['feedback'],
      message: 'Feedback is required when empathy is not validated',
    });
  }
});

export type ValidateEmpathyRequestInput = z.infer<typeof validateEmpathyRequestSchema>;

export const validateEmpathyResponseSchema = z.object({
  validated: z.boolean(),
  validatedAt: z.string().datetime().nullable(),
  canAdvance: z.boolean(),
});

export type ValidateEmpathyResponseInput = z.infer<typeof validateEmpathyResponseSchema>;

export const skipRefinementRequestSchema = z.object({
  willingToAccept: z.boolean(),
  reason: z.string().optional(),
});

export type SkipRefinementRequestInput = z.infer<typeof skipRefinementRequestSchema>;

export const skipRefinementResponseSchema = z.object({
  success: z.boolean(),
});

export type SkipRefinementResponseInput = z.infer<typeof skipRefinementResponseSchema>;

// ============================================================================
// Feedback Coach (Stage 2)
// ============================================================================

export const saveValidationFeedbackDraftRequestSchema = z.object({
  content: z.string().min(1, 'Content is required').max(500, 'Feedback too long'),
  readyToShare: z.boolean(),
});

export type SaveValidationFeedbackDraftRequestInput = z.infer<typeof saveValidationFeedbackDraftRequestSchema>;

export const saveValidationFeedbackDraftResponseSchema = z.object({
  success: z.boolean(),
  draftId: z.string().optional(),
  savedAt: z.string().datetime().optional(),
});

export type SaveValidationFeedbackDraftResponseInput = z.infer<typeof saveValidationFeedbackDraftResponseSchema>;

export const refineValidationFeedbackRequestSchema = z.object({
  message: z.string().min(1, 'Message is required'),
  history: z.array(z.object({
    role: z.enum(['coach', 'user']),
    content: z.string(),
  })).optional(),
});

export type RefineValidationFeedbackRequestInput = z.infer<typeof refineValidationFeedbackRequestSchema>;

export const refineValidationFeedbackResponseSchema = z.object({
  response: z.string(),
  proposedFeedback: z.string().nullable(),
  canSend: z.boolean(),
});

export type RefineValidationFeedbackResponseInput = z.infer<typeof refineValidationFeedbackResponseSchema>;

// ============================================================================
// Emotional Barometer
// ============================================================================

export const recordEmotionRequestSchema = z.object({
  intensity: z.number().int().min(1).max(10),
  context: z.string().max(500, 'Context too long').optional(),
});

export type RecordEmotionRequestInput = z.infer<typeof recordEmotionRequestSchema>;

export const recordEmotionResponseSchema = z.object({
  id: z.string(),
  intensity: z.number(),
  recordedAt: z.string().datetime(),
  suggestion: z.string().optional(),
  requiresCooling: z.boolean(),
});

export type RecordEmotionResponseInput = z.infer<typeof recordEmotionResponseSchema>;

// ============================================================================
// Stage 3: Needs
// ============================================================================

export const confirmNeedsRequestSchema = z.object({
  needIds: z.array(z.string().uuid()),
  adjustments: z
    .array(
      z.object({
        needId: z.string().uuid(),
        confirmed: z.boolean(),
        correction: z.string().max(500, 'Correction too long').optional(),
      }),
    )
    .optional(),
});

export type ConfirmNeedsRequestInput = z.infer<typeof confirmNeedsRequestSchema>;

export const confirmNeedsResponseSchema = z.object({
  confirmed: z.boolean(),
  confirmedAt: z.string().datetime(),
  partnerConfirmed: z.boolean(),
  commonGroundFound: z.boolean(),
  canAdvance: z.boolean(),
});

export type ConfirmNeedsResponseInput = z.infer<typeof confirmNeedsResponseSchema>;

export const needsMappingResponseSchema = z.object({
  phase: z.enum(['exploration', 'review', 'waiting', 'complete']),
  myNeeds: z.array(
    z.object({
      id: z.string(),
      category: z.string(),
      description: z.string(),
    }),
  ),
  sharedNeeds: z.array(
    z.object({
      category: z.string(),
      description: z.string(),
    }),
  ),
  sharedNeedIds: z.array(z.string()),
  insight: z.string().optional(),
});

export type NeedsMappingResponseInput = z.infer<typeof needsMappingResponseSchema>;

// ============================================================================
// Stage 4: Strategies
// ============================================================================

export const proposeStrategyRequestSchema = z.object({
  description: z.string().min(10, 'Description too short').max(1000, 'Description too long'),
  needsAddressed: z.array(z.string()).min(1, 'Must address at least one need'),
  duration: z.string().max(100).optional(),
  measureOfSuccess: z.string().max(500).optional(),
});

export type ProposeStrategyRequestInput = z.infer<typeof proposeStrategyRequestSchema>;

export const proposeStrategyResponseSchema = z.object({
  strategy: z.object({
    id: z.string(),
    description: z.string(),
    duration: z.string().optional(),
    measureOfSuccess: z.string().optional(),
  }),
  createdAt: z.string().datetime(),
});

export type ProposeStrategyResponseInput = z.infer<typeof proposeStrategyResponseSchema>;

export const strategiesRevealResponseSchema = z.object({
  phase: z.enum(['pool', 'ranking', 'waiting', 'reveal', 'agreement', 'complete']),
  strategies: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      duration: z.string().optional(),
    }),
  ),
  overlapping: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  uniqueToMe: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  uniqueToPartner: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
  agreement: z
    .object({
      experiment: z.string(),
      duration: z.string(),
      successMeasure: z.string(),
      checkInDate: z.string().optional(),
    })
    .optional(),
});

export type StrategiesRevealResponseInput = z.infer<typeof strategiesRevealResponseSchema>;

export const confirmAgreementRequestSchema = z.object({
  confirmed: z.boolean(),
});

export type ConfirmAgreementRequestInput = z.infer<typeof confirmAgreementRequestSchema>;

export const confirmAgreementResponseSchema = z.object({
  confirmed: z.boolean(),
  confirmedAt: z.string().datetime(),
  partnerConfirmed: z.boolean(),
  sessionComplete: z.boolean(),
});

export type ConfirmAgreementResponseInput = z.infer<typeof confirmAgreementResponseSchema>;

// ============================================================================
// Stage Progress
// ============================================================================

export const stageProgressDetailSchema = z.object({
  stage: z.nativeEnum(Stage),
  status: z.nativeEnum(StageStatus),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  gates: z.record(z.string(), z.boolean()),
});

export type StageProgressDetailInput = z.infer<typeof stageProgressDetailSchema>;

export const getProgressResponseSchema = z.object({
  sessionId: z.string(),
  myProgress: stageProgressDetailSchema,
  partnerProgress: z.object({
    stage: z.nativeEnum(Stage),
    status: z.nativeEnum(StageStatus),
  }),
  canAdvance: z.boolean(),
  advanceBlockedReason: stageBlockedReasonSchema.optional(),
});

export type GetProgressResponseInput = z.infer<typeof getProgressResponseSchema>;

// ============================================================================
// Follow-up check-in payload (target `follow_up_checkin.payload`, spec §1.5)
// ============================================================================
//
// One check-in is ONE `follow_up_checkin` row; the five old response tables
// (TendingResponse, TendingEntryOutcome, TendingNeedOutcome, TendingAdjustment,
// TendingResponsePartialClosure) become the arrays below, and the between-period
// notes the participant chose to share are copied into `carriedNotes` at submit.
// The backend validates every write with this schema (zod): a payload that does
// not parse is never written. `.strict()` everywhere: an unknown key is a
// contract error, not something to store.

const followUpId = z.string().uuid();
const nullableText = z.string().max(4000).nullable();

export const followUpEntryOutcomeSchema = z
  .object({
    followUpId,
    followThroughStatus: z.nativeEnum(TendingFollowThroughStatus),
    helpfulnessStatus: z.nativeEnum(TendingHelpfulnessStatus).nullable(),
    blockerCategories: z.array(z.nativeEnum(TendingBlockerCategory)),
    whatHappened: nullableText,
    helpedNeed: nullableText,
    blockerNote: nullableText,
    stillWorthTrying: z.boolean().nullable(),
  })
  .strict();

export const followUpNeedOutcomeSchema = z
  .object({
    /** A `need_share` id (a need that crossed the boundary), or null for a free-text need. */
    needId: z.string().uuid().nullable(),
    /** The shared text of `needId` when it is set (never the owner's private label). */
    needLabel: z.string().min(1).max(500),
    sourceParticipantId: z.string().uuid().nullable(),
    resolutionStatus: z.nativeEnum(TendingNeedResolutionStatus),
    note: nullableText,
    changedNeedLabel: z.string().max(500).nullable(),
    nextAction: z.nativeEnum(TendingNextAction).nullable(),
  })
  .strict();

export const followUpAdjustmentSchema = z
  .object({
    followUpId,
    privacyScope: z.nativeEnum(TendingReminderScope),
    revisedCommitmentText: nullableText,
    revisedCadence: z.string().max(500).nullable(),
    revisedScope: z.string().max(500).nullable(),
    revisedSuccessCriteria: nullableText,
    reason: nullableText,
    blockerAddressed: z.array(z.nativeEnum(TendingBlockerCategory)),
  })
  .strict();

export const followUpPartialClosureSchema = z
  .object({ followUpId, resolution: z.nativeEnum(PartialClosureResolution) })
  .strict();

export const followUpResponseSchema = z
  .object({
    followUpId,
    status: z.enum(['CHECKIN', 'WORKED', 'PARTLY', 'DID_NOT_WORK', 'DID_NOT_TRY', 'OTHER']),
    reflection: nullableText,
    continueChoice: z.nativeEnum(ContinueChoice).nullable(),
  })
  .strict();

export const followUpCarriedNoteSchema = z
  .object({ noteId: z.string().uuid(), content: z.string().min(1).max(4000), createdAt: z.string().datetime() })
  .strict();

export const followUpCheckinPayloadSchema = z
  .object({
    entryOutcomes: z.array(followUpEntryOutcomeSchema),
    needOutcomes: z.array(followUpNeedOutcomeSchema),
    adjustments: z.array(followUpAdjustmentSchema),
    partialClosures: z.array(followUpPartialClosureSchema),
    responses: z.array(followUpResponseSchema),
    carriedNotes: z.array(followUpCarriedNoteSchema),
  })
  .strict();

export type FollowUpCheckinPayload = z.infer<typeof followUpCheckinPayloadSchema>;
export type FollowUpEntryOutcome = z.infer<typeof followUpEntryOutcomeSchema>;
export type FollowUpNeedOutcome = z.infer<typeof followUpNeedOutcomeSchema>;
export type FollowUpAdjustment = z.infer<typeof followUpAdjustmentSchema>;
export type FollowUpPartialClosure = z.infer<typeof followUpPartialClosureSchema>;
export type FollowUpResponse = z.infer<typeof followUpResponseSchema>;
export type FollowUpCarriedNote = z.infer<typeof followUpCarriedNoteSchema>;

/** The empty payload: every array present and empty. */
export function emptyFollowUpCheckinPayload(): FollowUpCheckinPayload {
  return { entryOutcomes: [], needOutcomes: [], adjustments: [], partialClosures: [], responses: [], carriedNotes: [] };
}
