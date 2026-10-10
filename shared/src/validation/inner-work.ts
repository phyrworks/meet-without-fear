/**
 * Inner Work Validation Schemas
 *
 * Zod schemas for validating inner work session API requests.
 */

import { z } from 'zod';
import { InnerWorkStatus } from '../dto/inner-work';

// ============================================================================
// Inner Work Status as Zod
// ============================================================================

export const innerWorkStatusSchema = z.nativeEnum(InnerWorkStatus);

// ============================================================================
// Create Inner Work Session
// ============================================================================

export const createInnerWorkSessionRequestSchema = z.object({
  title: z.string().max(200).optional(),
  /** Optional initial message - if provided, creates session with user message first (no AI greeting) */
  initialMessage: z.string().min(1).max(10000).optional(),
  /** Optional linked partner session ID (UUID) */
  linkedPartnerSessionId: z.string().uuid().optional(),
  /** Optional stage at which linking occurred */
  linkedAtStage: z.number().int().min(0).max(4).optional(),
  /** Optional trigger that caused the link */
  linkedTrigger: z.string().max(100).optional(),
});

export type CreateInnerWorkSessionRequestInput = z.infer<typeof createInnerWorkSessionRequestSchema>;

// ============================================================================
// Send Inner Work Message
// ============================================================================

export const sendInnerWorkMessageRequestSchema = z.object({
  content: z.string().min(1).max(10000),
});

export type SendInnerWorkMessageRequestInput = z.infer<typeof sendInnerWorkMessageRequestSchema>;

// ============================================================================
// Update Inner Work Session
// ============================================================================

export const updateInnerWorkSessionRequestSchema = z.object({
  title: z.string().max(200).optional(),
  status: innerWorkStatusSchema.optional(),
});

export type UpdateInnerWorkSessionRequestInput = z.infer<typeof updateInnerWorkSessionRequestSchema>;

// ============================================================================
// List Inner Work Sessions Query
// ============================================================================

export const listInnerWorkSessionsQuerySchema = z.object({
  status: innerWorkStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type ListInnerWorkSessionsQueryInput = z.infer<typeof listInnerWorkSessionsQuerySchema>;
