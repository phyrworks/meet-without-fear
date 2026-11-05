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

import { prisma } from '../lib/prisma';
import { openInvitationOf, upsertDraft, type DraftRow, type EmpathySubject } from './empathy-store';

export type SaveEmpathyDraftResult =
  | { status: 'saved'; draft: DraftRow; subject: EmpathySubject }
  | { status: 'review_pending'; draft: DraftRow }
  | { status: 'no_subject' };

export async function saveEmpathyDraft(opts: {
  participantId: string;
  content: string;
  readyToShare?: boolean;
  /** The author's explicit review choice (Send as is / Edit first) — the only write that ends a pending review. */
  resolvePreJoinReview?: boolean;
}): Promise<SaveEmpathyDraftResult> {
  return prisma.$transaction(async tx => {
    const invitation = await openInvitationOf(opts.participantId, tx, true);
    // After the lock: an accept that committed meanwhile is visible here.
    const partners = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM participant p
      WHERE p.session_id = (SELECT session_id FROM participant WHERE id = ${opts.participantId}::uuid)
        AND p.id <> ${opts.participantId}::uuid AND p.kind = 'human' AND p.left_at IS NULL`;
    const partner = partners.length === 1 ? partners[0] : null;

    if (!partner) {
      if (!invitation || partners.length > 1) return { status: 'no_subject' };
      const subject = { invitationId: invitation.id };
      const draft = await upsertDraft(
        {
          participantId: opts.participantId,
          kind: 'EMPATHY',
          invitationId: invitation.id,
          content: opts.content,
          readyToShare: opts.readyToShare,
        },
        tx,
      );
      return { status: 'saved', draft, subject };
    }

    const pending = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT d.id FROM draft d
      WHERE d.participant_id = ${opts.participantId}::uuid AND d.kind = 'EMPATHY'
        AND d.about_participant_id = ${partner.id}::uuid
        AND d.updated_at < (SELECT p.joined_at FROM participant p WHERE p.id = ${partner.id}::uuid)
        AND NOT EXISTS (SELECT 1 FROM empathy_attempt a
                        WHERE a.author_participant_id = ${opts.participantId}::uuid
                          AND a.subject_participant_id = ${partner.id}::uuid)
      FOR UPDATE OF d`;
    if (pending.length && !opts.resolvePreJoinReview) {
      const kept = await tx.draft.findUniqueOrThrow({
        where: { id: pending[0].id },
        select: { id: true, content: true, readyToShare: true, version: true, updatedAt: true },
      });
      return { status: 'review_pending', draft: kept };
    }
    const subject = { aboutParticipantId: partner.id };
    const draft = await upsertDraft(
      {
        participantId: opts.participantId,
        kind: 'EMPATHY',
        aboutParticipantId: partner.id,
        content: opts.content,
        readyToShare: opts.readyToShare,
      },
      tx,
    );
    return { status: 'saved', draft, subject };
  });
}
