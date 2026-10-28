import { Router } from 'express';
import { requireAuth, requireSessionAccess } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import {
  getTendingEntries,
  getTendingHistory,
  postTendingBetweenPeriodNote,
  postTendingCheckin,
  postTendingEntryShare,
  postTendingEntryUnshare,
  postTendingReentry,
  postTendingResponse,
} from '../controllers/tending';

const router = Router();

router.get('/sessions/:id/tending', requireAuth, requireSessionAccess, asyncHandler(getTendingEntries));

router.get('/sessions/:id/tending/history', requireAuth, requireSessionAccess, asyncHandler(getTendingHistory));

router.post('/sessions/:id/tending/checkin', requireAuth, requireSessionAccess, asyncHandler(postTendingCheckin));

router.post(
  '/sessions/:id/tending/notes',
  requireAuth,
  requireSessionAccess,
  asyncHandler(postTendingBetweenPeriodNote),
);

router.post('/sessions/:id/tending/reentry', requireAuth, requireSessionAccess, asyncHandler(postTendingReentry));

router.post(
  '/sessions/:id/tending/:entryId/responses',
  requireAuth,
  requireSessionAccess,
  asyncHandler(postTendingResponse),
);

router.post(
  '/sessions/:id/tending/:entryId/share',
  requireAuth,
  requireSessionAccess,
  asyncHandler(postTendingEntryShare),
);

router.post(
  '/sessions/:id/tending/:entryId/unshare',
  requireAuth,
  requireSessionAccess,
  asyncHandler(postTendingEntryUnshare),
);

export default router;
