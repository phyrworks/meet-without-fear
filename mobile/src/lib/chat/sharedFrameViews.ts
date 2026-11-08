/**
 * "Seen" for shared context (work-2doq): which received shared frames have
 * just been shown on the recipient's screen and still need reporting.
 *
 * The chat list reports its viewable items (FlatList onViewableItemsChanged);
 * a received "Context from X" (SHARED_CONTEXT) or "Feedback from X"
 * (VALIDATION_FEEDBACK) frame that is viewable while the session screen is
 * focused is reported once per session + message: the server marks it viewed
 * (POST /sessions/:id/shared-context-viewed), which makes the sender's line
 * "✓ Seen" and clears the recipient's unviewed state. The server is
 * idempotent, so the de-duplication here only keeps the endpoint quiet on
 * scroll and re-render; it is not the source of truth for anything on screen.
 */

import { MessageRole, isUuidV7 } from '@meet-without-fear/shared';

const RECEIVED_FRAME_ROLES: ReadonlySet<string> = new Set([
  MessageRole.SHARED_CONTEXT,
  MessageRole.VALIDATION_FEEDBACK,
]);

/** A list item as the chat list reports it: messages carry these fields; other items do not. */
export interface ViewableChatItem {
  id?: unknown;
  role?: unknown;
  senderId?: unknown;
  sharedContentDirection?: unknown;
}

/**
 * The server message id of a received shared frame, or null. The current
 * user's own frame (sent, or synthesized locally, e.g. `my-shared-context-…`)
 * and anything without a server id never qualify.
 */
export function receivedSharedFrameId(
  item: ViewableChatItem | null | undefined,
  currentUserId: string | null | undefined,
): string | null {
  if (!item || typeof item.id !== 'string' || typeof item.role !== 'string') return null;
  if (!RECEIVED_FRAME_ROLES.has(item.role)) return null;
  if (item.sharedContentDirection === 'sent') return null;
  if (!currentUserId || item.senderId === currentUserId) return null;
  if (!isUuidV7(item.id)) return null;
  return item.id;
}

export interface SharedFrameViewTracker {
  /** Of `ids`, those not yet reported for `sessionId`; marks them reported. */
  take(sessionId: string, ids: string[]): string[];
  /** Forget a report (the request failed), so the next view retries it. */
  release(sessionId: string, id: string): void;
}

export function createSharedFrameViewTracker(): SharedFrameViewTracker {
  const reported = new Set<string>();
  const key = (sessionId: string, id: string) => `${sessionId}:${id}`;
  return {
    take(sessionId, ids) {
      const fresh: string[] = [];
      for (const id of ids) {
        const k = key(sessionId, id);
        if (reported.has(k)) continue;
        reported.add(k);
        fresh.push(id);
      }
      return fresh;
    },
    release(sessionId, id) {
      reported.delete(key(sessionId, id));
    },
  };
}

/** App-lifetime tracker: survives the chat list remounting within one app run. */
export const sharedFrameViewTracker = createSharedFrameViewTracker();

/**
 * The received shared frames among `viewable` to report now: none while the
 * screen is not focused (and none are recorded then, so they report once it is).
 */
export function newlyViewedSharedFrames(opts: {
  sessionId: string | undefined;
  currentUserId: string | null | undefined;
  isFocused: boolean;
  viewable: readonly { item: ViewableChatItem | null | undefined; isViewable: boolean }[];
  tracker?: SharedFrameViewTracker;
}): string[] {
  const { sessionId, currentUserId, isFocused, viewable, tracker = sharedFrameViewTracker } = opts;
  if (!sessionId || !isFocused) return [];
  const ids = viewable
    .filter(v => v.isViewable)
    .map(v => receivedSharedFrameId(v.item, currentUserId))
    .filter((id): id is string => id !== null);
  return tracker.take(sessionId, ids);
}
