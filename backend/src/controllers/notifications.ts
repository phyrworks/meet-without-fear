/**
 * Notifications Controller
 *
 * Provides pending action items and badge counts for the activity menu.
 * - GET /sessions/:id/pending-actions - Get pending actions for a session
 * - GET /notifications/badge-count - Get aggregate badge count across sessions
 *
 * Target shape (TS-10): everything counted is the caller's own — their offers
 * (as subject), the partner's rounds REVEALED to them and not yet reviewed,
 * and delivered context in their own conversation. The "sent tab" count is
 * the caller's accepted offers whose delivery / seen change they have not
 * been shown: this endpoint is the notification path that surfaces them, so
 * it WRITES `delivery_notified_at` / `seen_notified_at` (job) for what it
 * counted — an update is counted once (review F4.2; spec §1.2
 * context_share_offer).
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { successResponse, errorResponse } from '../utils/response';
import { loadCurrentStages } from '../services/stage-shim';
import { partyOf, sessionParties } from '../services/empathy-store';
import type { Seat } from '../services/participant-resolver';
import { withMessageId } from '../services/message-store';

// ============================================================================
// Types
// ============================================================================

interface PendingAction {
  type: 'share_offer' | 'validate_empathy' | 'context_received';
  id: string;
  data: Record<string, unknown>;
}

const TERMINAL = new Set(['RESOLVED', 'ABANDONED', 'ARCHIVED']);

/** The caller's participant in one session, with its MAIN conversation. */
type Me = Seat & { mainConversationId: string | null };

/** Partner rounds revealed to `me` (latest revealed round per direction) that `me` has not reviewed. */
async function unreviewedRevealed(me: Me) {
  const rounds = await prisma.empathyAttempt.findMany({
    where: { sessionId: me.sessionId, subjectUserId: me.userId, status: 'REVEALED', revealedAt: { not: null } },
    select: {
      id: true,
      content: true,
      authorUserId: true,
      reviews: { where: { sessionId: me.sessionId, reviewerUserId: me.userId }, select: { id: true } },
    },
  });
  return rounds.filter(r => r.reviews.length === 0);
}

/** Delivered context in `me`'s own conversation not yet shown to them (services/shared-context-view.ts). */
async function unreadContext(me: Me) {
  if (!me.mainConversationId) return [];
  const readState = await prisma.conversationReadState.findUnique({
    where: { sessionId_userId: { sessionId: me.sessionId, userId: me.userId } },
    select: { lastViewedShareTabAt: true },
  });
  return prisma.message.findMany({
    where: {
      conversationId: me.mainConversationId,
      kind: 'SHARED_CONTEXT',
      senderUserId: { not: me.userId },
      ...(readState?.lastViewedShareTabAt ? { createdAt: { gt: readState.lastViewedShareTabAt } } : {}),
    },
    orderBy: { seq: 'desc' },
    select: { conversationId: true, seq: true, content: true, createdAt: true, senderUserId: true },
  }).then(rows => rows.map(withMessageId));
}

