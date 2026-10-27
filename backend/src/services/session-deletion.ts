/**
 * Session Deletion Service — leaving one session (TS-12; spec §4
 * `app.anonymize_user_in_session` = steps 1–4 and 7 of the account walk for
 * one session).
 *
 * The walk runs on the JOB connection in one transaction: a live session →
 * ABANDONED; the leaver's participant loses its display name and leaves
 * (`left_at`); their private-only rows in the session are deleted (own
 * conversations with every message, read state, drafts, ai_memory, mood,
 * regulation, dispositions, notes, unshared needs, unshared choices,
 * individual check-ins, unrevealed attempts with their results/offers);
 * their brain_activity of the session (and, ruling R17, the session's
 * unattributed rows); their participant key is shredded. Delivered content —
 * messages in the partner's conversation, revealed attempts, need_share,
 * shared choices, agreements — stays, attributed to the leaver's participant.
 *
 * Explicit deletes the function does not cover, in the same job transaction
 * (each the leaver's own row, scoped to this session):
 *   - `user_memory` rows with `session_id` = this session — spec §1.7
 *     user_memory "optionally session-scoped" (`session_id` FK session;
 *     "NULL = global"): a standing instruction for a session the user left
 *     has no session to apply to;
 *   - `reminder` rows of the leaver for this session's follow-ups — spec §1.5
 *     reminder (`user_id`, the leaver's own nudge): a leaver gets no further
 *     reminders about a session they left. (The account walk's step 5 deletes
 *     every reminder of the user; leaving one session deletes that session's.)
 */

import { getJobPrisma, prisma } from '../lib/prisma';
import { resolveParticipant } from './participant-resolver';

export interface SessionDeletionSummary {
  sessionAbandoned: boolean;
  partnerNotified: boolean;
  dataRecordsDeleted: number;
}

/**
 * Leave a session: the per-session walk plus the two explicit deletes above.
 *
 * @param sessionId - The session to leave
 * @param userId - The leaving user (the caller)
 * @param displayName - Unused (kept for the caller's signature; no event names the leaver)
 */
export async function deleteSessionForUser(
  sessionId: string,
  userId: string,
  displayName: string,
): Promise<SessionDeletionSummary> {
  void displayName;

  // The caller's present participant (a leaver cannot leave twice)
  const me = await resolveParticipant(sessionId, userId);
  if (!me) {
    throw new Error('Session not found or access denied');
  }

  // Before the walk: what the summary reports (the caller's own rows)
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } });
  const live = !!session && ['CREATED', 'INVITED', 'ACTIVE'].includes(session.status);
  const [messages, drafts, moods] = await Promise.all([
    prisma.message.count({ where: { conversation: { participantId: me.id } } }),
    prisma.draft.count({ where: { participantId: me.id } }),
    prisma.moodReading.count({ where: { participantId: me.id } }),
  ]);

  // The walk and the explicit deletes: one job transaction
  const extra = await getJobPrisma().$transaction(async tx => {
    await tx.$executeRaw`SELECT app.anonymize_user_in_session(${sessionId}::uuid, ${me.id}::uuid)`;
    const memories = await tx.$executeRaw`DELETE FROM user_memory WHERE user_id = ${userId}::uuid AND session_id = ${sessionId}::uuid`;
    const reminders = await tx.$executeRaw`DELETE FROM reminder r USING follow_up f
      WHERE r.follow_up_id = f.id AND f.session_id = ${sessionId}::uuid AND r.user_id = ${userId}::uuid`;
    return memories + reminders;
  });

  return {
    sessionAbandoned: live || session?.status === 'ABANDONED',
    partnerNotified: false,
    dataRecordsDeleted: messages + drafts + moods + extra,
  };
}
