/**
 * AI Orchestrator Tests
 *
 * Tests the orchestrateResponse pipeline including:
 * - Full pipeline with mocked Bedrock returning fixture responses
 * - Fallback to mock responses when AI fails
 * - Token budget enforcement (context trimming)
 * - Context injection into messages
 * - Error handling paths
 */

// ============================================================================
// Mocks — must be declared before imports
// ============================================================================

// TS-12: no Prisma mock. The orchestrator's two database touch points are
// service modules — the user's memory preferences (user-settings) and the
// turn-trace merge (brain-service, the job's writer) — mocked at that seam.
jest.mock('../user-settings', () => ({
  readPreferences: jest.fn(),
}));
jest.mock('../../lib/bedrock');
jest.mock('../realtime', () => ({
  publishContextUpdated: jest.fn().mockResolvedValue(undefined),
  getAbly: jest.fn().mockReturnValue(null),
}));
jest.mock('../brain-service', () => ({
  brainService: {
    startActivity: jest.fn().mockResolvedValue({ id: 'mock-activity-id' }),
    completeActivity: jest.fn().mockResolvedValue(undefined),
    failActivity: jest.fn().mockResolvedValue(undefined),
    mergeTurnTrace: jest.fn().mockResolvedValue(undefined),
  },
  BrainActivityCallType: {
    ORCHESTRATED_RESPONSE: 'ORCHESTRATED_RESPONSE',
    REFERENCE_DETECTION: 'REFERENCE_DETECTION',
  },
}));
jest.mock('../llm-telemetry', () => ({
  estimateContextSizes: jest.fn().mockReturnValue({
    pinned: 0,
    summary: 0,
    recentMessages: 0,
    rag: 0,
  }),
  finalizeTurnMetrics: jest.fn(),
  recordContextSizes: jest.fn(),
  recordLlmCall: jest.fn(),
  getContextSizesForTurn: jest.fn().mockReturnValue(undefined),
}));
jest.mock('../../lib/e2e-fixtures', () => ({
  getFixtureResponseByIndex: jest.fn().mockReturnValue('fixture response'),
  getFixtureOperationResponse: jest.fn().mockReturnValue(null),
}));
jest.mock('../../lib/request-context', () => ({
  getE2EFixtureId: jest.fn().mockReturnValue(undefined),
  getRequestContext: jest.fn().mockReturnValue(undefined),
}));
jest.mock('../embedding', () => ({
  searchSessionContent: jest.fn().mockResolvedValue([]),
  searchInnerWorkSessionContent: jest.fn().mockResolvedValue([]),
}));
jest.mock('../shared-context', () => ({
  getSharedContentContext: jest.fn().mockResolvedValue(null),
  getMilestoneContext: jest.fn().mockResolvedValue(null),
}));

// Mock context-assembler to avoid deep Prisma dependency chain
const mockContextBundle = {
  conversationContext: {
    recentTurns: [],
    turnCount: 0,
    sessionDurationMinutes: 5,
    timeSinceLastUserTurnMs: null,
  },
  emotionalThread: {
    initialIntensity: null,
    currentIntensity: null,
    trend: 'unknown',
    notableShifts: [],
  },
  stageContext: { stage: 1, gatesSatisfied: {} },
  userName: 'Alice',
  partnerName: 'Bob',
  intent: {
    intent: 'emotional_validation',
    depth: 'light',
    reason: 'Test context',
    threshold: 0.5,
    maxCrossSession: 0,
    allowCrossSession: false,
    surfaceStyle: 'silent',
  },
  assembledAt: new Date().toISOString(),
};

jest.mock('../context-assembler', () => ({
  assembleContextBundle: jest.fn().mockResolvedValue(mockContextBundle),
  formatContextForPrompt: jest.fn().mockReturnValue(''),
}));

// Mock context-retriever to avoid Haiku + embedding dependency chain
jest.mock('../context-retriever', () => ({
  retrieveContext: jest.fn().mockResolvedValue({
    conversationHistory: [],
    relevantFromOtherSessions: [],
    relevantFromCurrentSession: [],
    preSessionMessages: [],
    detectedReferences: [],
    retrievalSummary: 'No additional context retrieved',
  }),
  formatRetrievedContext: jest.fn().mockReturnValue(''),
}));

// Mock dispatch-handler to avoid AI call chain
jest.mock('../dispatch-handler', () => ({
  handleDispatch: jest.fn().mockResolvedValue('Here is how the process works...'),
}));

