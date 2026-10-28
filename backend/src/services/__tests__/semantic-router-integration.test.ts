/**
 * Semantic Router Integration Tests
 *
 * Verifies the end-to-end behavior of the micro-tag response parsing system:
 * - Stage 1 flow with FeelHeardCheck flag
 * - Stage 2 flow with ReadyShare flag and empathy draft
 * - Dispatch flow for EXPLAIN_PROCESS and HANDLE_MEMORY_REQUEST
 * - Privacy: Tags never leak to user response
 */

import { parseMicroTagResponse } from '../../utils/micro-tag-parser';
import { handleDispatch, type DispatchContext } from '../dispatch-handler';

// Mock the bedrock module to avoid actual API calls in dispatch handler
jest.mock('../../lib/bedrock', () => ({
  getSonnetResponse: jest
    .fn()
    .mockResolvedValue(
      'In the Witness Stage you get to be fully heard. Then Perspective Stretch helps you understand your partner. What Matters helps you explore what truly matters to each of you. Finally, Strategic Repair helps you find solutions.',
    ),
  BrainActivityCallType: {
    ORCHESTRATED_RESPONSE: 'ORCHESTRATED_RESPONSE',
  },
}));

// Mock context for dispatch calls
const mockDispatchContext: DispatchContext = {
  userMessage: 'How does this process work?',
  conversationHistory: [],
  userName: 'Test User',
  sessionId: 'test-session',
  turnId: 'test-turn',
};

