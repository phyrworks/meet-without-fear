/*
 * TS-12: the Prisma-mock tests of this suite are gone. Drafts, consent,
 * reveal, validation and feedback run on the target as mwf_app / mwf_job in
 * TS-10's real-role suites (empathy-rounds, consent-arc, review-visibility,
 * feedback-draft-unrevealed, skip-refinement*) and the R2/R3/R6/R7 goldens.
 * What remains is the validation and the AI-refinement prompt shaping.
 */
/**
 * Stage 2 API Tests
 *
 * Tests for the Perspective Stretch / Empathy stage endpoints:
 * - POST /sessions/:id/empathy/draft - Save empathy draft
 * - GET /sessions/:id/empathy/draft - Get current draft
 * - POST /sessions/:id/empathy/consent - Consent to share
 * - GET /sessions/:id/empathy/partner - Get partner's empathy
 * - POST /sessions/:id/empathy/validate - Validate partner's empathy
 */

import { notifyPartner, publishSessionEvent } from '../../services/realtime';

// Mock realtime
jest.mock('../../services/realtime');

// Mock bedrock
jest.mock('../../lib/bedrock', () => ({
  getSonnetResponse: jest.fn().mockResolvedValue('{"response": "Test transition"}'),
  getModelCompletion: jest
    .fn()
    .mockResolvedValue('{"response": "AI response", "proposedFeedback": "Refined feedback"}'),
  BrainActivityCallType: {
    ORCHESTRATED_RESPONSE: 'ORCHESTRATED_RESPONSE',
  },
}));

// Mock json-extractor
jest.mock('../../utils/json-extractor', () => ({
  extractJsonFromResponse: jest.fn().mockReturnValue({ response: 'Test transition' }),
}));

// Mock embedding service
jest.mock('../../services/embedding', () => ({
  embedSessionContent: jest.fn().mockResolvedValue(true),
}));

// Mock empathy-status service (used for Ably events with full data)
jest.mock('../../services/empathy-status', () => ({
  buildEmpathyExchangeStatus: jest.fn().mockResolvedValue({
    myAttempt: { id: 'mock-attempt', status: 'VALIDATED' },
    partnerAttempt: null,
    analyzing: false,
    readyForStage3: false,
    partnerCompletedStage1: true,
  }),
  buildEmpathyExchangeStatusForBothUsers: jest.fn().mockResolvedValue({
    'user-1': { myAttempt: { status: 'VALIDATED' }, partnerAttempt: null },
    'partner-1': { myAttempt: { status: 'VALIDATED' }, partnerAttempt: null },
  }),
}));

// Import controllers after mocks
import {
  saveDraft,
  getDraft,
  consentToShare,
  getPartnerEmpathy,
  validateEmpathy,
  saveValidationFeedbackDraft,
  refineValidationFeedback,
  skipRefinement,
} from '../../controllers/stage2';

// Mock Express request/response
function mockRequest(overrides: Record<string, unknown> = {}) {
  return {
    params: { id: 'session-123' },
    body: {},
    query: {},
    user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
    ...overrides,
  } as any;
}

function mockResponse() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// Helper to create mock session
function mockSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-123',
    status: 'ACTIVE',
    currentStage: 2,
    relationship: {
      members: [{ userId: 'user-1' }, { userId: 'partner-1' }],
    },
    ...overrides,
  };
}

describe('Stage 2 API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /sessions/:id/empathy/draft (saveDraft)', () => {
    it('rejects empty content', async () => {
      const req = mockRequest({
        body: { content: '', readyToShare: false },
      });
      const res = mockResponse();

      await saveDraft(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        }),
      );
    });
  });

  describe('GET /sessions/:id/empathy/draft (getDraft)', () => {});

  describe('POST /sessions/:id/empathy/consent (consentToShare)', () => {});

  describe('GET /sessions/:id/empathy/partner (getPartnerEmpathy)', () => {});

  describe('POST /sessions/:id/empathy/validate (validateEmpathy)', () => {});
});

describe('Validation Feedback Routes', () => {
  describe('POST /sessions/:id/empathy/feedback/draft', () => {});

  describe('POST /sessions/:id/empathy/feedback/refine', () => {
    it('returns refined feedback from AI', async () => {
      const req = mockRequest({
        body: { message: 'Raw feedback' },
      });
      const res = mockResponse();

      // Mocks already set up for bedrock/getSonnetResponse top of file
      // But we need to ensure json-extractor returns what we want
      const { extractJsonFromResponse } = require('../../utils/json-extractor');
      extractJsonFromResponse.mockReturnValueOnce({
        response: 'AI response',
        proposedFeedback: 'Refined feedback',
      });

      await refineValidationFeedback(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            response: 'AI response',
            proposedFeedback: 'Refined feedback',
          }),
        }),
      );
    });

    it('passes refinement history and process guardrails to the model', async () => {
      const req = mockRequest({
        body: {
          message: "Don't water that down",
          history: [
            { role: 'user', content: 'He was drunk with poop in his pants' },
            { role: 'coach', content: 'Proposed feedback: serious incidents at drop-off' },
          ],
        },
      });
      const res = mockResponse();

      const { extractJsonFromResponse } = require('../../utils/json-extractor');
      const { getModelCompletion } = require('../../lib/bedrock');
      extractJsonFromResponse.mockReturnValueOnce({
        response: 'AI response',
        proposedFeedback: 'Refined feedback',
      });

      await refineValidationFeedback(req, res);

      expect(getModelCompletion).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          systemPrompt: expect.stringContaining('do not preserve personal attacks, threats, ultimatums'),
          messages: [
            { role: 'user', content: 'He was drunk with poop in his pants' },
            { role: 'assistant', content: 'Proposed feedback: serious incidents at drop-off' },
            { role: 'user', content: "Don't water that down" },
          ],
        }),
      );
    });
  });

  describe('POST /sessions/:id/empathy/skip-refinement', () => {});
});
