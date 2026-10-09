import { EmpathyStatus } from '../../generated/prisma/client';
import {
  transition,
  canTransition,
  validEventsFor,
  EmpathyEvent,
} from '../empathy-state-machine';

describe('empathy-state-machine', () => {
  describe('transition()', () => {
    // ===== HELD transitions =====
    it('HELD → ANALYZING on START_ANALYSIS', () => {
      expect(transition(EmpathyStatus.HELD, 'START_ANALYSIS')).toBe(EmpathyStatus.ANALYZING);
    });

    it('HELD → AWAITING_SHARING on GAPS_DETECTED (skip ANALYZING)', () => {
      expect(transition(EmpathyStatus.HELD, 'GAPS_DETECTED')).toBe(EmpathyStatus.AWAITING_SHARING);
    });

    it('HELD → READY on MARK_READY (skip analysis)', () => {
      expect(transition(EmpathyStatus.HELD, 'MARK_READY')).toBe(EmpathyStatus.READY);
    });

    // ===== ANALYZING transitions =====
    it('ANALYZING → AWAITING_SHARING on GAPS_DETECTED', () => {
      expect(transition(EmpathyStatus.ANALYZING, 'GAPS_DETECTED')).toBe(EmpathyStatus.AWAITING_SHARING);
    });

    it('ANALYZING → READY on NO_SIGNIFICANT_GAPS', () => {
      expect(transition(EmpathyStatus.ANALYZING, 'NO_SIGNIFICANT_GAPS')).toBe(EmpathyStatus.READY);
    });

    it('ANALYZING → READY on MARK_READY', () => {
      expect(transition(EmpathyStatus.ANALYZING, 'MARK_READY')).toBe(EmpathyStatus.READY);
    });

    // ===== AWAITING_SHARING transitions =====
    it('AWAITING_SHARING → REFINING on CONTEXT_SHARED', () => {
      expect(transition(EmpathyStatus.AWAITING_SHARING, 'CONTEXT_SHARED')).toBe(EmpathyStatus.REFINING);
    });

    it('AWAITING_SHARING → READY on DECLINE_SHARING', () => {
      expect(transition(EmpathyStatus.AWAITING_SHARING, 'DECLINE_SHARING')).toBe(EmpathyStatus.READY);
    });

    it('AWAITING_SHARING → READY on MARK_READY', () => {
      expect(transition(EmpathyStatus.AWAITING_SHARING, 'MARK_READY')).toBe(EmpathyStatus.READY);
    });

    // ===== REFINING transitions =====
    it('REFINING → READY on MARK_READY', () => {
      expect(transition(EmpathyStatus.REFINING, 'MARK_READY')).toBe(EmpathyStatus.READY);
    });

    it('REFINING → AWAITING_SHARING on RESUBMIT_WITH_GAPS', () => {
      expect(transition(EmpathyStatus.REFINING, 'RESUBMIT_WITH_GAPS')).toBe(EmpathyStatus.AWAITING_SHARING);
    });

    // ===== READY transitions =====
    it('READY → REVEALED on MUTUAL_REVEAL', () => {
      expect(transition(EmpathyStatus.READY, 'MUTUAL_REVEAL')).toBe(EmpathyStatus.REVEALED);
    });

    // ===== REVEALED transitions =====
    it('REVEALED → VALIDATED on VALIDATE', () => {
      expect(transition(EmpathyStatus.REVEALED, 'VALIDATE')).toBe(EmpathyStatus.VALIDATED);
    });

    it('REVEALED → REFINING on VALIDATION_FEEDBACK_SENT', () => {
      expect(transition(EmpathyStatus.REVEALED, 'VALIDATION_FEEDBACK_SENT')).toBe(EmpathyStatus.REFINING);
    });

    // ===== Legacy NEEDS_WORK =====
    it('NEEDS_WORK → REFINING on CONTEXT_SHARED', () => {
      expect(transition(EmpathyStatus.NEEDS_WORK, 'CONTEXT_SHARED')).toBe(EmpathyStatus.REFINING);
    });

    it('NEEDS_WORK → READY on DECLINE_SHARING', () => {
      expect(transition(EmpathyStatus.NEEDS_WORK, 'DECLINE_SHARING')).toBe(EmpathyStatus.READY);
    });

    // ===== Invalid transitions throw =====
    it('throws on HELD + VALIDATE (skip to end)', () => {
      expect(() => transition(EmpathyStatus.HELD, 'VALIDATE')).toThrow(
        'Invalid empathy state transition: HELD + VALIDATE'
      );
    });

    it('throws on REVEALED + GAPS_DETECTED (going backwards)', () => {
      expect(() => transition(EmpathyStatus.REVEALED, 'GAPS_DETECTED')).toThrow(
        'Invalid empathy state transition'
      );
    });

    it('throws on VALIDATED + any event (terminal state)', () => {
      const events: EmpathyEvent[] = [
        'START_ANALYSIS', 'GAPS_DETECTED', 'NO_SIGNIFICANT_GAPS',
        'MARK_READY', 'CONTEXT_SHARED', 'DECLINE_SHARING',
        'RESUBMIT_WITH_GAPS', 'MUTUAL_REVEAL', 'VALIDATE',
        'VALIDATION_FEEDBACK_SENT',
      ];
      for (const event of events) {
        expect(() => transition(EmpathyStatus.VALIDATED, event)).toThrow(
          'Invalid empathy state transition'
        );
      }
    });

    it('throws on READY + START_ANALYSIS (backwards)', () => {
      expect(() => transition(EmpathyStatus.READY, 'START_ANALYSIS')).toThrow(
        'Invalid empathy state transition'
      );
    });
  });

  describe('canTransition()', () => {
    it('returns true for valid transitions', () => {
      expect(canTransition(EmpathyStatus.HELD, 'START_ANALYSIS')).toBe(true);
      expect(canTransition(EmpathyStatus.READY, 'MUTUAL_REVEAL')).toBe(true);
      expect(canTransition(EmpathyStatus.REVEALED, 'VALIDATION_FEEDBACK_SENT')).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(canTransition(EmpathyStatus.HELD, 'VALIDATE')).toBe(false);
      expect(canTransition(EmpathyStatus.VALIDATED, 'START_ANALYSIS')).toBe(false);
    });
  });

  describe('validEventsFor()', () => {
    it('returns correct events for HELD', () => {
      const events = validEventsFor(EmpathyStatus.HELD);
      expect(events).toContain('START_ANALYSIS');
      expect(events).toContain('GAPS_DETECTED');
      expect(events).toContain('MARK_READY');
      expect(events).toHaveLength(3);
    });

    it('returns empty for VALIDATED (terminal)', () => {
      expect(validEventsFor(EmpathyStatus.VALIDATED)).toHaveLength(0);
    });

    it('returns MUTUAL_REVEAL for READY', () => {
      const events = validEventsFor(EmpathyStatus.READY);
      expect(events).toEqual(['MUTUAL_REVEAL']);
    });

    it('returns validation events for REVEALED', () => {
      const events = validEventsFor(EmpathyStatus.REVEALED);
      expect(events).toEqual(['VALIDATE', 'VALIDATION_FEEDBACK_SENT']);
    });
  });
});
