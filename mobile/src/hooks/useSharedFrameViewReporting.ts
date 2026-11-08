/**
 * "Seen" for shared context (work-2doq): turn the chat list's viewable items
 * into shared-context-viewed reports.
 *
 * A received "Context from X" / "Feedback from X" frame is reported once when
 * it is on screen while `isShown` (session screen focused AND app in the
 * foreground with its page visible). The latest viewable items are kept, so a
 * frame already on screen when `isShown` turns true is reported then; that
 * moment is also the only time a retryably-failed report is retried (the
 * mutation hook records each outcome in sharedFrameViewTracker).
 */

import { useCallback, useEffect, useRef } from 'react';
import { newlyViewedSharedFrames, type SharedFrameViewTracker } from '../lib/chat/sharedFrameViews';
import type { MarkSharedContextViewedVariables } from './useSessions';

export function useSharedFrameViewReporting<T extends { id: string; timestamp?: string }>(opts: {
  sessionId: string | undefined;
  currentUserId: string | null | undefined;
  isShown: boolean;
  report: (variables: MarkSharedContextViewedVariables) => void;
  tracker?: SharedFrameViewTracker;
}): (items: T[]) => void {
  const { sessionId, currentUserId, isShown, report, tracker } = opts;
  const viewableRef = useRef<T[]>([]);
  const retryArmedRef = useRef(true);

  const onItemsViewed = useCallback(
    (items: T[]) => {
      viewableRef.current = items;
      if (!isShown) return;
      const retry = retryArmedRef.current;
      if (items.length > 0) retryArmedRef.current = false;
      const ids = newlyViewedSharedFrames({
        sessionId,
        currentUserId,
        isFocused: isShown,
        viewable: items.map((item) => ({ item, isViewable: true })),
        retry,
        tracker,
      });
      for (const id of ids) {
        const frame = items.find((item) => item.id === id);
        report({ messageId: id, timestamp: frame?.timestamp ?? new Date().toISOString() });
      }
    },
    [sessionId, currentUserId, isShown, report, tracker],
  );

  useEffect(() => {
    if (!isShown) return;
    retryArmedRef.current = true;
    onItemsViewed(viewableRef.current);
  }, [isShown, onItemsViewed]);

  return onItemsViewed;
}
