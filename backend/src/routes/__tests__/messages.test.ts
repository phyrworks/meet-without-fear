/*
 * TS-12: the Prisma-mock halves of this suite are gone (no suite mocks the
 * Prisma client on the target). What remains is pure: the planner-text safety
 * helpers and the deprecated endpoint's 410. The streaming turn, feel-heard and
 * history behaviour run against the real target tables as mwf_app / mwf_job in
 * testing/golden/__tests__/job-path.target.test.ts, services/__tests__/
 * chat-turn.target.test.ts and the session-read golden.
 */
import { Request, Response } from 'express';
import {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  sendMessage,
  sendMessageStream,
  confirmFeelHeard,
  getConversationHistory,
  scrubVisibleAIText,
  isReadyForStage3RevealText,
} from '../../controllers/messages';
import { getModelCompletionWithTools, getSonnetStreamingResponse } from '../../lib/bedrock';
import { buildStagePrompt } from '../../services/stage-prompts';
import { interpretNeedEditRequest } from '../../services/needs-edit-interpreter.service';
import { applyNeedEdits } from '../../services/needs-edit-applier.service';

// Mock Prisma

// Mock realtime service
jest.mock('../../services/realtime', () => ({
  notifyPartner: jest.fn().mockResolvedValue(undefined),
  publishSessionEvent: jest.fn().mockResolvedValue(undefined),
  notifySessionMembers: jest.fn().mockResolvedValue(undefined),
  publishMessageAIResponse: jest.fn().mockResolvedValue(undefined),
  publishMessageError: jest.fn().mockResolvedValue(undefined),
  publishTopicFrameUpdated: jest.fn().mockResolvedValue(undefined),
}));

// Mock partner session classifier (fire-and-forget memory detection)
jest.mock('../../services/partner-session-classifier', () => ({
  runPartnerSessionClassifier: jest.fn().mockResolvedValue(null),
}));

// Mock bedrock
jest.mock('../../lib/bedrock', () => ({
  getSonnetResponse: jest.fn().mockResolvedValue('Mock response'),
  getModelCompletionWithTools: jest.fn().mockResolvedValue({ text: null, toolInvocations: [] }),
  getSonnetStreamingResponse: jest.fn(),
  BrainActivityCallType: {
    ORCHESTRATED_RESPONSE: 'ORCHESTRATED_RESPONSE',
  },
  isMockLLMEnabled: jest.fn().mockReturnValue(false),
}));

// Mock brain service
jest.mock('../../services/brain-service', () => ({
  brainService: {
    recordThinking: jest.fn().mockResolvedValue(undefined),
    broadcastMessage: jest.fn(),
  },
}));

// Mock stage prompts
jest.mock('../../services/stage-prompts', () => ({
  buildInitialMessagePrompt: jest.fn().mockReturnValue('Mock prompt'),
  buildStagePrompt: jest.fn().mockReturnValue({ staticBlock: 'Mock static', dynamicBlock: 'Mock dynamic' }),
  buildStagePromptString: jest.fn().mockReturnValue('Mock stage prompt'),
}));

// Mock json extractor
jest.mock('../../utils/json-extractor', () => ({
  extractJsonFromResponse: jest.fn().mockReturnValue({}),
}));

// Mock embedding service
jest.mock('../../services/embedding', () => ({
  embedSessionContent: jest.fn().mockResolvedValue(true),
}));

// Mock conversation summarizer
jest.mock('../../services/conversation-summarizer', () => ({
  updateSessionSummary: jest.fn().mockResolvedValue(undefined),
  getSessionSummary: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../services/context-assembler', () => ({
  assembleContextBundle: jest.fn().mockResolvedValue({ notableFacts: [] }),
  formatContextForPrompt: jest.fn().mockReturnValue(''),
}));

jest.mock('../../services/shared-context', () => ({
  getMilestoneContext: jest.fn().mockResolvedValue(null),
  getSharedContentContext: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../services/llm-telemetry', () => ({
  estimateContextSizes: jest.fn().mockReturnValue({}),
  finalizeTurnMetrics: jest.fn(),
  recordContextSizes: jest.fn(),
}));

jest.mock('../../services/global-memory', () => ({
  consolidateGlobalFacts: jest.fn().mockResolvedValue(undefined),
}));

// Mock reconciler
jest.mock('../../services/reconciler', () => ({
  runReconcilerForDirection: jest.fn().mockResolvedValue(null),
  getSharedContextForGuesser: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../services/needs-edit-interpreter.service', () => ({
  interpretNeedEditRequest: jest.fn(),
}));

jest.mock('../../services/needs-edit-applier.service', () => ({
  applyNeedAction: jest.fn(),
  applyNeedEdits: jest.fn(),
}));

