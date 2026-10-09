import { Prisma } from '../generated/prisma/client';
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
  TendingHistoryEntryReviewDTO,
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
} from '@meet-without-fear/shared';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { publishSessionEvent, publishUserEvent } from './realtime';

type Tx = Prisma.TransactionClient;

function buildTendingCoordinationKey(sessionId: string, entryIds: string[]): string {
  return `${sessionId}:${[...entryIds].sort().join('|')}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

type AgreementForScheduling = {
  id: string;
  description: string;
  followUpDate: Date | null;
};

type TendingEntryWithResponses = {
  id: string;
  sessionId: string;
  agreementId: string | null;
  type: TendingEntryType;
  scope: TendingEntryScope;
  ownerUserId: string | null;
  optedInShared: boolean;
  status: TendingEntryStatus;
  scheduledFor: Date | null;
  openedAt: Date | null;
  completedAt: Date | null;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
  responses: Array<{
    id: string;
    tendingEntryId: string;
    userId: string;
    checkinId: string | null;
    status: string;
    reflection: string | null;
    continueChoice: ContinueChoice | null;
    submittedAt: Date;
  }>;
  entryOutcomes?: Array<{
    id: string;
    checkinId: string;
    tendingEntryId: string;
    responseId: string | null;
    userId: string;
    followThroughStatus: any;
    helpfulnessStatus: any | null;
    blockerCategories: any[];
    whatHappened: string | null;
    helpedNeed: string | null;
    blockerNote: string | null;
    stillWorthTrying: boolean | null;
    createdAt: Date;
  }>;
  reminders?: Array<{
    id: string;
    sessionId: string;
    checkinId: string | null;
    tendingEntryId: string | null;
    userId: string;
    scope: any;
    remindAt: Date;
    cadence: string | null;
    note: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
};

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

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toResponseDTO(response: TendingEntryWithResponses['responses'][number]): TendingResponseDTO {
  return {
    id: response.id,
    tendingEntryId: response.tendingEntryId,
    userId: response.userId,
    checkinId: response.checkinId ?? null,
    status: response.status as TendingResponseStatus,
    reflection: response.reflection,
    continueChoice: response.continueChoice,
    submittedAt: response.submittedAt.toISOString(),
  };
}

function toEntryOutcomeDTO(outcome: NonNullable<TendingEntryWithResponses['entryOutcomes']>[number]): TendingEntryOutcomeDTO {
  return {
    id: outcome.id,
    checkinId: outcome.checkinId,
    tendingEntryId: outcome.tendingEntryId,
    responseId: outcome.responseId,
    userId: outcome.userId,
    followThroughStatus: outcome.followThroughStatus,
    helpfulnessStatus: outcome.helpfulnessStatus,
    blockerCategories: outcome.blockerCategories,
    whatHappened: outcome.whatHappened,
    helpedNeed: outcome.helpedNeed,
    blockerNote: outcome.blockerNote,
    stillWorthTrying: outcome.stillWorthTrying,
    createdAt: outcome.createdAt.toISOString(),
  };
}

function toReminderDTO(reminder: NonNullable<TendingEntryWithResponses['reminders']>[number]): TendingReminderDTO {
  return {
    id: reminder.id,
    sessionId: reminder.sessionId,
    checkinId: reminder.checkinId,
    tendingEntryId: reminder.tendingEntryId,
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

function toAdjustmentDTO(adjustment: {
  id: string;
  sessionId: string;
  checkinId: string;
  tendingEntryId: string;
  userId: string;
  privacyScope: any;
  revisedCommitmentText: string | null;
  revisedCadence: string | null;
  revisedScope: string | null;
  revisedSuccessCriteria: string | null;
  reason: string | null;
  blockerAddressed: any[];
  createdAt: Date;
}): TendingAdjustmentDTO {
  return {
    id: adjustment.id,
    sessionId: adjustment.sessionId,
    checkinId: adjustment.checkinId,
    tendingEntryId: adjustment.tendingEntryId,
    userId: adjustment.userId,
    privacyScope: adjustment.privacyScope as TendingReminderScope,
    revisedCommitmentText: adjustment.revisedCommitmentText,
    revisedCadence: adjustment.revisedCadence,
    revisedScope: adjustment.revisedScope,
    revisedSuccessCriteria: adjustment.revisedSuccessCriteria,
    reason: adjustment.reason,
    blockerAddressed: adjustment.blockerAddressed,
    createdAt: adjustment.createdAt.toISOString(),
  };
}

function toHistoryEntryReviewDTO(outcome: {
  tendingEntryId: string;
  tendingEntry?: { summary: string | null; scope: any } | null;
  followThroughStatus: any;
  helpfulnessStatus: any | null;
  blockerCategories: any[];
  whatHappened: string | null;
  helpedNeed: string | null;
  stillWorthTrying: boolean | null;
}): TendingHistoryEntryReviewDTO {
  return {
    tendingEntryId: outcome.tendingEntryId,
    summary: outcome.tendingEntry?.summary ?? null,
    scope: outcome.tendingEntry?.scope as TendingEntryScope,
    followThroughStatus: outcome.followThroughStatus as TendingFollowThroughStatus,
    helpfulnessStatus: outcome.helpfulnessStatus as TendingHelpfulnessStatus | null,
    blockerCategories: outcome.blockerCategories as TendingBlockerCategory[],
    whatHappened: outcome.whatHappened,
    helpedNeed: outcome.helpedNeed,
    stillWorthTrying: outcome.stillWorthTrying,
  };
}

function toBetweenPeriodNoteDTO(note: {
  id: string;
  sessionId: string;
  userId: string;
  content: string;
  carryForwardSelected: boolean;
  consentToShareWithPartner: boolean;
  shareConsentAt: Date | null;
  selectedForCheckinId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): TendingBetweenPeriodNoteDTO {
  return {
    id: note.id,
    sessionId: note.sessionId,
    userId: note.userId,
    content: note.content,
    carryForwardSelected: note.carryForwardSelected,
    consentToShareWithPartner: note.consentToShareWithPartner,
    shareConsentAt: iso(note.shareConsentAt),
    selectedForCheckinId: note.selectedForCheckinId,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

function toEntryDTO(entry: TendingEntryWithResponses, userId: string): TendingEntryDTO {
  const myResponse = entry.responses.find((response) => response.userId === userId) ?? null;
  const latestOutcome = (entry.entryOutcomes ?? [])
    .filter((outcome) => outcome.userId === userId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;

  return {
    id: entry.id,
    sessionId: entry.sessionId,
    agreementId: entry.agreementId,
    type: entry.type,
    scope: entry.scope,
    ownerUserId: entry.ownerUserId,
    optedInShared: entry.optedInShared,
    status: entry.status,
    scheduledFor: iso(entry.scheduledFor),
    openedAt: iso(entry.openedAt),
    completedAt: iso(entry.completedAt),
    summary: entry.summary,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    myResponse: myResponse ? toResponseDTO(myResponse) : null,
    responseCount: entry.responses.length,
    latestOutcome: latestOutcome ? toEntryOutcomeDTO(latestOutcome) : null,
    reminders: (entry.reminders ?? [])
      .filter((reminder) => reminder.userId === userId || reminder.scope === TendingReminderScope.SHARED)
      .map(toReminderDTO),
  };
}

async function assertSessionMember(sessionId: string, userId: string) {
  const session = await prisma.session.findFirst({
    where: {
      id: sessionId,
      relationship: { members: { some: { userId } } },
    },
    include: {
      relationship: {
        include: {
          members: { select: { userId: true } },
        },
      },
    },
  });

  if (!session) throw new TendingNotFoundError();
  return session;
}

function buildScheduledSummary(agreement: AgreementForScheduling): string {
  return `Check in on the shared agreement: ${agreement.description}`;
}

export async function scheduleSharedAgreementTendingEntries(
  tx: Tx,
  sessionId: string,
  agreements: AgreementForScheduling[],
  now = new Date()
): Promise<string[]> {
  const createdIds: string[] = [];

  for (const agreement of agreements) {
    if (!agreement.followUpDate) continue;

    const entry = await tx.tendingEntry.create({
      data: {
        sessionId,
        agreementId: agreement.id,
        type: TendingEntryType.SCHEDULED_SHARED_AGREEMENT_CHECKIN,
        scope: TendingEntryScope.SHARED,
        status:
          agreement.followUpDate <= now
            ? TendingEntryStatus.OPEN
            : TendingEntryStatus.SCHEDULED,
        scheduledFor: agreement.followUpDate,
        openedAt: agreement.followUpDate <= now ? now : null,
        summary: buildScheduledSummary(agreement),
      },
    });
    createdIds.push(entry.id);
  }

  return createdIds;
}

type IndividualCommitmentForScheduling = {
  proposalId: string;
  ownerUserId: string;
  description: string;
};

function buildIndividualCommitmentSummary(commitment: IndividualCommitmentForScheduling): string {
  return `Check in on your individual commitment: ${commitment.description}`;
}

export async function scheduleIndividualCommitmentTendingEntries(
  tx: Tx,
  sessionId: string,
  commitments: IndividualCommitmentForScheduling[],
  scheduledFor: Date,
  now = new Date()
): Promise<string[]> {
  const createdIds: string[] = [];
  for (const commitment of commitments) {
    const isDue = scheduledFor <= now;
    const entry = await tx.tendingEntry.create({
      data: {
        sessionId,
        type: TendingEntryType.SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN,
        scope: TendingEntryScope.INDIVIDUAL,
        ownerUserId: commitment.ownerUserId,
        optedInShared: false,
        status: isDue ? TendingEntryStatus.OPEN : TendingEntryStatus.SCHEDULED,
        scheduledFor,
        openedAt: isDue ? now : null,
        summary: buildIndividualCommitmentSummary(commitment),
      },
    });
    createdIds.push(entry.id);
  }
  return createdIds;
}

export async function listTendingEntries(sessionId: string, userId: string): Promise<TendingEntryDTO[]> {
  await assertSessionMember(sessionId, userId);

  const entries = (await prisma.tendingEntry.findMany({
    where: {
      sessionId,
      OR: [
        { scope: TendingEntryScope.SHARED },
        { scope: TendingEntryScope.INDIVIDUAL, ownerUserId: userId },
        { scope: TendingEntryScope.INDIVIDUAL, optedInShared: true },
      ],
    },
    orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
    include: { responses: true, entryOutcomes: true, reminders: true },
  })) as TendingEntryWithResponses[];

  return entries.map((entry) => toEntryDTO(entry, userId));
}

export async function listTendingCoordinationCycles(
  sessionId: string,
  userId: string
): Promise<TendingCoordinationCycleDTO[]> {
  await assertSessionMember(sessionId, userId);

  const cycles = await prisma.tendingCoordinationCycle.findMany({
    where: {
      sessionId,
      participantUserIds: { has: userId },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 10,
  });

  return cycles.map(toCoordinationCycleDTO);
}

export async function listTendingBetweenPeriodNotes(
  sessionId: string,
  userId: string
): Promise<TendingBetweenPeriodNoteDTO[]> {
  await assertSessionMember(sessionId, userId);

  const notes = await prisma.tendingBetweenPeriodNote.findMany({
    where: { sessionId, userId },
    orderBy: [{ createdAt: 'asc' }],
  });

  return notes.map(toBetweenPeriodNoteDTO);
}

export async function createTendingBetweenPeriodNote(args: {
  sessionId: string;
  userId: string;
  content: string;
}): Promise<TendingBetweenPeriodNoteDTO> {
  const session = await assertSessionMember(args.sessionId, args.userId);
  if (session.status !== 'RESOLVED') {
    throw new TendingInvalidStateError('Between-period Tending notes require a resolved session');
  }

  const note = await prisma.tendingBetweenPeriodNote.create({
    data: {
      sessionId: args.sessionId,
      userId: args.userId,
      content: args.content,
    },
  });

  return toBetweenPeriodNoteDTO(note);
}

export async function listTendingHistory(
  sessionId: string,
  userId: string
): Promise<TendingHistoryCycleDTO[]> {
  await assertSessionMember(sessionId, userId);

  const checkins = await prisma.tendingCheckin.findMany({
    where: { sessionId, userId },
    orderBy: [{ submittedAt: 'desc' }],
    take: 20,
    include: {
      coordinationCycle: true,
      entryOutcomes: {
        include: {
          tendingEntry: { select: { summary: true, scope: true } },
        },
        orderBy: [{ createdAt: 'asc' }],
      },
      needOutcomes: { orderBy: [{ createdAt: 'asc' }] },
      reminders: { orderBy: [{ remindAt: 'asc' }] },
      adjustments: { orderBy: [{ createdAt: 'asc' }] },
    },
  });

  return checkins.map((checkin) => ({
    checkinId: checkin.id,
    sessionId: checkin.sessionId,
    userId: checkin.userId,
    submittedAt: checkin.submittedAt.toISOString(),
    continueChoice: checkin.continueChoice as ContinueChoice | null,
    nextAction: checkin.nextAction as TendingNextAction | null,
    reflectionSummary: checkin.reflectionSummary,
    entryReviews: checkin.entryOutcomes.map(toHistoryEntryReviewDTO),
    needOutcomes: checkin.needOutcomes.map(toNeedOutcomeDTO),
    adjustments: checkin.adjustments.map(toAdjustmentDTO),
    reminders: checkin.reminders.map(toReminderDTO),
    coordinationStatus: checkin.coordinationCycle?.status as TendingCoordinationStatus | null | undefined,
    coordinationSummary: checkin.coordinationCycle?.resultSummary ?? null,
  }));
}

export async function setIndividualEntryShare(args: {
  entryId: string;
  userId: string;
  optedInShared: boolean;
}): Promise<TendingEntryDTO> {
  const entry = await getEntryForUser(args.entryId, args.userId);
  if (entry.scope !== TendingEntryScope.INDIVIDUAL) {
    throw new TendingInvalidStateError('Only INDIVIDUAL entries can be shared');
  }
  if (entry.ownerUserId !== args.userId) {
    throw new TendingForbiddenError();
  }

  await prisma.tendingEntry.update({
    where: { id: args.entryId },
    data: { optedInShared: args.optedInShared },
  });

  try {
    await publishSessionEvent(entry.sessionId, 'notification.pending_action', {
      kind: args.optedInShared ? 'tending_entry_shared' : 'tending_entry_unshared',
      tendingEntryId: args.entryId,
      ownerUserId: args.userId,
    }, args.userId);
  } catch (error) {
    logger.warn('[tending] Failed to publish share-toggle event', { entryId: args.entryId, error });
  }

  const updated = await getEntryForUser(args.entryId, args.userId);
  return toEntryDTO(updated, args.userId);
}

async function getEntryForUser(entryId: string, userId: string) {
  const entry = (await prisma.tendingEntry.findFirst({
    where: {
      id: entryId,
      session: { relationship: { members: { some: { userId } } } },
    },
    include: {
      responses: true,
      session: {
        include: {
          relationship: {
            include: {
              members: { select: { userId: true } },
            },
          },
        },
      },
    },
  })) as (TendingEntryWithResponses & {
    session: { relationship: { members: Array<{ userId: string }> } };
  }) | null;

  if (!entry) throw new TendingNotFoundError();
  return entry;
}

export async function submitTendingResponse(args: {
  entryId: string;
  userId: string;
  status: string;
  reflection?: string;
  continueChoice?: ContinueChoice;
}): Promise<TendingEntryDTO> {
  const entry = await getEntryForUser(args.entryId, args.userId);
  if (entry.scope === TendingEntryScope.INDIVIDUAL && entry.ownerUserId !== args.userId) {
    throw new TendingForbiddenError();
  }
  if (entry.status === TendingEntryStatus.SCHEDULED) {
    throw new TendingInvalidStateError('Tending entry is not open yet');
  }
  if (entry.status === TendingEntryStatus.CANCELLED || entry.status === TendingEntryStatus.EXPIRED) {
    throw new TendingInvalidStateError('Tending entry is no longer accepting responses');
  }

  const now = new Date();
  const memberCount = entry.scope === TendingEntryScope.INDIVIDUAL
    ? 1
    : entry.session.relationship.members.length;
  await prisma.$transaction(async (tx) => {
    await tx.tendingResponse.upsert({
      where: {
        tendingEntryId_userId: {
          tendingEntryId: args.entryId,
          userId: args.userId,
        },
      },
      create: {
        tendingEntryId: args.entryId,
        userId: args.userId,
        status: args.status,
        reflection: args.reflection,
        continueChoice: args.continueChoice,
        submittedAt: now,
      },
      update: {
        status: args.status,
        reflection: args.reflection,
        continueChoice: args.continueChoice,
        submittedAt: now,
      },
    });

    const responseCount = await tx.tendingResponse.count({
      where: { tendingEntryId: args.entryId },
    });

    await tx.tendingEntry.update({
      where: { id: args.entryId },
      data: {
        status:
          responseCount >= memberCount
            ? TendingEntryStatus.COMPLETED
            : TendingEntryStatus.PARTIAL,
        completedAt: responseCount >= memberCount ? now : null,
      },
    });
  });

  await publishSessionEvent(entry.sessionId, 'notification.pending_action', {
    kind: 'tending_response_submitted',
    tendingEntryId: args.entryId,
    submittedBy: args.userId,
  }, args.userId);

  const updated = await getEntryForUser(args.entryId, args.userId);
  return toEntryDTO(updated, args.userId);
}

async function buildReentrySummary(sessionId: string, userId: string, intent?: string): Promise<string> {
  const [closure, sharedVessel, openNeeds] = await Promise.all([
    prisma.stage4Closure.findUnique({ where: { sessionId } }),
    prisma.sharedVessel.findUnique({
      where: { sessionId },
      include: {
        agreements: {
          where: { status: 'AGREED' },
          orderBy: { agreedAt: 'desc' },
        },
      },
    }),
    prisma.stage4NeedCoverage.findMany({
      where: { sessionId, coverageStatus: { in: ['OPEN', 'PARTIAL'] } },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);

  const individualIds = closure?.individualProposalIds ?? [];
  const commitments = individualIds.length > 0
    ? await prisma.strategyProposal.findMany({
        where: { sessionId, id: { in: individualIds } },
        orderBy: { updatedAt: 'desc' },
      })
    : [];

  const lines = [
    'Passive Tending re-entry context.',
    closure ? `Stage 4 closed as ${closure.kind}: ${closure.summary}` : null,
    intent ? `User intent: ${intent}` : null,
    sharedVessel?.agreements.length
      ? `Shared agreements: ${sharedVessel.agreements.map((agreement) => agreement.description).join('; ')}`
      : null,
    commitments.length
      ? `Individual commitments: ${commitments.map((proposal) => proposal.description).join('; ')}`
      : null,
    openNeeds.length
      ? `Still-open needs: ${openNeeds.map((need) => need.needLabel).join('; ')}`
      : null,
  ];

  return lines.filter(Boolean).join('\n');
}

export async function createPassiveReentry(args: {
  sessionId: string;
  userId: string;
  intent?: string;
}): Promise<TendingEntryDTO> {
  const session = await assertSessionMember(args.sessionId, args.userId);
  if (session.status !== 'RESOLVED') {
    throw new TendingInvalidStateError('Passive Tending re-entry requires a resolved session');
  }

  const now = new Date();
  const summary = await buildReentrySummary(args.sessionId, args.userId, args.intent);
  const entry = (await prisma.tendingEntry.create({
    data: {
      sessionId: args.sessionId,
      type: TendingEntryType.USER_INITIATED_REENTRY,
      status: TendingEntryStatus.OPEN,
      openedAt: now,
      summary,
    },
    include: { responses: true, entryOutcomes: true, reminders: true },
  })) as TendingEntryWithResponses;

  return toEntryDTO(entry, args.userId);
}

export async function publishPartnerInvolvingReentryChoice(args: {
  sessionId: string;
  userId: string;
  tendingEntryId: string;
}): Promise<void> {
  await publishSessionEvent(args.sessionId, 'notification.pending_action', {
    kind: 'tending_reentry_partner_action_requested',
    tendingEntryId: args.tendingEntryId,
    createdBy: args.userId,
  }, args.userId);
}

/**
 * Stage 4 Phase 5 — submit the structured three-orientation check-in covering all
 * currently-open Tending entries on a session in one shot. Returns the affected entries
 * and metadata about the chosen forward path.
 *
 * Scope decision (documented in PR): partial-closure resolutions target TendingEntry
 * rather than Agreement so individual commitments can be partially closed too.
 */
const DEFAULT_EXTENSION_DAYS = 28;
const DEFAULT_SHARED_RESPONSE_DEADLINE_DAYS = 14;

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export type SubmitTendingCheckinResult = {
  entries: TendingEntryDTO[];
  checkin?: TendingCheckinDTO;
  coordinationCycle?: TendingCoordinationCycleDTO;
  newSessionId?: string;
  continueChoice: ContinueChoice;
  nextScheduledFor?: Date | null;
};

function toCoordinationCycleDTO(cycle: {
  id: string;
  sessionId: string;
  status: any;
  entryIds: string[];
  participantUserIds: string[];
  submittedUserIds: string[];
  responseDeadlineAt: Date;
  resolvedAt: Date | null;
  resultSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
}): TendingCoordinationCycleDTO {
  return {
    id: cycle.id,
    sessionId: cycle.sessionId,
    status: cycle.status as TendingCoordinationStatus,
    entryIds: cycle.entryIds,
    participantUserIds: cycle.participantUserIds,
    submittedUserIds: cycle.submittedUserIds,
    responseDeadlineAt: cycle.responseDeadlineAt.toISOString(),
    resolvedAt: iso(cycle.resolvedAt),
    resultSummary: cycle.resultSummary,
    createdAt: cycle.createdAt.toISOString(),
    updatedAt: cycle.updatedAt.toISOString(),
  };
}

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
  const hasStillOpenNeed = (args.needOutcomes ?? []).some((outcome) =>
    outcome.resolutionStatus === TendingNeedResolutionStatus.STILL_OPEN ||
    outcome.resolutionStatus === TendingNeedResolutionStatus.CHANGED
  );
  const hasWeakFollowThrough = (args.entryOutcomes ?? []).some((outcome) =>
    outcome.followThroughStatus === TendingFollowThroughStatus.DID_NOT_HAPPEN ||
    outcome.helpfulnessStatus === TendingHelpfulnessStatus.DID_NOT_HELP ||
    outcome.stillWorthTrying === false
  );
  const hasPartialFollowThrough = (args.entryOutcomes ?? []).some((outcome) =>
    outcome.followThroughStatus === TendingFollowThroughStatus.PARTLY_HAPPENED ||
    outcome.helpfulnessStatus === TendingHelpfulnessStatus.PARTLY_HELPED ||
    (outcome.blockerCategories?.length ?? 0) > 0
  );
  const hasOnlyResolvedNeeds =
    (args.needOutcomes?.length ?? 0) > 0 &&
    args.needOutcomes!.every((outcome) => outcome.resolutionStatus === TendingNeedResolutionStatus.RESOLVED);

  if (hasStillOpenNeed && hasWeakFollowThrough) {
    return TendingNextAction.REOPEN_STRATEGY_WORK;
  }
  if (hasStillOpenNeed || hasPartialFollowThrough) {
    return TendingNextAction.ADJUST_COMMITMENT;
  }
  if (hasOnlyResolvedNeeds && args.continueChoice === ContinueChoice.FULL_CLOSURE) {
    return TendingNextAction.FULL_CLOSURE;
  }
  return nextActionFromChoice(args.continueChoice);
}

function buildEntryReflection(args: {
  baseReflection: string;
  entryId: string;
  whatWorkedNote?: string;
  supportNote?: string;
  outcome?: TendingCheckinEntryOutcomeInput;
}): string | null {
  const lines = [
    args.baseReflection || null,
    args.whatWorkedNote ? `Entry note - what worked: ${args.whatWorkedNote}` : null,
    args.supportNote ? `Entry note - more support: ${args.supportNote}` : null,
    args.outcome?.whatHappened ? `What actually happened: ${args.outcome.whatHappened}` : null,
    args.outcome?.helpedNeed ? `Need impact: ${args.outcome.helpedNeed}` : null,
    args.outcome?.blockerNote ? `Blocker: ${args.outcome.blockerNote}` : null,
    args.outcome?.note ? `Entry note: ${args.outcome.note}` : null,
  ];

  return lines.filter(Boolean).join('\n') || null;
}

function toNeedOutcomeDTO(outcome: {
  id: string;
  checkinId: string;
  sessionId: string;
  needId: string | null;
  needLabel: string;
  sourceUserId: string | null;
  resolutionStatus: any;
  note: string | null;
  changedNeedLabel: string | null;
  nextAction: any;
  createdAt: Date;
}): TendingNeedOutcomeDTO {
  return {
    id: outcome.id,
    checkinId: outcome.checkinId,
    sessionId: outcome.sessionId,
    needId: outcome.needId,
    needLabel: outcome.needLabel,
    sourceUserId: outcome.sourceUserId,
    resolutionStatus: outcome.resolutionStatus,
    note: outcome.note,
    changedNeedLabel: outcome.changedNeedLabel,
    nextAction: outcome.nextAction as TendingNextAction | null,
    createdAt: outcome.createdAt.toISOString(),
  };
}

function buildNewProcessHandoffSummary(args: {
  reflection: string;
  entryOutcomes?: TendingCheckinEntryOutcomeInput[];
  needOutcomes?: TendingCheckinNeedOutcomeInput[];
}): string {
  const lines = [
    'Prior Tending handoff for linked new process.',
    args.reflection || null,
  ];

  for (const outcome of args.entryOutcomes ?? []) {
    lines.push([
      `Entry ${outcome.tendingEntryId}: ${outcome.followThroughStatus}`,
      outcome.helpfulnessStatus ? `helpfulness=${outcome.helpfulnessStatus}` : null,
      outcome.blockerCategories?.length ? `blockers=${outcome.blockerCategories.join(', ')}` : null,
      outcome.whatHappened ? `what happened=${outcome.whatHappened}` : null,
      outcome.helpedNeed ? `need impact=${outcome.helpedNeed}` : null,
    ].filter(Boolean).join('; '));
  }

  for (const outcome of args.needOutcomes ?? []) {
    lines.push([
      `Need "${outcome.needLabel}": ${outcome.resolutionStatus}`,
      outcome.changedNeedLabel ? `changed to "${outcome.changedNeedLabel}"` : null,
      outcome.note ? `note=${outcome.note}` : null,
    ].filter(Boolean).join('; '));
  }

  return lines.filter(Boolean).join('\n');
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
  const session = await assertSessionMember(args.sessionId, args.userId);

  const openEntries = (await prisma.tendingEntry.findMany({
    where: {
      sessionId: args.sessionId,
      status: { in: [TendingEntryStatus.OPEN, TendingEntryStatus.PARTIAL] },
      OR: [
        { scope: TendingEntryScope.SHARED },
        { scope: TendingEntryScope.INDIVIDUAL, ownerUserId: args.userId },
      ],
    },
    include: { responses: true, entryOutcomes: true, reminders: true },
  })) as TendingEntryWithResponses[];

  if (openEntries.length === 0) {
    throw new TendingInvalidStateError('No open Tending entries to check in on');
  }

  const choice = args.orientations.whatComesNext.continueChoice;
  const nextAction = args.nextAction
    ?? args.orientations.whatComesNext.nextAction
    ?? recommendTendingNextAction({
      continueChoice: choice,
      entryOutcomes: args.entryOutcomes,
      needOutcomes: args.needOutcomes,
    });
  const entryOutcomeByEntryId = new Map(
    (args.entryOutcomes ?? []).map((outcome) => [outcome.tendingEntryId, outcome])
  );
  const openEntryIds = new Set(openEntries.map((entry) => entry.id));
  const sharedEntries = openEntries.filter((entry) => entry.scope === TendingEntryScope.SHARED);
  const hasSharedEntry = sharedEntries.length > 0;
  const sharedEntryIds = sharedEntries.map((entry) => entry.id).sort();
  const participantUserIds = session.relationship.members.map((member) => member.userId).sort();
  const includedBetweenPeriodNoteIds = Array.from(new Set(args.includedBetweenPeriodNoteIds ?? []));
  const shareBetweenPeriodNoteIds = Array.from(new Set(args.shareBetweenPeriodNoteIds ?? []));
  const shareWithoutCarryForward = shareBetweenPeriodNoteIds.filter(
    (noteId) => !includedBetweenPeriodNoteIds.includes(noteId)
  );
  if (shareWithoutCarryForward.length > 0) {
    throw new TendingInvalidStateError('Shared between-period notes must also be selected for carry-forward');
  }
  const referencedBetweenPeriodNoteIds = Array.from(new Set([
    ...includedBetweenPeriodNoteIds,
    ...shareBetweenPeriodNoteIds,
  ]));
  if (referencedBetweenPeriodNoteIds.length > 0) {
    const notes = await prisma.tendingBetweenPeriodNote.findMany({
      where: {
        id: { in: referencedBetweenPeriodNoteIds },
        sessionId: args.sessionId,
        userId: args.userId,
      },
      select: { id: true },
    });
    const foundIds = new Set(notes.map((note) => note.id));
    if (referencedBetweenPeriodNoteIds.some((noteId) => !foundIds.has(noteId))) {
      throw new TendingInvalidStateError('Between-period note references a non-private or non-session note');
    }
  }
  for (const outcome of args.entryOutcomes ?? []) {
    if (!openEntryIds.has(outcome.tendingEntryId)) {
      throw new TendingInvalidStateError('Entry outcome references a non-open Tending entry');
    }
  }
  for (const reminder of [
    ...(args.reminders ?? []),
    ...(args.orientations.whatComesNext.reminders ?? []),
  ]) {
    if (reminder.tendingEntryId && !openEntryIds.has(reminder.tendingEntryId)) {
      throw new TendingInvalidStateError('Reminder references a non-open Tending entry');
    }
    if (reminder.scope === TendingReminderScope.SHARED) {
      const linkedEntry = reminder.tendingEntryId
        ? openEntries.find((entry) => entry.id === reminder.tendingEntryId)
        : null;
      if (!linkedEntry || linkedEntry.scope !== TendingEntryScope.SHARED) {
        throw new TendingInvalidStateError('Shared reminders require a shared Tending entry');
      }
    }
  }
  for (const adjustment of args.adjustments ?? []) {
    if (!openEntryIds.has(adjustment.tendingEntryId)) {
      throw new TendingInvalidStateError('Adjustment references a non-open Tending entry');
    }
    const linkedEntry = openEntries.find((entry) => entry.id === adjustment.tendingEntryId);
    if (linkedEntry?.scope === TendingEntryScope.INDIVIDUAL && linkedEntry.ownerUserId !== args.userId) {
      throw new TendingForbiddenError();
    }
  }
  if (choice === ContinueChoice.FULL_CLOSURE && !args.resolvedEnoughOverride) {
    const unresolvedNeeds = (args.needOutcomes ?? []).filter(
      (outcome) => outcome.resolutionStatus !== TendingNeedResolutionStatus.RESOLVED
    );
    if (unresolvedNeeds.length > 0) {
      throw new TendingInvalidStateError(
        'Full closure requires submitted needs to be resolved or an explicit resolved-enough override'
      );
    }
  }
  const reflection = [
    args.orientations.whatWorked.reflection
      ? `What worked: ${args.orientations.whatWorked.reflection}`
      : null,
    args.orientations.whereMoreSupport.reflection
      ? `Where more support: ${args.orientations.whereMoreSupport.reflection}`
      : null,
    args.resolvedEnoughOverride
      ? `Resolved-enough override: ${args.resolvedEnoughOverrideNote ?? 'User explicitly chose to proceed.'}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  let nextScheduledFor: Date | null = null;
  let newSessionId: string | undefined;
  let checkinDTO: TendingCheckinDTO | undefined;
  let coordinationCycleDTO: TendingCoordinationCycleDTO | undefined;

  await prisma.$transaction(async (tx) => {
    let coordinationCycle: {
      id: string;
      sessionId: string;
      status: any;
      entryIds: string[];
      participantUserIds: string[];
      submittedUserIds: string[];
      responseDeadlineAt: Date;
      resolvedAt: Date | null;
      resultSummary: string | null;
      createdAt: Date;
      updatedAt: Date;
    } | null = null;

    if (hasSharedEntry) {
      const coordinationKey = buildTendingCoordinationKey(args.sessionId, sharedEntryIds);
      let existingCycle = await tx.tendingCoordinationCycle.findFirst({
        where: {
          coordinationKey,
          status: { in: [TendingCoordinationStatus.WAITING_FOR_PARTNER, TendingCoordinationStatus.READY_TO_RESOLVE] },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!existingCycle) {
        try {
          existingCycle = await tx.tendingCoordinationCycle.create({
            data: {
              sessionId: args.sessionId,
              createdByUserId: args.userId,
              coordinationKey,
              status: TendingCoordinationStatus.WAITING_FOR_PARTNER,
              entryIds: sharedEntryIds,
              participantUserIds,
              submittedUserIds: [args.userId],
              responseDeadlineAt: addDays(now, DEFAULT_SHARED_RESPONSE_DEADLINE_DAYS),
              resultSummary: 'Shared Tending choices are being held privately until the partner submits or the response window expires.',
            },
          });
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          existingCycle = await tx.tendingCoordinationCycle.findFirst({
            where: {
              coordinationKey,
              status: { in: [TendingCoordinationStatus.WAITING_FOR_PARTNER, TendingCoordinationStatus.READY_TO_RESOLVE] },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (!existingCycle) throw error;
        }
      }

      const submittedUserIds = Array.from(new Set([
        ...((existingCycle?.submittedUserIds as string[] | undefined) ?? []),
        args.userId,
      ])).sort();
      const allSubmitted = participantUserIds.every((id) => submittedUserIds.includes(id));

      coordinationCycle = await tx.tendingCoordinationCycle.update({
        where: { id: existingCycle.id },
        data: {
          submittedUserIds,
          status: allSubmitted
            ? TendingCoordinationStatus.READY_TO_RESOLVE
            : TendingCoordinationStatus.WAITING_FOR_PARTNER,
          resultSummary: allSubmitted
            ? 'All participants have submitted; shared Tending choices are ready for coordinated resolution.'
            : 'Shared Tending choices are being held privately until the partner submits or the response window expires.',
        },
      });
      coordinationCycleDTO = toCoordinationCycleDTO(coordinationCycle);
    }

    const createdCheckin = await tx.tendingCheckin.create({
      data: {
        sessionId: args.sessionId,
        userId: args.userId,
        coordinationCycleId: coordinationCycle?.id,
        nextAction,
        continueChoice: choice,
        reflectionSummary: reflection || null,
        submittedAt: now,
      },
    });

    // 1) Persist a TendingResponse for each open entry that the user can respond to.
    const responseIds: Record<string, string> = {};
    for (const entry of openEntries) {
      if (entry.scope === TendingEntryScope.INDIVIDUAL && entry.ownerUserId !== args.userId) {
        continue;
      }
      const entryOutcome = entryOutcomeByEntryId.get(entry.id);
      const upserted = await tx.tendingResponse.upsert({
        where: {
          tendingEntryId_userId: {
            tendingEntryId: entry.id,
            userId: args.userId,
          },
        },
        create: {
          tendingEntryId: entry.id,
          userId: args.userId,
          checkinId: createdCheckin.id,
          status: 'CHECKIN',
          reflection: buildEntryReflection({
            baseReflection: reflection,
            entryId: entry.id,
            whatWorkedNote: args.orientations.whatWorked.perEntryNotes?.[entry.id],
            supportNote: args.orientations.whereMoreSupport.perEntryNotes?.[entry.id],
            outcome: entryOutcome,
          }),
          continueChoice: choice,
          submittedAt: now,
        },
        update: {
          checkinId: createdCheckin.id,
          status: 'CHECKIN',
          reflection: buildEntryReflection({
            baseReflection: reflection,
            entryId: entry.id,
            whatWorkedNote: args.orientations.whatWorked.perEntryNotes?.[entry.id],
            supportNote: args.orientations.whereMoreSupport.perEntryNotes?.[entry.id],
            outcome: entryOutcome,
          }),
          continueChoice: choice,
          submittedAt: now,
        },
      });
      responseIds[entry.id] = upserted.id;

      if (entryOutcome) {
        await tx.tendingEntryOutcome.upsert({
          where: {
            checkinId_tendingEntryId: {
              checkinId: createdCheckin.id,
              tendingEntryId: entry.id,
            },
          },
          create: {
            checkinId: createdCheckin.id,
            tendingEntryId: entry.id,
            responseId: upserted.id,
            userId: args.userId,
            followThroughStatus: entryOutcome.followThroughStatus,
            helpfulnessStatus: entryOutcome.helpfulnessStatus,
            blockerCategories: entryOutcome.blockerCategories ?? [],
            whatHappened: entryOutcome.whatHappened,
            helpedNeed: entryOutcome.helpedNeed,
            blockerNote: entryOutcome.blockerNote ?? entryOutcome.note,
            stillWorthTrying: entryOutcome.stillWorthTrying,
          },
          update: {
            responseId: upserted.id,
            followThroughStatus: entryOutcome.followThroughStatus,
            helpfulnessStatus: entryOutcome.helpfulnessStatus,
            blockerCategories: entryOutcome.blockerCategories ?? [],
            whatHappened: entryOutcome.whatHappened,
            helpedNeed: entryOutcome.helpedNeed,
            blockerNote: entryOutcome.blockerNote ?? entryOutcome.note,
            stillWorthTrying: entryOutcome.stillWorthTrying,
          },
        });
      }
    }

    const createdNeedOutcomes = [];
    for (const needOutcome of args.needOutcomes ?? []) {
      createdNeedOutcomes.push(await tx.tendingNeedOutcome.create({
        data: {
          checkinId: createdCheckin.id,
          sessionId: args.sessionId,
          needId: needOutcome.needId,
          needLabel: needOutcome.needLabel,
          sourceUserId: needOutcome.sourceUserId,
          resolutionStatus: needOutcome.resolutionStatus,
          note: needOutcome.note,
          changedNeedLabel: needOutcome.changedNeedLabel,
          nextAction: needOutcome.nextAction,
        },
      }));
    }

    const reminderInputs = [
      ...(args.reminders ?? []),
      ...(args.orientations.whatComesNext.reminders ?? []),
    ];
    const createdReminders = [];
    for (const reminder of reminderInputs) {
      createdReminders.push(await tx.tendingReminder.create({
        data: {
          sessionId: args.sessionId,
          checkinId: createdCheckin.id,
          tendingEntryId: reminder.tendingEntryId,
          userId: args.userId,
          scope: reminder.scope,
          remindAt: new Date(reminder.remindAt),
          cadence: reminder.cadence,
          note: reminder.note,
        },
      }));
    }

    const createdAdjustments = [];
    for (const adjustment of args.adjustments ?? []) {
      createdAdjustments.push(await tx.tendingAdjustment.create({
        data: {
          sessionId: args.sessionId,
          checkinId: createdCheckin.id,
          tendingEntryId: adjustment.tendingEntryId,
          userId: args.userId,
          privacyScope: adjustment.privacyScope ?? TendingReminderScope.PRIVATE,
          revisedCommitmentText: adjustment.revisedCommitmentText,
          revisedCadence: adjustment.revisedCadence,
          revisedScope: adjustment.revisedScope,
          revisedSuccessCriteria: adjustment.revisedSuccessCriteria,
          reason: adjustment.reason,
          blockerAddressed: adjustment.blockerAddressed ?? [],
        },
      }));
    }

    if (includedBetweenPeriodNoteIds.length > 0) {
      await tx.tendingBetweenPeriodNote.updateMany({
        where: {
          id: { in: includedBetweenPeriodNoteIds },
          sessionId: args.sessionId,
          userId: args.userId,
        },
        data: {
          carryForwardSelected: true,
          selectedForCheckinId: createdCheckin.id,
        },
      });
    }
    if (shareBetweenPeriodNoteIds.length > 0) {
      await tx.tendingBetweenPeriodNote.updateMany({
        where: {
          id: { in: shareBetweenPeriodNoteIds },
          sessionId: args.sessionId,
          userId: args.userId,
        },
        data: {
          consentToShareWithPartner: true,
          shareConsentAt: now,
        },
      });
    }

    checkinDTO = {
      id: createdCheckin.id,
      sessionId: createdCheckin.sessionId,
      userId: createdCheckin.userId,
      coordinationCycleId: createdCheckin.coordinationCycleId ?? null,
      nextAction: createdCheckin.nextAction as TendingNextAction | null,
      continueChoice: createdCheckin.continueChoice as ContinueChoice | null,
      reflectionSummary: createdCheckin.reflectionSummary,
      submittedAt: createdCheckin.submittedAt.toISOString(),
      createdAt: createdCheckin.createdAt.toISOString(),
      needOutcomes: createdNeedOutcomes.map(toNeedOutcomeDTO),
      reminders: createdReminders.map(toReminderDTO),
      adjustments: createdAdjustments.map(toAdjustmentDTO),
    };

    if (hasSharedEntry) {
      for (const entry of sharedEntries) {
        await tx.tendingEntry.update({
          where: { id: entry.id },
          data: { status: TendingEntryStatus.PARTIAL },
        });
      }
    }

    const entriesToTransition = hasSharedEntry
      ? openEntries.filter((entry) => entry.scope === TendingEntryScope.INDIVIDUAL)
      : openEntries;

    // 2) Apply path-specific state transitions. Shared entries are held for the
    // coordination resolver; individual entries still advance immediately.
    switch (choice) {
      case ContinueChoice.ANOTHER_ROUND: {
        if (entriesToTransition.length === 0) break;
        // Do not reset session-wide Stage 4 state from a single user's Tending
        // check-in. Reopening strategy work is coordinated separately once both
        // partners have had a chance to respond.
        for (const entry of entriesToTransition) {
          await tx.tendingEntry.update({
            where: { id: entry.id },
            data: { status: TendingEntryStatus.COMPLETED, completedAt: now },
          });
        }
        break;
      }
      case ContinueChoice.EXTEND: {
        if (entriesToTransition.length === 0) break;
        nextScheduledFor = addDays(now, DEFAULT_EXTENSION_DAYS);
        const allNeedsResolved =
          (args.needOutcomes?.length ?? 0) > 0 &&
          args.needOutcomes!.every((outcome) => outcome.resolutionStatus === TendingNeedResolutionStatus.RESOLVED);
        for (const entry of entriesToTransition) {
          const entryOutcome = entryOutcomeByEntryId.get(entry.id);
          if (entryOutcome?.stillWorthTrying === false || allNeedsResolved) {
            await tx.tendingEntry.update({
              where: { id: entry.id },
              data: { status: TendingEntryStatus.COMPLETED, completedAt: now },
            });
            continue;
          }
          await tx.tendingEntry.update({
            where: { id: entry.id },
            data: {
              status: TendingEntryStatus.SCHEDULED,
              scheduledFor: nextScheduledFor,
              openedAt: null,
              completedAt: null,
            },
          });
        }
        break;
      }
      case ContinueChoice.NEW_PROCESS: {
        if (entriesToTransition.length === 0) break;
        const handoffSummary = buildNewProcessHandoffSummary({
          reflection,
          entryOutcomes: args.entryOutcomes,
          needOutcomes: args.needOutcomes,
        });
        // Create a new Session linked back to this one. Both users start at Stage 0.
        const created = await tx.session.create({
          data: {
            relationshipId: session.relationshipId,
            status: 'CREATED',
            type: session.type,
            previousSessionId: args.sessionId,
            topicFrame: 'Tending follow-up',
          },
        });
        newSessionId = created.id;
        await tx.message.create({
          data: {
            sessionId: created.id,
            senderId: null,
            forUserId: args.userId,
            role: 'SYSTEM',
            content: handoffSummary,
            stage: 0,
            timestamp: now,
          },
        });
        // Mark current entries COMPLETED and the current session RESOLVED.
        for (const entry of entriesToTransition) {
          await tx.tendingEntry.update({
            where: { id: entry.id },
            data: { status: TendingEntryStatus.COMPLETED, completedAt: now },
          });
        }
        await tx.session.update({
          where: { id: args.sessionId },
          data: { status: 'RESOLVED', resolvedAt: now },
        });
        break;
      }
      case ContinueChoice.PARTIAL_CLOSURE: {
        if (entriesToTransition.length === 0) break;
        const resolutions = args.orientations.whatComesNext.partialClosure ?? {};
        nextScheduledFor = addDays(now, DEFAULT_EXTENSION_DAYS);
        for (const entry of entriesToTransition) {
          const resolution = resolutions[entry.id] ?? PartialClosureResolution.CONTINUING;
          const responseId = responseIds[entry.id];
          if (responseId) {
            await tx.tendingResponsePartialClosure.upsert({
              where: {
                tendingResponseId_tendingEntryId: {
                  tendingResponseId: responseId,
                  tendingEntryId: entry.id,
                },
              },
              create: {
                tendingResponseId: responseId,
                tendingEntryId: entry.id,
                resolution,
              },
              update: { resolution },
            });
          }
          if (resolution === PartialClosureResolution.RESOLVED) {
            await tx.tendingEntry.update({
              where: { id: entry.id },
              data: { status: TendingEntryStatus.COMPLETED, completedAt: now },
            });
          } else {
            await tx.tendingEntry.update({
              where: { id: entry.id },
              data: {
                status: TendingEntryStatus.SCHEDULED,
                scheduledFor: nextScheduledFor,
                openedAt: null,
                completedAt: null,
              },
            });
          }
        }
        break;
      }
      case ContinueChoice.FULL_CLOSURE: {
        if (entriesToTransition.length === 0) break;
        for (const entry of entriesToTransition) {
          await tx.tendingEntry.update({
            where: { id: entry.id },
            data: { status: TendingEntryStatus.COMPLETED, completedAt: now },
          });
        }
        await tx.session.update({
          where: { id: args.sessionId },
          data: { status: 'RESOLVED', resolvedAt: now },
        });
        break;
      }
      default:
        throw new TendingInvalidStateError(`Unsupported continueChoice: ${choice as string}`);
    }
  });

  if (hasSharedEntry) {
    try {
      await publishSessionEvent(args.sessionId, 'notification.pending_action', {
        kind: 'tending_checkin_submitted',
        continueChoice: choice,
        nextAction,
        submittedBy: args.userId,
        newSessionId,
      }, args.userId);
    } catch (error) {
      logger.warn('[tending] Failed to publish check-in event', { sessionId: args.sessionId, error });
    }
  }

  const refreshed = (await prisma.tendingEntry.findMany({
    where: { id: { in: openEntries.map((e) => e.id) } },
    include: { responses: true, entryOutcomes: true, reminders: true },
  })) as TendingEntryWithResponses[];

  return {
    entries: refreshed.map((entry) => toEntryDTO(entry, args.userId)),
    checkin: checkinDTO,
    coordinationCycle: coordinationCycleDTO,
    newSessionId,
    continueChoice: choice,
    nextScheduledFor,
  };
}

export async function openDueTendingEntries(now = new Date()): Promise<{ opened: number; entryIds: string[] }> {
  const dueEntries = await prisma.tendingEntry.findMany({
    where: {
      status: TendingEntryStatus.SCHEDULED,
      scheduledFor: { lte: now },
      type: {
        in: [
          TendingEntryType.SCHEDULED_SHARED_AGREEMENT_CHECKIN,
          TendingEntryType.SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN,
        ],
      },
    },
    select: { id: true, sessionId: true, scope: true, ownerUserId: true, type: true },
  });

  const entryIds: string[] = [];
  for (const entry of dueEntries) {
    const updated = await prisma.tendingEntry.updateMany({
      where: { id: entry.id, status: TendingEntryStatus.SCHEDULED },
      data: { status: TendingEntryStatus.OPEN, openedAt: now },
    });
    if (updated.count === 0) continue;
    entryIds.push(entry.id);

    try {
      if (entry.scope === TendingEntryScope.INDIVIDUAL && entry.ownerUserId) {
        await publishUserEvent(entry.ownerUserId, 'session.updated', {
          sessionId: entry.sessionId,
          kind: 'tending_checkin_opened',
          tendingEntryId: entry.id,
          scope: entry.scope,
        });
      } else {
        await publishSessionEvent(entry.sessionId, 'notification.pending_action', {
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
    case 'ONCE':
    case 'ONE_TIME':
    default:
      return null;
  }
}

export async function processDueTendingReminders(
  now = new Date()
): Promise<{ delivered: number; reminderIds: string[] }> {
  const dueReminders = await prisma.tendingReminder.findMany({
    where: {
      status: 'SCHEDULED',
      remindAt: { lte: now },
    },
    orderBy: [{ remindAt: 'asc' }],
  });

  const reminderIds: string[] = [];
  for (const reminder of dueReminders) {
    const nextDate = nextReminderDate(reminder.remindAt, reminder.cadence);
    if (nextDate) {
      await prisma.tendingReminder.update({
        where: { id: reminder.id },
        data: {
          remindAt: nextDate,
          status: 'SCHEDULED',
        },
      });
    } else {
      await prisma.tendingReminder.update({
        where: { id: reminder.id },
        data: { status: 'DELIVERED' },
      });
    }
    reminderIds.push(reminder.id);

    const payload = {
      kind: 'tending_reminder_due',
      reminderId: reminder.id,
      tendingEntryId: reminder.tendingEntryId,
      scope: reminder.scope,
      note: reminder.note,
      userId: reminder.userId,
    };

    try {
      if (reminder.scope === TendingReminderScope.PRIVATE) {
        await publishUserEvent(reminder.userId, 'session.updated', {
          sessionId: reminder.sessionId,
          ...payload,
        });
      } else {
        await publishSessionEvent(reminder.sessionId, 'notification.pending_action', payload);
      }
    } catch (error) {
      logger.warn('[tending] Failed to publish reminder due event', { reminderId: reminder.id, error });
    }
  }

  return { delivered: reminderIds.length, reminderIds };
}

export async function resolveTimedOutTendingCoordinationCycles(
  now = new Date()
): Promise<{ resolved: number; cycleIds: string[] }> {
  const timedOutCycles = await prisma.tendingCoordinationCycle.findMany({
    where: {
      status: TendingCoordinationStatus.WAITING_FOR_PARTNER,
      responseDeadlineAt: { lte: now },
    },
  });

  const cycleIds: string[] = [];
  for (const cycle of timedOutCycles) {
    const missingUserIds = cycle.participantUserIds.filter(
      (userId) => !cycle.submittedUserIds.includes(userId)
    );
    const updated = await prisma.tendingCoordinationCycle.update({
      where: { id: cycle.id },
      data: {
        status: TendingCoordinationStatus.TIMED_OUT,
        resolvedAt: now,
        resultSummary: missingUserIds.length
          ? `Tending proceeded with submitted responses after timeout. Missing participant(s): ${missingUserIds.join(', ')}.`
          : 'Tending proceeded after timeout with all available submitted responses.',
      },
    });
    cycleIds.push(updated.id);

    try {
      await publishSessionEvent(cycle.sessionId, 'notification.pending_action', {
        kind: 'tending_coordination_timed_out',
        coordinationCycleId: cycle.id,
        submittedUserIds: cycle.submittedUserIds,
        missingUserIds,
      });
    } catch (error) {
      logger.warn('[tending] Failed to publish coordination timeout event', { cycleId: cycle.id, error });
    }
  }

  return { resolved: cycleIds.length, cycleIds };
}

export async function resolveReadyTendingCoordinationCycles(
  now = new Date()
): Promise<{ resolved: number; cycleIds: string[] }> {
  const readyCycles = await prisma.tendingCoordinationCycle.findMany({
    where: { status: TendingCoordinationStatus.READY_TO_RESOLVE },
    include: {
      checkins: {
        include: {
          responses: {
            include: { partialClosures: true },
          },
          entryOutcomes: true,
          needOutcomes: true,
        },
      },
    },
  });

  const cycleIds: string[] = [];
  for (const cycle of readyCycles) {
    const choices = cycle.checkins
      .map((checkin) => checkin.continueChoice)
      .filter(Boolean);
    const allExtend = choices.length > 0 && choices.every((choice) => choice === ContinueChoice.EXTEND);
    const allFullClosure = choices.length > 0 && choices.every((choice) => choice === ContinueChoice.FULL_CLOSURE);
    const allPartialClosure = choices.length > 0 && choices.every((choice) => choice === ContinueChoice.PARTIAL_CLOSURE);
    const anyNewProcess = choices.some((choice) => choice === ContinueChoice.NEW_PROCESS);
    const anyReopen = choices.some((choice) => choice === ContinueChoice.ANOTHER_ROUND);
    const partialClosureByEntryId = new Map<string, PartialClosureResolution[]>();
    for (const checkin of cycle.checkins) {
      for (const response of checkin.responses ?? []) {
        for (const partialClosure of response.partialClosures ?? []) {
          const current = partialClosureByEntryId.get(partialClosure.tendingEntryId) ?? [];
          current.push(partialClosure.resolution as PartialClosureResolution);
          partialClosureByEntryId.set(partialClosure.tendingEntryId, current);
        }
      }
    }
    const entryIdsBothClosed = cycle.entryIds.filter((entryId) => {
      const resolutions = partialClosureByEntryId.get(entryId) ?? [];
      return (
        resolutions.length >= cycle.participantUserIds.length &&
        resolutions.every((resolution) => resolution === PartialClosureResolution.RESOLVED)
      );
    });
    const entryIdsContinuing = cycle.entryIds.filter((entryId) => !entryIdsBothClosed.includes(entryId));
    const anyFailedFollowThrough = cycle.checkins.some((checkin) =>
      (checkin.entryOutcomes ?? []).some((outcome) =>
        outcome.followThroughStatus === TendingFollowThroughStatus.DID_NOT_HAPPEN ||
        outcome.helpfulnessStatus === TendingHelpfulnessStatus.DID_NOT_HELP ||
        outcome.stillWorthTrying === false
      )
    );
    const anyStillOpenNeed = cycle.checkins.some((checkin) =>
      (checkin.needOutcomes ?? []).some((outcome) =>
        outcome.resolutionStatus === TendingNeedResolutionStatus.STILL_OPEN ||
        outcome.resolutionStatus === TendingNeedResolutionStatus.CHANGED ||
        outcome.resolutionStatus === TendingNeedResolutionStatus.NOT_SURE
      )
    );

    let resultSummary = '';
    let nextScheduledFor: Date | null = null;
    let nextScheduledForIso: string | null = null;

    await prisma.$transaction(async (tx) => {
      if (allExtend && !(anyFailedFollowThrough && anyStillOpenNeed)) {
        nextScheduledFor = addDays(now, DEFAULT_EXTENSION_DAYS);
        nextScheduledForIso = nextScheduledFor.toISOString();
        await tx.tendingEntry.updateMany({
          where: { id: { in: cycle.entryIds } },
          data: {
            status: TendingEntryStatus.SCHEDULED,
            scheduledFor: nextScheduledFor,
            openedAt: null,
            completedAt: null,
          },
        });
        resultSummary = `Both participants chose extension. Shared Tending entries continue until ${nextScheduledForIso}.`;
      } else if (allFullClosure && !anyStillOpenNeed) {
        await tx.tendingEntry.updateMany({
          where: { id: { in: cycle.entryIds } },
          data: { status: TendingEntryStatus.COMPLETED, completedAt: now },
        });
        await tx.session.update({
          where: { id: cycle.sessionId },
          data: { status: 'RESOLVED', resolvedAt: now },
        });
        resultSummary = 'Both participants chose full closure and no submitted need remains open. Shared Tending entries are complete.';
      } else if (allPartialClosure) {
        nextScheduledFor = entryIdsContinuing.length > 0 ? addDays(now, DEFAULT_EXTENSION_DAYS) : null;
        nextScheduledForIso = nextScheduledFor?.toISOString() ?? null;
        if (entryIdsBothClosed.length > 0) {
          await tx.tendingEntry.updateMany({
            where: { id: { in: entryIdsBothClosed } },
            data: { status: TendingEntryStatus.COMPLETED, completedAt: now },
          });
        }
        if (entryIdsContinuing.length > 0) {
          await tx.tendingEntry.updateMany({
            where: { id: { in: entryIdsContinuing } },
            data: {
              status: TendingEntryStatus.SCHEDULED,
              scheduledFor: nextScheduledFor,
              openedAt: null,
              completedAt: null,
            },
          });
        }
        resultSummary = entryIdsBothClosed.length > 0
          ? `Both participants chose partial closure. Closed ${entryIdsBothClosed.length} shared entr${entryIdsBothClosed.length === 1 ? 'y' : 'ies'} and continued ${entryIdsContinuing.length}.`
          : 'Both participants chose partial closure, but no shared entry had explicit closure from both sides. Shared entries continue for another check-in.';
      } else if (anyNewProcess) {
        resultSummary = 'At least one participant chose a new process. Partner-involving consent and mediated coordination are required before creating a linked shared session.';
      } else if (choices.includes(ContinueChoice.EXTEND) && choices.includes(ContinueChoice.PARTIAL_CLOSURE)) {
        nextScheduledFor = entryIdsContinuing.length > 0 ? addDays(now, DEFAULT_EXTENSION_DAYS) : null;
        nextScheduledForIso = nextScheduledFor?.toISOString() ?? null;
        if (entryIdsContinuing.length > 0) {
          await tx.tendingEntry.updateMany({
            where: { id: { in: entryIdsContinuing } },
            data: {
              status: TendingEntryStatus.SCHEDULED,
              scheduledFor: nextScheduledFor,
              openedAt: null,
              completedAt: null,
            },
          });
        }
        if (entryIdsBothClosed.length > 0) {
          await tx.tendingEntry.updateMany({
            where: { id: { in: entryIdsBothClosed } },
            data: { status: TendingEntryStatus.COMPLETED, completedAt: now },
          });
        }
        resultSummary = 'One participant chose extension and one chose partial closure. Entries only close where both explicitly closed them; unresolved shared entries continue for a mediated next-step prompt.';
      } else if (anyReopen || (anyFailedFollowThrough && anyStillOpenNeed)) {
        resultSummary = 'At least one participant reported failed follow-through or a still-open need. Shared Tending should move to adjustment or strategy reopening instead of blind extension.';
      } else {
        resultSummary = 'Participants submitted mixed Tending choices. Shared entries remain held for a mediated next-step prompt.';
      }

      await tx.tendingCoordinationCycle.update({
        where: { id: cycle.id },
        data: {
          status: TendingCoordinationStatus.RESOLVED,
          resolvedAt: now,
          resultSummary,
        },
      });
    });

    cycleIds.push(cycle.id);
    try {
      await publishSessionEvent(cycle.sessionId, 'notification.pending_action', {
        kind: 'tending_coordination_resolved',
        coordinationCycleId: cycle.id,
        resultSummary,
        nextScheduledFor: nextScheduledForIso,
      });
    } catch (error) {
      logger.warn('[tending] Failed to publish coordination resolved event', { cycleId: cycle.id, error });
    }
  }

  return { resolved: cycleIds.length, cycleIds };
}
