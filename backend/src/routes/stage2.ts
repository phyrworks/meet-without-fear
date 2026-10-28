/**
 * Stage 2 Routes
 *
 * Routes for the Perspective Stretch / Empathy stage of the Meet Without Fear process.
 * - POST /sessions/:id/empathy/draft - Save empathy draft
 * - GET /sessions/:id/empathy/draft - Get current draft
 * - POST /sessions/:id/empathy/consent - Consent to share
 * - GET /sessions/:id/empathy/partner - Get partner's empathy
 * - POST /sessions/:id/empathy/validate - Validate partner's empathy
 * - GET /sessions/:id/empathy/status - Get empathy exchange status
 * - POST /sessions/:id/empathy/refine - Refinement conversation (when NEEDS_WORK or REFINING)
 * - POST /sessions/:id/empathy/resubmit - Resubmit revised empathy statement
 * - POST /sessions/:id/empathy/skip-refinement - Skip refinement / acceptance check
 * - POST /sessions/:id/empathy/validation-feedback/draft - Save validation feedback draft
 * - POST /sessions/:id/empathy/validation-feedback/refine - Refine validation feedback (Feedback Coach)
 *
 * NEW: Share suggestion flow (asymmetric reconciler)
 * - GET /sessions/:id/empathy/share-suggestion - Get share suggestion for current user
 * - POST /sessions/:id/empathy/share-suggestion/respond - Respond to share suggestion
 */

import { Router } from 'express';
import { requireAuth, requireSessionAccess } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import {
  saveDraft,
  getDraft,
  consentToShare,
  getPartnerEmpathy,
  validateEmpathy,
  getEmpathyExchangeStatus,
  refineEmpathy,
  resubmitEmpathy,
  getShareSuggestion,
  respondToShareSuggestion,
  skipRefinement,
  saveValidationFeedbackDraft,
  refineValidationFeedback,
} from '../controllers/stage2';

const router = Router();

// Save empathy draft
router.post('/sessions/:id/empathy/draft', requireAuth, requireSessionAccess, asyncHandler(saveDraft));

// Get current empathy draft
router.get('/sessions/:id/empathy/draft', requireAuth, requireSessionAccess, asyncHandler(getDraft));

// Consent to share empathy with partner
router.post('/sessions/:id/empathy/consent', requireAuth, requireSessionAccess, asyncHandler(consentToShare));

// Get partner's empathy attempt
router.get('/sessions/:id/empathy/partner', requireAuth, requireSessionAccess, asyncHandler(getPartnerEmpathy));

// Validate partner's empathy attempt
router.post('/sessions/:id/empathy/validate', requireAuth, requireSessionAccess, asyncHandler(validateEmpathy));

// Get empathy exchange status (for UI state management)
router.get('/sessions/:id/empathy/status', requireAuth, requireSessionAccess, asyncHandler(getEmpathyExchangeStatus));

// Refinement conversation (when status is NEEDS_WORK)
router.post('/sessions/:id/empathy/refine', requireAuth, requireSessionAccess, asyncHandler(refineEmpathy));

// Resubmit revised empathy statement
router.post('/sessions/:id/empathy/resubmit', requireAuth, requireSessionAccess, asyncHandler(resubmitEmpathy));

// ============================================================================
// Validation Feedback / Feedback Coach Flow
// ============================================================================

// Skip refinement (accept the difference or decline)
router.post('/sessions/:id/empathy/skip-refinement', requireAuth, requireSessionAccess, asyncHandler(skipRefinement));

// Save validation feedback draft (Feedback Coach)
router.post(
  '/sessions/:id/empathy/validation-feedback/draft',
  requireAuth,
  requireSessionAccess,
  asyncHandler(saveValidationFeedbackDraft),
);

// Refine validation feedback (Feedback Coach)
router.post(
  '/sessions/:id/empathy/validation-feedback/refine',
  requireAuth,
  requireSessionAccess,
  asyncHandler(refineValidationFeedback),
);

// ============================================================================
// Share Suggestion Flow (Asymmetric Reconciler)
// ============================================================================

// Get share suggestion for current user (called by subject when partner has gaps)
router.get(
  '/sessions/:id/empathy/share-suggestion',
  requireAuth,
  requireSessionAccess,
  asyncHandler(getShareSuggestion),
);

// Respond to share suggestion (accept, decline, or refine)
router.post(
  '/sessions/:id/empathy/share-suggestion/respond',
  requireAuth,
  requireSessionAccess,
  asyncHandler(respondToShareSuggestion),
);

export default router;
