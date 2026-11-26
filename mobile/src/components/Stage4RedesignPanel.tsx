import { useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Lock, MinusCircle, Send, RotateCcw, Share2, XCircle } from 'lucide-react-native';
import {
  GetStage4StateResponse,
  ProposalCardDTO,
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4CoverageStatus,
  Stage4Phase,
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
} from '@meet-without-fear/shared';
import { useAppAppearance } from '@/theme';

interface Stage4RedesignPanelProps {
  state: GetStage4StateResponse;
  partnerName?: string | null;
  isSelecting?: boolean;
  isClosing?: boolean;
  isSharing?: boolean;
  isRevising?: boolean;
  /** Hide the inline footer — caller renders <Stage4RedesignFooter /> separately (e.g. sticky to the drawer). */
  hideFooter?: boolean;
  onSelectProposal: (proposalId: string, decision: Stage4SelectionDecision) => void;
  onShareSelections?: () => void;
  /** Share one of the viewer's own individual commitments with the partner (work-k5fk.37). */
  onShareCommitment?: (proposalId: string) => void;
  /** The commitment whose share is in flight, if any. */
  sharingCommitmentId?: string | null;
  onReviseSelections?: () => void;
  onSuggestOptions?: (needLabel: string, needId: string) => void;
  onBrainstormNeed?: (needLabel: string, needId: string) => void;
  onRefineProposal?: (proposalId: string, description: string) => void;
  onKeepRefiningNoOverlap?: () => void;
  onDeclineNeed?: (needId: string) => void;
  onUndeclineNeed?: (needId: string) => void;
  onMarkNeedCovered?: (needId: string) => void;
  onSkipNeed?: (needId: string) => void;
  onResetNeed?: (needId: string) => void;
  onBackToChat?: () => void;
  onCloseStage4: (kind: Stage4ClosureKind, reason: Stage4ClosureReason, checkInDate: string) => void;
}

interface Stage4RedesignFooterProps {
  state: GetStage4StateResponse;
  partnerName?: string | null;
  isClosing?: boolean;
  isSharing?: boolean;
  isRevising?: boolean;
  onShareSelections?: () => void;
  onReviseSelections?: () => void;
  onKeepRefiningNoOverlap?: () => void;
  onBackToChat?: () => void;
  onCloseStage4: (kind: Stage4ClosureKind, reason: Stage4ClosureReason, checkInDate: string) => void;
}

/**
 * True iff every OPEN need is either covered by a proposal the user
 * marked WILLING or explicitly declined ("leave for now") by the user.
 */
function allOpenNeedsAddressedOrDeclined(state: GetStage4StateResponse): boolean {
  const safeState = withStage4Defaults(state);
  const willingProposalIds = new Set(
    [...safeState.inventory.sharedProposals, ...safeState.inventory.individualCommitments]
      .filter((p) => p.myDecision === Stage4SelectionDecision.WILLING)
      .map((p) => p.id),
  );
  const rows = safeState.coverageAudit.open;
  return rows.every((row) => {
    if (row.userDeclinedToAddress) return true;
    return row.coveringProposalIds.some((pid) => willingProposalIds.has(pid));
  });
}

const decisionLabels: Record<Stage4SelectionDecision, string> = {
  [Stage4SelectionDecision.WILLING]: 'Willing',
  [Stage4SelectionDecision.NOT_WILLING]: 'Not willing',
};

const coverageLabels: Record<Stage4CoverageStatus, string> = {
  COVERED: 'Covered',
  PARTIAL: 'Partly covered',
  OPEN: 'Open',
};

function outcomeReasonLabel(reason: Stage4ClosureReason): string {
  switch (reason) {
    case Stage4ClosureReason.MUTUAL_SELECTION:
      return 'Mutual selection';
    case Stage4ClosureReason.NO_OVERLAP:
      return 'No mutual overlap';
    case Stage4ClosureReason.BOUNDARY_HONORED:
      return 'Boundary honored';
    case Stage4ClosureReason.USER_STOPPED:
      return 'Stopped here';
    default:
      return reason;
  }
}

function proposalKindLabel(kind: Stage4ProposalKind): string {
  return kind === Stage4ProposalKind.INDIVIDUAL_COMMITMENT
    ? 'Individual commitment'
    : 'Shared proposal';
}

function defaultCheckInDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 10);
  return date.toISOString().slice(0, 10);
}