describe('Semantic Router Integration', () => {
  describe('Stage 1 Flow', () => {
    it('correctly parses a typical Stage 1 response', () => {
      const simulatedResponse = `<thinking>
Mode: Witness
Intensity: 7
FeelHeardCheck: N
Strategy: Reflect back the frustration
</thinking>

I hear how frustrated you're feeling right now. It sounds like this has been building up for a while. What feels most important for me to understand?`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.offerFeelHeardCheck).toBe(false);
      expect(parsed.response).toContain('frustrated');
      expect(parsed.response).not.toContain('Mode:');
      expect(parsed.response).not.toContain('<thinking>');
    });

    it('correctly detects feel-heard readiness', () => {
      const simulatedResponse = `<thinking>
Mode: Witness
Intensity: 4
FeelHeardCheck: Y
Strategy: User has named core pain, affirmed reflection
</thinking>

Yes, exactly - that feeling of being invisible in your own home. I really hear that. It sounds like what you need most is to be seen.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.offerFeelHeardCheck).toBe(true);
      expect(parsed.response).toContain('invisible');
    });

    it('handles multiline thinking blocks', () => {
      const simulatedResponse = `<thinking>
Mode: Witness
Intensity: 6
FeelHeardCheck: N
Strategy:
- User is still venting
- Need to validate more
- Not ready for check yet
</thinking>

That sounds incredibly hard. You're dealing with a lot right now.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.offerFeelHeardCheck).toBe(false);
      expect(parsed.thinking).toContain('User is still venting');
      expect(parsed.response).toBe("That sounds incredibly hard. You're dealing with a lot right now.");
    });
  });

  describe('Stage 2 Flow', () => {
    it('extracts empathy draft from Stage 2 response', () => {
      const simulatedResponse = `<thinking>
Mode: Bridging
ReadyShare: Y
Strategy: User has developed genuine empathy, ready to draft
</thinking>

<draft>
I think you might be feeling overwhelmed by all the demands on your time, and scared that if you say no, I'll think you don't care about us.
</draft>

That's a really thoughtful attempt to step into their shoes. Here's how I'd summarize what you're sensing.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.offerReadyToShare).toBe(true);
      expect(parsed.draft).toContain('overwhelmed');
      expect(parsed.draft).toContain('scared');
      expect(parsed.response).not.toContain('overwhelmed');
      expect(parsed.response).toContain('thoughtful attempt');
    });

    it('handles Stage 2 without ReadyShare', () => {
      const simulatedResponse = `<thinking>
Mode: Listening
ReadyShare: N
Strategy: User still venting about partner, not ready for empathy yet
</thinking>

I can hear how much that hurt. Before we try to understand their perspective, I want to make sure you feel fully heard.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.offerReadyToShare).toBe(false);
      expect(parsed.draft).toBeNull();
    });
  });

  describe('Stage 0 Invitation Flow', () => {
    it('extracts invitation draft', () => {
      const simulatedResponse = `<thinking>
Mode: Invitation
Intensity: 5
Strategy: User has given enough context, ready to propose
</thinking>

<draft>
I've been thinking about us and would love to have a real conversation where we both feel heard. Would you join me?
</draft>

Here's a draft invitation that captures what you've shared. Take a look and let me know if you'd like to adjust anything.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.draft).toContain("I've been thinking about us");
      expect(parsed.draft).toContain('Would you join me?');
      expect(parsed.response).toContain('draft invitation');
      expect(parsed.response).not.toContain('<draft>');
    });
  });

  describe('Dispatch Flow', () => {
    it('handles EXPLAIN_PROCESS dispatch', async () => {
      const simulatedResponse = `<thinking>
User asking how this works
</thinking>

<dispatch>EXPLAIN_PROCESS</dispatch>`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.dispatchTag).toBe('EXPLAIN_PROCESS');

      const dispatchedResponse = await handleDispatch(parsed.dispatchTag!, mockDispatchContext);
      // AI response should explain the stages
      expect(dispatchedResponse).toBeTruthy();
      expect(dispatchedResponse!.length).toBeGreaterThan(50);
    });

    it('handles HANDLE_MEMORY_REQUEST dispatch', async () => {
      const simulatedResponse = `<thinking>
User wants me to remember something
</thinking>

<dispatch>HANDLE_MEMORY_REQUEST</dispatch>`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.dispatchTag).toBe('HANDLE_MEMORY_REQUEST');

      const dispatchedResponse = await handleDispatch(parsed.dispatchTag!, mockDispatchContext);
      expect(dispatchedResponse).toContain('Profile');
      expect(dispatchedResponse).toContain('Things to Remember');
    });

    it('dispatch tag with user response (edge case)', async () => {
      // Sometimes the AI might output both dispatch AND a response
      const simulatedResponse = `<thinking>
User asking about the process
</thinking>

<dispatch>EXPLAIN_PROCESS</dispatch>

Let me explain how this works.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.dispatchTag).toBe('EXPLAIN_PROCESS');
      // Even if there's text after dispatch, the orchestrator should use the dispatch handler response
      expect(parsed.response).toBe('Let me explain how this works.');
    });
  });

  describe('Privacy - Tags Never Leak', () => {
    it('thinking tags are fully stripped', () => {
      const simulatedResponse = `<thinking>
Mode: Witness
FeelHeardCheck: Y
Secret analysis here
Internal strategy notes
</thinking>

Your response text.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.response).not.toContain('<thinking>');
      expect(parsed.response).not.toContain('Mode:');
      expect(parsed.response).not.toContain('Secret analysis');
      expect(parsed.response).not.toContain('Internal strategy');
      expect(parsed.response).toBe('Your response text.');
    });

    it('draft tags are fully stripped', () => {
      const simulatedResponse = `<thinking>test</thinking>
<draft>Private draft content</draft>
Public response.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.response).not.toContain('<draft>');
      expect(parsed.response).not.toContain('Private draft content');
      expect(parsed.response).toBe('Public response.');
      // Draft is still available internally
      expect(parsed.draft).toBe('Private draft content');
    });

    it('dispatch tags are fully stripped', () => {
      const simulatedResponse = `<thinking>test</thinking>
<dispatch>SOME_TAG</dispatch>
Fallback response.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.response).not.toContain('<dispatch>');
      expect(parsed.response).not.toContain('SOME_TAG');
      expect(parsed.response).toBe('Fallback response.');
    });

    it('all tag types stripped together', () => {
      const simulatedResponse = `<thinking>
Mode: Witness
FeelHeardCheck: Y
</thinking>

<draft>
Draft content for UI panel
</draft>

<dispatch>EXPLAIN_PROCESS</dispatch>

Clean user-facing response.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.response).toBe('Clean user-facing response.');
      expect(parsed.thinking).toContain('Mode: Witness');
      expect(parsed.draft).toContain('Draft content');
      expect(parsed.dispatchTag).toBe('EXPLAIN_PROCESS');
    });
  });

  describe('Edge Cases', () => {
    it('handles empty thinking block', () => {
      const simulatedResponse = `<thinking></thinking>
Response without analysis.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.thinking).toBe('');
      expect(parsed.response).toBe('Response without analysis.');
      expect(parsed.offerFeelHeardCheck).toBe(false);
    });

    it('handles response with no tags at all (fallback)', () => {
      const plainResponse = 'Just a plain response with no tags.';

      const parsed = parseMicroTagResponse(plainResponse);

      expect(parsed.response).toBe('Just a plain response with no tags.');
      expect(parsed.thinking).toBe('');
      expect(parsed.draft).toBeNull();
      expect(parsed.dispatchTag).toBeNull();
    });

    it('handles case-insensitive flags', () => {
      const simulatedResponse = `<thinking>
feelheardcheck:y
readyshare:y
</thinking>
Response.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.offerFeelHeardCheck).toBe(true);
      expect(parsed.offerReadyToShare).toBe(true);
    });

    it('handles whitespace in flag values', () => {
      const simulatedResponse = `<thinking>
FeelHeardCheck:  Y
ReadyShare:   Y
</thinking>
Response.`;

      const parsed = parseMicroTagResponse(simulatedResponse);

      expect(parsed.offerFeelHeardCheck).toBe(true);
      expect(parsed.offerReadyToShare).toBe(true);
    });
  });
});
