/**
 * The application's copy of the spec §1.2 transition table (TS-10).
 * app.empathy_set_status enforces the same table in the database; the
 * real-role tests (empathy-rounds.target.test.ts) exercise that side.
 */
import { transition, canTransition, validEventsFor, type EmpathyEvent } from '../empathy-state-machine';

describe('empathy-state-machine (target table)', () => {
  it.each([
    ['HELD', 'GAPS_DETECTED', 'AWAITING_SHARING'],
    ['HELD', 'NO_SIGNIFICANT_GAPS', 'READY'],
    ['HELD', 'MARK_READY', 'READY'],
    ['AWAITING_SHARING', 'CONTEXT_SHARED', 'REFINING'],
    ['AWAITING_SHARING', 'DECLINE_SHARING', 'READY'],
    ['AWAITING_SHARING', 'MARK_READY', 'READY'],
    ['REFINING', 'MARK_READY', 'READY'],
    ['REFINING', 'GAPS_DETECTED', 'AWAITING_SHARING'],
    ['REFINING', 'RESUBMIT_WITH_GAPS', 'AWAITING_SHARING'],
    ['READY', 'MUTUAL_REVEAL', 'REVEALED'],
    ['REVEALED', 'VALIDATE', 'VALIDATED'],
    ['REVEALED', 'VALIDATION_FEEDBACK_SENT', 'REFINING'],
    ['HELD', 'RESUBMIT', 'SUPERSEDED'],
    ['REFINING', 'RESUBMIT', 'SUPERSEDED'],
    ['REVEALED', 'RESUBMIT', 'SUPERSEDED'],
  ] as const)('%s + %s → %s', (from, event, to) => {
    expect(transition(from, event as EmpathyEvent)).toBe(to);
  });

  it('has no legacy ANALYZING / NEEDS_WORK', () => {
    expect(validEventsFor('ANALYZING')).toEqual([]);
    expect(validEventsFor('NEEDS_WORK')).toEqual([]);
  });

  it('refuses what the table refuses', () => {
    expect(() => transition('VALIDATED', 'RESUBMIT')).toThrow(/Invalid empathy state transition/);
    expect(() => transition('HELD', 'MUTUAL_REVEAL')).toThrow();
    expect(() => transition('READY', 'VALIDATE')).toThrow();
    expect(() => transition('SUPERSEDED', 'MARK_READY')).toThrow();
    expect(canTransition('VALIDATED', 'CONTEXT_SHARED')).toBe(false);
    expect(canTransition('AWAITING_SHARING', 'DECLINE_SHARING')).toBe(true);
  });

  it('every READY is reached only by the table, and REVEALED only from READY', () => {
    const froms = ['HELD', 'AWAITING_SHARING', 'REFINING', 'READY', 'REVEALED', 'VALIDATED', 'SUPERSEDED'];
    const intoRevealed = froms.filter(f => validEventsFor(f).some(e => transition(f, e) === 'REVEALED'));
    expect(intoRevealed).toEqual(['READY']);
  });
});
