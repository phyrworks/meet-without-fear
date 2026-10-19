/**
 * Authentication Middleware
 *
 * Clerk-based authentication for all environments.
 * Requires CLERK_SECRET_KEY to be configured.
 */

import { Request, Response, NextFunction } from 'express';
import { UnauthorizedError, ForbiddenError, NotFoundError } from './errors';
import { prisma } from '../lib/prisma';
import { ApiResponse, ErrorCode } from '@meet-without-fear/shared';
import { Prisma } from '../generated/prisma/client';
import { logger } from '../lib/logger';
import { identityBindingEnabled } from '../lib/prisma-identity';
import { updateContext } from '../lib/request-context';

// ============================================================================
// Types
// ============================================================================

export interface AuthUser {
  id: string;
  clerkId: string | null;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  pushToken: string | null;
  biometricEnabled: boolean;
  biometricEnrolledAt: Date | null;
  lastMoodIntensity: number | null;
  createdAt: Date;
  updatedAt: Date;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      clerkUserId?: string;
    }
  }
}

// ============================================================================
// Clerk Authentication
// ============================================================================

/**
 * Verifies Clerk JWT and returns the user ID
 */
async function verifyClerkToken(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  try {
    const { verifyToken } = await import('@clerk/express');
    const token = authHeader.slice(7);
    const session = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });
    return session.sub;
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      logger.error('[Auth] Clerk token verification failed:', error);
    }
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * E2E auth bypass handler
 * When E2E_AUTH_BYPASS=true AND NODE_ENV is not production, accepts x-e2e-user-id and x-e2e-user-email headers
 */
async function handleE2EAuthBypass(req: Request): Promise<boolean> {
  if (process.env.E2E_AUTH_BYPASS !== 'true') {
    return false;
  }
  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  const e2eUserId = req.headers['x-e2e-user-id'] as string | undefined;
  const e2eEmail = req.headers['x-e2e-user-email'] as string | undefined;

  if (!e2eUserId || !e2eEmail) {
    return false;
  }

  // User.id is a Postgres uuid: say so here rather than let the upsert fail in
  // the database with an error that reads like a missing resource.
  if (!UUID_RE.test(e2eUserId)) {
    throw new UnauthorizedError('x-e2e-user-id must be a UUID');
  }

  const e2eClerkId = `e2e_${e2eUserId}`;

  let user;
  try {
    // Primary path: tie auth identity to E2E user ID
    user = await prisma.user.upsert({
      where: { id: e2eUserId },
      create: { id: e2eUserId, email: e2eEmail, clerkId: e2eClerkId },
      update: { email: e2eEmail, clerkId: e2eClerkId },
    });
  } catch (error) {
    // Guard against transient unique conflicts (parallel E2E requests)
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }

    user = await prisma.user.findFirst({
      where: {
        OR: [{ id: e2eUserId }, { clerkId: e2eClerkId }, { email: e2eEmail }],
      },
    });
    if (!user) {
      throw error;
    }

    user = await prisma.user.update({
      where: { id: user.id },
      data: { email: e2eEmail, clerkId: e2eClerkId },
    });
  }

  req.user = user;
  return true;
}

/**
 * Clerk authentication handler
 */
async function handleClerkAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  required: boolean
): Promise<void> {
  // Check for E2E auth bypass first
  const e2eBypassed = await handleE2EAuthBypass(req);
  if (e2eBypassed) {
    next();
    return;
  }

  // Check Clerk is configured
  if (!process.env.CLERK_SECRET_KEY) {
    const response: ApiResponse<never> = {
      success: false,
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Authentication not configured: set CLERK_SECRET_KEY',
      },
    };
    res.status(500).json(response);
    return;
  }

  const clerkUserId = await verifyClerkToken(req);

  if (!clerkUserId) {
    if (required) {
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: ErrorCode.UNAUTHORIZED,
          message: 'Authentication required',
        },
      };
      res.status(401).json(response);
      return;
    }
    next();
    return;
  }

  try {
    // Fast path: look up existing user from our DB without calling Clerk API.
    // This eliminates an external HTTP call on every authenticated request,
    // preventing Clerk rate-limit (429) errors under high request volume.
    let user = await prisma.user.findUnique({ where: { clerkId: clerkUserId } });

    if (user) {
      // User exists — use DB record directly. Profile data (name/email) is
      // synced via Clerk webhooks or on first auth; no need to fetch every time.
      req.user = user;
      req.clerkUserId = clerkUserId;
      next();
      return;
    }

    // Slow path: new user — fetch details from Clerk to populate initial record.
    let clerkUser;
    try {
      const { clerkClient } = await import('@clerk/express');
      clerkUser = await clerkClient.users.getUser(clerkUserId);
    } catch (clerkError) {
      // Clerk API may fail due to rate-limiting (429) under burst traffic.
      // Another concurrent request may have already created the user — retry DB lookup.
      const retryUser = await prisma.user.findUnique({ where: { clerkId: clerkUserId } });
      if (retryUser) {
        req.user = retryUser;
        req.clerkUserId = clerkUserId;
        next();
        return;
      }
      throw clerkError;
    }

    const email = clerkUser.emailAddresses[0]?.emailAddress || `${clerkUserId}@pending.clerk`;
    const firstName = clerkUser.firstName || null;
    const lastName = clerkUser.lastName || null;
    const name = [firstName, lastName].filter(Boolean).join(' ') || null;

    try {
      user = await prisma.user.create({
        data: { clerkId: clerkUserId, email, name, firstName, lastName },
      });
    } catch (error) {
      // Concurrent create race, or a local account already exists for this
      // Clerk email. Resolve by identity first, then by email.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        user =
          (await prisma.user.findUnique({ where: { clerkId: clerkUserId } })) ||
          (await prisma.user.findUnique({ where: { email } }));
        if (!user) throw error;

        if (user.clerkId !== clerkUserId) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { clerkId: clerkUserId, email, name, firstName, lastName },
          });
        }
      } else {
        throw error;
      }
    }

    req.user = user;
    req.clerkUserId = clerkUserId;
    next();
  } catch (error) {
    next(error);
  }
}

