import { renderHook, waitFor, act } from '@testing-library/react-native';
import {
  useInvitationLink,
  usePendingInvitation,
  getPendingInvitation,
  clearPendingInvitation,
  createInvitationLink,
  useInvitationDetails,
  isInvitationClaimedError,
  isInvitationsDisabledError,
  describeAcceptInvitationError,
  INVITATION_CLAIMED_MESSAGE,
  type InvitationDetails,
} from '../useInvitation';

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';

// Import mocked API
import { get, post, ApiClientError } from '@/src/lib/api';
import { ErrorCode } from '@meet-without-fear/shared';

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

// Mock expo-linking
jest.mock('expo-linking', () => ({
  createURL: jest.fn((path) => `meetwithoutfear://${path}`),
  parse: jest.fn((url) => {
    // Handle meetwithoutfear:// scheme
    if (url.startsWith('meetwithoutfear://')) {
      const path = url.replace('meetwithoutfear://', '');
      return { path, queryParams: {} };
    }
    // Handle https:// scheme
    try {
      const parsed = new URL(url);
      return {
        path: parsed.pathname.slice(1),
        queryParams: Object.fromEntries(parsed.searchParams),
      };
    } catch {
      return { path: '', queryParams: {} };
    }
  }),
  getInitialURL: jest.fn(),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
}));

const mockGetItem = AsyncStorage.getItem as jest.MockedFunction<typeof AsyncStorage.getItem>;
const mockSetItem = AsyncStorage.setItem as jest.MockedFunction<typeof AsyncStorage.setItem>;
const mockRemoveItem = AsyncStorage.removeItem as jest.MockedFunction<typeof AsyncStorage.removeItem>;
const mockGetInitialURL = Linking.getInitialURL as jest.MockedFunction<typeof Linking.getInitialURL>;
const mockAddEventListener = Linking.addEventListener as jest.Mock;
const mockCreateURL = Linking.createURL as jest.MockedFunction<typeof Linking.createURL>;

describe('useInvitationLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetInitialURL.mockResolvedValue(null);
    mockSetItem.mockResolvedValue();
  });

  it('returns null when no invitation URL', async () => {
    const { result } = renderHook(() => useInvitationLink());

    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  it('extracts invitation ID from initial URL', async () => {
    mockGetInitialURL.mockResolvedValue('meetwithoutfear://invitation/abc123');

    const { result } = renderHook(() => useInvitationLink());

    await waitFor(() => {
      expect(result.current).toBe('abc123');
    });

    expect(mockSetItem).toHaveBeenCalledWith('pending_invitation', 'abc123');
  });

  it('handles https URL format', async () => {
    mockGetInitialURL.mockResolvedValue('https://meetwithoutfear.com/invitation/xyz789');

    const { result } = renderHook(() => useInvitationLink());

    await waitFor(() => {
      expect(result.current).toBe('xyz789');
    });
  });

  it('subscribes to URL events', () => {
    renderHook(() => useInvitationLink());

    expect(mockAddEventListener).toHaveBeenCalledWith('url', expect.any(Function));
  });

  it('cleans up URL listener on unmount', () => {
    const removeFn = jest.fn();
    (mockAddEventListener as jest.Mock).mockReturnValue({ remove: removeFn });

    const { unmount } = renderHook(() => useInvitationLink());

    unmount();

    expect(removeFn).toHaveBeenCalled();
  });

  it('handles URL events while running', async () => {
    let urlHandler: (event: { url: string }) => void;
    (mockAddEventListener as jest.Mock).mockImplementation((event: string, handler: (event: { url: string }) => void) => {
      urlHandler = handler;
      return { remove: jest.fn() };
    });

    const { result } = renderHook(() => useInvitationLink());

    // Simulate receiving a URL event
    await act(async () => {
      urlHandler({ url: 'meetwithoutfear://invitation/event123' });
    });

    await waitFor(() => {
      expect(result.current).toBe('event123');
    });
  });
});

