/**
 * The recipient's "I have seen this shared frame" instant (work-2doq).
 *
 * Content the partner sent across — a SHARED_CONTEXT ("Context from X") or a
 * VALIDATION_FEEDBACK ("Feedback from X") message delivered into the caller's
 * own conversation — is rendered inline in the recipient's chat. When that
 * frame is actually on screen, mobile posts
 * `POST /sessions/:id/shared-context-viewed { messageId }` and this module
 * advances `conversation_read_state.last_viewed_share_tab_at` (the column keeps
 * its Share-tab-era name; the Share tab no longer exists).
 *
 * Three reads derive from that one instant:
 *  - the sender's delivery line: `seen` once it reaches the offer's delivery
 *    (reconciler/sharing.ts getSharedContentDeliveryStatus);
 *  - the recipient's `hasUnviewedSharedContext` (empathy-status.ts);
 *  - the recipient's unviewed `context_received` actions (notifications.ts).
 *
 * Rules:
 *  - Only the recipient marks, and only their own view: the message must be in
 *    the caller's own conversation and sent by someone else. Anything else
 *    reads as not found (no existence oracle).
 *  - Keyed to the frame, not the clock: the instant covers the viewed frame
 *    and everything older, but never a newer delivered frame the caller has
 *    not been shown (capped 1 ms before the next one).
 *  - Monotonic and idempotent: a frame already covered writes nothing (and
 *    publishes nothing); the conditional update never moves the instant back.
 */

import { prisma } from '../lib/prisma';

/** Message kinds that render as a received shared frame and feed the derivations above. */
export const VIEWABLE_SHARED_KINDS = ['SHARED_CONTEXT', 'VALIDATION_FEEDBACK'] as const;

/**
 * The instant to record for viewing a frame delivered at `viewedAt`: now, but
 * never at or past the next newer delivered frame, and never before the viewed
 * frame itself (clock skew).
 */
export function sharedContextViewedInstant(opts: { now: Date; viewedAt: Date; nextAt: Date | null }): Date {
  const cap = opts.nextAt ? opts.nextAt.getTime() - 1 : opts.now.getTime();
  return new Date(Math.max(Math.min(opts.now.getTime(), cap), opts.viewedAt.getTime()));
}

export type MarkSharedContextViewedResult =
  | { status: 'not_found' }
  | { status: 'ok'; advanced: boolean; lastViewedShareTabAt: Date };

/**
 * Record that `participantId` saw the received shared frame `messageId`.
 * `advanced` is true only when the stored instant moved (the caller notifies
 * the sender only then).
 */
export async function markSharedContextViewed(
  participantId: string,
  messageId: string,
  now: Date = new Date(),
): Promise<MarkSharedContextViewedResult> {
  const message = await prisma.message.findFirst({
    where: {
      id: messageId,
      kind: { in: [...VIEWABLE_SHARED_KINDS] },
      conversation: { participantId },
      senderParticipantId: { not: participantId },
    },
    select: { createdAt: true, conversationId: true },
  });
  if (!message) return { status: 'not_found' };

  const existing = await prisma.conversationReadState.findUnique({
    where: { participantId },
    select: { lastViewedShareTabAt: true },
  });
  if (existing?.lastViewedShareTabAt && existing.lastViewedShareTabAt >= message.createdAt) {
    return { status: 'ok', advanced: false, lastViewedShareTabAt: existing.lastViewedShareTabAt };
  }

  const next = await prisma.message.findFirst({
    where: {
      conversationId: message.conversationId,
      kind: { in: [...VIEWABLE_SHARED_KINDS] },
      senderParticipantId: { not: participantId },
      createdAt: { gt: message.createdAt },
    },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  const instant = sharedContextViewedInstant({ now, viewedAt: message.createdAt, nextAt: next?.createdAt ?? null });

  // Conditional write: only while the stored instant does not yet cover this
  // frame, so a concurrent or older view can never move it back.
  const notCovered = { OR: [{ lastViewedShareTabAt: null }, { lastViewedShareTabAt: { lt: message.createdAt } }] };
  let { count } = await prisma.conversationReadState.updateMany({
    where: { participantId, ...notCovered },
    data: { lastViewedShareTabAt: instant, lastActiveAt: now },
  });
  if (count === 0 && !existing) {
    try {
      await prisma.conversationReadState.create({
        data: { participantId, lastViewedShareTabAt: instant, lastActiveAt: now },
      });
      count = 1;
    } catch {
      // Created concurrently (by this or another view): retry the conditional write.
      ({ count } = await prisma.conversationReadState.updateMany({
        where: { participantId, ...notCovered },
        data: { lastViewedShareTabAt: instant, lastActiveAt: now },
      }));
    }
  }

  const stored = await prisma.conversationReadState.findUnique({
    where: { participantId },
    select: { lastViewedShareTabAt: true },
  });
  return { status: 'ok', advanced: count > 0, lastViewedShareTabAt: stored?.lastViewedShareTabAt ?? instant };
}
