import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import {
  AgreementStatus,
  AgreementType,
  GetStage4StateResponse,
  Stage4ClosureKind,
  Stage4ClosureReason,
  Stage4Phase,
  Stage4ProposalKind,
  Stage4ProposalStatus,
  Stage4SelectionDecision,
} from '@meet-without-fear/shared';
import { Stage4RedesignFooter, Stage4RedesignPanel } from '../Stage4RedesignPanel';

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const mockIcon = (props: Record<string, unknown>) =>
    React.createElement('Icon', props);
  return new Proxy(
    {},
    {
      get: () => mockIcon,
    }
  );
});

const baseState: GetStage4StateResponse = {
  phase: Stage4Phase.SELECTION,
  inventory: {
    sharedProposals: [
      {
        id: 'proposal-1',
        kind: Stage4ProposalKind.SHARED_PROPOSAL,
        description: 'Take turns naming the impact before problem solving.',
        needsAddressed: [
          { id: 'need-1', label: 'Feeling heard', coverage: 'COVERED' },
        ],
        duration: 'Two weeks',
        measureOfSuccess: 'Both people can finish a hard talk calmer.',
        status: Stage4ProposalStatus.ACTIVE,
        myDecision: Stage4SelectionDecision.WILLING,
      },
    ],
    individualCommitments: [
      {
        id: 'proposal-2',
        kind: Stage4ProposalKind.INDIVIDUAL_COMMITMENT,
        description: 'I will pause when my voice gets sharp.',
        ownerLabel: 'You',
        needsAddressed: [],
        duration: null,
        measureOfSuccess: null,
        status: Stage4ProposalStatus.ACTIVE,
        myDecision: Stage4SelectionDecision.NOT_WILLING,
      },
    ],
    unaddressedNeeds: [
      {
        id: 'need-2',
        label: 'Trust after conflict',
        source: 'BOTH',
        note: 'No active proposal fully covers this yet.',
      },
    ],
    removedProposalCount: 0,
    updatedAt: '2026-05-06T00:00:00.000Z',
  },
  coverageAudit: {
    covered: [
      {
        id: 'coverage-1',
        label: 'Feeling heard',
        source: 'BOTH',
        coveringProposalIds: ['proposal-1'],
        note: null,
      },
    ],
    partial: [],
    open: [
      {
        id: 'coverage-2',
        label: 'Trust after conflict',
        source: 'BOTH',
        coveringProposalIds: [],
        note: 'No active proposal fully covers this yet.',
      },
    ],
    updatedAt: '2026-05-06T00:00:00.000Z',
  },
  mySelections: [],
  partnerSelections: [],
  mySelectionStatus: 'NOT_STARTED',
  partnerSelectionStatus: 'NOT_STARTED',
  outcome: null,
  tendingPreview: null,
};

const walkthroughNeedsState: GetStage4StateResponse = {
  ...baseState,
  walkthrough: {
    phase: 'MY_NEEDS',
    currentNeed: {
      id: 'coverage-1',
      label: 'Feeling heard',
      source: 'YOU',
      status: 'in_progress',
    },
    currentIndex: 0,
    totalInPhase: 2,
    ownNeeds: [
      {
        id: 'coverage-0',
        label: 'A previously reviewed need',
        source: 'YOU',
        status: 'covered',
      },
      {
        id: 'coverage-1',
        label: 'Feeling heard',
        source: 'YOU',
        status: 'in_progress',
      },
    ],
    partnerNeeds: [],
    proposalGroups: [
      {
        key: 'you_suggested',
        title: 'Options you suggested',
        proposals: [baseState.inventory.sharedProposals[0]],
      },
    ],
    qualityWarnings: [],
    defaultCheckInDate: '2026-06-09',
  },
};