describe('usePendingInvitation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItem.mockResolvedValue(null);
    mockRemoveItem.mockResolvedValue();
  });

  it('starts with loading state', () => {
    const { result } = renderHook(() => usePendingInvitation());

    expect(result.current.isLoading).toBe(true);
  });

  it('returns null when no pending invitation', async () => {
    mockGetItem.mockResolvedValue(null);

    const { result } = renderHook(() => usePendingInvitation());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.pendingInvitation).toBeNull();
  });

  it('returns pending invitation from storage', async () => {
    mockGetItem.mockResolvedValue('stored-invitation-id');

    const { result } = renderHook(() => usePendingInvitation());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.pendingInvitation).toBe('stored-invitation-id');
  });

  it('clears invitation when clearInvitation is called', async () => {
    mockGetItem.mockResolvedValue('to-clear-id');

    const { result } = renderHook(() => usePendingInvitation());

    await waitFor(() => {
      expect(result.current.pendingInvitation).toBe('to-clear-id');
    });

    await act(async () => {
      await result.current.clearInvitation();
    });

    expect(mockRemoveItem).toHaveBeenCalledWith('pending_invitation');
    expect(result.current.pendingInvitation).toBeNull();
  });
});

describe('getPendingInvitation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns invitation ID from storage', async () => {
    mockGetItem.mockResolvedValue('invitation-from-storage');

    const result = await getPendingInvitation();

    expect(result).toBe('invitation-from-storage');
    expect(mockGetItem).toHaveBeenCalledWith('pending_invitation');
  });

  it('returns null when no invitation stored', async () => {
    mockGetItem.mockResolvedValue(null);

    const result = await getPendingInvitation();

    expect(result).toBeNull();
  });

  it('handles storage errors gracefully', async () => {
    // Suppress console.error for this test
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetItem.mockRejectedValue(new Error('Storage error'));

    const result = await getPendingInvitation();

    expect(result).toBeNull();
    consoleSpy.mockRestore();
  });
});

describe('clearPendingInvitation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRemoveItem.mockResolvedValue();
  });

  it('removes invitation from storage', async () => {
    await clearPendingInvitation();

    expect(mockRemoveItem).toHaveBeenCalledWith('pending_invitation');
  });

  it('handles storage errors gracefully', async () => {
    // Suppress console.error for this test
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRemoveItem.mockRejectedValue(new Error('Storage error'));

    // Should not throw
    await expect(clearPendingInvitation()).resolves.toBeUndefined();

    consoleSpy.mockRestore();
  });
});

describe('createInvitationLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates invitation link with ID using website URL', () => {
    // createInvitationLink now returns website URLs (not deep links)
    // so recipients can open in browser, sign up, then be redirected to app
    const link = createInvitationLink('my-invitation-123');

    // In test/dev environment, uses localhost
    expect(link).toBe('http://localhost:3001/invitation/my-invitation-123');
    // Note: mockCreateURL is NOT called because we use website URLs now
  });
});

describe('invitation flow integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetItem.mockResolvedValue();
    mockGetItem.mockResolvedValue(null);
    mockRemoveItem.mockResolvedValue();
  });

  it('preserves invitation through auth flow', async () => {
    // 1. User opens app with invitation link
    mockGetInitialURL.mockResolvedValue('meetwithoutfear://invitation/auth-flow-test');

    const { result: linkResult } = renderHook(() => useInvitationLink());

    await waitFor(() => {
      expect(linkResult.current).toBe('auth-flow-test');
    });

    // 2. Invitation is stored
    expect(mockSetItem).toHaveBeenCalledWith('pending_invitation', 'auth-flow-test');

    // 3. After auth completes, retrieve pending invitation
    mockGetItem.mockResolvedValue('auth-flow-test');

    const { result: pendingResult } = renderHook(() => usePendingInvitation());

    await waitFor(() => {
      expect(pendingResult.current.pendingInvitation).toBe('auth-flow-test');
    });

    // 4. After joining session, clear invitation
    await act(async () => {
      await pendingResult.current.clearInvitation();
    });

    expect(mockRemoveItem).toHaveBeenCalledWith('pending_invitation');
  });
});

// Mock API module for useInvitationDetails tests
jest.mock('@/src/lib/api', () => ({
  get: jest.fn(),
  post: jest.fn().mockResolvedValue({}), // Mock post for acknowledge endpoint
  ApiClientError: class ApiClientError extends Error {
    code: string;
    status: number;
    constructor(error: { code: string; message: string }, status: number) {
      super(error.message);
      this.code = error.code;
      this.status = status;
    }
  },
}));

