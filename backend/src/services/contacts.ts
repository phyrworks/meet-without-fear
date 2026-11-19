/**
 * Who a user's partner is, and what they call them, without `relationship`
 * (work-k5fk.2, design note §2/§4).
 *
 *   - A session's partner is its other HUMAN participant (participant.kind =
 *     'human'; the AI and personas are modeled seats and never a partner).
 *     A NEW_PROCESS follow-up (tending startLinkedProcess) starts with the
 *     caller only: until someone else joins it, its partner is the other
 *     human of the session it continues (previous_session_id), so the
 *     follow-up shows the same person — only through sessions the caller is
 *     a participant of.
 *   - What the caller calls the partner is resolved at READ time, from the
 *     caller's own rows only (review round 1, Q1 — nothing is ever written
 *     into another user's row):
 *       1. the caller's own user_contact entry for them — authoritative even
 *          when its nickname is NULL (cleared: the display name shows);
 *       2. else (no entry) the invite name on the caller's own invitation they accepted
 *          (invitation.invitee_name, accepted_by_user_id = the partner);
 *       3. before the invitee joins, the invite name on the caller's latest
 *          invitation for the session (pendingInviteeNames);
 *     and the callers fall back to the partner's display name.
 *   - "Sessions with this person" is the sessions both are participants of;
 *     "a live session with this person" is a `live_session_pair` row, the
 *     key the database enforces (one live session per pair of humans).
 *
 * Every read here runs on the app connection under the caller's identity.
 */

import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { getPgConstraintViolation } from '../middleware/errors';
import { loadSessionParties } from './participant-resolver';

type Tx = Prisma.TransactionClient;

/** How far back a follow-up looks for the person it continues with (previous_session_id hops). */
const LINEAGE_HOPS = 5;

/** The other human of a session as the caller sees them. */
export interface SessionPartner {
  userId: string;
  firstName: string | null;
  name: string | null;
  /** What the caller calls them: their own user_contact nickname, else the invite name they accepted; or null. */
  nickname: string | null;
}

interface OtherHuman {
  userId: string;
  firstName: string | null;
  name: string | null;
}

/** The first other human participant of each session, by join order (present or left). */
async function otherHumans(sessionIds: string[], userId: string): Promise<Map<string, OtherHuman>> {
  const out = new Map<string, OtherHuman>();
  if (sessionIds.length === 0) return out;
  // A partner's "user" row is theirs under RLS: their name comes from app.session_parties (work-k5fk.10.7, review
  // F7) — the name the app calls them by, as firstName (first name, else the full name).
  const rows = (await loadSessionParties(sessionIds)).filter(r => r.kind === 'human' && r.userId !== userId);
  for (const r of rows) {
    if (out.has(r.sessionId)) continue;
    out.set(r.sessionId, { userId: r.userId, firstName: r.userName, name: r.userName });
  }
  return out;
}

/**
 * Each session's partner for `userId` with what the caller calls them. A
 * session with no other human takes the other human of the session it
 * continues (previous_session_id, up to LINEAGE_HOPS back); none at all maps
 * to null.
 */
export async function loadSessionPartners(
  sessionIds: string[],
  userId: string,
): Promise<Map<string, SessionPartner | null>> {
  const found = await otherHumans(sessionIds, userId);

  // F4: a follow-up with no other human yet continues its previous session's pair. Each pending session maps to
  // every requested session it stands for (two follow-ups of one session share an ancestor: review round 2, N1),
  // and the walk only enters an ancestor the caller is a participant of (a crafted previous_session_id must not
  // name a stranger's session's partner: N2).
  let pending = new Map<string, string[]>(sessionIds.filter(id => !found.has(id)).map(id => [id, [id]]));
  for (let hop = 0; hop < LINEAGE_HOPS && pending.size > 0; hop++) {
    const links = await prisma.session.findMany({
      where: { id: { in: [...pending.keys()] }, previousSessionId: { not: null } },
      select: { id: true, previousSessionId: true },
    });
    const next = new Map<string, string[]>();
    for (const l of links) {
      if (!l.previousSessionId) continue;
      next.set(l.previousSessionId, [...(next.get(l.previousSessionId) ?? []), ...(pending.get(l.id) ?? [])]);
    }
    if (next.size === 0) break;
    const mine = new Set(
      (
        await prisma.participant.findMany({
          where: { sessionId: { in: [...next.keys()] }, userId },
          select: { sessionId: true },
        })
      ).map(r => r.sessionId),
    );
    for (const ancestor of [...next.keys()]) if (!mine.has(ancestor)) next.delete(ancestor);
    const ancestors = await otherHumans([...next.keys()], userId);
    pending = new Map();
    for (const [ancestor, starts] of next) {
      const o = ancestors.get(ancestor);
      if (o) for (const start of starts) found.set(start, o);
      else pending.set(ancestor, starts);
    }
  }

  const names = await namesIGave(userId, [...new Set([...found.values()].map(o => o.userId))]);
  const out = new Map<string, SessionPartner | null>(sessionIds.map(id => [id, null]));
  for (const [sessionId, o] of found) out.set(sessionId, { ...o, nickname: names.get(o.userId) ?? null });
  return out;
}

/** One session's partner for `userId` (see loadSessionPartners). */
export async function loadSessionPartner(sessionId: string, userId: string): Promise<SessionPartner | null> {
  return (await loadSessionPartners([sessionId], userId)).get(sessionId) ?? null;
}

