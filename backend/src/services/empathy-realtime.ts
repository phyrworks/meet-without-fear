/**
 * Stage 2 realtime nudges (TS-10, I1 / Ruling R36).
 *
 * Every Stage 2 event goes out on the SESSION channel, because that is the only
 * channel on which mobile handles these event names
 * (mobile/src/screens/UnifiedSessionScreen.tsx `onSessionEvent`; the user
 * channel handler in mobile/src/hooks/useRealtime.ts only refetches session
 * lists). Both participants' devices receive every session-channel message;
 * `forUserId` and `excludeUserId` are client-side filters, not delivery rules.
 * So a Stage 2 payload carries only what every channel member may read: the
 * envelope, ids, direction status. Never a status DTO (it holds the
 * recipient's own unrevealed round), shared or draft text, feedback, or a
 * private AI note.
 *
 * `pingStage2Refresh` is the content-free stand-in for a private payload: an
 * addressed `empathy.status_updated` with no `empathyStatus`, on which mobile
 * invalidates the addressed user's empathy status and Stage 2 messages and
 * refetches them over the authenticated API.
 */
import { publishSessionEvent } from './realtime';

export async function pingStage2Refresh(sessionId: string, userId: string): Promise<void> {
  await publishSessionEvent(sessionId, 'empathy.status_updated', { stage: 2, forUserId: userId });
}
