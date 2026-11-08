/**
 * work-2doq review: a backgrounded app / hidden tab never marks a frame seen;
 * returning to the foreground reports what is on screen and is the only time a
 * retryably-failed report is retried.
 */

import { act, renderHook } from '@testing-library/react-native';
import { MessageRole } from '@meet-without-fear/shared';
import { createSharedFrameViewTracker } from '../../lib/chat/sharedFrameViews';
import { useSharedFrameViewReporting } from '../useSharedFrameViewReporting';

const ME = 'user-me';
const SESSION = 'session-1';
const FRAME = {
  id: '019a5f3e-1c2d-7a00-8b00-000000000001',
  role: MessageRole.SHARED_CONTEXT,
  senderId: 'user-partner',
  sharedContentDirection: 'received',
  timestamp: '2026-11-07T12:00:00.000Z',
};

function setup(initiallyShown: boolean) {
  const report = jest.fn();
  const tracker = createSharedFrameViewTracker();
  const hook = renderHook(
    ({ isShown }: { isShown: boolean }) =>
      useSharedFrameViewReporting<typeof FRAME>({ sessionId: SESSION, currentUserId: ME, isShown, report, tracker }),
    { initialProps: { isShown: initiallyShown } },
  );
  return { report, tracker, hook };
}

describe('useSharedFrameViewReporting', () => {
  it('reports a frame on screen while shown, once', () => {
    const { report, hook } = setup(true);
    act(() => hook.result.current([FRAME]));
    act(() => hook.result.current([FRAME]));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ messageId: FRAME.id, timestamp: FRAME.timestamp });
  });

  it('never reports while the app is backgrounded / the tab hidden; reports on return', () => {
    const { report, hook } = setup(false);
    // The list keeps reporting viewability in the background (Android keeps JS alive).
    act(() => hook.result.current([FRAME]));
    act(() => hook.result.current([FRAME]));
    expect(report).not.toHaveBeenCalled();
    // Back to the foreground: what is on screen now is reported, without a new viewability event.
    hook.rerender({ isShown: true });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('a retryable failure is retried on the next return to the foreground, not on scroll', () => {
    const { report, tracker, hook } = setup(true);
    act(() => hook.result.current([FRAME]));
    expect(report).toHaveBeenCalledTimes(1);
    tracker.fail(SESSION, FRAME.id, true);
    act(() => hook.result.current([FRAME])); // scroll / re-render
    expect(report).toHaveBeenCalledTimes(1);
    hook.rerender({ isShown: false });
    hook.rerender({ isShown: true });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('a 4xx failure is never retried', () => {
    const { report, tracker, hook } = setup(true);
    act(() => hook.result.current([FRAME]));
    tracker.fail(SESSION, FRAME.id, false);
    hook.rerender({ isShown: false });
    hook.rerender({ isShown: true });
    act(() => hook.result.current([FRAME]));
    expect(report).toHaveBeenCalledTimes(1);
  });
});
