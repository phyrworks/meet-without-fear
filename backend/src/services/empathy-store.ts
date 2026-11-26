/**
 * Empathy rows on the target shape (TS-10; spec §1.2, §4, §7).
 *
 * The one module that reads and writes `empathy_attempt`, `empathy_review`,
 * the Stage 2 drafts and the direction status. Every other Stage 2 /
 * reconciler module goes through it, so the rules live in one place:
 *
 *   - An attempt is IMMUTABLE per round. A submission inserts round 1 (HELD);
 *     a resubmission is `app.empathy_set_status(attempt, 'SUPERSEDED', content)`,
 *     which retires round n and inserts round n+1 (HELD) in one transaction and
 *     returns its id (a retried call returns the same id). The app never
 *     UPDATEs `content` or `status`.
 *   - Every status move is `app.empathy_set_status` — the only writer, which
 *     enforces the transition table and its actors. The author's and the
 *     subject's own moves run on the APP connection under their identity
 *     (DB_IDENTITY_BINDING binds it to the statement); the reconciler's moves and
 *     the reveal run on the AI connection (`mwf_ai`, scoped to the session:
 *     app.session_scope), which is the only principal the function lets reveal
 *     (work-k5fk.10.5: was mwf_job). The function also owns the reveal
 *     gate and writes the subject's delivered `EMPATHY_STATEMENT` copy.
 *   - The waiting state ("is my partner's attempt held / ready?") comes from
 *     `v_empathy_direction_status` — content-free, both parties may read it —
 *     never from the partner's attempt row (spec §7 service rule).
 *   - A participant reads an attempt about them only once `revealed_at` is set
 *     (spec §1.2 RLS, status-independent): `revealedAttemptAbout`.
 *
 * Reads run on the app connection (the request's identity); the AI's writes use
 * exactly the columns tables.sql grants mwf_ai.
 */

import type { PrismaClient } from '../generated/prisma/client';
import { getAiPrisma, prisma, type DbClient } from '../lib/prisma';
import { decryptRawRows, encryptColumnValue } from '../lib/prisma-encryption-middleware';
import { loadSessionParties, type Seat } from './participant-resolver';

export type TargetEmpathyStatus =
  | 'HELD'
  | 'AWAITING_SHARING'
  | 'REFINING'
  | 'READY'
  | 'REVEALED'
  | 'VALIDATED'
  | 'SUPERSEDED';

/** Statuses at which a direction counts as "ready or later" (the reveal gate's set). */
export const READY_OR_LATER: ReadonlySet<TargetEmpathyStatus> = new Set(['READY', 'REVEALED', 'VALIDATED']);

export interface AttemptRow {
  id: string;
  sessionId: string;
  authorUserId: string;
  subjectUserId: string;
  round: number;
  supersedesAttemptId: string | null;
  content: string;
  status: TargetEmpathyStatus;
  statusVersion: number;
  submittedAt: Date;
  revealedAt: Date | null;
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'SEEN';
  deliveredAt: Date | null;
  seenAt: Date | null;
}

const ATTEMPT_SELECT = {
  id: true,
  sessionId: true,
  authorUserId: true,
  subjectUserId: true,
  round: true,
  supersedesAttemptId: true,
  content: true,
  status: true,
  statusVersion: true,
  submittedAt: true,
  revealedAt: true,
  deliveryStatus: true,
  deliveredAt: true,
  seenAt: true,
} as const;

// ----------------------------------------------------------------------------
// Session parties
// ----------------------------------------------------------------------------

export interface SessionParty {
  /** The party's user — with the session, its participant key (work-k5fk.3). */
  userId: string;
  /** first name, else the full name (the old `firstName || name`). */
  name: string | null;
  joinedAt: Date;
  mainConversationId: string | null;
}

/**
 * The session's present human participants, in join order (the old
 * relationship-member order: the inviter first). The reconciler's A/B
 * directions are this order.
 */
