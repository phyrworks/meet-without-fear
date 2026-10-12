/**
 * Stages Validation Tests
 */

import {
  stageParamSchema,
  advanceStageRequestSchema,
  advanceStageResponseSchema,
  stageStatusResponseSchema,
  signCompactRequestSchema,
  signCompactResponseSchema,
  feelHeardRequestSchema,
  saveEmpathyDraftRequestSchema,
  consentToShareRequestSchema,
  confirmNeedsRequestSchema,
  proposeStrategyRequestSchema,
  rankStrategiesRequestSchema,
  confirmAgreementRequestSchema,
} from '../stages';
import { Stage, StageStatus } from '../../enums';

describe('stageParamSchema', () => {
  it('accepts valid stage numbers', () => {
    expect(stageParamSchema.safeParse({ stage: '0' }).success).toBe(true);
    expect(stageParamSchema.safeParse({ stage: '1' }).success).toBe(true);
    expect(stageParamSchema.safeParse({ stage: '4' }).success).toBe(true);
  });

  it('coerces string to number', () => {
    const result = stageParamSchema.safeParse({ stage: '2' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stage).toBe(2);
    }
  });

  it('rejects stage below 0', () => {
    const result = stageParamSchema.safeParse({ stage: '-1' });
    expect(result.success).toBe(false);
  });

  it('rejects stage above 4', () => {
    const result = stageParamSchema.safeParse({ stage: '5' });
    expect(result.success).toBe(false);
  });
});

describe('advanceStageRequestSchema', () => {
  it('accepts empty object with defaults', () => {
    const result = advanceStageRequestSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.force).toBe(false);
    }
  });

  it('accepts force flag', () => {
    const result = advanceStageRequestSchema.safeParse({ force: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.force).toBe(true);
    }
  });
});

describe('advanceStageResponseSchema', () => {
  it('accepts valid advance response', () => {
    const result = advanceStageResponseSchema.safeParse({
      advanced: true,
      newStage: Stage.WITNESS,
      newStatus: StageStatus.IN_PROGRESS,
      advancedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts blocked response with reason', () => {
    const result = advanceStageResponseSchema.safeParse({
      advanced: false,
      newStage: Stage.ONBOARDING,
      newStatus: StageStatus.IN_PROGRESS,
      advancedAt: null,
      blockedReason: 'Partner not ready',
    });
    expect(result.success).toBe(true);
  });
});

describe('stageStatusResponseSchema', () => {
  it('accepts complete status response', () => {
    const result = stageStatusResponseSchema.safeParse({
      stage: Stage.WITNESS,
      status: StageStatus.IN_PROGRESS,
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: null,
      partnerStage: Stage.ONBOARDING,
      partnerStatus: StageStatus.COMPLETED,
      canAdvance: false,
      advanceBlockedReason: 'Gates not satisfied',
      gates: [
        {
          id: 'gate-1',
          description: 'Feel heard confirmed',
          satisfied: false,
          requiredForAdvance: true,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts status with empty gates', () => {
    const result = stageStatusResponseSchema.safeParse({
      stage: Stage.ONBOARDING,
      status: StageStatus.NOT_STARTED,
      startedAt: null,
      completedAt: null,
      partnerStage: Stage.ONBOARDING,
      partnerStatus: StageStatus.NOT_STARTED,
      canAdvance: true,
      gates: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('Stage 0: signCompactRequestSchema', () => {
  it('accepts agreed true', () => {
    const result = signCompactRequestSchema.safeParse({ agreed: true });
    expect(result.success).toBe(true);
  });

  it('rejects agreed false', () => {
    const result = signCompactRequestSchema.safeParse({ agreed: false });
    expect(result.success).toBe(false);
  });
});

describe('Stage 0: signCompactResponseSchema', () => {
  it('accepts valid response', () => {
    const result = signCompactResponseSchema.safeParse({
      signed: true,
      signedAt: '2024-01-01T00:00:00.000Z',
      partnerSigned: false,
      canAdvance: false,
    });
    expect(result.success).toBe(true);
  });
});

describe('Stage 1: feelHeardRequestSchema', () => {
  it('accepts confirmed true', () => {
    const result = feelHeardRequestSchema.safeParse({ confirmed: true });
    expect(result.success).toBe(true);
  });

  it('accepts confirmed with feedback', () => {
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

describe('Stage 2: saveEmpathyDraftRequestSchema', () => {
  it('accepts valid draft', () => {
    const result = saveEmpathyDraftRequestSchema.safeParse({
      content: 'I understand you feel...',
      readyToShare: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty content', () => {
    const result = saveEmpathyDraftRequestSchema.safeParse({
      content: '',
      readyToShare: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects content over 2000 chars', () => {
    const result = saveEmpathyDraftRequestSchema.safeParse({
      content: 'x'.repeat(2001),
      readyToShare: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('Stage 2: consentToShareRequestSchema', () => {
  it('accepts consent true', () => {
    const result = consentToShareRequestSchema.safeParse({ consent: true });
    expect(result.success).toBe(true);
  });

  it('accepts consent false', () => {
    const result = consentToShareRequestSchema.safeParse({ consent: false });
    expect(result.success).toBe(true);
  });
});

describe('Stage 3: confirmNeedsRequestSchema', () => {
  it('accepts valid needs confirmation', () => {
    const result = confirmNeedsRequestSchema.safeParse({
      needIds: ['0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51'],
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
          correction: 'Minor adjustment',
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('Stage 4: proposeStrategyRequestSchema', () => {
  it('accepts valid strategy', () => {
    const result = proposeStrategyRequestSchema.safeParse({
      description: 'We will try a weekly check-in session',
      needsAddressed: ['need-1'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts with optional fields', () => {
    const result = proposeStrategyRequestSchema.safeParse({
      description: 'We will try a weekly check-in session',
      needsAddressed: ['need-1', 'need-2'],
      duration: '1 month trial',
      measureOfSuccess: 'Both feel more connected',
    });
    expect(result.success).toBe(true);
  });

  it('rejects description under 10 chars', () => {
    const result = proposeStrategyRequestSchema.safeParse({
      description: 'Too short',
      needsAddressed: ['need-1'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty needsAddressed', () => {
    const result = proposeStrategyRequestSchema.safeParse({
      description: 'A valid description for our strategy',
      needsAddressed: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('Stage 4: rankStrategiesRequestSchema', () => {
  it('accepts valid rankings', () => {
    const result = rankStrategiesRequestSchema.safeParse({
      rankedIds: ['0190f3a2-6c1e-7b4d-9a8e-3f2b1c0d4e51'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty rankings', () => {
    const result = rankStrategiesRequestSchema.safeParse({
      rankedIds: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('Stage 4: confirmAgreementRequestSchema', () => {
  it('accepts confirmed true', () => {
    const result = confirmAgreementRequestSchema.safeParse({ confirmed: true });
    expect(result.success).toBe(true);
  });

  it('accepts confirmed false', () => {
    const result = confirmAgreementRequestSchema.safeParse({ confirmed: false });
    expect(result.success).toBe(true);
  });
});
