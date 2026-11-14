/**
 * Authentication Middleware
 *
 * Clerk-based authentication for all environments.
 * Requires CLERK_SECRET_KEY to be configured.
 *
 * Identity (work-k5fk.1): a sign-in is a (provider, subject) row in
 * user_identity, which the request role (mwf_app) can neither read nor write.
 * The middleware resolves it through mwf_auth's app.resolve_user (every
 * request) and creates it through app.create_user (first login), then reads
 * the user row by id as the app. No path re-binds an identity to an existing
 * account (work-bp5m, the work-jv9y fix).
 */

import { Request, Response, NextFunction } from 'express';
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  EmailNotVerifiedError,
  AccountLinkConflictError,
} from './errors';
import { prisma, getAuthPrisma, getE2EToolingPrisma } from '../lib/prisma';
import { ApiResponse, ErrorCode, canonicalEmail, isUuidV7 } from '@meet-without-fear/shared';
import { Prisma } from '../generated/prisma/client';
import { logger } from '../lib/logger';
import { identityBindingEnabled } from '../lib/prisma-identity';
import { updateContext } from '../lib/request-context';
import { isE2EBypassEnabled } from '../lib/e2e-bypass';
import { resolveParticipant, type ResolvedParticipant } from '../services/participant-resolver';

// ============================================================================
// Types
// ============================================================================

/**
 * The authenticated account — a human `user` row (spec §1.7; work-k5fk.1).
 * Device and biometric state moved to `user_device`, mood to `mood_reading`;
 * `name` is generated from the first/last names and never written. The
 * sign-in identity is not on it: it lives in user_identity, out of the app's
 * reach. Only a human signs in, so `email` is always set.
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      clerkUserId?: string;
      /**
       * The caller's participant in the route's session, resolved once by
       * `requireSessionAccess` (TS-9). Absent on the invitee fallback path
       * (no participant yet) and on routes without a session.
       */
      participant?: ResolvedParticipant;
    }
  }
}

type UserRow = Omit<AuthUser, 'email'> & { email: string | null; kind: string };

/** The row as the request sees it. A sign-in resolves only to a human, which always has an email (CHECK). */
export function toAuthUser(row: UserRow): AuthUser {
  if (row.kind !== 'human' || row.email === null) {
    throw new UnauthorizedError('Only a human account signs in');
  }
  const { kind: _kind, ...user } = row;
  return { ...user, email: row.email };
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

/** The live user a (provider, subject) belongs to, through mwf_auth's definer function. */
async function resolveUserId(provider: 'clerk' | 'e2e', subject: string): Promise<string | null> {
  const rows = await getAuthPrisma().$queryRaw<Array<{ id: string | null }>>`SELECT app.resolve_user(${provider}::identity_provider, ${subject})::text AS id`;
  return rows[0]?.id ?? null;
}

/** The user row by id, as the app (mwf_app SELECT). */
async function loadUser(id: string): Promise<AuthUser | null> {
  const row = await prisma.user.findUnique({ where: { id } });
  return row ? toAuthUser(row) : null;
}

/**
 * E2E auth bypass handler
 * Only when isE2EBypassEnabled() (E2E_AUTH_BYPASS=true and NODE_ENV test,
 * development or e2e), accepts x-e2e-user-id and x-e2e-user-email headers
 */
async function handleE2EAuthBypass(req: Request): Promise<boolean> {
  if (!isE2EBypassEnabled()) {
    return false;
  }

  const e2eUserId = req.headers['x-e2e-user-id'] as string | undefined;
  const rawE2eEmail = req.headers['x-e2e-user-email'] as string | undefined;
  // user.email is canonical (work-k5fk.5): the database refuses any other form.
  const e2eEmail = rawE2eEmail === undefined ? undefined : canonicalEmail(rawE2eEmail);

  if (!e2eUserId || !e2eEmail) {
    return false;
  }

  // User.id is a Postgres uuid: say so here rather than let the upsert fail in
  // the database with an error that reads like a missing resource.
  // UUIDv7 only (owner rule): a v4 id gets the clean 401, not a DB error.
  if (!isUuidV7(e2eUserId)) {
    throw new UnauthorizedError('x-e2e-user-id must be a UUIDv7');
  }

  // The bypass is E2E tooling: it creates a user with a caller-chosen id, which
  // no production request does, so it writes on the tooling connection, never
  // the app's (mwf_app has no INSERT on user; work-k5fk.10.1, work-bp5m).
  const tooling = getE2EToolingPrisma();

  let user;
  try {
    // Primary path: tie auth identity to E2E user ID
    user = await tooling.user.upsert({
      where: { id: e2eUserId },
      create: { id: e2eUserId, email: e2eEmail },
      update: { email: e2eEmail },
    });
  } catch (error) {
    // Guard against transient unique conflicts (parallel E2E requests)
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }

    user = await tooling.user.findFirst({
      where: { OR: [{ id: e2eUserId }, { email: e2eEmail }] },
    });
    if (!user) {
      throw error;
    }

    user = await tooling.user.update({
      where: { id: user.id },
      data: { email: e2eEmail },
    });
  }

  await bindE2EIdentity(user.id, `e2e_${e2eUserId}`);
  req.user = toAuthUser(user);
  return true;
}