function withStage4Defaults(state: GetStage4StateResponse): GetStage4StateResponse {
  const partial = state as Partial<GetStage4StateResponse>;
  const inventory = partial.inventory ?? {
    sharedProposals: [],
    individualCommitments: [],
    unaddressedNeeds: [],
    removedProposalCount: 0,
    updatedAt: new Date().toISOString(),
  };
  const coverageAudit = partial.coverageAudit ?? {
    covered: [],
    partial: [],
    open: [],
    updatedAt: null,
  };
  const walkthrough = partial.walkthrough ?? {
    phase: 'SUMMARY' as const,
    currentNeed: null,
    currentIndex: 0,
    totalInPhase: 0,
    ownNeeds: [],
    partnerNeeds: [],
    proposalGroups: [],
    qualityWarnings: [],
    defaultCheckInDate: defaultCheckInDate(),
  };

  return {
    ...state,
    phase: partial.phase ?? Stage4Phase.INVENTORY_BUILDING,
    inventory: {
      ...inventory,
      sharedProposals: inventory.sharedProposals ?? [],
      individualCommitments: inventory.individualCommitments ?? [],
      unaddressedNeeds: inventory.unaddressedNeeds ?? [],
      removedProposalCount: inventory.removedProposalCount ?? 0,
      updatedAt: inventory.updatedAt ?? new Date().toISOString(),
    },
    coverageAudit: {
      ...coverageAudit,
      covered: coverageAudit.covered ?? [],
      partial: coverageAudit.partial ?? [],
      open: coverageAudit.open ?? [],
      updatedAt: coverageAudit.updatedAt ?? null,
    },
    mySelections: partial.mySelections ?? [],
    partnerSelections: partial.partnerSelections ?? [],
    mySelectionStatus: partial.mySelectionStatus ?? 'NOT_STARTED',
    partnerSelectionStatus: partial.partnerSelectionStatus ?? 'NOT_STARTED',
    outcome: partial.outcome ?? null,
    tendingPreview: partial.tendingPreview ?? null,
    walkthrough: {
      ...walkthrough,
      currentNeed: walkthrough.currentNeed ?? null,
      currentIndex: walkthrough.currentIndex ?? 0,
      totalInPhase: walkthrough.totalInPhase ?? 0,
      ownNeeds: walkthrough.ownNeeds ?? [],
      partnerNeeds: walkthrough.partnerNeeds ?? [],
      proposalGroups: walkthrough.proposalGroups ?? [],
      qualityWarnings: walkthrough.qualityWarnings ?? [],
      defaultCheckInDate: walkthrough.defaultCheckInDate ?? defaultCheckInDate(),
    },
  };
}

const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function CloseControls({
  canCloseShared,
  showNoSharedClose,
  canCloseNoShared,
  isClosing,
  partnerName,
  onCloseStage4,
  onKeepRefiningNoOverlap,
}: {
  canCloseShared: boolean;
  showNoSharedClose: boolean;
  canCloseNoShared: boolean;
  isClosing: boolean;
  partnerName: string;
  onCloseStage4: (
    kind: Stage4ClosureKind,
    reason: Stage4ClosureReason,
    checkInDate: string,
  ) => void;
  onKeepRefiningNoOverlap?: () => void;
}) {
  const { palette } = useAppAppearance();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [pending, setPending] = useState<
    | { kind: Stage4ClosureKind; reason: Stage4ClosureReason }
    | null
  >(null);
  const [checkInDate, setCheckInDate] = useState<string>(defaultCheckInDate);
  const noSharedCloseDisabled = !canCloseNoShared || isClosing;
  const dateValid = DATE_INPUT_PATTERN.test(checkInDate.trim());

  if (pending) {
    const isShared = pending.kind === Stage4ClosureKind.SHARED_AGREEMENT;
    return (
      <View style={styles.actions}>
        <Text style={styles.closeConfirmTitle}>
          {isShared ? 'Close with shared agreement' : 'Close without a shared agreement'}
        </Text>
        <Text style={styles.closeConfirmCopy}>
          {isShared
            ? `Pick a check-in date. You'll both see this on the shared experiment.`
            : `That's a valid place to land. Whatever you've named here stays on record.`}
        </Text>
        <Text style={styles.dateLabel}>Check-in date (YYYY-MM-DD)</Text>
        <TextInput
          style={styles.dateInput}
          value={checkInDate}
          onChangeText={setCheckInDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={palette.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          testID="stage4-close-check-in-date"
          accessibilityLabel="Check-in date"
        />
        {!dateValid && (
          <Text style={styles.actionHint}>Enter a date like 2026-06-09.</Text>
        )}
        <TouchableOpacity
          style={[
            styles.primaryButton,
            (!dateValid || isClosing) && styles.primaryButtonDisabled,
          ]}
          onPress={() => {
            if (!dateValid || isClosing) return;
            onCloseStage4(pending.kind, pending.reason, checkInDate.trim());
          }}
          disabled={!dateValid || isClosing}
          accessibilityRole="button"
          accessibilityLabel="Confirm close"
          accessibilityState={{ disabled: !dateValid || isClosing }}
          testID="stage4-close-confirm"
        >
          <Send color={dateValid ? palette.bg : palette.textFaint} size={17} />
          <Text
            style={[
              styles.primaryButtonText,
              (!dateValid || isClosing) && styles.disabledButtonText,
            ]}
          >
            {isClosing ? 'Closing…' : 'Confirm close'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => setPending(null)}
          accessibilityRole="button"
          accessibilityLabel="Cancel close"
        >
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.actions}>
      <TouchableOpacity
        style={[styles.primaryButton, !canCloseShared && styles.primaryButtonDisabled]}
        onPress={() =>
          setPending({
            kind: Stage4ClosureKind.SHARED_AGREEMENT,
            reason: Stage4ClosureReason.MUTUAL_SELECTION,
          })
        }
        disabled={!canCloseShared || isClosing}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canCloseShared || isClosing }}
      >
        <Send color={canCloseShared ? palette.bg : palette.textFaint} size={17} />
        <Text style={[styles.primaryButtonText, !canCloseShared && styles.disabledButtonText]}>
          Close with shared agreement
        </Text>
      </TouchableOpacity>
      {showNoSharedClose && canCloseNoShared && !canCloseShared && onKeepRefiningNoOverlap && (
        <TouchableOpacity
          style={[styles.primaryButton]}
          onPress={() => onKeepRefiningNoOverlap()}
          accessibilityRole="button"
          accessibilityLabel="Keep refining in chat"
          testID="stage4-keep-refining-mwf"
        >
          <Send color={palette.bg} size={17} />
          <Text style={styles.primaryButtonText}>Keep refining in chat</Text>
        </TouchableOpacity>
      )}
      {showNoSharedClose && (
        <TouchableOpacity
          style={[styles.secondaryButton, noSharedCloseDisabled && styles.secondaryButtonDisabled]}
          onPress={() =>
            setPending({
              kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
              reason: Stage4ClosureReason.NO_OVERLAP,
            })
          }
          disabled={noSharedCloseDisabled}
          accessibilityRole="button"
          accessibilityState={{ disabled: noSharedCloseDisabled }}
          testID="stage4-close-without-shared"
        >
          <MinusCircle color={canCloseNoShared ? palette.text : palette.textFaint} size={17} />
          <Text
            style={[
              styles.secondaryButtonText,
              noSharedCloseDisabled && styles.disabledButtonText,
            ]}
          >
            Close without a shared agreement
          </Text>
        </TouchableOpacity>
      )}
      {!canCloseShared && (
        <Text style={styles.actionHint}>
          A shared agreement is available once you and {partnerName} both say &ldquo;willing&rdquo; to the same proposal.
        </Text>
      )}
    </View>
  );
}

