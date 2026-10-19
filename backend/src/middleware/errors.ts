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
  // A Postgres constraint violation carries the offending row (or key values)
  // in its detail. Classify it from the safe fields only, before anything is
  // logged or echoed.
  const violation = getPgConstraintViolation(err);

  // Log error — use warn for expected client errors (4xx) so they don't reach Sentry.
  // Constraint violations log at error level: they mean the app tried to write
  // data the schema forbids, which is a bug worth seeing in Sentry.
  // Everything logged goes through scrubPgDetail; a constraint violation logs
  // only its classification, never the driver's message.
  if (process.env.NODE_ENV !== 'test') {
    const is4xx = !violation && err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500;
    const logFn = is4xx ? logger.warn.bind(logger) : logger.error.bind(logger);
    const safeMessage = violation ? describeViolation(violation) : scrubPgDetail(err.message);
    logFn(`[${err.name}] ${safeMessage}`, {
      ...(is4xx ? {} : { stack: safeStack(err, safeMessage) }),
      ...(violation ? { sqlState: violation.sqlState, constraint: violation.constraint } : {}),
      path: req.path,
      method: req.method,
    });
  }

  if (violation) {
    const response: ApiResponse<never> = {
      success: false,
      error: {
        code: violation.status === 409 ? ErrorCode.CONFLICT : ErrorCode.VALIDATION_ERROR,
        message: describeViolation(violation),
        ...(violation.constraint ? { details: { constraint: violation.constraint } } : {}),
      },
    };
    res.status(violation.status).json(response);
    return;
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
      message: scrubPgDetail(err.message),
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
          : scrubPgDetail(err.message),
    },
  };
  res.status(500).json(response);
}

// ============================================================================
// Postgres constraint violations
// ============================================================================
//
// Postgres reports a constraint violation with a `detail` that quotes the data:
//   CHECK / NOT NULL   "Failing row contains (<every column of the row>)."
//   UNIQUE / FK / EXCL "Key (<cols>)=(<values>) already exists." (etc.)
// For this app the row can be private message content, so neither may reach a
// client or a log (and through the logger, Sentry).
//
// How they surface (observed, Prisma 7.10 + @prisma/adapter-pg, PG 18):
//   - PrismaClientKnownRequestError P2010 (raw query), P2039 (model query,
//     unmapped SQLSTATE such as 23514), P2002 (unique), P2003 (FK), P2011
//     (null). The SQLSTATE is in meta.driverAdapterError.cause.originalCode;
//     for unmapped codes (CHECK) the cause also carries `detail`.
//   - Prisma 6-style raw errors: meta.code (SQLSTATE) + meta.message, where the
//     message can embed "DETAIL: ...".
//   - A raw `pg` DatabaseError: own `code`, `constraint`, `column`, `detail`.
// Only the SQLSTATE, the constraint name and the column name are read; they
// are schema identifiers, not data.

type ViolationKind = 'check' | 'not_null' | 'unique' | 'foreign_key' | 'exclusion' | 'restrict';

export interface PgConstraintViolation {
  kind: ViolationKind;
  sqlState: string;
  status: 400 | 409;
  /** Constraint name, or the column name for NOT NULL (which has no constraint name). */
  constraint?: string;
}

const SQLSTATE_KINDS: Record<string, { kind: ViolationKind; status: 400 | 409 }> = {
  '23514': { kind: 'check', status: 400 },
  '23502': { kind: 'not_null', status: 400 },
  '23505': { kind: 'unique', status: 409 },
  '23P01': { kind: 'exclusion', status: 409 },
  '23503': { kind: 'foreign_key', status: 409 },
  '23001': { kind: 'restrict', status: 409 },
};

/** Prisma codes that are constraint violations even when no SQLSTATE is attached. */
const PRISMA_CODE_SQLSTATE: Record<string, string> = {
  P2002: '23505',
  P2003: '23503',
  P2004: '23514',
  P2011: '23502',
};

const KIND_LABEL: Record<ViolationKind, string> = {
  check: 'check constraint',
  not_null: 'not-null constraint on column',
  unique: 'unique constraint',
  foreign_key: 'foreign key constraint',
  exclusion: 'exclusion constraint',
  restrict: 'restrict constraint',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `... constraint "name"` or `... column "name"` from a Postgres message (identifiers only). */
function nameFromMessage(message: string | undefined, kind: ViolationKind): string | undefined {
  if (!message) return undefined;
  const re = kind === 'not_null' ? /column "((?:[^"]|"")+)"/ : /constraint "((?:[^"]|"")+)"/;
  return scrubPgDetail(message).match(re)?.[1];
}

/**
 * Classifies a Postgres constraint violation from any shape it surfaces in.
 * Returns null for everything else. Reads only SQLSTATE and identifiers.
 */
export function getPgConstraintViolation(err: unknown): PgConstraintViolation | null {
  const e = asRecord(err);
  if (!e) return null;

  let sqlState: string | undefined;
  let constraint: string | undefined;
  let message: string | undefined; // a Postgres message, used only to extract identifiers

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = asRecord(err.meta);
    const cause = asRecord(asRecord(meta?.driverAdapterError)?.cause);
    sqlState = str(cause?.originalCode) ?? str(meta?.code) ?? PRISMA_CODE_SQLSTATE[err.code];
    message = str(cause?.originalMessage) ?? str(meta?.message) ?? err.message;
    const c = asRecord(cause?.constraint);
    constraint =
      str(c?.index) ??
      (Array.isArray(c?.fields) ? (c?.fields as unknown[]).join(', ') : undefined) ??
      str(meta?.constraint) ??
      (Array.isArray(meta?.target) ? (meta?.target as unknown[]).join(', ') : str(meta?.target));
  } else if (typeof e.code === 'string' && typeof e.severity === 'string') {
    // node-postgres DatabaseError
    sqlState = e.code;
    constraint = e.code === '23502' ? str(e.column) : str(e.constraint);
    message = str(e.message);
  } else {
    return null;
  }

  const mapped = sqlState ? SQLSTATE_KINDS[sqlState] : undefined;
  if (!sqlState || !mapped) return null;

  return {
    ...mapped,
    sqlState,
    constraint:
      (mapped.kind === 'not_null' ? undefined : constraint) ?? nameFromMessage(message, mapped.kind) ?? constraint,
  };
}

function describeViolation(v: PgConstraintViolation): string {
  const label = KIND_LABEL[v.kind];
  return v.constraint ? `Request violates ${label} "${v.constraint}"` : `Request violates a ${label}`;
}

/**
 * Removes the parts of a Postgres error text that quote data. Over-strips by
 * design: values can contain parentheses and newlines, so everything from the
 * first marker to the end of the text goes.
 */
export function scrubPgDetail(text: string): string {
  return text
    .replace(/\bDETAIL:[\s\S]*$/, 'DETAIL: [redacted]')
    .replace(/Failing row contains[\s\S]*$/, 'Failing row contains [redacted]')
    .replace(/\bKey \([\s\S]*$/, 'Key [redacted]');
}

/** The stack as logged: unchanged unless its header quoted data, else rebuilt from the safe message. */
function safeStack(err: Error, safeMessage: string): string | undefined {
  if (!err.stack) return undefined;
  if (safeMessage === err.message && scrubPgDetail(err.stack) === err.stack) return err.stack;
  const frames = err.stack.split('\n').filter(line => /^\s+at /.test(line));
  return [`${err.name}: ${safeMessage}`, ...frames].join('\n');
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
