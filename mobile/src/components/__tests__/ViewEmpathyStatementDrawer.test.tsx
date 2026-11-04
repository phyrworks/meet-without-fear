import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ViewEmpathyStatementDrawer } from '../ViewEmpathyStatementDrawer';

describe('ViewEmpathyStatementDrawer', () => {
  const defaultProps = {
    visible: true,
    statement: 'I understand why this felt frustrating.',
    partnerName: 'Alex',
    onShare: jest.fn(),
    onClose: jest.fn(),
    onSendRefinement: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not show accept/reject buttons while revising', () => {
    render(<ViewEmpathyStatementDrawer {...defaultProps} isRevising />);

    expect(screen.getByText('Refine further')).toBeTruthy();
    expect(screen.getByText('Resubmit')).toBeTruthy();
    expect(screen.queryByText('I accept their experience')).toBeNull();
    expect(screen.queryByText('I cannot accept this')).toBeNull();
  });

  it('before the partner joins: explains the wait, offers no Share, and "Keep for later" only closes (work-99k2)', () => {
    render(<ViewEmpathyStatementDrawer {...defaultProps} awaitingPartner />);

    expect(screen.getByTestId('empathy-share-after-join-note')).toHaveTextContent(
      "Alex hasn't joined yet. Your draft is saved, and you can share it once Alex joins. You'll get to look it over again first.",
    );
    expect(screen.queryByTestId('share-empathy-button')).toBeNull();
    fireEvent.press(screen.getByTestId('empathy-keep-for-later-button'));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    expect(defaultProps.onShare).not.toHaveBeenCalled();
  });

  it('preserves resubmit action while revising', () => {
    render(<ViewEmpathyStatementDrawer {...defaultProps} isRevising />);

    fireEvent.press(screen.getByTestId('share-empathy-button'));

    expect(defaultProps.onShare).toHaveBeenCalledTimes(1);
  });
});
