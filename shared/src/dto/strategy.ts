/**
 * Strategy & Agreement DTOs (Stage 4)
 *
 * Data Transfer Objects for collaborative strategy generation and agreements.
 */

import {
  AgreementStatus,
  AgreementType,
  MessageRole,
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
  Stage4SubChatAnchor,
  Stage4SubChatStatus,
  TendingBlockerCategory,
  TendingEntryScope,
  TendingEntryStatus,
  TendingEntryType,
  TendingFollowThroughStatus,
  TendingHelpfulnessStatus,
  TendingNeedResolutionStatus,
  TendingNextAction,
  TendingReminderScope,
  TendingCoordinationStatus,
} from '../enums';

/** Maximum number of agreements allowed per session */
export const MAX_AGREEMENTS = 2;

// ============================================================================
// Strategy Phase
// ============================================================================

export enum StrategyPhase {
  COLLECTING = 'COLLECTING', // Users still adding
  RANKING = 'RANKING', // Both ready to rank
  REVEALING = 'REVEALING', // Revealing overlap
  NEGOTIATING = 'NEGOTIATING', // Working toward agreement
  AGREED = 'AGREED', // Agreement reached
}

// ============================================================================
// Strategies
// ============================================================================

export interface StrategyDTO {
  id: string;
  description: string;
  needsAddressed: string[];
  duration: string | null;
  measureOfSuccess: string | null;
  // Note: NO source attribution - strategies are unlabeled
}

export interface GetStrategiesResponse {
  strategies: StrategyDTO[];
  aiSuggestionsAvailable: boolean;
  phase: StrategyPhase;
  myReadyToRank?: boolean;
  partnerReadyToRank?: boolean;
  canMarkReadyToRank?: boolean;
  canRank?: boolean;
  rankableStrategyCount?: number;
}

export interface ProposeStrategyRequest {
  description: string;
  needsAddressed?: string[];
  duration?: string;
  measureOfSuccess?: string;
}

export interface ProposeStrategyResponse {
  strategy: {
    id: string;
    description: string;
    duration: string | null;
    measureOfSuccess: string | null;
  };
  createdAt: string;
}

// ============================================================================
// AI Suggestions
// ============================================================================

export interface RequestSuggestionsRequest {
  count?: number; // Default: 3
  focusNeeds?: string[];
}

export interface RequestSuggestionsResponse {
  suggestions: StrategyDTO[];
  source: 'AI_GENERATED';
}

// ============================================================================
// Ranking
// ============================================================================

export interface MarkReadyResponse {
  ready: boolean;
  readyAt?: string;
  partnerReady: boolean;
  canStartRanking: boolean;
}

export interface StrategyRanking {
  strategyId: string;
  rank: number; // 1 = top choice
}

export interface SubmitRankingRequest {
  rankedIds: string[];
}

export interface SubmitRankingResponse {
  submitted: boolean;
  submittedAt: string;
  partnerSubmitted: boolean;
  awaitingReveal: boolean;
}

export type RevealOverlapResponse = {
  overlap: StrategyDTO[];
  phase: StrategyPhase;
};

// ============================================================================
// Agreements
// ============================================================================

export interface AgreementDTO {
  /**
   * The agreement's id — or, in the legacy create/confirm flow before every
   * party has confirmed (no agreement row exists yet on the target; TS-11),
   * the proposal's id, which is also `proposalId`.
   */
  id: string;
  strategyId?: string | null;
  /** The proposal the agreement is (or will be) made from (TS-11, additive). */
  proposalId?: string | null;
  description: string;
  type?: AgreementType;
  duration: string | null;
  measureOfSuccess: string | null;
  status: AgreementStatus;
  agreedByMe: boolean;
  agreedByPartner: boolean;
  agreedAt: string | null;
  followUpDate: string | null;
}

export interface CreateAgreementRequest {
  strategyId?: string;
  description: string;
  type: AgreementType;
  duration?: string;
  measureOfSuccess?: string;
  followUpDate?: string;
}

export interface CreateAgreementResponse {
  agreement: AgreementDTO;
  awaitingPartnerConfirmation: boolean;
}

export interface ConfirmAgreementRequest {
  confirmed: boolean;
  modification?: string;
}

export interface ConfirmAgreementResponse {
  agreement: AgreementDTO;
  sessionCanResolve: boolean;
}

// ============================================================================
// Session Resolution
// ============================================================================

