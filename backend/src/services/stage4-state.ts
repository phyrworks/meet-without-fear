/**
 * The redesigned Stage 4 state DTO (`GetStage4StateResponse`), on the target
 * tables (TS-11). The DTO shape is unchanged; its sources moved:
 *
 *   coverage rows   v_need_coverage (computed; ruling R20: ACTIVE, REVISED and
 *                   CONVERTED_TO_AGREEMENT cover) — the coverage `note` has no
 *                   table and is dropped (null; "Still open" on an open need)
 *   need names      the viewer's OWN needs by their own label; the partner's by
 *                   `need_share.shared_text` — never the partner's label
 *   need ids        need_share ids (= the need's id)
 *   walkthrough     need_disposition (covered / skipped / current); the phase
 *                   follows the current need's owner
 *   declinations    need_disposition DECLINED
 *   "submitted"     participant_milestone choices_shared
 *   partner choices only once the partner has reached choices_shared AND the
 *                   viewer has (unchanged rule: both shared)
 *   outcome         session_closure + v_session_closure_items
 *   Tending preview follow_up
 */

import {
  AgreementDTO,
  CoverageRowDTO,
  GetStage4StateResponse,
  ProposalCardDTO,
  Stage4NeedWalkthroughStatus,
  Stage4ProposalSourceLabel,
  Stage4QualityWarningDTO,
  Stage4CoverageAuditDTO,
  Stage4ClosureKind,
  Stage4Phase,
  Stage4ProposalKind,
  Stage4SelectionDecision,
  Stage4SelectionDTO,
  Stage4ProposalStatus,
  Stage4WalkthroughDTO,
  Stage4WalkthroughPhase,
  TendingPreviewDTO,
  UnaddressedNeedDTO,
} from '@meet-without-fear/shared';
import { getPartnerParticipant, resolveParticipant } from './participant-resolver';
import {
  hasMilestone,
  loadAgreements,
  loadClosure,
  loadClosureItems,
  loadCoverage,
  loadDispositions,
  loadProposals,
  loadStage4Needs,
  loadVisibleChoices,
  presentHumans,
  type AgreementRow,
  type ChoiceRow,
  type ClosureItems,
  type ClosureRow,
  type CoverageRow,
  type DispositionRow,
  type ProposalRow,
  type Stage4Need,
} from './stage4-store';
import { loadFollowUpsForParticipant, toTendingEntryType, type FollowUpRow } from './tending.service';

/** One shared need as the Stage 4 state names it (the old coverage row's role). */
type CoverageView = {
  id: string;
  label: string;
  ownerParticipantId: string;
  coverageStatus: 'COVERED' | 'PARTIAL' | 'OPEN';
  coveringProposalIds: string[];
  note: string | null;
};

type WalkthroughStored = {
  phase?: Stage4WalkthroughPhase;
  currentNeedId?: string | null;
  coveredNeedIds: string[];
  skippedNeedIds: string[];
};