function partnerStateLabel(
  partnerName: string | null,
  decision?: Stage4SelectionDecision,
): string {
  const who = partnerName || 'They';
  if (!decision) return `${who} hasn't shared their stance yet`;
  return `${who}: ${decisionLabels[decision].toLowerCase()}`;
}

/**
 * Who can read one of the viewer's own individual commitments, and the action that shares it (owner decision
 * 2026-11-25, work-k5fk.37): private until its own "Share with {partner}" — sharing stances shares none — and never
 * unshared. The partner then reads its current text only. Nothing for a shared proposal or the partner's commitment.
 */
function CommitmentVisibility({
  proposal,
  partnerName,
  readOnly,
  isSharing,
  onShareCommitment,
}: {
  proposal: ProposalCardDTO;
  partnerName: string;
  readOnly?: boolean;
  isSharing?: boolean;
  onShareCommitment?: (proposalId: string) => void;
}) {
  const { palette } = useAppAppearance();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  if (proposal.kind !== Stage4ProposalKind.INDIVIDUAL_COMMITMENT || proposal.ownerLabel !== 'You') return null;
  if (proposal.isShared) {
    return (
      <View style={styles.commitmentVisibility} testID={`stage4-commitment-shared-${proposal.id}`}>
        <Share2 size={13} color={palette.textMuted} />
        <Text style={styles.commitmentVisibilityText}>Shared with {partnerName}</Text>
      </View>
    );
  }
  const canShare = Boolean(onShareCommitment) && !readOnly && proposal.status !== Stage4ProposalStatus.REMOVED;
  return (
    <View style={styles.commitmentVisibility} testID={`stage4-commitment-private-${proposal.id}`}>
      <Lock size={13} color={palette.textMuted} />
      <Text style={styles.commitmentVisibilityText}>Private — only you can see this</Text>
      {canShare && (
        <TouchableOpacity
          onPress={() => {
            if (!isSharing) onShareCommitment?.(proposal.id);
          }}
          disabled={isSharing}
          accessibilityRole="button"
          accessibilityLabel={`Share this commitment with ${partnerName}`}
          accessibilityState={{ disabled: Boolean(isSharing) }}
          testID={`stage4-commitment-share-${proposal.id}`}
          style={styles.refineButton}
          hitSlop={8}
        >
          <Share2 size={14} color={palette.accent} />
          <Text style={styles.refineButtonText}>{isSharing ? 'Sharing…' : `Share with ${partnerName}`}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function ProposalCard({
  proposal,
  partnerName,
  isSelecting,
  readOnly,
  showStance = true,
  sharingCommitmentId,
  onSelectProposal,
  onRefineProposal,
  onShareCommitment,
}: {
  proposal: ProposalCardDTO;
  partnerName: string;
  isSelecting?: boolean;
  readOnly?: boolean;
  showStance?: boolean;
  sharingCommitmentId?: string | null;
  onSelectProposal: (proposalId: string, decision: Stage4SelectionDecision) => void;
  onRefineProposal?: (proposalId: string, description: string) => void;
  onShareCommitment?: (proposalId: string) => void;
}) {
  const { palette } = useAppAppearance();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const metaLines: string[] = [];
  if (proposal.needsAddressed.length > 0) {
    metaLines.push(
      'Addresses: ' +
        proposal.needsAddressed
          .map((n) => `${n.label} (${coverageLabels[n.coverage].toLowerCase()})`)
          .join(', '),
    );
  }
  if (proposal.duration) metaLines.push(`Timing: ${proposal.duration}`);
  if (proposal.measureOfSuccess) metaLines.push(`Success: ${proposal.measureOfSuccess}`);

  return (
    <View style={styles.proposalCard}>
      <View style={styles.proposalHeader}>
        <Text style={styles.proposalKind}>{proposalKindLabel(proposal.kind)}</Text>
        {proposal.ownerLabel && (
          <Text style={styles.ownerLabel}>{proposal.ownerLabel}</Text>
        )}
        {onRefineProposal && !readOnly && (
          <TouchableOpacity
            onPress={() => onRefineProposal(proposal.id, proposal.description)}
            accessibilityRole="button"
            accessibilityLabel={`Refine this proposal in chat`}
            testID={`stage4-proposal-refine-${proposal.id}`}
            style={styles.refineButton}
            hitSlop={8}
          >
            <RotateCcw size={14} color={palette.accent} />
            <Text style={styles.refineButtonText}>Refine this</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.proposalDescription}>{proposal.description}</Text>

      <CommitmentVisibility
        proposal={proposal}
        partnerName={partnerName}
        readOnly={readOnly}
        isSharing={sharingCommitmentId === proposal.id}
        onShareCommitment={onShareCommitment}
      />

      {metaLines.map((line) => (
        <Text key={line} style={styles.proposalMeta}>
          {line}
        </Text>
      ))}

      {showStance && (
        <>
          <Text style={styles.stanceLabel}>Your stance</Text>
          <View style={styles.segmentedControl}>
            {[
              Stage4SelectionDecision.WILLING,
              Stage4SelectionDecision.NOT_WILLING,
            ].map((decision) => {
              const selected = proposal.myDecision === decision;
              const disabled = Boolean(isSelecting || readOnly);
              return (
                <TouchableOpacity
                  key={decision}
                  style={[
                    styles.segment,
                    selected && styles.segmentSelected,
                    disabled && !selected && styles.segmentDisabled,
                  ]}
                  onPress={() => onSelectProposal(proposal.id, decision)}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={`${decisionLabels[decision]} for proposal`}
                  accessibilityState={{ selected, disabled }}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      selected && styles.segmentTextSelected,
                    ]}
                  >
                    {decisionLabels[decision]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.partnerState}>
            {partnerStateLabel(partnerName, proposal.partnerDecisionVisible)}
          </Text>
        </>
      )}
    </View>
  );
}

function NeedRows({
  title,
  rows,
  tone,
  onBrainstormNeed,
  onDeclineNeed,
  onUndeclineNeed,
}: {
  title: string;
  rows: GetStage4StateResponse['coverageAudit']['covered'];
  tone: 'covered' | 'partial' | 'open';
  onBrainstormNeed?: (needLabel: string, needId: string) => void;
  onDeclineNeed?: (needId: string) => void;
  onUndeclineNeed?: (needId: string) => void;
}) {
  const { palette } = useAppAppearance();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  if (rows.length === 0) return null;

  const showActions = tone === 'open';

  return (
    <View style={styles.coverageGroup}>
      <Text style={styles.coverageTitle}>{title}</Text>
      {rows.map((row, index) => {
        const declined = Boolean(row.userDeclinedToAddress);
        const key = row.id || `${row.label}-${index}`;
        return (
          <View key={key} style={styles.needRow}>
            <View style={[styles.needDot, styles[`${tone}Dot`]]} />
            <View style={styles.needTextWrap}>
              <Text style={[styles.needLabel, declined && styles.needLabelMuted]}>
                {row.label}
              </Text>
              {showActions && row.id && (
                declined ? (
                  <TouchableOpacity
                    onPress={() => onUndeclineNeed?.(row.id!)}
                    accessibilityRole="button"
                    accessibilityLabel={`Bring back ${row.label}`}
                    testID={`stage4-need-undecline-${row.id}`}
                  >
                    <Text style={styles.needSetAside}>
                      Set aside — tap to bring back
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.needActions}>
                    <TouchableOpacity
                      onPress={() => onBrainstormNeed?.(row.label, row.id!)}
                      accessibilityRole="button"
                      accessibilityLabel={`Brainstorm about ${row.label}`}
                      testID={`stage4-need-brainstorm-${row.id}`}
                      style={styles.needActionButton}
                    >
                      <Text style={styles.needActionButtonText}>Brainstorm in chat</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => onDeclineNeed?.(row.id!)}
                      accessibilityRole="button"
                      accessibilityLabel={`Leave ${row.label} for now`}
                      testID={`stage4-need-decline-${row.id}`}
                      style={styles.needActionButton}
                    >
                      <Text style={styles.needActionButtonText}>Leave for now</Text>
                    </TouchableOpacity>
                  </View>
                )
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function Stage4RedesignFooter({
  state: rawState,
  partnerName,
  isClosing = false,
  isSharing = false,
  isRevising = false,
  onShareSelections,
  onReviseSelections,
  onCloseStage4,
  onKeepRefiningNoOverlap,
  onBackToChat,
}: Stage4RedesignFooterProps) {
  const { palette } = useAppAppearance();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const state = withStage4Defaults(rawState);
  const allProposals = [
    ...state.inventory.sharedProposals,
    ...state.inventory.individualCommitments,
  ];
  const mutualShared = state.inventory.sharedProposals.filter(
    (proposal) =>
      proposal.myDecision === Stage4SelectionDecision.WILLING &&
      proposal.partnerDecisionVisible === Stage4SelectionDecision.WILLING,
  );
  const canCloseShared =
    mutualShared.length > 0 && state.partnerSelectionStatus === 'SUBMITTED';
  const canCloseNoShared =
    (state.phase === Stage4Phase.OUTCOME_REVIEW ||
      state.phase === Stage4Phase.SELECTION ||
      state.phase === Stage4Phase.COVERAGE_REVIEW) &&
    state.partnerSelectionStatus === 'SUBMITTED';
  const showNoSharedClose =
    state.phase === Stage4Phase.OUTCOME_REVIEW ||
    state.phase === Stage4Phase.SELECTION ||
    state.phase === Stage4Phase.COVERAGE_REVIEW;
  const mySelectionSubmitted = state.mySelectionStatus === 'SUBMITTED';
  const partnerReady = state.partnerSelectionStatus === 'SUBMITTED';
  const allMyDecisionsMade =
    state.inventory.sharedProposals.length > 0 &&
    state.inventory.sharedProposals.every((p) => Boolean(p.myDecision));
  const needsGated = allOpenNeedsAddressedOrDeclined(state);
  const who = partnerName || 'They';
  const isWalkingNeeds =
    state.walkthrough.phase === 'MY_NEEDS' ||
    state.walkthrough.phase === 'PARTNER_NEEDS';

  if (state.outcome) return null;
  if (isWalkingNeeds) return null;

  if (allProposals.length === 0) {
    return (
      <View style={styles.footerContainer}>
        <View style={styles.actions}>
          <View style={styles.statusBlock}>
            <Text style={styles.statusText}>
              Close this and keep brainstorming in the chat. Proposals will appear here once they are captured.
            </Text>
          </View>
          {onBackToChat && (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={onBackToChat}
              accessibilityRole="button"
              testID="stage4-back-to-chat"
            >
              <Text style={styles.secondaryButtonText}>Back to chat</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  if (!mySelectionSubmitted) {
    const canShare = allMyDecisionsMade && needsGated && !isSharing;
    return (
      <View style={styles.footerContainer}>
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.primaryButton, !canShare && styles.primaryButtonDisabled]}
            onPress={() => {
              if (canShare && onShareSelections) onShareSelections();
            }}
            disabled={!canShare}
            accessibilityRole="button"
            accessibilityLabel="Share my stances"
            accessibilityState={{ disabled: !canShare }}
            testID="stage4-share-selections"
          >
            <Share2 color={canShare ? palette.bg : palette.textFaint} size={17} />
            <Text style={[styles.primaryButtonText, !canShare && styles.disabledButtonText]}>
              {isSharing ? 'Sharing…' : `Share my stances with ${who}`}
            </Text>
          </TouchableOpacity>
          {!allMyDecisionsMade && (
            <Text style={styles.actionHint}>
              Take a stance on every proposal first.
            </Text>
          )}
          {allMyDecisionsMade && !needsGated && (
            <Text style={styles.actionHint} testID="stage4-needs-gate-hint">
              There are still needs unaddressed — brainstorm or set them aside first.
            </Text>
          )}
        </View>
      </View>
    );
  }

  if (!partnerReady) {
    return (
      <View style={styles.footerContainer}>
        <View style={styles.actions}>
          {onReviseSelections && (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                if (!isRevising) onReviseSelections();
              }}
              disabled={isRevising}
              accessibilityRole="button"
              accessibilityLabel="Revise my stances"
              testID="stage4-revise-selections"
            >
              <RotateCcw color={palette.text} size={17} />
              <Text style={styles.secondaryButtonText}>
                {isRevising ? 'Pulling back…' : 'Pull my stances back to revise'}
              </Text>
            </TouchableOpacity>
          )}
          <Text style={styles.actionHint}>
            Hidden until {who} shares too — then you'll both see at once.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.footerContainer}>
      <CloseControls
        canCloseShared={canCloseShared}
        showNoSharedClose={showNoSharedClose}
        canCloseNoShared={canCloseNoShared}
        isClosing={isClosing}
        partnerName={who}
        onCloseStage4={onCloseStage4}
        onKeepRefiningNoOverlap={onKeepRefiningNoOverlap}
      />
    </View>
  );
}

export function Stage4RedesignPanel({
  state: rawState,
  partnerName,
  isSelecting = false,
  isClosing = false,
  isSharing = false,
  isRevising = false,
  hideFooter = false,
  onSelectProposal,
  onShareSelections,
  onShareCommitment,
  sharingCommitmentId = null,
  onReviseSelections,
  onSuggestOptions,
  onBrainstormNeed,
  onRefineProposal,
  onKeepRefiningNoOverlap,
  onDeclineNeed,
  onUndeclineNeed,
  onMarkNeedCovered,
  onSkipNeed,
  onResetNeed,
  onBackToChat,
  onCloseStage4,
}: Stage4RedesignPanelProps) {
  const { palette } = useAppAppearance();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const state = withStage4Defaults(rawState);
  const partnerLabel = partnerName || 'Partner';
  const allProposals = [
    ...state.inventory.sharedProposals,
    ...state.inventory.individualCommitments,
  ];
  const mutualShared = state.inventory.sharedProposals.filter(
    (proposal) =>
      proposal.myDecision === Stage4SelectionDecision.WILLING &&
      proposal.partnerDecisionVisible === Stage4SelectionDecision.WILLING
  );
  const canCloseShared =
    mutualShared.length > 0 &&
    state.partnerSelectionStatus === 'SUBMITTED';
  const canCloseNoShared =
    (state.phase === Stage4Phase.OUTCOME_REVIEW ||
      state.phase === Stage4Phase.SELECTION ||
      state.phase === Stage4Phase.COVERAGE_REVIEW) &&
    state.partnerSelectionStatus === 'SUBMITTED';
  const showNoSharedClose =
    state.phase === Stage4Phase.OUTCOME_REVIEW ||
    state.phase === Stage4Phase.SELECTION ||
    state.phase === Stage4Phase.COVERAGE_REVIEW;
  const mySelectionSubmitted = state.mySelectionStatus === 'SUBMITTED';
  // Stances stay editable after sharing — changing one auto-unshares on the
  // backend, so the partner never sees a stale stance. Only a finalized
  // outcome locks them.
  const proposalSelectionsReadOnly = Boolean(state.outcome);

  const coverageHasRows =
    state.coverageAudit.covered.length > 0 ||
    state.coverageAudit.partial.length > 0 ||
    state.coverageAudit.open.length > 0;

  const walkthrough = state.walkthrough;
  const currentNeed = walkthrough.currentNeed;

  if (!state.outcome && (walkthrough.phase === 'MY_NEEDS' || walkthrough.phase === 'PARTNER_NEEDS') && currentNeed) {
    const phaseLabel =
      walkthrough.phase === 'MY_NEEDS'
        ? `Your needs: ${walkthrough.currentIndex + 1} of ${Math.max(1, walkthrough.totalInPhase)}`
        : `Their needs: ${walkthrough.currentIndex + 1} of ${Math.max(1, walkthrough.totalInPhase)}`;
    const hasProposal = walkthrough.proposalGroups.some((group) => group.proposals.length > 0);
    const phaseNeeds = walkthrough.phase === 'MY_NEEDS' ? walkthrough.ownNeeds : walkthrough.partnerNeeds;
    const previousNeeds = phaseNeeds.filter(
      (need) => need.id !== currentNeed.id && (need.status === 'covered' || need.status === 'skipped')
    );

    return (
      <View style={styles.container} testID="stage4-redesign-panel">
        <View style={styles.walkthroughHeader}>
          <View>
            <Text style={styles.walkthroughTitle}>Working toward agreements</Text>
            <Text style={styles.walkthroughProgress}>{phaseLabel}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {walkthrough.phase === 'MY_NEEDS' ? 'Need' : `${partnerLabel}'s need`}
          </Text>
          <Text style={styles.focusNeedText}>{currentNeed.label}</Text>
          <Text style={styles.emptyText}>
            {walkthrough.phase === 'MY_NEEDS'
              ? "Let's look at options for this need."
              : "Here's what might be relevant for you."}
          </Text>
        </View>

        {walkthrough.proposalGroups.map((group) => (
          <View key={group.key} style={styles.card}>
            <Text style={styles.sectionTitle}>{group.title}</Text>
            {group.proposals.length === 0 ? (
              <Text style={styles.emptyText}>No options in this group yet.</Text>
            ) : (
              group.proposals.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  partnerName={partnerLabel}
                  isSelecting={isSelecting}
                  readOnly={proposalSelectionsReadOnly || Boolean(group.readOnly)}
                  showStance={false}
                  sharingCommitmentId={sharingCommitmentId}
                  onSelectProposal={onSelectProposal}
                  onRefineProposal={group.readOnly ? undefined : onRefineProposal}
                  onShareCommitment={onShareCommitment}
                />
              ))
            )}
          </View>
        ))}

        <View style={styles.actions}>
          {!hasProposal ? (
            <View style={styles.statusBlock} testID="stage4-current-need-chat-guidance">
              <Text style={styles.statusText}>
                Keep brainstorming in the chat. When something feels workable, it will appear here.
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => onMarkNeedCovered?.(currentNeed.id)}
              accessibilityRole="button"
              testID="stage4-current-need-covered"
            >
              <Text style={styles.primaryButtonText}>
                {walkthrough.phase === 'MY_NEEDS' ? 'This need feels covered' : 'Continue'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.tertiaryButton}
            onPress={() => onSkipNeed?.(currentNeed.id)}
            accessibilityRole="button"
            testID="stage4-current-need-skip"
          >
            <Text style={styles.tertiaryButtonText}>Skip this need for now</Text>
          </TouchableOpacity>
        </View>

        {previousNeeds.length > 0 && (
          <View style={styles.referenceBlock} testID="stage4-previous-needs">
            <Text style={styles.referenceTitle}>Already reviewed</Text>
            {previousNeeds.map((need) => (
              <View key={need.id} style={styles.referenceRow}>
                <Text style={styles.referenceText}>{need.label}</Text>
                <Text style={styles.referenceStatus}>
                  {need.status === 'covered' ? 'Covered' : 'Skipped'}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  }

  if (!state.outcome && walkthrough.phase === 'QUALITY_REVIEW') {
    if (allProposals.length === 0) {
      const reviewedNeeds = [...walkthrough.ownNeeds, ...walkthrough.partnerNeeds].filter(
        (need) => need.status === 'covered' || need.status === 'skipped'
      );

      return (
        <View style={styles.container} testID="stage4-redesign-panel">
          <View style={styles.walkthroughHeader}>
            <View>
              <Text style={styles.walkthroughTitle}>Keep brainstorming</Text>
              <Text style={styles.walkthroughProgress}>No options have been captured yet.</Text>
            </View>
          </View>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Next step</Text>
            <Text style={styles.emptyText}>
              Close this and keep talking in the chat. When something feels workable, it will appear here for review.
            </Text>
          </View>
          {reviewedNeeds.length > 0 && onResetNeed && (
            <View style={styles.card} testID="stage4-empty-review-needs">
              <Text style={styles.sectionTitle}>Go back to a need</Text>
              {reviewedNeeds.map((need) => (
                <TouchableOpacity
                  key={need.id}
                  style={styles.secondaryButton}
                  onPress={() => onResetNeed(need.id)}
                  accessibilityRole="button"
                  testID={`stage4-reset-need-${need.id}`}
                >
                  <RotateCcw color={palette.text} size={17} />
                  <Text style={styles.secondaryButtonText}>{need.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {!hideFooter && (
            <Stage4RedesignFooter
              state={state}
              partnerName={partnerName}
              isClosing={isClosing}
              isSharing={isSharing}
              isRevising={isRevising}
              onShareSelections={onShareSelections}
              onReviseSelections={onReviseSelections}
              onKeepRefiningNoOverlap={onKeepRefiningNoOverlap}
              onBackToChat={onBackToChat}
              onCloseStage4={onCloseStage4}
            />
          )}
        </View>
      );
    }

    return (
      <View style={styles.container} testID="stage4-redesign-panel">
        <View style={styles.walkthroughHeader}>
          <View>
            <Text style={styles.walkthroughTitle}>Review agreements</Text>
            <Text style={styles.walkthroughProgress}>Check whether these are concrete enough to try.</Text>
          </View>
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Options to consider</Text>
          {allProposals.length === 0 ? (
            <Text style={styles.emptyText}>No proposals captured yet.</Text>
          ) : (
            allProposals.map((proposal) => {
              const warning = walkthrough.qualityWarnings.find((item) => item.proposalId === proposal.id);
              return (
                <View key={proposal.id}>
                  <ProposalCard
                    proposal={proposal}
                    partnerName={partnerLabel}
                    isSelecting={isSelecting}
                    readOnly={proposalSelectionsReadOnly}
                    sharingCommitmentId={sharingCommitmentId}
                    onSelectProposal={onSelectProposal}
                    onRefineProposal={onRefineProposal}
                    onShareCommitment={onShareCommitment}
                  />
                  {warning && (
                    <Text style={styles.actionHint}>{warning.warning} {warning.suggestedRevision}</Text>
                  )}
                </View>
              );
            })
          )}
        </View>
        {!hideFooter && (
          <Stage4RedesignFooter
            state={state}
            partnerName={partnerName}
            isClosing={isClosing}
            isSharing={isSharing}
            isRevising={isRevising}
            onShareSelections={onShareSelections}
            onReviseSelections={onReviseSelections}
            onCloseStage4={onCloseStage4}
            onKeepRefiningNoOverlap={onKeepRefiningNoOverlap}
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.container} testID="stage4-redesign-panel">
      <Text style={styles.intro}>
        Proposals are receipts from your conversation. Keep talking to add, revise, or remove them.
      </Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Proposals</Text>
        {allProposals.length === 0 ? (
          <Text style={styles.emptyText}>No proposals captured yet.</Text>
        ) : (
          allProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              partnerName={partnerLabel}
              isSelecting={isSelecting}
              readOnly={proposalSelectionsReadOnly}
              sharingCommitmentId={sharingCommitmentId}
              onSelectProposal={onSelectProposal}
              onRefineProposal={onRefineProposal}
              onShareCommitment={onShareCommitment}
            />
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>How your needs are addressed</Text>
        {coverageHasRows ? (
          <>
            <NeedRows title="Covered" rows={state.coverageAudit.covered} tone="covered" />
            <NeedRows title="Partly addressed" rows={state.coverageAudit.partial} tone="partial" />
            <NeedRows
              title="Not yet addressed"
              rows={state.coverageAudit.open}
              tone="open"
              onBrainstormNeed={onBrainstormNeed}
              onDeclineNeed={onDeclineNeed}
              onUndeclineNeed={onUndeclineNeed}
            />
          </>
        ) : (
          <Text style={styles.emptyText}>
            This will appear once your needs are mapped.
          </Text>
        )}
      </View>

      {state.outcome && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {state.outcome.kind === Stage4ClosureKind.SHARED_AGREEMENT
              ? 'Shared agreement outcome'
              : 'No shared agreement outcome'}
          </Text>
          <Text style={styles.outcomeReason}>{outcomeReasonLabel(state.outcome.reason)}</Text>
          <Text style={styles.outcomeSummary}>{state.outcome.summary}</Text>
          {state.outcome.agreements.map((agreement) => (
            <View key={agreement.id} style={styles.outcomeItem}>
              <Text style={styles.outcomeItemText}>{agreement.description}</Text>
            </View>
          ))}
          {state.outcome.openNeeds.length > 0 && (
            <Text style={styles.outcomeMeta}>
              Open needs carried forward: {state.outcome.openNeeds.map((need) => need.label).join(', ')}
            </Text>
          )}
        </View>
      )}

      {!hideFooter && !state.outcome && (() => {
        const partnerReady = state.partnerSelectionStatus === 'SUBMITTED';
        // Only shared proposals require a stance — individual commitments are
        // one-sided so the partner doesn't have to take a position on them.
        const allMyDecisionsMade =
          state.inventory.sharedProposals.length > 0 &&
          state.inventory.sharedProposals.every((p) => Boolean(p.myDecision));
        const who = partnerName || 'They';

        // (a) No proposals yet.
        if (allProposals.length === 0) {
          return (
            <View style={styles.statusBlock}>
              <Text style={styles.statusText}>
                Proposals will appear here as your conversation develops them.
              </Text>
            </View>
          );
        }

        // (b) I haven't shared yet → show Share CTA (disabled until every
        // proposal has a stance AND every open need is addressed-or-declined)
        // with an inline hint about what's missing.
        const needsGated = allOpenNeedsAddressedOrDeclined(state);
        if (!mySelectionSubmitted) {
          const canShare = allMyDecisionsMade && needsGated && !isSharing;
          return (
            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.primaryButton, !canShare && styles.primaryButtonDisabled]}
                onPress={() => {
                  if (canShare && onShareSelections) onShareSelections();
                }}
                disabled={!canShare}
                accessibilityRole="button"
                accessibilityLabel="Share my stances"
                accessibilityState={{ disabled: !canShare }}
                testID="stage4-share-selections"
              >
                <Share2 color={canShare ? palette.bg : palette.textFaint} size={17} />
                <Text style={[styles.primaryButtonText, !canShare && styles.disabledButtonText]}>
                  {isSharing ? 'Sharing…' : `Share my stances with ${who}`}
                </Text>
              </TouchableOpacity>
              {!allMyDecisionsMade && (
                <Text style={styles.actionHint}>
                  Take a stance on every proposal first.
                </Text>
              )}
              {allMyDecisionsMade && !needsGated && (
                <Text style={styles.actionHint} testID="stage4-needs-gate-hint-inline">
                  There are still needs unaddressed — brainstorm or set them aside first.
                </Text>
              )}
            </View>
          );
        }

        // (c) I've shared but partner hasn't → waiting state + Revise.
        if (!partnerReady) {
          return (
            <View style={styles.actions}>
              {onReviseSelections && (
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => {
                    if (!isRevising) onReviseSelections();
                  }}
                  disabled={isRevising}
                  accessibilityRole="button"
                  accessibilityLabel="Revise my stances"
                  testID="stage4-revise-selections"
                >
                  <RotateCcw color={palette.text} size={17} />
                  <Text style={styles.secondaryButtonText}>
                    {isRevising ? 'Taking back…' : "I'm not ready yet"}
                  </Text>
                </TouchableOpacity>
              )}
              <View style={styles.statusBlock}>
                <Text style={styles.statusText}>
                  Hidden until {who} shares too — then you'll both see at once.
                </Text>
              </View>
            </View>
          );
        }

        // (d) Both shared → close buttons.
        return (
          <CloseControls
            canCloseShared={canCloseShared}
            showNoSharedClose={showNoSharedClose}
            canCloseNoShared={canCloseNoShared}
            isClosing={isClosing}
            partnerName={who}
            onCloseStage4={onCloseStage4}
            onKeepRefiningNoOverlap={onKeepRefiningNoOverlap}
          />
        );
      })()}

      {state.phase === Stage4Phase.CLOSED_NO_SHARED_AGREEMENT && (
        <View style={styles.closedNote}>
          <XCircle color={palette.warning} size={18} />
          <Text style={styles.closedNoteText}>
            This is a valid close. Passive Tending re-entry remains available.
          </Text>
        </View>
      )}
    </View>
  );
}

type Palette = ReturnType<typeof useAppAppearance>['palette'];

const makeStyles = (palette: Palette) => StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 16,
  },
  intro: {
    color: palette.textMuted,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 4,
  },
  walkthroughHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 4,
  },
  walkthroughTitle: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '700',
  },
  walkthroughProgress: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  focusNeedText: {
    color: palette.text,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    marginBottom: 8,
  },
  card: {
    backgroundColor: palette.bgElev,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.border,
    padding: 14,
  },
  sectionTitle: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  emptyText: {
    color: palette.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  proposalCard: {
    backgroundColor: palette.bgPane,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  proposalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  proposalKind: {
    color: palette.accentText,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  ownerLabel: {
    color: palette.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  commitmentVisibility: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  commitmentVisibilityText: {
    color: palette.textMuted,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  proposalDescription: {
    color: palette.text,
    fontSize: 15,
    lineHeight: 21,
  },
  proposalMeta: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
  },
  stanceLabel: {
    color: palette.textMuted,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 14,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: palette.bgElev,
    borderRadius: 10,
    padding: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  segmentSelected: {
    backgroundColor: palette.accent,
  },
  segmentDisabled: {
    opacity: 0.5,
  },
  segmentText: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '600',
  },
  segmentTextSelected: {
    color: palette.bg,
    fontWeight: '700',
  },
  partnerState: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 8,
    fontStyle: 'italic',
  },
  coverageGroup: {
    marginBottom: 12,
  },
  coverageTitle: {
    color: palette.textMuted,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  needRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 8,
  },
  needDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
  },
  coveredDot: {
    backgroundColor: palette.success,
  },
  partialDot: {
    backgroundColor: palette.warning,
  },
  openDot: {
    backgroundColor: palette.danger,
  },
  needTextWrap: {
    flex: 1,
  },
  needLabel: {
    color: palette.text,
    fontSize: 14,
    lineHeight: 19,
  },
  needLabelMuted: {
    color: palette.textMuted,
    textDecorationLine: 'line-through',
  },
  needActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  needActionButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.bgElev,
  },
  needActionButtonText: {
    color: palette.text,
    fontSize: 12,
    fontWeight: '600',
  },
  refineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: palette.accent,
    marginLeft: 'auto',
  },
  refineButtonText: {
    color: palette.accent,
    fontSize: 11,
    fontWeight: '600',
  },
  needSetAside: {
    color: palette.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 4,
  },
  outcomeReason: {
    color: palette.accentText,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  outcomeSummary: {
    color: palette.text,
    fontSize: 14,
    lineHeight: 20,
  },
  outcomeItem: {
    backgroundColor: palette.bgPane,
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
  },
  outcomeItemText: {
    color: palette.text,
    fontSize: 14,
    lineHeight: 19,
  },
  outcomeMeta: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 10,
  },
  footerContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.bgPane,
  },
  actions: {
    gap: 10,
  },
  statusBlock: {
    backgroundColor: palette.bgElev,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.border,
    padding: 14,
  },
  statusText: {
    color: palette.text,
    fontSize: 14,
    lineHeight: 20,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
  },
  primaryButtonDisabled: {
    backgroundColor: palette.chipBg,
  },
  primaryButtonText: {
    color: palette.bg,
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: palette.bgElev,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
  },
  secondaryButtonDisabled: {
    opacity: 0.6,
  },
  secondaryButtonText: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
  },
  tertiaryButton: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  tertiaryButtonText: {
    color: palette.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  referenceBlock: {
    paddingHorizontal: 4,
    paddingTop: 4,
    gap: 8,
  },
  referenceTitle: {
    color: palette.textMuted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  referenceRow: {
    borderTopWidth: 1,
    borderTopColor: palette.border,
    paddingTop: 8,
    gap: 3,
  },
  referenceText: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  referenceStatus: {
    color: palette.textFaint,
    fontSize: 12,
    fontWeight: '600',
  },
  disabledButtonText: {
    color: palette.textFaint,
  },
  actionHint: {
    color: palette.textMuted,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  closeConfirmTitle: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '700',
  },
  closeConfirmCopy: {
    color: palette.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  dateLabel: {
    color: palette.textMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  dateInput: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: palette.border,
    paddingHorizontal: 12,
    color: palette.text,
    fontSize: 15,
    backgroundColor: palette.bgPane,
  },
  closedNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.warning,
    padding: 12,
  },
  closedNoteText: {
    flex: 1,
    color: palette.text,
    fontSize: 13,
    lineHeight: 18,
  },
});

export default Stage4RedesignPanel;
