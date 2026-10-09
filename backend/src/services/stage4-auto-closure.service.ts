import { Prisma } from '../generated/prisma/client';
import {
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
} from '@meet-without-fear/shared';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { notifyPartner, publishSessionEvent } from './realtime';
import { getPartnerUserId } from '../utils/session';
import type { Stage4ClosureSignalDTO } from './stage4-capture.service';

type SessionForClosure = {
  id: string;
  status: string;
  relationship: {
    members: Array<{ userId: string; joinedAt: Date }>;
  };
};

type ProposalForClosure = {
  id: string;
  kind: Stage4ProposalKind;
  status: Stage4ProposalStatus;
  createdByUserId: string | null;
};

type SelectionForClosure = {
  proposalId: string;
  userId: string;
  decision: Stage4SelectionDecision;
};

type CoverageForClosure = {
  id: string;
  needId: string | null;
  coverageStatus: string;
};

export type Stage4AutoClosureResult =
  | { closed: true; reason: Stage4ClosureReason }
  | { closed: false; reason: string };

function isExplicitNoSharedClosure(signal: Stage4ClosureSignalDTO | undefined): signal is Stage4ClosureSignalDTO {
  return signal?.readyToClose === true && signal.kind === Stage4ClosureKind.NO_SHARED_AGREEMENT;
}

function getIndividualCommitmentIds(
  proposals: ProposalForClosure[],
  selections: SelectionForClosure[],
  closingUserId: string
): string[] {
  const willingIds = new Set(
    selections
      .filter((selection) => selection.decision === Stage4SelectionDecision.WILLING)
      .map((selection) => selection.proposalId)
  );

  return proposals
    .filter((proposal) => proposal.kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT)
    .filter((proposal) => proposal.status === Stage4ProposalStatus.ACTIVE)
    .filter(
      (proposal) =>
        willingIds.has(proposal.id) ||
        proposal.createdByUserId === closingUserId
    )
    .map((proposal) => proposal.id);
}

function buildNoSharedSummary(
  individualCommitmentCount: number,
  openNeedCount: number,
  requestedSummary?: string
): string {
  if (requestedSummary) return requestedSummary;

  return `Closed without a shared agreement, preserving ${individualCommitmentCount} individual commitment${individualCommitmentCount === 1 ? '' : 's'} and ${openNeedCount} still-open need${openNeedCount === 1 ? '' : 's'}.`;
}

/**
 * Apply an explicit conversational no-shared-agreement close.
 *
 * This is intentionally narrower than the button endpoint: it only honors
 * explicit stop/close/no-shared-agreement language captured from the user's
 * own Stage 4 message. It does not convert shared proposals into agreements.
 */
export async function applyStage4AutoClosureFromSignal(args: {
  sessionId: string;
  userId: string;
  signal?: Stage4ClosureSignalDTO;
}): Promise<Stage4AutoClosureResult> {
  if (!isExplicitNoSharedClosure(args.signal)) {
    return { closed: false, reason: 'no_explicit_no_shared_closure_signal' };
  }

  const session = (await prisma.session.findFirst({
    where: {
      id: args.sessionId,
      relationship: {
        members: {
          some: { userId: args.userId },
        },
      },
    },
    include: {
      relationship: {
        include: {
          members: {
            orderBy: { joinedAt: 'asc' },
          },
        },
      },
    },
  })) as SessionForClosure | null;

  if (!session) return { closed: false, reason: 'session_not_found' };
  if (session.status !== 'ACTIVE') return { closed: false, reason: 'session_not_active' };

  const currentProgress = await prisma.stageProgress.findFirst({
    where: { sessionId: args.sessionId, userId: args.userId, status: 'IN_PROGRESS' },
    orderBy: { stage: 'desc' },
    select: { stage: true },
  });
  if ((currentProgress?.stage ?? 0) !== 4) {
    return { closed: false, reason: 'not_in_stage_4' };
  }

  const existingClosure = await prisma.stage4Closure.findUnique({
    where: { sessionId: args.sessionId },
  });
  if (existingClosure) return { closed: false, reason: 'already_closed' };

  const [proposals, selections, coverageRows] = await Promise.all([
    prisma.strategyProposal.findMany({
      where: { sessionId: args.sessionId, status: { not: Stage4ProposalStatus.REMOVED } },
      select: {
        id: true,
        kind: true,
        status: true,
        createdByUserId: true,
      },
    }) as Promise<ProposalForClosure[]>,
    prisma.stage4ProposalSelection.findMany({
      where: { sessionId: args.sessionId },
      select: { proposalId: true, userId: true, decision: true },
    }) as Promise<SelectionForClosure[]>,
    prisma.stage4NeedCoverage.findMany({
      where: { sessionId: args.sessionId },
      select: { id: true, needId: true, coverageStatus: true },
    }) as Promise<CoverageForClosure[]>,
  ]);

  const individualProposalIds = getIndividualCommitmentIds(proposals, selections, args.userId);
  const openNeedIds = coverageRows
    .filter((row) => row.coverageStatus === 'OPEN' || row.coverageStatus === 'PARTIAL')
    .map((row) => row.needId ?? row.id);
  const now = new Date();
  const reason = args.signal.reason ?? Stage4ClosureReason.USER_STOPPED;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.stage4Closure.create({
      data: {
        sessionId: args.sessionId,
        kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
        reason,
        summary: buildNoSharedSummary(individualProposalIds.length, openNeedIds.length, args.signal?.summary),
        sharedAgreementIds: [],
        individualProposalIds,
        openNeedIds,
        closedByUserId: args.userId,
        closedAt: now,
      },
    });

    await tx.session.update({
      where: { id: args.sessionId },
      data: { status: 'RESOLVED', resolvedAt: now },
    });

    await tx.stageProgress.updateMany({
      where: { sessionId: args.sessionId, completedAt: null },
      data: { status: 'COMPLETED', completedAt: now },
    });
  });

  const partnerId = await getPartnerUserId(args.sessionId, args.userId);
  if (partnerId) {
    await notifyPartner(args.sessionId, partnerId, 'session.resolved', {
      closedBy: args.userId,
      kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
      agreementIds: [],
    });
  }

  await publishSessionEvent(args.sessionId, 'session.resolved', {
    closureKind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
    agreementIds: [],
  });

  logger.info('[applyStage4AutoClosureFromSignal] Closed Stage 4 from explicit conversation signal', {
    sessionId: args.sessionId,
    userId: args.userId,
    reason,
    individualProposalCount: individualProposalIds.length,
    openNeedCount: openNeedIds.length,
  });

  return { closed: true, reason };
}
