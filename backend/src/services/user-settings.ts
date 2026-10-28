/**
 * A user's own settings on the target shape (TS-12, spec §1.7):
 *
 *   user_preferences.doc   the three preference documents under `memory`,
 *                          `notifications`, `privacy` (the CHECK requires all
 *                          three keys; shapes from shared/src/dto/auth.ts)
 *   user_device            push tokens and biometric enrolment, one row per
 *                          device (UNIQUE (user_id, push_token))
 *   mood                   `User.lastMoodIntensity` is gone; the latest
 *                          `mood_reading` across the user's participants
 *                          replaces it (v_participant.last_mood, per participant)
 *
 * Everything here reads and writes the caller's own rows on the app
 * connection (RLS shape: user_id = me). Sending a push to ANOTHER user reads
 * that user's devices, which is the job's (see `pushTokensAsJob`).
 */

import {
  DEFAULT_MEMORY_PREFERENCES,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_PRIVACY_PREFERENCES,
  type MemoryPreferencesDTO,
  type NotificationPreferencesDTO,
  type PrivacyPreferencesDTO,
} from '@meet-without-fear/shared';
import { getJobPrisma, prisma } from '../lib/prisma';
import type { Prisma } from '../generated/prisma/client';

// ============================================================================
// Preferences (user_preferences.doc)
// ============================================================================

export interface PreferencesDoc {
  memory: MemoryPreferencesDTO;
  notifications: NotificationPreferencesDTO;
  privacy: PrivacyPreferencesDTO;
}

const DEFAULT_DOC: PreferencesDoc = {
  memory: DEFAULT_MEMORY_PREFERENCES,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
  privacy: DEFAULT_PRIVACY_PREFERENCES,
};

/** Stored keys over the defaults, key by key (an older document missing a field reads its default). */
function withDefaults(raw: unknown): PreferencesDoc {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof PreferencesDoc, object>>;
  return {
    memory: { ...DEFAULT_DOC.memory, ...(doc.memory ?? {}) },
    notifications: { ...DEFAULT_DOC.notifications, ...(doc.notifications ?? {}) },
    privacy: { ...DEFAULT_DOC.privacy, ...(doc.privacy ?? {}) },
  };
}

/** The caller's preferences (defaults when there is no row; a read writes nothing). */
export async function readPreferences(userId: string): Promise<PreferencesDoc> {
  const row = await prisma.userPreferences.findUnique({ where: { userId }, select: { doc: true } });
  return withDefaults(row?.doc);
}

/**
 * Merge a patch into one preference document under a row lock (two devices
 * changing different settings at once both keep theirs). Returns that
 * document after the merge.
 */
