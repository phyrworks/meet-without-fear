/**
 * Consent Routes
 *
 * Routes for consent management operations:
 * - GET /sessions/:id/consent/pending - Get pending consent requests
 * - POST /sessions/:id/consent/decide - Grant or deny consent
 * - POST /sessions/:id/consent/revoke - Revoke previously granted consent
 * - GET /sessions/:id/consent/history - Get consent history
 */

import { Router } from 'express';
import { requireAuth, requireSessionAccess } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { getPendingConsents, decideConsent, revokeConsent, getConsentHistory } from '../controllers/consent';

const router = Router();

/**
 * @route GET /api/v1/sessions/:id/consent/pending
 * @description Get pending consent requests
 * @access Private - requires authentication and session access
 */
router.get('/sessions/:id/consent/pending', requireAuth, requireSessionAccess, asyncHandler(getPendingConsents));

/**
 * @route POST /api/v1/sessions/:id/consent/decide
 * @description Grant or deny a consent request
 * @access Private - requires authentication and session access
 */
router.post('/sessions/:id/consent/decide', requireAuth, requireSessionAccess, asyncHandler(decideConsent));

/**
 * @route POST /api/v1/sessions/:id/consent/revoke
 * @description Revoke previously granted consent
 * @access Private - requires authentication and session access
 */
router.post('/sessions/:id/consent/revoke', requireAuth, requireSessionAccess, asyncHandler(revokeConsent));

/**
 * @route GET /api/v1/sessions/:id/consent/history
 * @description Get consent history for the session
 * @access Private - requires authentication and session access
 */
router.get('/sessions/:id/consent/history', requireAuth, requireSessionAccess, asyncHandler(getConsentHistory));

export default router;