export class Stage4StateNotFoundError extends Error {
  constructor() {
    super('Session not found');
    this.name = 'Stage4StateNotFoundError';
  }
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function sourceLabel(owner: string | null, me: string, partner: string | null): CoverageRowDTO['source'] {
  if (!owner) return 'UNKNOWN';
  if (owner === me) return 'YOU';
  if (owner === partner) return 'PARTNER';
  return 'UNKNOWN';
}

function proposalSourceLabel(proposal: ProposalRow, me: string, partner: string | null): Stage4ProposalSourceLabel {
  if (proposal.createdByParticipantId === me) return 'YOU';
  if (proposal.createdByParticipantId && proposal.createdByParticipantId === partner) return 'PARTNER';
  if (proposal.source === 'AI_SUGGESTED') return 'AI';
  return 'UNKNOWN';
}

/**
 * The coverage a viewer may see. The covering proposals come from
 * v_need_coverage; the WILLING side is recomputed over the choices the viewer
 * may read (their own, and a co-participant's only after choices_shared) —
 * the rule the view applies under the viewer's RLS (TS-16): a partner's
 * unshared WILLING must not flip a need to COVERED in the viewer's state.
 * Rule as the view's (R20): COVERED when every present human is WILLING on a
 * covering proposal, PARTIAL when some are, OPEN otherwise.
 */
function buildCoverageViews(
  needs: Stage4Need[],
  coverage: CoverageRow[],
  visibleChoices: ChoiceRow[],
  humans: string[],
  visibleProposalIds: Set<string>,
): CoverageView[] {
  const byNeed = new Map(coverage.map((c) => [c.needId, c]));
  return needs.map((n) => {
    const c = byNeed.get(n.id);
    // Only proposals the viewer may see (spec §1.4 proposal RLS arm; TS-11
    // post-merge, found by choices-hidden-until-shared): the view spans every
    // proposal of the session, so a partner's unshared INDIVIDUAL_COMMITMENT
    // id would otherwise reach the viewer in coveringProposalIds.
    const covering = (c?.coveringProposalIds ?? []).filter((id) => visibleProposalIds.has(id));
    const willing = new Set(
      visibleChoices
        .filter((choice) => choice.decision === 'WILLING' && covering.includes(choice.proposalId) && humans.includes(choice.participantId))
        .map((choice) => choice.participantId),
    );
    const status: CoverageView['coverageStatus'] =
      willing.size === 0 ? 'OPEN' : willing.size >= humans.length ? 'COVERED' : 'PARTIAL';
    return {
      id: n.id,
      label: n.label,
      ownerParticipantId: n.ownerParticipantId,
      coverageStatus: status,
      coveringProposalIds: covering,
      note: null,
    };
  });
}

function walkthroughStored(dispositions: DispositionRow[], needs: Stage4Need[], me: string): WalkthroughStored {
  const current = dispositions.find((d) => d.isCurrent);
  const currentOwner = current ? needs.find((n) => n.id === current.needId)?.ownerParticipantId : undefined;
  return {
    phase: current && currentOwner ? (currentOwner === me ? 'MY_NEEDS' : 'PARTNER_NEEDS') : undefined,
    currentNeedId: current?.needId,
    coveredNeedIds: dispositions.filter((d) => d.status === 'COVERED').map((d) => d.needId),
    skippedNeedIds: dispositions.filter((d) => d.status === 'SKIPPED').map((d) => d.needId),
  };
}

function buildCoverageAudit(
  rows: CoverageView[],
  me: string,
  partner: string | null,
  declined: Set<string>,
  updatedAt: Date | null,
): Stage4CoverageAuditDTO {
  const dto = rows.map((row): CoverageRowDTO & { status: string } => ({
    id: row.id,
    label: row.label,
    source: sourceLabel(row.ownerParticipantId, me, partner),
    coveringProposalIds: row.coveringProposalIds,
    note: row.note,
    userDeclinedToAddress: declined.has(row.id),
    status: row.coverageStatus,
  }));
  const byStatus = (status: string): CoverageRowDTO[] =>
    dto.filter((r) => r.status === status).map(({ status: _s, ...r }) => r);
  return { covered: byStatus('COVERED'), partial: byStatus('PARTIAL'), open: byStatus('OPEN'), updatedAt: iso(updatedAt) };
}

function buildUnaddressedNeeds(rows: CoverageView[], me: string, partner: string | null): UnaddressedNeedDTO[] {
  return rows
    .filter((row) => row.coverageStatus === 'OPEN')
    .map((row) => ({
      id: row.id,
      label: row.label,
      source: sourceLabel(row.ownerParticipantId, me, partner),
      note: row.note ?? 'Still open',
    }));
}

function buildProposalCard(
  proposal: ProposalRow,
  me: string,
  partner: string | null,
  choices: ChoiceRow[],
  rows: CoverageView[],
  revealPartner: boolean,
): ProposalCardDTO {
  const mine = choices.find((c) => c.proposalId === proposal.id && c.participantId === me);
  const theirs = partner ? choices.find((c) => c.proposalId === proposal.id && c.participantId === partner) : undefined;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const linked = proposal.needIds
    .map((id) => byId.get(id))
    .filter((r): r is CoverageView => Boolean(r))
    .map((r) => ({
      id: r.id,
      label: r.label,
      coverage: (r.coverageStatus === 'PARTIAL' ? 'PARTIAL' : 'COVERED') as 'COVERED' | 'PARTIAL',
    }));
  return {
    id: proposal.id,
    kind: proposal.kind as Stage4ProposalKind,
    description: proposal.description,
    sourceLabel: proposalSourceLabel(proposal, me, partner),
    ownerLabel:
      proposal.kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT
        ? proposal.createdByParticipantId === me
          ? 'You'
          : 'Partner'
        : undefined,
    needsAddressed:
      linked.length > 0
        ? linked
        : proposal.unresolvedNeedLabels.map((label) => ({ label, coverage: 'COVERED' as const })),
    duration: proposal.duration,
    measureOfSuccess: proposal.measureOfSuccess,
    status: proposal.status as Stage4ProposalStatus,
    myDecision: mine?.decision as Stage4SelectionDecision | undefined,
    partnerDecisionVisible: revealPartner ? (theirs?.decision as Stage4SelectionDecision | undefined) : undefined,
  };
}

function proposalMatchesNeed(proposal: ProposalCardDTO, needId: string, needLabel: string): boolean {
  const normalizedLabel = needLabel.toLowerCase();
  return proposal.needsAddressed.some((need) => {
    if (need.id && need.id === needId) return true;
    return need.label.toLowerCase() === normalizedLabel;
  });
}

function needStatus(args: {
  needId: string;
  currentNeedId?: string | null;
  coveringProposalIds: string[];
  coveredIds: Set<string>;
  skippedIds: Set<string>;
}): Stage4NeedWalkthroughStatus {
  if (args.coveredIds.has(args.needId)) return 'covered';
  if (args.skippedIds.has(args.needId)) return 'skipped';
  if (args.currentNeedId === args.needId) return 'in_progress';
  if (args.coveringProposalIds.length === 0) return 'needs_options';
  return 'not_started';
}

function defaultCheckInDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 10);
  return date.toISOString().slice(0, 10);
}

