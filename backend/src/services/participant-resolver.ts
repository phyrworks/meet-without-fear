/**
 * Participant resolution (TS-9, spec §6 "Identity & participant resolution").
 *
 * The target schema pivots on `participant`: one row per (session, user), and
 * every private row of the session hangs off it. A request resolves the
 * caller's participant ONCE (`requireSessionAccess` → `req.participant`, and
 * `participantId` on the request context); code below the route works from
 * that, never from a (sessionId, userId) pair again.
 *
 * Co-participants come from `v_co_participant` only — N-party-safe by
 * construction (one row per ordered pair). There are no A/B slots in this
 * module. `getPartnerParticipant` exists for the two-party paths that still
 * need "the other one"; it returns null rather than guess when the session
 * does not have exactly one other present human.
 */

import { prisma } from '../lib/prisma';

export interface ResolvedParticipant {
  id: string;
  sessionId: string;
  userId: string | null;
  kind: 'human' | 'modeled';
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  /** The participant's MAIN conversation — the audience of their chat. */
  mainConversationId: string | null;
}

export interface CoParticipant {
  participantId: string;
  userId: string | null;
  kind: 'human' | 'modeled';
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
}

const PARTICIPANT_SELECT = {
  id: true,
  sessionId: true,
  userId: true,
  kind: true,
  displayName: true,
  joinedAt: true,
  leftAt: true,
  conversations: { where: { kind: 'MAIN' as const }, select: { id: true } },
} as const;

type ParticipantRow = {
  id: string;
  sessionId: string;
  userId: string | null;
  kind: 'human' | 'modeled';
  displayName: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  conversations: Array<{ id: string }>;
};

function toResolved(row: ParticipantRow): ResolvedParticipant {
  return {
    id: row.id,
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

/** A participant by id (for code that was handed an id, e.g. a job). */
export async function getParticipant(participantId: string): Promise<ResolvedParticipant | null> {
  const row = (await prisma.participant.findUnique({
    where: { id: participantId },
    select: PARTICIPANT_SELECT,
  })) as ParticipantRow | null;
  return row ? toResolved(row) : null;
}

/**
 * Every other participant of the participant's session, through
 * `v_co_participant` (joined to `participant` for the user id and join order).
 */
export async function getCoParticipants(participantId: string): Promise<CoParticipant[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      participantId: string;
      userId: string | null;
      kind: 'human' | 'modeled';
      displayName: string | null;
      joinedAt: Date;
      leftAt: Date | null;
    }>
  >`
    SELECT v.co_participant_id AS "participantId", o.user_id AS "userId", v.co_kind::text AS kind,
           v.co_display_name AS "displayName", o.joined_at AS "joinedAt", v.co_left_at AS "leftAt"
    FROM v_co_participant v
    JOIN participant o ON o.id = v.co_participant_id
    WHERE v.participant_id = ${participantId}::uuid
    ORDER BY o.joined_at, o.id`;
  return rows;
}

/**
 * The one other present human participant — for the two-party paths that
 * still need "the partner". Null when there is none, or more than one.
 */
export async function getPartnerParticipant(participantId: string): Promise<CoParticipant | null> {
  const present = (await getCoParticipants(participantId)).filter(p => p.kind === 'human' && !p.leftAt);
  return present.length === 1 ? present[0] : null;
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
 * (owned by mwf_job, identity-bound), as the v_participant note in the
 * trailer says; its result shape is already that function's.
 */
export async function getCoParticipantPresence(coParticipantId: string): Promise<CoParticipantPresence> {
  const rows = await prisma.$queryRaw<
    Array<{ shows: boolean | null; last_viewed_at: Date | null; last_active_at: Date | null; last_turn_at: Date | null }>
  >`
    SELECT (up.doc -> 'privacy' ->> 'showActivityStatus')::boolean AS shows,
           r.last_viewed_at, r.last_active_at,
           (SELECT max(m.created_at) FROM message m
             WHERE m.sender_participant_id = p.id AND m.role = 'USER' AND m.kind = 'CHAT') AS last_turn_at
    FROM participant p
    LEFT JOIN conversation_read_state r ON r.participant_id = p.id
    LEFT JOIN user_preferences up ON up.user_id = p.user_id
    WHERE p.id = ${coParticipantId}::uuid`;
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
 * (session, user) pair. Resolves the caller's participant, then the partner
 * through `v_co_participant`. Null when the caller is not a participant or the
 * session has no single present partner.
 */
export async function getPartnerUserIdFor(sessionId: string, userId: string): Promise<string | null> {
  const me = await resolveParticipant(sessionId, userId);
  if (!me) return null;
  return (await getPartnerParticipant(me.id))?.userId ?? null;
}
