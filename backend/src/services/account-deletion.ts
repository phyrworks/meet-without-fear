/**
 * Account Deletion Service — the tombstone walk (TS-12; spec §4
 * `app.anonymize_user_account` "the complete walk", P3 D9).
 *
 * The walk is ONE SQL function, run by the JOB (`mwf_job`, the principal for
 * work that crosses participants — R35) as one statement, so it is one
 * transaction: every live session → ABANDONED; each of the user's
 * participants loses its display name and leaves; the leaver's private-only
 * rows are deleted (own conversations, drafts, ai_memory, mood, regulation,
 * dispositions, notes, unshared needs, unshared choices, individual
 * check-ins, unrevealed attempts); their brain_activity (incl. ruling R17's
 * unattributed session rows); their reflections, feature documents, user
 * memories, devices, preferences, reminders and user-scoped ai_memory; the
 * `user` row is scrubbed to a tombstone (never deleted — every FK to `user` is
 * RESTRICT); every participant key and the user key are shredded.
 *
 * What survives, attributed to the tombstone: delivered messages in the
 * co-participants' conversations, revealed attempts and their reviews,
 * need_share, shared choices, proposals, agreements and their parties, shared
 * check-ins, milestones, relationship membership.
 *
 * The application does no hard delete of its own here: there is no row the
 * walk leaves that this service then removes (contrast session-deletion.ts).
 * Around the walk it only reads the caller's own rows (for the notification
 * and the summary) and, after the commit, notifies partners and deletes the
 * Clerk identity.
 */

import { getJobPrisma, prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { publishSessionEvent } from './realtime';

export interface AccountDeletionSummary {
  sessionsAbandoned: number;
  partnersNotified: number;
  dataRecordsDeleted: number;
}

/** Live session statuses (the walk's step 1 moves exactly these to ABANDONED). */
const LIVE = ['CREATED', 'INVITED', 'ACTIVE'] as const;

/**
 * Count the caller's own private rows the walk deletes (read on the app
 * connection, before the walk; the user's own rows only).
 */
async function countPrivateRows(userId: string): Promise<number> {
  const mine = { participant: { userId } };
  const counts = await Promise.all([
    prisma.message.count({ where: { conversation: mine } }),
    prisma.draft.count({ where: mine }),
    prisma.aiMemory.count({ where: { OR: [mine, { userId }] } }),
    prisma.moodReading.count({ where: mine }),
    prisma.regulationEvent.count({ where: mine }),
    prisma.empathyAttempt.count({ where: { authorParticipant: { userId }, revealedAt: null } }),
    prisma.reflection.count({ where: { userId } }),
    prisma.featureState.count({ where: { userId } }),
    prisma.userMemory.count({ where: { userId } }),
    prisma.userDevice.count({ where: { userId } }),
    prisma.userPreferences.count({ where: { userId } }),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

/**
 * Delete a user account: the tombstone walk, partner notifications, and the
 * Clerk identity.
 *
 * @param userId - The user to tombstone (the caller)
 * @param displayName - The user's display name for the partner's notification
 */
export async function deleteAccountWithNotifications(userId: string, displayName: string): Promise<AccountDeletionSummary> {
  // Before the walk: the caller's live sessions (to notify) and own rows (to count)
  const liveSessions = await prisma.participant.findMany({
    where: { userId, leftAt: null, session: { status: { in: [...LIVE] } } },
    select: { sessionId: true },
  });
  const dataRecordsDeleted = await countPrivateRows(userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { clerkId: true } });
  const clerkId = user?.clerkId;

  // The walk: one statement, one transaction, as the job
  await getJobPrisma().$executeRaw`SELECT app.anonymize_user_account(${userId}::uuid)`;

  // After the commit: tell each live session's other side that it ended.
  // The event carries no private content (R36): a reason and the leaver's
  // display name, which the partner already saw.
  let partnersNotified = 0;
  for (const { sessionId } of liveSessions) {
    try {
      await publishSessionEvent(sessionId, 'session.abandoned', {
        reason: 'partner_deleted_account',
        partnerName: displayName,
      });
      partnersNotified++;
    } catch (error) {
      logger.warn(`[AccountDeletion] Failed to notify session ${sessionId}:`, { error });
    }
  }

  // Delete the Clerk user (after the walk, so the DB is clean even if Clerk fails)
  if (clerkId) {
    try {
      const { clerkClient } = await import('@clerk/express');
      await clerkClient.users.deleteUser(clerkId);
    } catch (error) {
      logger.error(`[AccountDeletion] Failed to delete Clerk user ${clerkId}:`, { error });
    }
  }

  return {
    sessionsAbandoned: liveSessions.length,
    partnersNotified,
    // + 1: the user row itself, scrubbed to a tombstone
    dataRecordsDeleted: dataRecordsDeleted + 1,
  };
}
