/**
 * Empathy Status Service
 *
 * Builds the EmpathyExchangeStatusResponse for a user in a session, for the
 * HTTP handler (GET /sessions/:id/empathy/status) and the Ably publishers.
 *
 * Target shape (TS-10; spec §1.2, §7):
 *   - `myAttempt` is the caller's own current round (they are its author);
 *   - `partnerAttempt` is the partner's latest round ABOUT the caller that has
 *     been revealed (`revealed_at` set) — never an unrevealed round;
 *   - the partner's waiting state (`partnerHasSubmittedEmpathy`,
 *     `partnerEmpathyHeldStatus`, `partnerEmpathySubmittedAt`) comes from
 *     `v_empathy_direction_status`, never from the partner's attempt row;
 *   - `myReconcilerResult` is null: the analysis of the caller's attempt is its
 *     subject's (reconciler_result is subject-only, P3 D8a; golden R6). The
 *     author's view of the analysis is the direction's status and the
 *     abstract `reconciler_guidance` (`refinementHint`).
 */

import { prisma } from '../lib/prisma';
import type { EmpathyAttemptDTO, EmpathyExchangeStatusResponse, SharedContentDeliveryStatus } from '@meet-without-fear/shared';
import { getSharedContextForGuesser, getSharedContentDeliveryStatus } from './reconciler';
import {
  currentAttempt,
  directionOf,
  directionStatuses,
  partyOf,
  revealedAttemptAbout,
  reviewOf,
  reviewVisibleToAuthor,
  sessionParties,
  type AttemptRow,
  type ReviewRow,
  type SessionParty,
} from './empathy-store';

const deliveryOf = (status: string): 'pending' | 'delivered' | 'seen' =>
  status === 'VALIDATED' ? 'seen' : status === 'REVEALED' ? 'delivered' : 'pending';

/** The DTO of an attempt (additive on the target: `attemptId`, `round`). */
export function attemptDTO(
  a: AttemptRow,
  author: SessionParty | undefined,
  review: ReviewRow | null,
  opts: { delivery?: boolean; statusVersion?: boolean } = {},
): EmpathyAttemptDTO {
  return {
    id: a.id,
    sourceUserId: author?.userId ?? '',
    content: a.content,
    sharedAt: a.submittedAt.toISOString(),
    consentRecordId: '',
    status: a.status as EmpathyAttemptDTO['status'],
    revealedAt: a.revealedAt?.toISOString() ?? null,
    // The author's own round carries no readable review before a send (m2):
    // VALIDATED is the verdict, and seen_at is stamped with it (validateEmpathy).
    validatedAt: review?.validated
      ? review.updatedAt.toISOString()
      : a.status === 'VALIDATED' && a.seenAt
        ? a.seenAt.toISOString()
        : null,
    revisionCount: a.round - 1,
    ...(opts.statusVersion ? { statusVersion: a.statusVersion } : {}),
    ...(opts.delivery ? { deliveryStatus: deliveryOf(a.status) } : {}),
    attemptId: a.id,
    round: a.round,
  };
}

/**
 * Build the full EmpathyExchangeStatusResponse for a user.
 */
