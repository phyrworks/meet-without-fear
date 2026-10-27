/**
 * Reconciler Routes
 *
 * Endpoints for the Empathy Reconciler system that analyzes gaps
 * between empathy guesses and actual feelings after Stage 2.
 *
 * All routes require authentication and are scoped to sessions.
 */

import { Router } from 'express';
import { requireAuth, requireSessionAccess } from '../middleware/auth';
import { empathyRateLimit } from '../middleware/rate-limit';
import {
  runReconcilerHandler,
  getReconcilerStatusHandler,
  getShareOfferHandler,
  respondToShareOfferHandler,
  getReconcilerSummaryHandler,
  skipShareOfferHandler,
  generateShareDraftHandler,
  refinementChatMessageHandler,
  refinementFinalizeHandler,
} from '../controllers/reconciler';

const router = Router();

// All reconciler routes require authentication; each resolves the caller's participant
// (requireSessionAccess, TS-9) — the reconciler reads are per participant (TS-10).
router.use(requireAuth);

/**
 * Run reconciler analysis for a session
 * POST /sessions/:id/reconciler/run
 *
 * Analyzes empathy gaps in both directions (A→B and B→A).
 * Should be called after both users have shared their empathy statements.
 */
router.post('/sessions/:id/reconciler/run', requireSessionAccess, empathyRateLimit, runReconcilerHandler);

/**
 * Get reconciler status for a session
 * GET /sessions/:id/reconciler/status
 *
 * Returns whether reconciler has run, results, pending offers, and readiness.
 */
router.get('/sessions/:id/reconciler/status', requireSessionAccess, getReconcilerStatusHandler);

/**
 * Get pending share offer for the current user
 * GET /sessions/:id/reconciler/share-offer
 *
 * Returns any pending share offer for the authenticated user.
 * Includes the offer message and quote options to choose from.
 */
router.get('/sessions/:id/reconciler/share-offer', requireSessionAccess, getShareOfferHandler);

/**
 * Respond to a share offer
 * POST /sessions/:id/reconciler/share-offer/respond
 *
 * Accept (with selected quote or custom content) or decline the share offer.
 */
router.post('/sessions/:id/reconciler/share-offer/respond', requireSessionAccess, empathyRateLimit, respondToShareOfferHandler);

/**
 * Skip share offer without explicit response
 * POST /sessions/:id/reconciler/share-offer/skip
 *
 * Marks the share offer as skipped, allowing progression without sharing.
 */
router.post('/sessions/:id/reconciler/share-offer/skip', requireSessionAccess, empathyRateLimit, skipShareOfferHandler);

/**
 * Generate a share draft for the user
 * POST /sessions/:id/reconciler/share-offer/generate-draft
 *
 * Called when user taps "Yes, help me share" in the ShareTopicDrawer.
 * Generates a draft based on suggestedShareFocus and saves as AI message.
 */
router.post('/sessions/:id/reconciler/share-offer/generate-draft', requireSessionAccess, empathyRateLimit, generateShareDraftHandler);

/**
 * Get reconciler summary after completion
 * GET /sessions/:id/reconciler/summary
 *
 * Returns an AI-generated summary of the empathy exchange.
 * Only available after reconciliation is complete.
 */
router.get('/sessions/:id/reconciler/summary', requireSessionAccess, getReconcilerSummaryHandler);

/**
 * Refinement chat message (stateless, Haiku-powered)
 * POST /sessions/:id/reconciler/refinement/message
 *
 * Client sends full conversation history each time. No DB writes.
 * Returns AI coaching response and optional proposed content.
 */
router.post('/sessions/:id/reconciler/refinement/message', requireSessionAccess, empathyRateLimit, refinementChatMessageHandler);

/**
 * Finalize refinement — share refined content with partner
 * POST /sessions/:id/reconciler/refinement/finalize
 *
 * Creates SHARED_CONTEXT message and notifies partner via Ably.
 */
router.post('/sessions/:id/reconciler/refinement/finalize', requireSessionAccess, empathyRateLimit, refinementFinalizeHandler);

export default router;
