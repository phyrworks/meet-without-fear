/**
 * Takeaway CRUD Controller
 *
 * Handles per-takeaway operations for distilled Inner Thoughts sessions:
 * - GET /inner-thoughts/:id/takeaways     — List all takeaways for a session
 * - PATCH /inner-thoughts/:id/takeaways/:takeawayId — Update takeaway content
 * - DELETE /inner-thoughts/:id/takeaways/:takeawayId — Delete a takeaway
 *
 * These endpoints are consumed by the mobile TakeawayReviewSheet for inline
 * editing (DIST-05) and swipe-to-delete (DIST-06).
 *
 * Target shape (TS-12): `reflection` / `takeaway` (spec §1.6), the caller's own
 * rows only (reflection.user_id = me).
 */

import { Request, Response } from 'express';
import { asyncHandler, NotFoundError, ValidationError } from '../middleware/errors';
import { getUser } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { mapTakeawayToDTO } from '../services/distillation';
import type {
  ApiResponse,
  GetTakeawaysResponse,
  UpdateTakeawayResponse,
  DeleteTakeawayResponse,
} from '@meet-without-fear/shared';

// ============================================================================
// Helper
// ============================================================================

/** The caller's own reflection (spec §1.6 RLS shape: user_id = me), or a 404. */
async function ownReflection(userId: string, reflectionId: string): Promise<{ id: string; distilledAt: Date | null }> {
  const reflection = await prisma.reflection.findFirst({
    where: { id: reflectionId, userId },
    select: { id: true, distilledAt: true },
  });
  if (!reflection) throw new NotFoundError('Session not found');
  return reflection;
}

/** A takeaway of that reflection, or a 404. */
async function takeawayOf(reflectionId: string, takeawayId: string): Promise<void> {
  const existing = await prisma.takeaway.findFirst({
    where: { id: takeawayId, reflectionId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('Takeaway not found');
}

// ============================================================================
// GET /inner-thoughts/:id/takeaways
// ============================================================================

/**
 * List all takeaways for a session.
 *
 * Returns the takeaway list and the session's `distilledAt` timestamp.
 * Returns an empty array (not 404) when no takeaways exist.
 */
export const getTakeaways = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const user = getUser(req);
    const session = await ownReflection(user.id, req.params.id);

    const rawTakeaways = await prisma.takeaway.findMany({
      where: { reflectionId: session.id },
      orderBy: { position: 'asc' },
    });

    const response: ApiResponse<GetTakeawaysResponse> = {
      success: true,
      data: {
        takeaways: rawTakeaways.map(mapTakeawayToDTO),
        distilledAt: session.distilledAt?.toISOString() ?? null,
      },
    };
    res.json(response);
  }
);

// ============================================================================
// PATCH /inner-thoughts/:id/takeaways/:takeawayId
// ============================================================================

/**
 * Update a takeaway's content.
 *
 * Changes the source from 'AI' to 'USER' to mark it as user-edited.
 * USER-sourced takeaways are preserved during re-distillation.
 */
export const updateTakeaway = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const user = getUser(req);
    const { id: sessionId, takeawayId } = req.params;
    const { content } = req.body as { content?: string };

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new ValidationError('content is required and must be a non-empty string');
    }

    await ownReflection(user.id, sessionId);
    await takeawayOf(sessionId, takeawayId);

    const updated = await prisma.takeaway.update({
      where: { id: takeawayId },
      data: {
        content: content.trim(),
        source: 'USER', // Mark as user-edited to preserve on re-distillation
      },
    });

    const response: ApiResponse<UpdateTakeawayResponse> = {
      success: true,
      data: { takeaway: mapTakeawayToDTO(updated) },
    };
    res.json(response);
  }
);

// ============================================================================
// DELETE /inner-thoughts/:id/takeaways/:takeawayId
// ============================================================================

/**
 * Delete a single takeaway.
 *
 * Permanently removes the takeaway. Cannot be undone.
 */
export const deleteTakeaway = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const user = getUser(req);
    const { id: sessionId, takeawayId } = req.params;

    await ownReflection(user.id, sessionId);
    await takeawayOf(sessionId, takeawayId);

    await prisma.takeaway.delete({
      where: { id: takeawayId },
    });

    const response: ApiResponse<DeleteTakeawayResponse> = {
      success: true,
      data: { success: true },
    };
    res.json(response);
  }
);
