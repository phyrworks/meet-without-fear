/**
 * Response Helper Utilities
 *
 * Centralized response formatting for consistent API responses across all controllers.
 */

import { Response } from 'express';
import { ApiResponse, ErrorCode } from '@meet-without-fear/shared';

/**
 * Send a successful API response
 */
export function successResponse<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data } as ApiResponse<T>);
}

/**
 * Send an error API response
 */
export function errorResponse(res: Response, code: string, message: string, status = 400, details?: unknown): void {
  res.status(status).json({
    success: false,
    error: { code, message, details },
  } as ApiResponse<never>);
}

/**
 * Create a success response object (for res.json())
 */
export function success<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

/**
 * Create an error response object (for res.json())
 */
export function error(
  code: ErrorCode | string,
  message: string,
  details?: Record<string, unknown>,
): ApiResponse<never> {
  return {
    success: false,
    error: { code: code as ErrorCode, message, details },
  };
}
