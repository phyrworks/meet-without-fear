/**
 * Unit tests for `runStreamTurnModel` — the two-pass model execution.
 *
 * These pin the two structured-state channels (the `update_session_state`
 * tool call and the legacy hidden-tag fallback), the guarantee that hidden
 * reasoning never reaches the client, and that unvalidated model output
 * cannot mutate state.
 */

import { runStreamTurnModel } from '../stream-turn-model';
import { getModelCompletionWithTools, getSonnetStreamingResponse } from '../../lib/bedrock';
import { SESSION_STATE_TOOL_NAME } from '../stage-tools';

jest.mock('../../lib/bedrock', () => ({
  getModelCompletionWithTools: jest.fn().mockResolvedValue({ text: null, toolInvocations: [] }),
  getSonnetStreamingResponse: jest.fn(),
  BrainActivityCallType: { ORCHESTRATED_RESPONSE: 'ORCHESTRATED_RESPONSE' },
}));

jest.mock('../stage-prompts', () => ({
  buildStagePrompt: jest.fn().mockReturnValue({ staticBlock: 's', dynamicBlock: 'd' }),
}));

/** Builds an async generator over the given stream events. */
function streamOf(...events: any[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function text(t: string) {
  return { type: 'text', text: t };
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    currentStage: 1,
    isInvitationPhase: false,
    userTurnCount: 1,
    prompt: { staticBlock: 'static', dynamicBlock: 'dynamic' },
    messagesWithContext: [{ role: 'user' as const, content: 'hi' }],
    emitVisibleChunk: jest.fn(),
    isClientDisconnected: () => false,
    ...overrides,
  } as any;
}

describe('stream-turn-model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getModelCompletionWithTools as jest.Mock).mockResolvedValue({ text: null, toolInvocations: [] });
    (getSonnetStreamingResponse as jest.Mock).mockReturnValue(streamOf(text('Hello there.')));
  });

  describe('two-pass structure', () => {
    it('runs the state capture pass before the visible pass', async () => {
      const order: string[] = [];
      (getModelCompletionWithTools as jest.Mock).mockImplementation(async () => {
        order.push('capture');
        return { text: null, toolInvocations: [] };
      });
      (getSonnetStreamingResponse as jest.Mock).mockImplementation(() => {
        order.push('visible');
        return streamOf(text('hi'));
      });

      await runStreamTurnModel(params());

      expect(order).toEqual(['capture', 'visible']);
    });

    it('offers tools only on the capture pass, never on the visible pass', async () => {
      await runStreamTurnModel(params());

      expect((getModelCompletionWithTools as jest.Mock).mock.calls[0][1]).toHaveProperty('tools');
      expect((getSonnetStreamingResponse as jest.Mock).mock.calls[0][0]).not.toHaveProperty('tools');
    });

    it('does not emit any text produced by the capture pass', async () => {
      (getModelCompletionWithTools as jest.Mock).mockResolvedValue({
        text: 'internal planning prose that must not be shown',
        toolInvocations: [],
      });
      const emitVisibleChunk = jest.fn();

      const result = await runStreamTurnModel(params({ emitVisibleChunk }));

      expect(result.accumulatedText).not.toContain('internal planning prose');
      for (const [chunk] of emitVisibleChunk.mock.calls) {
        expect(chunk).not.toContain('internal planning prose');
      }
    });
  });

  describe('structured tool-call channel', () => {
    it('takes state from a validated update_session_state call on the capture pass', async () => {
      (getModelCompletionWithTools as jest.Mock).mockResolvedValue({
        text: null,
        toolInvocations: [
          { name: SESSION_STATE_TOOL_NAME, input: { offerFeelHeardCheck: true, topicFrame: 'the trip' } },
        ],
      });

      const result = await runStreamTurnModel(params());

      expect(result.metadata.offerFeelHeardCheck).toBe(true);
      expect(result.metadata.topicFrame).toBe('the trip');
    });

    it('merges an in-stream tool call over the capture-pass state', async () => {
      (getModelCompletionWithTools as jest.Mock).mockResolvedValue({
        text: null,
        toolInvocations: [{ name: SESSION_STATE_TOOL_NAME, input: { topicFrame: 'first' } }],
      });
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(
        streamOf(
          { type: 'tool_use', toolUseId: 't1', name: SESSION_STATE_TOOL_NAME, input: { topicFrame: 'second' } },
          text('visible'),
        ),
      );

      const result = await runStreamTurnModel(params());

      expect(result.metadata.topicFrame).toBe('second');
    });

    it('ignores an unknown tool call entirely', async () => {
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(
        streamOf(
          { type: 'tool_use', toolUseId: 't1', name: 'delete_everything', input: { topicFrame: 'evil' } },
          text('visible'),
        ),
      );

      const result = await runStreamTurnModel(params());

      expect(result.metadata.topicFrame).toBeUndefined();
    });

    it('drops malformed tool input rather than trusting it', async () => {
      (getModelCompletionWithTools as jest.Mock).mockResolvedValue({
        text: null,
        toolInvocations: [
          {
            name: SESSION_STATE_TOOL_NAME,
            input: { offerFeelHeardCheck: 'yes please', topicFrame: 42, proposedNeed: 'not an object' },
          },
        ],
      });

      const result = await runStreamTurnModel(params());

      expect(result.metadata.offerFeelHeardCheck).toBeUndefined();
      expect(result.metadata.topicFrame).toBeUndefined();
      expect(result.metadata.proposedNeed).toBeUndefined();
    });

    // The downstream consequence of this refusal — malformed input becoming a
    // definite `false` once resolution backfills it — is a known defect pinned
    // in stream-turn-known-defects.test.ts, which composes both services.
    it('refuses a malformed boolean rather than coercing it to true', async () => {
      (getModelCompletionWithTools as jest.Mock).mockResolvedValue({
        text: null,
        toolInvocations: [{ name: SESSION_STATE_TOOL_NAME, input: { offerFeelHeardCheck: 'yes please' } }],
      });

      const result = await runStreamTurnModel(params());

      expect(result.metadata.offerFeelHeardCheck).toBeUndefined();
    });
  });

  describe('legacy hidden-tag fallback channel', () => {
    it('parses state from capture-pass prose when the model skipped the tool', async () => {
      (getModelCompletionWithTools as jest.Mock).mockResolvedValue({
        text: '<thinking>FeelHeardCheck:Y</thinking>',
        toolInvocations: [],
      });

      const result = await runStreamTurnModel(params());

      expect(result.metadata.offerFeelHeardCheck).toBe(true);
    });

    it('only accepts a Stage 3 need from the fallback when the caller is in Stage 3', async () => {
      // The <need> block carries JSON; free prose inside it does not parse.
      const needJson = JSON.stringify({
        need: 'to be heard',
        category: 'CONNECTION',
        description: 'wants acknowledgement',
        evidence: [],
      });
      (getModelCompletionWithTools as jest.Mock).mockResolvedValue({
        text: `<need>${needJson}</need>`,
        toolInvocations: [],
      });

      const inStage1 = await runStreamTurnModel(params({ currentStage: 1 }));
      expect(inStage1.metadata.proposedNeed).toBeUndefined();

      const inStage3 = await runStreamTurnModel(params({ currentStage: 3 }));
      expect(inStage3.metadata.proposedNeed).toBeDefined();
    });

    it('captures hidden tags from the visible stream for post-stream resolution', async () => {
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(
        streamOf(text('<thinking>secret plan</thinking><draft>a draft</draft>Visible text.')),
      );

      const result = await runStreamTurnModel(params());

      expect(result.captured.thinking).toContain('secret plan');
      expect(result.captured.draft).toContain('a draft');
    });
  });

  describe('hidden reasoning never reaches the client', () => {
    it('does not emit thinking content', async () => {
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(
        streamOf(text('<thinking>internal reasoning</thinking>Visible answer.')),
      );
      const emitVisibleChunk = jest.fn();

      const result = await runStreamTurnModel(params({ emitVisibleChunk }));

      expect(result.accumulatedText).not.toContain('internal reasoning');
      expect(result.accumulatedText).toContain('Visible answer.');
      for (const [chunk] of emitVisibleChunk.mock.calls) {
        expect(chunk).not.toContain('internal reasoning');
      }
    });

    it('keeps unterminated thinking hidden rather than flushing it', async () => {
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(
        streamOf(text('<thinking>reasoning that never closes')),
      );

      const result = await runStreamTurnModel(params());

      expect(result.accumulatedText).toBe('');
    });

    it('emits accumulated text equal to the concatenation of emitted chunks', async () => {
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(streamOf(text('Part one. '), text('Part two.')));
      const emitted: string[] = [];

      const result = await runStreamTurnModel(params({ emitVisibleChunk: (t: string) => emitted.push(t) }));

      // Assert the actual content too: without this, deleting both emission
      // and accumulation would leave '' === '' and pass.
      expect(result.accumulatedText).toBe('Part one. Part two.');
      expect(emitted.join('')).toBe(result.accumulatedText);
    });
  });

  describe('client disconnect', () => {
    // Sanitizer timing: a response with no <thinking> opener bails out of the
    // thinking trap on the first delta and buffers it WITHOUT evaluating, so
    // the first delta never emits on its own. The second delta clears the tag
    // trap's ~50-character threshold and releases both; the third then streams
    // normally. Three deltas is therefore the minimum for two emissions.
    const FIRST = 'I hear that you felt dismissed when the plans changed again. ';
    const SECOND = 'That sounds lonely. ';
    const THIRD = 'It kept happening all week.';

    it('stops emitting once the client is gone', async () => {
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(streamOf(text(FIRST), text(SECOND), text(THIRD)));
      let disconnected = false;
      const emitVisibleChunk = jest.fn(() => {
        disconnected = true; // disconnect right after the first emission
      });

      await runStreamTurnModel(params({ emitVisibleChunk, isClientDisconnected: () => disconnected }));

      expect(emitVisibleChunk).toHaveBeenCalledTimes(1);
    });

    /**
     * The full defect — this truncated text then being persisted as a
     * complete AI message — is a property of the controller's orchestration
     * and is pinned against the real `sendMessageStream` in
     * src/routes/__tests__/messages-stream-characterization.test.ts. Here we
     * pin only the model half: text produced after the disconnect is dropped
     * from the returned response rather than merely unsent.
     *
     * Asserted as a strict prefix rather than an exact string so a change to
     * how the sanitizer batches deltas does not fail this test for the wrong
     * reason.
     */
    it('drops post-disconnect text from the returned response, not just from the wire', async () => {
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(streamOf(text(FIRST), text(SECOND), text(THIRD)));
      let disconnected = false;
      const emitVisibleChunk = jest.fn(() => {
        disconnected = true;
      });

      const result = await runStreamTurnModel(params({ emitVisibleChunk, isClientDisconnected: () => disconnected }));

      const full = `${FIRST}${SECOND}${THIRD}`;
      expect(result.accumulatedText.length).toBeGreaterThan(0);
      expect(result.accumulatedText.length).toBeLessThan(full.length);
      expect(full.startsWith(result.accumulatedText.trimEnd())).toBe(true);
      expect(result.accumulatedText).not.toContain('kept happening');
    });

    it('reads the disconnect state fresh on every emission rather than capturing it once', async () => {
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(streamOf(text(FIRST), text(SECOND), text(THIRD)));
      let checks = 0;

      await runStreamTurnModel(
        params({
          emitVisibleChunk: jest.fn(),
          isClientDisconnected: () => {
            checks += 1;
            return false;
          },
        }),
      );

      // Consulted per emission attempt, not read once up front.
      expect(checks).toBeGreaterThan(1);
    });
  });

  describe('stream failure', () => {
    it('throws when the generator reports an error on the done event', async () => {
      (getSonnetStreamingResponse as jest.Mock).mockReturnValue(
        streamOf(text('partial'), { type: 'done', error: 'upstream exploded' }),
      );

      await expect(runStreamTurnModel(params())).rejects.toThrow('upstream exploded');
    });

    it('propagates a capture-pass failure without starting the visible pass', async () => {
      (getModelCompletionWithTools as jest.Mock).mockRejectedValue(new Error('capture failed'));

      await expect(runStreamTurnModel(params())).rejects.toThrow('capture failed');
      expect(getSonnetStreamingResponse).not.toHaveBeenCalled();
    });
  });

  it('passes a zero-based mock response index derived from the 1-based turn count', async () => {
    await runStreamTurnModel(params({ userTurnCount: 3 }));

    expect((getSonnetStreamingResponse as jest.Mock).mock.calls[0][0].mockResponseIndex).toBe(2);
  });

  it('never lets the visible pass index go negative', async () => {
    await runStreamTurnModel(params({ userTurnCount: 0 }));

    expect((getSonnetStreamingResponse as jest.Mock).mock.calls[0][0].mockResponseIndex).toBe(0);
  });
});
