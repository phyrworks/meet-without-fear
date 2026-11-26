/**
 * Auth Types and Context
 *
 * Separated from useAuth.ts to avoid Clerk import side effects in E2E mode.
 */

import { createContext, useContext } from 'react';
import type { UserDTO } from '@meet-without-fear/shared';

/**
 * User type from backend
 */
export interface User extends UserDTO {
  avatarUrl?: string;
}

/**
 * The backend refused the signed-in account (GET /auth/me, work-k5fk.35 C4): Clerk says signed in, but there is
 * no user to be. EMAIL_NOT_VERIFIED: the account's email is not verified. ACCOUNT_LINK_CONFLICT: the email belongs
 * to another account. EMAIL_NOT_ACCEPTED: the email is not one an account can hold (work-k5fk.34).
 */
export type AccountProblem = 'EMAIL_NOT_VERIFIED' | 'ACCOUNT_LINK_CONFLICT' | 'EMAIL_NOT_ACCEPTED';

/**
 * Authentication context value
 * Clerk-first: Clerk is the auth source, backend profile is just data
 */
export interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Set when the backend refused the account; the app shows what to do instead of the app (null otherwise) */
  accountProblem: AccountProblem | null;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
  updateUser: (updates: Partial<User>) => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Hook to access authentication state and methods
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
