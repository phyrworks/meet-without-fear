/**
 * Tests for token-budget utility functions
 */

import {
  estimateTokens,
  estimateMessagesTokens,
  calculateMessageBudget,
  buildBudgetedContext,
  MODEL_LIMITS,
  getRecommendedLimits,
} from '../token-budget';

describe('token-budget utilities', () => {
  describe('estimateTokens', () => {
    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate tokens based on character count (~4 chars/token)', () => {
      // 100 chars should be ~25 tokens
      const text = 'a'.repeat(100);
      expect(estimateTokens(text)).toBe(25);
    });

    it('should handle typical sentences', () => {
      const sentence = 'Hello, how are you doing today?'; // 31 chars
      expect(estimateTokens(sentence)).toBe(8); // ceil(31/4)
    });

    it('should handle long paragraphs', () => {
      const paragraph =
        'This is a longer paragraph with multiple sentences. It contains various words and punctuation marks. The goal is to test token estimation for realistic content.';
      const tokens = estimateTokens(paragraph);
      // 163 chars -> ~41 tokens
      expect(tokens).toBeGreaterThan(30);
      expect(tokens).toBeLessThan(50);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('should return 0 for empty array', () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });

    it('should add overhead per message', () => {
      const messages = [
        { role: 'user', content: 'Hi' }, // ~1 token + 4 overhead
        { role: 'assistant', content: 'Hello!' }, // ~2 tokens + 4 overhead
      ];
      const tokens = estimateMessagesTokens(messages);
      // 2 messages × 4 overhead + content tokens
      expect(tokens).toBeGreaterThan(8);
    });

    it('should estimate conversation accurately', () => {
      const conversation = [
        { role: 'user', content: 'I have been feeling frustrated with my partner lately.' },
        {
          role: 'assistant',
          content: 'I hear that you are experiencing frustration. Can you tell me more about what has been happening?',
        },
        { role: 'user', content: 'They never seem to listen when I talk about my day.' },
      ];
      const tokens = estimateMessagesTokens(conversation);
      // Should be substantial but not huge
      expect(tokens).toBeGreaterThan(50);
      expect(tokens).toBeLessThan(100);
    });
  });

  describe('calculateMessageBudget', () => {
    it('should return 0 for empty messages', () => {
      const result = calculateMessageBudget([], 1000);
      expect(result.included).toBe(0);
      expect(result.tokens).toBe(0);
    });

    it('should include all messages when under budget', () => {
      const messages = [
        { role: 'user', content: 'Short message 1' },
        { role: 'assistant', content: 'Short message 2' },
        { role: 'user', content: 'Short message 3' },
      ];
      const result = calculateMessageBudget(messages, 1000);
      expect(result.included).toBe(3);
    });

    it('should respect minimum message count even if over budget', () => {
      const messages = [
        { role: 'user', content: 'a'.repeat(400) }, // ~100 tokens
        { role: 'assistant', content: 'b'.repeat(400) }, // ~100 tokens
        { role: 'user', content: 'c'.repeat(400) }, // ~100 tokens
        { role: 'assistant', content: 'd'.repeat(400) }, // ~100 tokens
      ];
      // Very small budget but minimum of 4 messages
      const result = calculateMessageBudget(messages, 50, 4);
      expect(result.included).toBe(4); // All 4 included despite being over budget
    });

    it('should prioritize recent messages', () => {
      const messages = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message number ${i + 1} with some content`,
      }));
      // Limited budget
      const result = calculateMessageBudget(messages, 200, 4);
      expect(result.included).toBeLessThan(20);
      expect(result.included).toBeGreaterThanOrEqual(4);
    });
  });

  describe('buildBudgetedContext', () => {
    const systemPrompt = 'You are a helpful assistant. Be empathetic and supportive.';
    const shortHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    it('should include all content when under budget', () => {
      const result = buildBudgetedContext(systemPrompt, shortHistory, 'Some retrieved context', 10000);

      expect(result.conversationMessages.length).toBe(2);
      expect(result.truncated).toBe(0);
      expect(result.retrievedContext).toBe('Some retrieved context');
    });

    it('should truncate when over budget', () => {
      const longHistory: Array<{ role: 'user' | 'assistant'; content: string }> = Array.from(
        { length: 100 },
        (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `This is message number ${i + 1}. `.repeat(10),
        }),
      );

      const result = buildBudgetedContext(
        systemPrompt,
        longHistory,
        'Very long retrieved context '.repeat(100),
        500, // Very small budget
      );

      expect(result.conversationMessages.length).toBeLessThan(100);
      expect(result.truncated).toBeGreaterThan(0);
    });

    it('should preserve message type constraint', () => {
      const result = buildBudgetedContext(systemPrompt, shortHistory, 'context', 10000);

      // TypeScript should ensure these are 'user' | 'assistant', not just string
      expect(result.conversationMessages[0].role).toBe('user');
      expect(result.conversationMessages[1].role).toBe('assistant');
    });

    it('should report token usage', () => {
      const result = buildBudgetedContext(systemPrompt, shortHistory, 'Some context', 10000);

      expect(result.conversationTokens).toBeGreaterThan(0);
      expect(result.retrievedTokens).toBeGreaterThan(0);
      expect(result.totalTokens).toBe(
        estimateTokens(systemPrompt) + result.conversationTokens + result.retrievedTokens,
      );
    });
  });

  describe('getRecommendedLimits', () => {
    it('should return structured recommendations', () => {
      const limits = getRecommendedLimits();

      expect(limits.conversationMessages).toHaveProperty('min');
      expect(limits.conversationMessages).toHaveProperty('recommended');
      expect(limits.conversationMessages).toHaveProperty('max');

      expect(limits.crossSessionMessages.recommended).toBe(5);
      expect(limits.currentSessionRetrieved.recommended).toBe(5);
      expect(limits.preSessionMessages.recommended).toBe(5);

      expect(limits.rationale).toContain('CONVERSATION HISTORY');
      expect(limits.rationale).toContain('CROSS-SESSION RETRIEVAL');
    });
  });

  describe('MODEL_LIMITS', () => {
    it('should have sensible defaults', () => {
      expect(MODEL_LIMITS.maxInputTokens).toBeGreaterThan(100000);
      expect(MODEL_LIMITS.systemPromptBudget).toBeGreaterThan(1000);
      expect(MODEL_LIMITS.outputReservation).toBeGreaterThan(1000);
      expect(MODEL_LIMITS.contextBudget).toBeGreaterThanOrEqual(40000);
    });
  });
});
