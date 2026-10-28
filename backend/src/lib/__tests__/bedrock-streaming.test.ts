/**
 * Tests for Bedrock Streaming functionality
 */

import { getSonnetStreamingResponse, StreamEvent, resetBedrockClient } from '../bedrock';

// Mock the Anthropic Bedrock SDK
jest.mock('@anthropic-ai/bedrock-sdk', () => {
  return jest.fn();
});

// Mock the AWS SDK (still needed for getBedrockClient path)
jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock-runtime');
  return {
    ...actual,
    BedrockRuntimeClient: jest.fn(),
  };
});

// Mock brain service
jest.mock('../../services/brain-service', () => ({
  brainService: {
    startActivity: jest.fn().mockResolvedValue({ id: 'test-activity-id' }),
    completeActivity: jest.fn().mockResolvedValue(undefined),
    failActivity: jest.fn().mockResolvedValue(undefined),
  },
}));

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';

describe('getSonnetStreamingResponse', () => {
  let mockStream: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    resetBedrockClient();

    // Set up AWS credentials for client initialization
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    process.env.AWS_REGION = 'us-east-1';

    mockStream = jest.fn();

    // Mock the AnthropicBedrock constructor
    (AnthropicBedrock as unknown as jest.Mock).mockImplementation(() => ({
      messages: {
        stream: mockStream,
      },
    }));
  });

  afterEach(() => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_REGION;
    resetBedrockClient();
  });

  it('should yield text chunks as they arrive', async () => {
    // Create a mock stream that yields Anthropic-format events
    const mockEvents = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } },
    ];

    const streamObj = {
      [Symbol.asyncIterator]: async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      },
      finalMessage: jest.fn().mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      }),
    };

    mockStream.mockReturnValue(streamObj);

    const events: StreamEvent[] = [];
    for await (const event of getSonnetStreamingResponse({
      systemPrompt: 'You are a helpful assistant',
      messages: [{ role: 'user', content: 'Say hello' }],
      sessionId: 'test-session',
      turnId: 'test-turn',
      operation: 'test',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(events[1]).toEqual({ type: 'text', text: ', ' });
    expect(events[2]).toEqual({ type: 'text', text: 'world!' });
    expect(events[3]).toEqual({
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('should accumulate and yield tool use results', async () => {
    const mockEvents = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will update the state.' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool-123', name: 'update_session_state' },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"offer' } },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'FeelHeardCheck":true}' },
      },
      { type: 'content_block_stop', index: 1 },
    ];

    const streamObj = {
      [Symbol.asyncIterator]: async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      },
      finalMessage: jest.fn().mockResolvedValue({
        usage: { input_tokens: 50, output_tokens: 30 },
        stop_reason: 'tool_use',
      }),
    };

    mockStream.mockReturnValue(streamObj);

    const events: StreamEvent[] = [];
    for await (const event of getSonnetStreamingResponse({
      systemPrompt: 'You are a helpful assistant',
      messages: [{ role: 'user', content: 'Help me' }],
      tools: [
        {
          name: 'update_session_state',
          description: 'Update session state',
          input_schema: {
            type: 'object',
            properties: { offerFeelHeardCheck: { type: 'boolean' } },
          },
        },
      ],
      sessionId: 'test-session',
      turnId: 'test-turn',
      operation: 'test',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'text', text: 'I will update the state.' });
    expect(events[1]).toEqual({
      type: 'tool_use',
      toolUseId: 'tool-123',
      name: 'update_session_state',
      input: { offerFeelHeardCheck: true },
    });
    expect(events[2]).toEqual({
      type: 'done',
      usage: { inputTokens: 50, outputTokens: 30 },
    });
  });

  it('should handle empty tool input gracefully', async () => {
    const mockEvents = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-456', name: 'some_tool' } },
      { type: 'content_block_stop', index: 0 },
    ];

    const streamObj = {
      [Symbol.asyncIterator]: async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      },
      finalMessage: jest.fn().mockResolvedValue({
        usage: { input_tokens: 20, output_tokens: 10 },
        stop_reason: 'tool_use',
      }),
    };

    mockStream.mockReturnValue(streamObj);

    const events: StreamEvent[] = [];
    for await (const event of getSonnetStreamingResponse({
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Test' }],
      sessionId: 'test-session',
      turnId: 'test-turn',
      operation: 'test',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'tool_use',
      toolUseId: 'tool-456',
      name: 'some_tool',
      input: {},
    });
  });

  it('should yield done with zero usage when client is not configured', async () => {
    // Clear AWS credentials
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    resetBedrockClient();

    const events: StreamEvent[] = [];
    for await (const event of getSonnetStreamingResponse({
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Test' }],
      sessionId: 'test-session',
      turnId: 'test-turn',
      operation: 'test',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it('should yield done with error flag instead of throwing when stream fails', async () => {
    // Simulate the Anthropic stream throwing mid-iteration
    const streamObj = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } };
        throw new Error('Connection reset by peer');
      },
      finalMessage: jest.fn(),
    };

    mockStream.mockReturnValue(streamObj);

    const events: StreamEvent[] = [];
    // Should NOT throw — the generator catches errors and yields a done event
    for await (const event of getSonnetStreamingResponse({
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Test' }],
      sessionId: 'test-session',
      turnId: 'test-turn',
      operation: 'test',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text', text: 'Partial' });
    expect(events[1]).toEqual({
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0 },
      error: 'Connection reset by peer',
    });
  });

  it('should yield done with error flag when finalMessage() rejects', async () => {
    // Stream iterates fine but finalMessage() throws (e.g., incomplete response)
    const mockEvents = [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }];

    const streamObj = {
      [Symbol.asyncIterator]: async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      },
      finalMessage: jest.fn().mockRejectedValue(new Error('Stream ended unexpectedly')),
    };

    mockStream.mockReturnValue(streamObj);

    const events: StreamEvent[] = [];
    for await (const event of getSonnetStreamingResponse({
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Test' }],
      sessionId: 'test-session',
      turnId: 'test-turn',
      operation: 'test',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(events[1]).toEqual({
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0 },
      error: 'Stream ended unexpectedly',
    });
  });

  it('should include error flag that consumer can use to detect failures', async () => {
    // Verify the consumer pattern: check event.error to distinguish success from failure
    const streamObj = {
      [Symbol.asyncIterator]: async function* () {
        throw new Error('Bedrock throttling');
      },
      finalMessage: jest.fn(),
    };

    mockStream.mockReturnValue(streamObj);

    const events: StreamEvent[] = [];
    for await (const event of getSonnetStreamingResponse({
      systemPrompt: 'Test',
      messages: [{ role: 'user', content: 'Test' }],
      sessionId: 'test-session',
      turnId: 'test-turn',
      operation: 'test',
    })) {
      events.push(event);
    }

    // Consumer can check for error on done event
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.type).toBe('done');
    if (doneEvent!.type === 'done') {
      expect(doneEvent!.error).toBe('Bedrock throttling');
      expect(doneEvent!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    }
  });
});
