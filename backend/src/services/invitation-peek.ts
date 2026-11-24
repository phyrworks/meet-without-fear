/**
 * The invitee's side of an invitation (work-k5fk.10.7, design note §6 invitation).
 *
 * Before accepting, the invitee is no participant: under row-level security they see neither the
 * invitation nor its session nor the inviter's participant row. The link's id is the credential, so
 * the database answers through two definers, both identity-bound:
 *
 *   - `app.invitation_peek(id)`: status, expiry, the inviter's display name, the invitee name,
 *     whether the session is ready to join and who claimed it — never the session's content. Once
 *     claimed, a caller who is neither the claimer nor the inviter gets the claim notice only
 *     (`withheld`; work-k5fk.10.8);
 *   - `app.invitation_claim(id)`: the first signed-in non-inviter to open it becomes its invitee
 *     (work-k5fk.10.8: first opener claims); anyone else is refused with MWI01;
 *   - `app.invitation_answer(id, answer, instant, reason)`: ACCEPTED / DECLINED / EXPIRED, the
 *     inviter's row written for the invitee (it locks the row FOR UPDATE first — the accept's lock,
 *     work-99k2).
 */
import { prisma } from '../lib/prisma';
import { decryptColumnValue, encryptColumnValue } from '../lib/prisma-encryption-middleware';
import type { Prisma } from '../generated/prisma/client';

export type InvitationStatusValue = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';

/** Everything a caller may see of an invitation someone else claimed: the claim notice. */
export interface InvitationClaimNotice {
  id: string;
  status: InvitationStatusValue;
  expiresAt: Date;
  createdAt: Date;
  withheld: true;
}

export interface InvitationPeek {
  id: string;
  sessionId: string;
  invitedByUserId: string;
  inviterDisplayName: string | null;
  inviteeName: string | null;
  status: InvitationStatusValue;
  acceptedByUserId: string | null;
  messageConfirmedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  sessionStatus: string;
  /** The session's topic frame is set and confirmed (never its text). */
  topicFrameConfirmed: boolean;
  /** Who opened it first and so is its invitee (work-k5fk.10.8), with their name and when; null until then. */
  claimedBy: { userId: string; name: string | null; claimedAt: Date } | null;
  withheld: false;
}

/** The SQLSTATE app.invitation_claim / app.invitation_answer raise for an invitation someone else claimed. */
export const INVITATION_CLAIMED_SQLSTATE = 'MWI01';
export const INVITATION_CLAIMED_MESSAGE = 'This invitation has already been opened by someone else';

/**
 * The SQLSTATE the seat cap raises (work-k5fk.10.38: two humans per session, for now — app.session_human_limit):
 * the t_human_limit triggers refuse an invitation beyond the seats left (invitation) and a third human’s seat (participant).
 */
export const SESSION_FULL_SQLSTATE = 'MWS01';
export const SESSION_FULL_MESSAGE = 'This session has no room for anyone else';

/** A claim notice rather than the invitation (claimed by someone other than the caller and the inviter). */
export function isClaimNotice(p: InvitationPeek | InvitationClaimNotice): p is InvitationClaimNotice {
  return p.withheld;
}

type Raw = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** The invitation as the caller (participant or not) may see it, or null when there is none. */
export async function peekInvitation(
  id: string,
  client: Raw = prisma,
): Promise<InvitationPeek | InvitationClaimNotice | null> {
  const rows = await client.$queryRaw<
    Array<{
      id: string;
      session_id: string;
      invited_by_user_id: string;
      inviter_display_name: string | null;
      invitee_name: string | null;
      status: InvitationStatusValue;
      accepted_by_user_id: string | null;
      message_confirmed_at: Date | null;
      expires_at: Date;
      created_at: Date;
      session_status: string;
      topic_frame_confirmed: boolean;
      withheld: boolean;
      claimed_by_user_id: string | null;
      claimed_by_name: string | null;
      claimed_at: Date | null;
    }>
  >`SELECT id, session_id, invited_by_user_id, inviter_display_name, invitee_name, status::text AS status,
           accepted_by_user_id, message_confirmed_at, expires_at, created_at, session_status::text AS session_status,
           topic_frame_confirmed, withheld, claimed_by_user_id, claimed_by_name, claimed_at
    FROM app.invitation_peek(${id}::uuid)`;
  const r = rows[0];
  if (!r) return null;
  if (r.withheld) {
    return { id: r.id, status: r.status, expiresAt: r.expires_at, createdAt: r.created_at, withheld: true };
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    invitedByUserId: r.invited_by_user_id,
    inviterDisplayName: r.inviter_display_name,
    inviteeName: r.invitee_name === null ? null : decryptColumnValue('invitation', 'invitee_name', r.invitee_name),
    status: r.status,
    acceptedByUserId: r.accepted_by_user_id,
    messageConfirmedAt: r.message_confirmed_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    sessionStatus: r.session_status,
    topicFrameConfirmed: r.topic_frame_confirmed,
    claimedBy:
      r.claimed_by_user_id && r.claimed_at
        ? { userId: r.claimed_by_user_id, name: r.claimed_by_name, claimedAt: r.claimed_at }
        : null,
    withheld: false,
  };
}

/**
 * The caller claims the invitation as its invitee (work-k5fk.10.8: first opener claims). The
 * database refuses the inviter (P0002), someone else's claim (MWI01), and a non-PENDING or expired
 * invitation (check_violation); the claimer opening it again is a no-op. Returns claimed_at.
 */
export async function claimInvitation(id: string, client: Raw = prisma): Promise<Date> {
  const [row] = await client.$queryRaw<Array<{ claimed_at: Date }>>`
    SELECT app.invitation_claim(${id}::uuid) AS claimed_at`;
  return row.claimed_at;
}

/** The caller's answer to a PENDING invitation (the database refuses the inviter, a non-PENDING row and a wrong expiry). */
export async function answerInvitation(
  client: Pick<Prisma.TransactionClient, '$executeRaw'>,
  id: string,
  answer: 'ACCEPTED' | 'DECLINED' | 'EXPIRED',
  at: Date,
  reason?: string | null,
): Promise<void> {
  const sealed = reason == null ? null : encryptColumnValue('invitation', 'decline_reason', reason);
  await client.$executeRaw`SELECT app.invitation_answer(${id}::uuid, ${answer}::invitation_status, ${at}::timestamptz, ${sealed}::text)`;
}

/** Who claimed an invitation, as the inviter's views carry it (shared InvitationClaimantDTO). */
export interface InvitationClaimant {
  id: string;
  name: string | null;
  claimedAt: string;
}

/**
 * The inviter's view of who opened their invitation first and so is its invitee (work-k5fk.10.8),
 * while that person is not seated (PENDING, DECLINED; once accepted they are the partner). The
 * claimer is no participant, so the name comes through app.invitation_peek (read now, never
 * stored). Null for anyone but the inviter, for an accepted or expired one, and until it is claimed.
 */
export async function invitationClaimantFor(
  invitation: { id: string; invitedByUserId: string; status: string },
  viewerUserId: string,
): Promise<InvitationClaimant | null> {
  if (invitation.invitedByUserId !== viewerUserId) return null;
  if (invitation.status !== 'PENDING' && invitation.status !== 'DECLINED') return null;
  const invitationId = invitation.id;
  const peek = await peekInvitation(invitationId);
  if (!peek || isClaimNotice(peek) || !peek.claimedBy) return null;
  return { id: peek.claimedBy.userId, name: peek.claimedBy.name, claimedAt: peek.claimedBy.claimedAt.toISOString() };
}
