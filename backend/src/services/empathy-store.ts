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
 *     the reveal run on the JOB connection (`mwf_job`), which is the only
 *     principal the function lets reveal. The function also owns the reveal
 *     gate and writes the subject's delivered `EMPATHY_STATEMENT` copy.
 *   - The waiting state ("is my partner's attempt held / ready?") comes from
 *     `v_empathy_direction_status` — content-free, both parties may read it —
 *     never from the partner's attempt row (spec §7 service rule).
 *   - A participant reads an attempt about them only once `revealed_at` is set
 *     (spec §1.2 RLS, status-independent): `revealedAttemptAbout`.
 *
 * Reads run on the app connection (the request's identity); job writes use
 * exactly the columns trailer T7 grants mwf_job.
 */

import type { PrismaClient } from '../generated/prisma/client';
import { getJobPrisma, prisma } from '../lib/prisma';

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
  authorParticipantId: string;
  subjectParticipantId: string;
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
  authorParticipantId: true,
  subjectParticipantId: true,
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
  participantId: string;
  userId: string | null;
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
export async function sessionParties(sessionId: string): Promise<SessionParty[]> {
  const rows = await prisma.participant.findMany({
    where: { sessionId, kind: 'human', leftAt: null },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      userId: true,
      joinedAt: true,
      displayName: true,
      user: { select: { firstName: true, name: true } },
      conversations: { where: { kind: 'MAIN' }, select: { id: true } },
    },
  });
  return rows.map(r => ({
    participantId: r.id,
    userId: r.userId,
    name: r.user?.firstName || r.user?.name || r.displayName || null,
    joinedAt: r.joinedAt,
    mainConversationId: r.conversations[0]?.id ?? null,
  }));
}

/** The party with this user id, or this participant id. */
export function partyOf(parties: SessionParty[], who: { userId?: string; participantId?: string }): SessionParty | undefined {
  return parties.find(p => (who.participantId ? p.participantId === who.participantId : p.userId === who.userId));
}

// ----------------------------------------------------------------------------
// Attempts
// ----------------------------------------------------------------------------

/**
 * The CURRENT attempt of a direction — the live round, else the latest round
 * (as `v_empathy_direction`). Readable by its author; a subject must use
 * `revealedAttemptAbout` instead.
 */
export async function currentAttempt(authorParticipantId: string, subjectParticipantId: string): Promise<AttemptRow | null> {
  const rounds = (await prisma.empathyAttempt.findMany({
    where: { authorParticipantId, subjectParticipantId },
    orderBy: { round: 'desc' },
    select: ATTEMPT_SELECT,
  })) as AttemptRow[];
  return rounds.find(r => r.status !== 'SUPERSEDED' && r.status !== 'VALIDATED') ?? rounds[0] ?? null;
}

/** Every round of a direction, oldest first (the old revisionCount = rounds − 1). */
export async function roundsOf(authorParticipantId: string, subjectParticipantId: string): Promise<AttemptRow[]> {
  return (await prisma.empathyAttempt.findMany({
    where: { authorParticipantId, subjectParticipantId },
    orderBy: { round: 'asc' },
    select: ATTEMPT_SELECT,
  })) as AttemptRow[];
}

/**
 * What the SUBJECT may read of a direction about them: the latest round with
 * `revealed_at` set (a later, unrevealed round is invisible to them; a
 * superseded round they already read stays readable — spec §7).
 */
export async function revealedAttemptAbout(subjectParticipantId: string, authorParticipantId: string): Promise<AttemptRow | null> {
  return (await prisma.empathyAttempt.findFirst({
    where: { authorParticipantId, subjectParticipantId, revealedAt: { not: null } },
    orderBy: { round: 'desc' },
    select: ATTEMPT_SELECT,
  })) as AttemptRow | null;
}

export async function attemptById(id: string): Promise<AttemptRow | null> {
  return (await prisma.empathyAttempt.findUnique({ where: { id }, select: ATTEMPT_SELECT })) as AttemptRow | null;
}

export interface DirectionStatus {
  authorParticipantId: string;
  subjectParticipantId: string;
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
    Array<{ a: string; s: string; round: number; status: TargetEmpathyStatus; submitted_at: Date; revealed_at: Date | null }>
  >`SELECT v.author_participant_id AS a, v.subject_participant_id AS s, v.round, v.status::text AS status,
           v.submitted_at, v.revealed_at
    FROM v_empathy_direction_status v
    JOIN participant p ON p.id = v.author_participant_id
    WHERE p.session_id = ${sessionId}::uuid`;
  return rows.map(r => ({
    authorParticipantId: r.a,
    subjectParticipantId: r.s,
    round: Number(r.round),
    status: r.status,
    submittedAt: r.submitted_at,
    revealedAt: r.revealed_at,
  }));
}

