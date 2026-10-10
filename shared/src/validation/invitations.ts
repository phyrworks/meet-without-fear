/**
 * Invitation Validation Schemas
 *
 * Zod schemas for partner invitation flow.
 * Note: Comprehensive invitation contracts are in contracts/sessions.ts
 */

import { z } from 'zod';
import { uuid } from './utils';

// Re-export from contracts
export {
  invitationStatusSchema,
  invitationSchema,
  acceptInvitationRequestSchema,
  acceptInvitationResponseSchema,
  declineInvitationRequestSchema,
  declineInvitationResponseSchema,
  resendInvitationResponseSchema,
  type InvitationInput,
  type AcceptInvitationRequestInput,
  type AcceptInvitationResponseInput,
  type DeclineInvitationRequestInput,
  type DeclineInvitationResponseInput,
  type ResendInvitationResponseInput,
} from '../contracts/sessions';

// ============================================================================
// Invitation Validation-specific Schemas
// ============================================================================

export const acceptInvitationParamsSchema = z.object({
  invitationId: uuid,
});

export type AcceptInvitationParamsInput = z.infer<typeof acceptInvitationParamsSchema>;

export const resendInvitationRequestSchema = z.object({
  invitationId: uuid,
});

export type ResendInvitationRequestInput = z.infer<typeof resendInvitationRequestSchema>;

export const invitationStatusCheckSchema = z.enum(['pending', 'accepted', 'expired', 'declined']);

export type InvitationStatusCheckInput = z.infer<typeof invitationStatusCheckSchema>;

export const invitationStatusResponseSchema = z.object({
  id: z.string(),
  status: invitationStatusCheckSchema,
  expiresAt: z.string().datetime(),
  recipientContact: z.string(),
});

export type InvitationStatusResponseInput = z.infer<typeof invitationStatusResponseSchema>;

// ============================================================================
// Pending Invitations
// ============================================================================

export const pendingInvitationSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  invitedBy: z.object({
    id: z.string(),
    name: z.string().nullable(),
  }),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type PendingInvitationInput = z.infer<typeof pendingInvitationSchema>;

export const getPendingInvitationsResponseSchema = z.object({
  invitations: z.array(pendingInvitationSchema),
});

export type GetPendingInvitationsResponseInput = z.infer<typeof getPendingInvitationsResponseSchema>;