export interface ResolveSessionResponse {
  resolved: boolean;
  resolvedAt: string;
  agreements: AgreementDTO[];
  followUpScheduled: boolean;
}

// ============================================================================
// Redesigned Stage 4
// ============================================================================

export enum Stage4Phase {
  INVENTORY_BUILDING = 'INVENTORY_BUILDING',
  COVERAGE_REVIEW = 'COVERAGE_REVIEW',
  SELECTION = 'SELECTION',
  OUTCOME_REVIEW = 'OUTCOME_REVIEW',
  CLOSING = 'CLOSING',
  CLOSED_SHARED_AGREEMENT = 'CLOSED_SHARED_AGREEMENT',
  CLOSED_NO_SHARED_AGREEMENT = 'CLOSED_NO_SHARED_AGREEMENT',
}

export type Stage4CoverageStatus = 'COVERED' | 'PARTIAL' | 'OPEN';
export type Stage4ProposalSourceLabel = 'YOU' | 'PARTNER' | 'AI' | 'UNKNOWN';
export type Stage4WalkthroughPhase = 'MY_NEEDS' | 'PARTNER_NEEDS' | 'QUALITY_REVIEW' | 'SUMMARY';
export type Stage4NeedWalkthroughStatus =
  | 'not_started'
  | 'in_progress'
  | 'covered'
  | 'skipped'
  | 'needs_options';

export interface ProposalNeedCoverageDTO {
  id?: string;
  label: string;
  coverage: Exclude<Stage4CoverageStatus, 'OPEN'>;
}

export interface ProposalCardDTO {
  id: string;
  kind: Stage4ProposalKind;
  description: string;
  sourceLabel?: Stage4ProposalSourceLabel;
  ownerLabel?: 'You' | 'Partner';
  needsAddressed: ProposalNeedCoverageDTO[];
  duration: string | null;
  measureOfSuccess: string | null;
  status: Stage4ProposalStatus;
  myDecision?: Stage4SelectionDecision;
  partnerDecisionVisible?: Stage4SelectionDecision;
}

export interface Stage4WalkthroughNeedDTO {
  id: string;
  label: string;
  source: 'YOU' | 'PARTNER' | 'UNKNOWN';
  status: Stage4NeedWalkthroughStatus;
}

export interface Stage4WalkthroughProposalGroupDTO {
  key:
    | 'you_suggested'
    | 'partner_suggested'
    | 'ai_suggested'
    | 'partner_may_do'
    | 'shared_options'
    | 'your_prior_suggestions';
  title: string;
  readOnly?: boolean;
  proposals: ProposalCardDTO[];
}

export interface Stage4QualityWarningDTO {
  proposalId: string;
  description: string;
  warning: string;
  suggestedRevision?: string;
}

export interface Stage4WalkthroughDTO {
  phase: Stage4WalkthroughPhase;
  currentNeed: Stage4WalkthroughNeedDTO | null;
  currentIndex: number;
  totalInPhase: number;
  ownNeeds: Stage4WalkthroughNeedDTO[];
  partnerNeeds: Stage4WalkthroughNeedDTO[];
  proposalGroups: Stage4WalkthroughProposalGroupDTO[];
  qualityWarnings: Stage4QualityWarningDTO[];
  defaultCheckInDate: string;
}

export interface UnaddressedNeedDTO {
  id?: string;
  label: string;
  source: 'YOU' | 'PARTNER' | 'BOTH' | 'UNKNOWN';
  note: string;
}

export interface ProposalInventoryDTO {
  sharedProposals: ProposalCardDTO[];
  individualCommitments: ProposalCardDTO[];
  unaddressedNeeds: UnaddressedNeedDTO[];
  removedProposalCount: number;
  updatedAt: string;
}

export interface CoverageRowDTO {
  id?: string;
  label: string;
  source: 'YOU' | 'PARTNER' | 'BOTH' | 'UNKNOWN';
  coveringProposalIds: string[];
  note: string | null;
  userDeclinedToAddress?: boolean;
}

export interface Stage4CoverageAuditDTO {
  covered: CoverageRowDTO[];
  partial: CoverageRowDTO[];
  open: CoverageRowDTO[];
  updatedAt: string | null;
}

export interface Stage4SelectionDTO {
  proposalId: string;
  decision: Stage4SelectionDecision;
  note: string | null;
  selectedAt: string;
  updatedAt: string;
}

