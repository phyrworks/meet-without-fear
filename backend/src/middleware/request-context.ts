/**
 * Request Context Middleware
 *
 * Sets up AsyncLocalStorage-based request context at the start of each HTTP request.
 * This allows all downstream code (services, loggers, etc.) to access the context
 * without explicit parameter passing.
 */

import { Request, Response, NextFunction } from 'express';
import { runWithContext, updateContext, generateRequestId, RequestContext } from '../lib/request-context';

/**
 * Middleware to establish request context for all routes.
 * Must be registered early in the middleware chain.
 *
 * The turnId is initially set to a request-based ID and can be updated
 * once session/user information is available in the route handler.
 */
export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const requestId = generateRequestId();

  // Extract sessionId from common route param patterns
  const sessionId = req.params?.id || req.params?.sessionId || undefined;

  // Extract E2E fixture ID from header (for per-request fixture selection in tests)
  const e2eFixtureId = req.headers['x-e2e-fixture-id'] as string | undefined;

  // Initial context - turnId will be refined once we know user info
  const context: RequestContext = {
    requestId,
    turnId: `${sessionId || 'global'}-${requestId}`,
    sessionId,
    userId: undefined, // Will be set by auth middleware
    startTime: Date.now(),
    e2eFixtureId,
  };

  // Run the rest of the middleware/route handlers within this context
  runWithContext(context, () => {
    // Add helper method to refine turnId once user/session info is available
    req.setTurnId = (turnId: string) => {
      updateContext({ turnId });
    };

    req.setContextUser = (userId: string) => {
      updateContext({ userId });
    };

    req.setContextSession = (sessionId: string) => {
      updateContext({ sessionId });
    };

    next();
  });
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      /** Set the turnId for this request (call after determining user turn count) */
      setTurnId?: (turnId: string) => void;
      /** Set the userId in the request context */
      setContextUser?: (userId: string) => void;
      /** Set the sessionId in the request context */
      setContextSession?: (sessionId: string) => void;
    }
  }
}
