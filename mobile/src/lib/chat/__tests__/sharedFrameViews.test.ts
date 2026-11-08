import { MessageRole } from '@meet-without-fear/shared';
import {
  MAX_REPORT_ATTEMPTS,
  createSharedFrameViewTracker,
  isRetryableReportError,
  newlyViewedSharedFrames,
  receivedSharedFrameId,
} from '../sharedFrameViews';

const ME = 'user-me';
const PARTNER = 'user-partner';
const SESSION = 'session-1';
const CONTEXT_ID = '019a5f3e-1c2d-7a00-8b00-000000000001';
const FEEDBACK_ID = '019a5f3e-1c2d-7a00-8b00-000000000002';
const NEWER_CONTEXT_ID = '019a5f3e-1c2d-7a00-8b00-000000000003';

const received = (id = CONTEXT_ID, role: string = MessageRole.SHARED_CONTEXT) => ({
  id,
  role,
  senderId: PARTNER,
  sharedContentDirection: 'received',
});

describe('receivedSharedFrameId', () => {
  it("accepts the partner's Context / Feedback frame", () => {
    expect(receivedSharedFrameId(received(), ME)).toBe(CONTEXT_ID);
    expect(receivedSharedFrameId(received(FEEDBACK_ID, MessageRole.VALIDATION_FEEDBACK), ME)).toBe(FEEDBACK_ID);
  });

  it("never reports the sender's own frame", () => {
    expect(receivedSharedFrameId({ ...received(), senderId: ME }, ME)).toBeNull();
    expect(receivedSharedFrameId({ ...received(), sharedContentDirection: 'sent' }, ME)).toBeNull();
    // The sender's locally synthesized frame (UnifiedSessionScreen `my-shared-context-…`)
    expect(
      receivedSharedFrameId(
        { id: 'my-shared-context-2026-11-07T12:00:00.000Z', role: MessageRole.SHARED_CONTEXT, senderId: ME, sharedContentDirection: 'sent' },
        ME,
      ),
    ).toBeNull();
  });

  it('ignores other kinds, non-server ids and an unknown current user', () => {
    expect(receivedSharedFrameId({ ...received(), role: MessageRole.EMPATHY_STATEMENT }, ME)).toBeNull();
    expect(receivedSharedFrameId({ ...received(), role: MessageRole.AI }, ME)).toBeNull();
    expect(receivedSharedFrameId({ ...received(), id: 'context-shared-x' }, ME)).toBeNull();
    expect(receivedSharedFrameId({ type: 'indicator', id: `context-shared-${CONTEXT_ID}` } as never, ME)).toBeNull();
    expect(receivedSharedFrameId(received(), null)).toBeNull();
    expect(receivedSharedFrameId(null, ME)).toBeNull();
  });
});