function buildQualityWarnings(proposals: ProposalCardDTO[]): Stage4QualityWarningDTO[] {
  const warnings: Stage4QualityWarningDTO[] = [];
  for (const proposal of proposals.filter((item) => item.myDecision === Stage4SelectionDecision.WILLING)) {
    const vague =
      !proposal.duration ||
      !proposal.measureOfSuccess ||
      /\b(communicate better|be better|try harder|more supportive|more present)\b/i.test(proposal.description);
    if (!vague) continue;
    warnings.push({
      proposalId: proposal.id,
      description: proposal.description,
      warning: 'This may be hard to check later. You can still continue for now.',
      suggestedRevision: 'Make it concrete: who does what, when, and how you will know it happened.',
    });
  }
  return warnings;
}

/** The walkthrough's needs in the order the walkthrough visits them, with the current one. */
export function walkthroughOrder(
  rows: CoverageView[],
  me: string,
  stored: WalkthroughStored,
): { own: CoverageView[]; partner: CoverageView[]; phase: Stage4WalkthroughPhase; currentNeedId: string | null } {
  const covered = new Set(stored.coveredNeedIds);
  const skipped = new Set(stored.skippedNeedIds);
  const own = rows.filter((r) => r.ownerParticipantId === me);
  const partner = rows.filter((r) => r.ownerParticipantId !== me);
  const ownRemaining = own.find((n) => !covered.has(n.id) && !skipped.has(n.id));
  const partnerRemaining = partner.find((n) => !covered.has(n.id) && !skipped.has(n.id));
  const phase = stored.phase ?? (ownRemaining ? 'MY_NEEDS' : partnerRemaining ? 'PARTNER_NEEDS' : 'QUALITY_REVIEW');
  const phaseNeeds = phase === 'PARTNER_NEEDS' ? partner : own;
  const currentNeedId =
    stored.currentNeedId && phaseNeeds.some((n) => n.id === stored.currentNeedId)
      ? stored.currentNeedId
      : phase === 'MY_NEEDS'
        ? (ownRemaining?.id ?? null)
        : phase === 'PARTNER_NEEDS'
          ? (partnerRemaining?.id ?? null)
          : null;
  return { own, partner, phase, currentNeedId };
}

