/**
 * Auth Controller
 *
 * Handles authentication-related endpoints including user profile,
 * push notifications, and Ably realtime token generation.
 *
 * Target shape (TS-12, spec §1.7): `user` keeps identity only. Preferences are
 * `user_preferences.doc` (memory / notifications / privacy), push tokens and
 * biometrics `user_device`, the last mood the latest `mood_reading`
 * (services/user-settings.ts). The `auth` contract is unchanged.
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getUser, AuthUser } from '../middleware/auth';
import { asyncHandler, ForbiddenError, ValidationError } from '../middleware/errors';
import {
  ApiResponse,
  GetMeResponse,
  UpdateProfileResponse,
  UpdatePushTokenResponse,
  AblyTokenResponse,
  UpdateBiometricPreferenceResponse,
  GetMemoryPreferencesResponse,
  UpdateMemoryPreferencesResponse,
  GetNotificationPreferencesResponse,
  UpdateNotificationPreferencesResponse,
  GetPrivacyPreferencesResponse,
  UpdatePrivacyPreferencesResponse,
  DeleteAccountResponse,
  updateProfileRequestSchema,
  updatePushTokenRequestSchema,
  updateBiometricPreferenceRequestSchema,
  updateMemoryPreferencesRequestSchema,
  updateNotificationPreferencesRequestSchema,
  updatePrivacyPreferencesRequestSchema,
} from '@meet-without-fear/shared';
import { deleteAccountWithNotifications } from '../services/account-deletion';
import { sendTestPushNotification } from '../services/push';
import {
  clearPushTokens,
  deviceSummary,
  lastMoodIntensity,
  readPreferences,
  recordUserMood,
  registerPushToken,
  setBiometric,
  updatePreferences,
} from '../services/user-settings';

// ============================================================================
// Helper Functions
// ============================================================================

/** The unchanged user DTO: identity from `user`, biometric from `user_device`, mood from `mood_reading`. */
async function toUserDTO(user: Pick<AuthUser, 'id' | 'email' | 'name' | 'firstName' | 'lastName' | 'createdAt'>) {
  const [devices, mood] = await Promise.all([deviceSummary(user.id), lastMoodIntensity(user.id)]);
  return {
    dto: {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      biometricEnabled: devices.biometricEnabled,
      lastMoodIntensity: mood,
      createdAt: user.createdAt.toISOString(),
    },
    devices,
  };
}

/** Live sessions the user is a present participant of (the old ACTIVE / WAITING / PAUSED; PAUSED is ACTIVE + a `paused` milestone). */
const ACTIVE_SESSION_STATUSES = ['ACTIVE'] as const;

// ============================================================================
// GET /auth/me
// ============================================================================

export const getMe = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Count active sessions for this user
  const activeSessions = await prisma.session.count({
    where: {
      participants: { some: { userId: user.id, leftAt: null } },
      status: { in: [...ACTIVE_SESSION_STATUSES] },
    },
  });

  const { dto, devices } = await toUserDTO(user);
  const response: ApiResponse<GetMeResponse> = {
    success: true,
    data: {
      user: dto,
      activeSessions,
      pushNotificationsEnabled: devices.pushNotificationsEnabled,
    },
  };

  res.json(response);
});

// ============================================================================
// PATCH /auth/me
// ============================================================================

export const updateProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Validate request body
  const parseResult = updateProfileRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid profile data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { name, firstName, lastName } = parseResult.data;

  // Build update data - only include fields that were provided. `name` is
  // generated from the first and last names (spec §1.7); a `name` alone is
  // stored as the first name with no last name (it then reads back whole).
  const updateData: { firstName?: string | null; lastName?: string | null } = {};
  if (name !== undefined && firstName === undefined && lastName === undefined) {
    updateData.firstName = name;
    updateData.lastName = null;
  }
  if (firstName !== undefined) updateData.firstName = firstName;
  if (lastName !== undefined) updateData.lastName = lastName;

  // Update user profile
  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: updateData,
  });

  const response: ApiResponse<UpdateProfileResponse> = {
    success: true,
    data: {
      user: (await toUserDTO(updatedUser)).dto,
    },
  };

  res.json(response);
});

// ============================================================================
// POST /auth/push-token
// ============================================================================

export const updatePushToken = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Validate request body
  const parseResult = updatePushTokenRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid push token data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { pushToken, platform } = parseResult.data;

  // Register this device's token (user_device; one row per device)
  await registerPushToken(user.id, pushToken, platform);

  const response: ApiResponse<UpdatePushTokenResponse> = {
    success: true,
    data: {
      registered: true,
    },
  };

  res.json(response);
});

// ============================================================================
// GET /auth/ably-token
// ============================================================================

/**
 * Generates an Ably token for the authenticated user.
 * The token is scoped to only allow access to channels the user
 * is authorized to access (their active sessions).
 *
 * If Ably is not configured, returns a mock token response.
 */