jest.mock('../../services/stage4-capture.service', () => ({
  captureStage4Turn: jest.fn().mockResolvedValue({
    appliedOperationCount: 0,
    skippedOperationCount: 0,
    selection: null,
    closureSignal: null,
    confidence: 0,
  }),
}));

jest.mock('../../services/stage4-auto-closure.service', () => ({
  applyStage4AutoClosureFromSignal: jest.fn().mockResolvedValue({ closed: false }),
}));

// Mock request context
jest.mock('../../lib/request-context', () => ({
  updateContext: jest.fn(),
}));

// Helper to create mock request
function createMockRequest(options: {
  user?: { id: string; email: string; name?: string | null };
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}): Partial<Request> {
  return {
    user: options.user,
    params: options.params || {},
    body: options.body || {},
    query: options.query || {},
    on: jest.fn(),
  } as Partial<Request>;
}

// Helper to create mock response
function createMockResponse(): {
  res: Partial<Response>;
  statusMock: jest.Mock;
  jsonMock: jest.Mock;
  writeMock: jest.Mock;
  endMock: jest.Mock;
} {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const writeMock = jest.fn();
  const endMock = jest.fn();

  return {
    res: {
      status: statusMock,
      json: jsonMock,
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: writeMock,
      end: endMock,
    } as Partial<Response>,
    statusMock,
    jsonMock,
    writeMock,
    endMock,
  };
}

describe('Messages API (Fire-and-Forget)', () => {
  const mockUser = { id: 'user-1', email: 'test@example.com', name: 'Test User' };
  const mockSessionId = 'session-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('planner text safety helpers', () => {
    describe('scrubVisibleAIText', () => {
      it('removes visible planner lines and flags the scrub', () => {
        const result = scrubVisibleAIText([
          'I should compare both lists before showing anything.',
          'That sounds like a need for more steadiness.',
          "Here's my plan: reveal the comparison.",
        ].join('\n'));

        expect(result.scrubbed).toBe(true);
        expect(result.text).toBe('That sounds like a need for more steadiness.');
      });

      it('preserves normal facilitation that starts with I need to', () => {
        const text = 'I need to make sure I am capturing this right: you want steadiness before deciding.';

        expect(scrubVisibleAIText(text)).toEqual({
          text,
          scrubbed: false,
        });
      });

      it('can preserve boundary whitespace for streamed chunks', () => {
        expect(scrubVisibleAIText(' talk ', { preserveBoundaryWhitespace: true })).toEqual({
          text: ' talk ',
          scrubbed: false,
        });
      });

      it('removes untagged Stage 4 reasoning before the visible answer', () => {
        const result = scrubVisibleAIText([
          'This is them accepting my invitation to add another option for the same need.',
          '',
          'So I have:',
          '- Previous proposal idea: play 20 Questions',
          '- Current addition: Would You Rather',
          '',
          'These are both specific games. capture them as options and then check if they are done brainstorming.',
          '',
          'For stage4_walkthrough: The user is still actively brainstorming for the current need, so action=NONE.',
          '',
          '',
          'Got it — so 20 Questions or Would You Rather, both could create that shared lightness.',
          '',
          'Is that enough to work with, or do you want one more option for this need?',
        ].join('\n'));

        expect(result.scrubbed).toBe(true);
        expect(result.text).toBe([
          'Got it — so 20 Questions or Would You Rather, both could create that shared lightness.',
          '',
          'Is that enough to work with, or do you want one more option for this need?',
        ].join('\n'));
      });
    });

    describe('isReadyForStage3RevealText', () => {
      it('detects ready requests that mention needs reveal context', () => {
        expect(isReadyForStage3RevealText("I'm ready to see the needs lists")).toBe(true);
        expect(isReadyForStage3RevealText('We are ready for the side by side reveal')).toBe(true);
      });

      it('does not treat negated ready language as a reveal request', () => {
        expect(isReadyForStage3RevealText("I'm not ready to see the lists")).toBe(false);
        expect(isReadyForStage3RevealText("I don't want to show the needs yet")).toBe(false);
      });

      it('requires reveal context to avoid hijacking generic ready messages', () => {
        expect(isReadyForStage3RevealText("Yes, I'm ready")).toBe(false);
      });
    });

  });

  describe('POST /sessions/:id/messages (sendMessage - DEPRECATED)', () => {
    // The fire-and-forget endpoint has been deprecated in favor of SSE streaming.
    // All message sending should now use POST /sessions/:id/messages/stream.

    it('returns 410 Gone with deprecation message', async () => {
      const req = createMockRequest({
        user: mockUser,
        params: { id: mockSessionId },
        body: { content: 'Test message' },
      });
      const { res, statusMock, jsonMock } = createMockResponse();

      await sendMessage(req as Request, res as Response);

      expect(statusMock).toHaveBeenCalledWith(410);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'ENDPOINT_DEPRECATED',
            message: expect.stringContaining('deprecated'),
          }),
        })
      );
    });
  });
});
