/**
 * HomeScreen Tests
 *
 * Tests for the simplified home screen with greeting and quick actions.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import HomeScreen from '../index';
import { SessionSummaryDTO, SessionStatus, Stage, StageStatus } from '@meet-without-fear/shared';

// Mock expo-router
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Mock lucide-react-native
jest.mock('lucide-react-native', () => ({
  ArrowRight: () => 'ArrowRightIcon',
  ArrowUp: () => 'ArrowUpIcon',
  Plus: () => 'PlusIcon',
  Heart: () => 'HeartIcon',
  UserPlus: () => 'UserPlusIcon',
  Layers: () => 'LayersIcon',
  Menu: () => 'MenuIcon',
  Settings: () => 'SettingsIcon',
}));

// Mock useSessions hook
const mockUseSessions = jest.fn();
const mockAcceptInvitation = jest.fn();
jest.mock('../../../../src/hooks/useSessions', () => ({
  useSessions: () => mockUseSessions(),
  useAcceptInvitation: (options) => {
    mockAcceptInvitation.mockImplementation((params) => {
      // Simulate successful acceptance
      options.onSuccess?.({ session: { id: 'accepted-session' } });
    });
    return {
      mutate: mockAcceptInvitation,
      isPending: false,
    };
  },
}));

jest.mock('@/src/hooks/useUnreadSessionCount', () => ({
  useUnreadSessionCount: () => ({ count: 0, isLoading: false }),
}));

// Mock useAuth hook
const mockUseAuth = jest.fn();
jest.mock('@/src/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

// Mock useBiometricAuth, usePendingInvitation, and useCreateInnerThoughtsSession hooks to prevent async state updates
const mockUsePendingInvitation = jest.fn();
const mockCreateInnerThoughts = jest.fn();
const mockOpenDrawer = jest.fn();
jest.mock('@/src/hooks', () => ({
  useBiometricAuth: () => ({
    isAvailable: false,
    isEnrolled: false,
    isEnabled: false,
    isLoading: false,
    biometricType: null,
    biometricName: null,
    hasPrompted: true, // Already prompted, so no async effects
    error: null,
    checkAvailability: jest.fn(),
    authenticate: jest.fn(),
    enableBiometric: jest.fn(),
    disableBiometric: jest.fn(),
    markPrompted: jest.fn(),
    refresh: jest.fn(),
  }),
  usePendingInvitation: () => mockUsePendingInvitation(),
  useCreateInnerThoughtsSession: () => ({
    mutate: mockCreateInnerThoughts,
    isPending: false,
  }),
  useSessionDrawer: () => ({
    openDrawer: mockOpenDrawer,
  }),
  useUnreadSessionCount: () => ({
    count: 0,
  }),
}));

// Mock useInvitationDetails hook
const mockUseInvitationDetails = jest.fn();
jest.mock('@/src/hooks/useInvitation', () => ({
  useInvitationDetails: () => mockUseInvitationDetails(),
}));

// Mock components that may have dependencies
jest.mock('../../../../src/components', () => ({
  BiometricPrompt: ({ visible, testID }) => {
    const { View, Text } = require('react-native');
    if (!visible) return null;
    return (
      <View testID={testID || 'biometric-prompt'}>
        <Text>Biometric Prompt</Text>
      </View>
    );
  },
  Logo: () => null,
  ChatInput: ({ onSend, placeholder, testID }) => {
    const { View, TextInput, TouchableOpacity, Text } = require('react-native');
    return (
      <View testID={testID || 'chat-input'}>
        <TextInput placeholder={placeholder} testID="chat-input-field" />
        <TouchableOpacity onPress={() => onSend?.('test message')} testID="chat-input-send">
          <Text>Send</Text>
        </TouchableOpacity>
      </View>
    );
  },
  SessionDrawer: ({ children }) => children,
}));

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }) => children,
}));

// Helper to create mock session
function createMockSession(overrides: Partial<SessionSummaryDTO> = {}): SessionSummaryDTO {
  return {
    id: 'session-1',
    relationshipId: 'rel-1',
    status: SessionStatus.ACTIVE,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    partner: {
      id: 'user-2',
      name: 'Jane Doe',
      nickname: 'Jane',
    },
    myProgress: {
      stage: Stage.WITNESS,
      status: StageStatus.IN_PROGRESS,
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: null,
    },
    partnerProgress: {
      stage: Stage.WITNESS,
      status: StageStatus.IN_PROGRESS,
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: null,
    },
    statusSummary: {
      userStatus: 'Working on The Witness',
      partnerStatus: 'Jane is also working',
    },
    selfActionNeeded: [],
    partnerActionNeeded: [],
    hasUnread: false,
    lastViewedAt: '2024-01-02T00:00:00Z',
    lastSeenChatItemId: null,
    ...overrides,
  };
}

function renderWithProviders(component: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {component}
    </QueryClientProvider>
  );
}

describe('HomeScreen', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    // Local time, not an offset: the greeting reads local getHours(), so a fixed
    // offset made this pass only in UTC-7 (a UTC runner read "Good afternoon").
    jest.setSystemTime(new Date(2026, 4, 9, 9, 0, 0));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    mockPush.mockClear();
    mockUseSessions.mockClear();
    mockUseAuth.mockClear();
    mockUsePendingInvitation.mockClear();
    mockUseInvitationDetails.mockClear();
    mockAcceptInvitation.mockClear();

    // Default auth state - logged in user
    mockUseAuth.mockReturnValue({
      user: { id: 'user-1', name: 'Test User', firstName: 'Test', email: 'test@example.com' },
      isAuthenticated: true,
      isLoading: false,
    });

    // Default pending invitation state - no pending invitation
    mockUsePendingInvitation.mockReturnValue({
      pendingInvitation: null,
      isLoading: false,
      clearInvitation: jest.fn(),
    });

    // Default invitation details state - no invitation
    mockUseInvitationDetails.mockReturnValue({
      invitation: null,
      isLoading: false,
      error: null,
      isExpired: false,
      isNotFound: false,
      refetch: jest.fn(),
    });
  });

  it('shows loading state while fetching sessions', () => {
    mockUseSessions.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows loading state while auth is loading', () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isAuthenticated: false,
      isLoading: true,
    });
    mockUseSessions.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('shows greeting with user name', () => {
    mockUseSessions.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.getByText('Good morning, Test')).toBeTruthy();
  });

  it('shows main question', () => {
    mockUseSessions.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.getByText('What would you like to work through?')).toBeTruthy();
  });

  it('shows New Conversation and Inner Thoughts entry points', () => {
    mockUseSessions.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.getByText('New conversation')).toBeTruthy();
    expect(screen.getByText('Inner thoughts')).toBeTruthy();
  });

  it('shows Continue button when there is a recent session with partner nickname', () => {
    const session = createMockSession({
      id: 'session-1',
      partner: { id: 'user-2', name: 'Jane Doe', nickname: 'Jane' },
    });

    mockUseSessions.mockReturnValue({
      data: { items: [session], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.getByLabelText('Continue with Jane')).toBeTruthy();
  });

  it('uses partner name when nickname is not available', () => {
    const session = createMockSession({
      id: 'session-1',
      partner: { id: 'user-2', name: 'Jane Doe', nickname: null },
    });

    mockUseSessions.mockReturnValue({
      data: { items: [session], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.getByLabelText('Continue with Jane Doe')).toBeTruthy();
  });

  it('does not show Continue button when no sessions exist', () => {
    mockUseSessions.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.queryByText(/Continue with/)).toBeNull();
  });

  it('navigates to new session screen when New Session pressed', () => {
    mockUseSessions.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    fireEvent.press(screen.getByLabelText('Start new session'));

    expect(mockPush).toHaveBeenCalledWith('/session/new');
  });

  it('navigates to session when Continue pressed', () => {
    const session = createMockSession({
      id: 'recent-session',
      partner: { id: 'user-2', name: 'Jane', nickname: 'Jane' },
    });

    mockUseSessions.mockReturnValue({
      data: { items: [session], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    fireEvent.press(screen.getByLabelText('Continue with Jane'));

    expect(mockPush).toHaveBeenCalledWith('/session/recent-session');
  });

  it('routes home composer directly into a new inner thoughts session', () => {
    const session = createMockSession({
      id: 'recent-session',
      partner: { id: 'user-2', name: 'Jane', nickname: 'Jane' },
    });

    mockUseSessions.mockReturnValue({
      data: { items: [session], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    fireEvent.changeText(screen.getByPlaceholderText("What's on your mind?"), 'I feel stuck');
    fireEvent.press(screen.getByLabelText('Send'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/inner-work/self-reflection/[id]',
      params: {
        id: 'new',
        initialMessage: 'I feel stuck',
      },
    });
  });

  it('shows the most recently updated session for Continue button', () => {
    const olderSession = createMockSession({
      id: 'older-session',
      partner: { id: 'user-2', name: 'Older Partner', nickname: 'Old' },
      updatedAt: '2024-01-01T00:00:00Z',
    });
    const newerSession = createMockSession({
      id: 'newer-session',
      partner: { id: 'user-3', name: 'Newer Partner', nickname: 'New' },
      updatedAt: '2024-01-03T00:00:00Z',
    });

    mockUseSessions.mockReturnValue({
      data: { items: [olderSession, newerSession], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    // Should show the newer session's partner
    expect(screen.getByLabelText('Continue with New')).toBeTruthy();
    expect(screen.queryByLabelText('Continue with Old')).toBeNull();
  });

  it('does not show biometric prompt when already prompted', () => {
    mockUseSessions.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
    });

    renderWithProviders(<HomeScreen />);

    // Biometric prompt should not be visible since hasPrompted is true
    expect(screen.queryByTestId('biometric-prompt')).toBeNull();
  });

  it('shows Accept invitation button when there is a pending invitation', () => {
    mockUseSessions.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
    });
    mockUsePendingInvitation.mockReturnValue({
      pendingInvitation: 'invite-123',
      isLoading: false,
      clearInvitation: jest.fn(),
    });
    mockUseInvitationDetails.mockReturnValue({
      invitation: {
        id: 'invite-123',
        invitedBy: { id: 'user-2', name: 'Jane' },
        status: 'PENDING',
        createdAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-08T00:00:00Z',
        name: null,
        session: { id: 'session-1', status: 'CREATED' },
      },
      isLoading: false,
      error: null,
      isExpired: false,
      isNotFound: false,
      refetch: jest.fn(),
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.getByText("Accept Jane's invitation")).toBeTruthy();
  });

  it('does not show Continue button when there is a pending invitation', () => {
    const session = createMockSession({
      id: 'session-1',
      partner: { id: 'user-2', name: 'Bob', nickname: 'Bob' },
    });

    mockUseSessions.mockReturnValue({
      data: { items: [session], hasMore: false },
      isLoading: false,
    });
    mockUsePendingInvitation.mockReturnValue({
      pendingInvitation: 'invite-123',
      isLoading: false,
      clearInvitation: jest.fn(),
    });
    mockUseInvitationDetails.mockReturnValue({
      invitation: {
        id: 'invite-123',
        invitedBy: { id: 'user-3', name: 'Jane' },
        status: 'PENDING',
        createdAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-08T00:00:00Z',
        name: null,
        session: { id: 'session-2', status: 'CREATED' },
      },
      isLoading: false,
      error: null,
      isExpired: false,
      isNotFound: false,
      refetch: jest.fn(),
    });

    renderWithProviders(<HomeScreen />);

    // Accept invitation should show, Continue should not
    expect(screen.getByText("Accept Jane's invitation")).toBeTruthy();
    expect(screen.queryByText('Continue with Bob')).toBeNull();
  });

  it('does not show Accept invitation when invitation is not PENDING', () => {
    mockUseSessions.mockReturnValue({
      data: { items: [], hasMore: false },
      isLoading: false,
    });
    mockUsePendingInvitation.mockReturnValue({
      pendingInvitation: 'invite-123',
      isLoading: false,
      clearInvitation: jest.fn(),
    });
    mockUseInvitationDetails.mockReturnValue({
      invitation: {
        id: 'invite-123',
        invitedBy: { id: 'user-2', name: 'Jane' },
        status: 'ACCEPTED', // Already accepted
        createdAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-08T00:00:00Z',
        name: null,
        session: { id: 'session-1', status: 'ACTIVE' },
      },
      isLoading: false,
      error: null,
      isExpired: false,
      isNotFound: false,
      refetch: jest.fn(),
    });

    renderWithProviders(<HomeScreen />);

    expect(screen.queryByText(/Accept.*invitation/)).toBeNull();
  });
});