export const getAblyToken = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Check if Ably is configured
  const ablyApiKey = process.env.ABLY_API_KEY;

  if (!ablyApiKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new ValidationError('Realtime not configured', {
        errors: { ABLY_API_KEY: ['ABLY_API_KEY is required in production'] },
      });
    }

    // Return mock token for development
    const mockTokenRequest = {
      keyName: 'mock-key-name',
      ttl: 3600000, // 1 hour in ms
      timestamp: Date.now(),
      capability: JSON.stringify({ '*': ['subscribe', 'publish'] }),
      clientId: user.id,
      nonce: Math.random().toString(36).substring(2),
      mac: 'mock-mac-signature',
    };

    const response: ApiResponse<AblyTokenResponse> = {
      success: true,
      data: {
        tokenRequest: mockTokenRequest,
      },
    };

    res.json(response);
    return;
  }

  // Get user's session IDs for capability scoping
  // Include all non-resolved sessions so users can connect during invitation phase too
  const sessions = await prisma.session.findMany({
    where: {
      participants: { some: { userId: user.id, leftAt: null } },
      status: { in: ['CREATED', 'INVITED', 'ACTIVE'] },
    },
    select: { id: true },
  });

  // Build capability object - scope to user's active sessions
  // Note: 'presence' capability must be on the same channel as subscribe/publish
  const capability: Record<string, string[]> = {};

  // ALWAYS allow access to the user's private notification channel
  // This is required for useNotificationChannel to work regardless of session state
  capability[`meetwithoutfear:user:${user.id}`] = ['subscribe'];

  // Add capabilities for specific sessions
  for (const session of sessions) {
    capability[`meetwithoutfear:session:${session.id}`] = ['subscribe', 'publish'];
    capability[`meetwithoutfear:presence:${session.id}`] = ['subscribe', 'presence'];
  }

  try {
    // Dynamic import to handle when Ably is not installed
    const Ably = await import('ably');
    const ably = new Ably.Rest(ablyApiKey);

    // Use requestToken() to get an actual token (not just a tokenRequest)
    // This avoids the client needing to make a separate request to Ably servers,
    // which fixes CORS issues when E2E headers are being sent
    const tokenDetails = await ably.auth.requestToken({
      clientId: user.id,
      capability: JSON.stringify(capability),
    });

    const response: ApiResponse<AblyTokenResponse> = {
      success: true,
      data: {
        token: {
          token: tokenDetails.token,
          issued: tokenDetails.issued,
          expires: tokenDetails.expires,
          capability: tokenDetails.capability,
          clientId: tokenDetails.clientId || user.id,
        },
      },
    };

    res.json(response);
  } catch (error) {
    // If Ably fails, log and return mock for development
    if (process.env.NODE_ENV !== 'production') {
      logger.error('[Ably] Token generation failed:', error);

      // Return mock token for development (when Ably is not configured properly)
      const mockToken = {
        token: 'mock-token-for-development',
        issued: Date.now(),
        expires: Date.now() + 3600000, // 1 hour
        capability: JSON.stringify(capability),
        clientId: user.id,
      };

      const response: ApiResponse<AblyTokenResponse> = {
        success: true,
        data: {
          token: mockToken,
        },
      };

      res.json(response);
      return;
    }

    throw error;
  }
});

// ============================================================================
// DELETE /auth/push-token
// ============================================================================

export const deletePushToken = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // A body may name the device's token; without one every token of the user goes (the old single-token logout)
  const token = typeof req.body?.pushToken === 'string' ? (req.body.pushToken as string) : undefined;
  await clearPushTokens(user.id, token);

  const response: ApiResponse<UpdatePushTokenResponse> = {
    success: true,
    data: {
      registered: false,
    },
  };

  res.json(response);
});

// ============================================================================
// POST /auth/test-push-notification
// ============================================================================

export const scheduleTestPushNotification = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  if (user.email.toLowerCase() !== 'jason@galuten.com') {
    throw new ForbiddenError('Test push notifications are not available for this account');
  }

  await new Promise(resolve => setTimeout(resolve, 10_000));
  const result = await sendTestPushNotification(user.id);

  const response: ApiResponse<{ sent: boolean; delaySeconds: number; reason?: string }> = {
    success: true,
    data: {
      sent: result.sent,
      delaySeconds: 10,
      ...(result.reason ? { reason: result.reason } : {}),
    },
  };

  res.json(response);
});

// ============================================================================
// PATCH /auth/biometric
// ============================================================================

export const updateBiometricPreference = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Validate request body
  const parseResult = updateBiometricPreferenceRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid biometric preference data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { enabled } = parseResult.data;

  // Update biometric preference (user_device)
  const devices = await setBiometric(user.id, enabled);

  const response: ApiResponse<UpdateBiometricPreferenceResponse> = {
    success: true,
    data: {
      biometricEnabled: devices.biometricEnabled,
      biometricEnrolledAt: devices.biometricEnrolledAt?.toISOString() ?? null,
    },
  };

  res.json(response);
});

