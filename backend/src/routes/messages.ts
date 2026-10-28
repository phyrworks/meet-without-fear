/**
 * Messages Routes
 *
 * Routes for chat messaging across all stages of the Meet Without Fear process.
 * - POST /sessions/:id/messages - Send message and get AI response (fire-and-forget)
 * - POST /sessions/:id/feel-heard - Confirm user feels heard (Stage 1)
 * - GET /sessions/:id/messages - Get conversation history
 * - POST /sessions/:id/messages/initial - Get AI-generated initial message
 */

import { Router } from 'express';
import { requireAuth, requireSessionAccess } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { streamingRateLimit } from '../middleware/rate-limit';
import {
  sendMessage,
  sendMessageStream,
  confirmFeelHeard,
  getConversationHistory,
  getInitialMessage,
} from '../controllers/messages';

const router = Router();

// Send message and get AI witness response
router.post('/sessions/:id/messages', requireAuth, requireSessionAccess, streamingRateLimit, asyncHandler(sendMessage));

// Send message with streaming AI response (SSE)
router.post(
  '/sessions/:id/messages/stream',
  requireAuth,
  requireSessionAccess,
  streamingRateLimit,
  asyncHandler(sendMessageStream),
);

// Confirm user feels heard
router.post('/sessions/:id/feel-heard', requireAuth, requireSessionAccess, asyncHandler(confirmFeelHeard));

// Get conversation history
router.get('/sessions/:id/messages', requireAuth, requireSessionAccess, asyncHandler(getConversationHistory));

// Get AI-generated initial message for a session/stage
router.post(
  '/sessions/:id/messages/initial',
  requireAuth,
  requireSessionAccess,
  streamingRateLimit,
  asyncHandler(getInitialMessage),
);

export default router;
