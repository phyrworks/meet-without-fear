/**
 * Stage 4 Routes
 *
 * Routes for the Strategic Repair stage of the Meet Without Fear process.
 * - GET /sessions/:id/strategies - Get anonymous strategy pool
 * - POST /sessions/:id/strategies - Propose a strategy
 * - GET /sessions/:id/stage4 - Get redesigned Stage 4 state
 * - POST /sessions/:id/agreements - Create agreement
 * - POST /sessions/:id/agreements/:agreementId/confirm - Confirm agreement
 */

import { Router } from 'express';
import { requireAuth, requireSessionAccess } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import {
  openStage4SubChat,
  getStage4SubChat,
  sendStage4SubChatMessage,
  resolveStage4SubChat,
} from '../controllers/stage4-subchat';
import {
  getStrategies,
  getStage4State,
  submitStage4ProposalSelection,
  submitStage4Selections,
  updateStage4WalkthroughNeedStatus,
  shareStage4Selections,
  unshareStage4Selections,
  declineStage4Need,
  undeclineStage4Need,
  closeStage4,
  proposeStrategy,
  createAgreement,
  confirmAgreement,
  requestSuggestions,
  getAgreements,
} from '../controllers/stage4';

const router = Router();

// Get redesigned Stage 4 state
router.get('/sessions/:id/stage4', requireAuth, requireSessionAccess, asyncHandler(getStage4State));

// Submit one redesigned Stage 4 per-proposal willingness decision
router.post(
  '/sessions/:id/stage4/proposals/:proposalId/selection',
  requireAuth,
  requireSessionAccess,
  asyncHandler(submitStage4ProposalSelection),
);

// Submit redesigned Stage 4 per-proposal willingness decisions
router.post('/sessions/:id/stage4/selections', requireAuth, requireSessionAccess, asyncHandler(submitStage4Selections));

router.post(
  '/sessions/:id/stage4/walkthrough/needs/:needId',
  requireAuth,
  requireSessionAccess,
  asyncHandler(updateStage4WalkthroughNeedStatus),
);

router.post(
  '/sessions/:id/stage4/proposals/suggest',
  requireAuth,
  requireSessionAccess,
  asyncHandler(requestSuggestions),
);

// Share current user's Stage 4 selections with their partner
router.post(
  '/sessions/:id/stage4/share-selections',
  requireAuth,
  requireSessionAccess,
  asyncHandler(shareStage4Selections),
);

// Mark a need as "leave for now"
router.post(
  '/sessions/:id/stage4/needs/:needId/decline',
  requireAuth,
  requireSessionAccess,
  asyncHandler(declineStage4Need),
);

// Remove a "leave for now" declination
router.delete(
  '/sessions/:id/stage4/needs/:needId/decline',
  requireAuth,
  requireSessionAccess,
  asyncHandler(undeclineStage4Need),
);

// Withdraw current user's shared Stage 4 selections so they can revise
router.post(
  '/sessions/:id/stage4/unshare-selections',
  requireAuth,
  requireSessionAccess,
  asyncHandler(unshareStage4Selections),
);

// Close redesigned Stage 4 from willingness selections
router.post('/sessions/:id/stage4/close', requireAuth, requireSessionAccess, asyncHandler(closeStage4));

// Stage 4 Sub-chat (Phase 3)
router.post('/sessions/:id/stage4/subchat', requireAuth, requireSessionAccess, asyncHandler(openStage4SubChat));
router.get(
  '/sessions/:id/stage4/subchat/:subChatId',
  requireAuth,
  requireSessionAccess,
  asyncHandler(getStage4SubChat),
);
router.post(
  '/sessions/:id/stage4/subchat/:subChatId/messages',
  requireAuth,
  requireSessionAccess,
  asyncHandler(sendStage4SubChatMessage),
);
router.post(
  '/sessions/:id/stage4/subchat/:subChatId/resolve',
  requireAuth,
  requireSessionAccess,
  asyncHandler(resolveStage4SubChat),
);

// Get anonymous strategy pool
router.get('/sessions/:id/strategies', requireAuth, requireSessionAccess, asyncHandler(getStrategies));

// Propose a new strategy
router.post('/sessions/:id/strategies', requireAuth, requireSessionAccess, asyncHandler(proposeStrategy));

// Create agreement
router.post('/sessions/:id/agreements', requireAuth, requireSessionAccess, asyncHandler(createAgreement));

// Confirm agreement
router.post(
  '/sessions/:id/agreements/:agreementId/confirm',
  requireAuth,
  requireSessionAccess,
  asyncHandler(confirmAgreement),
);

// Request AI strategy suggestions
router.post('/sessions/:id/strategies/suggest', requireAuth, requireSessionAccess, asyncHandler(requestSuggestions));

// Get agreements list
router.get('/sessions/:id/agreements', requireAuth, requireSessionAccess, asyncHandler(getAgreements));

export default router;