describe('newlyViewedSharedFrames', () => {
  const run = (
    tracker: ReturnType<typeof createSharedFrameViewTracker>,
    viewable: { item: Record<string, unknown>; isViewable: boolean }[],
    isFocused = true,
    retry = false,
  ) => newlyViewedSharedFrames({ sessionId: SESSION, currentUserId: ME, isFocused, viewable, tracker, retry });

  it('fires once for a new shared context, not again on scroll or re-render', () => {
    const tracker = createSharedFrameViewTracker();
    expect(run(tracker, [{ item: received(), isViewable: true }])).toEqual([CONTEXT_ID]);
    expect(run(tracker, [{ item: received(), isViewable: true }])).toEqual([]);
    expect(run(tracker, [{ item: received(), isViewable: false }])).toEqual([]);
    expect(run(tracker, [{ item: received(), isViewable: true }])).toEqual([]);
  });

  it('fires again for a newer shared context', () => {
    const tracker = createSharedFrameViewTracker();
    expect(run(tracker, [{ item: received(), isViewable: true }])).toEqual([CONTEXT_ID]);
    expect(
      run(tracker, [
        { item: received(), isViewable: true },
        { item: received(NEWER_CONTEXT_ID), isViewable: true },
      ]),
    ).toEqual([NEWER_CONTEXT_ID]);
  });

  it("does not fire for the sender's own frame", () => {
    const tracker = createSharedFrameViewTracker();
    expect(run(tracker, [{ item: { ...received(), senderId: ME, sharedContentDirection: 'sent' }, isViewable: true }])).toEqual([]);
  });

  it('does not fire for a frame that is rendered but not viewable', () => {
    const tracker = createSharedFrameViewTracker();
    expect(run(tracker, [{ item: received(), isViewable: false }])).toEqual([]);
    expect(run(tracker, [{ item: received(), isViewable: true }])).toEqual([CONTEXT_ID]);
  });

  it('does not fire, nor record, while the screen is not focused', () => {
    const tracker = createSharedFrameViewTracker();
    expect(run(tracker, [{ item: received(), isViewable: true }], false)).toEqual([]);
    expect(run(tracker, [{ item: received(), isViewable: true }], true)).toEqual([CONTEXT_ID]);
  });

  it('a retryable failure (5xx / network) is retried on the next focus / foreground only, bounded', () => {
    const tracker = createSharedFrameViewTracker();
    const shown = [{ item: received(), isViewable: true }];
    expect(run(tracker, shown)).toEqual([CONTEXT_ID]);
    tracker.fail(SESSION, CONTEXT_ID, true);
    // Scrolling / re-rendering does not re-post a failed frame...
    expect(run(tracker, shown)).toEqual([]);
    expect(run(tracker, shown)).toEqual([]);
    // ...regaining focus / returning to the foreground does, up to MAX_REPORT_ATTEMPTS in all.
    for (let attempt = 2; attempt <= MAX_REPORT_ATTEMPTS; attempt++) {
      expect(run(tracker, shown, true, true)).toEqual([CONTEXT_ID]);
      expect(run(tracker, shown, true, true)).toEqual([]); // in flight: not doubled
      tracker.fail(SESSION, CONTEXT_ID, true);
    }
    expect(run(tracker, shown, true, true)).toEqual([]);
  });

  it('a 4xx failure is done for good, even on focus', () => {
    const tracker = createSharedFrameViewTracker();
    const shown = [{ item: received(), isViewable: true }];
    expect(run(tracker, shown)).toEqual([CONTEXT_ID]);
    tracker.fail(SESSION, CONTEXT_ID, false);
    expect(run(tracker, shown, true, true)).toEqual([]);
    expect(run(tracker, shown)).toEqual([]);
  });

  it('retry does not re-post a frame that was reported successfully', () => {
    const tracker = createSharedFrameViewTracker();
    const shown = [{ item: received(), isViewable: true }];
    expect(run(tracker, shown)).toEqual([CONTEXT_ID]);
    expect(run(tracker, shown, true, true)).toEqual([]);
  });

  it('keys by session', () => {
    const tracker = createSharedFrameViewTracker();
    expect(run(tracker, [{ item: received(), isViewable: true }])).toEqual([CONTEXT_ID]);
    expect(
      newlyViewedSharedFrames({
        sessionId: 'session-2',
        currentUserId: ME,
        isFocused: true,
        viewable: [{ item: received(), isViewable: true }],
        tracker,
      }),
    ).toEqual([CONTEXT_ID]);
  });
});

describe('isRetryableReportError', () => {
  it('retries network errors and 5xx, never 4xx', () => {
    expect(isRetryableReportError(new Error('Network request failed'))).toBe(true);
    expect(isRetryableReportError({ status: 0 })).toBe(true);
    expect(isRetryableReportError({ status: 500 })).toBe(true);
    expect(isRetryableReportError({ status: 503 })).toBe(true);
    expect(isRetryableReportError({ status: 400 })).toBe(false);
    expect(isRetryableReportError({ status: 404 })).toBe(false);
  });
});
