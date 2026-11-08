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
 * "Focused" here means the session screen is focused AND the app is in the
 * foreground with its page visible (hooks/useAppForeground.ts).
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

/** At most this many requests per frame (first report + retries). */
export const MAX_REPORT_ATTEMPTS = 3;

export interface SharedFrameViewTracker {
  /**
   * Of `ids`, those to report now; marks them in flight. A frame whose last
   * report failed retryably is only returned when `retry` is set (the screen
   * just regained focus / the app returned to the foreground), so a failing
   * frame never re-posts on every scroll.
   */
  take(sessionId: string, ids: string[], opts?: { retry?: boolean }): string[];
  /**
   * A report failed. Retryable (5xx / network) and under MAX_REPORT_ATTEMPTS:
   * retried on the next focus / foreground. Otherwise (4xx: the server will
   * keep refusing it) done for good.
   */
  fail(sessionId: string, id: string, retryable: boolean): void;
}

type FrameReport = { state: 'reported' | 'retry' | 'done'; attempts: number };

export function createSharedFrameViewTracker(): SharedFrameViewTracker {
  const reports = new Map<string, FrameReport>();
  const key = (sessionId: string, id: string) => `${sessionId}:${id}`;
  return {
    take(sessionId, ids, opts) {
      const fresh: string[] = [];
      for (const id of ids) {
        const k = key(sessionId, id);
        const report = reports.get(k);
        if (!report) {
          reports.set(k, { state: 'reported', attempts: 1 });
          fresh.push(id);
        } else if (report.state === 'retry' && opts?.retry) {
          reports.set(k, { state: 'reported', attempts: report.attempts + 1 });
          fresh.push(id);
        }
      }
      return fresh;
    },
    fail(sessionId, id, retryable) {
      const k = key(sessionId, id);
      const attempts = reports.get(k)?.attempts ?? 1;
      reports.set(k, { state: retryable && attempts < MAX_REPORT_ATTEMPTS ? 'retry' : 'done', attempts });
    },
  };
}

/**
 * Whether a failed report is worth retrying: network errors and 5xx are;
 * a 4xx (bad id, not the caller's frame) never will succeed.
 */
export function isRetryableReportError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== 'number' || status <= 0) return true;
  return status >= 500;
}

/** App-lifetime tracker: survives the chat list remounting within one app run. */
export const sharedFrameViewTracker = createSharedFrameViewTracker();

/**
 * The received shared frames among `viewable` to report now: none while the
 * screen is not focused or the app is not in the foreground (and none are
 * recorded then, so they report once it is). `retry` re-reports frames whose
 * last report failed retryably.
 */
export function newlyViewedSharedFrames(opts: {
  sessionId: string | undefined;
  currentUserId: string | null | undefined;
  isFocused: boolean;
  viewable: readonly { item: ViewableChatItem | null | undefined; isViewable: boolean }[];
  retry?: boolean;
  tracker?: SharedFrameViewTracker;
}): string[] {
  const { sessionId, currentUserId, isFocused, viewable, retry, tracker = sharedFrameViewTracker } = opts;
  if (!sessionId || !isFocused) return [];
  const ids = viewable
    .filter(v => v.isViewable)
    .map(v => receivedSharedFrameId(v.item, currentUserId))
    .filter((id): id is string => id !== null);
  return tracker.take(sessionId, ids, { retry });
}
