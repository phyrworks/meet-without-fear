/*
 * TS-12: the retrieveContext half of this suite mocked the Prisma client and is
 * gone; retrieval reads the caller's own rows on the target and is exercised
 * against real tables by services/__tests__/participant-context.target.test.ts
 * (the context builder) and the chat-turn goldens. What remains is pure: the
 * formatters.
 */
/**
 * Context Retriever Tests
 *
 * Tests the universal context retrieval service including:
 * - Reference detection behavior via the public retrieveContext API
 * - Context formatting and truncation
 * - Error handling when embedding search fails
 * - Deduplication of search results
 */

// ============================================================================
// Mocks — must be declared before imports
// ============================================================================

jest.mock('../../lib/bedrock', () => ({
  getHaikuJson: jest.fn().mockResolvedValue(null),
  getModelCompletion: jest.fn().mockResolvedValue(null),
  getEmbedding: jest.fn().mockResolvedValue(null),
  BrainActivityCallType: {
    REFERENCE_DETECTION: 'REFERENCE_DETECTION',
    ORCHESTRATED_RESPONSE: 'ORCHESTRATED_RESPONSE',
  },
}));
jest.mock('../brain-service', () => ({
  brainService: {
    startActivity: jest.fn().mockResolvedValue({ id: 'mock-activity-id' }),
    completeActivity: jest.fn().mockResolvedValue(undefined),
    failActivity: jest.fn().mockResolvedValue(undefined),
  },
  BrainActivityCallType: {
    REFERENCE_DETECTION: 'REFERENCE_DETECTION',
  },
}));
jest.mock('../embedding', () => ({
  searchSessionContent: jest.fn().mockResolvedValue([]),
  searchInnerWorkSessionContent: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../utils/circuit-breaker', () => ({
  withHaikuCircuitBreaker: jest.fn(async (fn: () => Promise<any>, fallback: any) => {
    try {
      const result = await fn();
      // Match real circuit breaker: null result triggers fallback
      if (result === null) return fallback;
      return result;
    } catch {
      return fallback;
    }
  }),
}));

// ============================================================================
// Imports
// ============================================================================

import {
  retrieveContext,
  formatRetrievedContext,
  buildMessagesWithFullContext,
  type RetrievedContext,
  type RelevantMessage,
  type RetrievalOptions,
  type DetectedReference,
} from '../context-retriever';
import { getHaikuJson } from '../../lib/bedrock';
import { searchSessionContent, searchInnerWorkSessionContent } from '../embedding';

const mockGetHaikuJson = getHaikuJson as jest.MockedFunction<typeof getHaikuJson>;
const mockSearchSessionContent = searchSessionContent as jest.MockedFunction<typeof searchSessionContent>;
const mockSearchInnerWorkSessionContent = searchInnerWorkSessionContent as jest.MockedFunction<
  typeof searchInnerWorkSessionContent
>;

// ============================================================================
// Fixtures
// ============================================================================

function buildOptions(overrides?: Partial<RetrievalOptions>): RetrievalOptions {
  return {
    userId: 'user-1',
    currentMessage: 'I feel really frustrated with Bob.',
    currentSessionId: 'session-1',
    turnId: 'session-1-1',
    maxCrossSessionMessages: 10,
    similarityThreshold: 0.5,
    includePreSession: true,
    skipDetection: false,
    ...overrides,
  };
}

function buildRetrievedContext(overrides?: Partial<RetrievedContext>): RetrievedContext {
  return {
    conversationHistory: [],
    relevantFromOtherSessions: [],
    relevantFromCurrentSession: [],
    preSessionMessages: [],
    detectedReferences: [],
    retrievalSummary: 'No additional context retrieved',
    ...overrides,
  };
}

function buildRelevantMessage(overrides?: Partial<RelevantMessage>): RelevantMessage {
  return {
    content: 'Some relevant content from a past session',
    sessionId: 'session-old',
    partnerName: 'Bob',
    similarity: 0.85,
    timestamp: new Date('2025-12-01T10:00:00Z').toISOString(),
    role: 'user',
    source: 'partner-session',
    ...overrides,
  };
}

// ============================================================================
// Tests — formatRetrievedContext
// ============================================================================

