/**
 * Fixture reachability (work-2km7): a scenario must be a state the app can
 * reach. The rules are read off the controllers that write these rows:
 *
 *   - createSession (controllers/invitations.ts) writes ONE participant — the
 *     inviter, with a MAIN conversation and a read state — and a PENDING
 *     invitation. The invitee may already be a relationship member (the
 *     `personId` path), never a participant.
 *   - acceptInvitation (controllers/invitations.ts), and its E2E twin
 *     acceptPendingInvitationForE2ESession (controllers/session-state.ts), is
 *     the only writer of the invitee's participant (+ MAIN conversation, read
 *     state). In one transaction it marks the invitation ACCEPTED
 *     (accepted_at, accepted_by_user_id) and the session ACTIVE; afterwards it
 *     gives the inviter `invitation_sent` (reachInvitationSentOnAccept,
 *     work-qmgc). It writes no milestone, message or content for the invitee.
 *   - confirmInvitationMessage (controllers/sessions.ts) is the only other
 *     writer of `invitation_sent`, and writes `compact_signed` with it — so on
 *     a still-PENDING invitation the inviter has both.
 *   - saveDraft (controllers/stage2.ts) refuses an empathy draft before the
 *     partner joined.
 *
 * In scenario terms: the inviter (`participants[0]`) is always joined; the
 * others are joined exactly when the invitation was accepted. A participant
 * who has not joined is a user the writer creates (and makes a relationship
 * member) but writes NO participant, conversation or read state for, and must
 * carry nothing but its key.
 */

import type { ParticipantKey, ParticipantScenario, Scenario } from './scenario-model';

/** The participants who are in the session: the inviter, and the others once the invitation was accepted. */
export function joinedParticipants(s: Scenario): ParticipantScenario[] {
  return s.invitation.acceptedAt ? s.participants : s.participants.slice(0, 1);
}

/** Fields whose string values name a participant. */
const PARTICIPANT_REFS = new Set([
  'from',
  'to',
  'by',
  'guesser',
  'subject',
  'participant',
  'actor',
  'source',
  'closedBy',
  'agreedBy',
]);

/** Every participant key a piece of content names. */
function namedParticipants(value: unknown, out: Set<ParticipantKey>, field?: string): Set<ParticipantKey> {
  if (Array.isArray(value)) {
    for (const v of value) namedParticipants(v, out, field);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) namedParticipants(v, out, k);
  } else if (typeof value === 'string' && field && PARTICIPANT_REFS.has(field)) {
    out.add(value);
  }
  return out;
}

/** Why a scenario is a state the app cannot reach; empty when it can. */
export function reachabilityViolations(s: Scenario): string[] {
  const out: string[] = [];
  const [inviter, ...invitees] = s.participants;
  if (!inviter) return ['the scenario has no inviter'];
  const accepted = Boolean(s.invitation.acceptedAt);
  const joined = new Set(joinedParticipants(s).map(p => p.key));

  for (const p of invitees) {
    if (joined.has(p.key)) continue;
    const { key, milestones, ...rest } = p;
    void key;
    if (Object.keys(milestones).length || Object.keys(rest).length) {
      out.push(`participant "${p.key}" has progress or content but has not joined (the invitation is not ACCEPTED)`);
    }
  }

  if (inviter.empathy && joined.size < 2) {
    out.push(`participant "${inviter.key}" has an empathy attempt but nobody else has joined (saveDraft refuses it)`);
  }

  const { participants, ...sessionContent } = s;
  const named = namedParticipants(sessionContent, new Set());
  for (const p of participants) namedParticipants({ ...p, key: undefined }, named);
  for (const p of invitees) {
    if (!joined.has(p.key) && named.has(p.key))
      out.push(`participant "${p.key}" is named by content but has not joined`);
  }

  const sent = inviter.milestones.invitation_sent;
  if (accepted) {
    if (!invitees.length) out.push('the invitation is ACCEPTED but there is no invitee to have accepted it');
    if (!sent)
      out.push('the invitation is ACCEPTED but the inviter has no invitation_sent (acceptInvitation writes it)');
  } else if (sent && !inviter.milestones.compact_signed) {
    out.push(
      'the inviter reached invitation_sent on a PENDING invitation without compact_signed (confirmInvitationMessage writes both)',
    );
  }
  if ((sent || accepted) && !s.topic) {
    out.push('the invitation was sent but the session has no confirmed topic frame (confirmTopicFrame precedes it)');
  }
  return out;
}
