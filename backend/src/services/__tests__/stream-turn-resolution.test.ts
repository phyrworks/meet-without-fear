/**
 * Unit tests for `resolveStreamTurn` — post-stream state resolution.
 *
 * These pin the merge precedence between the two structured-state channels
 * (tool calls captured during the stream vs. the legacy hidden-tag fallback),
 * the Stage 4 clarification guard, dispatch replacement, and the
 * empty-response guard that turns a content-less turn into a failure rather
 * than a saved message.
 */

import { resolveStreamTurn } from '../stream-turn-resolution';
import { handleDispatch } from '../dispatch-handler';
import type { CapturedHiddenTags } from '../stream-tag-sanitizer';
import type { SessionStateToolInput } from '../stage-tools';

jest.mock('../dispatch-handler', () => ({
  handleDispatch: jest.fn().mockResolvedValue(null),
}));

/**
 * The `<need>` block carries JSON — `parseNeedBlock` JSON.parses it and
 * returns null for free prose. Tests that feed it prose pass vacuously, because
 * the fallback contributes nothing for the stage guard to gate.
 */
const NEED_TAG_JSON = JSON.stringify({
  need: 'from tag',
  category: 'CONNECTION',
  description: 'wants acknowledgement',
  evidence: [],
});

function captured(overrides: Partial<CapturedHiddenTags> = {}): CapturedHiddenTags {
  return {
    thinking: '',
    draft: '',
    need: '',
    needAction: '',
    needs: '',
    stage4Proposals: '',
    stage4Walkthrough: '',
    dispatch: '',
    ...overrides,
  };
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    currentStage: 1,
    isInvitationPhase: false,
    content: 'user said this',
    history: [{ role: 'USER', content: 'earlier' }],
    userName: 'Ann',
    partnerName: 'Bo',
    session: { status: 'ACTIVE' },
    accumulatedText: 'Here is the visible response.',
    metadata: {} as SessionStateToolInput,
    captured: captured(),
    emitVisibleChunk: jest.fn(),
    ...overrides,
  } as any;
}