describe('formatRetrievedContext', () => {
  it('returns empty string when no context is available', () => {
    const context = buildRetrievedContext();
    const formatted = formatRetrievedContext(context);
    expect(formatted).toBe('');
  });

  it('formats pre-session messages', () => {
    const context = buildRetrievedContext({
      preSessionMessages: [
        { role: 'user', content: 'I need to talk about something', timestamp: new Date().toISOString() },
      ],
    });

    const formatted = formatRetrievedContext(context);

    expect(formatted).toContain('[Earlier in this conversation]');
    expect(formatted).toContain('User: I need to talk about something');
  });

  it('formats cross-session results with time context', () => {
    const context = buildRetrievedContext({
      relevantFromOtherSessions: [
        buildRelevantMessage({
          partnerName: 'Bob',
          content: 'We discussed childcare responsibilities',
          timeContext: {
            bucket: 'recent' as any,
            daysAgo: 14,
            hoursAgo: 336,
            phrase: 'about 2 weeks ago',
            useRememberingLanguage: true,
            promptGuidance: 'Reference naturally',
          },
          source: 'partner-session',
        }),
      ],
    });

    const formatted = formatRetrievedContext(context);

    expect(formatted).toContain('[Related content from previous sessions]');
    expect(formatted).toContain('[Session with Bob, about 2 weeks ago]');
    expect(formatted).toContain('We discussed childcare responsibilities');
  });

  it('formats inner thoughts results differently', () => {
    const context = buildRetrievedContext({
      relevantFromOtherSessions: [
        buildRelevantMessage({
          content: 'I realized I tend to shut down during arguments',
          source: 'inner-thoughts',
          timeContext: {
            bucket: 'recent' as any,
            daysAgo: 3,
            hoursAgo: 72,
            phrase: 'a few days ago',
            useRememberingLanguage: true,
            promptGuidance: 'Reference naturally',
          },
        }),
      ],
    });

    const formatted = formatRetrievedContext(context);

    expect(formatted).toContain('[Your reflections, a few days ago]');
    expect(formatted).toContain('I realized I tend to shut down');
  });

  it('formats detected references', () => {
    const refs: DetectedReference[] = [
      { type: 'agreement', text: 'we agreed to talk weekly', confidence: 'high' },
      { type: 'person', text: 'my mom', confidence: 'medium' },
    ];

    const context = buildRetrievedContext({ detectedReferences: refs });
    const formatted = formatRetrievedContext(context);

    expect(formatted).toContain('[Detected references in user message]');
    expect(formatted).toContain('agreement: "we agreed to talk weekly" (high confidence)');
    expect(formatted).toContain('person: "my mom" (medium confidence)');
  });

  it('truncates long content to 500 characters', () => {
    const longContent = 'x'.repeat(600);
    const context = buildRetrievedContext({
      preSessionMessages: [{ role: 'user', content: longContent }],
    });

    const formatted = formatRetrievedContext(context);

    // Should be truncated with the ellipsis marker
    expect(formatted).toContain('[truncated]');
    // Should not contain the full 600-char string
    expect(formatted.length).toBeLessThan(longContent.length + 200);
  });

  it('includes recency guidance when cross-session results exist', () => {
    const context = buildRetrievedContext({
      relevantFromOtherSessions: [
        buildRelevantMessage({
          timeContext: {
            bucket: 'old' as any,
            daysAgo: 90,
            hoursAgo: 2160,
            phrase: '3 months ago',
            useRememberingLanguage: true,
            promptGuidance: 'Reference with tentativeness',
          },
        }),
      ],
      recencyGuidance: 'Some of this context is from several months ago; reference with appropriate tentativeness.',
    });

    const formatted = formatRetrievedContext(context);

    expect(formatted).toContain('[MEMORY CONTEXT GUIDANCE:');
    expect(formatted).toContain('tentativeness');
  });

  it('does not include recency guidance when no cross-session results', () => {
    const context = buildRetrievedContext({
      recencyGuidance: 'This should not appear',
    });

    const formatted = formatRetrievedContext(context);

    expect(formatted).not.toContain('MEMORY CONTEXT GUIDANCE');
  });

  it('formats within-session results', () => {
    const context = buildRetrievedContext({
      relevantFromCurrentSession: [
        buildRelevantMessage({
          content: 'Earlier we talked about trust',
          timeContext: {
            bucket: 'just-now' as any,
            daysAgo: 0,
            hoursAgo: 0.33,
            phrase: '20 minutes ago',
            useRememberingLanguage: false,
            promptGuidance: 'Reference casually',
          },
        }),
      ],
    });

    const formatted = formatRetrievedContext(context);

    expect(formatted).toContain('[Related content from earlier in this session]');
    expect(formatted).toContain('Earlier we talked about trust');
  });
});

// ============================================================================
// Tests — buildMessagesWithFullContext
// ============================================================================

describe('buildMessagesWithFullContext', () => {
  it('includes conversation history before current message', () => {
    const context = buildRetrievedContext({
      conversationHistory: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
    });

    const messages = buildMessagesWithFullContext(context, 'How are you?');

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].content).toBe('Hi there!');
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toContain('How are you?');
  });

  it('injects retrieved context as prefix to current message', () => {
    const context = buildRetrievedContext({
      conversationHistory: [],
      relevantFromOtherSessions: [buildRelevantMessage({ content: 'Past insight about trust' })],
    });

    const messages = buildMessagesWithFullContext(context, 'I want to talk about trust');

    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.content).toContain('Retrieved context:');
    expect(lastMsg.content).toContain('I want to talk about trust');
  });

  it('does not inject context prefix when no retrieved context', () => {
    const context = buildRetrievedContext({
      conversationHistory: [
        { role: 'user', content: 'prev' },
        { role: 'assistant', content: 'ok' },
      ],
    });

    const messages = buildMessagesWithFullContext(context, 'Hi');

    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.content).toBe('Hi');
    expect(lastMsg.content).not.toContain('Retrieved context');
  });
});
