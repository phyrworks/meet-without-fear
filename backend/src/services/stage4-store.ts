/**
 * The repair stage on the target tables (TS-11; spec §1.4, §4).
 *
 * Old model → target ("old gate": a key of the old StageProgress.gatesSatisfied
 * JSON column, which the target does not have):
 *
 *   StrategyProposal (+ needsAddressed[])   → proposal + proposal_need (need_share ids only;
 *                                            labels nothing matches → unresolved_need_labels)
 *   Stage4ProposalRevision                  → proposal_revision (append-only, no message id)
 *   Stage4ProposalSelection                 → proposal_choice (withdraw = DELETE)
 *   old gate stage4Walkthrough,
 *   Stage4NeedDeclination                   → need_disposition (over need_share ids; one is_current)
 *   old gate selectionSubmitted             → participant_milestone choices_shared
 *   walkthrough started                     → participant_milestone repair_walkthrough_started (job)
 *   Stage4NeedCoverage                      → v_need_coverage (computed; no table, no note)
 *   Agreement (agreedByA/B)                 → agreement + agreement_party, JOB path only
 *   Stage4Closure (+ three id arrays)       → session_closure (JOB) + v_session_closure_items
 *   StrategyRanking, CommonGround           → nothing (ranking is not in the product)
 *
 * Visibility (the RLS arms TS-16 will enforce, applied here in the query):
 * a co-participant's `proposal_choice` is read only once that participant has
 * reached `choices_shared`; partner needs are `need_share` rows only.
 */

import type { NeedCategory } from '@meet-without-fear/shared';
import type { Prisma, PrismaClient } from '../generated/prisma/client';

/** A transaction on the JOB connection. */
export type JobTx = Prisma.TransactionClient;
import { getWorkerPrisma, prisma } from '../lib/prisma';
import { getPgSqlState } from '../middleware/errors';
import { withSessionScope } from '../lib/request-context';
import { decryptRawRows, encryptColumnValue } from '../lib/prisma-encryption-middleware';
import { reencryptForSession } from '../lib/share-moments';
import {
  PROPOSAL_REVISION_REASONS,
  proposalRevisionReason,
  type ProposalRevisionReason,
} from './proposal-revision-reasons';
import { reachMilestone } from './milestone-writer';
import type { Seat } from './participant-resolver';

// ============================================================================
// Rows
// ============================================================================

export type ProposalKind = 'SHARED_PROPOSAL' | 'INDIVIDUAL_COMMITMENT';
export type ProposalStatus = 'ACTIVE' | 'REVISED' | 'REMOVED' | 'CONVERTED_TO_AGREEMENT';
export type ChoiceDecision = 'WILLING' | 'NOT_WILLING';
export type DispositionStatus = 'OPEN' | 'COVERED' | 'PARTIAL' | 'SKIPPED';

export interface ProposalRow {
  id: string;
  sessionId: string;
  createdByUserId: string | null;
  source: 'USER_SUBMITTED' | 'AI_SUGGESTED' | 'CURATED';
  kind: ProposalKind;
  status: ProposalStatus;
  description: string;
  duration: string | null;
  measureOfSuccess: string | null;
  unresolvedNeedLabels: string[];
  removedAt: Date | null;
  removedByUserId: string | null;
  removalReason: string | null;
  sharedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** `proposal_need`: the need_share ids the proposal addresses. */
  needIds: string[];
}

