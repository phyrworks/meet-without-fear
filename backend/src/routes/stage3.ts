/**
 * Stage 3 Routes
 *
 * Routes for the What Matters stage of the Meet Without Fear process.
 * - GET /sessions/:id/needs - Get identified needs
 * - POST /sessions/:id/needs/capture - Capture needs from an AI summary card
 * - POST /sessions/:id/needs/confirm - Confirm needs
 * - POST /sessions/:id/needs/consent - Consent to share needs
 * - POST /sessions/:id/needs/validate - Validate revealed needs
 */

import { Router } from 'express';
import { requireAuth, requireSessionAccess } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import {
  getNeeds,
  captureNeeds,
  confirmNeeds,
  consentToShareNeeds,
  validateNeeds,
  addCustomNeed,
  getNeedsComparison,
  interpretNeedEdit,
  applyNeedEditPlan,
  removeNeed,
} from '../controllers/stage3';

const router = Router();

// Get identified needs for the user
router.get('/sessions/:id/needs', requireAuth, requireSessionAccess, asyncHandler(getNeeds));

// Capture needs from an AI summary card
router.post('/sessions/:id/needs/capture', requireAuth, requireSessionAccess, asyncHandler(captureNeeds));

// Confirm user's needs
router.post('/sessions/:id/needs/confirm', requireAuth, requireSessionAccess, asyncHandler(confirmNeeds));

// Consent to share needs with partner
router.post('/sessions/:id/needs/consent', requireAuth, requireSessionAccess, asyncHandler(consentToShareNeeds));

// Validate revealed needs
router.post('/sessions/:id/needs/validate', requireAuth, requireSessionAccess, asyncHandler(validateNeeds));

// Get needs comparison (side-by-side view of both users' needs)
router.get('/sessions/:id/needs/comparison', requireAuth, requireSessionAccess, asyncHandler(getNeedsComparison));

// Reveal alias for clients using the Stage 3 capture/consent/reveal/validation vocabulary
router.get('/sessions/:id/needs/reveal', requireAuth, requireSessionAccess, asyncHandler(getNeedsComparison));

// Add custom need
router.post('/sessions/:id/needs', requireAuth, requireSessionAccess, asyncHandler(addCustomNeed));

router.post(
  '/sessions/:id/needs/interpret-edit-request',
  requireAuth,
  requireSessionAccess,
  asyncHandler(interpretNeedEdit),
);

router.post('/sessions/:id/needs/apply-edits', requireAuth, requireSessionAccess, asyncHandler(applyNeedEditPlan));

router.delete('/sessions/:id/needs/:needId', requireAuth, requireSessionAccess, asyncHandler(removeNeed));

export default router;
