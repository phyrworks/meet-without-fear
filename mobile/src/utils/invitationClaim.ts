/**
 * What the inviter is told about who opened their invitation (work-k5fk.35 C13). The first signed-in person to
 * open an invitation claims it: only they can accept or decline it (work-k5fk.10.8). The session state carries
 * the claimant to the inviter only (invitation.claimedBy), while the invitation is PENDING or DECLINED.
 */
import type { InvitationClaimantDTO } from '@meet-without-fear/shared';

export function invitationClaimDescription(
  invitation: { isInviter: boolean; status: string; claimedBy?: InvitationClaimantDTO } | null | undefined
): string | null {
  if (!invitation?.isInviter || !invitation.claimedBy) return null;
  const who = invitation.claimedBy.name || 'Someone';
  if (invitation.status === 'PENDING') {
    return `${who} opened your invitation. They haven't joined yet; only they can accept it now.`;
  }
  if (invitation.status === 'DECLINED') return `${who} opened your invitation and declined it.`;
  return null;
}
