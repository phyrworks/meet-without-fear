/**
 * Who a user's partner is, and what they call them, without `relationship`
 * (work-k5fk.2, design note §2/§4).
 *
 *   - A session's partner is its other HUMAN participant (participant.kind =
 *     'human'; the AI and personas are modeled seats and never a partner).
 *     Before the invitee joins there is none.
 *   - A nickname is the caller's own `user_contact` row (user_id = caller):
 *     private to its owner, never read for anybody else.
 *   - "Sessions with this person" is the sessions both are participants of;
 *     "a live session with this person" is a `live_session_pair` row, the
 *     key the database enforces (one live session per pair of humans).
 *
 * Every read here runs on the app connection under the caller's identity.
 */

import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { getPgConstraintViolation } from '../middleware/errors';

type Tx = Prisma.TransactionClient;

/** The other human of a session as the caller sees them. */
export interface SessionPartner {
  userId: string;
  firstName: string | null;
  name: string | null;
  /** The caller's own nickname for them (user_contact), or null. */
  nickname: string | null;
}

/**
 * Each session's partner for `userId` (the first other human participant by
 * join order, present or left), with the caller's nickname for them. A
 * session with no other human maps to null.
 */
export async function loadSessionPartners(
  sessionIds: string[],
  userId: string,
): Promise<Map<string, SessionPartner | null>> {
  const out = new Map<string, SessionPartner | null>(sessionIds.map(id => [id, null]));
  if (sessionIds.length === 0) return out;
  const others = await prisma.participant.findMany({
    where: { sessionId: { in: sessionIds }, kind: 'human', userId: { not: userId } },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: { sessionId: true, userId: true, user: { select: { firstName: true, name: true } } },
  });
  const nicknames = await nicknamesFor(
    userId,
    others.flatMap(o => (o.userId ? [o.userId] : [])),
  );
  for (const o of others) {
    if (!o.userId || out.get(o.sessionId)) continue;
    out.set(o.sessionId, {
      userId: o.userId,
      firstName: o.user?.firstName ?? null,
      name: o.user?.name ?? null,
      nickname: nicknames.get(o.userId) ?? null,
    });
  }
  return out;
}

/** One session's partner for `userId` (see loadSessionPartners). */
export async function loadSessionPartner(sessionId: string, userId: string): Promise<SessionPartner | null> {
  return (await loadSessionPartners([sessionId], userId)).get(sessionId) ?? null;
}

/** The caller's nicknames for these users (user_contact rows owned by `userId`). */
export async function nicknamesFor(userId: string, contactUserIds: string[]): Promise<Map<string, string>> {
  if (contactUserIds.length === 0) return new Map();
  const rows = await prisma.userContact.findMany({
    where: { userId, contactUserId: { in: [...new Set(contactUserIds)] } },
    select: { contactUserId: true, nickname: true },
  });
  return new Map(rows.flatMap(r => (r.nickname ? [[r.contactUserId, r.nickname] as const] : [])));
}

/** The caller's nickname for one user, or null. */
export async function getNickname(userId: string, contactUserId: string): Promise<string | null> {
  return (await nicknamesFor(userId, [contactUserId])).get(contactUserId) ?? null;
}

/**
 * The caller's nickname for the partner of a session (another human
 * participant of it), in one statement; none before the invitee joins.
 */
export async function getNicknameForSessionPartner(sessionId: string, userId: string): Promise<string | null> {
  const row = await prisma.userContact.findFirst({
    where: {
      userId,
      nickname: { not: null },
      contact: { participants: { some: { sessionId, kind: 'human' } } },
    },
    select: { nickname: true },
  });
  return row?.nickname ?? null;
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

/**
 * Record an invite name as the owner's nickname for the contact unless the
 * owner already has an entry for them (an existing nickname is theirs to
 * change, through PATCH /contacts/:userId/nickname or a new invite name).
 */
export async function recordNicknameIfAbsent(
  client: Tx,
  userId: string,
  contactUserId: string,
  nickname: string | null | undefined,
): Promise<void> {
  const value = nickname?.trim();
  if (!value) return;
  await client.userContact.createMany({
    data: [{ userId, contactUserId, nickname: value.slice(0, 100) }],
    skipDuplicates: true,
  });
}

/** Do these two users share any session (any status)? */
export async function sharesASession(userId: string, otherUserId: string): Promise<boolean> {
  const n = await prisma.participant.count({
    where: { userId, session: { participants: { some: { userId: otherUserId } } } },
  });
  return n > 0;
}

/** Ids of the sessions `userId` and `otherUserId` are both participants of (newest first). */
export async function sharedSessionIds(
  userId: string,
  otherUserId: string,
  where: Prisma.SessionWhereInput = {},
): Promise<string[]> {
  const rows = await prisma.session.findMany({
    where: {
      AND: [{ participants: { some: { userId } } }, { participants: { some: { userId: otherUserId } } }, where],
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
  return rows.map(r => r.id);
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
