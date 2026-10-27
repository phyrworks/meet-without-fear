/**
 * Follow-up (was Tending) on the target tables (TS-11; spec §1.5).
 *
 * Old model → target:
 *
 *   TendingEntry                        → follow_up (type, scope, owner_participant_id,
 *                                         response_deadline_at); ONE follow-up is ONE cycle:
 *                                         a further round (EXTEND, PARTIAL_CLOSURE continuing) is a
 *                                         new follow_up row and the old one COMPLETED
 *   TendingCoordinationCycle            → v_follow_up_cycle (computed: waiting_on, status by deadline)
 *   TendingCheckin + TendingResponse +
 *   TendingEntryOutcome + TendingNeedOutcome +
 *   TendingAdjustment + TendingResponsePartialClosure
 *                                       → ONE follow_up_checkin per (follow_up, participant) with a
 *                                         `payload` validated by the shared zod contract
 *                                         `followUpCheckinPayloadSchema` (the five tables are its arrays)
 *   TendingBetweenPeriodNote            → follow_up_note (private); sharing = copying the note into
 *                                         the check-in's payload.carriedNotes[] and setting
 *                                         carried_into_checkin_id
 *   TendingReminder                     → reminder (user-scoped)
 *
 * Writers: the participant's own rows (check-ins, notes, reminders, the
 * owner's opt-in) on the APP connection; the scheduler, the open-due job,
 * status moves of a follow-up and reminder delivery on the JOB connection
 * (spec: follow_up "I member / job (scheduler) · U owner or job (status)",
 * reminder "status → DELIVERED by mwf_job").
 *
 * The DTOs (`shared/src/dto/strategy.ts` Tending*) keep their shape: ids are
 * the follow-up / check-in ids, user ids are the participants' user ids.
 */

import {
  ContinueChoice,
  PartialClosureResolution,
  TendingCheckinDTO,
  TendingAdjustmentDTO,
  TendingAdjustmentInput,
  TendingBlockerCategory,
  TendingCheckinEntryOutcomeInput,
  TendingCheckinNeedOutcomeInput,
  TendingCheckinOrientations,
  TendingBetweenPeriodNoteDTO,
  TendingCoordinationCycleDTO,
  TendingCoordinationStatus,
  TendingEntryDTO,
  TendingEntryOutcomeDTO,
  TendingEntryScope,
  TendingEntryStatus,
  TendingEntryType,
  TendingFollowThroughStatus,
  TendingHistoryCycleDTO,
  TendingHelpfulnessStatus,
  TendingNeedOutcomeDTO,
  TendingNeedResolutionStatus,
  TendingNextAction,
  TendingReminderDTO,
  TendingReminderInput,
  TendingReminderScope,
  TendingReminderStatus,
  TendingResponseDTO,
  TendingResponseStatus,
  emptyFollowUpCheckinPayload,
  followUpCheckinPayloadSchema,
  type FollowUpCheckinPayload,
} from '@meet-without-fear/shared';
import type { Prisma } from '../generated/prisma/client';
import { getJobPrisma, prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { publishSessionEvent, publishUserEvent } from './realtime';
import { createFacilitatorMessage } from './message-store';
import { resolveParticipant } from './participant-resolver';

// ============================================================================
// Rows and errors
// ============================================================================

export type FollowUpType = 'SCHEDULED_SHARED_AGREEMENT' | 'SCHEDULED_INDIVIDUAL_COMMITMENT' | 'USER_INITIATED_REENTRY';

export interface FollowUpRow {
  id: string;
  sessionId: string;
  agreementId: string | null;
  proposalId: string | null;
  type: FollowUpType;
  scope: 'SHARED' | 'INDIVIDUAL';
  ownerParticipantId: string | null;
  optedInShared: boolean;
  status: 'SCHEDULED' | 'OPEN' | 'PARTIAL' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
  scheduledFor: Date | null;
  responseDeadlineAt: Date | null;
  openedAt: Date | null;
  completedAt: Date | null;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CheckinRow {
  id: string;
  followUpId: string;
  participantId: string;
  nextAction: TendingNextAction | null;
  continueChoice: ContinueChoice | null;
  reflectionSummary: string | null;
  payload: FollowUpCheckinPayload;
  submittedAt: Date;
  createdAt: Date;
}

export class TendingNotFoundError extends Error {
  constructor() {
    super('Tending entry not found');
    this.name = 'TendingNotFoundError';
  }
}

export class TendingForbiddenError extends Error {
  constructor() {
    super('User is not a member of this session');
    this.name = 'TendingForbiddenError';
  }
}

export class TendingInvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TendingInvalidStateError';
  }
}

