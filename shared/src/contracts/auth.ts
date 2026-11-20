/**
 * Auth API Contracts
 *
 * Zod schemas for auth-related API endpoints.
 */

import { z } from 'zod';

// ============================================================================
// User Schema
// ============================================================================

export const userDTOSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  biometricEnabled: z.boolean(),
  createdAt: z.string().datetime(),
});

// ============================================================================
// GET /auth/me
// ============================================================================

export const getMeResponseSchema = z.object({
  user: userDTOSchema,
  activeSessions: z.number().int().min(0),
  pushNotificationsEnabled: z.boolean(),
});

export type GetMeResponseInput = z.infer<typeof getMeResponseSchema>;

// ============================================================================
// PATCH /auth/me
// ============================================================================

export const updateProfileRequestSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long').optional(),
  firstName: z.string().min(1, 'First name is required').max(50, 'First name too long').optional(),
  lastName: z.string().max(50, 'Last name too long').optional(),
});

export type UpdateProfileRequestInput = z.infer<typeof updateProfileRequestSchema>;

export const updateProfileResponseSchema = z.object({
  user: userDTOSchema,
});

// ============================================================================
// POST /auth/push-token
// ============================================================================

export const updatePushTokenRequestSchema = z.object({
  // 512: user_device.push_token's bound (work-k5fk.9, review r1 F7)
  pushToken: z.string().min(1, 'Push token is required').max(512, 'Push token too long'),
  platform: z.enum(['ios', 'android']),
});

export type UpdatePushTokenRequestInput = z.infer<typeof updatePushTokenRequestSchema>;

export const updatePushTokenResponseSchema = z.object({
  registered: z.boolean(),
});

// ============================================================================
// GET /auth/ably-token
// ============================================================================

export const ablyTokenResponseSchema = z.object({
  // Preferred: actual token (JWT) - avoids extra round-trip to Ably servers
  token: z
    .object({
      token: z.string(),
      issued: z.number(),
      expires: z.number(),
      capability: z.string(),
      clientId: z.string(),
    })
    .optional(),
  // Legacy: tokenRequest for backwards compatibility
  tokenRequest: z
    .object({
      keyName: z.string(),
      ttl: z.number(),
      timestamp: z.number(),
      capability: z.string(),
      clientId: z.string(),
      nonce: z.string(),
      mac: z.string(),
    })
    .optional(),
});

export type AblyTokenResponseInput = z.infer<typeof ablyTokenResponseSchema>;

// ============================================================================
// PATCH /auth/biometric
// ============================================================================

export const updateBiometricPreferenceRequestSchema = z.object({
  enabled: z.boolean(),
});

export type UpdateBiometricPreferenceRequestInput = z.infer<typeof updateBiometricPreferenceRequestSchema>;

export const updateBiometricPreferenceResponseSchema = z.object({
  biometricEnabled: z.boolean(),
  biometricEnrolledAt: z.string().datetime().nullable(),
});

export type UpdateBiometricPreferenceResponseInput = z.infer<typeof updateBiometricPreferenceResponseSchema>;

// ============================================================================
// Memory Preferences
// ============================================================================

export const memoryPreferencesDTOSchema = z.object({
  sessionContinuity: z.boolean(),
  crossSessionRecall: z.boolean(),
  patternInsights: z.boolean(),
  rememberAgreements: z.boolean(),
});

export type MemoryPreferencesDTOInput = z.infer<typeof memoryPreferencesDTOSchema>;

export const getMemoryPreferencesResponseSchema = z.object({
  preferences: memoryPreferencesDTOSchema,
});

export type GetMemoryPreferencesResponseInput = z.infer<typeof getMemoryPreferencesResponseSchema>;

export const updateMemoryPreferencesRequestSchema = z.object({
  sessionContinuity: z.boolean().optional(),
  crossSessionRecall: z.boolean().optional(),
  patternInsights: z.boolean().optional(),
  rememberAgreements: z.boolean().optional(),
});

export type UpdateMemoryPreferencesRequestInput = z.infer<typeof updateMemoryPreferencesRequestSchema>;

export const updateMemoryPreferencesResponseSchema = z.object({
  preferences: memoryPreferencesDTOSchema,
});

export type UpdateMemoryPreferencesResponseInput = z.infer<typeof updateMemoryPreferencesResponseSchema>;

// ============================================================================
// Notification Preferences
// ============================================================================

export const notificationPreferencesDTOSchema = z.object({
  pushEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  newInvitations: z.boolean(),
  partnerActions: z.boolean(),
  followUpReminders: z.boolean(),
});

export type NotificationPreferencesDTOInput = z.infer<typeof notificationPreferencesDTOSchema>;

export const getNotificationPreferencesResponseSchema = z.object({
  preferences: notificationPreferencesDTOSchema,
});

export type GetNotificationPreferencesResponseInput = z.infer<typeof getNotificationPreferencesResponseSchema>;

export const updateNotificationPreferencesRequestSchema = z.object({
  pushEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  newInvitations: z.boolean().optional(),
  partnerActions: z.boolean().optional(),
  followUpReminders: z.boolean().optional(),
});

export type UpdateNotificationPreferencesRequestInput = z.infer<typeof updateNotificationPreferencesRequestSchema>;

export const updateNotificationPreferencesResponseSchema = z.object({
  preferences: notificationPreferencesDTOSchema,
});

export type UpdateNotificationPreferencesResponseInput = z.infer<typeof updateNotificationPreferencesResponseSchema>;

// ============================================================================
// Privacy Preferences
// ============================================================================

export const privacyPreferencesDTOSchema = z.object({
  showActivityStatus: z.boolean(),
  allowSessionInvites: z.boolean(),
  analyticsOptOut: z.boolean(),
});

export type PrivacyPreferencesDTOInput = z.infer<typeof privacyPreferencesDTOSchema>;

export const updatePrivacyPreferencesRequestSchema = z.object({
  showActivityStatus: z.boolean().optional(),
  allowSessionInvites: z.boolean().optional(),
  analyticsOptOut: z.boolean().optional(),
});

export type UpdatePrivacyPreferencesRequestInput = z.infer<typeof updatePrivacyPreferencesRequestSchema>;

export const getPrivacyPreferencesResponseSchema = z.object({
  preferences: privacyPreferencesDTOSchema,
});

export type GetPrivacyPreferencesResponseInput = z.infer<typeof getPrivacyPreferencesResponseSchema>;

export const updatePrivacyPreferencesResponseSchema = z.object({
  preferences: privacyPreferencesDTOSchema,
});

export type UpdatePrivacyPreferencesResponseInput = z.infer<typeof updatePrivacyPreferencesResponseSchema>;
