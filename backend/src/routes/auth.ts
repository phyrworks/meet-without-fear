/**
 * Auth Routes
 *
 * Routes for authentication-related endpoints.
 *
 * All routes in this file require authentication via requireAuth middleware.
 * Note: Controllers already use asyncHandler internally.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  getMe,
  updateProfile,
  updatePushToken,
  deletePushToken,
  scheduleTestPushNotification,
  getAblyToken,
  updateBiometricPreference,
  getMemoryPreferences,
  updateMemoryPreferences,
  getNotificationPreferences,
  updateNotificationPreferences,
  getPrivacyPreferences,
  updatePrivacyPreferences,
  updateMood,
  deleteAccount,
} from '../controllers/auth';

const router = Router();

// All auth routes require authentication
router.use(requireAuth);

/**
 * GET /auth/me
 *
 * Get the current user's profile and session status.
 *
 * Response: GetMeResponse
 * - user: UserDTO
 * - activeSessions: number
 * - pushNotificationsEnabled: boolean
 */
router.get('/me', getMe);

/**
 * PATCH /auth/me
 *
 * Update the current user's profile.
 *
 * Request: UpdateProfileRequest
 * - name?: string
 *
 * Response: UpdateProfileResponse
 * - user: UserDTO
 */
router.patch('/me', updateProfile);

/**
 * POST /auth/push-token
 *
 * Register or update push notification token.
 *
 * Request: UpdatePushTokenRequest
 * - pushToken: string
 * - platform: 'ios' | 'android'
 *
 * Response: UpdatePushTokenResponse
 * - registered: boolean
 */
router.post('/push-token', updatePushToken);

/**
 * DELETE /auth/push-token
 *
 * Remove push notification token (disable push notifications).
 *
 * Response: UpdatePushTokenResponse
 * - registered: boolean (always false)
 */
router.delete('/push-token', deletePushToken);

/**
 * POST /auth/test-push-notification
 *
 * Schedule a test push notification for approved internal accounts.
 *
 * Response:
 * - scheduled: true
 * - delaySeconds: number
 */
router.post('/test-push-notification', scheduleTestPushNotification);

/**
 * GET /auth/ably-token
 *
 * Get an Ably token for realtime communication.
 * Token is scoped to the user's active sessions.
 *
 * Response: AblyTokenResponse
 * - tokenRequest: AblyTokenRequest object
 */
router.get('/ably-token', getAblyToken);

/**
 * PATCH /auth/biometric
 *
 * Update biometric authentication preference.
 *
 * Request: UpdateBiometricPreferenceRequest
 * - enabled: boolean
 *
 * Response: UpdateBiometricPreferenceResponse
 * - biometricEnabled: boolean
 * - biometricEnrolledAt: string | null
 */
router.patch('/biometric', updateBiometricPreference);

/**
 * GET /auth/me/memory-preferences
 *
 * Get current memory preferences.
 *
 * Response: GetMemoryPreferencesResponse
 * - preferences: MemoryPreferencesDTO
 */
router.get('/me/memory-preferences', getMemoryPreferences);

/**
 * PUT /auth/me/memory-preferences
 *
 * Update memory preferences.
 *
 * Request: UpdateMemoryPreferencesRequest
 * - sessionContinuity?: boolean
 * - crossSessionRecall?: boolean
 * - patternInsights?: boolean
 * - rememberAgreements?: boolean
 *
 * Response: UpdateMemoryPreferencesResponse
 * - preferences: MemoryPreferencesDTO
 */
router.put('/me/memory-preferences', updateMemoryPreferences);

/**
 * GET /auth/me/notification-preferences
 *
 * Get current notification preferences.
 *
 * Response: GetNotificationPreferencesResponse
 * - preferences: NotificationPreferencesDTO
 */
router.get('/me/notification-preferences', getNotificationPreferences);

/**
 * PATCH /auth/me/notification-preferences
 *
 * Update notification preferences.
 *
 * Request: UpdateNotificationPreferencesRequest
 * - pushEnabled?: boolean
 * - emailEnabled?: boolean
 * - newInvitations?: boolean
 * - partnerActions?: boolean
 * - followUpReminders?: boolean
 *
 * Response: UpdateNotificationPreferencesResponse
 * - preferences: NotificationPreferencesDTO
 */
router.patch('/me/notification-preferences', updateNotificationPreferences);

/**
 * GET /auth/me/privacy-preferences
 *
 * Get current privacy preferences.
 *
 * Response: GetPrivacyPreferencesResponse
 * - preferences: PrivacyPreferencesDTO
 */
router.get('/me/privacy-preferences', getPrivacyPreferences);

/**
 * PATCH /auth/me/privacy-preferences
 *
 * Update privacy preferences.
 *
 * Request: UpdatePrivacyPreferencesRequest
 * - showActivityStatus?: boolean
 * - allowSessionInvites?: boolean
 *
 * Response: UpdatePrivacyPreferencesResponse
 * - preferences: PrivacyPreferencesDTO
 */
router.patch('/me/privacy-preferences', updatePrivacyPreferences);

/**
 * PATCH /auth/me/mood
 *
 * Validates the user's mood intensity and echoes it. Stores nothing: the last mood (GET /auth/me
 * lastMoodIntensity, the default for the next session's mood check) is the user's latest
 * mood_reading, which the session-entry check records for its own session via
 * POST /sessions/:id/emotions (work-k5fk.34).
 *
 * Request: { intensity: number } (1-10)
 *
 * Response: { lastMoodIntensity: number }
 */
router.patch('/me/mood', updateMood);

/**
 * DELETE /auth/me
 *
 * Permanently delete the user's account.
 *
 * This action:
 * - Marks active sessions as ABANDONED
 * - Notifies partners in active sessions via SESSION_ABANDONED notification
 * - Preserves shared content for partners (anonymized - source user becomes null)
 * - Deletes all private user data (inner work, drafts, progress, etc.)
 * - Removes user from all relationships
 *
 * Response: DeleteAccountResponse
 * - success: boolean
 * - summary: { sessionsAbandoned, partnersNotified, dataRecordsDeleted }
 */
router.delete('/me', deleteAccount);

export default router;