// ============================================================================
// GET /auth/me/memory-preferences
// ============================================================================

export const getMemoryPreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const preferences = (await readPreferences(user.id)).memory;

  const response: ApiResponse<GetMemoryPreferencesResponse> = {
    success: true,
    data: {
      preferences,
    },
  };

  res.json(response);
});

// ============================================================================
// PUT /auth/me/memory-preferences
// ============================================================================

export const updateMemoryPreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Validate request body
  const parseResult = updateMemoryPreferencesRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid memory preferences data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const updates = parseResult.data;

  // Merge updates into the stored preferences (locked read-modify-write)
  const newPreferences = await updatePreferences(user.id, 'memory', {
    sessionContinuity: updates.sessionContinuity,
    crossSessionRecall: updates.crossSessionRecall,
    patternInsights: updates.patternInsights,
    rememberAgreements: updates.rememberAgreements,
  });

  const response: ApiResponse<UpdateMemoryPreferencesResponse> = {
    success: true,
    data: {
      preferences: newPreferences,
    },
  };

  res.json(response);
});

// ============================================================================
// PATCH /auth/me/mood
// ============================================================================

interface UpdateMoodResponse {
  lastMoodIntensity: number;
}

export const updateMood = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Validate intensity
  const { intensity } = req.body;
  if (typeof intensity !== 'number' || intensity < 1 || intensity > 10 || !Number.isInteger(intensity)) {
    throw new ValidationError('Invalid mood intensity', {
      errors: { intensity: ['Intensity must be an integer between 1 and 10'] },
    });
  }

  // A mood reading on the user's live participant (the last mood is the latest reading)
  await recordUserMood(user.id, intensity);

  const response: ApiResponse<UpdateMoodResponse> = {
    success: true,
    data: {
      lastMoodIntensity: intensity,
    },
  };

  res.json(response);
});

// ============================================================================
// GET /auth/me/notification-preferences
// ============================================================================

export const getNotificationPreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const preferences = (await readPreferences(user.id)).notifications;

  const response: ApiResponse<GetNotificationPreferencesResponse> = {
    success: true,
    data: {
      preferences,
    },
  };

  res.json(response);
});

// ============================================================================
// PATCH /auth/me/notification-preferences
// ============================================================================

export const updateNotificationPreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Validate request body
  const parseResult = updateNotificationPreferencesRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid notification preferences data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const updates = parseResult.data;

  // Merge updates into the stored preferences (locked read-modify-write)
  const newPreferences = await updatePreferences(user.id, 'notifications', {
    pushEnabled: updates.pushEnabled,
    emailEnabled: updates.emailEnabled,
    newInvitations: updates.newInvitations,
    partnerActions: updates.partnerActions,
    followUpReminders: updates.followUpReminders,
  });

  const response: ApiResponse<UpdateNotificationPreferencesResponse> = {
    success: true,
    data: {
      preferences: newPreferences,
    },
  };

  res.json(response);
});

// ============================================================================
// GET /auth/me/privacy-preferences
// ============================================================================

export const getPrivacyPreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const preferences = (await readPreferences(user.id)).privacy;

  const response: ApiResponse<GetPrivacyPreferencesResponse> = {
    success: true,
    data: { preferences },
  };

  res.json(response);
});

// ============================================================================
// PATCH /auth/me/privacy-preferences
// ============================================================================

export const updatePrivacyPreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  const parseResult = updatePrivacyPreferencesRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid privacy preferences data', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const updates = parseResult.data;
  const newPreferences = await updatePreferences(user.id, 'privacy', {
    showActivityStatus: updates.showActivityStatus,
    allowSessionInvites: updates.allowSessionInvites,
    analyticsOptOut: updates.analyticsOptOut,
  });

  const response: ApiResponse<UpdatePrivacyPreferencesResponse> = {
    success: true,
    data: { preferences: newPreferences },
  };

  res.json(response);
});

// ============================================================================
// DELETE /auth/me - Delete Account
// ============================================================================

/**
 * Permanently delete the user's account.
 *
 * This performs a complete account deletion with the following behavior:
 * 1. Active sessions are marked as ABANDONED
 * 2. Partners in active sessions are notified via SESSION_ABANDONED notification
 * 3. Data shared with partners is preserved but anonymized (source user set to null)
 * 4. All private user data is permanently deleted
 * 5. The user is removed from all relationships
 */
export const deleteAccount = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = getUser(req);

  // Perform the deletion with notifications
  const summary = await deleteAccountWithNotifications(user.id);

  const response: ApiResponse<DeleteAccountResponse> = {
    success: true,
    data: {
      success: true,
      summary,
    },
  };

  res.json(response);
});
