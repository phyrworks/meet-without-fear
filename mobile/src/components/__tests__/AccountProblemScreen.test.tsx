/**
 * work-k5fk.35 C4: a refused account sees what to do, and can sign out.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { AccountProblemScreen, SUPPORT_EMAIL } from '../AccountProblemScreen';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

describe('AccountProblemScreen', () => {
  it('EMAIL_NOT_VERIFIED: asks the user to verify their email in their account', () => {
    render(<AccountProblemScreen problem="EMAIL_NOT_VERIFIED" onSignOut={jest.fn()} />);
    expect(screen.getByText('Verify your email')).toBeTruthy();
    expect(screen.getByText(/Verify your email in your account/)).toBeTruthy();
  });

  it('ACCOUNT_LINK_CONFLICT: says the email belongs to another account, and how to reach support', () => {
    render(<AccountProblemScreen problem="ACCOUNT_LINK_CONFLICT" onSignOut={jest.fn()} />);
    expect(screen.getByText('This email belongs to another account')).toBeTruthy();
    expect(screen.getByText(new RegExp(`Contact support at ${SUPPORT_EMAIL}`))).toBeTruthy();
  });

  it('EMAIL_NOT_ACCEPTED: says the email cannot be used, and how to reach support (work-k5fk.34)', () => {
    render(<AccountProblemScreen problem="EMAIL_NOT_ACCEPTED" onSignOut={jest.fn()} />);
    expect(screen.getByText("This email can't be used")).toBeTruthy();
    expect(screen.getByText(new RegExp(`contact support at ${SUPPORT_EMAIL}`))).toBeTruthy();
  });

  it('signs out', () => {
    const onSignOut = jest.fn();
    render(<AccountProblemScreen problem="EMAIL_NOT_VERIFIED" onSignOut={onSignOut} />);
    fireEvent.press(screen.getByTestId('account-problem-sign-out'));
    expect(onSignOut).toHaveBeenCalled();
  });
});
