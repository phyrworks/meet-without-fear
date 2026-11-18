/**
 * The invitee's side of an invitation (work-k5fk.10.7, design note §6 invitation).
 *
 * Before accepting, the invitee is no participant: under row-level security they see neither the
 * invitation nor its session nor the inviter's participant row. The link's id is the credential, so
 * the database answers through two definers, both identity-bound:
 *
 *   - `app.invitation_peek(id)`: status, expiry, the inviter's display name, the invitee name and
 *     whether the session is ready to join — never the session's content;
 *   - `app.invitation_answer(id, answer, instant, reason)`: ACCEPTED / DECLINED / EXPIRED, the
 *     inviter's row written for the invitee (it locks the row FOR UPDATE first — the accept's lock,
 *     work-99k2).
 */
import { prisma } from '../lib/prisma';
import { decryptColumnValue, encryptColumnValue } from '../lib/prisma-encryption-middleware';
import type { Prisma } from '../generated/prisma/client';

export type InvitationStatusValue = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';

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
}

type Raw = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** The invitation as the caller (participant or not) may see it, or null when there is none. */
export async function peekInvitation(id: string, client: Raw = prisma): Promise<InvitationPeek | null> {
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
    }>
  >`SELECT id, session_id, invited_by_user_id, inviter_display_name, invitee_name, status::text AS status,
           accepted_by_user_id, message_confirmed_at, expires_at, created_at, session_status::text AS session_status,
           topic_frame_confirmed
    FROM app.invitation_peek(${id}::uuid)`;
  const r = rows[0];
  if (!r) return null;
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
  };
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