export interface Stage4OutcomeDTO {
  kind: Stage4ClosureKind;
  reason: Stage4ClosureReason;
  summary: string;
  agreements: AgreementDTO[];
  individualCommitments: ProposalCardDTO[];
  openNeeds: UnaddressedNeedDTO[];
  closedAt: string;
  checkInAt: string | null;
}

export interface TendingPreviewDTO {
  nextEntry: {
    id: string;
    type: TendingEntryType;
    status: TendingEntryStatus;
    agreementId: string | null;
    scheduledFor: string | null;
    openedAt: string | null;
    completedAt: string | null;
    summary: string | null;
  } | null;
  scheduledCount: number;
  openCount: number;
  passiveReentryAvailable: boolean;
}

export interface TendingEntryDTO {
  id: string;
  sessionId: string;
  agreementId: string | null;
  type: TendingEntryType;
  scope: TendingEntryScope;
  ownerUserId: string | null;
  optedInShared: boolean;
  status: TendingEntryStatus;
  scheduledFor: string | null;
  openedAt: string | null;
  completedAt: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  myResponse: TendingResponseDTO | null;
  responseCount: number;
  latestOutcome?: TendingEntryOutcomeDTO | null;
  reminders?: TendingReminderDTO[];
}

export interface TendingResponseDTO {
  id: string;
  tendingEntryId: string;
  userId: string;
  checkinId?: string | null;
  status: TendingResponseStatus;
  reflection: string | null;
  continueChoice: ContinueChoice | null;
  submittedAt: string;
}

export type TendingResponseStatus = 'CHECKIN' | 'WORKED' | 'PARTLY' | 'DID_NOT_WORK' | 'DID_NOT_TRY' | 'OTHER';

export interface TendingCheckinDTO {
  id: string;
  sessionId: string;
  userId: string;
  coordinationCycleId?: string | null;
  nextAction: TendingNextAction | null;
  continueChoice: ContinueChoice | null;
  reflectionSummary: string | null;
  submittedAt: string;
  createdAt: string;
  entryOutcomes?: TendingEntryOutcomeDTO[];
  needOutcomes?: TendingNeedOutcomeDTO[];
  reminders?: TendingReminderDTO[];
  adjustments?: TendingAdjustmentDTO[];
}

