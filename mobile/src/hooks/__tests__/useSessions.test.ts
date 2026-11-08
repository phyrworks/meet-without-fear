/**
 * useSessions Hook Tests
 *
 * Tests for session-related API hooks including fetching, creating, and managing sessions.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  useSessions,
  useSession,
  useCreateSession,
  usePauseSession,
  useResumeSession,
  useInvitation,
  useAcceptInvitation,
  useDeclineInvitation,
  useConfirmInvitationMessage,
  useMarkSharedContextViewed,
  sessionKeys,
} from '../useSessions';
import { SessionStatus, StageStatus } from '@meet-without-fear/shared';

// Import mocked functions
import * as api from '../../lib/api';
import { stageKeys } from '../queryKeys';

// Mock the API module
jest.mock('../../lib/api', () => ({
  get: jest.fn(),
  post: jest.fn(),
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

const mockGet = api.get as jest.MockedFunction<typeof api.get>;
const mockPost = api.post as jest.MockedFunction<typeof api.post>;

// Create a wrapper with QueryClient
function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

function createWrapperWithClient(queryClient: QueryClient): React.FC<{ children: React.ReactNode }> {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

// Sample session data
const mockSessionSummary = {
  id: 'session-123',
  status: SessionStatus.ACTIVE,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  topic: 'Test topic',
  partner: {
    id: 'user-456',
    name: 'Partner Name',
    email: 'partner@example.com',
  },
};

const mockSessionDetail = {
  ...mockSessionSummary,
  currentStage: 0,
  messages: [],
  participants: [],
};

describe('useSessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('useSessions hook', () => {
    it('fetches sessions list successfully', async () => {
      mockGet.mockResolvedValueOnce({
        items: [mockSessionSummary],
        hasMore: false,
        cursor: null,
      });

      const { result } = renderHook(() => useSessions(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data?.items).toHaveLength(1);
      expect(result.current.data?.items[0].id).toBe('session-123');
      expect(mockGet).toHaveBeenCalledWith('/sessions');
    });

    it('fetches sessions with status filter', async () => {
      mockGet.mockResolvedValueOnce({
        items: [mockSessionSummary],
        hasMore: false,
        cursor: null,
      });

      const { result } = renderHook(() => useSessions({ status: SessionStatus.ACTIVE }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockGet).toHaveBeenCalledWith('/sessions?status=ACTIVE');
    });

    it('fetches sessions with limit and cursor', async () => {
      mockGet.mockResolvedValueOnce({
        items: [mockSessionSummary],
        hasMore: true,
        cursor: 'next-cursor',
      });

      const { result } = renderHook(() => useSessions({ limit: 10, cursor: 'prev-cursor' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockGet).toHaveBeenCalledWith('/sessions?limit=10&cursor=prev-cursor');
    });

    it('handles error state', async () => {
      const error = new (api.ApiClientError as any)(
        { code: 'INTERNAL_ERROR', message: 'Server error' },
        500
      );
      mockGet.mockRejectedValueOnce(error);

      const { result } = renderHook(() => useSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect(result.current.error?.message).toBe('Server error');
    });
  });

  describe('useSession hook', () => {
    it('fetches single session by ID', async () => {
      mockGet.mockResolvedValueOnce({ session: mockSessionDetail });

      const { result } = renderHook(() => useSession('session-123'), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data?.session.id).toBe('session-123');
      expect(mockGet).toHaveBeenCalledWith('/sessions/session-123');
    });

    it('does not fetch when sessionId is undefined', async () => {
      const { result } = renderHook(() => useSession(undefined), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.fetchStatus).toBe('idle');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('handles 404 error', async () => {
      const error = new (api.ApiClientError as any)(
        { code: 'NOT_FOUND', message: 'Session not found' },
        404
      );
      mockGet.mockRejectedValueOnce(error);

      const { result } = renderHook(() => useSession('nonexistent-id'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect(result.current.error?.message).toBe('Session not found');
    });
  });

  describe('useCreateSession hook', () => {
    it('creates session successfully', async () => {
      const responseData = {
        session: mockSessionDetail,
        invitationId: 'inv-123',
        invitationUrl: 'https://example.com/invite/inv-123',
      };
      mockPost.mockResolvedValueOnce(responseData);

      const { result } = renderHook(() => useCreateSession(), {
        wrapper: createWrapper(),
      });

      const mutationPromise = result.current.mutateAsync({
        inviteEmail: 'partner@example.com',
        context: 'New topic',
      });
      await act(async () => {
        await mutationPromise;
      });

      expect(mockPost).toHaveBeenCalledWith('/sessions', {
        inviteEmail: 'partner@example.com',
        context: 'New topic',
      });
      const mutationResult = await mutationPromise;
      expect(mutationResult.session.id).toBe('session-123');
    });

    it('handles validation error', async () => {
      const error = new (api.ApiClientError as any)(
        { code: 'VALIDATION_ERROR', message: 'Must provide personId, inviteEmail, or invitePhone' },
        400
      );
      mockPost.mockRejectedValueOnce(error);

      const { result } = renderHook(() => useCreateSession(), {
        wrapper: createWrapper(),
      });

      let caughtError: Error | undefined;
      await act(async () => {
        try {
          await result.current.mutateAsync({
            context: 'Some context',
          });
        } catch (e) {
          caughtError = e as Error;
        }
      });

      expect(caughtError?.message).toBe('Must provide personId, inviteEmail, or invitePhone');
    });
  });

  describe('usePauseSession hook', () => {
    it('pauses session successfully', async () => {
      const responseData = { paused: true, pausedAt: '2024-01-01T12:00:00.000Z' };
      mockPost.mockResolvedValueOnce(responseData);

      const { result } = renderHook(() => usePauseSession(), {
        wrapper: createWrapper(),
      });

      let mutationResult: typeof responseData | undefined;
      await act(async () => {
        mutationResult = await result.current.mutateAsync({ sessionId: 'session-123', reason: 'Need a break' });
      });

      expect(mockPost).toHaveBeenCalledWith('/sessions/session-123/pause', {
        reason: 'Need a break',
      });
      expect(mutationResult?.paused).toBe(true);
    });
  });

  describe('useResumeSession hook', () => {
    it('resumes session successfully', async () => {
      const responseData = { resumed: true, resumedAt: '2024-01-01T14:00:00.000Z' };
      mockPost.mockResolvedValueOnce(responseData);

      const { result } = renderHook(() => useResumeSession(), {
        wrapper: createWrapper(),
      });

      let mutationResult: typeof responseData | undefined;
      await act(async () => {
        mutationResult = await result.current.mutateAsync({ sessionId: 'session-123' });
      });

      expect(mockPost).toHaveBeenCalledWith('/sessions/session-123/resume');
      expect(mutationResult?.resumed).toBe(true);
    });
  });

  describe('useInvitation hook', () => {
    it('fetches invitation by ID', async () => {
      mockGet.mockResolvedValueOnce({
        invitation: {
          id: 'inv-123',
          sessionId: 'session-123',
          status: 'PENDING',
          expiresAt: '2024-01-02T00:00:00.000Z',
        },
      });

      const { result } = renderHook(() => useInvitation('inv-123'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expect(result.current.data?.invitation.id).toBe('inv-123');
      expect(mockGet).toHaveBeenCalledWith('/invitations/inv-123');
    });

    it('does not fetch when invitationId is undefined', async () => {
      const { result } = renderHook(() => useInvitation(undefined), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('useAcceptInvitation hook', () => {
    it('accepts invitation successfully', async () => {
      const responseData = { session: mockSessionDetail };
      mockPost.mockResolvedValueOnce(responseData);

      const { result } = renderHook(() => useAcceptInvitation(), {
        wrapper: createWrapper(),
      });

      const mutationPromise = result.current.mutateAsync({ invitationId: 'inv-123' });
      await act(async () => {
        await mutationPromise;
      });

      expect(mockPost).toHaveBeenCalledWith('/invitations/inv-123/accept');
      const mutationResult = await mutationPromise;
      expect(mutationResult.session.id).toBe('session-123');
    });
  });

  describe('useDeclineInvitation hook', () => {
    it('declines invitation with reason', async () => {
      const responseData = { declined: true, declinedAt: '2024-01-01T00:00:00.000Z' };
      mockPost.mockResolvedValueOnce(responseData);

      const { result } = renderHook(() => useDeclineInvitation(), {
        wrapper: createWrapper(),
      });

      let mutationResult: typeof responseData | undefined;
      await act(async () => {
        mutationResult = await result.current.mutateAsync({
          invitationId: 'inv-123',
          reason: 'Not available',
        });
      });

      expect(mockPost).toHaveBeenCalledWith('/invitations/inv-123/decline', {
        reason: 'Not available',
      });
      expect(mutationResult?.declined).toBe(true);
    });

    it('declines invitation without reason', async () => {
      mockPost.mockResolvedValueOnce({ declined: true, declinedAt: '2024-01-01T00:00:00.000Z' });

      const { result } = renderHook(() => useDeclineInvitation(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.mutateAsync({ invitationId: 'inv-123' });
      });

      expect(mockPost).toHaveBeenCalledWith('/invitations/inv-123/decline', {
        reason: undefined,
      });
    });
  });

  describe('useConfirmInvitationMessage hook', () => {
    it('updates cached session status to INVITED when invitation confirmation advances to witness', async () => {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
          },
        },
      });

      queryClient.setQueryData(sessionKeys.state('session-123'), {
        session: {
          id: 'session-123',
          status: SessionStatus.CREATED,
          currentStage: 0,
          stageStatus: StageStatus.IN_PROGRESS,
          relationshipId: 'relationship-123',
          partner: { id: 'user-456', name: 'Partner', nickname: null },
          myProgress: { stage: 0, status: StageStatus.IN_PROGRESS },
          createdAt: '2024-01-01T00:00:00.000Z',
          resolvedAt: null,
          lastViewedAt: null,
          partnerLastViewedAt: null,
          partnerLastActiveAt: null,
          lastSeenChatItemId: null,
          sourceInnerThoughts: null,
        },
        progress: {
          sessionId: 'session-123',
          myProgress: {
            stage: 0,
            status: StageStatus.IN_PROGRESS,
            startedAt: null,
            completedAt: null,
            milestones: {},
          },
          partnerProgress: {
            stage: 0,
            status: StageStatus.IN_PROGRESS,
            startedAt: null,
            completedAt: null,
          },
          canAdvance: false,
          witnessStartedAt: null,
        },
        messages: [],
        invitation: {
          id: 'inv-123',
          messageConfirmed: false,
          messageConfirmedAt: null,
          topicFrame: 'house chores',
        },
        compact: null,
      });

      mockPost.mockResolvedValueOnce({
        confirmed: true,
        invitation: {
          id: 'inv-123',
          messageConfirmed: true,
          messageConfirmedAt: '2024-01-01T00:01:00.000Z',
          topicFrame: 'house chores',
        },
        advancedToStage: 1,
      });

      const { result } = renderHook(() => useConfirmInvitationMessage(), {
        wrapper: createWrapperWithClient(queryClient),
      });

      await act(async () => {
        await result.current.mutateAsync({ sessionId: 'session-123' });
      });

      expect(mockPost).toHaveBeenCalledWith('/sessions/session-123/invitation/confirm', {});
      expect(queryClient.getQueryData<any>(sessionKeys.state('session-123'))?.session.status)
        .toBe(SessionStatus.INVITED);
    });
  });

  describe('sessionKeys', () => {
    it('generates correct query keys', () => {
      expect(sessionKeys.all).toEqual(['sessions']);
      expect(sessionKeys.lists()).toEqual(['sessions', 'list']);
      expect(sessionKeys.list({ status: SessionStatus.ACTIVE })).toEqual([
        'sessions',
        'list',
        { status: SessionStatus.ACTIVE },
      ]);
      expect(sessionKeys.details()).toEqual(['sessions', 'detail']);
      expect(sessionKeys.detail('session-123')).toEqual(['sessions', 'detail', 'session-123']);
      expect(sessionKeys.invitations()).toEqual(['invitations']);
      expect(sessionKeys.invitation('inv-123')).toEqual(['invitations', 'inv-123']);
    });
  });
});

describe('useMarkSharedContextViewed (work-2doq)', () => {
  const SESSION = 'session-123';
  const MESSAGE = '019a5f3e-1c2d-7a00-8b00-000000000001';
  const SHARED_AT = '2026-11-07T12:00:00.000Z';
  const status = { hasUnviewedSharedContext: true, sharedContext: { content: 'x', sharedAt: SHARED_AT } };
  const actions = {
    actions: [
      { type: 'context_received', id: MESSAGE, data: { timestamp: SHARED_AT } },
      { type: 'context_received', id: 'newer', data: { timestamp: '2026-11-07T12:05:00.000Z' } },
      { type: 'share_offer', id: 'offer', data: {} },
    ],
  };

  const setup = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(stageKeys.empathyStatus(SESSION), status);
    queryClient.setQueryData(stageKeys.pendingActions(SESSION), actions);
    const { result } = renderHook(() => useMarkSharedContextViewed(SESSION), {
      wrapper: createWrapperWithClient(queryClient),
    });
    return { queryClient, result };
  };

  beforeEach(() => jest.clearAllMocks());

  it('posts the viewed frame and clears unviewed context optimistically', async () => {
    mockPost.mockResolvedValueOnce({ success: true, advanced: true, lastViewedSharedContextAt: SHARED_AT });
    const { queryClient, result } = setup();
    await act(async () => {
      result.current.mutate({ messageId: MESSAGE, timestamp: SHARED_AT });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith(`/sessions/${SESSION}/shared-context-viewed`, { messageId: MESSAGE });
    expect(queryClient.getQueryData<typeof status>(stageKeys.empathyStatus(SESSION))?.hasUnviewedSharedContext).toBe(false);
    expect(
      queryClient.getQueryData<typeof actions>(stageKeys.pendingActions(SESSION))?.actions.map((a) => a.id),
    ).toEqual(['newer', 'offer']);
  });

  it('keeps unviewed context when the viewed frame is older than the newest delivered one', async () => {
    mockPost.mockResolvedValueOnce({ success: true, advanced: true, lastViewedSharedContextAt: SHARED_AT });
    const { queryClient, result } = setup();
    await act(async () => {
      result.current.mutate({ messageId: MESSAGE, timestamp: '2026-11-07T11:00:00.000Z' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<typeof status>(stageKeys.empathyStatus(SESSION))?.hasUnviewedSharedContext).toBe(true);
  });

  it('rolls the optimistic write back on error', async () => {
    mockPost.mockRejectedValueOnce(new Error('network'));
    const { queryClient, result } = setup();
    await act(async () => {
      result.current.mutate({ messageId: MESSAGE, timestamp: SHARED_AT });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(stageKeys.empathyStatus(SESSION))).toEqual(status);
    expect(queryClient.getQueryData(stageKeys.pendingActions(SESSION))).toEqual(actions);
  });
});