function buildWalkthrough(args: {
  rows: CoverageView[];
  cards: ProposalCardDTO[];
  me: string;
  partner: string | null;
  stored: WalkthroughStored;
}): Stage4WalkthroughDTO {
  const coveredIds = new Set(args.stored.coveredNeedIds);
  const skippedIds = new Set(args.stored.skippedNeedIds);
  const { own, partner, phase, currentNeedId } = walkthroughOrder(args.rows, args.me, args.stored);
  const phaseNeeds = phase === 'PARTNER_NEEDS' ? partner : own;
  const toDTO = (n: CoverageView) => ({
    id: n.id,
    label: n.label,
    source: sourceLabel(n.ownerParticipantId, args.me, args.partner) as 'YOU' | 'PARTNER' | 'UNKNOWN',
    status: needStatus({
      needId: n.id,
      currentNeedId,
      coveringProposalIds: n.coveringProposalIds,
      coveredIds,
      skippedIds,
    }),
  });
  const ownNeeds = own.map(toDTO);
  const partnerNeeds = partner.map(toDTO);
  const currentNeed =
    phase === 'MY_NEEDS'
      ? (ownNeeds.find((n) => n.id === currentNeedId) ?? null)
      : phase === 'PARTNER_NEEDS'
        ? (partnerNeeds.find((n) => n.id === currentNeedId) ?? null)
        : null;
  const currentIndex = currentNeed ? Math.max(0, phaseNeeds.findIndex((n) => n.id === currentNeed.id)) : 0;
  const forCurrent = currentNeed
    ? args.cards.filter((p) => proposalMatchesNeed(p, currentNeed.id, currentNeed.label))
    : [];
  const group = (
    key: Stage4WalkthroughDTO['proposalGroups'][number]['key'],
    title: string,
    proposals: ProposalCardDTO[],
    readOnly = false,
  ) => ({ key, title, proposals, readOnly });
  const proposalGroups =
    phase === 'PARTNER_NEEDS'
      ? [
          group(
            'partner_may_do',
            'Things your partner may do themselves',
            forCurrent.filter((p) => p.kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT && p.sourceLabel === 'PARTNER'),
            true,
          ),
          group('shared_options', 'Things you could do together', forCurrent.filter((p) => p.kind === Stage4ProposalKind.SHARED_PROPOSAL)),
          group('your_prior_suggestions', 'Things you already suggested', forCurrent.filter((p) => p.sourceLabel === 'YOU')),
        ]
      : [
          group('you_suggested', 'Options you suggested', forCurrent.filter((p) => p.sourceLabel === 'YOU')),
          group('partner_suggested', 'Options your partner suggested', forCurrent.filter((p) => p.sourceLabel === 'PARTNER')),
          group('ai_suggested', 'MWF ideas', forCurrent.filter((p) => p.sourceLabel === 'AI')),
        ];
  return {
    phase,
    currentNeed,
    currentIndex,
    totalInPhase: phaseNeeds.length,
    ownNeeds,
    partnerNeeds,
    proposalGroups,
    qualityWarnings: buildQualityWarnings(args.cards),
    defaultCheckInDate: defaultCheckInDate(),
  };
}

export function toAgreementDTO(agreement: AgreementRow, me: string, partner: string | null): AgreementDTO {
  const myParty = agreement.parties.find((p) => p.participantId === me);
  return {
    id: agreement.id,
    strategyId: agreement.proposalId,
    description: agreement.description,
    type: agreement.type as AgreementDTO['type'],
    duration: agreement.duration,
    measureOfSuccess: agreement.measureOfSuccess,
    status: agreement.status as AgreementDTO['status'],
    agreedByMe: Boolean(myParty),
    agreedByPartner: partner ? agreement.parties.some((p) => p.participantId === partner) : false,
    agreedAt: iso(myParty?.agreedAt ?? agreement.parties[0]?.agreedAt ?? null),
    followUpDate: iso(agreement.followUpAt),
  };
}