export function directionOf(
  statuses: DirectionStatus[],
  authorParticipantId: string,
  subjectParticipantId: string,
): DirectionStatus | undefined {
  return statuses.find(d => d.authorParticipantId === authorParticipantId && d.subjectParticipantId === subjectParticipantId);
}

/**
 * Submit round 1 of a direction (the author, app connection) with the
 * submission consent (the arc names the attempt; requester = the author,
 * spec §1.3). One transaction: an attempt never exists without its consent.
 * Returns null when the direction already has a round (the unique
 * (author, subject, round) refused it) — the caller answers idempotently.
 */
export async function submitAttempt(opts: {
  authorParticipantId: string;
  subjectParticipantId: string;
  content: string;
  granted: boolean;
  at?: Date;
}): Promise<AttemptRow | null> {
  const at = opts.at ?? new Date();
  try {
    return await prisma.$transaction(async tx => {
      const attempt = (await tx.empathyAttempt.create({
        data: {
          authorParticipantId: opts.authorParticipantId,
          subjectParticipantId: opts.subjectParticipantId,
          round: 1,
          content: opts.content,
          status: 'HELD',
          submittedAt: at,
        },
        select: ATTEMPT_SELECT,
      })) as AttemptRow;
      await tx.consent.create({
        data: {
          participantId: opts.authorParticipantId,
          requestedByParticipantId: opts.authorParticipantId,
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

/** Which connection runs a status move: the caller's own (author/subject) or the job's. */
export type StatusActor = 'participant' | 'job';

function clientFor(actor: StatusActor): PrismaClient {
  return actor === 'job' ? getJobPrisma() : prisma;
}

/**
 * `app.empathy_set_status(attempt, status, content)`. Returns the id the
 * function returns: the attempt's own, or round n+1's on SUPERSEDED. The
 * function raises for a move the actor may not make or the table forbids.
 */
export async function setAttemptStatus(
  attemptId: string,
  status: TargetEmpathyStatus,
  opts: { actor: StatusActor; content?: string; client?: PrismaClient },
): Promise<string> {
  const client = opts.client ?? clientFor(opts.actor);
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT app.empathy_set_status(${attemptId}::uuid, ${status}::empathy_status, ${opts.content ?? null}::text)::text AS id`;
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
 * The reconciler's move (job connection), guarded by `status_version`: the
 * move is made only if the attempt is still at the version the caller's
 * analysis started from, so a late result never overwrites a newer decision
 * (spec §7 service rule). Returns false when the attempt moved on.
 */
export async function jobMoveIfUnchanged(
  attemptId: string,
  expectedVersion: number,
  status: TargetEmpathyStatus,
  /** More job writes in the same transaction, run only when the move is made (e.g. its chat note). */
  alsoInTransaction?: (tx: PrismaClient) => Promise<void>,
): Promise<boolean> {
  return getJobPrisma().$transaction(async tx => {
    // Lock order as in app.empathy_set_status: the session row, then the attempt.
    await tx.$queryRaw`
      SELECT s.id FROM session s
      WHERE s.id = (SELECT p.session_id FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id
                    WHERE a.id = ${attemptId}::uuid)
      FOR NO KEY UPDATE`;
    const rows = await tx.$queryRaw<Array<{ status_version: number; status: TargetEmpathyStatus }>>`
      SELECT status_version, status::text AS status FROM empathy_attempt WHERE id = ${attemptId}::uuid FOR NO KEY UPDATE`;
    const row = rows[0];
    if (!row || Number(row.status_version) !== expectedVersion) return false;
    if (row.status !== status) {
      await tx.$queryRaw`SELECT app.empathy_set_status(${attemptId}::uuid, ${status}::empathy_status, NULL::text)`;
    }
    if (alsoInTransaction) await alsoInTransaction(tx as unknown as PrismaClient);
    return true;
  });
}

/**
 * The job's delivery stamp on a revealed/validated attempt (trailer T7:
 * delivery_status, delivered_at, seen_at).
 */
export async function markAttemptDelivery(
  attemptId: string,
  delivery: 'DELIVERED' | 'SEEN',
  at: Date = new Date(),
  client: PrismaClient = getJobPrisma(),
): Promise<void> {
  if (delivery === 'DELIVERED') {
    await client.$executeRaw`
      UPDATE empathy_attempt SET delivery_status = 'DELIVERED', delivered_at = coalesce(delivered_at, ${at})
      WHERE id = ${attemptId}::uuid`;
  } else {
    await client.$executeRaw`
      UPDATE empathy_attempt SET delivery_status = 'SEEN', seen_at = coalesce(seen_at, ${at})
      WHERE id = ${attemptId}::uuid`;
  }
}

// ----------------------------------------------------------------------------
// Reviews (spec §1.2 empathy_review — the subject's verdict on a revealed attempt)
// ----------------------------------------------------------------------------

export interface ReviewRow {
  id: string;
  attemptId: string;
  reviewerParticipantId: string;
  validated: boolean;
  feedback: string | null;
  feedbackSentAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

const REVIEW_SELECT = {
  id: true,
  attemptId: true,
  reviewerParticipantId: true,
  validated: true,
  feedback: true,
  feedbackSentAt: true,
  updatedAt: true,
  createdAt: true,
} as const;

/** The subject's review of an attempt (the reviewer reads their own). */
export async function reviewOf(attemptId: string, reviewerParticipantId: string): Promise<ReviewRow | null> {
  return prisma.empathyReview.findUnique({
    where: { attemptId_reviewerParticipantId: { attemptId, reviewerParticipantId } },
    select: REVIEW_SELECT,
  });
}

/**
 * What the AUTHOR may read of the review of their attempt: nothing before the
 * feedback is sent (spec §1.2 RLS — "before send the author sees nothing, the
 * `validated` flag included"), except a positive verdict, which IS the send
 * (validated = true is delivered by the status VALIDATED it causes).
 */
export async function reviewVisibleToAuthor(attemptId: string, subjectParticipantId: string): Promise<ReviewRow | null> {
  const review = await reviewOf(attemptId, subjectParticipantId);
  if (!review) return null;
  return review.feedbackSentAt || review.validated ? review : null;
}

/**
 * The subject records a verdict (app connection; the reviewer's own row). The
 * feedback text is written only on an explicit send (`feedback_sent_at`);
 * an unsent text stays in the draft.
 */
export async function recordReview(opts: {
  attemptId: string;
  reviewerParticipantId: string;
  validated: boolean;
  sentFeedback: string | null;
  at: Date;
}): Promise<ReviewRow> {
  const data = {
    validated: opts.validated,
    feedback: opts.sentFeedback,
    feedbackSentAt: opts.sentFeedback ? opts.at : null,
  };
  return prisma.empathyReview.upsert({
    where: { attemptId_reviewerParticipantId: { attemptId: opts.attemptId, reviewerParticipantId: opts.reviewerParticipantId } },
    create: { attemptId: opts.attemptId, reviewerParticipantId: opts.reviewerParticipantId, ...data },
    update: data,
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
}

/**
 * Upsert one draft point in ONE statement (TS-9's pattern,
 * stream-turn-actions.ts): `INSERT … ON CONFLICT (participant, kind, point)
 * DO UPDATE`. `readyToShare` undefined keeps the stored value.
 */
export async function upsertDraft(opts: {
  participantId: string;
  kind: 'EMPATHY' | 'VALIDATION_FEEDBACK';
  aboutParticipantId?: string;
  attemptId?: string;
  content: string;
  readyToShare?: boolean;
}): Promise<DraftRow> {
  const about = opts.kind === 'EMPATHY' ? opts.aboutParticipantId ?? null : null;
  const attempt = opts.kind === 'VALIDATION_FEEDBACK' ? opts.attemptId ?? null : null;
  const ready = typeof opts.readyToShare === 'boolean' ? opts.readyToShare : null;
  const rows = await prisma.$queryRaw<Array<{ id: string; content: string; ready_to_share: boolean; version: number; updated_at: Date }>>`
    INSERT INTO draft (participant_id, kind, about_participant_id, attempt_id, content, ready_to_share, version)
    VALUES (${opts.participantId}::uuid, ${opts.kind}::draft_kind, ${about}::uuid, ${attempt}::uuid, ${opts.content},
            coalesce(${ready}::boolean, false), 1)
    ON CONFLICT (participant_id, kind, (coalesce(about_participant_id, attempt_id, share_offer_id)))
    DO UPDATE SET content = EXCLUDED.content,
                  ready_to_share = coalesce(${ready}::boolean, draft.ready_to_share),
                  version = draft.version + 1
    RETURNING id, content, ready_to_share, version, updated_at`;
  const r = rows[0];
  return { id: r.id, content: r.content, readyToShare: r.ready_to_share, version: Number(r.version), updatedAt: r.updated_at };
}

export async function findDraft(opts: {
  participantId: string;
  kind: 'EMPATHY' | 'VALIDATION_FEEDBACK';
  aboutParticipantId?: string;
  attemptId?: string;
}): Promise<DraftRow | null> {
  return prisma.draft.findFirst({
    where: {
      participantId: opts.participantId,
      kind: opts.kind,
      ...(opts.kind === 'EMPATHY' ? { aboutParticipantId: opts.aboutParticipantId } : { attemptId: opts.attemptId }),
    },
    select: { id: true, content: true, readyToShare: true, version: true, updatedAt: true },
  });
}

/** The submission consent of an author's direction (the newest round's arc), if granted. */
export async function grantedSubmissionConsent(authorParticipantId: string, subjectParticipantId: string): Promise<boolean> {
  const n = await prisma.consent.count({
    where: {
      participantId: authorParticipantId,
      decision: 'GRANTED',
      empathyAttempt: { authorParticipantId, subjectParticipantId },
    },
  });
  return n > 0;
}
