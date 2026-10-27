/**
 * Empathy State Machine — the transition table of spec §1.2 (TS-10).
 *
 * `app.empathy_set_status` is the ONLY executor of a status move: it enforces
 * this table and its actors in the database and refuses anything else. This
 * module is the application's copy of the table, used to DECIDE a move (which
 * status an event leads to) and to skip a call that would be refused. It
 * never writes.
 *
 *   HELD → AWAITING_SHARING (gaps), READY (no significant gaps)       job / author
 *   AWAITING_SHARING → REFINING (subject shared), READY (declined)     job / author
 *   REFINING → READY, AWAITING_SHARING (re-analysis)                   job / author
 *   READY → REVEALED                                                   job only, reveal gate
 *   REVEALED → VALIDATED (subject), REFINING (subject sent feedback)   subject / job
 *   any except VALIDATED → SUPERSEDED (resubmission inserts round n+1) author / job
 *
 * The legacy ANALYZING and NEEDS_WORK statuses do not exist on the target.
 */

import type { TargetEmpathyStatus } from './empathy-store';

/** Events that trigger empathy status transitions */
export type EmpathyEvent =
  | 'GAPS_DETECTED'
  | 'NO_SIGNIFICANT_GAPS'
  | 'MARK_READY'
  | 'CONTEXT_SHARED'
  | 'DECLINE_SHARING'
  | 'RESUBMIT_WITH_GAPS'
  | 'MUTUAL_REVEAL'
  | 'VALIDATE'
  | 'VALIDATION_FEEDBACK_SENT'
  | 'RESUBMIT';

const TRANSITIONS: Record<string, TargetEmpathyStatus | undefined> = {
  'HELD:GAPS_DETECTED': 'AWAITING_SHARING',
  'HELD:NO_SIGNIFICANT_GAPS': 'READY',
  'HELD:MARK_READY': 'READY',

  'AWAITING_SHARING:CONTEXT_SHARED': 'REFINING',
  'AWAITING_SHARING:DECLINE_SHARING': 'READY',
  'AWAITING_SHARING:MARK_READY': 'READY',

  'REFINING:MARK_READY': 'READY',
  'REFINING:NO_SIGNIFICANT_GAPS': 'READY',
  'REFINING:GAPS_DETECTED': 'AWAITING_SHARING',
  'REFINING:RESUBMIT_WITH_GAPS': 'AWAITING_SHARING',

  'READY:MUTUAL_REVEAL': 'REVEALED',

  'REVEALED:VALIDATE': 'VALIDATED',
  'REVEALED:VALIDATION_FEEDBACK_SENT': 'REFINING',

  'HELD:RESUBMIT': 'SUPERSEDED',
  'AWAITING_SHARING:RESUBMIT': 'SUPERSEDED',
  'REFINING:RESUBMIT': 'SUPERSEDED',
  'READY:RESUBMIT': 'SUPERSEDED',
  'REVEALED:RESUBMIT': 'SUPERSEDED',
};

/**
 * The status an event leads to from `currentStatus`.
 * @throws Error if the transition is not in the table
 */
export function transition(currentStatus: TargetEmpathyStatus | string, event: EmpathyEvent): TargetEmpathyStatus {
  const newStatus = TRANSITIONS[`${currentStatus}:${event}`];
  if (newStatus === undefined) {
    throw new Error(
      `Invalid empathy state transition: ${currentStatus} + ${event}. No valid transition defined for this combination.`,
    );
  }
  return newStatus;
}

/** Checks if a transition is valid without throwing. */
export function canTransition(currentStatus: TargetEmpathyStatus | string, event: EmpathyEvent): boolean {
  return TRANSITIONS[`${currentStatus}:${event}`] !== undefined;
}

/** Returns all valid events for a given status. */
export function validEventsFor(status: TargetEmpathyStatus | string): EmpathyEvent[] {
  const prefix = `${status}:`;
  return Object.keys(TRANSITIONS)
    .filter(key => key.startsWith(prefix))
    .map(key => key.slice(prefix.length) as EmpathyEvent);
}