function derivePhase(args: {
  closure: ClosureRow | null;
  hasLiveProposals: boolean;
  hasCoverage: boolean;
  mySelections: ChoiceRow[];
  partnerSelections: ChoiceRow[];
  mySubmitted: boolean;
  partnerSubmitted: boolean;
}): Stage4Phase {
  if (args.closure?.kind === Stage4ClosureKind.SHARED_AGREEMENT) return Stage4Phase.CLOSED_SHARED_AGREEMENT;
  if (args.closure?.kind === Stage4ClosureKind.NO_SHARED_AGREEMENT) return Stage4Phase.CLOSED_NO_SHARED_AGREEMENT;
  if (args.mySubmitted && args.partnerSubmitted) return Stage4Phase.OUTCOME_REVIEW;
  if (args.mySubmitted || args.partnerSubmitted || args.mySelections.length > 0 || args.partnerSelections.length > 0) {
    return Stage4Phase.SELECTION;
  }
  // Coverage is computed from proposals: it is "under review" once there is a proposal to cover anything.
  if (args.hasCoverage && args.hasLiveProposals) return Stage4Phase.COVERAGE_REVIEW;
  return Stage4Phase.INVENTORY_BUILDING;
}

function buildTendingPreview(closure: ClosureRow | null, entries: FollowUpRow[]): TendingPreviewDTO | null {
  if (!closure && entries.length === 0) return null;
  const next = entries[0] ?? null;
  return {
    nextEntry: next
      ? {
          id: next.id,
          type: toTendingEntryType(next.type),
          status: next.status as NonNullable<TendingPreviewDTO['nextEntry']>['status'],
          agreementId: next.agreementId,
          scheduledFor: iso(next.scheduledFor),
          openedAt: iso(next.openedAt),
          completedAt: iso(next.completedAt),
          summary: next.summary,
        }
      : null,
    scheduledCount: entries.filter((e) => e.status === 'SCHEDULED').length,
    openCount: entries.filter((e) => e.status === 'OPEN').length,
    passiveReentryAvailable: Boolean(closure),
  };
}

const latest = (dates: Array<Date | null | undefined>): Date | null =>
  dates.reduce<Date | null>((acc, d) => (d && (!acc || d > acc) ? d : acc), null);

/** Everything the state needs, for one viewer. */
export async function loadStage4View(sessionId: string, userId: string) {
  const me = await resolveParticipant(sessionId, userId);
  if (!me) throw new Stage4StateNotFoundError();
  const partner = (await getPartnerParticipant(me.id))?.participantId ?? null;
  const [proposals, choices, needs, coverage, dispositions, closure, items, agreements, followUps, mySubmitted, partnerSubmitted, humans] =
    await Promise.all([
      loadProposals(sessionId, me.id),
      loadVisibleChoices(sessionId, me.id),
      loadStage4Needs(sessionId, me.id),
      loadCoverage(sessionId),
      loadDispositions(me.id),
      loadClosure(sessionId),
      loadClosureItems(sessionId),
      loadAgreements(sessionId),
      loadFollowUpsForParticipant(sessionId, me.id),
      hasMilestone(me.id, 'choices_shared'),
      partner ? hasMilestone(partner, 'choices_shared') : Promise.resolve(false),
      presentHumans(sessionId).then((list) => list.map((h) => h.id)),
    ]);
  return {
    me: me.id,
    partner,
    proposals,
    choices,
    needs,
    rows: buildCoverageViews(needs, coverage, choices, humans, new Set(proposals.map((p) => p.id))),
    dispositions,
    closure,
    items,
    agreements,
    followUps,
    mySubmitted,
    partnerSubmitted,
  };
}

export type Stage4View = Awaited<ReturnType<typeof loadStage4View>>;