export async function sessionParties(sessionId: string, client: PrismaClient = prisma): Promise<SessionParty[]> {
  if (client === prisma) {
    // As mwf_app: a partner's "user" and conversation rows are theirs under RLS; their name and MAIN conversation id
    // come from app.session_parties (work-k5fk.10.7, review F7/F8).
    const rows = await loadSessionParties([sessionId]);
    return rows
      .filter(r => r.kind === 'human' && !r.leftAt)
      .map(r => ({
        userId: r.userId,
        name: r.userName || r.displayName || null,
        joinedAt: r.joinedAt,
        mainConversationId: r.mainConversationId,
      }));
  }
  const rows = await client.participant.findMany({
    where: { sessionId, kind: 'human', leftAt: null },
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    select: {
      userId: true,
      joinedAt: true,
      displayName: true,
      user: { select: { firstName: true, name: true } },
      conversations: { where: { kind: 'MAIN' }, select: { id: true } },
    },
  });
  return rows.map(r => ({
    userId: r.userId,
    name: r.user?.firstName || r.user?.name || r.displayName || null,
    joinedAt: r.joinedAt,
    mainConversationId: r.conversations[0]?.id ?? null,
  }));
}

/**
 * TS-12 (R5): the one human co-participant who has LEFT the session (account
 * deletion or leaving: app.anonymize_user_in_session sets left_at and NULLs
 * display_name), when there is no present partner. Reads of what the leaver
 * delivered — their revealed round, the caller's own draft and round about
 * them — resolve the tombstone through this (spec §7: the revealed row stays
 * in the subject's SELECT arm forever). Writes never do: they keep requiring a
 * present partner. `name` is always null (the tombstone has none).
 */
export async function departedCounterpart(me: Seat, client: PrismaClient = prisma): Promise<SessionParty | null> {
  const rows =
    client === prisma
      ? (await loadSessionParties([me.sessionId]))
          .filter(r => r.kind === 'human' && r.leftAt && r.userId !== me.userId)
          .map(r => ({ userId: r.userId, joinedAt: r.joinedAt, mainConversationId: r.mainConversationId }))
      : (
          await client.participant.findMany({
            where: { sessionId: me.sessionId, kind: 'human', leftAt: { not: null }, userId: { not: me.userId } },
            orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
            select: {
              userId: true,
              joinedAt: true,
              conversations: { where: { kind: 'MAIN' }, select: { id: true } },
            },
          })
        ).map(r => ({ userId: r.userId, joinedAt: r.joinedAt, mainConversationId: r.conversations[0]?.id ?? null }));
  if (rows.length !== 1) return null;
  const r = rows[0];
  return { userId: r.userId, name: null, joinedAt: r.joinedAt, mainConversationId: r.mainConversationId };
}

/** The party with this user id. */
export function partyOf(parties: SessionParty[], who: { userId: string }): SessionParty | undefined {
  return parties.find(p => p.userId === who.userId);
}

// ----------------------------------------------------------------------------
// Attempts
// ----------------------------------------------------------------------------

/**
 * The CURRENT attempt of a direction — the live round, else the latest round
 * (as `v_empathy_direction`). Readable by its author; a subject must use
 * `revealedAttemptAbout` instead.
 */
export async function currentAttempt(
  sessionId: string,
  authorUserId: string,
  subjectUserId: string,
  /** The reconciler passes the job connection (Ruling R35). */
  client: PrismaClient = prisma,
): Promise<AttemptRow | null> {
  const rounds = (await client.empathyAttempt.findMany({
    where: { sessionId, authorUserId, subjectUserId },
    orderBy: { round: 'desc' },
    select: ATTEMPT_SELECT,
  })) as AttemptRow[];
  return rounds.find(r => r.status !== 'SUPERSEDED' && r.status !== 'VALIDATED') ?? rounds[0] ?? null;
}

/** Every round of a direction, oldest first (the old revisionCount = rounds − 1). */
export async function roundsOf(sessionId: string, authorUserId: string, subjectUserId: string): Promise<AttemptRow[]> {
  return (await prisma.empathyAttempt.findMany({
    where: { sessionId, authorUserId, subjectUserId },
    orderBy: { round: 'asc' },
    select: ATTEMPT_SELECT,
  })) as AttemptRow[];
}

