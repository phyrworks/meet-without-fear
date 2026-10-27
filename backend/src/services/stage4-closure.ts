/**
 * Closing the repair stage (TS-11; spec §1.4 agreement, agreement_party,
 * session_closure, §4 v_session_closure_items).
 *
 * The decision is computed from the present humans' choices; every write is
 * the JOB's, in ONE job transaction: an `agreement` + an `agreement_party`
 * per present human for each mutually WILLING shared proposal (the deferred
 * T-agreement-parties re-checks at COMMIT that the parties are every present
 * human, each WILLING), the proposals CONVERTED_TO_AGREEMENT with their
 * revision rows, the follow-ups, the `session_closure` row, and the session
 * RESOLVED. Then `closed` for every present human. The three id arrays the
 * old Stage4Closure stored are `v_session_closure_items`.
 */

import { AgreementType, MAX_AGREEMENTS, Stage4ClosureKind, Stage4ClosureReason } from '@meet-without-fear/shared';
import { getJobPrisma, prisma } from '../lib/prisma';
import {
  insertAgreementsTx,
  insertClosureTx,
  loadClosure,
  loadClosureItems,
  loadProposals,
  presentHumans,
  reachClosedForAll,
  type ProposalRow,
} from './stage4-store';
import { scheduleIndividualCommitmentTendingEntries, scheduleSharedAgreementTendingEntries } from './tending.service';

export class Stage4CloseError extends Error {
  constructor(
    message: string,
    readonly code: 'VALIDATION_ERROR' | 'CONFLICT',
    readonly status: number,
  ) {
    super(message);
    this.name = 'Stage4CloseError';
  }
}

export interface CloseStage4Request {
  sessionId: string;
  participantId: string;
  kind?: Stage4ClosureKind;
  reason?: Stage4ClosureReason;
  summary?: string;
  checkInDate?: string;
  followUpDatesByProposalId?: Record<string, string>;
}

function buildClosureSummary(
  kind: Stage4ClosureKind,
  mutual: number,
  individual: number,
  open: number,
  requested?: string,
): string {
  if (requested) return requested;
  if (kind === Stage4ClosureKind.SHARED_AGREEMENT) {
    return `Closed with ${mutual} shared agreement${mutual === 1 ? '' : 's'} and ${individual} individual commitment${individual === 1 ? '' : 's'}.`;
  }
  return `Closed without a shared agreement, preserving ${individual} individual commitment${individual === 1 ? '' : 's'} and ${open} still-open need${open === 1 ? '' : 's'}.`;
}

async function allChoices(sessionId: string): Promise<Array<{ proposalId: string; participantId: string; decision: string }>> {
  return prisma.proposalChoice.findMany({
    where: { proposal: { sessionId } },
    select: { proposalId: true, participantId: true, decision: true },
  });
}

/** Individual commitments a closure keeps: not removed, its creator WILLING on it (v_session_closure_items' rule). */
function willingIndividualCommitments(
  proposals: ProposalRow[],
  choices: Array<{ proposalId: string; participantId: string; decision: string }>,
): ProposalRow[] {
  return proposals.filter(
    (p) =>
      p.kind === 'INDIVIDUAL_COMMITMENT' &&
      p.status !== 'REMOVED' &&
      choices.some((c) => c.proposalId === p.id && c.participantId === p.createdByParticipantId && c.decision === 'WILLING'),
  );
}