const FOLLOW_UP_SELECT = {
  id: true,
  sessionId: true,
  agreementId: true,
  proposalId: true,
  type: true,
  scope: true,
  ownerParticipantId: true,
  optedInShared: true,
  status: true,
  scheduledFor: true,
  responseDeadlineAt: true,
  openedAt: true,
  completedAt: true,
  summary: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The JOB connection or a transaction on it. */
type JobDb = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | '$executeRawUnsafe'>;

const DEFAULT_EXTENSION_DAYS = 28;
const DEFAULT_SHARED_RESPONSE_DEADLINE_DAYS = 14;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** follow_up.type → the DTO's TendingEntryType (names only). */
export function toTendingEntryType(type: FollowUpType): TendingEntryType {
  switch (type) {
    case 'SCHEDULED_SHARED_AGREEMENT':
      return TendingEntryType.SCHEDULED_SHARED_AGREEMENT_CHECKIN;
    case 'SCHEDULED_INDIVIDUAL_COMMITMENT':
      return TendingEntryType.SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN;
    default:
      return TendingEntryType.USER_INITIATED_REENTRY;
  }
}

/**
 * Validate a check-in payload against the shared contract. Every write goes
 * through here: an invalid payload is never stored.
 */
export function validateCheckinPayload(payload: unknown): FollowUpCheckinPayload {
  const parsed = followUpCheckinPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TendingInvalidStateError(
      `Invalid check-in payload: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

/** A stored payload, read back (a row written before validation existed reads as empty). */
function readPayload(raw: unknown): FollowUpCheckinPayload {
  const parsed = followUpCheckinPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyFollowUpCheckinPayload();
}

// ============================================================================
// Context
// ============================================================================

interface Viewer {
  sessionId: string;
  participantId: string;
  userId: string;
  sessionStatus: string;
  relationshipId: string;
  /** participant id → user id, for every participant of the session (DTOs carry user ids). */
  userOf: Map<string, string | null>;
  /** user id → participant id. */
  participantOfUser: Map<string, string>;
  /** Present human participants. */
  humans: string[];
}

async function viewerFor(sessionId: string, userId: string): Promise<Viewer> {
  const me = await resolveParticipant(sessionId, userId);
  if (!me) throw new TendingNotFoundError();
  const [session, participants] = await Promise.all([
    prisma.session.findUnique({ where: { id: sessionId }, select: { status: true, relationshipId: true } }),
    prisma.participant.findMany({
      where: { sessionId },
      select: { id: true, userId: true, kind: true, leftAt: true },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  if (!session) throw new TendingNotFoundError();
  return {
    sessionId,
    participantId: me.id,
    userId,
    sessionStatus: session.status,
    relationshipId: session.relationshipId,
    userOf: new Map(participants.map((p) => [p.id, p.userId])),
    participantOfUser: new Map(participants.filter((p) => p.userId).map((p) => [p.userId as string, p.id])),
    humans: participants.filter((p) => p.kind === 'human' && !p.leftAt).map((p) => p.id),
  };
}

const userIdOf = (v: Viewer, participantId: string | null): string | null =>
  participantId ? (v.userOf.get(participantId) ?? null) : null;

/**
 * The follow-ups a participant may see (spec RLS: SHARED, their own
 * INDIVIDUAL ones, or an INDIVIDUAL one its owner opted in to share).
 */
export async function loadFollowUpsForParticipant(sessionId: string, participantId: string): Promise<FollowUpRow[]> {
  return (await prisma.followUp.findMany({
    where: {
      sessionId,
      OR: [{ scope: 'SHARED' }, { ownerParticipantId: participantId }, { optedInShared: true }],
    },
    orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: FOLLOW_UP_SELECT,
  })) as FollowUpRow[];
}

/** Check-ins the viewer may read: their own, and every check-in on a SHARED follow-up. */
async function loadCheckins(followUpIds: string[], viewerParticipantId: string): Promise<CheckinRow[]> {
  if (followUpIds.length === 0) return [];
  const rows = await prisma.followUpCheckin.findMany({
    where: {
      followUpId: { in: followUpIds },
      OR: [{ participantId: viewerParticipantId }, { followUp: { scope: 'SHARED' } }],
    },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      followUpId: true,
      participantId: true,
      nextAction: true,
      continueChoice: true,
      reflectionSummary: true,
      payload: true,
      submittedAt: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    ...r,
    nextAction: r.nextAction as TendingNextAction | null,
    continueChoice: r.continueChoice as ContinueChoice | null,
    payload: readPayload(r.payload),
  }));
}

async function loadReminders(viewer: Viewer, followUpIds: string[]) {
  if (followUpIds.length === 0) return [];
  return prisma.reminder.findMany({
    where: { followUpId: { in: followUpIds }, userId: viewer.userId },
    orderBy: [{ remindAt: 'asc' }, { id: 'asc' }],
  });
}

type ReminderRow = Awaited<ReturnType<typeof loadReminders>>[number];

// ============================================================================
// DTOs
// ============================================================================

function toReminderDTO(viewer: Viewer, reminder: ReminderRow): TendingReminderDTO {
  return {
    id: reminder.id,
    sessionId: viewer.sessionId,
    checkinId: null,
    tendingEntryId: reminder.followUpId,
    userId: reminder.userId,
    scope: reminder.scope as TendingReminderScope,
    remindAt: reminder.remindAt.toISOString(),
    cadence: reminder.cadence,
    note: reminder.note,
    status: reminder.status as TendingReminderStatus,
    createdAt: reminder.createdAt.toISOString(),
    updatedAt: reminder.updatedAt.toISOString(),
  };
}

function toResponseDTO(viewer: Viewer, checkin: CheckinRow): TendingResponseDTO {
  const response = checkin.payload.responses.find((r) => r.followUpId === checkin.followUpId);
  return {
    id: checkin.id,
    tendingEntryId: checkin.followUpId,
    userId: userIdOf(viewer, checkin.participantId) ?? '',
    checkinId: checkin.id,
    status: (response?.status ?? 'CHECKIN') as TendingResponseStatus,
    reflection: response?.reflection ?? checkin.reflectionSummary,
    continueChoice: response?.continueChoice ?? checkin.continueChoice,
    submittedAt: checkin.submittedAt.toISOString(),
  };
}

function entryOutcomeDTOs(viewer: Viewer, checkin: CheckinRow): TendingEntryOutcomeDTO[] {
  return checkin.payload.entryOutcomes.map((o, i) => ({
    id: `${checkin.id}:entry:${i}`,
    checkinId: checkin.id,
    tendingEntryId: o.followUpId,
    responseId: checkin.id,
    userId: userIdOf(viewer, checkin.participantId) ?? '',
    followThroughStatus: o.followThroughStatus,
    helpfulnessStatus: o.helpfulnessStatus,
    blockerCategories: o.blockerCategories,
    whatHappened: o.whatHappened,
    helpedNeed: o.helpedNeed,
    blockerNote: o.blockerNote,
    stillWorthTrying: o.stillWorthTrying,
    createdAt: checkin.submittedAt.toISOString(),
  }));
}

function needOutcomeDTOs(viewer: Viewer, checkin: CheckinRow): TendingNeedOutcomeDTO[] {
  return checkin.payload.needOutcomes.map((o, i) => ({
    id: `${checkin.id}:need:${i}`,
    checkinId: checkin.id,
    sessionId: viewer.sessionId,
    needId: o.needId,
    needLabel: o.needLabel,
    sourceUserId: userIdOf(viewer, o.sourceParticipantId),
    resolutionStatus: o.resolutionStatus,
    note: o.note,
    changedNeedLabel: o.changedNeedLabel,
    nextAction: o.nextAction,
    createdAt: checkin.submittedAt.toISOString(),
  }));
}

function adjustmentDTOs(viewer: Viewer, checkin: CheckinRow): TendingAdjustmentDTO[] {
  return checkin.payload.adjustments.map((a, i) => ({
    id: `${checkin.id}:adjustment:${i}`,
    sessionId: viewer.sessionId,
    checkinId: checkin.id,
    tendingEntryId: a.followUpId,
    userId: userIdOf(viewer, checkin.participantId) ?? '',
    privacyScope: a.privacyScope,
    revisedCommitmentText: a.revisedCommitmentText,
    revisedCadence: a.revisedCadence,
    revisedScope: a.revisedScope,
    revisedSuccessCriteria: a.revisedSuccessCriteria,
    reason: a.reason,
    blockerAddressed: a.blockerAddressed,
    createdAt: checkin.submittedAt.toISOString(),
  }));
}

function toEntryDTO(viewer: Viewer, entry: FollowUpRow, checkins: CheckinRow[], reminders: ReminderRow[]): TendingEntryDTO {
  const onEntry = checkins.filter((c) => c.followUpId === entry.id);
  const mine = onEntry.find((c) => c.participantId === viewer.participantId) ?? null;
  const latestOutcome = mine ? (entryOutcomeDTOs(viewer, mine).find((o) => o.tendingEntryId === entry.id) ?? null) : null;
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    agreementId: entry.agreementId,
    type: toTendingEntryType(entry.type),
    scope: entry.scope as TendingEntryScope,
    ownerUserId: userIdOf(viewer, entry.ownerParticipantId),
    optedInShared: entry.optedInShared,
    status: entry.status as TendingEntryStatus,
    scheduledFor: iso(entry.scheduledFor),
    openedAt: iso(entry.openedAt),
    completedAt: iso(entry.completedAt),
    summary: entry.summary,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    myResponse: mine ? toResponseDTO(viewer, mine) : null,
    responseCount: onEntry.length,
    latestOutcome,
    reminders: reminders.filter((r) => r.followUpId === entry.id).map((r) => toReminderDTO(viewer, r)),
  };
}

async function entryDTOs(viewer: Viewer, entries: FollowUpRow[]): Promise<TendingEntryDTO[]> {
  const ids = entries.map((e) => e.id);
  const [checkins, reminders] = await Promise.all([loadCheckins(ids, viewer.participantId), loadReminders(viewer, ids)]);
  return entries.map((e) => toEntryDTO(viewer, e, checkins, reminders));
}

// ============================================================================
// Scheduling (JOB connection)
// ============================================================================

async function insertFollowUpAsJob(row: {
  sessionId: string;
  agreementId?: string | null;
  proposalId?: string | null;
  type: FollowUpType;
  scope: 'SHARED' | 'INDIVIDUAL';
  ownerParticipantId?: string | null;
  optedInShared?: boolean;
  status: 'SCHEDULED' | 'OPEN';
  scheduledFor: Date | null;
  responseDeadlineAt?: Date | null;
  summary: string | null;
}, db: JobDb = getJobPrisma()): Promise<string> {
  const [r] = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO follow_up (session_id, agreement_id, proposal_id, type, scope, owner_participant_id, opted_in_shared,
                           status, scheduled_for, response_deadline_at, summary)
    VALUES (${row.sessionId}::uuid, ${row.agreementId ?? null}::uuid, ${row.proposalId ?? null}::uuid,
            ${row.type}::follow_up_type, ${row.scope}::follow_up_scope, ${row.ownerParticipantId ?? null}::uuid,
            ${row.optedInShared ?? false}, ${row.status}::follow_up_status, ${row.scheduledFor},
            ${row.responseDeadlineAt ?? null}, ${row.summary})
    RETURNING id`;
  return r.id;
}

/**
 * A follow-up's status move (the job writes follow-up status). The SET names
 * only the columns it assigns: the job's grant on follow_up is UPDATE on
 * (status, opened_at, completed_at, response_deadline_at) and a SET that read
 * an unassigned column would need SELECT on it.
 */
async function setFollowUpStatusAsJob(
  id: string,
  status: FollowUpRow['status'],
  extra: { openedAt?: Date | null; completedAt?: Date | null; responseDeadlineAt?: Date | null } = {},
  db: JobDb = getJobPrisma(),
): Promise<number> {
  const params: unknown[] = [id, status];
  const sets = ['status = $2::follow_up_status'];
  const put = (column: string, value: Date | null | undefined) => {
    if (value === undefined) return;
    params.push(value);
    sets.push(`${column} = $${params.length}::timestamptz`);
  };
  put('opened_at', extra.openedAt);
  put('completed_at', extra.completedAt);
  put('response_deadline_at', extra.responseDeadlineAt);
  return db.$executeRawUnsafe(`UPDATE follow_up SET ${sets.join(', ')} WHERE id = $1::uuid`, ...params);
}

/** The next round of a follow-up: the current one COMPLETED, a new SCHEDULED row for the same subject. */
async function scheduleNextRoundAsJob(entry: FollowUpRow, scheduledFor: Date, now: Date): Promise<string> {
  await setFollowUpStatusAsJob(entry.id, 'COMPLETED', { completedAt: now });
  return insertFollowUpAsJob({
    sessionId: entry.sessionId,
    agreementId: entry.agreementId,
    proposalId: entry.proposalId,
    type: entry.type,
    scope: entry.scope,
    ownerParticipantId: entry.ownerParticipantId,
    optedInShared: entry.optedInShared,
    status: 'SCHEDULED',
    scheduledFor,
    summary: entry.summary,
  });
}

type AgreementForScheduling = { id: string; description: string; followUpDate: Date | null };

export async function scheduleSharedAgreementTendingEntries(
  sessionId: string,
  agreements: AgreementForScheduling[],
  now = new Date(),
  db: JobDb = getJobPrisma(),
): Promise<string[]> {
  const ids: string[] = [];
  for (const agreement of agreements) {
    if (!agreement.followUpDate) continue;
    const due = agreement.followUpDate <= now;
    ids.push(
      await insertFollowUpAsJob({
        sessionId,
        agreementId: agreement.id,
        type: 'SCHEDULED_SHARED_AGREEMENT',
        scope: 'SHARED',
        status: due ? 'OPEN' : 'SCHEDULED',
        scheduledFor: agreement.followUpDate,
        responseDeadlineAt: due ? addDays(now, DEFAULT_SHARED_RESPONSE_DEADLINE_DAYS) : null,
        summary: `Check in on the shared agreement: ${agreement.description}`,
      }, db),
    );
    if (due) await setFollowUpStatusAsJob(ids[ids.length - 1], 'OPEN', { openedAt: now }, db);
  }
  return ids;
}

type IndividualCommitmentForScheduling = { proposalId: string; ownerParticipantId: string; description: string };

export async function scheduleIndividualCommitmentTendingEntries(
  sessionId: string,
  commitments: IndividualCommitmentForScheduling[],
  scheduledFor: Date,
  now = new Date(),
  db: JobDb = getJobPrisma(),
): Promise<string[]> {
  const ids: string[] = [];
  const due = scheduledFor <= now;
  for (const c of commitments) {
    const id = await insertFollowUpAsJob({
      sessionId,
      proposalId: c.proposalId,
      type: 'SCHEDULED_INDIVIDUAL_COMMITMENT',
      scope: 'INDIVIDUAL',
      ownerParticipantId: c.ownerParticipantId,
      status: due ? 'OPEN' : 'SCHEDULED',
      scheduledFor,
      summary: `Check in on your individual commitment: ${c.description}`,
    }, db);
    if (due) await setFollowUpStatusAsJob(id, 'OPEN', { openedAt: now }, db);
    ids.push(id);
  }
  return ids;
}

// ============================================================================
// Reads
// ============================================================================

export async function listTendingEntries(sessionId: string, userId: string): Promise<TendingEntryDTO[]> {
  const viewer = await viewerFor(sessionId, userId);
  return entryDTOs(viewer, await loadFollowUpsForParticipant(sessionId, viewer.participantId));
}

interface CycleRow {
  followUpId: string;
  participantIds: string[];
  submittedParticipantIds: string[];
  waitingOn: string[];
  responseDeadlineAt: Date | null;
  status: TendingCoordinationStatus;
}

/** `v_follow_up_cycle` for the session's follow-ups. */
async function loadCycles(sessionId: string): Promise<CycleRow[]> {
  return prisma.$queryRaw<CycleRow[]>`
    SELECT follow_up_id AS "followUpId", participant_ids AS "participantIds",
           submitted_participant_ids AS "submittedParticipantIds", waiting_on AS "waitingOn",
           response_deadline_at AS "responseDeadlineAt", status
    FROM v_follow_up_cycle WHERE session_id = ${sessionId}::uuid`;
}

function cycleSummary(status: TendingCoordinationStatus): string {
  switch (status) {
    case TendingCoordinationStatus.WAITING_FOR_PARTNER:
      return 'Shared Tending choices are being held privately until the partner submits or the response window expires.';
    case TendingCoordinationStatus.READY_TO_RESOLVE:
      return 'All participants have submitted; shared Tending choices are ready for coordinated resolution.';
    case TendingCoordinationStatus.TIMED_OUT:
      return 'Tending proceeded with submitted responses after timeout.';
    default:
      return 'Shared Tending check-in resolved.';
  }
}

export async function listTendingCoordinationCycles(sessionId: string, userId: string): Promise<TendingCoordinationCycleDTO[]> {
  const viewer = await viewerFor(sessionId, userId);
  const entries = (await loadFollowUpsForParticipant(sessionId, viewer.participantId)).filter((e) => e.scope === 'SHARED');
  const byId = new Map(entries.map((e) => [e.id, e]));
  const cycles = (await loadCycles(sessionId))
    .filter((c) => byId.has(c.followUpId) && c.participantIds.includes(viewer.participantId))
    // A cycle exists once someone has checked in on an opened follow-up.
    .filter((c) => c.submittedParticipantIds.length > 0);
  return cycles
    .map((c) => {
      const e = byId.get(c.followUpId)!;
      return {
        id: e.id,
        sessionId,
        status: c.status,
        entryIds: [e.id],
        participantUserIds: c.participantIds.map((p) => userIdOf(viewer, p) ?? '').sort(),
        submittedUserIds: c.submittedParticipantIds.map((p) => userIdOf(viewer, p) ?? '').sort(),
        responseDeadlineAt: (c.responseDeadlineAt ?? addDays(e.openedAt ?? e.createdAt, DEFAULT_SHARED_RESPONSE_DEADLINE_DAYS)).toISOString(),
        resolvedAt: iso(e.completedAt),
        resultSummary: cycleSummary(c.status),
        createdAt: (e.openedAt ?? e.createdAt).toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 10);
}

function toNoteDTO(
  viewer: Viewer,
  note: { id: string; content: string; carryForward: boolean; carriedIntoCheckinId: string | null; createdAt: Date; updatedAt: Date },
  sharedAt: Date | null,
): TendingBetweenPeriodNoteDTO {
  return {
    id: note.id,
    sessionId: viewer.sessionId,
    userId: viewer.userId,
    content: note.content,
    carryForwardSelected: note.carryForward,
    consentToShareWithPartner: note.carriedIntoCheckinId !== null,
    shareConsentAt: iso(sharedAt),
    selectedForCheckinId: note.carriedIntoCheckinId,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

export async function listTendingBetweenPeriodNotes(sessionId: string, userId: string): Promise<TendingBetweenPeriodNoteDTO[]> {
  const viewer = await viewerFor(sessionId, userId);
  const notes = await prisma.followUpNote.findMany({
    where: { participantId: viewer.participantId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { carriedIntoCheckin: { select: { submittedAt: true } } },
  });
  return notes.map((n) => toNoteDTO(viewer, n, n.carriedIntoCheckin?.submittedAt ?? null));
}

export async function createTendingBetweenPeriodNote(args: {
  sessionId: string;
  userId: string;
  content: string;
}): Promise<TendingBetweenPeriodNoteDTO> {
  const viewer = await viewerFor(args.sessionId, args.userId);
  if (viewer.sessionStatus !== 'RESOLVED') {
    throw new TendingInvalidStateError('Between-period Tending notes require a resolved session');
  }
  const note = await prisma.followUpNote.create({ data: { participantId: viewer.participantId, content: args.content } });
  return toNoteDTO(viewer, note, null);
}

export async function listTendingHistory(sessionId: string, userId: string): Promise<TendingHistoryCycleDTO[]> {
  const viewer = await viewerFor(sessionId, userId);
  const entries = await loadFollowUpsForParticipant(sessionId, viewer.participantId);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const [checkins, cycles, reminders] = await Promise.all([
    loadCheckins(entries.map((e) => e.id), viewer.participantId),
    loadCycles(sessionId),
    loadReminders(viewer, entries.map((e) => e.id)),
  ]);
  const cycleOf = new Map(cycles.map((c) => [c.followUpId, c]));
  return checkins
    .filter((c) => c.participantId === viewer.participantId)
    .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
    .slice(0, 20)
    .map((c) => {
      const entry = byId.get(c.followUpId);
      const cycle = entry?.scope === 'SHARED' ? cycleOf.get(c.followUpId) : undefined;
      return {
        checkinId: c.id,
        sessionId,
        userId: viewer.userId,
        submittedAt: c.submittedAt.toISOString(),
        continueChoice: c.continueChoice,
        nextAction: c.nextAction,
        reflectionSummary: c.reflectionSummary,
        entryReviews: c.payload.entryOutcomes.map((o) => ({
          tendingEntryId: o.followUpId,
          summary: byId.get(o.followUpId)?.summary ?? null,
          scope: (byId.get(o.followUpId)?.scope ?? 'SHARED') as TendingEntryScope,
          followThroughStatus: o.followThroughStatus,
          helpfulnessStatus: o.helpfulnessStatus,
          blockerCategories: o.blockerCategories,
          whatHappened: o.whatHappened,
          helpedNeed: o.helpedNeed,
          stillWorthTrying: o.stillWorthTrying,
        })),
        needOutcomes: needOutcomeDTOs(viewer, c),
        adjustments: adjustmentDTOs(viewer, c),
        reminders: reminders.filter((r) => r.followUpId === c.followUpId).map((r) => toReminderDTO(viewer, r)),
        coordinationStatus: cycle?.status ?? null,
        coordinationSummary: cycle ? cycleSummary(cycle.status) : null,
      };
    });
}

async function getEntryForViewer(entryId: string, userId: string): Promise<{ viewer: Viewer; entry: FollowUpRow }> {
  const row = (await prisma.followUp.findUnique({ where: { id: entryId }, select: FOLLOW_UP_SELECT })) as FollowUpRow | null;
  if (!row) throw new TendingNotFoundError();
  const viewer = await viewerFor(row.sessionId, userId).catch(() => {
    throw new TendingNotFoundError();
  });
  const visible = row.scope === 'SHARED' || row.ownerParticipantId === viewer.participantId || row.optedInShared;
  if (!visible) throw new TendingNotFoundError();
  return { viewer, entry: row };
}

async function entryDTO(entryId: string, viewer: Viewer): Promise<TendingEntryDTO> {
  const row = (await prisma.followUp.findUnique({ where: { id: entryId }, select: FOLLOW_UP_SELECT })) as FollowUpRow;
  return (await entryDTOs(viewer, [row]))[0];
}

// ============================================================================
// Participant writes (APP connection)
// ============================================================================

export async function setIndividualEntryShare(args: {
  entryId: string;
  userId: string;
  optedInShared: boolean;
}): Promise<TendingEntryDTO> {
  const { viewer, entry } = await getEntryForViewer(args.entryId, args.userId);
  if (entry.scope !== 'INDIVIDUAL') throw new TendingInvalidStateError('Only INDIVIDUAL entries can be shared');
  if (entry.ownerParticipantId !== viewer.participantId) throw new TendingForbiddenError();

  // spec §1.5 follow_up: U owner — the owner's opt-in is the owner's write.
  await prisma.followUp.update({ where: { id: entry.id }, data: { optedInShared: args.optedInShared } });

  try {
    await publishSessionEvent(
      entry.sessionId,
      'notification.pending_action',
      {
        kind: args.optedInShared ? 'tending_entry_shared' : 'tending_entry_unshared',
        tendingEntryId: args.entryId,
        ownerUserId: args.userId,
      },
      args.userId,
    );
  } catch (error) {
    logger.warn('[tending] Failed to publish share-toggle event', { entryId: args.entryId, error });
  }
  return entryDTO(entry.id, viewer);
}

/** Write one check-in row (the participant's, app connection), its payload validated first. */
async function insertCheckin(args: {
  followUpId: string;
  participantId: string;
  nextAction: TendingNextAction | null;
  continueChoice: ContinueChoice | null;
  reflectionSummary: string | null;
  payload: unknown;
  submittedAt: Date;
}): Promise<string> {
  const payload = validateCheckinPayload(args.payload);
  const existing = await prisma.followUpCheckin.findUnique({
    where: { followUpId_participantId: { followUpId: args.followUpId, participantId: args.participantId } },
    select: { id: true },
  });
  if (existing) throw new TendingInvalidStateError('You have already checked in on this Tending entry');
  const row = await prisma.followUpCheckin.create({
    data: {
      followUpId: args.followUpId,
      participantId: args.participantId,
      nextAction: args.nextAction,
      continueChoice: args.continueChoice,
      reflectionSummary: args.reflectionSummary,
      payload,
      submittedAt: args.submittedAt,
    },
    select: { id: true },
  });
  return row.id;
}

/** After a check-in: the follow-up is COMPLETED once every expected participant has checked in, else PARTIAL. */
async function updateEntryProgressAsJob(entry: FollowUpRow, expected: number, now: Date): Promise<void> {
  const count = await prisma.followUpCheckin.count({ where: { followUpId: entry.id } });
  if (count >= expected) await setFollowUpStatusAsJob(entry.id, 'COMPLETED', { completedAt: now });
  else await setFollowUpStatusAsJob(entry.id, 'PARTIAL');
}

export async function submitTendingResponse(args: {
  entryId: string;
  userId: string;
  status: string;
  reflection?: string;
  continueChoice?: ContinueChoice;
}): Promise<TendingEntryDTO> {
  const { viewer, entry } = await getEntryForViewer(args.entryId, args.userId);
  if (entry.scope === 'INDIVIDUAL' && entry.ownerParticipantId !== viewer.participantId) throw new TendingForbiddenError();
  if (entry.status === 'SCHEDULED') throw new TendingInvalidStateError('Tending entry is not open yet');
  if (entry.status === 'CANCELLED' || entry.status === 'EXPIRED' || entry.status === 'COMPLETED') {
    throw new TendingInvalidStateError('Tending entry is no longer accepting responses');
  }
  const now = new Date();
  await insertCheckin({
    followUpId: entry.id,
    participantId: viewer.participantId,
    nextAction: null,
    continueChoice: args.continueChoice ?? null,
    reflectionSummary: args.reflection ?? null,
    payload: {
      ...emptyFollowUpCheckinPayload(),
      responses: [
        {
          followUpId: entry.id,
          status: args.status,
          reflection: args.reflection ?? null,
          continueChoice: args.continueChoice ?? null,
        },
      ],
    },
    submittedAt: now,
  });
  await updateEntryProgressAsJob(entry, entry.scope === 'INDIVIDUAL' ? 1 : viewer.humans.length, now);

  await publishSessionEvent(
    entry.sessionId,
    'notification.pending_action',
    { kind: 'tending_response_submitted', tendingEntryId: args.entryId, submittedBy: args.userId },
    args.userId,
  );
  return entryDTO(entry.id, viewer);
}

async function buildReentrySummary(viewer: Viewer, intent?: string): Promise<string> {
  const { loadAgreements, loadClosure, loadClosureItems, loadProposals, loadStage4Needs } = await import('./stage4-store');
  const [closure, items, agreements, proposals, needs] = await Promise.all([
    loadClosure(viewer.sessionId),
    loadClosureItems(viewer.sessionId),
    loadAgreements(viewer.sessionId),
    loadProposals(viewer.sessionId, viewer.participantId),
    loadStage4Needs(viewer.sessionId, viewer.participantId),
  ]);
  const commitments = proposals.filter((p) => items.individualCommitmentIds.includes(p.id));
  const open = needs.filter((n) => items.openNeedIds.includes(n.id));
  const agreed = agreements.filter((a) => a.status === 'AGREED');
  return [
    'Passive Tending re-entry context.',
    closure ? `Stage 4 closed as ${closure.kind}: ${closure.summary}` : null,
    intent ? `User intent: ${intent}` : null,
    agreed.length ? `Shared agreements: ${agreed.map((a) => a.description).join('; ')}` : null,
    commitments.length ? `Individual commitments: ${commitments.map((p) => p.description).join('; ')}` : null,
    // The viewer's own needs by their own label, the partner's by the shared text.
    open.length ? `Still-open needs: ${open.map((n) => n.label).join('; ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function createPassiveReentry(args: { sessionId: string; userId: string; intent?: string }): Promise<TendingEntryDTO> {
  const viewer = await viewerFor(args.sessionId, args.userId);
  if (viewer.sessionStatus !== 'RESOLVED') {
    throw new TendingInvalidStateError('Passive Tending re-entry requires a resolved session');
  }
  const now = new Date();
  const summary = await buildReentrySummary(viewer, args.intent);
  // spec §1.5 follow_up: I member — a re-entry is the member's own write.
  const row = await prisma.followUp.create({
    data: { sessionId: args.sessionId, type: 'USER_INITIATED_REENTRY', status: 'OPEN', openedAt: now, summary },
    select: { id: true },
  });
  return entryDTO(row.id, viewer);
}

export async function publishPartnerInvolvingReentryChoice(args: {
  sessionId: string;
  userId: string;
  tendingEntryId: string;
}): Promise<void> {
  await publishSessionEvent(
    args.sessionId,
    'notification.pending_action',
    { kind: 'tending_reentry_partner_action_requested', tendingEntryId: args.tendingEntryId, createdBy: args.userId },
    args.userId,
  );
}

// ============================================================================
// The structured check-in
// ============================================================================

export type SubmitTendingCheckinResult = {
  entries: TendingEntryDTO[];
  checkin?: TendingCheckinDTO;
  coordinationCycle?: TendingCoordinationCycleDTO;
  newSessionId?: string;
  continueChoice: ContinueChoice;
  nextScheduledFor?: Date | null;
};

function nextActionFromChoice(choice: ContinueChoice): TendingNextAction {
  switch (choice) {
    case ContinueChoice.FULL_CLOSURE:
      return TendingNextAction.FULL_CLOSURE;
    case ContinueChoice.EXTEND:
      return TendingNextAction.EXTEND;
    case ContinueChoice.NEW_PROCESS:
      return TendingNextAction.NEW_PROCESS;
    case ContinueChoice.PARTIAL_CLOSURE:
      return TendingNextAction.PARTIAL_CLOSURE;
    case ContinueChoice.ANOTHER_ROUND:
      return TendingNextAction.REOPEN_STRATEGY_WORK;
  }
}

export function recommendTendingNextAction(args: {
  continueChoice: ContinueChoice;
  entryOutcomes?: TendingCheckinEntryOutcomeInput[];
  needOutcomes?: TendingCheckinNeedOutcomeInput[];
}): TendingNextAction {
  const hasStillOpenNeed = (args.needOutcomes ?? []).some(
    (o) => o.resolutionStatus === TendingNeedResolutionStatus.STILL_OPEN || o.resolutionStatus === TendingNeedResolutionStatus.CHANGED,
  );
  const hasWeakFollowThrough = (args.entryOutcomes ?? []).some(
    (o) =>
      o.followThroughStatus === TendingFollowThroughStatus.DID_NOT_HAPPEN ||
      o.helpfulnessStatus === TendingHelpfulnessStatus.DID_NOT_HELP ||
      o.stillWorthTrying === false,
  );
  const hasPartialFollowThrough = (args.entryOutcomes ?? []).some(
    (o) =>
      o.followThroughStatus === TendingFollowThroughStatus.PARTLY_HAPPENED ||
      o.helpfulnessStatus === TendingHelpfulnessStatus.PARTLY_HELPED ||
      (o.blockerCategories?.length ?? 0) > 0,
  );
  const hasOnlyResolvedNeeds =
    (args.needOutcomes?.length ?? 0) > 0 &&
    args.needOutcomes!.every((o) => o.resolutionStatus === TendingNeedResolutionStatus.RESOLVED);
  if (hasStillOpenNeed && hasWeakFollowThrough) return TendingNextAction.REOPEN_STRATEGY_WORK;
  if (hasStillOpenNeed || hasPartialFollowThrough) return TendingNextAction.ADJUST_COMMITMENT;
  if (hasOnlyResolvedNeeds && args.continueChoice === ContinueChoice.FULL_CLOSURE) return TendingNextAction.FULL_CLOSURE;
  return nextActionFromChoice(args.continueChoice);
}

function buildNewProcessHandoffSummary(args: {
  reflection: string;
  entryOutcomes?: TendingCheckinEntryOutcomeInput[];
  needOutcomes?: Array<{ needLabel: string; resolutionStatus: string; changedNeedLabel?: string | null; note?: string | null }>;
}): string {
  const lines: Array<string | null> = ['Prior Tending handoff for linked new process.', args.reflection || null];
  for (const o of args.entryOutcomes ?? []) {
    lines.push(
      [
        `Entry ${o.tendingEntryId}: ${o.followThroughStatus}`,
        o.helpfulnessStatus ? `helpfulness=${o.helpfulnessStatus}` : null,
        o.blockerCategories?.length ? `blockers=${o.blockerCategories.join(', ')}` : null,
        o.whatHappened ? `what happened=${o.whatHappened}` : null,
        o.helpedNeed ? `need impact=${o.helpedNeed}` : null,
      ]
        .filter(Boolean)
        .join('; '),
    );
  }
  for (const o of args.needOutcomes ?? []) {
    lines.push(
      [
        `Need "${o.needLabel}": ${o.resolutionStatus}`,
        o.changedNeedLabel ? `changed to "${o.changedNeedLabel}"` : null,
        o.note ? `note=${o.note}` : null,
      ]
        .filter(Boolean)
        .join('; '),
    );
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * A need outcome names a shared need by its `need_share` id; its label is the
 * SHARED text (a SHARED-scope check-in is read by the co-participant — the
 * owner's private label must not ride into it).
 */
async function normalizeNeedOutcomes(
  viewer: Viewer,
  outcomes: TendingCheckinNeedOutcomeInput[] = [],
): Promise<FollowUpCheckinPayload['needOutcomes']> {
  const ids = outcomes.map((o) => o.needId).filter((id): id is string => Boolean(id));
  const shared = ids.length
    ? await prisma.needShare.findMany({
        where: { needId: { in: ids }, sessionId: viewer.sessionId },
        select: { needId: true, sharedText: true, participantId: true },
      })
    : [];
  const byId = new Map(shared.map((s) => [s.needId, s]));
  return outcomes.map((o) => {
    const s = o.needId ? byId.get(o.needId) : undefined;
    return {
      needId: s ? s.needId : null,
      needLabel: s ? s.sharedText : o.needLabel,
      sourceParticipantId: s ? s.participantId : o.sourceUserId ? (viewer.participantOfUser.get(o.sourceUserId) ?? null) : null,
      resolutionStatus: o.resolutionStatus,
      note: o.note ?? null,
      changedNeedLabel: o.changedNeedLabel ?? null,
      nextAction: o.nextAction ?? null,
    };
  });
}

export async function submitTendingCheckin(args: {
  sessionId: string;
  userId: string;
  orientations: TendingCheckinOrientations;
  entryOutcomes?: TendingCheckinEntryOutcomeInput[];
  needOutcomes?: TendingCheckinNeedOutcomeInput[];
  reminders?: TendingReminderInput[];
  adjustments?: TendingAdjustmentInput[];
  includedBetweenPeriodNoteIds?: string[];
  shareBetweenPeriodNoteIds?: string[];
  nextAction?: TendingNextAction;
  resolvedEnoughOverride?: boolean;
  resolvedEnoughOverrideNote?: string;
  now?: Date;
}): Promise<SubmitTendingCheckinResult> {
  const now = args.now ?? new Date();
  const viewer = await viewerFor(args.sessionId, args.userId);

  const open = (await loadFollowUpsForParticipant(args.sessionId, viewer.participantId)).filter(
    (e) => (e.status === 'OPEN' || e.status === 'PARTIAL') && (e.scope === 'SHARED' || e.ownerParticipantId === viewer.participantId),
  );
  if (open.length === 0) throw new TendingInvalidStateError('No open Tending entries to check in on');
  const already = new Set(
    (await prisma.followUpCheckin.findMany({
      where: { followUpId: { in: open.map((e) => e.id) }, participantId: viewer.participantId },
      select: { followUpId: true },
    })).map((c) => c.followUpId),
  );
  const openEntries = open.filter((e) => !already.has(e.id));
  if (openEntries.length === 0) throw new TendingInvalidStateError('You have already checked in on every open Tending entry');

  const choice = args.orientations.whatComesNext.continueChoice;
  const nextAction =
    args.nextAction ??
    args.orientations.whatComesNext.nextAction ??
    recommendTendingNextAction({ continueChoice: choice, entryOutcomes: args.entryOutcomes, needOutcomes: args.needOutcomes });
  const openIds = new Set(openEntries.map((e) => e.id));

  // --- Validation (as before) -----------------------------------------------
  const included = Array.from(new Set(args.includedBetweenPeriodNoteIds ?? []));
  const shareIds = Array.from(new Set(args.shareBetweenPeriodNoteIds ?? []));
  if (shareIds.some((id) => !included.includes(id))) {
    throw new TendingInvalidStateError('Shared between-period notes must also be selected for carry-forward');
  }
  const referenced = Array.from(new Set([...included, ...shareIds]));
  const notes = referenced.length
    ? await prisma.followUpNote.findMany({
        where: { id: { in: referenced }, participantId: viewer.participantId },
        select: { id: true, content: true, createdAt: true },
      })
    : [];
  if (notes.length !== referenced.length) {
    throw new TendingInvalidStateError('Between-period note references a non-private or non-session note');
  }
  for (const o of args.entryOutcomes ?? []) {
    if (!openIds.has(o.tendingEntryId)) throw new TendingInvalidStateError('Entry outcome references a non-open Tending entry');
  }
  const reminderInputs = [...(args.reminders ?? []), ...(args.orientations.whatComesNext.reminders ?? [])];
  for (const r of reminderInputs) {
    if (r.tendingEntryId && !openIds.has(r.tendingEntryId)) {
      throw new TendingInvalidStateError('Reminder references a non-open Tending entry');
    }
    if (r.scope === TendingReminderScope.SHARED) {
      const linked = r.tendingEntryId ? openEntries.find((e) => e.id === r.tendingEntryId) : null;
      if (!linked || linked.scope !== 'SHARED') throw new TendingInvalidStateError('Shared reminders require a shared Tending entry');
    }
  }
  for (const a of args.adjustments ?? []) {
    if (!openIds.has(a.tendingEntryId)) throw new TendingInvalidStateError('Adjustment references a non-open Tending entry');
    const linked = openEntries.find((e) => e.id === a.tendingEntryId);
    if (linked?.scope === 'INDIVIDUAL' && linked.ownerParticipantId !== viewer.participantId) throw new TendingForbiddenError();
  }
  if (choice === ContinueChoice.FULL_CLOSURE && !args.resolvedEnoughOverride) {
    if ((args.needOutcomes ?? []).some((o) => o.resolutionStatus !== TendingNeedResolutionStatus.RESOLVED)) {
      throw new TendingInvalidStateError(
        'Full closure requires submitted needs to be resolved or an explicit resolved-enough override',
      );
    }
  }
  const reflection = [
    args.orientations.whatWorked.reflection ? `What worked: ${args.orientations.whatWorked.reflection}` : null,
    args.orientations.whereMoreSupport.reflection ? `Where more support: ${args.orientations.whereMoreSupport.reflection}` : null,
    args.resolvedEnoughOverride
      ? `Resolved-enough override: ${args.resolvedEnoughOverrideNote ?? 'User explicitly chose to proceed.'}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  // --- The payload of each follow-up's check-in ------------------------------
  const needOutcomes = await normalizeNeedOutcomes(viewer, args.needOutcomes);
  const resolutions = args.orientations.whatComesNext.partialClosure ?? {};
  const sharedNotes = notes.filter((n) => shareIds.includes(n.id));
  const payloadFor = (entry: FollowUpRow, primary: boolean): FollowUpCheckinPayload => ({
    entryOutcomes: (args.entryOutcomes ?? [])
      .filter((o) => o.tendingEntryId === entry.id)
      .map((o) => ({
        followUpId: o.tendingEntryId,
        followThroughStatus: o.followThroughStatus,
        helpfulnessStatus: o.helpfulnessStatus ?? null,
        blockerCategories: o.blockerCategories ?? [],
        whatHappened: o.whatHappened ?? null,
        helpedNeed: o.helpedNeed ?? null,
        blockerNote: o.blockerNote ?? o.note ?? null,
        stillWorthTrying: o.stillWorthTrying ?? null,
      })),
    // Session-wide answers ride on the first follow-up's check-in only.
    needOutcomes: primary ? needOutcomes : [],
    adjustments: (args.adjustments ?? [])
      .filter((a) => a.tendingEntryId === entry.id)
      .map((a) => ({
        followUpId: a.tendingEntryId,
        privacyScope: a.privacyScope ?? TendingReminderScope.PRIVATE,
        revisedCommitmentText: a.revisedCommitmentText ?? null,
        revisedCadence: a.revisedCadence ?? null,
        revisedScope: a.revisedScope ?? null,
        revisedSuccessCriteria: a.revisedSuccessCriteria ?? null,
        reason: a.reason ?? null,
        blockerAddressed: a.blockerAddressed ?? [],
      })),
    partialClosures:
      choice === ContinueChoice.PARTIAL_CLOSURE
        ? [{ followUpId: entry.id, resolution: resolutions[entry.id] ?? PartialClosureResolution.CONTINUING }]
        : [],
    responses: [
      {
        followUpId: entry.id,
        status: 'CHECKIN',
        reflection:
          [
            reflection || null,
            args.orientations.whatWorked.perEntryNotes?.[entry.id]
              ? `Entry note - what worked: ${args.orientations.whatWorked.perEntryNotes[entry.id]}`
              : null,
            args.orientations.whereMoreSupport.perEntryNotes?.[entry.id]
              ? `Entry note - more support: ${args.orientations.whereMoreSupport.perEntryNotes[entry.id]}`
              : null,
          ]
            .filter(Boolean)
            .join('\n') || null,
        continueChoice: choice,
      },
    ],
    carriedNotes: primary
      ? sharedNotes.map((n) => ({ noteId: n.id, content: n.content, createdAt: n.createdAt.toISOString() }))
      : [],
  });

  // Validate every payload before anything is written.
  const payloads = openEntries.map((e, i) => ({ entry: e, payload: validateCheckinPayload(payloadFor(e, i === 0)) }));

  const checkinIds: string[] = [];
  for (const { entry, payload } of payloads) {
    checkinIds.push(
      await insertCheckin({
        followUpId: entry.id,
        participantId: viewer.participantId,
        nextAction,
        continueChoice: choice,
        reflectionSummary: reflection || null,
        payload,
        submittedAt: now,
      }),
    );
  }
  const primaryCheckinId = checkinIds[0];

  // Notes: included → carry_forward; shared → copied into the check-in, carried_into_checkin_id set.
  if (included.length) {
    await prisma.followUpNote.updateMany({
      where: { id: { in: included }, participantId: viewer.participantId },
      data: { carryForward: true },
    });
  }
  if (shareIds.length) {
    await prisma.followUpNote.updateMany({
      where: { id: { in: shareIds }, participantId: viewer.participantId },
      data: { carriedIntoCheckinId: primaryCheckinId },
    });
  }

  // Reminders: user-scoped rows.
  const createdReminders: ReminderRow[] = [];
  for (const r of reminderInputs) {
    createdReminders.push(
      await prisma.reminder.create({
        data: {
          userId: viewer.userId,
          followUpId: r.tendingEntryId ?? openEntries[0].id,
          scope: r.scope,
          remindAt: new Date(r.remindAt),
          cadence: r.cadence,
          note: r.note,
        },
      }),
    );
  }

  // --- State transitions -------------------------------------------------------
  let nextScheduledFor: Date | null = null;
  let newSessionId: string | undefined;
  const sharedEntries = openEntries.filter((e) => e.scope === 'SHARED');
  const individualEntries = openEntries.filter((e) => e.scope === 'INDIVIDUAL');

  // A shared follow-up is held for coordination: PARTIAL until every present human has checked in.
  for (const e of sharedEntries) {
    const count = await prisma.followUpCheckin.count({ where: { followUpId: e.id } });
    if (count < viewer.humans.length) await setFollowUpStatusAsJob(e.id, 'PARTIAL');
  }

  const toTransition = sharedEntries.length ? individualEntries : openEntries;
  if (toTransition.length) {
    switch (choice) {
      case ContinueChoice.ANOTHER_ROUND:
      case ContinueChoice.FULL_CLOSURE:
        for (const e of toTransition) await setFollowUpStatusAsJob(e.id, 'COMPLETED', { completedAt: now });
        break;
      case ContinueChoice.EXTEND: {
        nextScheduledFor = addDays(now, DEFAULT_EXTENSION_DAYS);
        const allResolved =
          (args.needOutcomes?.length ?? 0) > 0 &&
          args.needOutcomes!.every((o) => o.resolutionStatus === TendingNeedResolutionStatus.RESOLVED);
        for (const e of toTransition) {
          const outcome = (args.entryOutcomes ?? []).find((o) => o.tendingEntryId === e.id);
          if (outcome?.stillWorthTrying === false || allResolved) {
            await setFollowUpStatusAsJob(e.id, 'COMPLETED', { completedAt: now });
          } else {
            await scheduleNextRoundAsJob(e, nextScheduledFor, now);
          }
        }
        break;
      }
      case ContinueChoice.PARTIAL_CLOSURE: {
        nextScheduledFor = addDays(now, DEFAULT_EXTENSION_DAYS);
        for (const e of toTransition) {
          if ((resolutions[e.id] ?? PartialClosureResolution.CONTINUING) === PartialClosureResolution.RESOLVED) {
            await setFollowUpStatusAsJob(e.id, 'COMPLETED', { completedAt: now });
          } else {
            await scheduleNextRoundAsJob(e, nextScheduledFor, now);
          }
        }
        break;
      }
      case ContinueChoice.NEW_PROCESS: {
        for (const e of toTransition) await setFollowUpStatusAsJob(e.id, 'COMPLETED', { completedAt: now });
        newSessionId = await startLinkedProcess(viewer, buildNewProcessHandoffSummary({
          reflection,
          entryOutcomes: args.entryOutcomes,
          needOutcomes,
        }), now);
        break;
      }
      default:
        throw new TendingInvalidStateError(`Unsupported continueChoice: ${choice as string}`);
    }
    if (choice === ContinueChoice.FULL_CLOSURE) {
      await getJobPrisma().$executeRaw`SELECT app.session_set_status(${args.sessionId}::uuid, 'RESOLVED'::session_status)`;
    }
  }

  if (sharedEntries.length) {
    try {
      await publishSessionEvent(
        args.sessionId,
        'notification.pending_action',
        { kind: 'tending_checkin_submitted', continueChoice: choice, nextAction, submittedBy: args.userId, newSessionId },
        args.userId,
      );
    } catch (error) {
      logger.warn('[tending] Failed to publish check-in event', { sessionId: args.sessionId, error });
    }
  }

  const refreshed = (await prisma.followUp.findMany({
    where: { id: { in: openEntries.map((e) => e.id) } },
    orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: FOLLOW_UP_SELECT,
  })) as FollowUpRow[];
  const entries = await entryDTOs(viewer, refreshed);
  const [primaryCheckin] = await loadCheckins([openEntries[0].id], viewer.participantId).then((rows) =>
    rows.filter((c) => c.id === primaryCheckinId),
  );
  const cycles = sharedEntries.length ? await listTendingCoordinationCycles(args.sessionId, args.userId) : [];
  return {
    entries,
    checkin: primaryCheckin
      ? {
          id: primaryCheckin.id,
          sessionId: args.sessionId,
          userId: viewer.userId,
          coordinationCycleId: sharedEntries[0]?.id ?? null,
          nextAction: primaryCheckin.nextAction,
          continueChoice: primaryCheckin.continueChoice,
          reflectionSummary: primaryCheckin.reflectionSummary,
          submittedAt: primaryCheckin.submittedAt.toISOString(),
          createdAt: primaryCheckin.createdAt.toISOString(),
          entryOutcomes: entryOutcomeDTOs(viewer, primaryCheckin),
          needOutcomes: needOutcomeDTOs(viewer, primaryCheckin),
          reminders: createdReminders.map((r) => toReminderDTO(viewer, r)),
          adjustments: adjustmentDTOs(viewer, primaryCheckin),
        }
      : undefined,
    coordinationCycle: cycles.find((c) => sharedEntries.some((e) => e.id === c.id)),
    newSessionId,
    continueChoice: choice,
    nextScheduledFor,
  };
}

/**
 * NEW_PROCESS: the current session RESOLVED, a new CREATED session linked
 * back to it (previous_session_id) with the caller as its first participant,
 * and the hand-off summary as a SYSTEM message in their MAIN conversation (job).
 */
async function startLinkedProcess(viewer: Viewer, handoff: string, now: Date): Promise<string> {
  await getJobPrisma().$executeRaw`SELECT app.session_set_status(${viewer.sessionId}::uuid, 'RESOLVED'::session_status)`;
  const { sessionId, conversationId } = await prisma.$transaction(async (tx) => {
    const session = await tx.session.create({
      data: { relationshipId: viewer.relationshipId, status: 'CREATED', previousSessionId: viewer.sessionId, topicFrame: 'Tending follow-up' },
      select: { id: true },
    });
    const participant = await tx.participant.create({
      data: { sessionId: session.id, userId: viewer.userId, kind: 'human' },
      select: { id: true },
    });
    const conversation = await tx.conversation.create({
      data: { participantId: participant.id, kind: 'MAIN' },
      select: { id: true },
    });
    return { sessionId: session.id, conversationId: conversation.id };
  });
  await createFacilitatorMessage({ conversationId, role: 'SYSTEM', content: handoff, createdAt: now });
  return sessionId;
}

// ============================================================================
// Jobs (JOB connection)
// ============================================================================

/**
 * Open every due scheduled follow-up (sql_follow_up_due: status SCHEDULED by
 * scheduled_for) — runs as the job. A SHARED follow-up gets its response
 * deadline (the coordination window) when it opens.
 */
export async function openDueTendingEntries(now = new Date()): Promise<{ opened: number; entryIds: string[] }> {
  const job = getJobPrisma();
  const due = await job.$queryRaw<
    Array<{ id: string; session_id: string; scope: 'SHARED' | 'INDIVIDUAL'; owner_participant_id: string | null }>
  >`
    SELECT id, session_id, scope::text AS scope, owner_participant_id FROM follow_up
    WHERE status = 'SCHEDULED' AND scheduled_for <= ${now}
      AND type IN ('SCHEDULED_SHARED_AGREEMENT', 'SCHEDULED_INDIVIDUAL_COMMITMENT')
    ORDER BY scheduled_for, id`;
  const entryIds: string[] = [];
  for (const entry of due) {
    const n = await job.$executeRaw`
      UPDATE follow_up SET status = 'OPEN', opened_at = ${now},
        response_deadline_at = CASE WHEN scope = 'SHARED' THEN ${addDays(now, DEFAULT_SHARED_RESPONSE_DEADLINE_DAYS)}::timestamptz
                                    ELSE response_deadline_at END
      WHERE id = ${entry.id}::uuid AND status = 'SCHEDULED'`;
    if (n === 0) continue;
    entryIds.push(entry.id);
    try {
      if (entry.scope === 'INDIVIDUAL' && entry.owner_participant_id) {
        const [owner] = await job.$queryRaw<Array<{ user_id: string | null }>>`
          SELECT user_id FROM participant WHERE id = ${entry.owner_participant_id}::uuid`;
        if (owner?.user_id) {
          await publishUserEvent(owner.user_id, 'session.updated', {
            sessionId: entry.session_id,
            kind: 'tending_checkin_opened',
            tendingEntryId: entry.id,
            scope: entry.scope,
          });
        }
      } else {
        await publishSessionEvent(entry.session_id, 'notification.pending_action', {
          kind: 'tending_checkin_opened',
          tendingEntryId: entry.id,
          scope: entry.scope,
        });
      }
    } catch (error) {
      logger.warn('[tending] Failed to publish opened check-in event', { entryId: entry.id, error });
    }
  }
  return { opened: entryIds.length, entryIds };
}

function nextReminderDate(remindAt: Date, cadence: string | null): Date | null {
  const normalized = cadence?.trim().toUpperCase().replace(/[\s-]+/g, '_') ?? 'ONCE';
  const next = new Date(remindAt.getTime());
  switch (normalized) {
    case 'WEEKLY':
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case 'MONTHLY':
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    case 'EVERY_COUPLE_MONTHS':
    case 'EVERY_TWO_MONTHS':
    case 'BIMONTHLY':
      next.setUTCMonth(next.getUTCMonth() + 2);
      return next;
    default:
      return null;
  }
}

/** Deliver due reminders (sql_reminder_due) — the job moves status / the next instant. */
export async function processDueTendingReminders(now = new Date()): Promise<{ delivered: number; reminderIds: string[] }> {
  const job = getJobPrisma();
  const due = await job.$queryRaw<
    Array<{ id: string; follow_up_id: string | null; remind_at: Date; cadence: string | null; user_id: string; scope: string; note: string | null }>
  >`
    SELECT r.id, r.follow_up_id, r.remind_at, r.cadence, r.user_id, r.scope::text AS scope, NULL::text AS note
    FROM reminder r WHERE r.status = 'SCHEDULED' AND r.remind_at <= ${now} ORDER BY r.remind_at, r.id`;
  const reminderIds: string[] = [];
  for (const r of due) {
    const next = nextReminderDate(r.remind_at, r.cadence);
    if (next) await job.$executeRaw`UPDATE reminder SET remind_at = ${next}, status = 'SCHEDULED' WHERE id = ${r.id}::uuid`;
    else await job.$executeRaw`UPDATE reminder SET status = 'DELIVERED' WHERE id = ${r.id}::uuid`;
    reminderIds.push(r.id);
    try {
      const [fu] = r.follow_up_id
        ? await job.$queryRaw<Array<{ session_id: string }>>`SELECT session_id FROM follow_up WHERE id = ${r.follow_up_id}::uuid`
        : [];
      const payload = { kind: 'tending_reminder_due', reminderId: r.id, tendingEntryId: r.follow_up_id, scope: r.scope, userId: r.user_id };
      if (r.scope === 'PRIVATE' || !fu) {
        await publishUserEvent(r.user_id, 'session.updated', { sessionId: fu?.session_id, ...payload });
      } else {
        await publishSessionEvent(fu.session_id, 'notification.pending_action', payload);
      }
    } catch (error) {
      logger.warn('[tending] Failed to publish reminder due event', { reminderId: r.id, error });
    }
  }
  return { delivered: reminderIds.length, reminderIds };
}

/**
 * Report the shared follow-ups whose coordination window has passed
 * (`v_follow_up_cycle` status TIMED_OUT is computed from response_deadline_at;
 * nothing is stored). Publishes one event per follow-up.
 */
export async function resolveTimedOutTendingCoordinationCycles(now = new Date()): Promise<{ resolved: number; cycleIds: string[] }> {
  const rows = await prisma.$queryRaw<Array<{ follow_up_id: string; session_id: string; waiting_on: string[]; submitted: string[] }>>`
    SELECT c.follow_up_id, c.session_id,
           ARRAY(SELECT p.user_id::text FROM participant p WHERE p.id = ANY(c.waiting_on) ORDER BY p.joined_at, p.id) AS waiting_on,
           ARRAY(SELECT p.user_id::text FROM participant p WHERE p.id = ANY(c.submitted_participant_ids) ORDER BY p.joined_at, p.id) AS submitted
    FROM v_follow_up_cycle c JOIN follow_up f ON f.id = c.follow_up_id
    WHERE f.scope = 'SHARED' AND f.status IN ('OPEN', 'PARTIAL') AND f.response_deadline_at <= ${now}`;
  for (const r of rows) {
    try {
      await publishSessionEvent(r.session_id, 'notification.pending_action', {
        kind: 'tending_coordination_timed_out',
        coordinationCycleId: r.follow_up_id,
        submittedUserIds: r.submitted,
        missingUserIds: r.waiting_on,
      });
    } catch (error) {
      logger.warn('[tending] Failed to publish coordination timeout event', { followUpId: r.follow_up_id, error });
    }
  }
  return { resolved: rows.length, cycleIds: rows.map((r) => r.follow_up_id) };
}

/**
 * Resolve shared follow-ups every present human has checked in on
 * (`v_follow_up_cycle` READY_TO_RESOLVE): the check-ins' choices decide
 * (extend together → the next round; full closure with nothing open →
 * COMPLETED; partial closure → COMPLETED, plus a next round unless both
 * closed it; anything else is held for a mediated prompt).
 */
export async function resolveReadyTendingCoordinationCycles(now = new Date()): Promise<{ resolved: number; cycleIds: string[] }> {
  const ready = await prisma.$queryRaw<Array<{ follow_up_id: string }>>`
    SELECT c.follow_up_id FROM v_follow_up_cycle c JOIN follow_up f ON f.id = c.follow_up_id
    WHERE c.status = 'READY_TO_RESOLVE' AND f.scope = 'SHARED' AND f.status IN ('OPEN', 'PARTIAL')`;
  const cycleIds: string[] = [];
  for (const { follow_up_id: id } of ready) {
    const entry = (await prisma.followUp.findUnique({ where: { id }, select: FOLLOW_UP_SELECT })) as FollowUpRow;
    const checkins = (
      await prisma.followUpCheckin.findMany({ where: { followUpId: id }, select: { continueChoice: true, payload: true } })
    ).map((c) => ({ continueChoice: c.continueChoice as ContinueChoice | null, payload: readPayload(c.payload) }));
    const choices = checkins.map((c) => c.continueChoice).filter((c): c is ContinueChoice => Boolean(c));
    const every = (c: ContinueChoice) => choices.length > 0 && choices.every((x) => x === c);
    const failed = checkins.some((c) =>
      c.payload.entryOutcomes.some(
        (o) =>
          o.followThroughStatus === TendingFollowThroughStatus.DID_NOT_HAPPEN ||
          o.helpfulnessStatus === TendingHelpfulnessStatus.DID_NOT_HELP ||
          o.stillWorthTrying === false,
      ),
    );
    const stillOpen = checkins.some((c) =>
      c.payload.needOutcomes.some((o) =>
        [TendingNeedResolutionStatus.STILL_OPEN, TendingNeedResolutionStatus.CHANGED, TendingNeedResolutionStatus.NOT_SURE].includes(
          o.resolutionStatus,
        ),
      ),
    );
    const bothClosed =
      checkins.length > 0 &&
      checkins.every((c) => c.payload.partialClosures.some((p) => p.followUpId === id && p.resolution === PartialClosureResolution.RESOLVED));
    let resultSummary: string;
    let nextScheduledFor: Date | null = null;
    if (every(ContinueChoice.EXTEND) && !(failed && stillOpen)) {
      nextScheduledFor = addDays(now, DEFAULT_EXTENSION_DAYS);
      await scheduleNextRoundAsJob(entry, nextScheduledFor, now);
      resultSummary = `Both participants chose extension. Shared Tending continues until ${nextScheduledFor.toISOString()}.`;
    } else if (every(ContinueChoice.FULL_CLOSURE) && !stillOpen) {
      await setFollowUpStatusAsJob(id, 'COMPLETED', { completedAt: now });
      await getJobPrisma().$executeRaw`SELECT app.session_set_status(${entry.sessionId}::uuid, 'RESOLVED'::session_status)`;
      resultSummary = 'Both participants chose full closure and no submitted need remains open. Shared Tending is complete.';
    } else if (every(ContinueChoice.PARTIAL_CLOSURE) || (choices.includes(ContinueChoice.EXTEND) && choices.includes(ContinueChoice.PARTIAL_CLOSURE))) {
      if (bothClosed) {
        await setFollowUpStatusAsJob(id, 'COMPLETED', { completedAt: now });
        resultSummary = 'Both participants closed this shared entry.';
      } else {
        nextScheduledFor = addDays(now, DEFAULT_EXTENSION_DAYS);
        await scheduleNextRoundAsJob(entry, nextScheduledFor, now);
        resultSummary = 'Not every participant closed this shared entry; it continues for another check-in.';
      }
    } else if (choices.includes(ContinueChoice.NEW_PROCESS)) {
      resultSummary = 'At least one participant chose a new process. Partner-involving consent and mediated coordination are required before creating a linked shared session.';
    } else if (choices.includes(ContinueChoice.ANOTHER_ROUND) || (failed && stillOpen)) {
      resultSummary = 'At least one participant reported failed follow-through or a still-open need. Shared Tending should move to adjustment or strategy reopening instead of blind extension.';
    } else {
      resultSummary = 'Participants submitted mixed Tending choices. Shared entries remain held for a mediated next-step prompt.';
    }
    cycleIds.push(id);
    try {
      await publishSessionEvent(entry.sessionId, 'notification.pending_action', {
        kind: 'tending_coordination_resolved',
        coordinationCycleId: id,
        resultSummary,
        nextScheduledFor: nextScheduledFor?.toISOString() ?? null,
      });
    } catch (error) {
      logger.warn('[tending] Failed to publish coordination resolved event', { followUpId: id, error });
    }
  }
  return { resolved: cycleIds.length, cycleIds };
}

// Re-exported for prompt context (stream-turn-context's Tending helper).
export { TendingBlockerCategory };
