import { Router } from 'express';
import {
  listSessions,
  createSession,
  getInvitation,
  acceptInvitation,
  declineInvitation,
  acknowledgeInvitation,
  updateNickname,
  listPeople,
  archiveSession,
  deleteSession,
} from '../controllers/invitations';
import { requireAuth, requireSessionAccess } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { invitationLookupRateLimit } from '../middleware/rate-limit';

const router = Router();

/**
 * @route GET /api/v1/sessions
 * @description List user's sessions
 * @access Private - requires authentication
 */
router.get('/sessions', requireAuth, asyncHandler(listSessions));

/**
 * @route POST /api/v1/sessions
 * @description Create a new session with an invitation
 * @access Private - requires authentication
 */
router.post('/sessions', requireAuth, asyncHandler(createSession));

/**
 * @route GET /api/v1/invitations/:id
 * @description Get invitation details (public info for accepting/declining)
 * @access Public - but only returns limited info
 */
router.get('/invitations/:id', invitationLookupRateLimit, asyncHandler(getInvitation));

/**
 * @route POST /api/v1/invitations/:id/accept
 * @description Accept an invitation and join the session
 * @access Private - requires authentication
 */
router.post('/invitations/:id/accept', requireAuth, asyncHandler(acceptInvitation));

/**
 * @route POST /api/v1/invitations/:id/decline
 * @description Decline an invitation
 * @access Private - requires authentication
 */
router.post('/invitations/:id/decline', requireAuth, asyncHandler(declineInvitation));

/**
 * @route POST /api/v1/invitations/:id/acknowledge
 * @description Acknowledge viewing a pending invitation (creates notification)
 * @access Private - requires authentication
 */
router.post('/invitations/:id/acknowledge', requireAuth, asyncHandler(acknowledgeInvitation));

/**
 * @route PATCH /api/v1/contacts/:userId/nickname
 * @description Set or clear what you call another user (your own contact entry; work-k5fk.2)
 * @access Private - requires authentication; someone you share a session with
 */
router.patch('/contacts/:userId/nickname', requireAuth, asyncHandler(updateNickname));

/**
 * @route GET /api/v1/people
 * @description List people the user has relationships with
 * @access Private - requires authentication
 */
router.get('/people', requireAuth, asyncHandler(listPeople));

/**
 * @route POST /api/v1/sessions/:id/archive
 * @description Archive a session (for resolved, abandoned, or pending sessions)
 * @access Private - requires authentication and session access
 */
router.post('/sessions/:id/archive', requireAuth, requireSessionAccess, asyncHandler(archiveSession));

/**
 * @route DELETE /api/v1/sessions/:id
 * @description Delete a session for the current user
 *
 * This action:
 * - Marks active sessions as ABANDONED
 * - Notifies partners in active sessions via SESSION_ABANDONED notification
 * - Preserves shared content for partners (anonymized - source user becomes null)
 * - Deletes all private user data for this session (vessel, drafts, progress, etc.)
 * - Partner keeps access to their own data and the session
 * @access Private - requires authentication and session access
 */
router.delete('/sessions/:id', requireAuth, requireSessionAccess, asyncHandler(deleteSession));

export default router;
