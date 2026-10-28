/**
 * Consent Controller
 *
 * Handles consent management operations:
 * - GET /sessions/:id/consent/pending - Get pending consent requests
 * - POST /sessions/:id/consent/decide - Grant or deny consent
 * - POST /sessions/:id/consent/revoke - Revoke previously granted consent
 * - GET /sessions/:id/consent/history - Get consent history
 *
 * Target shape (TS-10; spec §1.3 consent): a consent row names exactly one
 * target through its arc column (need_id | empathy_attempt_id | proposal_id |
 * share_offer_id | review_id); `target_kind` is generated from it and never
 * written. The decider is the target's owner (trigger T-consent-owner refuses
 * anything else with one fixed message); `decision` moves only NULL →
 * GRANTED | DENIED and GRANTED → REVOKED (T-consent-transitions). Every read
 * here is of the CALLER's own rows: there are no requester reads (spec §1.3
 * RLS "S mine(participant_id) only").
 *
 * The DTO keeps the old `contentType` values (ruling R32): NEED →
 * IDENTIFIED_NEED, EMPATHY_ATTEMPT → EMPATHY_DRAFT, PROPOSAL →
 * STRATEGY_PROPOSAL, plus the two target-only kinds SHARE_OFFER →
 * CONTEXT_SHARE_OFFER and REVIEW → EMPATHY_REVIEW. `targetId` is the arc id.
 */

import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { getJobPrisma, prisma } from '../lib/prisma';
import { encryptColumnValue } from '../lib/prisma-encryption-middleware';
import { reencryptForSession } from '../lib/share-moments';
import { ErrorCode, ConsentContentType } from '@meet-without-fear/shared';
import { notifyPartner } from '../services/realtime';
import { successResponse, errorResponse } from '../utils/response';
import { partyOf, sessionParties, type SessionParty } from '../services/empathy-store';

type ConsentTargetKind = 'NEED' | 'EMPATHY_ATTEMPT' | 'PROPOSAL' | 'SHARE_OFFER' | 'REVIEW';

/** target_kind → the DTO's ConsentContentType (ruling R32). */
export const CONTENT_TYPE_OF: Record<ConsentTargetKind, ConsentContentType> = {
  NEED: ConsentContentType.IDENTIFIED_NEED,
  EMPATHY_ATTEMPT: ConsentContentType.EMPATHY_DRAFT,
  PROPOSAL: ConsentContentType.STRATEGY_PROPOSAL,
  SHARE_OFFER: ConsentContentType.CONTEXT_SHARE_OFFER,
  REVIEW: ConsentContentType.EMPATHY_REVIEW,
};

