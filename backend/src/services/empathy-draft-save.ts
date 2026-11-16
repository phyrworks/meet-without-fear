/**
 * The one writer of a participant's EMPATHY draft (work-99k2): the stage 2
 * save endpoint and the chat turn's ReadyShare autosave both come here, so the
 * pre-join rules live in one place.
 *
 *   - Subject: the present partner; else the caller's open invitation
 *     (openInvitationOf), read FOR SHARE in this transaction. An accept holds
 *     the invitation FOR UPDATE from its first statement until it commits, so
 *     a save either commits before the accept moves the drafts (the move then
 *     carries the newest text), or runs after it and sees ACCEPTED and the new
 *     participant (never an invitation-keyed orphan against an accepted
 *     invitation).
 *   - A pre-join draft awaiting its author's review (written before the
 *     partner joined, nothing submitted) is resolved ONLY by the author's
 *     explicit choice: a write without `resolvePreJoinReview` (an autosave of
 *     the AI's newest proposal) is skipped and leaves the draft as written.
 *     The draft row is held FOR UPDATE while that is decided.
 */

import { prisma, type DbClient } from '../lib/prisma';
import { openInvitationOf, upsertDraft, type DraftRow, type EmpathySubject } from './empathy-store';
import type { Seat } from './participant-resolver';

export type SaveEmpathyDraftResult =
  | { status: 'saved'; draft: DraftRow; subject: EmpathySubject }
  | { status: 'review_pending'; draft: DraftRow }
  | { status: 'no_subject' };

export async function saveEmpathyDraft(opts: {
  /** The draft's author. */
  seat: Seat;
  content: string;
  readyToShare?: boolean;
  /** The author's explicit review choice (Send as is / Edit first) — the only write that ends a pending review. */
  resolvePreJoinReview?: boolean;
}): Promise<SaveEmpathyDraftResult> {
  return prisma.$transaction(async tx => {
    const invitation = await openInvitationOf(opts.seat, tx, true);
    // After the lock: an accept that committed meanwhile is visible here.
    const partners = await livePartnersOf(tx, opts.seat);
    const partner = partners.length === 1 ? partners[0] : null;

    if (!partner) {
      if (!invitation || partners.length > 1) return { status: 'no_subject' };
      const subject = { invitationId: invitation.id };
      const draft = await upsertDraft(
        {
          seat: opts.seat,
          kind: 'EMPATHY',
          invitationId: invitation.id,
          content: opts.content,
          readyToShare: opts.readyToShare,
        },
        tx,
      );
      return { status: 'saved', draft, subject };
    }

    const pending = await lockPendingPreJoinDraft(tx, opts.seat, partner.user_id);
    if (pending.length && !opts.resolvePreJoinReview) {
      const kept = await tx.draft.findUniqueOrThrow({
        where: { id: pending[0].id },
        select: { id: true, content: true, readyToShare: true, version: true, updatedAt: true },
      });
      return { status: 'review_pending', draft: kept };
    }
    const subject = { aboutUserId: partner.user_id };
    const draft = await upsertDraft(
      {
        seat: opts.seat,
        kind: 'EMPATHY',
        aboutUserId: partner.user_id,
        content: opts.content,
        readyToShare: opts.readyToShare,
      },
      tx,
    );
    return { status: 'saved', draft, subject };
  });
}

/** The other human participants of the seat's session who have not left (their user ids). */
function livePartnersOf(tx: DbClient, seat: Seat): Promise<Array<{ user_id: string }>> {
  return tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT p.user_id FROM participant p
      WHERE p.session_id = ${seat.sessionId}::uuid
        AND p.user_id <> ${seat.userId}::uuid AND p.kind = 'human' AND p.left_at IS NULL`;
}

/**
 * The participant's pre-join draft about the partner `partnerUserId` (of the
 * same session) that still awaits its author's review (written before the
 * partner joined, nothing submitted), locked FOR UPDATE for the rest of the
 * transaction. Empty when none.
 */
function lockPendingPreJoinDraft(
  tx: DbClient,
  seat: Seat,
  partnerUserId: string,
): Promise<Array<{ id: string; updated_at: Date }>> {
  return tx.$queryRaw<Array<{ id: string; updated_at: Date }>>`
      SELECT d.id, d.updated_at FROM draft d
      WHERE d.session_id = ${seat.sessionId}::uuid AND d.user_id = ${seat.userId}::uuid AND d.kind = 'EMPATHY'
        AND d.about_user_id = ${partnerUserId}::uuid
        AND d.updated_at < (SELECT p.joined_at FROM participant p
                            WHERE p.session_id = ${seat.sessionId}::uuid AND p.user_id = ${partnerUserId}::uuid)
        AND NOT EXISTS (SELECT 1 FROM empathy_attempt a
                        WHERE a.session_id = ${seat.sessionId}::uuid
                          AND a.author_user_id = ${seat.userId}::uuid
                          AND a.subject_user_id = ${partnerUserId}::uuid)
      FOR UPDATE OF d`;
}

export type ResolvePreJoinReviewForEditResult =
  | {
      status: 'resolved';
      /** The draft after the resolving write (same text, not ready; written-at is now), reopenedAt set. */
      draft: DraftRow & { reopenedAt: Date };
      /** When the author had written it: the review's written-at, read before this write. */
      writtenAt: Date;
      /** The partner the draft is about (a participant of the author's session). */
      partnerUserId: string;
    }
  | { status: 'not_pending' };

/**
 * work-9309: the author's "Edit first". Ends a pending pre-join review by the
 * author's explicit choice — the same resolving write work-99k2's Edit first
 * made (the text as written, not ready to share) — and reports when the draft
 * had been written, so the AI's opener can name the day.
 *
 * Exactly one call resolves a given review: the pending draft is held FOR
 * UPDATE, so a concurrent second call waits, then finds the review ended (its
 * updated_at is now after the join) and reports `not_pending`. The same
 * transaction sets `reopened_at` (work-9309): the reopen is durable before any
 * opener is generated. The caller schedules the opener only on `resolved`.
 */
export async function resolvePreJoinReviewForEdit(seat: Seat): Promise<ResolvePreJoinReviewForEditResult> {
  return prisma.$transaction(async tx => {
    const partners = await livePartnersOf(tx, seat);
    if (partners.length !== 1) return { status: 'not_pending' };
    const partnerUserId = partners[0].user_id;

    const pending = await lockPendingPreJoinDraft(tx, seat, partnerUserId);
    if (!pending.length) return { status: 'not_pending' };

    const kept = await tx.draft.findUniqueOrThrow({ where: { id: pending[0].id }, select: { content: true } });
    const written = await upsertDraft(
      { seat, kind: 'EMPATHY', aboutUserId: partnerUserId, content: kept.content, readyToShare: false },
      tx,
    );
    // work-9309: the durable reopen marker, in the resolving transaction. The
    // next draft write (upsertDraft's DO UPDATE) clears it.
    const [marked] = await tx.$queryRaw<Array<{ reopened_at: Date }>>`
      UPDATE draft SET reopened_at = now() WHERE id = ${written.id}::uuid RETURNING reopened_at`;
    const draft = { ...written, reopenedAt: marked.reopened_at };
    return { status: 'resolved', draft, writtenAt: pending[0].updated_at, partnerUserId };
  });
}
