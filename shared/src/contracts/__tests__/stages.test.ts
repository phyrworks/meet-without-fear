/**
 * Stages Contracts Tests
 */

import {
  signCompactRequestSchema,
  feelHeardRequestSchema,
  saveEmpathyDraftRequestSchema,
  consentToShareRequestSchema,
  validateEmpathyRequestSchema,
  recordEmotionRequestSchema,
  confirmNeedsRequestSchema,
  proposeStrategyRequestSchema,
  confirmAgreementRequestSchema,
} from '../stages';

describe('signCompactRequestSchema', () => {
  it('accepts agreed: true', () => {
    const result = signCompactRequestSchema.safeParse({
      agreed: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects agreed: false', () => {
    const result = signCompactRequestSchema.safeParse({
      agreed: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing agreed', () => {
    const result = signCompactRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('feelHeardRequestSchema', () => {
  it('accepts confirmed true', () => {
    const result = feelHeardRequestSchema.safeParse({
      confirmed: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts confirmed false', () => {
    const result = feelHeardRequestSchema.safeParse({
      confirmed: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional feedback', () => {
    const result = feelHeardRequestSchema.safeParse({
      confirmed: true,
      feedback: 'I feel understood now',
    });
    expect(result.success).toBe(true);
  });

  it('rejects feedback over 500 chars', () => {
    const result = feelHeardRequestSchema.safeParse({
      confirmed: true,
      feedback: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

describe('saveEmpathyDraftRequestSchema', () => {
  it('accepts valid draft', () => {
    const result = saveEmpathyDraftRequestSchema.safeParse({
      content: 'I understand that you felt...',
    });
    expect(result.success).toBe(true);
  });

  it('accepts draft with readyToShare', () => {
    const result = saveEmpathyDraftRequestSchema.safeParse({
      content: 'I understand that you felt...',
      readyToShare: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty content', () => {
    const result = saveEmpathyDraftRequestSchema.safeParse({
      content: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects content over 2000 chars', () => {
    const result = saveEmpathyDraftRequestSchema.safeParse({
      content: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('consentToShareRequestSchema', () => {
  it('accepts consent true', () => {
    const result = consentToShareRequestSchema.safeParse({
      consent: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts consent false', () => {
    const result = consentToShareRequestSchema.safeParse({
      consent: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing consent', () => {
    const result = consentToShareRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('validateEmpathyRequestSchema', () => {
  it('accepts validated true', () => {
    const result = validateEmpathyRequestSchema.safeParse({
      validated: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts validated false with feedback', () => {
    const result = validateEmpathyRequestSchema.safeParse({
      validated: false,
      feedback: 'Not quite what I meant',
    });
    expect(result.success).toBe(true);
  });

  it('rejects validated false without non-empty feedback', () => {
    const result = validateEmpathyRequestSchema.safeParse({
      validated: false,
      feedback: '   ',
    });
    expect(result.success).toBe(false);
  });
});

describe('recordEmotionRequestSchema', () => {
  it('accepts valid intensity', () => {
    const result = recordEmotionRequestSchema.safeParse({
      intensity: 5,
    });
    expect(result.success).toBe(true);
  });

  it('accepts intensity with context', () => {
    const result = recordEmotionRequestSchema.safeParse({
      intensity: 7,
      context: 'Feeling frustrated about the conversation',
    });
    expect(result.success).toBe(true);
  });

  it('rejects intensity below 1', () => {
    const result = recordEmotionRequestSchema.safeParse({
      intensity: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects intensity above 10', () => {
    const result = recordEmotionRequestSchema.safeParse({
      intensity: 11,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer intensity', () => {
    const result = recordEmotionRequestSchema.safeParse({
      intensity: 5.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('confirmNeedsRequestSchema', () => {
  it('accepts valid needIds', () => {
    const result = confirmNeedsRequestSchema.safeParse({
      needIds: ['0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51', '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e52'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty needIds', () => {
    const result = confirmNeedsRequestSchema.safeParse({
      needIds: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts with adjustments', () => {
    const result = confirmNeedsRequestSchema.safeParse({
      needIds: ['0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51'],
      adjustments: [
        {
          needId: '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51',
          confirmed: true,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts adjustment with correction', () => {
    const result = confirmNeedsRequestSchema.safeParse({
      needIds: ['0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51'],
      adjustments: [
        {
          needId: '0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51',
          confirmed: false,
          correction: "That's not quite right, I meant...",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('proposeStrategyRequestSchema', () => {
  it('accepts valid strategy', () => {
    const result = proposeStrategyRequestSchema.safeParse({
      description: 'We could try having weekly check-ins about finances',
      needsAddressed: ['need-1', 'need-2'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts with optional fields', () => {
    const result = proposeStrategyRequestSchema.safeParse({
      description: 'We could try having weekly check-ins about finances',
      needsAddressed: ['need-1'],
      duration: '2 weeks',
      measureOfSuccess: 'We both feel more informed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects description under 10 chars', () => {
    const result = proposeStrategyRequestSchema.safeParse({
      description: 'Short',
      needsAddressed: ['need-1'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty needsAddressed', () => {
    const result = proposeStrategyRequestSchema.safeParse({
      description: 'A valid description here',
      needsAddressed: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('confirmAgreementRequestSchema', () => {
  it('accepts confirmed true', () => {
    const result = confirmAgreementRequestSchema.safeParse({
      confirmed: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts confirmed false', () => {
    const result = confirmAgreementRequestSchema.safeParse({
      confirmed: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing confirmed', () => {
    const result = confirmAgreementRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
