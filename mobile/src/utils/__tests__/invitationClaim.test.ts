/**
 * work-k5fk.35 C13: the inviter sees who opened (claimed) their invitation.
 */
import { invitationClaimDescription } from '../invitationClaim';

const claim = { id: 'u2', name: 'Darryl', claimedAt: '2026-11-25T10:00:00Z' };

describe('invitationClaimDescription', () => {
  it('the inviter of a pending invitation someone opened: names them', () => {
    expect(invitationClaimDescription({ isInviter: true, status: 'PENDING', claimedBy: claim })).toBe(
      "Darryl opened your invitation. They haven't joined yet; only they can accept it now."
    );
  });

  it('a claimer with no name: "Someone"', () => {
    expect(
      invitationClaimDescription({ isInviter: true, status: 'PENDING', claimedBy: { ...claim, name: null } })
    ).toMatch(/^Someone opened your invitation\./);
  });

  it('a declined invitation says who declined it', () => {
    expect(invitationClaimDescription({ isInviter: true, status: 'DECLINED', claimedBy: claim })).toBe(
      'Darryl opened your invitation and declined it.'
    );
  });

  it('nothing to say: not claimed, not the inviter, or already accepted', () => {
    expect(invitationClaimDescription({ isInviter: true, status: 'PENDING' })).toBeNull();
    expect(invitationClaimDescription({ isInviter: false, status: 'PENDING', claimedBy: claim })).toBeNull();
    expect(invitationClaimDescription({ isInviter: true, status: 'ACCEPTED', claimedBy: claim })).toBeNull();
    expect(invitationClaimDescription(null)).toBeNull();
  });
});
