/**
 * work-99k2: the review of a draft written before the partner joined — the
 * written-at date, and the three choices (send as is / edit first / set aside,
 * the last confirmed in-page).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { PreJoinDraftReviewModal, formatWrittenAt, preJoinReviewHeading } from '../PreJoinDraftReviewModal';

// Wednesday 2026-11-04, noon local.
const NOW = new Date(2026, 10, 4, 12, 0, 0);
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h, 0, 0).toISOString();

describe('formatWrittenAt', () => {
  it('reads as a day relative to now', () => {
    expect(formatWrittenAt(at(2026, 10, 4, 8), NOW)).toBe('earlier today');
    expect(formatWrittenAt(at(2026, 10, 3, 23), NOW)).toBe('yesterday');
    expect(formatWrittenAt(at(2026, 10, 3 - 1), NOW)).toBe('on Monday');
    expect(formatWrittenAt(at(2026, 9, 29), NOW)).toBe('on Thursday');
    expect(formatWrittenAt(at(2026, 9, 28), NOW)).toBe('on Oct 28');
    expect(formatWrittenAt(at(2025, 11, 30), NOW)).toBe('on Dec 30, 2025');
  });

  it('heads the prompt with the partner and the day', () => {
    expect(preJoinReviewHeading('Jordan', at(2026, 10, 3 - 1), NOW)).toBe(
      "Jordan has joined. Here's what you wrote on Monday.",
    );
  });
});

describe('PreJoinDraftReviewModal', () => {
  const props = {
    visible: true,
    partnerName: 'Jordan',
    writtenAt: at(2026, 10, 3),
    statement: 'Jordan may feel unseen when the chores pile up.',
    onSendAsIs: jest.fn(),
    onEditFirst: jest.fn(),
    onSetAside: jest.fn(),
    now: NOW,
  };

  beforeEach(() => jest.clearAllMocks());

  it('shows when it was written and what was written', () => {
    render(<PreJoinDraftReviewModal {...props} />);
    expect(screen.getByTestId('pre-join-review-heading')).toHaveTextContent(
      "Jordan has joined. Here's what you wrote yesterday.",
    );
    expect(screen.getByTestId('pre-join-review-statement')).toHaveTextContent(props.statement);
  });

  it('send as is and edit first call through', () => {
    render(<PreJoinDraftReviewModal {...props} />);
    fireEvent.press(screen.getByTestId('pre-join-review-send-button'));
    expect(props.onSendAsIs).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('pre-join-review-edit-button'));
    expect(props.onEditFirst).toHaveBeenCalledTimes(1);
    expect(props.onSetAside).not.toHaveBeenCalled();
  });

  it('set aside asks in-page first; "Keep it" backs out, confirming discards', () => {
    render(<PreJoinDraftReviewModal {...props} />);
    fireEvent.press(screen.getByTestId('pre-join-review-set-aside-button'));
    expect(props.onSetAside).not.toHaveBeenCalled();
    expect(screen.getByTestId('pre-join-review-confirm-set-aside')).toBeTruthy();

    fireEvent.press(screen.getByTestId('pre-join-review-keep-button'));
    expect(screen.queryByTestId('pre-join-review-confirm-set-aside')).toBeNull();
    expect(props.onSetAside).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('pre-join-review-set-aside-button'));
    fireEvent.press(screen.getByTestId('pre-join-review-confirm-set-aside-button'));
    expect(props.onSetAside).toHaveBeenCalledTimes(1);
  });
});
