/**
 * Sessions API Contracts
 *
 * Zod schemas for session-related API endpoints.
 */

import { z } from 'zod';
import { SessionStatus, Stage, StageStatus } from '../enums';

// ============================================================================
// Shared Sub-schemas
// ============================================================================

const partnerSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  nickname: z.string().nullable(), // What I call my partner
});

const stageProgressSchema = z.object({
  stage: z.nativeEnum(Stage),
  status: z.nativeEnum(StageStatus),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

const stageGateSchema = z.object({
  id: z.string(),
  description: z.string(),
  satisfied: z.boolean(),
  requiredForAdvance: z.boolean(),
});

// ============================================================================
// Session Summary Schema
// ============================================================================

export const sessionSummarySchema = z.object({
  id: z.string(),
  relationshipId: z.string(),
  status: z.nativeEnum(SessionStatus),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  partner: partnerSchema,
  myProgress: stageProgressSchema,
  partnerProgress: stageProgressSchema,
  selfActionNeeded: z.array(z.string()),
  partnerActionNeeded: z.array(z.string()),
});

export type SessionSummaryInput = z.infer<typeof sessionSummarySchema>;

// ============================================================================
// Session Detail Schema
// ============================================================================

export const sessionDetailSchema = sessionSummarySchema.extend({
  relationship: z.object({
    id: z.string(),
    createdAt: z.string().datetime(),
    sessionCount: z.number().int().min(0),
  }),
  currentGates: z.array(stageGateSchema),
  resolvedAt: z.string().datetime().nullable(),
});

export type SessionDetailInput = z.infer<typeof sessionDetailSchema>;

// ============================================================================
// POST /sessions - Create Session
// ============================================================================

export const createSessionRequestSchema = z
  .object({
    personId: z.string().uuid().optional(),
    inviteName: z.string().min(1, 'Name is required').max(100, 'Name too long').optional(),
    context: z.string().max(500, 'Context too long').optional(),
    innerThoughtsId: z.string().uuid().optional(), // Link to originating Inner Thoughts session
    linkedAtMessageId: z.string().uuid().optional(),
    forceCreate: z.boolean().optional(),
  })
  .refine(data => data.personId || data.inviteName, {
    message: 'Must provide personId or inviteName',
  });

export type CreateSessionRequestInput = z.infer<typeof createSessionRequestSchema>;

export const createSessionResponseSchema = z.object({
  session: sessionSummarySchema,
  invitationId: z.string(),
  invitationUrl: z.string().url(),
});

export type CreateSessionResponseInput = z.infer<typeof createSessionResponseSchema>;

// ============================================================================
// GET /sessions - List Sessions
// ============================================================================

export const listSessionsQuerySchema = z.object({
  status: z.nativeEnum(SessionStatus).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

export type ListSessionsQueryInput = z.infer<typeof listSessionsQuerySchema>;

export const listSessionsResponseSchema = z.object({
  items: z.array(sessionSummarySchema),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
});

export type ListSessionsResponseInput = z.infer<typeof listSessionsResponseSchema>;

// ============================================================================
// GET /sessions/:id - Get Session Detail
// ============================================================================

export const getSessionResponseSchema = z.object({
  session: sessionDetailSchema,
});

export type GetSessionResponseInput = z.infer<typeof getSessionResponseSchema>;

// ============================================================================
// POST /sessions/:id/pause - Pause Session
// ============================================================================

export const pauseSessionRequestSchema = z.object({
  reason: z.string().max(200, 'Reason too long').optional(),
});

export type PauseSessionRequestInput = z.infer<typeof pauseSessionRequestSchema>;

export const pauseSessionResponseSchema = z.object({
  paused: z.boolean(),
  pausedAt: z.string().datetime(),
});

export type PauseSessionResponseInput = z.infer<typeof pauseSessionResponseSchema>;

// ============================================================================
// POST /sessions/:id/resume - Resume Session
// ============================================================================

export const resumeSessionResponseSchema = z.object({
  resumed: z.boolean(),
  resumedAt: z.string().datetime(),
});

export type ResumeSessionResponseInput = z.infer<typeof resumeSessionResponseSchema>;

// ============================================================================
// POST /sessions/:id/messages - Send Message
// ============================================================================

export const sendMessageRequestSchema = z.object({
  content: z.string().min(1, 'Message is required').max(5000, 'Message too long'),
  refiningNeedId: z.string().nullable().optional(),
});

export type SendMessageRequestInput = z.infer<typeof sendMessageRequestSchema>;

export const messageSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: z.enum(['USER', 'AI', 'SYSTEM']),
  createdAt: z.string().datetime(),
});

export const sendMessageResponseSchema = z.object({
  message: messageSchema,
  aiResponse: messageSchema.optional(),
});

export type SendMessageResponseInput = z.infer<typeof sendMessageResponseSchema>;

// ============================================================================
// Invitation Schemas
// ============================================================================

export const invitationStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED']);

export const invitationSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  invitedBy: z.object({
    id: z.string(),
    name: z.string().nullable(),
  }),
  status: invitationStatusSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type InvitationInput = z.infer<typeof invitationSchema>;

export const acceptInvitationRequestSchema = z.object({
  invitationId: z.string().uuid('Invalid invitation ID'),
});

export type AcceptInvitationRequestInput = z.infer<typeof acceptInvitationRequestSchema>;

export const acceptInvitationResponseSchema = z.object({
  session: sessionSummarySchema,
});

export type AcceptInvitationResponseInput = z.infer<typeof acceptInvitationResponseSchema>;

export const declineInvitationRequestSchema = z.object({
  reason: z.string().max(500, 'Reason too long').optional(),
});

export type DeclineInvitationRequestInput = z.infer<typeof declineInvitationRequestSchema>;

export const declineInvitationResponseSchema = z.object({
  declined: z.boolean(),
  declinedAt: z.string().datetime(),
});

export type DeclineInvitationResponseInput = z.infer<typeof declineInvitationResponseSchema>;

export const resendInvitationResponseSchema = z.object({
  sent: z.boolean(),
  sentAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type ResendInvitationResponseInput = z.infer<typeof resendInvitationResponseSchema>;

// ============================================================================
// PATCH /relationships/:relationshipId/nickname - Update Nickname
// ============================================================================

export const updateNicknameRequestSchema = z.object({
  nickname: z.string().min(1, 'Nickname is required').max(100, 'Nickname too long').nullable(),
});

export type UpdateNicknameRequestInput = z.infer<typeof updateNicknameRequestSchema>;

export const updateNicknameResponseSchema = z.object({
  nickname: z.string().nullable(),
});

export type UpdateNicknameResponseInput = z.infer<typeof updateNicknameResponseSchema>;