// ============================================================================
// Imports
// ============================================================================

import { orchestrateResponse, type OrchestratorContext } from '../ai-orchestrator';
import { getModelCompletionWithTools } from '../../lib/bedrock';
import { readPreferences } from '../user-settings';
import {
  DEFAULT_MEMORY_PREFERENCES,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_PRIVACY_PREFERENCES,
} from '@meet-without-fear/shared';
import { publishContextUpdated } from '../realtime';
import { handleDispatch } from '../dispatch-handler';

const mockGetModelCompletion = getModelCompletionWithTools as jest.Mock;

// ============================================================================
// Fixtures
// ============================================================================

function buildContext(overrides?: Partial<OrchestratorContext>): OrchestratorContext {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    turnId: 'session-1-1',
    userName: 'Alice',
    partnerName: 'Bob',
    stage: 1,
    userMessage: 'I feel like he never listens to me.',
    conversationHistory: [],
    turnCount: 1,
    emotionalIntensity: 5,
    isFirstTurnInSession: true,
    ...overrides,
  };
}

/** A well-formed micro-tag response from the AI */
const MICRO_TAG_RESPONSE = `<thinking>
FeelHeardCheck: N
The user is expressing frustration about not being heard. Stay present and validate.
</thinking>

I hear you, Alice. That feeling of not being listened to can be deeply painful. Can you tell me more about what happens when you try to share something important with Bob?`;

const MICRO_TAG_RESPONSE_WITH_DRAFT = `<thinking>
FeelHeardCheck: N
ReadyShare: N
</thinking>

<draft>
Bob, I want you to know that I understand the pressure you're under at work...
</draft>

I've drafted something that captures your understanding of Bob's perspective. Take a look and let me know if it resonates.`;

const MICRO_TAG_RESPONSE_FEEL_HEARD = `<thinking>
FeelHeardCheck: Y
The user seems to feel understood after our conversation.
</thinking>

It sounds like you're feeling more understood now. Would you say you feel heard about what you've shared today?`;

const MICRO_TAG_RESPONSE_READY_SHARE = `<thinking>
ReadyShare: Y
User shows genuine understanding of partner's perspective.
</thinking>

It sounds like you really understand what Bob might be going through. Would you like to share your empathy attempt with him?`;

const DISPATCH_RESPONSE = `<thinking>
The user is asking about the process, not sharing emotions.
</thinking>

<dispatch>EXPLAIN_PROCESS</dispatch>

Sure, let me explain how this works.`;

const DISPATCH_RESPONSE_WITH_INITIAL = `<thinking>
The user wants to know how the process works.
</thinking>

<dispatch>EXPLAIN_PROCESS</dispatch>

I can see you're curious about the process. Let me explain.`;

// ============================================================================
// Tests
// ============================================================================