async function openOffers(me: Me) {
  return prisma.contextShareOffer.findMany({
    where: { sessionId: me.sessionId, subjectUserId: me.userId, status: { in: ['PENDING', 'OFFERED'] } },
    include: { result: true, attempt: { select: { authorUserId: true } } },
  });
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * Get pending actions for a session
 * GET /sessions/:id/pending-actions
 */
export async function getPendingActionsHandler(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }
    const { id: sessionId } = req.params;

    const [session, parties] = await Promise.all([
      prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } }),
      sessionParties(sessionId),
    ]);
    const party = partyOf(parties, { userId: user.id });
    if (!session || !party) {
      errorResponse(res, 'NOT_FOUND', 'Session not found', 404);
      return;
    }
    if (TERMINAL.has(session.status)) {
      successResponse(res, { actions: [], sentTabUpdates: 0 });
      return;
    }
    const me: Me = { sessionId, userId: party.userId, mainConversationId: party.mainConversationId };

    const actions: PendingAction[] = [];
    const userMaxStage = (await loadCurrentStages([me])).get(me)?.stage ?? 0;

    // 1. My open share offers (as subject) — actionable only in Stage 2.
    if (userMaxStage === 2) {
      for (const offer of await openOffers(me)) {
        actions.push({
          type: 'share_offer',
          id: offer.id,
          data: {
            guesserName: partyOf(parties, { userId: offer.attempt.authorUserId })?.name ?? null,
            suggestedContent: offer.suggestedContent,
            suggestedShareFocus: offer.result.suggestedShareFocus,
            action: offer.result.recommendedAction,
          },
        });
      }
    }

    // 2. The partner's rounds revealed to me, awaiting my review.
    for (const attempt of await unreviewedRevealed(me)) {
      actions.push({
        type: 'validate_empathy',
        id: attempt.id,
        data: { content: attempt.content, sourceUserId: attempt.authorUserId },
      });
    }

    // 3. Unread delivered context — only once I am past Stage 1.
    if (userMaxStage >= 2) {
      for (const msg of await unreadContext(me)) {
        actions.push({
          type: 'context_received',
          id: msg.id,
          data: {
            content: msg.content,
            senderId: msg.senderUserId ?? null,
            timestamp: msg.createdAt.toISOString(),
          },
        });
      }
    }

    // 4. Sent-tab updates: my accepted offers whose delivery / seen I have not
    // been shown. Counted, then stamped as notified (job) — this response is
    // the notification.
    const unnotified = await prisma.contextShareOffer.findMany({
      where: {
        sessionId,
        subjectUserId: me.userId,
        status: 'ACCEPTED',
        OR: [
          { deliveryStatus: 'DELIVERED', deliveryNotifiedAt: null },
          { deliveryStatus: 'SEEN', seenNotifiedAt: null },
        ],
      },
      select: { id: true, deliveryStatus: true },
    });
    const sentTabUpdates = unnotified.length;
    if (unnotified.length > 0) {
      const delivered = unnotified.filter(o => o.deliveryStatus === 'DELIVERED').map(o => o.id);
      const seen = unnotified.filter(o => o.deliveryStatus === 'SEEN').map(o => o.id);
      // The caller's own offers' notification stamps (app.share_offers_mark_notified; work-k5fk.10.5: was the job's).
      if (delivered.length) {
        await prisma.$executeRaw`SELECT app.share_offers_mark_notified(${delivered}::uuid[], false)`;
      }
      if (seen.length) {
        await prisma.$executeRaw`SELECT app.share_offers_mark_notified(${seen}::uuid[], true)`;
      }
    }

    successResponse(res, { actions, sentTabUpdates });
  } catch (error) {
    logger.error('[getPendingActionsHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get pending actions', 500);
  }
}

/**
 * Get badge count across all active sessions
 * GET /notifications/badge-count
 */
export async function getBadgeCountHandler(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      errorResponse(res, 'UNAUTHORIZED', 'Authentication required', 401);
      return;
    }

    // The caller's present participants in active sessions.
    const rows = await prisma.participant.findMany({
      where: { userId: user.id, leftAt: null, session: { status: { in: ['ACTIVE', 'INVITED'] } } },
      select: {
        sessionId: true,
        userId: true,
        conversations: { where: { kind: 'MAIN' }, select: { id: true } },
      },
    });
    const stages = await loadCurrentStages(rows.map(r => ({ sessionId: r.sessionId, userId: r.userId })));

    const bySession: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const me: Me = {
        sessionId: r.sessionId,
        userId: r.userId,
        mainConversationId: r.conversations[0]?.id ?? null,
      };
      const stage = stages.get(me)?.stage ?? 0;
      let count = 0;
      if (stage === 2) {
        count += await prisma.contextShareOffer.count({
          where: { sessionId: me.sessionId, subjectUserId: me.userId, status: { in: ['PENDING', 'OFFERED'] } },
        });
      }
      count += (await unreviewedRevealed(me)).length;
      if (stage >= 2) count += (await unreadContext(me)).length;
      if (count > 0) {
        bySession[r.sessionId] = count;
        total += count;
      }
    }

    successResponse(res, { count: total, bySession });
  } catch (error) {
    logger.error('[getBadgeCountHandler] Error:', error);
    errorResponse(res, 'INTERNAL_ERROR', 'Failed to get badge count', 500);
  }
}
