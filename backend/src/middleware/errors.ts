/**
 * Error Handling Middleware
 *
 * Centralized error handling for the API with standardized error responses.
 */

import { Request, Response, NextFunction } from 'express';
import { ErrorCode, ApiError, ApiResponse } from '@meet-without-fear/shared';
import { ZodError } from 'zod';
import { logger } from '../lib/logger';
import { Prisma } from '../generated/prisma/client';

// ============================================================================
// API Error Classes
// ============================================================================

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(ErrorCode.UNAUTHORIZED, message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(ErrorCode.FORBIDDEN, message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', message?: string) {
    super(ErrorCode.NOT_FOUND, message || `${resource} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(ErrorCode.CONFLICT, message, 409);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_ERROR, message, 400, details);
  }
}

export class ConsentRequiredError extends AppError {
  constructor(message = 'Consent required to access this resource') {
    super(ErrorCode.CONSENT_REQUIRED, message, 403);
  }
}

export class SessionNotActiveError extends AppError {
  constructor(message = 'Session is not active') {
    super(ErrorCode.SESSION_NOT_ACTIVE, message, 400);
  }
}

export class GateNotSatisfiedError extends AppError {
  constructor(message = 'Gate requirements not satisfied') {
    super(ErrorCode.GATE_NOT_SATISFIED, message, 400);
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'Internal server error') {
    super(ErrorCode.INTERNAL_ERROR, message, 500);
  }
}

// ============================================================================
// Error Handler Middleware
// ============================================================================

/**
 * Formats a Zod validation error into a details object
 */
function formatZodError(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'value';
    if (!details[path]) {
      details[path] = [];
    }
    details[path].push(issue.message);
  }
  return details;
}

/**
 * Error handler middleware
 * Must be registered last in the middleware chain
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // Log error — use warn for expected client errors (4xx) so they don't reach Sentry
  if (process.env.NODE_ENV !== 'test') {
    const is4xx = err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500;
    const logFn = is4xx ? logger.warn.bind(logger) : logger.error.bind(logger);
    logFn(`[${err.name}] ${err.message}`, {
      ...(is4xx ? {} : { stack: err.stack }),
      path: req.path,
      method: req.method,
    });
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const response: ApiResponse<never> = {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Validation failed',
        details: formatZodError(err),
      },
    };
    res.status(400).json(response);
    return;
  }

  // A malformed id. Every primary key is a Postgres uuid, so a lookup by an id
  // that is not one fails in the database (P2007) where it used to find nothing.
  // Answer as the lookup used to: the resource does not exist.
  if (isMalformedIdError(err)) {
    const response: ApiResponse<never> = {
      success: false,
      error: { code: ErrorCode.NOT_FOUND, message: 'Resource not found' },
    };
    res.status(404).json(response);
    return;
  }

  // Handle our custom AppError
  if (err instanceof AppError) {
    const apiError: ApiError = {
      code: err.code,
      message: err.message,
      details: err.details,
    };
    const response: ApiResponse<never> = {
      success: false,
      error: apiError,
    };
    res.status(err.statusCode).json(response);
    return;
  }

  // Handle unknown errors
  const response: ApiResponse<never> = {
    success: false,
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message:
        process.env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : err.message,
    },
  };
  res.status(500).json(response);
}

/** Prisma's error for a value Postgres rejects as a uuid ("invalid input syntax for type uuid"). */
export function isMalformedIdError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2007' &&
    /type uuid/.test(err.message)
  );
}

/**
 * 404 handler for unmatched routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  const response: ApiResponse<never> = {
    success: false,
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `Route ${req.method} ${req.path} not found`,
    },
  };
  res.status(404).json(response);
}

/**
 * Async handler wrapper to catch async errors
 */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