export async function closeStage4(req: CloseStage4Request): Promise<{
  kind: Stage4ClosureKind;
  reason: Stage4ClosureReason;
  agreementIds: string[];
  closedAt: Date;
}> {
  if (await loadClosure(req.sessionId)) throw new Stage4CloseError('Stage 4 is already closed', 'CONFLICT', 409);
  const humans = (await presentHumans(req.sessionId)).map((h) => h.id);
  const [proposals, choices, items, shared] = await Promise.all([
    loadProposals(req.sessionId),
    allChoices(req.sessionId),
    loadClosureItems(req.sessionId),
    prisma.participantMilestone.findMany({
      where: { participantId: { in: humans }, milestoneKey: 'choices_shared' },
      select: { participantId: true },
    }),
  ]);
  const sharedBy = new Set(shared.map((s) => s.participantId));
  const allSubmitted = humans.length > 0 && humans.every((h) => sharedBy.has(h));
  const willing = (proposalId: string) =>
    humans.every((h) => choices.some((c) => c.proposalId === proposalId && c.participantId === h && c.decision === 'WILLING'));
  const mutual = proposals
    .filter((p) => p.kind === 'SHARED_PROPOSAL' && p.status === 'ACTIVE' && willing(p.id))
    .slice(0, MAX_AGREEMENTS);
  const individual = willingIndividualCommitments(proposals, choices);

  const kind =
    req.kind ??
    (mutual.length > 0 && allSubmitted ? Stage4ClosureKind.SHARED_AGREEMENT : Stage4ClosureKind.NO_SHARED_AGREEMENT);
  if (kind === Stage4ClosureKind.SHARED_AGREEMENT) {
    if (!allSubmitted) {
      throw new Stage4CloseError('Both partners must submit selections before shared agreement closure', 'VALIDATION_ERROR', 400);
    }
    if (mutual.length === 0) {
      throw new Stage4CloseError('No mutually willing shared proposals are available to close', 'VALIDATION_ERROR', 400);
    }
  }
  if (
    kind === Stage4ClosureKind.NO_SHARED_AGREEMENT &&
    mutual.length > 0 &&
    req.reason !== Stage4ClosureReason.BOUNDARY_HONORED &&
    req.reason !== Stage4ClosureReason.USER_STOPPED
  ) {
    throw new Stage4CloseError(
      'Mutual willingness exists; no-shared-agreement closure requires an explicit boundary or stop reason',
      'VALIDATION_ERROR',
      400,
    );
  }

  const now = new Date();
  const reason =
    req.reason ??
    (kind === Stage4ClosureKind.SHARED_AGREEMENT
      ? Stage4ClosureReason.MUTUAL_SELECTION
      : allSubmitted
        ? Stage4ClosureReason.NO_OVERLAP
        : Stage4ClosureReason.USER_STOPPED);
  const summary = buildClosureSummary(kind, mutual.length, individual.length, items.openNeedIds.length, req.summary);
  const checkInAt = req.checkInDate ? new Date(req.checkInDate) : new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

  const agreementIds = await getJobPrisma().$transaction(async (tx) => {
    const ids =
      kind === Stage4ClosureKind.SHARED_AGREEMENT
        ? await insertAgreementsTx(tx, {
            sessionId: req.sessionId,
            actorParticipantId: req.participantId,
            partyParticipantIds: humans,
            at: now,
            agreements: mutual.map((p) => {
              const legacy = req.followUpDatesByProposalId?.[p.id];
              return {
                proposalId: p.id,
                type: AgreementType.MICRO_EXPERIMENT,
                description: p.description,
                duration: p.duration,
                measureOfSuccess: p.measureOfSuccess,
                followUpAt: legacy ? new Date(legacy) : checkInAt,
                fromStatus: p.status,
              };
            }),
          })
        : [];
    if (ids.length) {
      await scheduleSharedAgreementTendingEntries(
        req.sessionId,
        ids.map((id, i) => ({
          id,
          description: mutual[i].description,
          followUpDate: req.followUpDatesByProposalId?.[mutual[i].id] ? new Date(req.followUpDatesByProposalId[mutual[i].id]) : checkInAt,
        })),
        now,
        tx,
      );
    }
    const owned = individual.filter((p) => p.createdByParticipantId);
    if (owned.length) {
      await scheduleIndividualCommitmentTendingEntries(
        req.sessionId,
        owned.map((p) => ({ proposalId: p.id, ownerParticipantId: p.createdByParticipantId as string, description: p.description })),
        checkInAt,
        now,
        tx,
      );
    }
    await insertClosureTx(tx, {
      sessionId: req.sessionId,
      kind,
      reason,
      summary,
      closedByParticipantId: req.participantId,
      checkInAt,
      at: now,
    });
    return ids;
  });
  await reachClosedForAll(req.sessionId, now);
  return { kind, reason, agreementIds, closedAt: now };
}

/**
 * The conversational no-shared-agreement close (an explicit stop captured
 * from the participant's own message): closure only — no agreements, no
 * follow-ups.
 */
export async function closeStage4WithoutAgreement(args: {
  sessionId: string;
  participantId: string;
  reason: Stage4ClosureReason;
  summary?: string;
}): Promise<{ individualCount: number; openNeedCount: number }> {
  if (await loadClosure(args.sessionId)) throw new Stage4CloseError('Stage 4 is already closed', 'CONFLICT', 409);
  const [proposals, choices, items] = await Promise.all([
    loadProposals(args.sessionId),
    allChoices(args.sessionId),
    loadClosureItems(args.sessionId),
  ]);
  const individual = willingIndividualCommitments(proposals, choices);
  const now = new Date();
  await getJobPrisma().$transaction((tx) =>
    insertClosureTx(tx, {
      sessionId: args.sessionId,
      kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
      reason: args.reason,
      summary: buildClosureSummary(Stage4ClosureKind.NO_SHARED_AGREEMENT, 0, individual.length, items.openNeedIds.length, args.summary),
      closedByParticipantId: args.participantId,
      checkInAt: null,
      at: now,
    }),
  );
  await reachClosedForAll(args.sessionId, now);
  return { individualCount: individual.length, openNeedCount: items.openNeedIds.length };
}
