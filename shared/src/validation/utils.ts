/**
 * Validation Utilities
 *
 * Common validation patterns and helpers for Zod schemas.
 */

import { z } from 'zod';
import { ErrorCode } from '../api';

// ============================================================================
// Common Validation Patterns
// ============================================================================

/** UUID validation */
export const uuid = z.string().uuid('Invalid ID format');


/** Non-empty string with configurable field name */
export const nonEmptyString = (field: string) =>
  z.string().min(1, `${field} is required`).max(10000, `${field} is too long`);

/** Email validation */
export const email = z.string().email('Invalid email format');

/** ISO 8601 timestamp validation */
export const timestamp = z.string().datetime({ message: 'Invalid timestamp format' });

// ============================================================================
// Pagination
// ============================================================================

export const paginationParams = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type PaginationParamsInput = z.infer<typeof paginationParams>;

// ============================================================================
// Error Response
// ============================================================================

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.nativeEnum(ErrorCode),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorResponseInput = z.infer<typeof errorResponseSchema>;

// ============================================================================
// API Response Wrapper
// ============================================================================

/** Wrap a data schema in standard API response format (validation helper) */
export function validationApiResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
  });
}

/** API error response schema (validation helper) */
export const validationApiErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.nativeEnum(ErrorCode),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

// ============================================================================
// Common Field Validators
// ============================================================================

/** Intensity rating (1-10 scale) */
export const intensityRating = z.number().int().min(1).max(10);

/** Phone number (E.164 format) */
export const phoneNumber = z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Valid phone number required');

/** Safe string (no XSS) */
export const safeString = (maxLength = 1000) =>
  z
    .string()
    .max(maxLength)
    .transform(val => val.trim());