// ============================================================================
// Middleware Exports
// ============================================================================

/**
 * Requires authentication - returns 401 if not authenticated
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  await handleClerkAuth(req, res, bindRequestIdentity(req, next), true);
}

/**
 * With DB_IDENTITY_BINDING=on, put the authenticated user's id on the request
 * context before the route runs, so lib/prisma-identity.ts binds it to every
 * statement the request issues (including continuations it schedules).
 * Off: `next` unchanged, nothing else differs.
 */
function bindRequestIdentity(req: Request, next: NextFunction): NextFunction {
  if (!identityBindingEnabled()) return next;
  return ((err?: unknown) => {
    if (err === undefined && req.user) updateContext({ userId: req.user.id });
    next(err);
  }) as NextFunction;
}

/**
 * Optional authentication - populates req.user if authenticated, continues if not
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  await handleClerkAuth(req, res, bindRequestIdentity(req, next), false);
}

/**
 * Gets the current authenticated user or throws
 */
export function getUser(req: Request): AuthUser {
  if (!req.user) {
    throw new UnauthorizedError('No authenticated user');
  }
  return req.user;
}

/**
 * Checks if the current user has access to a relationship
 */
export async function requireRelationshipAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = req.user;
  if (!user) {
    throw new UnauthorizedError();
  }

  const relationshipId = req.params.relationshipId;
  if (!relationshipId) {
    next();
    return;
  }

  try {
    const membership = await prisma.relationshipMember.findFirst({
      where: {
        relationshipId,
        userId: user.id,
      },
    });

    if (!membership) {
      throw new ForbiddenError('Access to this relationship denied');
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Checks if the current user has access to a session
 * Supports both :id and :sessionId route params
 */
export async function requireSessionAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = req.user;
  if (!user) {
    throw new UnauthorizedError();
  }

  // Support both :id and :sessionId (prefer :id for consistency)
  const sessionId = req.params.id || req.params.sessionId;
  if (!sessionId) {
    next();
    return;
  }

  try {
    // Primary check: user is a member of the session's relationship
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        relationship: {
          members: {
            some: {
              userId: user.id,
            },
          },
        },
      },
    });

    if (session) {
      next();
      return;
    }

    // Distinguish "session does not exist" from "exists but you can't access it".
    // Without this, deleted/stale sessionIds polled by clients flood Sentry as 403s.
    const exists = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundError('Session');
    }

    // Fallback: allow access for invitees during the acceptance timing gap.
    // When an invitee accepts an invitation, the RelationshipMember is created
    // inside a transaction. Between receiving the sessionId (from invitation
    // details) and the transaction committing, session endpoint requests fail
    // with 403. This fallback grants access if a valid invitation exists for
    // this session and the requesting user is not the inviter.
    const invitedSession = await prisma.session.findFirst({
      where: {
        id: sessionId,
        invitations: {
          some: {
            invitedById: { not: user.id },
            OR: [
              { status: 'PENDING', expiresAt: { gt: new Date() } },
              { status: 'ACCEPTED' },
            ],
          },
        },
      },
    });

    if (!invitedSession) {
      throw new ForbiddenError('Access to this session denied');
    }

    next();
  } catch (error) {
    next(error);
  }
}