export async function buildEmpathyExchangeStatus(sessionId: string, userId: string): Promise<EmpathyExchangeStatusResponse> {
  const parties = await sessionParties(sessionId);
  const me = partyOf(parties, { userId });
  if (!me) {
    throw new Error(`Session ${sessionId} not found or user ${userId} not a participant`);
  }
  const partner = parties.find(p => p.participantId !== me.participantId) ?? null;

  const [myAttempt, partnerAttempt, statuses] = await Promise.all([
    partner ? currentAttempt(me.participantId, partner.participantId) : Promise.resolve(null),
    partner ? revealedAttemptAbout(me.participantId, partner.participantId) : Promise.resolve(null),
    directionStatuses(sessionId),
  ]);
  const partnerDirection = partner ? directionOf(statuses, partner.participantId, me.participantId) : undefined;

  // The partner's review of MY attempt — visible to me only once sent;
  // my own review of the partner's revealed attempt.
  const [myAttemptReview, partnerAttemptReview] = await Promise.all([
    myAttempt && partner ? reviewVisibleToAuthor(myAttempt.id, partner.participantId) : Promise.resolve(null),
    partnerAttempt ? reviewOf(partnerAttempt.id, me.participantId) : Promise.resolve(null),
  ]);

  // The abstract guidance for my attempt (reconciler_guidance: author-visible).
  let refinementHint: EmpathyExchangeStatusResponse['refinementHint'] = null;
  if (myAttempt && (myAttempt.status === 'AWAITING_SHARING' || myAttempt.status === 'REFINING')) {
    const guidance = await prisma.reconcilerGuidance.findFirst({
      where: { authorParticipantId: me.participantId, result: { attemptId: myAttempt.id, supersededAt: null } },
      select: { areaHint: true, guidanceType: true, promptSeed: true },
    });
    if (guidance) refinementHint = guidance;
  }

  const readyForStage3 = myAttempt?.status === 'VALIDATED' && partnerAttempt?.status === 'VALIDATED';

  const partnerStage1Completed = partner
    ? (await prisma.participantMilestone.count({ where: { participantId: partner.participantId, milestoneKey: 'feel_heard' } })) > 0
    : false;

  const awaitingSharing = myAttempt?.status === 'AWAITING_SHARING';
  const hasNewSharedContext = myAttempt?.status === 'REFINING';

  let sharedContext: { content: string; sharedAt: string } | null = null;
  let messageCountSinceSharedContext = 0;
  const contextResult = await getSharedContextForGuesser(sessionId, userId);
  if (contextResult.hasSharedContext && contextResult.content && contextResult.sharedAt) {
    sharedContext = { content: contextResult.content, sharedAt: contextResult.sharedAt };
    if (me.mainConversationId) {
      messageCountSinceSharedContext = await prisma.message.count({
        where: {
          conversationId: me.mainConversationId,
          senderParticipantId: me.participantId,
          role: 'USER',
          kind: 'CHAT',
          createdAt: { gt: new Date(contextResult.sharedAt) },
        },
      });
    }
  }

  const deliveryStatusResult = await getSharedContentDeliveryStatus(sessionId, userId);
  const sharedContentDeliveryStatus = deliveryStatusResult.hasSharedContent ? deliveryStatusResult.deliveryStatus : null;
  const mySharedContext =
    deliveryStatusResult.hasSharedContent && deliveryStatusResult.sharedContent
      ? {
          content: deliveryStatusResult.sharedContent,
          sharedAt: deliveryStatusResult.sharedAt!,
          deliveryStatus: deliveryStatusResult.deliveryStatus,
        }
      : null;

  let hasUnviewedSharedContext = false;
  if (hasNewSharedContext && sharedContext !== null) {
    const readState = await prisma.conversationReadState.findUnique({
      where: { participantId: me.participantId },
      select: { lastViewedShareTabAt: true },
    });
    const sharedAtDate = new Date(sharedContext.sharedAt);
    hasUnviewedSharedContext = !readState?.lastViewedShareTabAt || readState.lastViewedShareTabAt < sharedAtDate;
  }

  return {
    myAttempt: myAttempt ? attemptDTO(myAttempt, me, myAttemptReview, { delivery: true }) : null,
    partnerAttempt: partnerAttempt && partner ? attemptDTO(partnerAttempt, partner, partnerAttemptReview) : null,
    partnerCompletedStage1: partnerStage1Completed,
    analyzing: false,
    awaitingSharing,
    hasNewSharedContext,
    hasUnviewedSharedContext,
    sharedContext,
    refinementHint,
    readyForStage3,
    messageCountSinceSharedContext,
    sharedContentDeliveryStatus: sharedContentDeliveryStatus as SharedContentDeliveryStatus | null,
    mySharedContext,
    mySharedAt: mySharedContext?.sharedAt ?? null,
    myReconcilerResult: null,
    partnerHasSubmittedEmpathy: !!partnerDirection,
    partnerEmpathyHeldStatus: (partnerDirection?.status as EmpathyExchangeStatusResponse['partnerEmpathyHeldStatus']) ?? null,
    partnerEmpathySubmittedAt: partnerDirection?.submittedAt.toISOString() ?? null,
  };
}

/**
 * Build empathy status for every participant user of a session.
 */
export async function buildEmpathyExchangeStatusForBothUsers(
  sessionId: string,
): Promise<{ [userId: string]: EmpathyExchangeStatusResponse }> {
  const parties = await sessionParties(sessionId);
  const result: { [userId: string]: EmpathyExchangeStatusResponse } = {};
  for (const p of parties) {
    if (p.userId) result[p.userId] = await buildEmpathyExchangeStatus(sessionId, p.userId);
  }
  return result;
}
