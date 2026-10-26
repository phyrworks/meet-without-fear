/**
 * The session-status shim (TS-9 fix round 1).
 *
 * The target's `session_status` has no PAUSED (nor WAITING): a paused
 * session is an ACTIVE one whose present participants hold the `paused`
 * milestone (spec §1.1 participant_milestone, "Absorbs … Session.status
 * PAUSED"). The DTOs (`SessionStatus` in shared/) still carry PAUSED, so
 * every reader that returns a session status goes through `displayStatus`,
 * and the session list maps a `?status=` filter onto the target here.
 */

import { prisma } from '../lib/prisma';

/** The target session statuses (enum session_status). */
export const TARGET_SESSION_STATUSES = ['CREATED', 'INVITED', 'ACTIVE', 'RESOLVED', 'ABANDONED', 'ARCHIVED'] as const;
export type TargetSessionStatus = (typeof TARGET_SESSION_STATUSES)[number];

/** The DTO status: an ACTIVE session holding a live `paused` milestone reads PAUSED. */
export function displayStatus(status: string, paused: boolean): string {
  return status === 'ACTIVE' && paused ? 'PAUSED' : status;
}

/** Which of these sessions are paused: any present participant holds `paused`. */
export async function pausedSessionIds(sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows = await prisma.participantMilestone.findMany({
    where: { milestoneKey: 'paused', participant: { sessionId: { in: sessionIds }, leftAt: null } },
    select: { participant: { select: { sessionId: true } } },
  });
  return new Set(rows.map(r => r.participant.sessionId));
}

export async function isSessionPaused(sessionId: string): Promise<boolean> {
  return (await pausedSessionIds([sessionId])).has(sessionId);
}

export type StatusFilter =
  | { kind: 'none' }
  | { kind: 'status'; status: TargetSessionStatus; paused?: boolean }
  | { kind: 'invalid'; value: string };

/**
 * A `?status=` value of the session list onto the target: PAUSED → ACTIVE and
 * paused; WAITING (gone; the migration mapped it to ACTIVE) → ACTIVE and not
 * paused; ACTIVE → ACTIVE and not paused (as before, a paused session was not
 * ACTIVE); any target status as itself; anything else is invalid.
 */
export function parseStatusFilter(value: unknown): StatusFilter {
  if (value === undefined || value === null || value === '') return { kind: 'none' };
  if (typeof value !== 'string') return { kind: 'invalid', value: String(value) };
  if (value === 'PAUSED') return { kind: 'status', status: 'ACTIVE', paused: true };
  if (value === 'WAITING' || value === 'ACTIVE') return { kind: 'status', status: 'ACTIVE', paused: false };
  if ((TARGET_SESSION_STATUSES as readonly string[]).includes(value)) {
    return { kind: 'status', status: value as TargetSessionStatus };
  }
  return { kind: 'invalid', value };
}
