/**
 * API Response Types for Meet Without Fear
 *
 * Standard response wrappers and error types for all API endpoints.
 */

import { z } from 'zod';

// ============================================================================
// Standard API Response Wrapper
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export enum ErrorCode {
  // Auth errors
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  /** First login refused: the Clerk user has no verified primary email address. */
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  /** First login refused: the email already belongs to an account bound to another identity. */
  ACCOUNT_LINK_CONFLICT = 'ACCOUNT_LINK_CONFLICT',

  // Resource errors
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',

  // Validation errors
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_STAGE = 'INVALID_STAGE',
  GATE_NOT_SATISFIED = 'GATE_NOT_SATISFIED',

  // Consent errors
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
  CONSENT_REVOKED = 'CONSENT_REVOKED',

  // Session errors
  SESSION_NOT_ACTIVE = 'SESSION_NOT_ACTIVE',
  PARTNER_NOT_READY = 'PARTNER_NOT_READY',
  INVITATION_EXPIRED = 'INVITATION_EXPIRED',

  // Server errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
}

/**
 * Backwards-compatible alias for API error codes used in contracts
 * ApiErrorCode keeps the naming used in implementation plans.
 */
export enum ApiErrorCode {
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  ACCOUNT_LINK_CONFLICT = 'ACCOUNT_LINK_CONFLICT',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_STAGE = 'INVALID_STAGE',
  GATE_NOT_SATISFIED = 'GATE_NOT_SATISFIED',
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
  CONSENT_REVOKED = 'CONSENT_REVOKED',
  SESSION_NOT_ACTIVE = 'SESSION_NOT_ACTIVE',
  PARTNER_NOT_READY = 'PARTNER_NOT_READY',
  INVITATION_EXPIRED = 'INVITATION_EXPIRED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
}

// ============================================================================
// Zod Schemas (runtime validation for API wrappers)
// ============================================================================

export const apiErrorSchema = z.object({
  code: z.nativeEnum(ApiErrorCode),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const apiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });

export const apiErrorResponseSchema = z.object({
  success: z.literal(false),
  error: apiErrorSchema,
});

// ============================================================================
// Pagination
// ============================================================================

export interface PaginatedResponse<T> {
  items: T[];
  cursor?: string;
  hasMore: boolean;
}

export interface PaginationParams {
  cursor?: string;
  limit?: number;
}
