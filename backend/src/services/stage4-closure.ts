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
import { getWorkerPrisma } from '../lib/prisma';
import { getPgSqlState } from '../middleware/errors';
import { withSessionScope } from '../lib/request-context';
import { decryptRawRows } from '../lib/prisma-encryption-middleware';
import { insertAgreementsTx, insertClosureTx, loadClosure, loadClosureItems, type ProposalRow } from './stage4-store';
import { scheduleIndividualCommitmentTendingEntries, scheduleSharedAgreementTendingEntries } from './tending.service';
import type { Seat } from './participant-resolver';

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

const alreadyClosed = () => new Stage4CloseError('Stage 4 is already closed', 'CONFLICT', 409);

/**
 * Run a closure transaction; a concurrent close that committed first makes this one fail on a unique key (the
 * session_closure primary key, agreement.proposal_id) — answered as "already closed", the pre-check's answer, never a
 * 500 (review services#5; base mapped P2002 to the same 409). The whole transaction rolled back, so nothing of the
 * losing close stays.
 */
async function asCloseOnce<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // Only when the session is in fact closed now: any other unique violation is a real error.
    if (getPgSqlState(error) === '23505' && (await loadClosure(sessionId))) throw alreadyClosed();
    throw error;
  }
}

export interface CloseStage4Request {
  sessionId: string;
  /** The closer. */
  seat: Seat;
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

type ClosureChoice = { proposalId: string; userId: string; decision: string };
type ClosureProposal = Pick<
  ProposalRow,
  'id' | 'kind' | 'status' | 'description' | 'duration' | 'measureOfSuccess' | 'createdByUserId' | 'sharedAt'
>;

/**
 * What the closure decides on, read on the JOB connection (fix round 1,
 * Important 3): the closure is the job's decision across every participant,
 * not a cross-participant read of the closer's request connection (and under
 * TS-16 RLS the closer could not see the partner's unshared rows anyway).
 * Participants are named by user id: every row here is of the one session.
 */
async function closureInputsAsJob(sessionId: string): Promise<{
  humans: string[];
  sharedBy: Set<string>;
  proposals: ClosureProposal[];
  choices: ClosureChoice[];
}> {
  const job = getWorkerPrisma();
  const [humans, shared, proposals, choices] = await Promise.all([
    job.$queryRaw<Array<{ user_id: string }>>`
      SELECT user_id FROM participant
      WHERE session_id = ${sessionId}::uuid AND kind = 'human' AND left_at IS NULL ORDER BY user_id`,
    job.$queryRaw<Array<{ user_id: string }>>`
      SELECT pm.user_id FROM participant_milestone pm
      WHERE pm.session_id = ${sessionId}::uuid AND pm.milestone_key = 'choices_shared'`,
    job.$queryRaw<ClosureProposal[]>`
      SELECT id, kind::text AS kind, status::text AS status, description, duration, measure_of_success AS "measureOfSuccess",
             created_by_user_id AS "createdByUserId", shared_at AS "sharedAt"
      FROM proposal WHERE session_id = ${sessionId}::uuid ORDER BY id`.then(rows =>
      decryptRawRows(rows, {
        description: 'proposal.description',
        duration: 'proposal.duration',
        measureOfSuccess: 'proposal.measure_of_success',
      }),
    ),
    job.$queryRaw<ClosureChoice[]>`
      SELECT c.proposal_id AS "proposalId", c.user_id AS "userId", c.decision::text AS decision
      FROM proposal_choice c JOIN proposal pr ON pr.id = c.proposal_id WHERE pr.session_id = ${sessionId}::uuid`,
  ]);
  return { humans: humans.map(h => h.user_id), sharedBy: new Set(shared.map(s => s.user_id)), proposals, choices };
}

/** Individual commitments a closure keeps: not removed, its creator WILLING on it (v_session_closure_items' rule). */
function willingIndividualCommitments(proposals: ClosureProposal[], choices: ClosureChoice[]): ClosureProposal[] {
  return proposals.filter(
    p =>
      p.kind === 'INDIVIDUAL_COMMITMENT' &&
      p.status !== 'REMOVED' &&
      choices.some(c => c.proposalId === p.id && c.userId === p.createdByUserId && c.decision === 'WILLING'),
  );
}

/** What the closer may see: their own commitments and shared ones (the response to the closer). */
const visibleToCloser = (closer: Seat) => (p: ClosureProposal) =>
  p.createdByUserId === closer.userId || p.sharedAt !== null;

/**
 * What the session_closure summary may count: only commitments shared with every member. The summary is read by
 * every member (session_closure app_select), so a count of the closer's own unshared commitments would tell the
 * partner they exist (work-k5fk.32 S1 sweep).
 */
const sharedWithEveryone = (p: ClosureProposal) => p.sharedAt !== null;

export function closeStage4(req: CloseStage4Request): Promise<{
  kind: Stage4ClosureKind;
  reason: Stage4ClosureReason;
  agreementIds: string[];
  closedAt: Date;
}> {
  // The closure is the system's decision across every participant: mwf_worker, scoped to the session
  // (work-k5fk.10.5; t_session_scope binds its agreement / closure writes to it).
  return withSessionScope(req.sessionId, () => closeStage4InScope(req));
}

async function closeStage4InScope(req: CloseStage4Request): Promise<{
  kind: Stage4ClosureKind;
  reason: Stage4ClosureReason;
  agreementIds: string[];
  closedAt: Date;
}> {
  if (await loadClosure(req.sessionId)) throw alreadyClosed();
  const [{ humans, sharedBy, proposals, choices }, items] = await Promise.all([
    closureInputsAsJob(req.sessionId),
    loadClosureItems(req.sessionId),
  ]);
  const allSubmitted = humans.length > 0 && humans.every(h => sharedBy.has(h));
  // A partner's choices count only once every present human has shared: before
  // that, mutual willingness is not known to the closer, and neither the
  // closure kind nor any refusal may depend on it (no oracle on unshared choices).
  const willing = (proposalId: string) =>
    humans.every(h => choices.some(c => c.proposalId === proposalId && c.userId === h && c.decision === 'WILLING'));
  const mutual = allSubmitted
    ? proposals
        .filter(p => p.kind === 'SHARED_PROPOSAL' && p.status === 'ACTIVE' && willing(p.id))
        .slice(0, MAX_AGREEMENTS)
    : [];
  // Each creator's own WILLING on their own commitment schedules its follow-up
  // (an INDIVIDUAL one, theirs alone); the summary counts only what the closer may see.
  const individual = willingIndividualCommitments(proposals, choices);
  const individualShared = individual.filter(sharedWithEveryone);

  const kind =
    req.kind ??
    (mutual.length > 0 && allSubmitted ? Stage4ClosureKind.SHARED_AGREEMENT : Stage4ClosureKind.NO_SHARED_AGREEMENT);
  if (kind === Stage4ClosureKind.SHARED_AGREEMENT) {
    if (!allSubmitted) {
      throw new Stage4CloseError(
        'Both partners must submit selections before shared agreement closure',
        'VALIDATION_ERROR',
        400,
      );
    }
    if (mutual.length === 0) {
      throw new Stage4CloseError(
        'No mutually willing shared proposals are available to close',
        'VALIDATION_ERROR',
        400,
      );
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
  const summary = buildClosureSummary(
    kind,
    mutual.length,
    individualShared.length,
    items.openNeedIds.length,
    req.summary,
  );
  const checkInAt = req.checkInDate ? new Date(req.checkInDate) : new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

  const agreementIds = await asCloseOnce(req.sessionId, () =>
    getWorkerPrisma().$transaction(async tx => {
      const ids =
        kind === Stage4ClosureKind.SHARED_AGREEMENT
          ? await insertAgreementsTx(tx, {
              sessionId: req.sessionId,
              actorUserId: req.seat.userId,
              partyUserIds: humans,
              at: now,
              agreements: mutual.map(p => {
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
            followUpDate: req.followUpDatesByProposalId?.[mutual[i].id]
              ? new Date(req.followUpDatesByProposalId[mutual[i].id])
              : checkInAt,
          })),
          now,
          tx,
        );
      }
      const owned = individual.filter(p => p.createdByUserId);
      if (owned.length) {
        await scheduleIndividualCommitmentTendingEntries(
          req.sessionId,
          owned.map(p => ({
            proposalId: p.id,
            ownerUserId: p.createdByUserId as string,
            description: p.description,
          })),
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
        closedByUserId: req.seat.userId,
        checkInAt,
        at: now,
      });
      return ids;
    }),
  );
  // Every present human's `closed` is written with the closure row, in its transaction (t_session_closure_closed;
  // review services#4): a closed session never leaves its participants at stage 4.
  return { kind, reason, agreementIds, closedAt: now };
}

/**
 * The conversational no-shared-agreement close (an explicit stop captured
 * from the participant's own message): closure only — no agreements, no
 * follow-ups.
 */
export async function closeStage4WithoutAgreement(args: {
  sessionId: string;
  /** The closer. */
  seat: Seat;
  reason: Stage4ClosureReason;
  summary?: string;
}): Promise<{ individualCount: number; openNeedCount: number }> {
  if (await loadClosure(args.sessionId)) throw alreadyClosed();
  const [{ proposals, choices }, items] = await Promise.all([
    closureInputsAsJob(args.sessionId),
    loadClosureItems(args.sessionId),
  ]);
  const willing = willingIndividualCommitments(proposals, choices);
  const individual = willing.filter(visibleToCloser(args.seat));
  const individualShared = willing.filter(sharedWithEveryone);
  const now = new Date();
  await asCloseOnce(args.sessionId, () =>
    withSessionScope(
      args.sessionId,
      async () =>
        await getWorkerPrisma().$transaction(tx =>
          insertClosureTx(tx, {
            sessionId: args.sessionId,
            kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
            reason: args.reason,
            summary: buildClosureSummary(
              Stage4ClosureKind.NO_SHARED_AGREEMENT,
              0,
              individualShared.length,
              items.openNeedIds.length,
              args.summary,
            ),
            closedByUserId: args.seat.userId,

            checkInAt: null,
            at: now,
          }),
        ),
    ),
  );
  return { individualCount: individual.length, openNeedCount: items.openNeedIds.length };
}