/**
 * What the SUBJECT may read of a direction about them: the latest round with
 * `revealed_at` set (a later, unrevealed round is invisible to them; a
 * superseded round they already read stays readable — spec §7).
 */
export async function revealedAttemptAbout(
  sessionId: string,
  subjectUserId: string,
  authorUserId: string,
): Promise<AttemptRow | null> {
  return (await prisma.empathyAttempt.findFirst({
    where: { sessionId, authorUserId, subjectUserId, revealedAt: { not: null } },
    orderBy: { round: 'desc' },
    select: ATTEMPT_SELECT,
  })) as AttemptRow | null;
}

export async function attemptById(id: string): Promise<AttemptRow | null> {
  return (await prisma.empathyAttempt.findUnique({ where: { id }, select: ATTEMPT_SELECT })) as AttemptRow | null;
}

export interface DirectionStatus {
  authorUserId: string;
  subjectUserId: string;
  round: number;
  status: TargetEmpathyStatus;
  submittedAt: Date;
  revealedAt: Date | null;
}

/**
 * `v_empathy_direction_status` for one session, under the caller's identity:
 * the latest round's status of every direction, no content. Must be awaited
 * inside the request context (a PrismaPromise is lazy — TS-9).
 */
export async function directionStatuses(sessionId: string): Promise<DirectionStatus[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      a: string;
      s: string;
      round: number;
      status: TargetEmpathyStatus;
      submitted_at: Date;
      revealed_at: Date | null;
    }>
  >`SELECT v.author_user_id AS a, v.subject_user_id AS s, v.round, v.status::text AS status,
           v.submitted_at, v.revealed_at
    FROM v_empathy_direction_status v
    WHERE v.session_id = ${sessionId}::uuid`;
  return rows.map(r => ({
    authorUserId: r.a,
    subjectUserId: r.s,
    round: Number(r.round),
    status: r.status,
    submittedAt: r.submitted_at,
    revealedAt: r.revealed_at,
  }));
}

/** The direction author → subject among one session's statuses (user ids; the session is the statuses'). */
export function directionOf(
  statuses: DirectionStatus[],
  authorUserId: string,
  subjectUserId: string,
): DirectionStatus | undefined {
  return statuses.find(d => d.authorUserId === authorUserId && d.subjectUserId === subjectUserId);
}

/**
 * Submit round 1 of a direction (the author, app connection) with the
 * submission consent (the arc names the attempt; requester = the author,
 * spec §1.3). One transaction: an attempt never exists without its consent.
 * Returns null when the direction already has a round (the unique
 * (author, subject, round) refused it) — the caller answers idempotently.
 */