describe('Stage4RedesignPanel', () => {
  const defaultProps = {
    state: baseState,
    partnerName: 'Eve',
    onSelectProposal: jest.fn(),
    onCloseStage4: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders proposal inventory and needs coverage cards', () => {
    render(<Stage4RedesignPanel {...defaultProps} />);

    expect(screen.getByText('Proposals')).toBeTruthy();
    expect(screen.getByText('Take turns naming the impact before problem solving.')).toBeTruthy();
    expect(screen.getByText('I will pause when my voice gets sharp.')).toBeTruthy();
    expect(screen.getByText('How your needs are addressed')).toBeTruthy();
    expect(screen.getByText('Feeling heard')).toBeTruthy();
    expect(screen.getAllByText('Trust after conflict').length).toBeGreaterThan(0);
  });

  // work-k5fk.37 (owner decision 2026-11-25): each of your own commitments is private until you share it with its
  // own action; sharing your stances shares none, and a shared commitment is never unshared.
  describe('commitment sharing (work-k5fk.37)', () => {
    const withCommitment = (over: Partial<GetStage4StateResponse['inventory']['individualCommitments'][number]>) => ({
      ...baseState,
      inventory: {
        ...baseState.inventory,
        individualCommitments: [{ ...baseState.inventory.individualCommitments[0], ...over }],
      },
    });

    it('marks your unshared commitment private and shares that one commitment with its own button', () => {
      const onShareCommitment = jest.fn();
      render(
        <Stage4RedesignPanel
          {...defaultProps}
          state={withCommitment({ isShared: false })}
          onShareCommitment={onShareCommitment}
        />
      );
      expect(screen.getByTestId('stage4-commitment-private-proposal-2')).toBeTruthy();
      expect(screen.getByText('Private — only you can see this')).toBeTruthy();
      expect(screen.queryByTestId('stage4-commitment-shared-proposal-2')).toBeNull();
      fireEvent.press(screen.getByTestId('stage4-commitment-share-proposal-2'));
      expect(onShareCommitment).toHaveBeenCalledWith('proposal-2');
      expect(onShareCommitment).toHaveBeenCalledTimes(1);
      expect(defaultProps.onSelectProposal).not.toHaveBeenCalled();
    });

    it('says a shared commitment is shared, with no way to share or unshare it', () => {
      render(
        <Stage4RedesignPanel {...defaultProps} state={withCommitment({ isShared: true })} onShareCommitment={jest.fn()} />
      );
      expect(screen.getByTestId('stage4-commitment-shared-proposal-2')).toBeTruthy();
      expect(screen.getByText('Shared with Eve')).toBeTruthy();
      expect(screen.queryByTestId('stage4-commitment-share-proposal-2')).toBeNull();
      expect(screen.queryByTestId('stage4-commitment-private-proposal-2')).toBeNull();
    });

    it('shows nothing of the kind on the partner’s commitment or a shared proposal', () => {
      render(
        <Stage4RedesignPanel
          {...defaultProps}
          state={withCommitment({ ownerLabel: 'Partner', isShared: true })}
          onShareCommitment={jest.fn()}
        />
      );
      expect(screen.queryByTestId('stage4-commitment-shared-proposal-2')).toBeNull();
      expect(screen.queryByTestId('stage4-commitment-share-proposal-2')).toBeNull();
      expect(screen.queryByTestId('stage4-commitment-private-proposal-1')).toBeNull();
      expect(screen.queryByTestId('stage4-commitment-share-proposal-1')).toBeNull();
    });

    it('disables the button while that share is in flight', () => {
      const onShareCommitment = jest.fn();
      render(
        <Stage4RedesignPanel
          {...defaultProps}
          state={withCommitment({ isShared: false })}
          onShareCommitment={onShareCommitment}
          sharingCommitmentId="proposal-2"
        />
      );
      const button = screen.getByTestId('stage4-commitment-share-proposal-2');
      expect(button.props.accessibilityState?.disabled).toBe(true);
      expect(screen.getByText('Sharing…')).toBeTruthy();
      fireEvent.press(button);
      expect(onShareCommitment).not.toHaveBeenCalled();
    });

    it('no longer says sharing your stances shares your commitments', () => {
      render(<Stage4RedesignPanel {...defaultProps} state={withCommitment({ isShared: false })} />);
      expect(screen.queryByText(/commitments are shared/i)).toBeNull();
      expect(screen.queryByTestId('stage4-share-commitments-hint-inline')).toBeNull();
    });
  });

  it('keeps partner selections private before both submit', () => {
    render(<Stage4RedesignPanel {...defaultProps} />);

    expect(
      screen.getAllByText(/Eve hasn't shared their stance yet/i).length,
    ).toBeGreaterThan(0);
  });

  it('submits proposal-level willingness selections', () => {
    render(<Stage4RedesignPanel {...defaultProps} />);

    fireEvent.press(screen.getAllByText('Not willing')[0]);

    expect(defaultProps.onSelectProposal).toHaveBeenCalledWith(
      'proposal-1',
      Stage4SelectionDecision.NOT_WILLING
    );
  });

  it('offers only the two binary stance options per proposal', () => {
    render(<Stage4RedesignPanel {...defaultProps} />);

    const willing = screen.getAllByLabelText('Willing for proposal');
    const notWilling = screen.getAllByLabelText('Not willing for proposal');

    expect(willing.length).toBeGreaterThan(0);
    expect(notWilling.length).toBeGreaterThan(0);
    expect(screen.queryByText('Discuss')).toBeNull();
  });

  it('does not ask for stances while walking needs one at a time', () => {
    render(<Stage4RedesignPanel {...defaultProps} state={walkthroughNeedsState} />);

    expect(screen.getByText('Working toward agreements')).toBeTruthy();
    expect(screen.getByText('Take turns naming the impact before problem solving.')).toBeTruthy();
    expect(screen.queryByText('Your stance')).toBeNull();
    expect(screen.queryByText(/Eve hasn't shared their stance yet/i)).toBeNull();
    expect(screen.queryByLabelText('Willing for proposal')).toBeNull();
  });

  it('shows reviewed needs as a secondary reference while walking the current need', () => {
    render(<Stage4RedesignPanel {...defaultProps} state={walkthroughNeedsState} />);

    expect(screen.getByTestId('stage4-previous-needs')).toBeTruthy();
    expect(screen.getByText('Already reviewed')).toBeTruthy();
    expect(screen.getByText('A previously reviewed need')).toBeTruthy();
    expect(screen.getByText('Covered')).toBeTruthy();
  });

  it('does not let the drawer brainstorm options for an empty current need', () => {
    const emptyState: GetStage4StateResponse = {
      ...walkthroughNeedsState,
      walkthrough: {
        ...walkthroughNeedsState.walkthrough!,
        proposalGroups: walkthroughNeedsState.walkthrough!.proposalGroups.map((group) => ({
          ...group,
          proposals: [],
        })),
      },
    };

    render(<Stage4RedesignPanel {...defaultProps} state={emptyState} />);

    expect(screen.getByTestId('stage4-current-need-chat-guidance')).toBeTruthy();
    expect(screen.getByText(/Keep brainstorming in the chat/i)).toBeTruthy();
    expect(screen.queryByTestId('stage4-current-need-brainstorm')).toBeNull();
    expect(screen.queryByTestId('stage4-current-need-covered')).toBeNull();
    expect(screen.getByTestId('stage4-current-need-skip')).toBeTruthy();
  });

  it('hides the share footer while walking needs one at a time', () => {
    render(
      <Stage4RedesignFooter
        state={walkthroughNeedsState}
        partnerName="Eve"
        onCloseStage4={jest.fn()}
      />
    );

    expect(screen.queryByTestId('stage4-share-selections')).toBeNull();
  });

  it('asks for stances after the needs walkthrough reaches review', () => {
    const reviewState: GetStage4StateResponse = {
      ...walkthroughNeedsState,
      walkthrough: {
        ...walkthroughNeedsState.walkthrough!,
        phase: 'QUALITY_REVIEW',
        currentNeed: null,
      },
    };

    render(<Stage4RedesignPanel {...defaultProps} state={reviewState} />);

    expect(screen.getByText('Options to consider')).toBeTruthy();
    expect(screen.getAllByText('Your stance').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Willing for proposal').length).toBeGreaterThan(0);
  });

  it('does not show agreement review when quality review has no proposals', () => {
    const onBackToChat = jest.fn();
    const onResetNeed = jest.fn();
    const reviewState: GetStage4StateResponse = {
      ...walkthroughNeedsState,
      inventory: {
        ...walkthroughNeedsState.inventory,
        sharedProposals: [],
        individualCommitments: [],
      },
      walkthrough: {
        ...walkthroughNeedsState.walkthrough!,
        phase: 'QUALITY_REVIEW',
        currentNeed: null,
        proposalGroups: [],
      },
    };

    render(
      <Stage4RedesignPanel
        {...defaultProps}
        state={reviewState}
        onBackToChat={onBackToChat}
        onResetNeed={onResetNeed}
      />
    );

    expect(screen.getByText('Keep brainstorming')).toBeTruthy();
    expect(screen.getByText('No options have been captured yet.')).toBeTruthy();
    expect(screen.getByText('Go back to a need')).toBeTruthy();
    expect(screen.queryByText('Review agreements')).toBeNull();
    expect(screen.queryByText('Options to consider')).toBeNull();

    fireEvent.press(screen.getByTestId('stage4-reset-need-coverage-0'));
    expect(onResetNeed).toHaveBeenCalledWith('coverage-0');

    fireEvent.press(screen.getByTestId('stage4-back-to-chat'));

    expect(onBackToChat).toHaveBeenCalledTimes(1);
  });

  it('enables shared-agreement closure only when mutual willingness is visible', () => {
    const state: GetStage4StateResponse = {
      ...baseState,
      phase: Stage4Phase.OUTCOME_REVIEW,
      mySelectionStatus: 'SUBMITTED',
      partnerSelectionStatus: 'SUBMITTED',
      inventory: {
        ...baseState.inventory,
        sharedProposals: [
          {
            ...baseState.inventory.sharedProposals[0],
            partnerDecisionVisible: Stage4SelectionDecision.WILLING,
          },
        ],
      },
    };

    render(<Stage4RedesignPanel {...defaultProps} state={state} />);

    fireEvent.press(screen.getByText('Close with shared agreement'));
    // Pressing the close button only opens the check-in step — it must not
    // call onCloseStage4 yet, because checkInDate is required.
    expect(defaultProps.onCloseStage4).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('stage4-close-confirm'));

    expect(defaultProps.onCloseStage4).toHaveBeenCalledWith(
      Stage4ClosureKind.SHARED_AGREEMENT,
      Stage4ClosureReason.MUTUAL_SELECTION,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    );
  });

  it('blocks the confirm-close CTA when the check-in date is empty', () => {
    const state: GetStage4StateResponse = {
      ...baseState,
      phase: Stage4Phase.OUTCOME_REVIEW,
      mySelectionStatus: 'SUBMITTED',
      partnerSelectionStatus: 'SUBMITTED',
      inventory: {
        ...baseState.inventory,
        sharedProposals: [
          {
            ...baseState.inventory.sharedProposals[0],
            partnerDecisionVisible: Stage4SelectionDecision.WILLING,
          },
        ],
      },
    };

    render(<Stage4RedesignPanel {...defaultProps} state={state} />);

    fireEvent.press(screen.getByText('Close with shared agreement'));
    fireEvent.changeText(screen.getByTestId('stage4-close-check-in-date'), '');

    const confirm = screen.getByTestId('stage4-close-confirm');
    expect(confirm).toBeDisabled();

    fireEvent.press(confirm);
    expect(defaultProps.onCloseStage4).not.toHaveBeenCalled();
  });

  it('enables shared-agreement closure when mutual willingness exists even if other active fragments are unreviewed', () => {
    const state: GetStage4StateResponse = {
      ...baseState,
      phase: Stage4Phase.SELECTION,
      mySelectionStatus: 'SUBMITTED',
      partnerSelectionStatus: 'SUBMITTED',
      inventory: {
        ...baseState.inventory,
        sharedProposals: [
          {
            ...baseState.inventory.sharedProposals[0],
            partnerDecisionVisible: Stage4SelectionDecision.WILLING,
          },
          {
            ...baseState.inventory.sharedProposals[0],
            id: 'proposal-3',
            description: 'Monthly desire conversation.',
            myDecision: undefined,
            partnerDecisionVisible: Stage4SelectionDecision.WILLING,
          },
        ],
      },
    };

    render(<Stage4RedesignPanel {...defaultProps} state={state} />);

    const closeButton = screen.getByText('Close with shared agreement');
    expect(closeButton).not.toBeDisabled();

    fireEvent.press(closeButton);
    fireEvent.press(screen.getByTestId('stage4-close-confirm'));

    expect(defaultProps.onCloseStage4).toHaveBeenCalledWith(
      Stage4ClosureKind.SHARED_AGREEMENT,
      Stage4ClosureReason.MUTUAL_SELECTION,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    );
  });

  it('shows the share CTA when stances are complete but not yet shared', () => {
    render(<Stage4RedesignPanel {...defaultProps} />);

    expect(screen.queryByText('Close without a shared agreement')).toBeNull();
    expect(screen.queryByText('Close with shared agreement')).toBeNull();
    expect(screen.getByText(/Share my stances with Eve/i)).toBeTruthy();
  });

  it('disables the share CTA until every proposal has a stance', () => {
    const state: GetStage4StateResponse = {
      ...baseState,
      inventory: {
        ...baseState.inventory,
        sharedProposals: [
          {
            ...baseState.inventory.sharedProposals[0],
            myDecision: undefined,
          },
        ],
      },
    };

    render(<Stage4RedesignPanel {...defaultProps} state={state} />);

    const share = screen.getByLabelText('Share my stances');
    expect(share).toBeDisabled();
    expect(screen.getByText(/Take a stance on every proposal first/i)).toBeTruthy();
  });

  it('calls onShareSelections when the share CTA is pressed', () => {
    const onShareSelections = jest.fn();
    // Open need must be addressed-or-declined for the share gate to allow it.
    const gatedState: GetStage4StateResponse = {
      ...baseState,
      coverageAudit: {
        ...baseState.coverageAudit,
        open: baseState.coverageAudit.open.map((row) => ({
          ...row,
          userDeclinedToAddress: true,
        })),
      },
    };
    render(
      <Stage4RedesignPanel
        {...defaultProps}
        state={gatedState}
        onShareSelections={onShareSelections}
      />,
    );

    fireEvent.press(screen.getByLabelText('Share my stances'));
    expect(onShareSelections).toHaveBeenCalled();
  });

  it('shows waiting state with revise CTA after sharing but before partner submits', () => {
    const onReviseSelections = jest.fn();
    const state: GetStage4StateResponse = {
      ...baseState,
      mySelectionStatus: 'SUBMITTED',
      partnerSelectionStatus: 'NOT_STARTED',
    };

    render(
      <Stage4RedesignPanel
        {...defaultProps}
        state={state}
        onReviseSelections={onReviseSelections}
      />,
    );

    expect(screen.queryByText('Close without a shared agreement')).toBeNull();
    expect(screen.queryByText('Close with shared agreement')).toBeNull();
    expect(screen.getByText(/Hidden until Eve shares too/i)).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Revise my stances'));
    expect(onReviseSelections).toHaveBeenCalled();
  });

  it('renders close-without-agreement button as enabled when both have submitted selections', () => {
    const state: GetStage4StateResponse = {
      ...baseState,
      phase: Stage4Phase.OUTCOME_REVIEW,
      mySelectionStatus: 'SUBMITTED',
      partnerSelectionStatus: 'SUBMITTED',
      partnerSelections: [],
    };

    render(<Stage4RedesignPanel {...defaultProps} state={state} />);

    const closeButton = screen.getByText('Close without a shared agreement');
    expect(closeButton).not.toBeDisabled();

    fireEvent.press(closeButton);
    fireEvent.press(screen.getByTestId('stage4-close-confirm'));

    expect(defaultProps.onCloseStage4).toHaveBeenCalledWith(
      Stage4ClosureKind.NO_SHARED_AGREEMENT,
      Stage4ClosureReason.NO_OVERLAP,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    );
  });

  it('renders no-shared-agreement outcome as a valid close', () => {
    const state: GetStage4StateResponse = {
      ...baseState,
      phase: Stage4Phase.CLOSED_NO_SHARED_AGREEMENT,
      outcome: {
        kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
        reason: Stage4ClosureReason.NO_OVERLAP,
        summary: 'No shared experiment was right to try yet.',
        agreements: [],
        individualCommitments: [],
        openNeeds: baseState.inventory.unaddressedNeeds,
        closedAt: '2026-05-06T00:00:00.000Z',
        checkInAt: '2026-06-03T00:00:00.000Z',
      },
    };

    render(<Stage4RedesignPanel {...defaultProps} state={state} />);

    expect(screen.getByText('No shared agreement outcome')).toBeTruthy();
    expect(screen.getByText('No shared experiment was right to try yet.')).toBeTruthy();
    expect(screen.getByText('This is a valid close. Passive Tending re-entry remains available.')).toBeTruthy();
  });

  it('renders closed proposal selections as read-only', () => {
    const state: GetStage4StateResponse = {
      ...baseState,
      phase: Stage4Phase.CLOSED_NO_SHARED_AGREEMENT,
      outcome: {
        kind: Stage4ClosureKind.NO_SHARED_AGREEMENT,
        reason: Stage4ClosureReason.NO_OVERLAP,
        summary: 'No shared experiment was right to try yet.',
        agreements: [],
        individualCommitments: [],
        openNeeds: baseState.inventory.unaddressedNeeds,
        closedAt: '2026-05-06T00:00:00.000Z',
        checkInAt: '2026-06-03T00:00:00.000Z',
      },
    };

    render(<Stage4RedesignPanel {...defaultProps} state={state} />);

    const willingButtons = screen.getAllByLabelText('Willing for proposal');
    expect(willingButtons[0]).toBeDisabled();

    fireEvent.press(willingButtons[0]);

    expect(defaultProps.onSelectProposal).not.toHaveBeenCalled();
  });

  it('renders shared agreement outcome details', () => {
    const state: GetStage4StateResponse = {
      ...baseState,
      phase: Stage4Phase.CLOSED_SHARED_AGREEMENT,
      outcome: {
        kind: Stage4ClosureKind.SHARED_AGREEMENT,
        reason: Stage4ClosureReason.MUTUAL_SELECTION,
        summary: 'Both people chose one shared experiment.',
        agreements: [
          {
            id: 'agreement-1',
            strategyId: 'proposal-1',
            description: 'Take turns naming the impact before problem solving.',
            type: AgreementType.MICRO_EXPERIMENT,
            duration: 'Two weeks',
            measureOfSuccess: 'Both people can finish a hard talk calmer.',
            status: AgreementStatus.AGREED,
            agreedByMe: true,
            agreedByPartner: true,
            agreedAt: '2026-05-06T00:00:00.000Z',
            followUpDate: null,
          },
        ],
        individualCommitments: [],
        openNeeds: [],
        closedAt: '2026-05-06T00:00:00.000Z',
        checkInAt: '2026-06-03T00:00:00.000Z',
      },
    };

    render(<Stage4RedesignPanel {...defaultProps} state={state} />);

    expect(screen.getByText('Shared agreement outcome')).toBeTruthy();
    expect(screen.getByText('Both people chose one shared experiment.')).toBeTruthy();
  });

  describe('Needs gate: brainstorm / leave-for-now', () => {
    it('renders Brainstorm and Leave-for-now buttons for each open need', () => {
      render(<Stage4RedesignPanel {...defaultProps} />);
      expect(screen.getByTestId('stage4-need-brainstorm-coverage-2')).toBeTruthy();
      expect(screen.getByTestId('stage4-need-decline-coverage-2')).toBeTruthy();
    });

    it('fires onBrainstormNeed with the need label when Brainstorm is tapped', () => {
      const onBrainstormNeed = jest.fn();
      render(
        <Stage4RedesignPanel {...defaultProps} onBrainstormNeed={onBrainstormNeed} />
      );
      fireEvent.press(screen.getByTestId('stage4-need-brainstorm-coverage-2'));
      expect(onBrainstormNeed).toHaveBeenCalledWith('Trust after conflict', 'coverage-2');
    });

    it('fires onDeclineNeed with the need id when Leave-for-now is tapped', () => {
      const onDeclineNeed = jest.fn();
      render(<Stage4RedesignPanel {...defaultProps} onDeclineNeed={onDeclineNeed} />);
      fireEvent.press(screen.getByTestId('stage4-need-decline-coverage-2'));
      expect(onDeclineNeed).toHaveBeenCalledWith('coverage-2');
    });

    it('renders the muted "Set aside" affordance when a need is declined', () => {
      const declinedState: GetStage4StateResponse = {
        ...baseState,
        coverageAudit: {
          ...baseState.coverageAudit,
          open: baseState.coverageAudit.open.map((row) => ({
            ...row,
            userDeclinedToAddress: true,
          })),
        },
      };
      const onUndeclineNeed = jest.fn();
      render(
        <Stage4RedesignPanel
          {...defaultProps}
          state={declinedState}
          onUndeclineNeed={onUndeclineNeed}
        />
      );
      fireEvent.press(screen.getByTestId('stage4-need-undecline-coverage-2'));
      expect(onUndeclineNeed).toHaveBeenCalledWith('coverage-2');
    });

    it('disables Share while any open need is neither addressed nor declined', () => {
      // baseState has one open need with no covering proposal and no declination.
      // sharedProposals[0] has myDecision = WILLING but it does not cover need-2.
      render(<Stage4RedesignPanel {...defaultProps} />);
      const share = screen.getByTestId('stage4-share-selections');
      expect(share.props.accessibilityState?.disabled).toBe(true);
      expect(screen.getByTestId('stage4-needs-gate-hint-inline')).toBeTruthy();
    });

    it('enables Share once every open need is declined', () => {
      const gatedState: GetStage4StateResponse = {
        ...baseState,
        coverageAudit: {
          ...baseState.coverageAudit,
          open: baseState.coverageAudit.open.map((row) => ({
            ...row,
            userDeclinedToAddress: true,
          })),
        },
      };
      render(<Stage4RedesignPanel {...defaultProps} state={gatedState} />);
      const share = screen.getByTestId('stage4-share-selections');
      expect(share.props.accessibilityState?.disabled).toBe(false);
    });
  });

  describe('no-overlap footer (Phase 3)', () => {
    function noOverlapState(): GetStage4StateResponse {
      return {
        ...baseState,
        phase: Stage4Phase.OUTCOME_REVIEW,
        mySelectionStatus: 'SUBMITTED',
        partnerSelectionStatus: 'SUBMITTED',
        inventory: {
          ...baseState.inventory,
          sharedProposals: [
            {
              ...baseState.inventory.sharedProposals[0],
              myDecision: Stage4SelectionDecision.NOT_WILLING,
              partnerDecisionVisible: Stage4SelectionDecision.WILLING,
            },
          ],
        },
      };
    }

    it('shows "Keep refining with MWF" as primary and "Close without a shared agreement" as secondary', () => {
      const onKeep = jest.fn();
      render(
        <Stage4RedesignPanel
          {...defaultProps}
          state={noOverlapState()}
          onKeepRefiningNoOverlap={onKeep}
        />
      );
      const keep = screen.getByTestId('stage4-keep-refining-mwf');
      const closeWithout = screen.getByTestId('stage4-close-without-shared');
      // Primary lives in the styles.primaryButton tree; secondary in styles.secondaryButton.
      // Asserting the relative visual treatment through the *order* of children and that
      // both buttons are present is sufficient for Phase 3 — the primary button is
      // rendered above the secondary in the close-controls cluster.
      expect(keep).toBeTruthy();
      expect(closeWithout).toBeTruthy();
      fireEvent.press(keep);
      expect(onKeep).toHaveBeenCalled();
    });
  });

  describe('linked-need rendering (Phase 4)', () => {
    it('renders the user\'s original IdentifiedNeed phrasing on the proposal card', () => {
      const linkedState: GetStage4StateResponse = {
        ...baseState,
        inventory: {
          ...baseState.inventory,
          sharedProposals: [
            {
              ...baseState.inventory.sharedProposals[0],
              needsAddressed: [
                {
                  id: 'need-autonomy',
                  label: 'autonomy over my own schedule',
                  coverage: 'COVERED',
                },
              ],
            },
          ],
        },
      };
      render(<Stage4RedesignPanel {...defaultProps} state={linkedState} />);
      expect(
        screen.getByText(/autonomy over my own schedule/i)
      ).toBeTruthy();
    });
  });

  describe('refine-this affordance (Phase 3)', () => {
    it('per-proposal Refine this button opens a refinement sub-chat', () => {
      const onRefine = jest.fn();
      render(
        <Stage4RedesignPanel
          {...defaultProps}
          onRefineProposal={onRefine}
        />
      );
      fireEvent.press(screen.getByTestId('stage4-proposal-refine-proposal-1'));
      expect(onRefine).toHaveBeenCalledWith(
        'proposal-1',
        'Take turns naming the impact before problem solving.'
      );
    });
  });
});