const mockGet = get as jest.MockedFunction<typeof get>;

describe('useInvitationDetails', () => {
  const mockInvitation: InvitationDetails = {
    id: 'test-invitation-id',
    invitedBy: {
      id: 'inviter-id',
      name: 'Test Inviter',
    },
    name: 'Test User',
    status: 'PENDING',
    createdAt: '2024-01-01T00:00:00.000Z',
    expiresAt: '2024-01-08T00:00:00.000Z',
    session: {
      id: 'session-id',
      status: 'INVITED',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts with loading state', () => {
    mockGet.mockImplementation(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useInvitationDetails('test-id'));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.invitation).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('fetches invitation details successfully', async () => {
    mockGet.mockResolvedValue({ invitation: mockInvitation });

    const { result } = renderHook(() => useInvitationDetails('test-id'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.invitation).toEqual(mockInvitation);
    expect(result.current.error).toBeNull();
    expect(result.current.isExpired).toBe(false);
    expect(result.current.isNotFound).toBe(false);
    expect(mockGet).toHaveBeenCalledWith('/v1/invitations/test-id');
  });

  it('detects expired invitation', async () => {
    const expiredInvitation = { ...mockInvitation, status: 'EXPIRED' as const };
    mockGet.mockResolvedValue({ invitation: expiredInvitation });

    const { result } = renderHook(() => useInvitationDetails('expired-id'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isExpired).toBe(true);
    expect(result.current.invitation?.status).toBe('EXPIRED');
  });

  it('handles not found error', async () => {
    const notFoundError = new (ApiClientError as unknown as new (error: { code: string; message: string }, status: number) => Error)(
      { code: ErrorCode.NOT_FOUND, message: 'Not found' },
      404
    );
    Object.assign(notFoundError, { code: ErrorCode.NOT_FOUND });
    mockGet.mockRejectedValue(notFoundError);

    const { result } = renderHook(() => useInvitationDetails('nonexistent-id'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isNotFound).toBe(true);
    expect(result.current.error?.type).toBe('not_found');
    expect(result.current.invitation).toBeNull();
  });

  it('handles network error', async () => {
    const networkError = new (ApiClientError as unknown as new (error: { code: string; message: string }, status: number) => Error)(
      { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'Network error' },
      0
    );
    Object.assign(networkError, { code: ErrorCode.SERVICE_UNAVAILABLE });
    mockGet.mockRejectedValue(networkError);

    const { result } = renderHook(() => useInvitationDetails('network-error-id'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error?.type).toBe('network');
    expect(result.current.isNotFound).toBe(false);
  });

  it('handles null invitation ID', async () => {
    const { result } = renderHook(() => useInvitationDetails(null));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error?.type).toBe('not_found');
    expect(result.current.isNotFound).toBe(true);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('handles undefined invitation ID', async () => {
    const { result } = renderHook(() => useInvitationDetails(undefined));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error?.type).toBe('not_found');
    expect(result.current.isNotFound).toBe(true);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('provides refetch function', async () => {
    mockGet.mockResolvedValue({ invitation: mockInvitation });

    const { result } = renderHook(() => useInvitationDetails('refetch-id'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockGet).toHaveBeenCalledTimes(1);

    // Refetch
    await act(async () => {
      await result.current.refetch();
    });

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('refetches when invitation ID changes', async () => {
    mockGet.mockResolvedValue({ invitation: mockInvitation });

    const { result, rerender } = renderHook(
      ({ id }) => useInvitationDetails(id),
      { initialProps: { id: 'first-id' } }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockGet).toHaveBeenCalledWith('/v1/invitations/first-id');

    // Change the ID
    rerender({ id: 'second-id' });

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/v1/invitations/second-id');
    });

    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('handles accepted invitation status', async () => {
    const acceptedInvitation = { ...mockInvitation, status: 'ACCEPTED' as const };
    mockGet.mockResolvedValue({ invitation: acceptedInvitation });

    const { result } = renderHook(() => useInvitationDetails('accepted-id'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.invitation?.status).toBe('ACCEPTED');
    expect(result.current.isExpired).toBe(false);
  });

  it('handles declined invitation status', async () => {
    const declinedInvitation = { ...mockInvitation, status: 'DECLINED' as const };
    mockGet.mockResolvedValue({ invitation: declinedInvitation });

    const { result } = renderHook(() => useInvitationDetails('declined-id'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.invitation?.status).toBe('DECLINED');
    expect(result.current.isExpired).toBe(false);
  });
  // work-k5fk.10.40: the first signed-in opener claims an invitation; anyone else gets a 403.
  const claimedError = () => {
    const err = new (ApiClientError as unknown as new (error: { code: string; message: string }, status: number) => Error)(
      { code: ErrorCode.FORBIDDEN, message: 'This invitation has already been opened by someone else' },
      403
    );
    return err;
  };

  it('shows the claimed state when someone else opened the invitation first (GET 403)', async () => {
    mockGet.mockRejectedValue(claimedError());

    const { result } = renderHook(() => useInvitationDetails('claimed-id'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isClaimedByOther).toBe(true);
    expect(result.current.error?.type).toBe('claimed');
    expect(result.current.isNotFound).toBe(false);
  });

  it('shows the claimed state when someone else claims it between the fetch and the acknowledge', async () => {
    mockGet.mockResolvedValue({ invitation: mockInvitation });
    (post as jest.Mock).mockRejectedValueOnce(claimedError());

    const { result } = renderHook(() => useInvitationDetails('raced-id'));

    await waitFor(() => {
      expect(result.current.isClaimedByOther).toBe(true);
    });
    expect(post).toHaveBeenCalledWith('/v1/invitations/raced-id/acknowledge', {});
  });

  it('a failed acknowledge for another reason stays silent', async () => {
    mockGet.mockResolvedValue({ invitation: mockInvitation });
    (post as jest.Mock).mockRejectedValueOnce(new Error('network'));

    const { result } = renderHook(() => useInvitationDetails('flaky-id'));

    await waitFor(() => {
      expect(post).toHaveBeenCalled();
    });
    expect(result.current.isClaimedByOther).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

// work-k5fk.35 C3 / C10: which refusal is which, by the API's code, never by the bare status.
describe('invitation refusals', () => {
  const apiError = (code: string, message: string, status: number) =>
    new (ApiClientError as unknown as new (error: { code: string; message: string }, status: number) => Error)(
      { code, message },
      status
    );
  const privacyRefusal = () =>
    apiError(ErrorCode.VALIDATION_ERROR, 'You have disabled session invitations in Privacy settings', 403);

  it('the claimed error is the FORBIDDEN code; the privacy refusal (403 VALIDATION_ERROR) is not it', () => {
    expect(isInvitationClaimedError(apiError(ErrorCode.FORBIDDEN, 'opened by someone else', 403))).toBe(true);
    expect(isInvitationClaimedError(privacyRefusal())).toBe(false);
    expect(isInvitationsDisabledError(privacyRefusal())).toBe(true);
    expect(isInvitationsDisabledError(apiError(ErrorCode.FORBIDDEN, 'opened by someone else', 403))).toBe(false);
    expect(isInvitationClaimedError(new Error('boom'))).toBe(false);
  });

  it('describes each accept refusal, and keeps the pending invitation only for a transient failure', () => {
    expect(describeAcceptInvitationError(apiError(ErrorCode.FORBIDDEN, 'x', 403))).toEqual({
      message: INVITATION_CLAIMED_MESSAGE,
      keepPending: false,
    });
    expect(describeAcceptInvitationError(privacyRefusal())).toEqual({
      message: expect.stringMatching(/Privacy settings/),
      keepPending: false,
    });
    const full = 'This session already has everyone it can seat.';
    expect(describeAcceptInvitationError(apiError(ErrorCode.CONFLICT, full, 409))).toEqual({
      message: full,
      keepPending: false,
    });
    const live = 'You already have a session in progress with this person. Finish or archive it before starting another.';
    expect(describeAcceptInvitationError(apiError(ErrorCode.CONFLICT, live, 409))).toEqual({
      message: live,
      keepPending: false,
    });
    expect(describeAcceptInvitationError(apiError(ErrorCode.SERVICE_UNAVAILABLE, 'Network error', 0))).toEqual({
      message: expect.stringMatching(/try again/i),
      keepPending: true,
    });
    expect(describeAcceptInvitationError(apiError(ErrorCode.INTERNAL_ERROR, 'Failed', 500)).keepPending).toBe(true);
  });
});