export async function updatePreferences<K extends keyof PreferencesDoc>(
  userId: string,
  key: K,
  patch: Partial<PreferencesDoc[K]>,
): Promise<PreferencesDoc[K]> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO user_preferences (user_id, doc) VALUES (${userId}::uuid, ${JSON.stringify(DEFAULT_DOC)}::jsonb) ON CONFLICT (user_id) DO NOTHING`;
    await tx.$queryRaw`SELECT 1 FROM user_preferences WHERE user_id = ${userId}::uuid FOR UPDATE`;
    const row = await tx.userPreferences.findUniqueOrThrow({ where: { userId }, select: { doc: true } });
    const doc = withDefaults(row.doc);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    doc[key] = { ...doc[key], ...defined } as PreferencesDoc[K];
    await tx.userPreferences.update({ where: { userId }, data: { doc: doc as unknown as Prisma.InputJsonObject } });
    return doc[key];
  });
}

// ============================================================================
// Devices (user_device)
// ============================================================================

export interface DeviceSummary {
  pushNotificationsEnabled: boolean;
  biometricEnabled: boolean;
  biometricEnrolledAt: Date | null;
}

/** What the user's devices add up to: any push token; biometric if any device enrolled. */
export async function deviceSummary(userId: string): Promise<DeviceSummary> {
  const devices = await prisma.userDevice.findMany({
    where: { userId },
    select: { pushToken: true, biometricEnabled: true, biometricEnrolledAt: true },
  });
  const enrolled = devices.filter(d => d.biometricEnabled);
  return {
    pushNotificationsEnabled: devices.some(d => d.pushToken !== null),
    biometricEnabled: enrolled.length > 0,
    biometricEnrolledAt:
      enrolled
        .map(d => d.biometricEnrolledAt)
        .filter((t): t is Date => t !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
  };
}

/** Register a device's push token (idempotent per (user, token); seen now). */
export async function registerPushToken(
  userId: string,
  pushToken: string,
  platform?: 'ios' | 'android' | 'web',
): Promise<void> {
  await prisma.$executeRaw`INSERT INTO user_device (user_id, push_token, platform, last_seen_at)
    VALUES (${userId}::uuid, ${pushToken}, ${platform ?? null}::device_platform, now())
    ON CONFLICT (user_id, push_token) WHERE push_token IS NOT NULL
    DO UPDATE SET platform = coalesce(EXCLUDED.platform, user_device.platform), last_seen_at = now()`;
}

/** Unregister push: the named token, or (no token given — the old single-token logout) every token of the user. */
export async function clearPushTokens(userId: string, pushToken?: string): Promise<void> {
  await prisma.userDevice.updateMany({
    where: { userId, pushToken: pushToken ?? { not: null } },
    data: { pushToken: null },
  });
}

/**
 * Biometric enrolment. The API names no device, so it applies to every device
 * of the user (one row is created when the user has none).
 */
export async function setBiometric(userId: string, enabled: boolean): Promise<DeviceSummary> {
  const at = enabled ? new Date() : null;
  const updated = await prisma.userDevice.updateMany({
    where: { userId },
    data: { biometricEnabled: enabled, biometricEnrolledAt: at },
  });
  if (updated.count === 0) {
    await prisma.userDevice.create({ data: { userId, biometricEnabled: enabled, biometricEnrolledAt: at } });
  }
  return deviceSummary(userId);
}

/**
 * THE JOB reads another user's push tokens to deliver a notification the
 * caller's action triggered (R35: the job is the principal for work that
 * crosses users; user_device is `user_id = me` for the request role).
 */
export async function pushTokensAsJob(userId: string): Promise<string[]> {
  const rows = await getJobPrisma().$queryRaw<Array<{ push_token: string }>>`SELECT push_token FROM user_device
    WHERE user_id = ${userId}::uuid AND push_token IS NOT NULL ORDER BY last_seen_at DESC NULLS LAST, push_token`;
  return rows.map(r => r.push_token);
}

/** THE JOB clears a token Expo reports as unregistered. */
export async function clearPushTokenAsJob(userId: string, pushToken: string): Promise<void> {
  await getJobPrisma()
    .$executeRaw`UPDATE user_device SET push_token = NULL WHERE user_id = ${userId}::uuid AND push_token = ${pushToken}`;
}

// ============================================================================
// Mood (mood_reading)
// ============================================================================

/** The user's latest mood reading across their participants (null when none). */
export async function lastMoodIntensity(userId: string): Promise<number | null> {
  const row = await prisma.moodReading.findFirst({
    where: { participant: { userId } },
    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    select: { intensity: true },
  });
  return row?.intensity ?? null;
}

/**
 * A mood set outside a session's own endpoint (PATCH /auth/me/mood). A
 * reading belongs to a participant (spec §1.1 mood_reading), so it is recorded
 * on the user's most recently active present participant in a live session.
 * Returns false when the user has none (nothing is stored).
 */
export async function recordUserMood(userId: string, intensity: number): Promise<boolean> {
  const participant = await prisma.participant.findFirst({
    where: { userId, leftAt: null, session: { status: { in: ['CREATED', 'INVITED', 'ACTIVE'] } } },
    orderBy: [{ readState: { lastActiveAt: { sort: 'desc', nulls: 'last' } } }, { joinedAt: 'desc' }],
    select: { id: true },
  });
  if (!participant) return false;
  await prisma.moodReading.create({ data: { participantId: participant.id, intensity } });
  return true;
}
