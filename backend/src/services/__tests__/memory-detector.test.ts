import { detectMemoryIntent, detectMemoryIntentMock } from '../memory-detector';

// Mock circuit breaker to execute immediately without timeout
jest.mock('../../utils/circuit-breaker', () => ({
  withHaikuCircuitBreaker: jest.fn().mockImplementation(async fn => fn()),
  withTimeout: jest.fn().mockImplementation(async fn => fn()),
  HAIKU_TIMEOUT_MS: 20000,
}));

// Mock Bedrock for tests that use the actual detectMemoryIntent
jest.mock('../../lib/bedrock', () => ({
  getHaikuJson: jest.fn().mockResolvedValue({
    hasMemoryIntent: false,
    suggestions: [],
    topicContext: null,
  }),
}));

describe('Memory Detector Service', () => {
  describe('detectMemoryIntentMock', () => {
    describe('AI_NAME detection', () => {
      it('detects "I\'ll call you" pattern', () => {
        const result = detectMemoryIntentMock("I'll call you Alex");

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0].category).toBe('AI_NAME');
        expect(result.suggestions[0].confidence).toBe('high');
      });

      it('detects "can I call you" pattern', () => {
        const result = detectMemoryIntentMock('Can I call you Buddy?');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('AI_NAME');
      });
    });

    describe('PERSONAL_INFO detection', () => {
      it('detects "call me" pattern for user name', () => {
        const result = detectMemoryIntentMock('Call me Sam');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0].category).toBe('PERSONAL_INFO');
      });

      it('detects "my name is" pattern', () => {
        const result = detectMemoryIntentMock('My name is Jordan');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('PERSONAL_INFO');
      });

      it('detects pronoun preferences', () => {
        const result = detectMemoryIntentMock('I use they/them pronouns');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('PERSONAL_INFO');
        expect(result.suggestions[0].suggestedContent).toContain('they/them');
      });

      it('detects she/her pronouns', () => {
        const result = detectMemoryIntentMock('My pronouns are she/her');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('PERSONAL_INFO');
      });
    });

    describe('COMMUNICATION detection', () => {
      it('detects "keep responses short" pattern', () => {
        const result = detectMemoryIntentMock('Keep your responses short please');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('COMMUNICATION');
      });

      it('detects "be more direct" pattern', () => {
        const result = detectMemoryIntentMock('Be more direct with me');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('COMMUNICATION');
      });

      it('detects "shorter responses" pattern', () => {
        const result = detectMemoryIntentMock('I prefer shorter responses');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('COMMUNICATION');
      });

      it('detects "be casual" pattern', () => {
        const result = detectMemoryIntentMock('Be more casual when talking to me');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('COMMUNICATION');
      });
    });

    describe('RELATIONSHIP detection', () => {
      it('detects partner name pattern', () => {
        const result = detectMemoryIntentMock("My partner's name is Jamie");

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('RELATIONSHIP');
        expect(result.suggestions[0].suggestedContent).toContain('Jamie');
      });

      it('detects spouse name pattern', () => {
        const result = detectMemoryIntentMock('My wife is named Sarah');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('RELATIONSHIP');
      });

      it('detects husband name pattern', () => {
        const result = detectMemoryIntentMock('My husband is named Michael');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('RELATIONSHIP');
      });
    });

    describe('PREFERENCE detection', () => {
      it('detects "don\'t use analogies" pattern', () => {
        const result = detectMemoryIntentMock("Don't use analogies when explaining");

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('PREFERENCE');
      });

      it('detects "give examples" pattern', () => {
        const result = detectMemoryIntentMock('Please give examples when explaining things');

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions[0].category).toBe('PREFERENCE');
      });
    });

    describe('No memory intent', () => {
      it('returns no suggestions for regular messages', () => {
        const result = detectMemoryIntentMock("I'm feeling frustrated with my partner");

        expect(result.hasMemoryIntent).toBe(false);
        expect(result.suggestions).toHaveLength(0);
      });

      it('returns no suggestions for empty messages', () => {
        const result = detectMemoryIntentMock('');

        expect(result.hasMemoryIntent).toBe(false);
        expect(result.suggestions).toHaveLength(0);
      });

      it('returns no suggestions for short messages', () => {
        const result = detectMemoryIntentMock('ok');

        expect(result.hasMemoryIntent).toBe(false);
        expect(result.suggestions).toHaveLength(0);
      });
    });

    describe('Multiple detections', () => {
      it('can detect multiple memory intents in one message', () => {
        const result = detectMemoryIntentMock("Call me Alex. My partner's name is Jordan. Keep responses brief.");

        expect(result.hasMemoryIntent).toBe(true);
        expect(result.suggestions.length).toBeGreaterThanOrEqual(2);

        const categories = result.suggestions.map(s => s.category);
        expect(categories).toContain('PERSONAL_INFO');
        expect(categories).toContain('RELATIONSHIP');
      });
    });
  });

  describe('detectMemoryIntent', () => {
    beforeEach(() => {
      // Clear AWS credentials to ensure mock mode
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    });

    it('returns no intent for very short messages', async () => {
      const result = await detectMemoryIntent('hi');

      expect(result.hasMemoryIntent).toBe(false);
      expect(result.suggestions).toHaveLength(0);
    });

    it('returns no intent for empty messages', async () => {
      const result = await detectMemoryIntent('');

      expect(result.hasMemoryIntent).toBe(false);
      expect(result.suggestions).toHaveLength(0);
    });

    it('handles null-like input gracefully', async () => {
      // @ts-expect-error Testing runtime behavior with invalid input
      const result = await detectMemoryIntent(null);

      expect(result.hasMemoryIntent).toBe(false);
      expect(result.suggestions).toHaveLength(0);
    });

    it('returns empty result when Haiku is unavailable', async () => {
      // Without AWS credentials, Haiku will return null
      const result = await detectMemoryIntent("I'll call you Alex and keep responses short");

      // Should return a valid result structure even without Haiku
      expect(result).toHaveProperty('hasMemoryIntent');
      expect(result).toHaveProperty('suggestions');
      expect(result).toHaveProperty('topicContext');
      expect(Array.isArray(result.suggestions)).toBe(true);
    });

    it('accepts optional sessionId parameter', async () => {
      const result = await detectMemoryIntent('Test message', 'session-123');

      expect(result).toHaveProperty('hasMemoryIntent');
    });
  });
});