/**
 * The bypass's sign-in identity: the user's one e2e identity carries
 * `e2e_<x-e2e-user-id>`, as user.clerk_id did before work-k5fk.1 (a fixture's
 * seeded e2e_<ms>_<random> subject is rewritten in place on first use, the
 * same change the goldens recorded on clerk_id). Tooling only, never production.
 */
async function bindE2EIdentity(userId: string, subject: string): Promise<void> {
  const tooling = getE2EToolingPrisma();
  const key = { userId_provider: { userId, provider: 'e2e' as const } };
  const existing = await tooling.userIdentity.findUnique({ where: key });
  if (existing?.subject === subject) return;
  try {
    if (existing) await tooling.userIdentity.update({ where: key, data: { subject } });
    else await tooling.userIdentity.create({ data: { provider: 'e2e', subject, userId } });
  } catch (error) {
    // A parallel request of the same user bound it first.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const now = await tooling.userIdentity.findUnique({ where: key });
    if (now?.subject !== subject) throw error;
  }
}

/** The Clerk primary email shape this middleware reads (the SDK's User has more). */
interface ClerkEmailProfile {
  primaryEmailAddressId: string | null;
  emailAddresses: ReadonlyArray<{
    id: string;
    emailAddress: string;
    verification: { status: string } | null;
  }>;
}

/**
 * The Clerk user's primary email address, only when Clerk reports it verified,
 * in canonical form (canonicalEmail: user.email is canonical, work-k5fk.5).
 *
 * Zero trust on Clerk's instance settings: whatever the dashboard allows
 * (unverified sign-ups, extra addresses), a user row only ever gets an email
 * its owner has proven. emailAddresses[0] is not necessarily the primary.
 */
export function verifiedPrimaryEmail(clerkUser: ClerkEmailProfile): string | null {
  const primary = clerkUser.emailAddresses.find(e => e.id === clerkUser.primaryEmailAddressId);
  if (!primary || primary.verification?.status !== 'verified') return null;
  return canonicalEmail(primary.emailAddress) || null;
}

/**
 * Security/support event for a refused first login. Carries ids only, never
 * the email or a name: logs reach CloudWatch, and error level reaches Sentry.
 * Warn level: the request is refused safely, but support needs to find it.
 */
function logIdentityConflict(incomingClerkUserId: string, existingUserId: string | null): void {
  logger.warn('[Auth] auth.identity_conflict: first login refused, email belongs to another account', {
    event: 'auth.identity_conflict',
    existingUserId,
    incomingClerkUserId,
  });
}

/**
 * The SQLSTATE and DETAIL of a database error raised by a raw query
 * (Prisma P2010: @prisma/adapter-pg passes them through as
 * meta.driverAdapterError.cause.code / .detail for an app-defined SQLSTATE).
 */
function pgRaise(error: unknown): { code?: string; detail?: string } {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } } | null)?.meta
    ?.driverAdapterError?.cause;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return { code: str(cause?.originalCode) ?? str(cause?.code), detail: str(cause?.detail) };
}

/** app.create_user's refusal: the email belongs to another account (DETAIL: the holder's id). */
const EMAIL_HELD_ELSEWHERE = 'MWF01';

/**
 * Create the user and its Clerk identity for a first-seen subject, through
 * mwf_auth's app.create_user. The function resolves the concurrent-create
 * race for the same subject (returns that user) and retries once when the
 * email's holder vanished. MWF01 means the email belongs to another account:
 * refuse (409), never re-bind (work-jv9y). Anything else — a unique_violation
 * on the identity key included — is not that case and is rethrown.
 */