export interface TendingCoordinationCycleDTO {
  id: string;
  sessionId: string;
  status: TendingCoordinationStatus;
  entryIds: string[];
  participantUserIds: string[];
  submittedUserIds: string[];
  responseDeadlineAt: string;
  resolvedAt: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TendingEntryOutcomeDTO {
  id: string;
  checkinId: string;
  tendingEntryId: string;
  responseId: string | null;
  userId: string;
  followThroughStatus: TendingFollowThroughStatus;
  helpfulnessStatus: TendingHelpfulnessStatus | null;
  blockerCategories: TendingBlockerCategory[];
  whatHappened: string | null;
  helpedNeed: string | null;
  blockerNote: string | null;
  stillWorthTrying: boolean | null;
  createdAt: string;
}

export interface TendingNeedOutcomeDTO {
  id: string;
  checkinId: string;
  sessionId: string;
  needId: string | null;
  needLabel: string;
  sourceUserId: string | null;
  resolutionStatus: TendingNeedResolutionStatus;
  note: string | null;
  changedNeedLabel: string | null;
  nextAction: TendingNextAction | null;
  createdAt: string;
}

export interface TendingReminderDTO {
  id: string;
  sessionId: string;
  checkinId: string | null;
  tendingEntryId: string | null;
  userId: string;
  scope: TendingReminderScope;
  remindAt: string;
  cadence: string | null;
  note: string | null;
  status: TendingReminderStatus;
  createdAt: string;
  updatedAt: string;
}

export type TendingReminderStatus = 'SCHEDULED' | 'DELIVERED' | 'CANCELLED';

export interface TendingAdjustmentDTO {
  id: string;
  sessionId: string;
  checkinId: string;
  tendingEntryId: string;
  userId: string;
  privacyScope: TendingReminderScope;
  revisedCommitmentText: string | null;
  revisedCadence: string | null;
  revisedScope: string | null;
  revisedSuccessCriteria: string | null;
  reason: string | null;
  blockerAddressed: TendingBlockerCategory[];
  createdAt: string;
}

export interface TendingBetweenPeriodNoteDTO {
  id: string;
  sessionId: string;
  userId: string;
  content: string;
  carryForwardSelected: boolean;
  consentToShareWithPartner: boolean;
  shareConsentAt: string | null;
  selectedForCheckinId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TendingHistoryEntryReviewDTO {
  tendingEntryId: string;
  summary: string | null;
  scope: TendingEntryScope;
  followThroughStatus: TendingFollowThroughStatus;
  helpfulnessStatus: TendingHelpfulnessStatus | null;
  blockerCategories: TendingBlockerCategory[];
  whatHappened: string | null;
  helpedNeed: string | null;
  stillWorthTrying: boolean | null;
}

export interface TendingHistoryCycleDTO {
  checkinId: string;
  sessionId: string;
  userId: string;
  submittedAt: string;
  continueChoice: ContinueChoice | null;
  nextAction: TendingNextAction | null;
  reflectionSummary: string | null;
  entryReviews: TendingHistoryEntryReviewDTO[];
  needOutcomes: TendingNeedOutcomeDTO[];
  adjustments: TendingAdjustmentDTO[];
  reminders: TendingReminderDTO[];
  coordinationStatus?: TendingCoordinationStatus | null;
  coordinationSummary?: string | null;
}

export interface GetTendingEntriesResponse {
  entries: TendingEntryDTO[];
  coordinationCycles?: TendingCoordinationCycleDTO[];
  betweenPeriodNotes?: TendingBetweenPeriodNoteDTO[];
}

export interface GetTendingHistoryResponse {
  cycles: TendingHistoryCycleDTO[];
}

export interface SubmitTendingResponseRequest {
  status: TendingResponseStatus;
  reflection?: string;
  continueChoice?: ContinueChoice;
}

export interface SubmitTendingResponseResponse {
  entry: TendingEntryDTO;
}

// Stage 4 Phase 5: the five forward paths surfaced at a Tending check-in.
export enum ContinueChoice {
  ANOTHER_ROUND = 'ANOTHER_ROUND',
  EXTEND = 'EXTEND',
  NEW_PROCESS = 'NEW_PROCESS',
  PARTIAL_CLOSURE = 'PARTIAL_CLOSURE',
  FULL_CLOSURE = 'FULL_CLOSURE',
}

export enum PartialClosureResolution {
  RESOLVED = 'RESOLVED',
  CONTINUING = 'CONTINUING',
}

export interface TendingCheckinOrientationReflection {
  reflection: string;
  perEntryNotes?: Record<string, string>;
}

export interface TendingCheckinEntryOutcomeInput {
  tendingEntryId: string;
  followThroughStatus: TendingFollowThroughStatus;
  helpfulnessStatus?: TendingHelpfulnessStatus;
  blockerCategories?: TendingBlockerCategory[];
  whatHappened?: string;
  helpedNeed?: string;
  blockerNote?: string;
  stillWorthTrying?: boolean;
  note?: string;
}

export interface TendingCheckinNeedOutcomeInput {
  needId?: string;
  needLabel: string;
  sourceUserId?: string;
  resolutionStatus: TendingNeedResolutionStatus;
  note?: string;
  changedNeedLabel?: string;
  nextAction?: TendingNextAction;
}

export interface TendingReminderInput {
  tendingEntryId?: string;
  scope: TendingReminderScope;
  remindAt: string;
  cadence?: string;
  note?: string;
}

export interface TendingAdjustmentInput {
  tendingEntryId: string;
  privacyScope?: TendingReminderScope;
  revisedCommitmentText?: string;
  revisedCadence?: string;
  revisedScope?: string;
  revisedSuccessCriteria?: string;
  reason?: string;
  blockerAddressed?: TendingBlockerCategory[];
}

export interface TendingCheckinWhatComesNext {
  continueChoice: ContinueChoice;
  nextAction?: TendingNextAction;
  partialClosure?: Record<string, PartialClosureResolution>;
  reminders?: TendingReminderInput[];
}

export interface TendingCheckinOrientations {
  whatWorked: TendingCheckinOrientationReflection;
  whereMoreSupport: TendingCheckinOrientationReflection;
  whatComesNext: TendingCheckinWhatComesNext;
}

export interface SubmitTendingCheckinRequest {
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
}

export interface SubmitTendingCheckinResponse {
  entries: TendingEntryDTO[];
  checkin?: TendingCheckinDTO;
  coordinationCycle?: TendingCoordinationCycleDTO;
  newSessionId?: string;
  continueChoice: ContinueChoice;
  nextScheduledFor?: string | null;
}

export interface CreateTendingReentryRequest {
  intent?: string;
}

export interface CreateTendingReentryResponse {
  entry: TendingEntryDTO;
}

export interface CreateTendingBetweenPeriodNoteRequest {
  content: string;
}

export interface CreateTendingBetweenPeriodNoteResponse {
  note: TendingBetweenPeriodNoteDTO;
}

export interface GetStage4StateResponse {
  phase: Stage4Phase;
  walkthrough: Stage4WalkthroughDTO;
  inventory: ProposalInventoryDTO;
  coverageAudit: Stage4CoverageAuditDTO;
  mySelections: Stage4SelectionDTO[];
  partnerSelections: Stage4SelectionDTO[];
  mySelectionStatus: 'NOT_STARTED' | 'SUBMITTED';
  partnerSelectionStatus: 'NOT_STARTED' | 'SUBMITTED';
  outcome: Stage4OutcomeDTO | null;
  tendingPreview: TendingPreviewDTO | null;
}

export interface UpdateStage4WalkthroughNeedResponse {
  state: GetStage4StateResponse;
}

export interface SubmitStage4SelectionRequest {
  decision: Stage4SelectionDecision;
  note?: string;
}

export interface SubmitStage4SelectionsRequest {
  selections: Array<{
    proposalId: string;
    decision: Stage4SelectionDecision;
    note?: string;
  }>;
}

export interface SubmitStage4SelectionsResponse {
  submitted: boolean;
  submittedAt: string;
  partnerSubmitted: boolean;
  state: GetStage4StateResponse;
}

export interface CloseStage4Request {
  kind?: Stage4ClosureKind;
  reason?: Stage4ClosureReason;
  summary?: string;
  /** ISO date string. Used as the followUpDate for any generated Agreement rows. */
  checkInDate: string;
  /** @deprecated Phase 4 removes this — checkInDate is the single source. */
  followUpDatesByProposalId?: Record<string, string>;
}

export interface CloseStage4Response {
  closed: boolean;
  closedAt: string;
  outcome: Stage4OutcomeDTO;
  state: GetStage4StateResponse;
}

// ============================================================================
// Stage 4 Sub-chat (Phase 3)
// ============================================================================

export interface Stage4SubChatMessageDTO {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  /**
   * Structured candidate proposal extracted from the AI's message (when it
   * has one to offer). The UI surfaces a "Use this version" affordance on
   * this message. The candidate's `description` is the proposal text;
   * `proposalId` (when present on a PROPOSAL_REFINEMENT sub-chat) tells the
   * client to update that proposal in place rather than create a new one.
   */
  candidate?: Stage4ProposalDraft | null;
}

export interface Stage4SubChatDTO {
  id: string;
  sessionId: string;
  userId: string;
  anchorKind: Stage4SubChatAnchor;
  anchorId: string | null;
  status: Stage4SubChatStatus;
  createdAt: string;
  resolvedAt: string | null;
  messages: Stage4SubChatMessageDTO[];
}

export interface OpenStage4SubChatRequest {
  anchorKind: Stage4SubChatAnchor;
  anchorId?: string | null;
}

export interface OpenStage4SubChatResponse {
  subChat: Stage4SubChatDTO;
}

export interface SendStage4SubChatMessageRequest {
  content: string;
}

export interface SendStage4SubChatMessageResponse {
  subChat: Stage4SubChatDTO;
}

export interface Stage4ProposalDraft {
  /** When set, refers to an existing StrategyProposal (refinement case). */
  proposalId?: string;
  description: string;
  needsAddressed?: string[];
  duration?: string | null;
  measureOfSuccess?: string | null;
}

export interface ResolveStage4SubChatRequest {
  /** Proposals to create new (NEEDS_BRAINSTORM, NO_OVERLAP). */
  acceptedProposals?: Stage4ProposalDraft[];
  /** Existing proposals to update in place (PROPOSAL_REFINEMENT, NO_OVERLAP). */
  updatedProposals?: Stage4ProposalDraft[];
}

export interface ResolveStage4SubChatResponse {
  subChat: Stage4SubChatDTO;
  createdProposalIds: string[];
  updatedProposalIds: string[];
}

export interface GetStage4SubChatResponse {
  subChat: Stage4SubChatDTO;
}
