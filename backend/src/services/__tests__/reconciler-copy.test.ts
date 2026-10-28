/**
 * Reconciler: the parts that never touch the database — the empathy state
 * machine's transitions, the fixed fallback copy, and the two reflections that
 * only call the model.
 *
 * TS-12: kept from the Prisma-mock suite services/__tests__/reconciler.test.ts,
 * which is deleted. Its database cases (attempt counters, evidence loading,
 * share suggestions, mutual reveal, runReconciler / runReconcilerForDirection,
 * respondToShareSuggestion) run on real roles in the TS-10 target suites:
 * empathy-rounds, reconciler-reader, consent-arc, share-delivery-retry,
 * share-notifications, skip-refinement(-open-offer), review-visibility and
 * feedback-draft-unrevealed (services/__tests__/*.target.test.ts).
 */

jest.mock('../../lib/bedrock', () => ({
  getSonnetResponse: jest.fn().mockResolvedValue('Mock AI response'),
  BrainActivityCallType: { RECONCILER_ANALYSIS: 'RECONCILER_ANALYSIS' },
}));

import { EmpathyStatus } from '../../generated/prisma/client';
import {
  getFallbackContinuation,
  generateContextReceivedReflection,
  generateValidationFeedbackReflection,
} from '../reconciler';
import { transition } from '../empathy-state-machine';

describe('State Transitions', () => {
  it('transitions from HELD to READY on MARK_READY', () => {
    expect(transition(EmpathyStatus.HELD, 'MARK_READY')).toBe(EmpathyStatus.READY);
  });

  it('transitions from AWAITING_SHARING to REFINING on CONTEXT_SHARED', () => {
    expect(transition(EmpathyStatus.AWAITING_SHARING, 'CONTEXT_SHARED')).toBe(EmpathyStatus.REFINING);
  });

  it('transitions from AWAITING_SHARING to READY on DECLINE_SHARING', () => {
    expect(transition(EmpathyStatus.AWAITING_SHARING, 'DECLINE_SHARING')).toBe(EmpathyStatus.READY);
  });

  it('transitions from REFINING to READY on MARK_READY', () => {
    expect(transition(EmpathyStatus.REFINING, 'MARK_READY')).toBe(EmpathyStatus.READY);
  });

  it('transitions from READY to REVEALED on MUTUAL_REVEAL', () => {
    expect(transition(EmpathyStatus.READY, 'MUTUAL_REVEAL')).toBe(EmpathyStatus.REVEALED);
  });

  it('transitions from REVEALED to VALIDATED on VALIDATE', () => {
    expect(transition(EmpathyStatus.REVEALED, 'VALIDATE')).toBe(EmpathyStatus.VALIDATED);
  });

  it('transitions from REVEALED to REFINING on VALIDATION_FEEDBACK_SENT', () => {
    expect(transition(EmpathyStatus.REVEALED, 'VALIDATION_FEEDBACK_SENT')).toBe(EmpathyStatus.REFINING);
  });

  it('throws on invalid transition', () => {
    expect(() => transition(EmpathyStatus.HELD, 'MUTUAL_REVEAL')).toThrow('Invalid empathy state transition');
  });

  it('throws when trying to transition from REVEALED to READY', () => {
    expect(() => transition(EmpathyStatus.REVEALED, 'MARK_READY')).toThrow('Invalid empathy state transition');
  });
});

describe('getFallbackContinuation', () => {
  it('returns stage 1 fallback with partner name', () => {
    const result = getFallbackContinuation(1, 'Alex');

    expect(result).toContain('Thank you for sharing that with Alex');
    expect(result).toContain('how this situation has affected you');
  });

  it('returns stage 2 fallback without restarting perspective exploration', () => {
    const result = getFallbackContinuation(2, 'Jordan');

    expect(result).toContain('Thank you for sharing that with Jordan');
    expect(result).toContain("Revisit what you'll share");
    expect(result).toContain("don't need to do anything more on their behalf");
    expect(result).not.toContain("Jordan's perspective");
  });

  it('returns stage 3 fallback about needs', () => {
    const result = getFallbackContinuation(3, 'Sam');

    expect(result).toContain('Thank you for sharing that with Sam');
    expect(result).toContain('what you truly need');
  });

  it('returns stage 4 fallback about steps forward', () => {
    const result = getFallbackContinuation(4, 'Pat');

    expect(result).toContain('Thank you for sharing that with Pat');
    expect(result).toContain('small step');
  });

  it('returns generic fallback for unknown stages', () => {
    const result = getFallbackContinuation(99, 'Alex');

    expect(result).toContain('Thank you for sharing that with Alex');
    expect(result).toContain("Let's continue our conversation");
  });

  it('always includes acknowledgment section', () => {
    for (const stage of [1, 2, 3, 4, 5]) {
      const result = getFallbackContinuation(stage, 'TestPartner');
      expect(result).toContain('Thank you for sharing that with TestPartner');
      expect(result).toContain('refine their understanding');
    }
  });
});

describe('generateContextReceivedReflection', () => {
  it('frames shared context for the receiver without thanking the sharer', async () => {
    const result = await generateContextReceivedReflection('session-1', 'Shantam', 'Blair');

    expect(result).toContain('Blair shared this because');
    expect(result).toContain('what stands out');
    expect(result).not.toContain('Thank you for sharing');
    expect(result).not.toContain('Jason');
  });
});

describe('generateValidationFeedbackReflection', () => {
  it('returns trimmed AI response on success', async () => {
    const { getSonnetResponse } = require('../../lib/bedrock');
    (getSonnetResponse as jest.Mock).mockResolvedValueOnce('  Jordan shared some thoughts about what felt off.  ');

    const result = await generateValidationFeedbackReflection('session-1', 'Alex', 'Jordan');

    expect(result).toBe('Jordan shared some thoughts about what felt off.');
    expect(getSonnetResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        operation: 'reconciler-validation-feedback-reflection',
      }),
    );
  });

  it('returns fallback when getSonnetResponse returns null', async () => {
    const { getSonnetResponse } = require('../../lib/bedrock');
    (getSonnetResponse as jest.Mock).mockResolvedValueOnce(null);

    const result = await generateValidationFeedbackReflection('session-1', 'Alex', 'Jordan');

    expect(result).toContain('Jordan');
    expect(result).toContain('shared some thoughts');
  });

  it('returns fallback when getSonnetResponse throws', async () => {
    const { getSonnetResponse } = require('../../lib/bedrock');
    (getSonnetResponse as jest.Mock).mockRejectedValueOnce(new Error('Bedrock error'));

    const result = await generateValidationFeedbackReflection('session-1', 'Alex', 'Jordan');

    expect(result).toContain('Jordan');
    expect(result).toContain('shared some thoughts');
  });
});
