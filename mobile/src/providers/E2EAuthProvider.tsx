/**
 * E2E Auth Provider
 *
 * Bypasses Clerk authentication for E2E testing.
 * When EXPO_PUBLIC_E2E_MODE is set, this provider mocks the auth context
 * to simulate a logged-in user without requiring Clerk.
 *
 * The provider reads E2E user info from URL parameters set by Playwright,
 * then fetches the full user profile from the backend.
 */

import React, { ReactNode, useCallback, useState, useEffect } from 'react';
import { Platform } from 'react-native';
import { AuthContext, User, AuthContextValue } from '../hooks/useAuthTypes';
import { setTokenProvider, get } from '../lib/api';

// Default E2E test user - used if no URL params provided
const DEFAULT_E2E_USER: User = {
  id: 'e2e-test-user',
  email: 'e2e-test@e2e.test',
  name: 'E2E Test User',
  firstName: 'E2E',
  lastName: 'Test',
  biometricEnabled: false,
  lastMoodIntensity: null,
  createdAt: new Date().toISOString(),
};

/**
 * Cached E2E user info — persists across re-renders and client-side navigations.
 * Without this, navigating from /?e2e-user-id=xxx to /session/xxx loses the
 * query params, causing the provider to fall back to the default E2E user.
 */
let cachedE2EUserInfo: { id: string; email: string } | null = null;

/**
 * Parse E2E user info from URL search params (set by Playwright via page.goto)
 * Format: ?e2e-user-id=xxx&e2e-user-email=xxx
 *
 * Caches the result so client-side navigation doesn't lose the params.
 */
function getE2EUserFromURL(): { id: string; email: string } | null {
  if (Platform.OS !== 'web') return null;

  try {
    // Check URL search params (Playwright can set these)
    const urlParams = new URLSearchParams(window.location.search);
    const userId = urlParams.get('e2e-user-id');
    const userEmail = urlParams.get('e2e-user-email');

    if (userId && userEmail) {
      cachedE2EUserInfo = { id: userId, email: userEmail };
      return cachedE2EUserInfo;
    }
  } catch {
    // Ignore - not in web environment
  }

  return cachedE2EUserInfo;
}

interface E2EAuthProviderProps {
  children: ReactNode;
}

/**
 * Mock auth provider for E2E testing.
 * Fetches the real user from backend to ensure correct user IDs.
 */
export function E2EAuthProvider({ children }: E2EAuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Get E2E user info from URL params or use default
  const e2eUserInfo = getE2EUserFromURL() || {
    id: DEFAULT_E2E_USER.id,
    email: DEFAULT_E2E_USER.email,
  };

  // Configure API client and fetch user profile
  useEffect(() => {
    // Configure API client to use E2E headers
    setTokenProvider({
      getToken: async () => null, // No token needed - backend uses E2E headers
      signOut: async () => {
        setUser(null);
      },
      // Custom headers for E2E auth bypass
      e2eHeaders: {
        'x-e2e-user-id': e2eUserInfo.id,
        'x-e2e-user-email': e2eUserInfo.email,
      },
    });

    // Fetch user profile from backend to get real user data
    const fetchUser = async () => {
      try {
        // The /auth/me endpoint returns { user, activeSessions, pushNotificationsEnabled }
        const response = await get<{ user: User }>('/auth/me');
        console.log('[E2EAuthProvider] Fetched user from backend:', response.user?.id);
        setUser(response.user);
      } catch (error) {
        console.warn('[E2EAuthProvider] Failed to fetch user, using default:', error);
        // Fall back to default user but with correct ID from params
        setUser({
          ...DEFAULT_E2E_USER,
          id: e2eUserInfo.id,
          email: e2eUserInfo.email,
        });
      } finally {
        setIsLoading(false);
      }
    };

    fetchUser();
  }, [e2eUserInfo.id, e2eUserInfo.email]);

  const signOut = useCallback(async () => {
    setUser(null);
  }, []);

  const getToken = useCallback(async () => {
    return null; // E2E mode doesn't use tokens
  }, []);

  const updateUser = useCallback((updates: Partial<User>) => {
    setUser((prev) => (prev ? { ...prev, ...updates } : null));
  }, []);

  const authValue: AuthContextValue = {
    user,
    isLoading,
    isAuthenticated: !!user,
    accountProblem: null,
    signOut,
    getToken,
    updateUser,
  };

  return (
    <AuthContext.Provider value={authValue}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Check if E2E mode is enabled
 */
export function isE2EMode(): boolean {
  return process.env.EXPO_PUBLIC_E2E_MODE === 'true';
}