async function createFirstLoginUser(
  clerkUserId: string,
  profile: { email: string; firstName: string | null; lastName: string | null },
): Promise<string> {
  try {
    const rows = await getAuthPrisma().$queryRaw<Array<{ id: string }>>`SELECT app.create_user('clerk'::identity_provider, ${clerkUserId}, ${profile.email}, ${profile.firstName}, ${profile.lastName})::text AS id`;
    return rows[0].id;
  } catch (error) {
    const { code, detail } = pgRaise(error);
    if (code !== EMAIL_HELD_ELSEWHERE) throw error;
    // The holder's id is for the support log only: it decides nothing.
    logIdentityConflict(clerkUserId, detail ?? null);
    throw new AccountLinkConflictError();
  }
}

/**
 * Clerk authentication handler
 */
async function handleClerkAuth(req: Request, res: Response, next: NextFunction, required: boolean): Promise<void> {
  // Check for E2E auth bypass first. Its errors go to next(): an async
  // middleware's rejection is not caught by Express 4, so a throw here left
  // the request hanging (found by auth.target.test, TS-12).
  let e2eBypassed: boolean;
  try {
    e2eBypassed = await handleE2EAuthBypass(req);
  } catch (error) {
    next(error);
    return;
  }
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
    // Fast path: resolve the identity in our DB without calling Clerk API.
    // This eliminates an external HTTP call on every authenticated request,
    // preventing Clerk rate-limit (429) errors under high request volume.
    let userId = await resolveUserId('clerk', clerkUserId);

    if (!userId) {
      // Slow path: new identity — fetch details from Clerk to populate the initial record.
      let clerkUser;
      try {
        const { clerkClient } = await import('@clerk/express');
        clerkUser = await clerkClient.users.getUser(clerkUserId);
      } catch (clerkError) {
        // Clerk API may fail due to rate-limiting (429) under burst traffic.
        // Another concurrent request may have already created the user — retry the lookup.
        userId = await resolveUserId('clerk', clerkUserId);
        if (!userId) throw clerkError;
      }

      if (!userId) {
        const email = verifiedPrimaryEmail(clerkUser as unknown as ClerkEmailProfile);
        if (!email) {
          // No row is created for an identity whose email we cannot trust: a row's
          // email is what invitations, display and support match a person by.
          throw new EmailNotVerifiedError();
        }
        // `name` is GENERATED from first/last (spec §1.7): never written. Profile
        // data is copied from Clerk once, at first login; there are no Clerk
        // webhooks, so later Clerk-side changes are not synced.
        userId = await createFirstLoginUser(clerkUserId, {
          email,
          firstName: clerkUser?.firstName || null,
          lastName: clerkUser?.lastName || null,
        });
      }
    }

    const user = await loadUser(userId);
    if (!user) throw new UnauthorizedError('Authentication required');
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
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
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
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
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
export async function requireRelationshipAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
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
 * Checks if the current user has access to a session, and resolves their
 * participant ONCE for the rest of the request (TS-9).
 * Supports both :id and :sessionId route params.
 *
 * Membership is the `participant` row (spec §1.1): a caller with a present
 * participant in the session is in, and `req.participant` / the request
 * context's `participantId` carry it to everything below the route. A session
 * that does not exist is a 404, one the caller does not belong to a 403.
 */
export async function requireSessionAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
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
    const participant = await resolveParticipant(sessionId, user.id, { includeLeft: true });
    if (participant) {
      // A participant who left is refused — never handed to the invitee
      // fallback below (an accepted invitee who left must not get back in).
      if (participant.leftAt) {
        throw new ForbiddenError('Access to this session denied');
      }
      req.participant = participant;
      updateContext({ sessionId, participantId: participant.id });
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

    // Fallback: allow access for invitees during the acceptance timing gap
    // (the participant row is created when the invitation is accepted). Only
    // reached by a caller with NO participant row. Phase 3 §7 schedules this
    // fallback's deletion (W6) — the PENDING arm admits any non-inviter who
    // knows the session id until then. Until then: a live PENDING
    // invitation for this session that the caller did not send, or an ACCEPTED
    // one the caller accepted (`accepted_by_user_id`, new in the target — the
    // old rule admitted ANY non-inviter once the invitation was accepted).
    const invitedSession = await prisma.invitation.findFirst({
      where: {
        sessionId,
        invitedByParticipant: { userId: { not: user.id } },
        OR: [
          { status: 'PENDING', expiresAt: { gt: new Date() } },
          { status: 'ACCEPTED', acceptedByUserId: user.id },
        ],
      },
      select: { id: true },
    });

    if (!invitedSession) {
      throw new ForbiddenError('Access to this session denied');
    }

    next();
  } catch (error) {
    next(error);
  }
}
