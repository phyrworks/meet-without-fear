/**
 * Notification Routes
 *
 * Endpoints for pending action items and badge counts.
 * All routes require authentication.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getPendingActionsHandler, getBadgeCountHandler } from '../controllers/notifications';

const router = Router();

router.use(requireAuth);

/**
 * Get pending actions for a session
 * GET /sessions/:id/pending-actions
 */
router.get('/sessions/:id/pending-actions', getPendingActionsHandler);

/**
 * Get badge count across all active sessions
 * GET /notifications/badge-count
 */
router.get('/notifications/badge-count', getBadgeCountHandler);

export default router;
