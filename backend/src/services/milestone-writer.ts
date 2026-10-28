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
