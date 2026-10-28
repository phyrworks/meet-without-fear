import { handleDispatch, type DispatchContext } from '../dispatch-handler';

// Mock the bedrock module to avoid actual API calls
jest.mock('../../lib/bedrock', () => ({
  getSonnetResponse: jest.fn().mockResolvedValue('Sure, let me explain what happens next in the process.'),
  BrainActivityCallType: {
    ORCHESTRATED_RESPONSE: 'ORCHESTRATED_RESPONSE',
  },
}));

describe('dispatch-handler', () => {
  const mockContext: DispatchContext = {
    userMessage: 'How does this process work?',
    conversationHistory: [{ role: 'assistant', content: 'Hi there, how can I help?' }],
    userName: 'Test User',
    partnerName: 'Partner',
    sessionId: 'test-session-123',
    turnId: 'test-turn-123',
  };

  describe('handleDispatch', () => {
    it('returns AI response for EXPLAIN_PROCESS', async () => {
      const result = await handleDispatch('EXPLAIN_PROCESS', mockContext);

      // Should call the AI and return a response
      expect(result).toBeTruthy();
      expect(result!.length).toBeGreaterThan(10);
    });

    it('returns memory guidance for HANDLE_MEMORY_REQUEST', async () => {
      const result = await handleDispatch('HANDLE_MEMORY_REQUEST', mockContext);

      expect(result).toContain('Profile');
      expect(result).toContain('Things to Remember');
    });

    it('returns retry guidance for safety concern tags', async () => {
      const result = await handleDispatch('SAFETY_CONCERN_MENTAL_HEALTH_CRISIS', mockContext);

      expect(result).toContain("I'm sorry");
      expect(result).toContain('safety-sensitive');
      expect(result).toContain('try again');
    });

    it('returns null for unknown dispatch tag (falls through to original AI response)', async () => {
      const result = await handleDispatch('UNKNOWN_TAG', mockContext);

      expect(result).toBeNull();
    });

    it('returns null for empty dispatch tag', async () => {
      const result = await handleDispatch('', mockContext);
      expect(result).toBeNull();
    });

    it('passes conversation history to AI for context-aware responses', async () => {
      const { getSonnetResponse } = require('../../lib/bedrock');

      const contextWithHistory: DispatchContext = {
        ...mockContext,
        userMessage: 'Yeah what happens next?',
        conversationHistory: [
          { role: 'assistant', content: 'The basic idea is simple...' },
          { role: 'user', content: 'How does this process work?' },
          { role: 'assistant', content: 'We help you feel heard first...' },
        ],
      };

      await handleDispatch('EXPLAIN_PROCESS', contextWithHistory);

      // Verify the AI was called with conversation history
      expect(getSonnetResponse).toHaveBeenCalled();
      const callArgs = getSonnetResponse.mock.calls[getSonnetResponse.mock.calls.length - 1][0];
      expect(callArgs.messages.length).toBeGreaterThan(1);
    });
  });
});