export interface ChoiceRow {
  proposalId: string;
  userId: string;
  decision: ChoiceDecision;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CoverageRow {
  needId: string;
  needOwnerUserId: string;
  coveringProposalIds: string[];
  willingUserIds: string[];
  status: 'COVERED' | 'PARTIAL' | 'OPEN';
}

export interface DispositionRow {
  userId: string;
  needId: string;
  status: DispositionStatus;
  isCurrent: boolean;
  /** "Leave for now": a fact apart from the walkthrough's status (review services#5). */
  declinedAt: Date | null;
  updatedAt: Date;
}

/** A shared need as one participant may name it: their own label for their own need, else the shared text. */
export interface Stage4Need {
  id: string;
  ownerUserId: string;
  category: NeedCategory;
  sharedText: string;
  /** What THIS viewer sees: own label (owner may read need.label) or the partner's shared text. */
  label: string;
  sharedAt: Date;
}

export interface ClosureRow {
  sessionId: string;
  kind: 'SHARED_AGREEMENT' | 'NO_SHARED_AGREEMENT';
  reason: 'MUTUAL_SELECTION' | 'NO_OVERLAP' | 'BOUNDARY_HONORED' | 'USER_STOPPED';
  summary: string;
  closedByUserId: string | null;
  checkInAt: Date | null;
  closedAt: Date;
}

export interface ClosureItems {
  agreementIds: string[];
  individualCommitmentIds: string[];
  openNeedIds: string[];
}

export interface AgreementRow {
  id: string;
  sessionId: string;
  proposalId: string;
  type: 'MICRO_EXPERIMENT' | 'COMMITMENT' | 'CHECK_IN' | 'HYBRID';
  status: 'AGREED' | 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED';
  description: string;
  duration: string | null;
  measureOfSuccess: string | null;
  followUpAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  parties: Array<{ userId: string; agreedAt: Date }>;
}

// ============================================================================
// Reads
// ============================================================================

const PROPOSAL_SELECT = {
  id: true,
  sessionId: true,
  createdByUserId: true,
  source: true,
  kind: true,
  status: true,
  description: true,
  duration: true,
  measureOfSuccess: true,
  unresolvedNeedLabels: true,
  removedAt: true,
  removedByUserId: true,
  removalReason: true,
  sharedAt: true,
  createdAt: true,
  updatedAt: true,
  needs: { select: { needId: true }, orderBy: { createdAt: 'asc' as const } },
} as const;

type RawProposal = Omit<ProposalRow, 'needIds'> & { needs: Array<{ needId: string }> };

const toProposal = ({ needs, ...p }: RawProposal): ProposalRow => ({ ...p, needIds: needs.map(n => n.needId) });

type ProposalAccessFacts = Pick<ProposalRow, 'kind' | 'createdByUserId' | 'sharedAt'>;

/**
 * May `viewer` see the proposal (loadProposals' rule, spec §1.4): every
 * SHARED_PROPOSAL — shared with every member from birth — and an
 * INDIVIDUAL_COMMITMENT only to its creator, or once shared (shared_at, which
 * shareCommitment stamps through app.proposal_share). The proposal app_select
 * policy is the same rule in the database (work-k5fk.32 S1).
 */
export function proposalVisibleTo(p: ProposalAccessFacts, viewer: Seat): boolean {
  return p.kind === 'SHARED_PROPOSAL' || p.createdByUserId === viewer.userId || p.sharedAt !== null;
}

/**
 * May `editor` edit or revise the proposal: creator-only until shared (owner
 * decision 2026-11-23, work-k5fk.10.10 / 10.11). Their own, or a
 * SHARED_PROPOSAL visible to them — never the partner's INDIVIDUAL_COMMITMENT,
 * even once shared_at makes it visible. The app's side of the proposal
 * app_update / proposal_revision app_insert policies, checked first so a
 * request is refused cleanly instead of by the database. (A converted
 * proposal is refused by the policy as well; callers that may meet one check
 * status themselves.)
 */
export function proposalEditableBy(p: ProposalAccessFacts, editor: Seat): boolean {
  return p.createdByUserId === editor.userId || (p.kind === 'SHARED_PROPOSAL' && proposalVisibleTo(p, editor));
}

/**
 * The session's proposals a viewer may see, newest update first: every
 * SHARED_PROPOSAL, and an INDIVIDUAL_COMMITMENT only to its creator or once
 * shared (spec §1.4 proposal RLS; proposalVisibleTo).
 */
export async function loadProposals(sessionId: string, viewer?: Seat): Promise<ProposalRow[]> {
  const rows = (await prisma.proposal.findMany({
    where: {
      sessionId,
      ...(viewer
        ? {
            OR: [
              { kind: 'SHARED_PROPOSAL' },
              { createdByUserId: viewer.userId },
              { sharedAt: { not: null } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: PROPOSAL_SELECT,
  })) as unknown as RawProposal[];
  return rows.map(toProposal);
}

export async function loadProposal(proposalId: string): Promise<ProposalRow | null> {
  const row = (await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: PROPOSAL_SELECT,
  })) as unknown as RawProposal | null;
  return row ? toProposal(row) : null;
}

/**
 * Of `proposalIds`, those the seat proposed or confirmed as an agreement in the legacy agreement flow (their own
 * LEGACY_PROPOSED / LEGACY_CONFIRMED revision — a public act every member reads). On these the seat's WILLING is that
 * act's substance: the legacy flow forms the agreement once every party has acted and is WILLING, so a private move
 * off WILLING would show the partner, as an agreement that never forms, a stance not yet shared (review B1 leftover,
 * work-k5fk.34). The Stage 4 selection paths refuse that move.
 */
export async function legacyAgreedProposalIds(seat: Seat, proposalIds: string[]): Promise<Set<string>> {
  if (proposalIds.length === 0) return new Set();
  const rows = await prisma.proposalRevision.findMany({
    where: {
      sessionId: seat.sessionId,
      actorUserId: seat.userId,
      proposalId: { in: proposalIds },
      reason: { in: [PROPOSAL_REVISION_REASONS.LEGACY_PROPOSED, PROPOSAL_REVISION_REASONS.LEGACY_CONFIRMED] },
    },
    select: { proposalId: true },
  });
  return new Set(rows.map(r => r.proposalId));
}

/**
 * The choices `viewer` may read: their own, and a co-participant's only once
 * that participant has reached `choices_shared` (the proposal_choice RLS arm).
 */
export async function loadVisibleChoices(sessionId: string, viewer: Seat): Promise<ChoiceRow[]> {
  return decryptRawRows(
    await prisma.$queryRaw<ChoiceRow[]>`
    SELECT c.proposal_id AS "proposalId", c.user_id AS "userId", c.decision::text AS decision,
           c.note, c.created_at AS "createdAt", c.updated_at AS "updatedAt"
    FROM proposal_choice c
    JOIN proposal pr ON pr.id = c.proposal_id AND pr.session_id = ${sessionId}::uuid
    WHERE c.session_id = ${sessionId}::uuid
      AND (c.user_id = ${viewer.userId}::uuid
           OR EXISTS (SELECT 1 FROM participant_milestone pm
                      WHERE pm.session_id = c.session_id AND pm.user_id = c.user_id
                        AND pm.milestone_key = 'choices_shared'))
    ORDER BY c.updated_at DESC, c.proposal_id`,
    { note: 'proposal_choice.note' },
  );
}

/** `v_need_coverage` for the session (shared needs only). */
export async function loadCoverage(sessionId: string): Promise<CoverageRow[]> {
  return prisma.$queryRaw<CoverageRow[]>`
    SELECT need_id AS "needId", need_owner_user_id AS "needOwnerUserId",
           covering_proposal_ids AS "coveringProposalIds", willing_user_ids AS "willingUserIds",
           status
    FROM v_need_coverage WHERE session_id = ${sessionId}::uuid`;
}

/**
 * Coverage of one need from the proposals and choices a viewer may see — the
 * ONE implementation of R20 the app uses (the view's rule under the viewer's
 * RLS): the covering proposals the viewer may see, the present humans WILLING
 * on one of them (from the viewer's visible choices), and COVERED when every
 * present human is, PARTIAL when some are, OPEN otherwise. Pure.
 */
export function visibleCoverageOf(
  coveringProposalIds: string[],
  visibleProposalIds: Set<string>,
  visibleChoices: Array<{ proposalId: string; userId: string; decision: string }>,
  humanUserIds: string[],
): { coveringProposalIds: string[]; willingUserIds: string[]; status: CoverageRow['status'] } {
  const covering = coveringProposalIds.filter(id => visibleProposalIds.has(id));
  const willing = [
    ...new Set(
      visibleChoices
        .filter(ch => ch.decision === 'WILLING' && covering.includes(ch.proposalId) && humanUserIds.includes(ch.userId))
        .map(ch => ch.userId),
    ),
  ];
  const status: CoverageRow['status'] =
    willing.length === 0 ? 'OPEN' : willing.length >= humanUserIds.length ? 'COVERED' : 'PARTIAL';
  return { coveringProposalIds: covering, willingUserIds: willing, status };
}

/**
 * `v_need_coverage` as `viewer` may see it (TS-11 fix round 2): covering
 * proposals limited to the proposals the viewer may see, and the status
 * recomputed from the choices the viewer may see (their own, and a partner's
 * once the partner has reached choices_shared) — the rule the view applies
 * under the viewer's RLS (TS-16; R20: COVERED when every present human is
 * WILLING on a covering proposal, PARTIAL when some are, OPEN otherwise). On
 * the app connection today the view spans every choice, so its own `status`
 * would let a partner's unshared WILLING change what the viewer is told
 * (the share gate, the prompt's open needs) — the closure-oracle class (I3).
 */
export async function loadVisibleCoverage(sessionId: string, viewer: Seat): Promise<CoverageRow[]> {
  const [coverage, proposals, choices, humans] = await Promise.all([
    loadCoverage(sessionId),
    loadProposals(sessionId, viewer),
    loadVisibleChoices(sessionId, viewer),
    presentHumans(sessionId),
  ]);
  const visible = new Set(proposals.map(p => p.id));
  const humanUserIds = humans.map(h => h.userId);
  return coverage.map(c => ({ ...c, ...visibleCoverageOf(c.coveringProposalIds, visible, choices, humanUserIds) }));
}

/**
 * The session's live shared needs as `viewer` names them (v_need_shared; the
 * viewer's own need labels from their own `need` rows — need_share.need_id is
 * the need's id).
 */
export async function loadStage4Needs(sessionId: string, viewer: Seat): Promise<Stage4Need[]> {
  const shared = decryptRawRows(
    await prisma.$queryRaw<
      Array<{ needId: string; userId: string; category: NeedCategory; sharedText: string; sharedAt: Date }>
    >`
    SELECT need_id AS "needId", user_id AS "userId", category::text AS category,
           shared_text AS "sharedText", shared_at AS "sharedAt"
    FROM v_need_shared WHERE session_id = ${sessionId}::uuid`,
    { sharedText: 'need_share.shared_text' },
  );
  const ownIds = shared.filter(n => n.userId === viewer.userId).map(n => n.needId);
  const own = ownIds.length
    ? await prisma.need.findMany({
        where: { id: { in: ownIds }, sessionId: viewer.sessionId, userId: viewer.userId },
        select: { id: true, label: true, createdAt: true },
      })
    : [];
  const ownById = new Map(own.map(n => [n.id, n]));
  return shared
    .map(n => ({
      id: n.needId,
      ownerUserId: n.userId,
      category: n.category,
      sharedText: n.sharedText,
      label: ownById.get(n.needId)?.label ?? n.sharedText,
      sharedAt: n.sharedAt,
      order: ownById.get(n.needId)?.createdAt ?? n.sharedAt,
    }))
    .sort((a, b) => a.order.getTime() - b.order.getTime() || (a.id < b.id ? -1 : 1))
    .map(({ order: _order, ...n }) => n);
}

export async function loadDispositions(seat: Seat): Promise<DispositionRow[]> {
  return (await prisma.needDisposition.findMany({
    where: { sessionId: seat.sessionId, userId: seat.userId },
    select: { userId: true, needId: true, status: true, isCurrent: true, declinedAt: true, updatedAt: true },
  })) as DispositionRow[];
}

export async function loadClosure(sessionId: string): Promise<ClosureRow | null> {
  return (await prisma.sessionClosure.findUnique({
    where: { sessionId },
    select: {
      sessionId: true,
      kind: true,
      reason: true,
      summary: true,
      closedByUserId: true,
      checkInAt: true,
      closedAt: true,
    },
  })) as ClosureRow | null;
}

/** `v_session_closure_items`: agreements, individual commitments, open (shared) needs. */
export async function loadClosureItems(sessionId: string): Promise<ClosureItems> {
  const [row] = await prisma.$queryRaw<ClosureItems[]>`
    SELECT agreement_ids AS "agreementIds", individual_commitment_ids AS "individualCommitmentIds",
           open_need_ids AS "openNeedIds"
    FROM v_session_closure_items WHERE session_id = ${sessionId}::uuid`;
  return row ?? { agreementIds: [], individualCommitmentIds: [], openNeedIds: [] };
}

export async function loadAgreements(sessionId: string): Promise<AgreementRow[]> {
  return (await prisma.agreement.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      sessionId: true,
      proposalId: true,
      type: true,
      status: true,
      description: true,
      duration: true,
      measureOfSuccess: true,
      followUpAt: true,
      completedAt: true,
      createdAt: true,
      parties: { select: { userId: true, agreedAt: true } },
    },
  })) as AgreementRow[];
}

export async function hasMilestone(seat: Seat, key: string): Promise<boolean> {
  return (
    (await prisma.participantMilestone.count({
      where: { sessionId: seat.sessionId, userId: seat.userId, milestoneKey: key },
    })) > 0
  );
}

/** Present human participants of the session, in join order. */
export async function presentHumans(sessionId: string): Promise<Seat[]> {
  return prisma.participant.findMany({
    where: { sessionId, kind: 'human', leftAt: null },
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    select: { sessionId: true, userId: true },
  });
}

// ============================================================================
// Writes (app connection: the participant's own rows)
// ============================================================================

/** Record (or change) the participant's choice on a proposal. `selectedAt` semantics: a change re-stamps created_at. */
export async function upsertChoice(args: {
  proposalId: string;
  seat: Seat;
  decision: ChoiceDecision;
  note?: string | null;
  at?: Date;
}): Promise<void> {
  const at = args.at ?? new Date();
  await prisma.$executeRaw`
    INSERT INTO proposal_choice (proposal_id, session_id, user_id, decision, note, created_at, updated_at)
    VALUES (${args.proposalId}::uuid, ${args.seat.sessionId}::uuid, ${args.seat.userId}::uuid,
            ${args.decision}::choice_decision,
            ${encryptColumnValue('proposal_choice', 'note', args.note ?? null)}, ${at}, ${at})
    ON CONFLICT (proposal_id, session_id, user_id)
    DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note, created_at = EXCLUDED.created_at`;
}

/** Withdraw a choice before closure (spec: withdraw = DELETE). */
export async function withdrawChoice(proposalId: string, seat: Seat): Promise<void> {
  await prisma.proposalChoice.deleteMany({ where: { proposalId, sessionId: seat.sessionId, userId: seat.userId } });
}

/** The participant shares their choices: `choices_shared` (self-assertable, app connection). */
export async function shareChoices(seat: Seat): Promise<boolean> {
  // Share moment (writer-principal rule): the participant's choices — their
  // notes — become the co-participant's to read with the milestone, so the
  // hook runs in the milestone's transaction. W13 re-encrypts here.
  // Shares no individual commitment: each is shared by its own action (shareCommitment; owner decision 2026-11-25,
  // work-k5fk.37 — was: every one of the participant's commitments, with their stances).
  return prisma.$transaction(async tx => {
    const reached = await reachMilestone(seat, 'choices_shared', new Date(), tx);
    await reencryptForSession(
      {
        moment: 'choices-shared',
        sessionId: seat.sessionId,
        // Every choice of the participant: their user id, within the event's session.
        rows: [{ table: 'proposal_choice', id: seat.userId, by: 'user_id' }],
      },
      tx,
    );
    return reached;
  });
}

/**
 * Share one of the participant's own individual commitments with the co-participants (owner decision 2026-11-25,
 * work-k5fk.37): app.proposal_share, identity-bound (the request's user; it must be the creator, present) — stamps its
 * shared_at once; never cleared. It releases only the commitment's current text: its revisions (earlier wordings, the
 * captured quote) stay the creator's (proposal_revision app_select). The description is session-encrypted, so
 * nothing re-encrypts. True when stamped now, false when it was already shared.
 */
export async function shareCommitment(proposalId: string): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ stamped: boolean }>>`
    SELECT app.proposal_share(${proposalId}::uuid) AS stamped`;
  return row.stamped;
}

