/**
 * CHARACTERIZATION of a KNOWN PRE-EXISTING DEFECT in the streaming turn:
 * malformed boolean tool input becoming a definite `false`.
 *
 * DO NOT "fix" these tests. The defect exists ACROSS a seam — the tool parser
 * is right to refuse the value, and resolution is right to backfill an absent
 * one; the loss happens between them — so it is pinned by composing the real
 * model and resolution services in the order the controller runs them.
 *
 * When the defect is genuinely fixed, these tests should fail. That failure is
 * the signal to delete them, not to loosen them.
 *
 * The other known defect (a mid-stream disconnect truncating the persisted AI
 * message) is a property of the controller's orchestration and is pinned
 * against the real `sendMessageStream` — see the note above the second test.
 */

import { runStreamTurnModel } from '../stream-turn-model';
import { resolveStreamTurn } from '../stream-turn-resolution';
import { getModelCompletionWithTools, getSonnetStreamingResponse } from '../../lib/bedrock';
import { SESSION_STATE_TOOL_NAME } from '../stage-tools';


jest.mock('../../lib/bedrock', () => ({
  getModelCompletionWithTools: jest.fn().mockResolvedValue({ text: null, toolInvocations: [] }),
  getSonnetStreamingResponse: jest.fn(),
  BrainActivityCallType: { ORCHESTRATED_RESPONSE: 'ORCHESTRATED_RESPONSE' },
}));

jest.mock('../dispatch-handler', () => ({
  handleDispatch: jest.fn().mockResolvedValue(null),
}));

function streamOf(...events: any[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

const t = (text: string) => ({ type: 'text', text });

function modelParams(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    currentStage: 1,
    isInvitationPhase: false,
    userTurnCount: 1,
    prompt: { staticBlock: 's', dynamicBlock: 'd' },
    messagesWithContext: [{ role: 'user' as const, content: 'hi' }],
    emitVisibleChunk: jest.fn(),
    isClientDisconnected: () => false,
    ...overrides,
  } as any;
}

function resolutionParams(modelResult: any, overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    currentStage: 1,
    isInvitationPhase: false,
    content: 'the user said this',
    history: [],
    userName: 'Ann',
    partnerName: 'Bo',
    session: { status: 'ACTIVE' },
    accumulatedText: modelResult.accumulatedText,
    metadata: modelResult.metadata,
    captured: modelResult.captured,
    emitVisibleChunk: jest.fn(),
    ...overrides,
  } as any;
}

describe('streaming turn — known pre-existing defects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getModelCompletionWithTools as jest.Mock).mockResolvedValue({ text: null, toolInvocations: [] });
  });

  /**
   * DEFECT 1 — a client disconnect mid-stream truncates the persisted AI
   * message — is deliberately NOT pinned here.
   *
   * It is a property of the controller's orchestration, not of any service or
   * of how a test chooses to wire them together: a hand-wired composition
   * would stay green if the controller changed how it supplies
   * `isClientDisconnected` / `emitVisibleChunk`. It is pinned against the real
   * `sendMessageStream` in
   * `src/routes/__tests__/messages-stream-characterization.test.ts` — see
   * "stops writing SSE frames after client disconnect and persists only the
   * pre-disconnect text" and its companion "records nothing on the truncated
   * row that would mark it incomplete".
   *
   * The model-side half (post-disconnect text is dropped from the returned
   * response, not merely unsent) is pinned in stream-turn-model.test.ts.
   */

  /**
   * DEFECT 2 — malformed boolean tool input becomes a definite `false`.
   *
   * The tool parser correctly refuses to trust a non-boolean and leaves the
   * field `undefined`. But "the model sent garbage" is then indistinguishable
   * from "the model said nothing", so resolution backfills it from the legacy
   * micro-tag parser, whose absent-tag default is `false`. The turn therefore
   * asserts a definite negative that the model never expressed.
   */
  it('CHARACTERIZATION (known defect): malformed boolean tool input is backfilled to a definite false', async () => {
    (getModelCompletionWithTools as jest.Mock).mockResolvedValue({
      text: null,
      toolInvocations: [
        { name: SESSION_STATE_TOOL_NAME, input: { offerFeelHeardCheck: 'yes please' } },
      ],
    });
    (getSonnetStreamingResponse as jest.Mock).mockReturnValue(
      streamOf(t('Thanks for telling me that. It sounds like it landed hard for you.'))
    );

    const modelResult = await runStreamTurnModel(modelParams());
    // The parser refused the malformed value, as it should.
    expect(modelResult.metadata.offerFeelHeardCheck).toBeUndefined();

    const resolution = await resolveStreamTurn(resolutionParams(modelResult));

    // But by the time the turn is resolved it has become a definite `false`,
    // not "unknown" — the malformed-input signal is gone.
    expect(resolution.metadata.offerFeelHeardCheck).toBe(false);
  });

  // Same defect via a different malformed shape. This inspects the resolved
  // metadata object the controller goes on to serialize; it does not itself
  // exercise SSE emission.
  it('CHARACTERIZATION (known defect): a malformed object input is also backfilled to false', async () => {
    (getModelCompletionWithTools as jest.Mock).mockResolvedValue({
      text: null,
      toolInvocations: [
        { name: SESSION_STATE_TOOL_NAME, input: { offerReadyToShare: { nested: 'object' } } },
      ],
    });
    (getSonnetStreamingResponse as jest.Mock).mockReturnValue(
      streamOf(t('That makes sense, and I want to stay with it a moment longer.'))
    );

    const modelResult = await runStreamTurnModel(modelParams());
    const resolution = await resolveStreamTurn(resolutionParams(modelResult));

    // This is the object the controller serializes into the metadata /
    // text_complete / complete SSE frames.
    expect(resolution.metadata.offerReadyToShare).toBe(false);
  });
});