/**
 * The caller's own user_contact entries for these users: contact id → nickname, NULL included (a row whose
 * nickname was cleared is still the caller's answer, review round 2 N3).
 */
async function contactEntries(userId: string, contactUserIds: string[]): Promise<Map<string, string | null>> {
  if (contactUserIds.length === 0) return new Map();
  const rows = await prisma.userContact.findMany({
    where: { userId, contactUserId: { in: [...new Set(contactUserIds)] } },
    select: { contactUserId: true, nickname: true },
  });
  return new Map(rows.map(r => [r.contactUserId, r.nickname] as const));
}

/**
 * What the caller calls each of these users, from the caller's own rows: their user_contact entry if they have
 * one — authoritative even when its nickname is NULL (cleared: the callers then show the display name) — else
 * the invite name on the caller's latest invitation that user accepted. Users with no name are absent.
 */
export async function namesIGave(userId: string, otherUserIds: string[]): Promise<Map<string, string>> {
  if (otherUserIds.length === 0) return new Map();
  const entries = await contactEntries(userId, otherUserIds);
  const out = new Map<string, string>();
  for (const [id, nickname] of entries) if (nickname) out.set(id, nickname);
  const missing = otherUserIds.filter(id => !entries.has(id));
  if (missing.length > 0) {
    const accepted = await prisma.invitation.findMany({
      where: { invitedByParticipant: { userId }, acceptedByUserId: { in: missing }, inviteeName: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { acceptedByUserId: true, inviteeName: true },
    });
    for (const a of accepted) {
      if (a.acceptedByUserId && a.inviteeName && !out.has(a.acceptedByUserId))
        out.set(a.acceptedByUserId, a.inviteeName);
    }
  }
  return out;
}

/** What the caller calls one user (namesIGave), or null. */
export async function getNickname(userId: string, contactUserId: string): Promise<string | null> {
  return (await namesIGave(userId, [contactUserId])).get(contactUserId) ?? null;
}

/**
 * What the caller calls the partner of a session: the partner's name as
 * namesIGave resolves it, or — before the invitee joins — the invite name on
 * the caller's latest invitation for the session. Null when there is neither.
 */
export async function getNicknameForSessionPartner(sessionId: string, userId: string): Promise<string | null> {
  const partner = await loadSessionPartner(sessionId, userId);
  if (partner) return partner.nickname;
  return (await pendingInviteeNames([sessionId], userId)).get(sessionId) ?? null;
}

/** Set (or clear, with null) the caller's own nickname for a contact. */
export async function setNickname(
  userId: string,
  contactUserId: string,
  nickname: string | null,
  client: Tx | typeof prisma = prisma,
): Promise<string | null> {
  const row = await client.userContact.upsert({
    where: { userId_contactUserId: { userId, contactUserId } },
    create: { userId, contactUserId, nickname },
    update: { nickname },
    select: { nickname: true },
  });
  return row.nickname;
}

/** Do these two humans share any session (any status)? Modeled seats never count. */
export async function sharesASession(userId: string, otherUserId: string): Promise<boolean> {
  const n = await prisma.participant.count({
    where: {
      userId,
      kind: 'human',
      session: { participants: { some: { userId: otherUserId, kind: 'human' } } },
    },
  });
  return n > 0;
}

/**
 * The live session these two humans share, from `live_session_pair` (the
 * invite-time pre-check; the database refuses a second one at the second
 * human's join regardless).
 */
export async function findLiveSessionWith(
  userId: string,
  otherUserId: string,
): Promise<{ id: string; status: string; updatedAt: Date } | null> {
  const [userA, userB] = userId < otherUserId ? [userId, otherUserId] : [otherUserId, userId];
  const pair = await prisma.liveSessionPair.findUnique({
    where: { userA_userB: { userA, userB } },
    select: { session: { select: { id: true, status: true, updatedAt: true } } },
  });
  return pair?.session ?? null;
}

/** The friendly answer when the pair rule refuses a session. */
export const LIVE_SESSION_EXISTS_MESSAGE =
  'You already have a session in progress with this person. Finish or archive it before starting another.';

/**
 * Is this error the database's pair rule (unique_violation on
 * live_session_pair_pkey, raised through app.t_live_session_pair at the
 * second human's join)? Read from the SQLSTATE and the constraint identifier
 * only (getPgConstraintViolation); Prisma may name the key by its columns.
 */
export function isLiveSessionPairViolation(error: unknown): boolean {
  const v = getPgConstraintViolation(error);
  if (!v || v.kind !== 'unique' || !v.constraint) return false;
  return v.constraint === 'live_session_pair_pkey' || v.constraint === 'user_a, user_b';
}

/**
 * Before the invitee joins a session has no partner: the name the caller gave
 * them is the invite name on the caller's own latest invitation for the
 * session (invitation.invitee_name). Keyed by session id; only invitations
 * the caller sent.
 */
export async function pendingInviteeNames(sessionIds: string[], userId: string): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await prisma.invitation.findMany({
    where: { sessionId: { in: sessionIds }, invitedByParticipant: { userId } },
    orderBy: { createdAt: 'desc' },
    select: { sessionId: true, inviteeName: true },
  });
  const out = new Map<string, string>();
  for (const r of rows) if (r.inviteeName && !out.has(r.sessionId)) out.set(r.sessionId, r.inviteeName);
  return out;
}
