/**
 * Stage 0 Routes - Curiosity Compact
 *
 * Endpoints for signing and checking status of the Curiosity Compact.
 */

import { Router } from 'express';
import { requireAuth, requireSessionAccess } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { signCompact, getCompactStatus } from '../controllers/stage0';

const router = Router();

/**
 * @route POST /api/v1/sessions/:id/compact/sign
 * @description Sign the Curiosity Compact for a session
 * @access Private - requires authentication and session access
 */
router.post('/sessions/:id/compact/sign', requireAuth, requireSessionAccess, asyncHandler(signCompact));

/**
 * @route GET /api/v1/sessions/:id/compact/status
 * @description Get the compact signing status for a session
 * @access Private - requires authentication and session access
 */
router.get('/sessions/:id/compact/status', requireAuth, requireSessionAccess, asyncHandler(getCompactStatus));

export default router;
