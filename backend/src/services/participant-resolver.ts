/**
 * Participant resolution (TS-9, spec §6 "Identity & participant resolution").
 *
 * The target schema pivots on `participant`: one row per (session, user) —
 * its key since work-k5fk.3 — and every private row of the session names it
 * by that pair. A request resolves the caller's participant ONCE
 * (`requireSessionAccess` → `req.participant`); code below the route passes
 * its `Seat` ({ sessionId, userId }) on.
 *
 * Co-participants come from `v_co_participant` only — N-party-safe by
 * construction (one row per ordered pair). There are no A/B slots in this
 * module. `getPartnerParticipant` exists for the two-party paths that still
 * need "the other one"; it returns null rather than guess when the session
 * does not have exactly one other present human.
 */

import { prisma } from '../lib/prisma';

/** A user's kind, which participant.kind pins (work-k5fk.3: human, the AI, or a persona). */
export type ParticipantKind = 'human' | 'ai' | 'persona';

/**
 * A participant: its key (session_id, user_id) since work-k5fk.3. Every child
 * row of a participant carries the pair (FOREIGN KEY (session_id, x_user_id)
 * REFERENCES participant), so this is what a writer passes and a reader filters by.
 */
export interface Seat {
  sessionId: string;
  userId: string;
}

export interface ResolvedParticipant extends Seat {
  kind: ParticipantKind;
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  /** The participant's MAIN conversation — the audience of their chat. */
  mainConversationId: string | null;
}

export interface CoParticipant {
  userId: string;
  kind: ParticipantKind;
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
}

/** The seat of a resolved participant (or of any row that carries one). */
export function seatOf(p: { sessionId: string; userId: string }): Seat {
  return { sessionId: p.sessionId, userId: p.userId };
}

/** Same seat? */
export function sameSeat(a: Seat, b: Seat): boolean {
  return a.sessionId === b.sessionId && a.userId === b.userId;
}

const PARTICIPANT_SELECT = {
  sessionId: true,
  userId: true,
  kind: true,
  displayName: true,
  joinedAt: true,
  leftAt: true,
  conversations: { where: { kind: 'MAIN' as const }, select: { id: true } },
} as const;

type ParticipantRow = {
  sessionId: string;
  userId: string;
  kind: ParticipantKind;
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  conversations: Array<{ id: string }>;
};

function toResolved(row: ParticipantRow): ResolvedParticipant {
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    kind: row.kind,
    displayName: row.displayName,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
    mainConversationId: row.conversations[0]?.id ?? null,
  };
}

/**
 * The caller's PRESENT participant in a session, or null if they have none —
 * a participant who left (`left_at` set) is not resolved. `includeLeft`
 * returns the row regardless (requireSessionAccess, which must refuse a
 * leaver rather than fall through to another rule).
 */
export async function resolveParticipant(
  sessionId: string,
  userId: string,
  opts: { includeLeft?: boolean } = {},
): Promise<ResolvedParticipant | null> {
  const row = (await prisma.participant.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
    select: PARTICIPANT_SELECT,
  })) as ParticipantRow | null;
  if (!row) return null;
  if (row.leftAt && !opts.includeLeft) return null;
  return toResolved(row);
}

/** A participant by its seat, present or not (for code that was handed a seat, e.g. a job). */
export async function getParticipant(seat: Seat): Promise<ResolvedParticipant | null> {
  return resolveParticipant(seat.sessionId, seat.userId, { includeLeft: true });
}

/** Every other participant of the participant's session, through `v_co_participant`, in join order. */
export async function getCoParticipants(seat: Seat): Promise<CoParticipant[]> {
  return prisma.$queryRaw<CoParticipant[]>`
    SELECT v.co_user_id AS "userId", v.co_kind::text AS kind, v.co_display_name AS "displayName",
           v.co_joined_at AS "joinedAt", v.co_left_at AS "leftAt"
    FROM v_co_participant v
    WHERE v.session_id = ${seat.sessionId}::uuid AND v.user_id = ${seat.userId}::uuid
    ORDER BY v.co_joined_at, v.co_user_id`;
}

/**
 * The one other present human participant — for the two-party paths that
 * still need "the partner". Null when there is none, or more than one.
 */
export async function getPartnerParticipant(seat: Seat): Promise<CoParticipant | null> {
  const present = (await getCoParticipants(seat)).filter(p => p.kind === 'human' && !p.leftAt);
  return present.length === 1 ? present[0] : null;
}

/**
 * TS-12 (R5): for READS only — the present partner, or else the one human
 * co-participant who has left (the tombstone after account deletion). What the
 * leaver shared stays readable to the partner (spec §7), and attributed to
 * them; writes keep requiring a present partner (getPartnerParticipant).
 */
export async function getCounterpartParticipant(seat: Seat): Promise<CoParticipant | null> {
  const humans = (await getCoParticipants(seat)).filter(p => p.kind === 'human');
  const present = humans.filter(p => !p.leftAt);
  if (present.length === 1) return present[0];
  if (present.length === 0 && humans.length === 1) return humans[0];
  return null;
}

export interface CoParticipantPresence {
  /** The co-participant's `privacy.showActivityStatus` (default true). */
  showsActivity: boolean;
  lastViewedAt: Date | null;
  lastActiveAt: Date | null;
  /** Their newest own chat turn (role USER, kind CHAT), anywhere they sent one. */
  lastTurnAt: Date | null;
}

/**
 * The presence facts the session view shows about a co-participant — the
 * ONE read of another participant's read state and turn times outside the
 * context builder, as one statement returning instants only (never content).
 * TS-16 NOTE: under owner-only RLS on conversation_read_state,
 * user_preferences and message this must become a SECURITY DEFINER function
 * (owned by mwf_definer, identity-bound), as the v_participant note in the
 * trailer says; its result shape is already that function's.
 */
export async function getCoParticipantPresence(co: Seat): Promise<CoParticipantPresence> {
  const rows = await prisma.$queryRaw<
    Array<{
      shows: boolean | null;
      last_viewed_at: Date | null;
      last_active_at: Date | null;
      last_turn_at: Date | null;
    }>
  >`
    SELECT (up.doc -> 'privacy' ->> 'showActivityStatus')::boolean AS shows,
           r.last_viewed_at, r.last_active_at,
           (SELECT max(m.created_at) FROM message m
             WHERE m.session_id = p.session_id AND m.sender_user_id = p.user_id
               AND m.role = 'USER' AND m.kind = 'CHAT') AS last_turn_at
    FROM participant p
    LEFT JOIN conversation_read_state r ON r.session_id = p.session_id AND r.user_id = p.user_id
    LEFT JOIN user_preferences up ON up.user_id = p.user_id
    WHERE p.session_id = ${co.sessionId}::uuid AND p.user_id = ${co.userId}::uuid`;
  const r = rows[0];
  return {
    showsActivity: r?.shows ?? true,
    lastViewedAt: r?.last_viewed_at ?? null,
    lastActiveAt: r?.last_active_at ?? null,
    lastTurnAt: r?.last_turn_at ?? null,
  };
}

/**
 * The partner's user id in a session, for callers that only hold a
 * (session, user) pair. Null when the caller is not a participant or the
 * session has no single present partner.
 */
export async function getPartnerUserIdFor(sessionId: string, userId: string): Promise<string | null> {
  const me = await resolveParticipant(sessionId, userId);
  if (!me) return null;
  return (await getPartnerParticipant(me))?.userId ?? null;
}
