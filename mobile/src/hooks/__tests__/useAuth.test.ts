/**
 * useAuth Hook Tests
 *
 * Tests for the simplified Clerk-first authentication hook.
 */

import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock Clerk
const mockGetToken = jest.fn().mockResolvedValue('mock-token');
const mockSignOut = jest.fn().mockResolvedValue(undefined);
let mockIsSignedIn = true;
let mockIsLoaded = true;
const mockClerkUser = {
  id: 'clerk-user-id',
  emailAddresses: [{ emailAddress: 'test@example.com' }],
  fullName: 'Test User',
  firstName: 'Test',
  lastName: 'User',
  createdAt: new Date(),
};

jest.mock('@clerk/clerk-expo', () => ({
  useAuth: () => ({
    isSignedIn: mockIsSignedIn,
    isLoaded: mockIsLoaded,
    signOut: mockSignOut,
    getToken: mockGetToken,
  }),
  useUser: () => ({
    user: mockIsSignedIn ? mockClerkUser : null,
  }),
}));

// Mock API client
const mockApiGet = jest.fn();
jest.mock('../../lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}));

import { useAuthProvider, useAuth, AuthContext } from '../useAuth';

/**
 * Create a fresh QueryClient for each test
 */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

/**
 * Wrapper that provides QueryClientProvider for hooks that need it
 */
function createQueryClientWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = createTestQueryClient();
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

/**
 * Helper to create a wrapper with AuthContext
 */
function createAuthWrapper(
  authValue: ReturnType<typeof useAuthProvider>
): React.FC<{ children: React.ReactNode }> {
  return ({ children }) =>
    React.createElement(AuthContext.Provider, { value: authValue }, children);
}

describe('useAuthProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSignedIn = true;
    mockIsLoaded = true;
    mockApiGet.mockResolvedValue({
      data: {
        data: {
          user: {
            id: 'backend-user-id',
            email: 'test@example.com',
            name: 'Test User',
            firstName: 'Test',
            lastName: 'User',
            biometricEnabled: false,
            createdAt: new Date().toISOString(),
          },
        },
      },
    });
  });

  describe('initial state', () => {
    it('starts with loading state when Clerk not loaded', () => {
      mockIsLoaded = false;
      const wrapper = createQueryClientWrapper();
      const { result } = renderHook(() => useAuthProvider(), { wrapper });

      expect(result.current.isLoading).toBe(true);
    });

    it('syncs backend profile when signed in', async () => {
      const wrapper = createQueryClientWrapper();
      const { result } = renderHook(() => useAuthProvider(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.user).toBeTruthy();
      expect(result.current.user?.id).toBe('backend-user-id');
      expect(mockApiGet).toHaveBeenCalledWith('/auth/me');
    });

    it('is not authenticated when not signed in', async () => {
      mockIsSignedIn = false;

      const wrapper = createQueryClientWrapper();
      const { result } = renderHook(() => useAuthProvider(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });
  });

  describe('backend sync', () => {
    it('falls back to Clerk user data on API error', async () => {
      mockApiGet.mockRejectedValueOnce(new Error('API Error'));

      const wrapper = createQueryClientWrapper();
      const { result } = renderHook(() => useAuthProvider(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Should still be authenticated with Clerk data
      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.user).toBeTruthy();
      expect(result.current.user?.id).toBe('clerk-user-id');
      expect(result.current.user?.email).toBe('test@example.com');
    });
  });

  // work-k5fk.35 C4: an account the backend refuses must not get a made-up user (the Clerk id as user.id).
  describe.each([
    ['EMAIL_NOT_VERIFIED', 403],
    ['ACCOUNT_LINK_CONFLICT', 409],
    // work-k5fk.34 (platform L3): a verified email the database refuses
    ['EMAIL_NOT_ACCEPTED', 403],
  ])('when /auth/me refuses the account with %s', (code, status) => {
    it('builds no user and reports the account problem', async () => {
      mockApiGet.mockRejectedValueOnce(Object.assign(new Error('refused'), { code, status }));

      const wrapper = createQueryClientWrapper();
      const { result } = renderHook(() => useAuthProvider(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.user).toBeNull();
      expect(result.current.accountProblem).toBe(code);
    });
  });

  it('reports no account problem on a normal sign-in', async () => {
    const wrapper = createQueryClientWrapper();
    const { result } = renderHook(() => useAuthProvider(), { wrapper });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.accountProblem).toBeNull();
  });

  describe('signOut', () => {
    it('calls Clerk signOut and clears user', async () => {
      const wrapper = createQueryClientWrapper();
      const { result } = renderHook(() => useAuthProvider(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.user).toBeTruthy();

      await act(async () => {
        await result.current.signOut();
      });

      expect(mockSignOut).toHaveBeenCalled();
      expect(result.current.user).toBeNull();
    });
  });

  describe('getToken', () => {
    it('delegates to Clerk getToken', async () => {
      const wrapper = createQueryClientWrapper();
      const { result } = renderHook(() => useAuthProvider(), { wrapper });

      const token = await result.current.getToken();

      expect(token).toBe('mock-token');
      expect(mockGetToken).toHaveBeenCalled();
    });
  });
});

describe('useAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSignedIn = true;
    mockIsLoaded = true;
    mockApiGet.mockResolvedValue({
      data: {
        data: {
          user: {
            id: 'backend-user-id',
            email: 'test@example.com',
            name: 'Test User',
            firstName: 'Test',
            lastName: 'User',
            biometricEnabled: false,
            createdAt: new Date().toISOString(),
          },
        },
      },
    });
  });

  it('throws when used outside AuthProvider', () => {
    // Suppress console.error for this test
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useAuth());
    }).toThrow('useAuth must be used within an AuthProvider');

    consoleSpy.mockRestore();
  });

  it('returns context value when inside AuthProvider', async () => {
    const queryWrapper = createQueryClientWrapper();
    const { result: providerResult } = renderHook(() => useAuthProvider(), { wrapper: queryWrapper });

    await waitFor(() => {
      expect(providerResult.current.isLoading).toBe(false);
    });

    const authWrapper = createAuthWrapper(providerResult.current);
    const { result } = renderHook(() => useAuth(), { wrapper: authWrapper });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toBeTruthy();
    expect(typeof result.current.signOut).toBe('function');
    expect(typeof result.current.getToken).toBe('function');
  });
});
