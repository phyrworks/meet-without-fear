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

/** Spec §1.1: the keys a participant may insert themselves. */
export const SELF_ASSERTABLE_MILESTONES = ['compact_signed', 'feel_heard', 'needs_confirmed', 'choices_shared'] as const;

export function isSelfAssertable(key: string): boolean {
  return (SELF_ASSERTABLE_MILESTONES as readonly string[]).includes(key);
}

/**
 * Record that `participantId` reached `key` (at `at`, default now). Returns
 * true when this call recorded it, false when it was already reached.
 */
export async function reachMilestone(participantId: string, key: string, at: Date = new Date()): Promise<boolean> {
  const client = isSelfAssertable(key) ? prisma : getJobPrisma();
  const { count } = await client.participantMilestone.createMany({
    data: [{ participantId, milestoneKey: key, reachedAt: at }],
    skipDuplicates: true,
  });
  return count > 0;
}