/**
 * Withdraw the share so the participant can revise: their own `choices_shared` goes
 * (app.choices_unshare, identity-bound — the seat is the caller's; work-k5fk.10.5: was the job's DELETE).
 */
export async function unshareChoices(seat: Seat): Promise<void> {
  await prisma.$executeRaw`SELECT app.choices_unshare(${seat.sessionId}::uuid)`;
}

/**
 * Link a proposal to shared needs. Only `need_share` ids can be named (FK):
 * a label that resolves to no shared need of the session is kept as text in
 * `unresolved_need_labels`.
 */
export async function setProposalNeeds(
  db: Pick<PrismaClient, 'proposalNeed' | 'proposal'>,
  proposalId: string,
  needIds: string[],
  unresolvedLabels: string[] = [],
): Promise<void> {
  const unique = [...new Set(needIds)];
  const { sessionId } = await db.proposal.findUniqueOrThrow({ where: { id: proposalId }, select: { sessionId: true } });
  await db.proposalNeed.deleteMany({ where: { proposalId, needId: { notIn: unique } } });
  for (const needId of unique) {
    await db.proposalNeed.upsert({
      where: { proposalId_needId: { proposalId, needId } },
      create: { proposalId, needId, sessionId },
      update: {},
    });
  }
  await db.proposal.update({
    where: { id: proposalId },
    data: { unresolvedNeedLabels: [...new Set(unresolvedLabels)] },
  });
}

function normalizeNeedToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function needLabelMatches(label: string, need: string): boolean {
  const a = normalizeNeedToken(label);
  const b = normalizeNeedToken(need);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const tokensA = new Set(a.split(' ').filter(token => token.length > 2));
  const tokensB = new Set(b.split(' ').filter(token => token.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  const denom = Math.min(tokensA.size, tokensB.size);
  return denom > 0 && shared / denom >= 0.5;
}

/**
 * Resolve the labels a proposal claims to address against the session's
 * shared needs as `actor` names them (their own labels, the partner's shared
 * text); a label may also be a need_share id.
 */
export async function resolveNeedLabels(
  sessionId: string,
  actor: Seat,
  labels: string[] | null | undefined,
): Promise<{ needIds: string[]; unresolved: string[] }> {
  if (!labels || labels.length === 0) return { needIds: [], unresolved: [] };
  const needs = await loadStage4Needs(sessionId, actor);
  const needIds = new Set<string>();
  const unresolved: string[] = [];
  for (const label of labels) {
    const hits = needs.filter(
      n => label === n.id || needLabelMatches(label, n.label) || needLabelMatches(label, n.sharedText),
    );
    if (hits.length === 0) unresolved.push(label);
    for (const h of hits) needIds.add(h.id);
  }
  return { needIds: [...needIds], unresolved };
}

// ============================================================================
// Job writers (spec: agreement / agreement_party / session_closure are "I job")
// ============================================================================

export interface AgreementToCreate {
  proposalId: string;
  type: AgreementRow['type'];
  description: string;
  duration: string | null;
  measureOfSuccess: string | null;
  followUpAt: Date | null;
  /** The proposal's status before conversion (revision `before`). */
  fromStatus: ProposalStatus;
}

/**
 * Create agreements on the JOB connection, one transaction: the agreement
 * row, one `agreement_party` per present human (the deferred
 * T-agreement-parties checks at COMMIT that the party set is every present
 * human and each is WILLING on the proposal — a missing WILLING aborts the
 * whole transaction), the proposal converted, and its revision row.
 */
export interface CreateAgreementsArgs {
  sessionId: string;
  actorUserId: string | null;
  partyUserIds: string[];
  agreements: AgreementToCreate[];
  at?: Date;
  /** A proposal_revision.reason marker (R47); never free text. */
  reason?: ProposalRevisionReason;
}

export async function createAgreementsAsJob(args: CreateAgreementsArgs): Promise<string[]> {
  // The worker, scoped to the session (work-k5fk.10.5: t_session_scope binds its agreement writes to it).
  return withSessionScope(
    args.sessionId,
    async () => await getWorkerPrisma().$transaction(tx => insertAgreementsTx(tx, args)),
  );
}

/** The writes of `createAgreementsAsJob`, inside a caller's worker transaction scoped to the session. */
export async function insertAgreementsTx(tx: JobTx, args: CreateAgreementsArgs): Promise<string[]> {
  const at = args.at ?? new Date();
  {
    const ids: string[] = [];
    for (const a of args.agreements) {
      const [row] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO agreement (session_id, proposal_id, type, status, description, duration, measure_of_success, follow_up_at)
        VALUES (${args.sessionId}::uuid, ${a.proposalId}::uuid, ${a.type}::agreement_type, 'AGREED',
                ${encryptColumnValue('agreement', 'description', a.description)},
                ${encryptColumnValue('agreement', 'duration', a.duration)},
                ${encryptColumnValue('agreement', 'measure_of_success', a.measureOfSuccess)}, ${a.followUpAt})
        RETURNING id`;
      ids.push(row.id);
      for (const uid of args.partyUserIds) {
        await tx.$executeRaw`
          INSERT INTO agreement_party (agreement_id, session_id, user_id, agreed_at)
          VALUES (${row.id}::uuid, ${args.sessionId}::uuid, ${uid}::uuid, ${at})`;
      }
      await tx.$executeRaw`
        UPDATE proposal SET status = 'CONVERTED_TO_AGREEMENT' WHERE id = ${a.proposalId}::uuid`;
      await tx.$executeRaw`
        INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action, before, after, reason)
        VALUES (${a.proposalId}::uuid, ${args.sessionId}::uuid, ${args.actorUserId}::uuid, 'CONVERTED',
                ${JSON.stringify(encryptColumnValue('proposal_revision', 'before', { status: a.fromStatus }))}::jsonb,
                ${JSON.stringify(encryptColumnValue('proposal_revision', 'after', { agreementId: row.id, status: 'CONVERTED_TO_AGREEMENT' }))}::jsonb,
                ${proposalRevisionReason(args.reason ?? PROPOSAL_REVISION_REASONS.MUTUAL_CLOSURE)}::proposal_revision_reason)`;
    }
    return ids;
  }
}

/**
 * Close the repair stage on the JOB connection: the `session_closure` row and
 * the session RESOLVED (app.session_set_status), in one transaction; its
 * t_session_closure_closed trigger reaches `closed` for every present human in
 * the same transaction (review services#4).
 */
export interface CloseSessionArgs {
  sessionId: string;
  kind: ClosureRow['kind'];
  reason: ClosureRow['reason'];
  summary: string;
  closedByUserId: string | null;
  checkInAt: Date | null;
  at?: Date;
}

export async function closeSessionAsJob(args: CloseSessionArgs): Promise<void> {
  try {
    await withSessionScope(
      args.sessionId,
      async () => await getWorkerPrisma().$transaction(tx => insertClosureTx(tx, args)),
    );
  } catch (error) {
    // A concurrent close committed first (the session_closure primary key): the session is closed, as asked.
    if (getPgSqlState(error) !== '23505') throw error;
  }
}

/** The closure row and the session RESOLVED, inside a caller's worker transaction scoped to the session. */
export async function insertClosureTx(tx: JobTx, args: CloseSessionArgs): Promise<void> {
  const at = args.at ?? new Date();
  await tx.$executeRaw`
    INSERT INTO session_closure (session_id, kind, reason, summary, closed_by_user_id, check_in_at, closed_at)
    VALUES (${args.sessionId}::uuid, ${args.kind}::closure_kind, ${args.reason}::closure_reason, ${encryptColumnValue('session_closure', 'summary', args.summary)},
            ${args.closedByUserId}::uuid, ${args.checkInAt}, ${at})`;
  await tx.$executeRaw`SELECT app.session_set_status(${args.sessionId}::uuid, 'RESOLVED'::session_status)`;
}
