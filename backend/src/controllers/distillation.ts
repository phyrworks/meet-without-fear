/**
 * Distillation Controller
 *
 * Handles POST /inner-thoughts/:id/distill — on-demand distillation.
 *
 * The user triggers this synchronously to receive takeaways immediately.
 * Fire-and-forget distillation (on session COMPLETED) is handled separately
 * in the inner-work controller's updateInnerWorkSession handler.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { asyncHandler, NotFoundError } from '../middleware/errors';
import { getUser } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { distillSession } from '../services/distillation';
import type { ApiResponse, DistillSessionResponse } from '@meet-without-fear/shared';

/**
 * POST /inner-thoughts/:id/distill
 *
 * Runs distillation synchronously for the given session.
 * Returns the resulting takeaways directly in the response.
 *
 * Rate limited via streamingRateLimit (LLM-backed endpoint).
 */
export const distillInnerWorkSession = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);
  const sessionId = req.params.id;
  const turnId = crypto.randomUUID();

  // Verify session exists and belongs to the authenticated user
  const session = await prisma.reflection.findFirst({
    where: { id: sessionId, userId: user.id },
    select: { id: true },
  });
  if (!session) throw new NotFoundError('Session not found');

  // Run distillation synchronously (user is waiting for result)
  const takeaways = await distillSession({ sessionId, userId: user.id, turnId });

  const response: ApiResponse<DistillSessionResponse> = {
    success: true,
    data: {
      takeaways,
      distilledAt: new Date().toISOString(),
    },
  };
  res.json(response);
});