export function walkthroughStoredFor(view: Stage4View): WalkthroughStored {
  return walkthroughStored(view.dispositions, view.needs, view.me);
}

export async function getStage4State(sessionId: string, userId: string): Promise<GetStage4StateResponse> {
  return buildStage4StateFromView(await loadStage4View(sessionId, userId));
}

export function buildStage4StateFromView(view: Stage4View): GetStage4StateResponse {
  const { me, partner, proposals, choices, rows, closure, items, agreements, followUps } = view;
  const mySelections = choices.filter((c) => c.participantId === me);
  const partnerSelections = choices.filter((c) => c.participantId === partner);
  const reveal = view.mySubmitted && view.partnerSubmitted;
  const active = proposals.filter((p) => p.status === 'ACTIVE');
  const cards = active.map((p) => buildProposalCard(p, me, partner, choices, rows, reveal));
  const unaddressed = buildUnaddressedNeeds(rows, me, partner);
  const agreementDTOs = agreements.map((a) => toAgreementDTO(a, me, partner));
  const declined = new Set(view.dispositions.filter((d) => d.status === 'DECLINED').map((d) => d.needId));
  const closureItems: ClosureItems = items;
  const individualIds = new Set(closureItems.individualCommitmentIds);
  const openIds = new Set(closureItems.openNeedIds);
  const coverageUpdatedAt = rows.length
    ? latest([...view.needs.map((n) => n.sharedAt), ...proposals.map((p) => p.updatedAt), ...choices.map((c) => c.updatedAt)])
    : null;
  const selectionDTO = (c: ChoiceRow): Stage4SelectionDTO => ({
    proposalId: c.proposalId,
    decision: c.decision as Stage4SelectionDecision,
    note: c.note,
    selectedAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  });

  return {
    phase: derivePhase({
      closure,
      hasLiveProposals: proposals.some((p) => p.status !== 'REMOVED'),
      hasCoverage: rows.length > 0,
      mySelections,
      partnerSelections,
      mySubmitted: view.mySubmitted,
      partnerSubmitted: view.partnerSubmitted,
    }),
    walkthrough: buildWalkthrough({ rows, cards, me, partner, stored: walkthroughStored(view.dispositions, view.needs, me) }),
    inventory: {
      sharedProposals: cards.filter((p) => p.kind === Stage4ProposalKind.SHARED_PROPOSAL),
      individualCommitments: cards.filter((p) => p.kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT),
      unaddressedNeeds: unaddressed,
      removedProposalCount: proposals.filter((p) => p.status === 'REMOVED').length,
      updatedAt: iso(latest(proposals.map((p) => p.updatedAt))) ?? new Date(0).toISOString(),
    },
    coverageAudit: buildCoverageAudit(rows, me, partner, declined, coverageUpdatedAt),
    mySelections: mySelections.map(selectionDTO),
    partnerSelections: reveal ? partnerSelections.map(selectionDTO) : [],
    mySelectionStatus: view.mySubmitted ? 'SUBMITTED' : 'NOT_STARTED',
    partnerSelectionStatus: view.partnerSubmitted ? 'SUBMITTED' : 'NOT_STARTED',
    outcome: closure
      ? {
          kind: closure.kind as Stage4ClosureKind,
          reason: closure.reason as NonNullable<GetStage4StateResponse['outcome']>['reason'],
          summary: closure.summary,
          agreements: agreementDTOs.filter((a) => closureItems.agreementIds.includes(a.id)),
          individualCommitments: proposals
            .filter((p) => individualIds.has(p.id))
            .map((p) => buildProposalCard(p, me, partner, choices, rows, reveal)),
          openNeeds: rows
            .filter((r) => openIds.has(r.id))
            .map((r) => ({ id: r.id, label: r.label, source: sourceLabel(r.ownerParticipantId, me, partner), note: r.note ?? 'Still open' })),
          closedAt: closure.closedAt.toISOString(),
          checkInAt: closure.checkInAt ? closure.checkInAt.toISOString() : null,
        }
      : null,
    tendingPreview: buildTendingPreview(closure, followUps),
  };
}