export async function submitAttempt(opts: {
  /** The two participants are (sessionId, authorUserId) and (sessionId, subjectUserId). */
  sessionId: string;
  authorUserId: string;
  subjectUserId: string;
  content: string;
  granted: boolean;
  at?: Date;
}): Promise<AttemptRow | null> {
  const at = opts.at ?? new Date();
  try {
    return await prisma.$transaction(async tx => {
      const attempt = (await tx.empathyAttempt.create({
        data: {
          sessionId: opts.sessionId,
          authorUserId: opts.authorUserId,
          subjectUserId: opts.subjectUserId,
          round: 1,
          content: opts.content,
          status: 'HELD',
          submittedAt: at,
        },
        select: ATTEMPT_SELECT,
      })) as AttemptRow;
      await tx.consent.create({
        data: {
          sessionId: opts.sessionId,
          userId: opts.authorUserId,
          requestedByUserId: opts.authorUserId,
          empathyAttemptId: attempt.id,
          decision: opts.granted ? 'GRANTED' : 'DENIED',
          decidedAt: at,
        },
        select: { id: true },
      });
      return attempt;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return null;
    throw err;
  }
}

/** Which connection runs a status move: the caller's own (author/subject) or the AI's (the reconciler, scoped). */
export type StatusActor = 'participant' | 'job';

function clientFor(actor: StatusActor): PrismaClient {
  return actor === 'job' ? getAiPrisma() : prisma;
}

/**
 * `app.empathy_set_status(attempt, status, content)`. Returns the id the
 * function returns: the attempt's own, or round n+1's on SUPERSEDED. The
 * function raises for a move the actor may not make or the table forbids.
 */
export async function setAttemptStatus(
  attemptId: string,
  status: TargetEmpathyStatus,
  /** `client`: a transaction of the actor's own connection, when the move is one write of several. */
  opts: { actor: StatusActor; content?: string; client?: DbClient },
): Promise<string> {
  const client = opts.client ?? clientFor(opts.actor);
  const rows = await client.$queryRaw<
    Array<{ id: string }>
  >`SELECT app.empathy_set_status(${attemptId}::uuid, ${status}::empathy_status, ${encryptColumnValue('empathy_attempt', 'content', opts.content ?? null)}::text)::text AS id`;
  return rows[0].id;
}

/**
 * The author resubmits: round n → SUPERSEDED, round n+1 HELD with `content`
 * (app connection, the author's identity). Idempotent on retry.
 */
export function resubmitAttempt(attemptId: string, content: string): Promise<string> {
  return setAttemptStatus(attemptId, 'SUPERSEDED', { actor: 'participant', content });
}

/**
 * The reconciler's move (the AI connection, scoped to the session), guarded by `status_version`: the
 * move is made only if the attempt is still at the version the caller's
 * analysis started from, so a late result never overwrites a newer decision
 * (spec §7 service rule). Returns false when the attempt moved on.
 */
export async function jobMoveIfUnchanged(
  attemptId: string,
  expectedVersion: number,
  status: TargetEmpathyStatus,
  /** More AI writes in the same transaction, run only when the move is made (e.g. its chat note). */
  alsoInTransaction?: (tx: DbClient) => Promise<void>,
): Promise<boolean> {
  return getAiPrisma().$transaction(async tx => {
    // Lock order as in app.empathy_set_status: the session row, then the attempt.
    await tx.$queryRaw`SELECT s.id FROM session s
      WHERE s.id = (SELECT a.session_id FROM empathy_attempt a WHERE a.id = ${attemptId}::uuid)
      FOR NO KEY UPDATE`;
    const rows = await tx.$queryRaw<
      Array<{ status_version: number; status: TargetEmpathyStatus }>
    >`SELECT status_version, status::text AS status FROM empathy_attempt WHERE id = ${attemptId}::uuid FOR NO KEY UPDATE`;
    const row = rows[0];
    if (!row || Number(row.status_version) !== expectedVersion) return false;
    if (row.status !== status) {
      await tx.$queryRaw`SELECT app.empathy_set_status(${attemptId}::uuid, ${status}::empathy_status, NULL::text)`;
    }
    if (alsoInTransaction) await alsoInTransaction(tx);
    return true;
  });
}

/**
 * The delivery stamp on a revealed/validated attempt (delivery_status, delivered_at, seen_at), through
 * app.empathy_mark_delivery (work-k5fk.10.5: was the job's UPDATE): on the caller's own connection the
 * attempt's SUBJECT (stage2.ts, the review), or inside the reconciler's AI transaction (state.ts).
 */
export async function markAttemptDelivery(
  attemptId: string,
  delivery: 'DELIVERED' | 'SEEN',
  at: Date = new Date(),
  client: DbClient = prisma,
): Promise<void> {
  await client.$executeRaw`SELECT app.empathy_mark_delivery(${attemptId}::uuid, ${delivery}::delivery_status, ${at}::timestamptz)`;
}

// ----------------------------------------------------------------------------
// Reviews (spec §1.2 empathy_review — the subject's verdict on a revealed attempt)
// ----------------------------------------------------------------------------

export interface ReviewRow {
  id: string;
  attemptId: string;
  sessionId: string;
  reviewerUserId: string;
  validated: boolean;
  feedback: string | null;
  feedbackSentAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

const REVIEW_SELECT = {
  id: true,
  attemptId: true,
  sessionId: true,
  reviewerUserId: true,
  validated: true,
  feedback: true,
  feedbackSentAt: true,
  updatedAt: true,
  createdAt: true,
} as const;

/** The subject's review of an attempt (the reviewer reads their own). */
export async function reviewOf(attemptId: string, reviewer: Seat): Promise<ReviewRow | null> {
  return prisma.empathyReview.findUnique({
    where: {
      attemptId_sessionId_reviewerUserId: { attemptId, sessionId: reviewer.sessionId, reviewerUserId: reviewer.userId },
    },
    select: REVIEW_SELECT,
  });
}

/**
 * What the AUTHOR may read of the review of their attempt: nothing before the
 * feedback is sent (spec §1.2 RLS — "before send the author sees nothing, the
 * `validated` flag included"; fix1 m2). A positive verdict reaches the author
 * through their own round's status (VALIDATED), never through this row.
 */
export async function reviewVisibleToAuthor(attemptId: string, subject: Seat): Promise<ReviewRow | null> {
  const review = await reviewOf(attemptId, subject);
  if (!review) return null;
  return review.feedbackSentAt ? review : null;
}

/**
 * The subject records a verdict (app connection; the reviewer's own row). The
 * feedback text is written only on an explicit send (`feedback_sent_at`);
 * an unsent text stays in the draft. A verdict without a send leaves an
 * earlier sent feedback as it is (fix1 m3): validating after sending feedback
 * must not erase what the author was sent.
 */
export async function recordReview(opts: {
  attemptId: string;
  /** The reviewer's seat is (sessionId, reviewerUserId); the key makes the reviewer the attempt's subject. */
  sessionId: string;
  reviewerUserId: string;
  validated: boolean;
  sentFeedback: string | null;
  at: Date;
  /** The reviewer's own connection or a transaction of it (stage2.ts validateEmpathy: one transaction). */
  client?: DbClient;
}): Promise<ReviewRow> {
  const client = opts.client ?? prisma;
  const data = {
    validated: opts.validated,
    feedback: opts.sentFeedback,
    feedbackSentAt: opts.sentFeedback ? opts.at : null,
  };
  return client.empathyReview.upsert({
    where: {
      attemptId_sessionId_reviewerUserId: {
        attemptId: opts.attemptId,
        sessionId: opts.sessionId,
        reviewerUserId: opts.reviewerUserId,
      },
    },
    create: {
      attemptId: opts.attemptId,
      sessionId: opts.sessionId,
      reviewerUserId: opts.reviewerUserId,
      ...data,
    },
    update: opts.sentFeedback ? data : { validated: opts.validated },
    select: REVIEW_SELECT,
  });
}

// ----------------------------------------------------------------------------
// Drafts (spec §1.1 draft — EmpathyDraft, ValidationFeedbackDraft)
// ----------------------------------------------------------------------------

export interface DraftRow {
  id: string;
  content: string;
  readyToShare: boolean;
  version: number;
  updatedAt: Date;
  /** work-9309: set by "Edit first", cleared by the next write (findDraft reads it; writes leave it unset). */
  reopenedAt?: Date | null;
}

/**
 * Upsert one draft point in ONE statement (TS-9's pattern,
 * stream-turn-actions.ts): `INSERT … ON CONFLICT (session, user, kind, point)
 * DO UPDATE`. `readyToShare` undefined keeps the stored value.
 */
export async function upsertDraft(
  opts: {
    /** The draft's owner. */
    seat: Seat;
    kind: 'EMPATHY' | 'VALIDATION_FEEDBACK';
    /** EMPATHY: the subject's user id (a participant of the owner's session). */
    aboutUserId?: string;
    /** EMPATHY before the partner has joined (work-99k2); ignored when aboutUserId is given. */
    invitationId?: string;
    attemptId?: string;
    content: string;
    readyToShare?: boolean;
  },
  client: DbClient = prisma,
): Promise<DraftRow> {
  const about = opts.kind === 'EMPATHY' ? (opts.aboutUserId ?? null) : null;
  const invitation = opts.kind === 'EMPATHY' && !about ? (opts.invitationId ?? null) : null;
  const attempt = opts.kind === 'VALIDATION_FEEDBACK' ? (opts.attemptId ?? null) : null;
  const ready = typeof opts.readyToShare === 'boolean' ? opts.readyToShare : null;
  const rows = decryptRawRows(
    await client.$queryRaw<
      Array<{ id: string; content: string; ready_to_share: boolean; version: number; updated_at: Date }>
    >`INSERT INTO draft (session_id, user_id, kind, about_user_id, invitation_id, attempt_id,
                       content, ready_to_share, version)
    VALUES (${opts.seat.sessionId}::uuid, ${opts.seat.userId}::uuid, ${opts.kind}::draft_kind, ${about}::uuid,
            ${invitation}::uuid, ${attempt}::uuid,
            ${encryptColumnValue('draft', 'content', opts.content)}, coalesce(${ready}::boolean, false), 1)
    ON CONFLICT (session_id, user_id, kind, (coalesce(about_user_id, invitation_id, attempt_id, share_offer_id)))
    DO UPDATE SET content = EXCLUDED.content,
                  ready_to_share = coalesce(${ready}::boolean, draft.ready_to_share),
                  version = draft.version + 1,
                  -- work-9309: any write after an "Edit first" (the AI's
                  -- proposal, the author's save) ends the reopen.
                  reopened_at = NULL
    RETURNING id, content, ready_to_share, version, updated_at`,
    { content: 'draft.content' },
  );
  const r = rows[0];
  return {
    id: r.id,
    content: r.content,
    readyToShare: r.ready_to_share,
    version: Number(r.version),
    updatedAt: r.updated_at,
  };
}

export async function findDraft(opts: {
  seat: Seat;
  kind: 'EMPATHY' | 'VALIDATION_FEEDBACK';
  aboutUserId?: string;
  invitationId?: string;
  attemptId?: string;
}): Promise<DraftRow | null> {
  const point =
    opts.kind === 'VALIDATION_FEEDBACK'
      ? { attemptId: opts.attemptId }
      : opts.aboutUserId
        ? { aboutUserId: opts.aboutUserId }
        : { invitationId: opts.invitationId };
  // An undefined arc would match any draft of the kind; there is no such point.
  if (!Object.values(point)[0]) return null;
  return prisma.draft.findFirst({
    where: { sessionId: opts.seat.sessionId, userId: opts.seat.userId, kind: opts.kind, ...point },
    select: { id: true, content: true, readyToShare: true, version: true, updatedAt: true, reopenedAt: true },
  });
}

/**
 * What an EMPATHY draft is about (spec §1.1 draft, work-99k2): the partner
 * (their user id; the session is the draft's), or — written before the partner has joined — the pending
 * invitation that will become them. Exactly one (the exclusive-arc CHECK on draft, tables.sql).
 */
export type EmpathySubject = { aboutUserId: string } | { invitationId: string };

/** Delete the caller's EMPATHY draft about this subject ("set aside", work-99k2). Returns whether one existed. */
export async function deleteEmpathyDraft(seat: Seat, subject: EmpathySubject): Promise<boolean> {
  const { count } = await prisma.draft.deleteMany({
    where: { sessionId: seat.sessionId, userId: seat.userId, kind: 'EMPATHY', ...subject },
  });
  return count > 0;
}

/**
 * The invitation an inviter's EMPATHY draft is about before the partner has
 * joined (work-99k2): the caller's newest invitation that has not been
 * ACCEPTED. PENDING normally; an EXPIRED (or DECLINED) one is still returned,
 * so a draft written against it stays readable and writable — there is no
 * re-issue path today (one invitation per session, createSession), so the
 * text must not vanish when the invitation lapses. With `lock`, the row is
 * read FOR SHARE: an accept (FOR UPDATE, lockInvitationForAccept) either
 * committed before — and the caller sees ACCEPTED and the new participant —
 * or waits until the caller's transaction ends.
 */
export async function openInvitationOf(
  seat: Seat,
  client: DbClient = prisma,
  lock = false,
): Promise<{ id: string; status: string } | null> {
  const rows = lock
    ? await client.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status::text AS status FROM invitation
        WHERE session_id = ${seat.sessionId}::uuid AND invited_by_user_id = ${seat.userId}::uuid
        ORDER BY created_at DESC LIMIT 1 FOR SHARE`
    : await client.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status::text AS status FROM invitation
        WHERE session_id = ${seat.sessionId}::uuid AND invited_by_user_id = ${seat.userId}::uuid
        ORDER BY created_at DESC LIMIT 1`;
  const inv = rows[0];
  return inv && inv.status !== 'ACCEPTED' ? inv : null;
}

/**
 * The accept's first statement (work-99k2): the invitation row FOR UPDATE, so
 * a concurrent pre-join draft save (FOR SHARE, openInvitationOf) is either
 * committed before the move reads the drafts or runs after the accept commits.
 */
export async function lockInvitationForAccept(tx: DbClient, invitationId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM invitation WHERE id = ${invitationId}::uuid FOR UPDATE`;
}

/**
 * At accept, inside the transaction that creates the invitee's participant:
 * re-point every draft about the invitation to that participant
 * (about_user_id = the invitee, invitation_id = NULL). Returns the count.
 *
 * The drafts are the INVITER's rows, so the move is app.invitation_repoint_drafts
 * (work-k5fk.10.7): a definer that checks the caller accepted the invitation and is
 * seated, then deletes and re-inserts each row with the new arc — not an UPDATE, which
 * would stamp updated_at (the draft's written-at, `preJoinReview`); id, created_at,
 * updated_at, version and reopened_at carry over. It locks the rows FOR UPDATE (the
 * invitation lock is the protocol; this keeps the move safe from any writer that skips it).
 */
export async function repointInvitationDrafts(
  tx: DbClient,
  invitationId: string,
  /** The invitee's new participant (of the invitation's session): the caller. */
  about: Seat,
): Promise<number> {
  void about;
  const [row] = await tx.$queryRaw<Array<{ moved: number }>>`
    SELECT app.invitation_repoint_drafts(${invitationId}::uuid) AS moved`;
  return Number(row?.moved ?? 0);
}

/**
 * The E2E tooling's copy of the move (controllers/session-state.ts acceptPendingInvitationForE2ESession, on the
 * superuser tooling connection, which no definer arm admits): the same delete and re-insert through the
 * Prisma client. Tooling only, never a request path.
 */
export async function repointInvitationDraftsAsTooling(
  tx: DbClient,
  invitationId: string,
  /** The invitee's new participant (of the invitation's session). */
  about: Seat,
): Promise<number> {
  // The rows themselves FOR UPDATE too (the invitation lock is the protocol;
  // this keeps the move safe from any writer that skips it).
  await tx.$queryRaw`SELECT id FROM draft WHERE invitation_id = ${invitationId}::uuid FOR UPDATE`;
  const drafts = await tx.draft.findMany({ where: { invitationId } });
  for (const d of drafts) {
    await tx.draft.delete({ where: { id: d.id } });
    await tx.draft.create({
      data: {
        id: d.id,
        sessionId: d.sessionId,
        userId: d.userId,
        kind: d.kind,
        aboutUserId: about.userId,
        content: d.content,
        readyToShare: d.readyToShare,
        version: d.version,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        reopenedAt: d.reopenedAt, // work-9309: the move keeps every fact of the row
      },
    });
  }
  return drafts.length;
}

/** Content-free facts of a reconciler result behind guidance the caller may read (app.result_facts). */
export interface ResultFacts {
  id: string;
  attemptId: string;
  iteration: number;
  supersededAt: Date | null;
}

/**
 * Which attempt each result analysed, its iteration and supersession — never the analysis — through
 * app.result_facts (work-k5fk.10.7): the author of an attempt reads its guidance, but the result is the
 * subject's (reconciler_result app_select, R6), so a relation filter on it would see nothing.
 */
export async function resultFactsOf(ids: string[], client: DbClient = prisma): Promise<Map<string, ResultFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await client.$queryRaw<
    Array<{ id: string; attempt_id: string; iteration: number; superseded_at: Date | null }>
  >`SELECT id, attempt_id, iteration, superseded_at FROM app.result_facts(${[...new Set(ids)]}::uuid[])`;
  return new Map(
    rows.map(r => [r.id, { id: r.id, attemptId: r.attempt_id, iteration: r.iteration, supersededAt: r.superseded_at }]),
  );
}

/** Of these guidance rows, the ones whose result is current (not superseded) — and of `attemptId`, when given. */
export async function currentGuidance<T extends { resultId: string }>(
  rows: T[],
  attemptId?: string,
): Promise<Array<T & { result: ResultFacts }>> {
  const facts = await resultFactsOf(rows.map(r => r.resultId));
  return rows.flatMap(r => {
    const result = facts.get(r.resultId);
    return result && result.supersededAt === null && (attemptId === undefined || result.attemptId === attemptId)
      ? [{ ...r, result }]
      : [];
  });
}

/** Content-free facts of an attempt the caller is a party of (app.attempt_meta). */
export interface AttemptMeta {
  id: string;
  sessionId: string;
  authorUserId: string;
  subjectUserId: string;
  round: number;
  status: TargetEmpathyStatus;
  statusVersion: number;
  revealedAt: Date | null;
}

/**
 * The facts (never the content) of attempts the caller authored or is the subject of, by id — through
 * app.attempt_meta (work-k5fk.10.7): before the reveal, the subject cannot read the attempt's row at all
 * (empathy_attempt app_select, P0-2), yet answers a share offer on it, which moves its round.
 */
export async function attemptMetaOf(ids: string[], client: DbClient = prisma): Promise<Map<string, AttemptMeta>> {
  if (ids.length === 0) return new Map();
  const rows = await client.$queryRaw<
    Array<{
      id: string;
      session_id: string;
      author_user_id: string;
      subject_user_id: string;
      round: number;
      status: TargetEmpathyStatus;
      status_version: number;
      revealed_at: Date | null;
    }>
  >`SELECT id, session_id, author_user_id, subject_user_id, round, status::text AS status, status_version, revealed_at
    FROM app.attempt_meta(${[...new Set(ids)]}::uuid[])`;
  return new Map(
    rows.map(r => [
      r.id,
      {
        id: r.id,
        sessionId: r.session_id,
        authorUserId: r.author_user_id,
        subjectUserId: r.subject_user_id,
        round: r.round,
        status: r.status,
        statusVersion: r.status_version,
        revealedAt: r.revealed_at,
      },
    ]),
  );
}

/** `rows` with each one's attempt facts attached as `attempt` (rows whose attempt the caller is no party of drop out). */
export async function withAttemptMeta<T extends { attemptId: string }>(
  rows: T[],
  client: DbClient = prisma,
): Promise<Array<T & { attempt: AttemptMeta }>> {
  const meta = await attemptMetaOf(
    rows.map(r => r.attemptId),
    client,
  );
  return rows.flatMap(r => {
    const attempt = meta.get(r.attemptId);
    return attempt ? [{ ...r, attempt }] : [];
  });
}

/** The first of `rows` (in their order) whose attempt `authorUserId` wrote — by app.attempt_meta, not the row's RLS. */
export async function byAuthor<T extends { attemptId: string }>(
  rows: T[],
  authorUserId: string,
  client: DbClient = prisma,
): Promise<T | null> {
  const meta = await attemptMetaOf(
    rows.map(r => r.attemptId),
    client,
  );
  return rows.find(r => meta.get(r.attemptId)?.authorUserId === authorUserId) ?? null;
}

/** One row with its attempt facts attached (null in, or no party of it: null). */
export async function withOneAttemptMeta<T extends { attemptId: string }>(
  row: T | null,
  client: DbClient = prisma,
): Promise<(T & { attempt: AttemptMeta }) | null> {
  if (!row) return null;
  return (await withAttemptMeta([row], client))[0] ?? null;
}

/** Has the author GRANTED a submission consent on any round of this direction (m12: any round, not only the newest)? */
export async function grantedSubmissionConsent(
  sessionId: string,
  authorUserId: string,
  subjectUserId: string,
): Promise<boolean> {
  const n = await prisma.consent.count({
    where: {
      sessionId,
      userId: authorUserId,
      decision: 'GRANTED',
      empathyAttempt: { sessionId, authorUserId, subjectUserId },
    },
  });
  return n > 0;
}