interface ConsentRow {
  id: string;
  targetKind: ConsentTargetKind;
  needId: string | null;
  empathyAttemptId: string | null;
  proposalId: string | null;
  shareOfferId: string | null;
  reviewId: string | null;
  decision: 'GRANTED' | 'DENIED' | 'REVOKED' | null;
  decidedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const CONSENT_SELECT = {
  id: true,
  targetKind: true,
  needId: true,
  empathyAttemptId: true,
  proposalId: true,
  shareOfferId: true,
  reviewId: true,
  decision: true,
  decidedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/** The arc's target id. */
export function targetIdOf(
  r: Pick<ConsentRow, 'needId' | 'empathyAttemptId' | 'proposalId' | 'shareOfferId' | 'reviewId'>,
): string | null {
  return r.needId ?? r.empathyAttemptId ?? r.proposalId ?? r.shareOfferId ?? r.reviewId ?? null;
}

/** Kinds whose decision the co-participant learns of (they asked); a share-offer or review decision never notifies. */
const NOTIFIES_PARTNER: ReadonlySet<ConsentTargetKind> = new Set(['NEED', 'EMPATHY_ATTEMPT', 'PROPOSAL']);

async function consentCaller(
  req: Request,
  res: Response,
): Promise<{ me: SessionParty; parties: SessionParty[]; sessionId: string } | null> {
  const user = req.user;
  if (!user) {
    errorResponse(res, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
    return null;
  }
  const sessionId = req.params.id;
  const parties = await sessionParties(sessionId);
  const me = partyOf(parties, { participantId: req.participant?.id }) ?? partyOf(parties, { userId: user.id });
  if (!me) {
    errorResponse(res, ErrorCode.NOT_FOUND, 'Session not found', 404);
    return null;
  }
  return { me, parties, sessionId };
}

// ============================================================================
// Controllers
// ============================================================================

/**
 * Get pending consent requests — the caller's own undecided rows.
 * GET /sessions/:id/consent/pending
 */
export async function getPendingConsents(req: Request, res: Response): Promise<void> {
  try {
    const caller = await consentCaller(req, res);
    if (!caller) return;
    const pending = (await prisma.consent.findMany({
      where: { participantId: caller.me.participantId, decision: null },
      orderBy: { createdAt: 'desc' },
      select: CONSENT_SELECT,
    })) as ConsentRow[];

    successResponse(res, {
      pendingRequests: pending.map(r => ({
        id: r.id,
        contentType: CONTENT_TYPE_OF[r.targetKind],
        targetId: targetIdOf(r),
        createdAt: r.createdAt.toISOString(),
        metadata: null,
      })),
    });
  } catch (error) {
    logger.error('[getPendingConsents] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to get pending consents', 500);
  }
}

/**
 * Decide on a consent request (grant or deny) — the caller's own undecided row.
 * POST /sessions/:id/consent/decide
 *
 * A GRANTED need consent with the shared text shares the need through the
 * job's `app.need_share` (the only writer of need_share).
 */
export async function decideConsent(req: Request, res: Response): Promise<void> {
  try {
    const { consentRequestId, decision, editedContent } = req.body;
    if (!['GRANTED', 'DENIED'].includes(decision)) {
      errorResponse(res, ErrorCode.VALIDATION_ERROR, 'Decision must be GRANTED or DENIED', 400);
      return;
    }
    const caller = await consentCaller(req, res);
    if (!caller) return;
    const { me, parties, sessionId } = caller;

    const record = (await prisma.consent.findFirst({
      where: { id: consentRequestId, participantId: me.participantId, decision: null },
      select: CONSENT_SELECT,
    })) as ConsentRow | null;
    if (!record) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Consent request not found', 404);
      return;
    }

    const now = new Date();
    const updated = (await prisma.consent.update({
      where: { id: record.id },
      data: { decision: decision as 'GRANTED' | 'DENIED', decidedAt: now },
      select: CONSENT_SELECT,
    })) as ConsentRow;

    let sharedContent: {
      id: string;
      sourceUserId: string;
      transformedContent: string;
      consentedAt: string;
      consentActive: boolean;
    } | null = null;
    if (
      decision === 'GRANTED' &&
      record.targetKind === 'NEED' &&
      record.needId &&
      typeof editedContent === 'string' &&
      editedContent.trim()
    ) {
      // need_share.shared_text is written under the session key by the job
      // (ciphertext in; TS-13). Share moment (writer-principal rule): the hook
      // runs in the share's own job transaction; W13 re-encrypts here.
      await getJobPrisma().$transaction(async tx => {
        await tx.$queryRaw`SELECT app.need_share(${record.needId}::uuid, ${encryptColumnValue('need_share', 'shared_text', editedContent)})`;
        await reencryptForSession(
          { moment: 'need-share', sessionId, rows: [{ table: 'need_share', id: record.needId! }] },
          tx,
        );
      });
      sharedContent = {
        id: record.needId,
        sourceUserId: me.userId ?? '',
        transformedContent: editedContent,
        consentedAt: now.toISOString(),
        consentActive: true,
      };
    }

    if (decision === 'GRANTED' && NOTIFIES_PARTNER.has(record.targetKind)) {
      const partner = parties.find(p => p.participantId !== me.participantId);
      if (partner?.userId) {
        await notifyPartner(sessionId, partner.userId, 'partner.consent_granted', {
          contentType: CONTENT_TYPE_OF[record.targetKind],
          consentedAt: now.toISOString(),
        });
      }
    }

    successResponse(res, {
      recorded: true,
      consentRecord: {
        id: updated.id,
        contentType: CONTENT_TYPE_OF[updated.targetKind],
        decision: updated.decision,
        decidedAt: updated.decidedAt?.toISOString() ?? null,
        revokedAt: updated.revokedAt?.toISOString() ?? null,
      },
      sharedContent,
    });
  } catch (error) {
    logger.error('[decideConsent] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to record consent decision', 500);
  }
}

/**
 * Revoke previously granted consent — the caller's own GRANTED row.
 * POST /sessions/:id/consent/revoke
 *
 * A need's revocation is `app.need_revoke_share(need)`: the share's
 * revoked_at and the consent's REVOKED in one transaction (spec §1.4). Every
 * other kind: GRANTED → REVOKED with revoked_at (decided_at kept).
 */
export async function revokeConsent(req: Request, res: Response): Promise<void> {
  try {
    const { consentRecordId } = req.body;
    const caller = await consentCaller(req, res);
    if (!caller) return;
    const { me, parties, sessionId } = caller;

    const record = (await prisma.consent.findFirst({
      where: { id: consentRecordId, participantId: me.participantId, decision: 'GRANTED', revokedAt: null },
      select: CONSENT_SELECT,
    })) as ConsentRow | null;
    if (!record) {
      errorResponse(res, ErrorCode.NOT_FOUND, 'Granted consent record not found', 404);
      return;
    }

    let revokedAt = new Date();
    if (record.targetKind === 'NEED' && record.needId) {
      await prisma.$queryRaw`SELECT app.need_revoke_share(${record.needId}::uuid)`;
      const after = await prisma.consent.findUnique({ where: { id: record.id }, select: { revokedAt: true } });
      revokedAt = after?.revokedAt ?? revokedAt;
    } else {
      await prisma.consent.update({
        where: { id: record.id },
        data: { decision: 'REVOKED', revokedAt },
        select: { id: true },
      });
    }

    if (NOTIFIES_PARTNER.has(record.targetKind)) {
      const partner = parties.find(p => p.participantId !== me.participantId);
      if (partner?.userId) {
        await notifyPartner(sessionId, partner.userId, 'partner.consent_revoked', {
          contentType: CONTENT_TYPE_OF[record.targetKind],
          revokedAt: revokedAt.toISOString(),
        });
      }
    }

    successResponse(res, { revoked: true, revokedAt: revokedAt.toISOString() });
  } catch (error) {
    logger.error('[revokeConsent] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to revoke consent', 500);
  }
}

/**
 * Get consent history — the caller's own rows in this session.
 * GET /sessions/:id/consent/history
 */
export async function getConsentHistory(req: Request, res: Response): Promise<void> {
  try {
    const caller = await consentCaller(req, res);
    if (!caller) return;
    const records = (await prisma.consent.findMany({
      where: { participantId: caller.me.participantId },
      orderBy: { createdAt: 'desc' },
      select: CONSENT_SELECT,
    })) as ConsentRow[];

    successResponse(res, {
      records: records.map(r => ({
        id: r.id,
        contentType: CONTENT_TYPE_OF[r.targetKind],
        targetId: targetIdOf(r),
        decision: r.decision,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    logger.error('[getConsentHistory] Error:', error);
    errorResponse(res, ErrorCode.INTERNAL_ERROR, 'Failed to get consent history', 500);
  }
}