describe('AI Orchestrator', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: user has no special memory preferences
    (readPreferences as jest.Mock).mockResolvedValue({
      memory: DEFAULT_MEMORY_PREFERENCES,
      notifications: DEFAULT_NOTIFICATION_PREFERENCES,
      privacy: DEFAULT_PRIVACY_PREFERENCES,
    });
  });

  // --------------------------------------------------------------------------
  // Happy path
  // --------------------------------------------------------------------------

  describe('orchestrateResponse pipeline', () => {
    it('returns AI response when Bedrock succeeds', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      const result = await orchestrateResponse(buildContext());

      expect(result.usedMock).toBe(false);
      expect(result.response).toContain('I hear you, Alice');
      expect(result.memoryIntent).toBeDefined();
      expect(result.contextBundle).toBeDefined();
      expect(result.modelUsed).toBeDefined();
    });

    it('parses FeelHeardCheck flag from thinking block', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE_FEEL_HEARD);

      const result = await orchestrateResponse(buildContext({ turnCount: 5 }));

      expect(result.usedMock).toBe(false);
      expect(result.offerFeelHeardCheck).toBe(true);
    });

    it('suppresses early Stage 1 feel-heard checks even when the model requests one', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE_FEEL_HEARD);

      const result = await orchestrateResponse(buildContext({ stage: 1, turnCount: 4 }));

      expect(result.usedMock).toBe(false);
      expect(result.offerFeelHeardCheck).toBe(false);
    });

    it('does not apply the Stage 1 feel-heard turn guard to other stages', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE_READY_SHARE);

      const result = await orchestrateResponse(buildContext({ stage: 2, turnCount: 4 }));

      expect(result.usedMock).toBe(false);
      expect(result.offerReadyToShare).toBe(true);
    });

    it('parses ReadyShare flag from thinking block (stage 2)', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE_READY_SHARE);

      const result = await orchestrateResponse(buildContext({ stage: 2, turnCount: 5 }));

      expect(result.usedMock).toBe(false);
      expect(result.offerReadyToShare).toBe(true);
    });

    it('extracts draft as empathy statement for stage 2', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE_WITH_DRAFT);

      const result = await orchestrateResponse(buildContext({ stage: 2 }));

      expect(result.proposedEmpathyStatement).toContain('Bob, I want you to know');
    });

    it('does not assign draft to empathy for non-stage-2 stages', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE_WITH_DRAFT);

      const result = await orchestrateResponse(buildContext({ stage: 1 }));

      expect(result.proposedEmpathyStatement).toBeNull();
    });

    it('extracts <draft> as topicFrame for Stage 0', async () => {
      const stage0Response = `<thinking>
Mode: ONBOARDING
</thinking>

<draft>
Mealtime poking
</draft>

Take a look at that framing when you're ready.`;
      mockGetModelCompletion.mockResolvedValue(stage0Response);

      const result = await orchestrateResponse(buildContext({ stage: 0, isInvitationPhase: true }));

      expect(result.topicFrame).toBe('Mealtime poking');
      // Stage 0 must NOT populate the empathy field
      expect(result.proposedEmpathyStatement).toBeNull();
    });

    it('topicFrame is null for non-Stage-0 stages even when <draft> present', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE_WITH_DRAFT);

      const result = await orchestrateResponse(buildContext({ stage: 2 }));

      expect(result.topicFrame).toBeFalsy();
    });

    it('includes routing decision metadata', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      const result = await orchestrateResponse(buildContext());

      expect(result.routingDecision).toBeDefined();
      expect(result.routingDecision!.model).toBe('sonnet');
      expect(result.routingDecision!.reasons).toContain('mediation-response');
    });

    it('publishes context.updated event', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      await orchestrateResponse(buildContext());

      expect(publishContextUpdated).toHaveBeenCalledWith(
        'session-1',
        'user-1',
        expect.any(String), // assembledAt timestamp
      );
    });

    it('stores analysis from thinking block', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      const result = await orchestrateResponse(buildContext());

      expect(result.analysis).toContain('expressing frustration');
    });
  });

  // --------------------------------------------------------------------------
  // Fallback to mock responses
  // --------------------------------------------------------------------------

  describe('fallback to mock responses', () => {
    it('falls back when getModelCompletion returns null', async () => {
      mockGetModelCompletion.mockResolvedValue(null);

      const result = await orchestrateResponse(buildContext());

      expect(result.usedMock).toBe(true);
      expect(result.response).toBeTruthy();
      // Stage 1 mock includes user's name
      expect(result.response).toContain('Alice');
    });

    it('falls back when getModelCompletion throws', async () => {
      mockGetModelCompletion.mockRejectedValue(new Error('Bedrock timeout'));

      const result = await orchestrateResponse(buildContext());

      expect(result.usedMock).toBe(true);
      expect(result.response).toBeTruthy();
    });

    it('provides stage-appropriate mock for stage 1 early turns', async () => {
      mockGetModelCompletion.mockResolvedValue(null);

      const result = await orchestrateResponse(buildContext({ stage: 1, turnCount: 1 }));

      expect(result.usedMock).toBe(true);
      expect(result.response).toContain('Alice');
    });

    it('provides stage-appropriate mock for stage 1 mid turns', async () => {
      mockGetModelCompletion.mockResolvedValue(null);

      const result = await orchestrateResponse(buildContext({ stage: 1, turnCount: 3 }));

      expect(result.usedMock).toBe(true);
      expect(result.response).toContain('frustration');
    });

    it('provides stage-appropriate mock for stage 1 later turns', async () => {
      mockGetModelCompletion.mockResolvedValue(null);

      const result = await orchestrateResponse(buildContext({ stage: 1, turnCount: 6 }));

      expect(result.usedMock).toBe(true);
      expect(result.response).toContain('feelings are valid');
    });

    it('provides stage-appropriate mock for stage 2', async () => {
      mockGetModelCompletion.mockResolvedValue(null);

      const result = await orchestrateResponse(buildContext({ stage: 2, turnCount: 1 }));

      expect(result.usedMock).toBe(true);
      expect(result.response.length).toBeGreaterThan(20);
    });

    it('provides stage-appropriate mock for stage 3', async () => {
      mockGetModelCompletion.mockResolvedValue(null);

      const result = await orchestrateResponse(buildContext({ stage: 3 }));

      expect(result.usedMock).toBe(true);
      expect(result.response).toContain('need');
    });

    it('provides stage-appropriate mock for stage 4', async () => {
      mockGetModelCompletion.mockResolvedValue(null);

      const result = await orchestrateResponse(buildContext({ stage: 4 }));

      expect(result.usedMock).toBe(true);
      expect(result.response).toContain('week');
    });

    it('provides fallback mock for unknown stage', async () => {
      mockGetModelCompletion.mockResolvedValue(null);

      const result = await orchestrateResponse(buildContext({ stage: 99 }));

      expect(result.usedMock).toBe(true);
      expect(result.response).toContain('Alice');
    });
  });

  // --------------------------------------------------------------------------
  // Token budget enforcement
  // --------------------------------------------------------------------------

  describe('token budget enforcement', () => {
    it('trims conversation history for long conversations', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      // Generate a long conversation history (40 turns = 80 messages)
      const longHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (let i = 0; i < 80; i++) {
        longHistory.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}: ${'x'.repeat(200)}`,
        });
      }

      const result = await orchestrateResponse(buildContext({ conversationHistory: longHistory, turnCount: 40 }));

      expect(result.usedMock).toBe(false);

      // Verify the model was called with fewer messages than the full 80
      const callArgs = mockGetModelCompletion.mock.calls[0];
      const messages = (callArgs[1] as any).messages;
      // Should have trimmed + current message; not the full 80
      expect(messages.length).toBeLessThan(80);
    });

    it('preserves recent messages when trimming', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      // 50 messages; the last one should still be the current user message
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (let i = 0; i < 50; i++) {
        history.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Turn ${i}`,
        });
      }

      await orchestrateResponse(buildContext({ conversationHistory: history, turnCount: 25 }));

      const callArgs = mockGetModelCompletion.mock.calls[0];
      const messages = (callArgs[1] as any).messages;
      // Last message should contain the current user message
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toContain('I feel like he never listens to me');
    });

    it('passes short history without trimming', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      const history = [
        { role: 'user' as const, content: 'Message 1' },
        { role: 'assistant' as const, content: 'Response 1' },
      ];

      await orchestrateResponse(buildContext({ conversationHistory: history, turnCount: 2 }));

      const callArgs = mockGetModelCompletion.mock.calls[0];
      const messages = (callArgs[1] as any).messages;
      // 2 history messages + 1 current = 3
      expect(messages.length).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // Context injection into messages
  // --------------------------------------------------------------------------

  describe('context injection', () => {
    it('wraps current user message in the final messages array', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      await orchestrateResponse(buildContext());

      const callArgs = mockGetModelCompletion.mock.calls[0];
      const messages = (callArgs[1] as any).messages;
      const lastMsg = messages[messages.length - 1];

      // Current message should be wrapped in user_message tags (input sanitizer)
      expect(lastMsg.content).toContain('I feel like he never listens to me');
      expect(lastMsg.role).toBe('user');
    });

    it('passes system prompt as PromptBlocks (staticBlock + dynamicBlock)', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      await orchestrateResponse(buildContext());

      const callArgs = mockGetModelCompletion.mock.calls[0];
      const systemPrompt = (callArgs[1] as any).systemPrompt;

      // buildStagePrompt returns PromptBlocks with staticBlock and dynamicBlock
      expect(systemPrompt).toHaveProperty('staticBlock');
      expect(systemPrompt).toHaveProperty('dynamicBlock');
      expect(typeof systemPrompt.staticBlock).toBe('string');
      expect(typeof systemPrompt.dynamicBlock).toBe('string');
    });

    it('passes conversation history messages before current message', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      const history = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
      ];

      await orchestrateResponse(buildContext({ conversationHistory: history }));

      const callArgs = mockGetModelCompletion.mock.calls[0];
      const messages = (callArgs[1] as any).messages;

      // First messages should be from history
      expect(messages[0].content).toBe('Hello');
      expect(messages[1].content).toBe('Hi there!');
      // Last message should be current user message
      expect(messages[messages.length - 1].role).toBe('user');
    });

    it('includes turnId and sessionId in model call options', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      await orchestrateResponse(buildContext());

      const callArgs = mockGetModelCompletion.mock.calls[0];
      const options = callArgs[1] as any;

      expect(options.sessionId).toBe('session-1');
      expect(options.turnId).toBe('session-1-1');
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('continues when publishContextUpdated fails', async () => {
      (publishContextUpdated as jest.Mock).mockRejectedValue(new Error('Ably down'));
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      const result = await orchestrateResponse(buildContext());

      expect(result.response).toBeTruthy();
      expect(result.usedMock).toBe(false);
    });

    it('handles empty AI response gracefully', async () => {
      mockGetModelCompletion.mockResolvedValue('');

      const result = await orchestrateResponse(buildContext());

      // parseMicroTagResponse with empty string yields empty response string
      // The orchestrator passes it through (empty string is truthy for modelResponse check)
      expect(result.response).toBeDefined();
    });

    it('returns usedMock=true when AI throws', async () => {
      mockGetModelCompletion.mockRejectedValue(new Error('Network error'));

      const result = await orchestrateResponse(buildContext());

      expect(result.usedMock).toBe(true);
      expect(result.response).toBeTruthy();
    });

    it('sets offerFeelHeardCheck to false on fallback', async () => {
      mockGetModelCompletion.mockResolvedValue(null);

      const result = await orchestrateResponse(buildContext());

      expect(result.offerFeelHeardCheck).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Dispatch handling
  // --------------------------------------------------------------------------

  describe('dispatch flow', () => {
    it('returns dispatched response when dispatch tag is present', async () => {
      mockGetModelCompletion.mockResolvedValue(DISPATCH_RESPONSE);

      const result = await orchestrateResponse(buildContext({ userMessage: 'How does this process work?' }));

      expect(result.dispatchTag).toBe('EXPLAIN_PROCESS');
      expect(result.usedMock).toBe(false);
    });

    it('includes initial response for two-message dispatch flow', async () => {
      mockGetModelCompletion.mockResolvedValue(DISPATCH_RESPONSE_WITH_INITIAL);

      const result = await orchestrateResponse(buildContext({ userMessage: 'What happens in this process?' }));

      expect(result.dispatchTag).toBe('EXPLAIN_PROCESS');
      // The initial response (text outside dispatch tags) is returned
      expect(result.initialResponse).toBeDefined();
      expect(result.dispatchedResponse).toBeDefined();
    });

    it('calls handleDispatch with the correct tag', async () => {
      mockGetModelCompletion.mockResolvedValue(DISPATCH_RESPONSE);

      await orchestrateResponse(buildContext({ userMessage: 'How does this process work?' }));

      expect(handleDispatch).toHaveBeenCalledWith(
        'EXPLAIN_PROCESS',
        expect.objectContaining({
          userMessage: 'How does this process work?',
          sessionId: 'session-1',
          turnId: 'session-1-1',
        }),
      );
    });

    it('falls through to normal response when dispatch returns null (unknown tag)', async () => {
      (handleDispatch as jest.Mock).mockResolvedValue(null);

      const response = `<thinking>
Something
</thinking>

<dispatch>UNKNOWN_TAG</dispatch>

Normal response text here.`;

      mockGetModelCompletion.mockResolvedValue(response);

      const result = await orchestrateResponse(buildContext());

      // Should fall through to normal response since dispatch handler returned null
      expect(result.dispatchTag).toBeUndefined();
      expect(result.response).toContain('Normal response text here');
    });
  });

  // --------------------------------------------------------------------------
  // Model routing
  // --------------------------------------------------------------------------

  describe('model routing', () => {
    it('routes to sonnet for high emotional intensity', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      await orchestrateResponse(buildContext({ emotionalIntensity: 9 }));

      const callArgs = mockGetModelCompletion.mock.calls[0];
      const model = callArgs[0]; // first arg is model type

      expect(model).toBe('sonnet');
    });

    it('uses compact maxTokens for the state-capture pass', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      await orchestrateResponse(buildContext());

      const callArgs = mockGetModelCompletion.mock.calls[0];
      const options = callArgs[1] as any;

      expect(options.maxTokens).toBe(1024);
    });

    it('includes callType ORCHESTRATED_RESPONSE', async () => {
      mockGetModelCompletion.mockResolvedValue(MICRO_TAG_RESPONSE);

      await orchestrateResponse(buildContext());

      const callArgs = mockGetModelCompletion.mock.calls[0];
      const options = callArgs[1] as any;

      expect(options.callType).toBe('ORCHESTRATED_RESPONSE');
    });
  });
});
