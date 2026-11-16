/**
 * useMessages Hook Tests
 *
 * Tests for message-related API hooks including fetching, sending, and emotional barometer.
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  useMessages,
  useInfiniteMessages,
  useEmotionalHistory,
  useRecordEmotion,
  useCompleteExercise,
  messageKeys,
} from '../useMessages';
import { MessageRole, Stage, EmotionalSupportType } from '@meet-without-fear/shared';

// Import mocked functions
import * as api from '../../lib/api';

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

// Sample message data
const mockMessage = {
  id: 'msg-123',
  sessionId: 'session-123',
  senderId: 'user-123',
  role: MessageRole.USER,
  content: 'Test message content',
  stage: Stage.ONBOARDING,
  timestamp: '2024-01-01T00:00:00.000Z',
};

const mockAiMessage = {
  id: 'msg-124',
  sessionId: 'session-123',
  senderId: null,
  role: MessageRole.AI,
  content: 'AI response',
  stage: Stage.ONBOARDING,
  timestamp: '2024-01-01T00:00:01.000Z',
};

const mockEmotionalReading = {
  id: 'emotion-123',
  sessionId: 'session-123',
  userId: 'user-123',
  intensity: 7,
  context: 'Feeling anxious',
  stage: Stage.ONBOARDING,
  timestamp: '2024-01-01T00:00:00.000Z',
};

describe('useMessages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('useMessages hook', () => {
    it('fetches messages for a session', async () => {
      mockGet.mockResolvedValueOnce({
        messages: [mockMessage],
        hasMore: false,
      });

      const { result } = renderHook(
        () => useMessages({ sessionId: 'session-123' }),
        { wrapper: createWrapper() }
      );

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data?.messages).toHaveLength(1);
      expect(result.current.data?.messages[0].content).toBe('Test message content');
      expect(mockGet).toHaveBeenCalledWith('/sessions/session-123/messages');
    });

    it('fetches messages with stage filter', async () => {
      mockGet.mockResolvedValueOnce({
        messages: [mockMessage],
        hasMore: false,
      });

      const { result } = renderHook(
        () => useMessages({ sessionId: 'session-123', stage: Stage.WITNESS }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockGet).toHaveBeenCalledWith('/sessions/session-123/messages?stage=1');
    });

    it('fetches messages with pagination params', async () => {
      mockGet.mockResolvedValueOnce({
        messages: [mockMessage],
        hasMore: true,
        cursor: 'next-cursor',
      });

      const { result } = renderHook(
        () => useMessages({ sessionId: 'session-123', limit: 20, cursor: 'prev-cursor' }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockGet).toHaveBeenCalledWith(
        '/sessions/session-123/messages?limit=20&cursor=prev-cursor'
      );
    });

    it('does not fetch when sessionId is empty', async () => {
      const { result } = renderHook(
        () => useMessages({ sessionId: '' }),
        { wrapper: createWrapper() }
      );

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('useInfiniteMessages hook', () => {
    it('loads the newest page first, then requests the immediately older page before the oldest visible message', async () => {
      mockGet
        .mockResolvedValueOnce({
          messages: [
            { ...mockMessage, id: 'msg-older-visible', seq: 41, timestamp: '2024-01-01T00:00:00.000Z' },
            { ...mockAiMessage, id: 'msg-newest-visible', seq: 42, timestamp: '2024-01-01T00:00:01.000Z' },
          ],
          hasMore: true,
        })
        .mockResolvedValueOnce({
          messages: [
            { ...mockMessage, id: 'msg-older-page', seq: 39, timestamp: '2023-12-31T23:59:58.000Z' },
            { ...mockAiMessage, id: 'msg-newer-in-older-page', seq: 40, timestamp: '2023-12-31T23:59:59.000Z' },
          ],
          hasMore: false,
        });

      const { result } = renderHook(
        () => useInfiniteMessages({ sessionId: 'session-123', limit: 2 }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.fetchNextPage();
      });

      await waitFor(() => {
        expect(result.current.isFetchingNextPage).toBe(false);
      });

      expect(mockGet).toHaveBeenNthCalledWith(
        1,
        '/sessions/session-123/messages?limit=2'
      );
      expect(mockGet).toHaveBeenNthCalledWith(
        2,
        // work-k5fk.4 (review F3): the cursor is the oldest visible message's seq, not its instant
        '/sessions/session-123/messages?limit=2&beforeSeq=41'
      );
    });
  });


  describe('useEmotionalHistory hook', () => {
    it('fetches emotional history for a session', async () => {
      mockGet.mockResolvedValueOnce({
        readings: [mockEmotionalReading],
        averageIntensity: 7,
        trend: 'stable',
      });

      const { result } = renderHook(
        () => useEmotionalHistory({ sessionId: 'session-123' }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expect(result.current.data?.readings).toHaveLength(1);
      expect(result.current.data?.averageIntensity).toBe(7);
      expect(mockGet).toHaveBeenCalledWith('/sessions/session-123/emotions');
    });

    it('fetches emotional history with stage filter', async () => {
      mockGet.mockResolvedValueOnce({
        readings: [],
        averageIntensity: 0,
        trend: 'none',
      });

      const { result } = renderHook(
        () => useEmotionalHistory({ sessionId: 'session-123', stage: Stage.WITNESS }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });

      expect(mockGet).toHaveBeenCalledWith('/sessions/session-123/emotions?stage=1');
    });
  });

  describe('useRecordEmotion hook', () => {
    it('records emotional reading successfully', async () => {
      mockPost.mockResolvedValueOnce({
        reading: mockEmotionalReading,
        offerSupport: false,
        supportType: null,
      });

      const { result } = renderHook(() => useRecordEmotion(), {
        wrapper: createWrapper(),
      });

      const mutationPromise = result.current.mutateAsync({
        sessionId: 'session-123',
        intensity: 7,
        context: 'Feeling anxious',
      });

      await act(async () => {
        await mutationPromise;
      });

      expect(mockPost).toHaveBeenCalledWith('/sessions/session-123/emotions', {
        sessionId: 'session-123',
        intensity: 7,
        context: 'Feeling anxious',
      });
      const mutationResult = await mutationPromise;
      expect(mutationResult.reading.intensity).toBe(7);
    });

    it('receives exercise suggestion for high intensity', async () => {
      mockPost.mockResolvedValueOnce({
        reading: { ...mockEmotionalReading, intensity: 9 },
        offerSupport: true,
        supportType: EmotionalSupportType.BREATHING_EXERCISE,
      });

      const { result } = renderHook(() => useRecordEmotion(), {
        wrapper: createWrapper(),
      });

      const mutationPromise = result.current.mutateAsync({
        sessionId: 'session-123',
        intensity: 9,
        context: 'Very stressed',
      });

      await act(async () => {
        await mutationPromise;
      });

      const mutationResult = await mutationPromise;
      expect(mutationResult.offerSupport).toBe(true);
    });
  });

  describe('useCompleteExercise hook', () => {
    it('completes exercise successfully', async () => {
      mockPost.mockResolvedValueOnce({
        logged: true,
        postExerciseCheckIn: false,
      });

      const { result } = renderHook(() => useCompleteExercise(), {
        wrapper: createWrapper(),
      });

      const mutationPromise = result.current.mutateAsync({
        sessionId: 'session-123',
        exerciseType: EmotionalSupportType.BREATHING_EXERCISE,
        completed: true,
        intensityBefore: 8,
        intensityAfter: 5,
      });

      await act(async () => {
        await mutationPromise;
      });

      expect(mockPost).toHaveBeenCalledWith('/sessions/session-123/exercises/complete', {
        sessionId: 'session-123',
        exerciseType: EmotionalSupportType.BREATHING_EXERCISE,
        completed: true,
        intensityBefore: 8,
        intensityAfter: 5,
      });
      const mutationResult = await mutationPromise;
      expect(mutationResult.logged).toBe(true);
    });
  });


  describe('messageKeys', () => {
    it('generates correct query keys', () => {
      expect(messageKeys.all).toEqual(['messages']);
      expect(messageKeys.lists()).toEqual(['messages', 'list']);
      expect(messageKeys.list('session-123')).toEqual(['messages', 'list', 'session-123', undefined]);
      expect(messageKeys.list('session-123', Stage.WITNESS)).toEqual([
        'messages',
        'list',
        'session-123',
        Stage.WITNESS,
      ]);
      expect(messageKeys.emotions()).toEqual(['messages', 'emotions']);
      expect(messageKeys.emotionHistory('session-123')).toEqual([
        'messages',
        'emotions',
        'session-123',
        undefined,
      ]);
    });
  });
});