describe('stream-turn-resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (handleDispatch as jest.Mock).mockResolvedValue(null);
  });

  describe('structured tool state wins over the legacy tag fallback', () => {
    it('keeps a tool-captured boolean instead of backfilling from tags', async () => {
      const result = await resolveStreamTurn(
        params({
          metadata: { offerFeelHeardCheck: true },
          captured: captured({ thinking: 'FeelHeardCheck:N' }),
        }),
      );

      expect(result.metadata.offerFeelHeardCheck).toBe(true);
    });

    it('backfills booleans from the thinking block only when the tool left them undefined', async () => {
      const result = await resolveStreamTurn(
        params({ metadata: {}, captured: captured({ thinking: 'FeelHeardCheck:Y ReadyShare:Y' }) }),
      );

      expect(result.metadata.offerFeelHeardCheck).toBe(true);
      expect(result.metadata.offerReadyToShare).toBe(true);
    });

    // POSITIVE CONTROL for the precedence test below. Without this, a <need>
    // tag that never parses would make the precedence test pass for the wrong
    // reason (nothing to overwrite rather than tool-wins).
    it('uses a Stage 3 need from the tag when the tool captured none', async () => {
      const result = await resolveStreamTurn(
        params({ currentStage: 3, metadata: {}, captured: captured({ need: NEED_TAG_JSON }) }),
      );

      expect(result.metadata.proposedNeed).toMatchObject({ need: 'from tag' });
    });

    it('does not let a Stage 3 tag overwrite a tool-captured need', async () => {
      const result = await resolveStreamTurn(
        params({
          currentStage: 3,
          metadata: { proposedNeed: { need: 'from tool', category: 'CONNECTION' } },
          // Identical, parseable input to the control above — so the only
          // difference is that the tool already captured a need.
          captured: captured({ need: NEED_TAG_JSON }),
        }),
      );

      expect(result.metadata.proposedNeed).toMatchObject({ need: 'from tool' });
    });
  });

  describe('stage scoping of the tag fallback', () => {
    // This pair is what pins the `currentStage === 3` guard: the SAME parseable
    // input is captured at Stage 3 and ignored at Stage 1. Either half alone
    // would pass with the guard deleted.
    it('captures a parseable <need> tag when the caller is in Stage 3', async () => {
      const result = await resolveStreamTurn(params({ currentStage: 3, captured: captured({ need: NEED_TAG_JSON }) }));

      expect(result.metadata.proposedNeed).toMatchObject({ need: 'from tag' });
    });

    it('ignores the same <need> tag when the caller is not in Stage 3', async () => {
      const result = await resolveStreamTurn(params({ currentStage: 1, captured: captured({ need: NEED_TAG_JSON }) }));

      expect(result.metadata.proposedNeed).toBeUndefined();
    });

    it('treats a <draft> as the empathy statement in Stage 2', async () => {
      const result = await resolveStreamTurn(
        params({ currentStage: 2, captured: captured({ draft: 'You felt dismissed.' }) }),
      );

      expect(result.metadata.proposedEmpathyStatement).toBe('You felt dismissed.');
      expect(result.metadata.topicFrame).toBeUndefined();
    });

    it('treats a <draft> as the topic frame in Stage 0', async () => {
      const result = await resolveStreamTurn(
        params({ currentStage: 0, captured: captured({ draft: '  chores and fairness  ' }) }),
      );

      expect(result.metadata.topicFrame).toBe('chores and fairness');
      expect(result.metadata.proposedEmpathyStatement).toBeUndefined();
    });

    it('treats a <draft> as the topic frame during the invitation phase at any stage', async () => {
      const result = await resolveStreamTurn(
        params({ currentStage: 1, isInvitationPhase: true, captured: captured({ draft: 'the trip' }) }),
      );

      expect(result.metadata.topicFrame).toBe('the trip');
    });
  });

  describe('Stage 4 clarification guard', () => {
    // COVERED is one of the three actions the parser can actually produce
    // (COVERED | SKIP | NONE); a fixture outside that set would pin a value
    // production can never emit.
    const walkthrough = { action: 'COVERED', needId: 'need-1' } as any;

    it('cancels a captured walkthrough action when the visible reply asks for clarification', async () => {
      const result = await resolveStreamTurn(
        params({
          currentStage: 4,
          metadata: { stage4WalkthroughAction: walkthrough, stage4Proposals: [{ description: 'x' }] },
          accumulatedText: 'Which of those did you mean?',
        }),
      );

      expect(result.metadata.stage4WalkthroughAction).toMatchObject({
        action: 'NONE',
        reason: 'visible_response_requested_clarification',
      });
      expect(result.metadata.stage4Proposals).toBeUndefined();
    });

    it('keeps the action when the visible reply is not a clarifying question', async () => {
      const result = await resolveStreamTurn(
        params({
          currentStage: 4,
          metadata: { stage4WalkthroughAction: walkthrough },
          accumulatedText: 'Got it, I have recorded that.',
        }),
      );

      expect(result.metadata.stage4WalkthroughAction).toMatchObject({ action: 'COVERED' });
    });

    it('does not apply the guard outside Stage 4', async () => {
      const result = await resolveStreamTurn(
        params({
          currentStage: 3,
          metadata: { stage4WalkthroughAction: walkthrough },
          accumulatedText: 'Which one did you mean?',
        }),
      );

      expect(result.metadata.stage4WalkthroughAction).toMatchObject({ action: 'COVERED' });
    });

    it('leaves an already-NONE action untouched', async () => {
      const result = await resolveStreamTurn(
        params({
          currentStage: 4,
          metadata: { stage4WalkthroughAction: { action: 'NONE' } as any },
          accumulatedText: 'Do you mean the weekly one?',
        }),
      );

      expect(result.metadata.stage4WalkthroughAction).toMatchObject({ action: 'NONE' });
      expect((result.metadata.stage4WalkthroughAction as any).reason).toBeUndefined();
    });
  });

  describe('dispatch handling', () => {
    it('replaces the visible response with the dispatched one and flags the turn', async () => {
      (handleDispatch as jest.Mock).mockResolvedValue('Dispatched answer.');
      const emitVisibleChunk = jest.fn();

      const result = await resolveStreamTurn(
        params({ captured: captured({ dispatch: 'SEND_INVITATION' }), emitVisibleChunk }),
      );

      expect(result.accumulatedText).toBe('Dispatched answer.');
      expect(result.isDispatchMessage).toBe(true);
      expect(emitVisibleChunk).toHaveBeenCalledWith('Dispatched answer.');
    });

    // Whether a given tag is "unknown" is handleDispatch's business, not this
    // service's; what is pinned here is the fallthrough when it declines.
    it('falls back to the streamed response when the dispatch handler declines the tag', async () => {
      (handleDispatch as jest.Mock).mockResolvedValue(null);
      const emitVisibleChunk = jest.fn();

      const result = await resolveStreamTurn(
        params({
          captured: captured({ dispatch: 'NOT_A_REAL_TAG' }),
          accumulatedText: 'Original streamed text.',
          emitVisibleChunk,
        }),
      );

      expect(result.accumulatedText).toBe('Original streamed text.');
      expect(result.isDispatchMessage).toBe(false);
      expect(emitVisibleChunk).not.toHaveBeenCalled();
    });

    it('passes session join state into the dispatch context', async () => {
      (handleDispatch as jest.Mock).mockResolvedValue('ok');

      await resolveStreamTurn(params({ captured: captured({ dispatch: 'X' }), session: { status: 'CREATED' } }));

      expect(handleDispatch).toHaveBeenCalledWith(
        'X',
        expect.objectContaining({ invitationSent: false, partnerJoined: false }),
      );
    });

    it('marks the invitation as sent and the partner joined for an ACTIVE session', async () => {
      (handleDispatch as jest.Mock).mockResolvedValue('ok');

      await resolveStreamTurn(params({ captured: captured({ dispatch: 'X' }), session: { status: 'ACTIVE' } }));

      expect(handleDispatch).toHaveBeenCalledWith(
        'X',
        expect.objectContaining({ invitationSent: true, partnerJoined: true }),
      );
    });

    it('does not call the dispatch handler when no tag was captured', async () => {
      await resolveStreamTurn(params());

      expect(handleDispatch).not.toHaveBeenCalled();
    });
  });

  describe('empty-response guard', () => {
    it('throws rather than resolving a turn with no visible text', async () => {
      await expect(resolveStreamTurn(params({ accumulatedText: '   ' }))).rejects.toThrow(
        'AI response was empty after tag stripping',
      );
    });

    it('throws when the response was only hidden tags', async () => {
      await expect(
        resolveStreamTurn(params({ accumulatedText: '', captured: captured({ thinking: 'planning' }) })),
      ).rejects.toThrow('AI response was empty after tag stripping');
    });

    it('sends nothing to the client when the turn fails the guard', async () => {
      const emitVisibleChunk = jest.fn();

      await expect(resolveStreamTurn(params({ accumulatedText: '', emitVisibleChunk }))).rejects.toThrow();

      expect(emitVisibleChunk).not.toHaveBeenCalled();
    });

    /**
     * Honest note on the failure path: the guard runs LAST, so metadata has
     * already been mutated by the time it throws. Nothing rolls that back.
     * It is harmless today only because the controller abandons the turn on a
     * throw and never persists or emits this object — a constraint worth
     * knowing before anyone reuses the metadata after a failed resolution.
     */
    it('leaves already-merged metadata mutations in place when the guard throws', async () => {
      const metadata: SessionStateToolInput = {};

      await expect(resolveStreamTurn(params({ accumulatedText: '', metadata }))).rejects.toThrow();

      expect(metadata.offerFeelHeardCheck).toBe(false);
    });
  });

  it('returns the same metadata object it was handed, so caller mutations stay visible', async () => {
    const metadata: SessionStateToolInput = {};
    const result = await resolveStreamTurn(params({ metadata }));

    expect(result.metadata).toBe(metadata);
  });

  it('scrubs planner prose out of the persisted visible text', async () => {
    const result = await resolveStreamTurn(
      params({ accumulatedText: 'I should ask about the weekend.\nWhat happened over the weekend?' }),
    );

    expect(result.accumulatedText).not.toMatch(/I should/);
    expect(result.accumulatedText).toContain('What happened over the weekend?');
  });
});
