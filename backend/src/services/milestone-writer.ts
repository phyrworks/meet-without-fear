/**
 * Reaching a milestone (TS-9; spec §1.1 `participant_milestone`).
 *
 * Progress is append-only events: a participant reached a milestone at an
 * instant. Who may write one is decided by the milestone lookup's
 * `self_assertable` flag (spec RLS: I `mine(session_id, user_id)` only for
 * self-assertable keys):
 *
 *   - self-assertable (`compact_signed`, `feel_heard`, `needs_confirmed`,
 *     `choices_shared`): the participant asserts it from the request path —
 *     the APP connection;
 *   - every key that records a fact the system establishes (`invitation_sent`,
 *     `empathy_submitted`, `empathy_ready`, `empathy_validated`,
 *     `needs_shared`, `closed`, `paused`, …): app.reach_milestone, a definer the
 *     APP connection calls as a current participant of the session — the
 *     participant reached may be the partner (work-k5fk.10.5: was the job's INSERT).
 *
 * Reaching a milestone twice is a no-op (the PK is (participant, key)); the
 * first instant stands. Either way the database clamps the instant to the last
 * ten minutes, never ahead (app.reach_milestone; t_milestone_instant for the
 * self-assertable INSERT, work-k5fk.34): `at` is a hint, not a choice.
 */

import type { Seat } from './participant-resolver';
import { prisma } from '../lib/prisma';
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
 * Record that the participant at `seat` reached `key` (at `at`, default now).
 * Returns true when this call recorded it, false when it was already reached.
 */
export async function reachMilestone(
  seat: Seat,
  key: string,
  at: Date = new Date(),
  /** A transaction of the caller's own (app) connection, to write inside it. */
  tx?: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>,
): Promise<boolean> {
  const client = tx ?? prisma;
  if (!isSelfAssertable(key)) {
    // A system milestone: app.reach_milestone checks the caller is a current participant of the
    // session and refuses a self-assertable key (work-k5fk.10.5).
    const [row] = await client.$queryRaw<
      Array<{ reached: boolean }>
    >`SELECT app.reach_milestone(${seat.sessionId}::uuid, ${seat.userId}::uuid, ${key}, ${at}::timestamptz) AS reached`;
    return row?.reached === true;
  }
  // Exactly the columns mwf_app may INSERT (the participant's key — session_id, user_id,
  // work-k5fk.3 — milestone_key, reached_at); created_at is the column default. Prisma's
  // createMany would also send its client-side `@default(now())` created_at.
  const count = await client.$executeRaw`
    INSERT INTO participant_milestone (session_id, user_id, milestone_key, reached_at)
    VALUES (${seat.sessionId}::uuid, ${seat.userId}::uuid, ${key}, ${at})
    ON CONFLICT (session_id, user_id, milestone_key) DO NOTHING`;
  return count > 0;
}

/**
 * The inviter's `invitation_sent`, reached when their invitation is accepted
 * (work-qmgc). POST /invitation/confirm is the usual writer, but it fires only
 * from the share modal, which mobile stops showing once the partner accepted —
 * so a partner who accepts before that call would otherwise leave the inviter
 * in stage 0 for good (the stage shim holds an inviter with an unsent
 * invitation there). app.reach_milestone, like every system milestone (the acceptor is
 * now a current participant); idempotent
 * (a confirmed inviter already has it, and the first instant stands). A later
 * confirm then takes its short-circuit (message confirmed + invitation_sent)
 * and is a no-op — without the stage-transition AI message, which this path
 * does not write.
 *
 * Runs after the accept transaction committed (a different connection). A
 * failure is logged, not thrown: the partner has joined either way, and the
 * inviter's own confirm still writes the milestone.
 */
export async function reachInvitationSentOnAccept(inviter: Seat, acceptedAt: Date): Promise<void> {
  try {
    await reachMilestone(inviter, 'invitation_sent', acceptedAt);
  } catch (error) {
    logger.error('[reachInvitationSentOnAccept] could not record invitation_sent for the inviter', {
      sessionId: inviter.sessionId,
      inviterUserId: inviter.userId,
      error,
    });
  }
}
