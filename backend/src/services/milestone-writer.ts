/**
 * Reaching a milestone (TS-9; spec §1.1 `participant_milestone`).
 *
 * Progress is append-only events: a participant reached a milestone at an
 * instant. Who may write one is decided by the milestone lookup's
 * `self_assertable` flag (spec RLS: I `mine(participant_id)` only for
 * self-assertable keys):
 *
 *   - self-assertable (`compact_signed`, `feel_heard`, `needs_confirmed`,
 *     `choices_shared`): the participant asserts it from the request path —
 *     the APP connection;
 *   - every key that records a fact the system establishes (`invitation_sent`,
 *     `empathy_submitted`, `empathy_ready`, `empathy_validated`,
 *     `needs_shared`, `closed`, `paused`, …): the JOB connection.
 *
 * Reaching a milestone twice is a no-op (the PK is (participant, key)); the
 * first instant stands.
 */

import { getJobPrisma, prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import type { Prisma } from '../generated/prisma/client';

/** Spec §1.1: the keys a participant may insert themselves. */
export const SELF_ASSERTABLE_MILESTONES = [
  'compact_signed',
  'feel_heard',
  'needs_confirmed',
  'choices_shared',
] as const;

export function isSelfAssertable(key: string): boolean {
  return (SELF_ASSERTABLE_MILESTONES as readonly string[]).includes(key);
}

/**
 * Record that `participantId` reached `key` (at `at`, default now). Returns
 * true when this call recorded it, false when it was already reached.
 */
export async function reachMilestone(
  participantId: string,
  key: string,
  at: Date = new Date(),
  /** A transaction of the role that may write `key` (the caller's own for a self-assertable key). */
  tx?: Pick<Prisma.TransactionClient, '$executeRaw'>,
): Promise<boolean> {
  const client = tx ?? (isSelfAssertable(key) ? prisma : getJobPrisma());
  // Exactly the columns the job may INSERT (trailer T7: participant_id,
  // milestone_key, reached_at); created_at is the column default. Prisma's
  // createMany would also send its client-side `@default(now())` created_at.
  const count = await client.$executeRaw`
    INSERT INTO participant_milestone (participant_id, milestone_key, reached_at)
    VALUES (${participantId}::uuid, ${key}, ${at})
    ON CONFLICT (participant_id, milestone_key) DO NOTHING`;
  return count > 0;
}

/**
 * The inviter's `invitation_sent`, reached when their invitation is accepted
 * (work-qmgc). POST /invitation/confirm is the usual writer, but it fires only
 * from the share modal, which mobile stops showing once the partner accepted —
 * so a partner who accepts before that call would otherwise leave the inviter
 * in stage 0 for good (the stage shim holds an inviter with an unsent
 * invitation there). Job connection, like every system milestone; idempotent
 * (a confirmed inviter already has it, and the first instant stands). A later
 * confirm then takes its short-circuit (message confirmed + invitation_sent)
 * and is a no-op — without the stage-transition AI message, which this path
 * does not write.
 *
 * Runs after the accept transaction committed (a different connection). A
 * failure is logged, not thrown: the partner has joined either way, and the
 * inviter's own confirm still writes the milestone.
 */
export async function reachInvitationSentOnAccept(inviterParticipantId: string, acceptedAt: Date): Promise<void> {
  try {
    await reachMilestone(inviterParticipantId, 'invitation_sent', acceptedAt);
  } catch (error) {
    logger.error('[reachInvitationSentOnAccept] could not record invitation_sent for the inviter', {
      inviterParticipantId,
      error,
    });
  }
}
