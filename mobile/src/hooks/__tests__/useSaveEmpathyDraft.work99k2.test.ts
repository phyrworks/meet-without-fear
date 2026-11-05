/**
 * work-99k2, through the app's real QueryClient (QueryProvider's retry policy):
 *   - a 4xx mutation is not retried (the solo draft autosave once hammered a
 *     400); a 5xx still is, within the bound;
 *   - the review's explicit save hides the pre-join review optimistically and
 *     restores it when the save fails (cache-first: onMutate / onError);
 *   - an ordinary save leaves a pending review alone and sends no resolve flag.
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider, onlineManager, type QueryClient } from '@tanstack/react-query';
import React from 'react';
import * as api from '../../lib/api';
import { createQueryClient } from '../../providers/QueryProvider';
import { useSaveEmpathyDraft, stageKeys } from '../useStages';

jest.mock('../../lib/api', () => ({
  get: jest.fn(),
  post: jest.fn(),
  del: jest.fn(),
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
jest.mock('../../services/analytics', () => ({ trackError: jest.fn() }));

const mockPost = api.post as jest.MockedFunction<typeof api.post>;
const ApiError = api.ApiClientError as unknown as new (e: { code: string; message: string }, s: number) => Error;
const sessionId = 'session-99k2';
const wrapperFor = (client: QueryClient): React.FC<{ children: React.ReactNode }> =>
  function Wrapper({ children }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };

const review = {
  draft: { id: 'd1', content: 'written before the join', readyToShare: false, version: 1, updatedAt: 'x' },
  canConsent: false,
  alreadyConsented: false,
  awaitingPartner: false,
  preJoinReview: { writtenAt: '2026-11-03T09:00:00.000Z', partnerJoinedAt: '2026-11-04T09:00:00.000Z' },
};

describe('useSaveEmpathyDraft with the app QueryClient (work-99k2)', () => {
  // offlineFirst pauses a retry while offline; the test environment is online.
  beforeAll(() => onlineManager.setOnline(true));
  beforeEach(() => jest.clearAllMocks());

  it('does not retry a 400', async () => {
    mockPost.mockRejectedValue(new ApiError({ code: 'VALIDATION_ERROR', message: 'no' }, 400));
    const { result } = renderHook(() => useSaveEmpathyDraft(), { wrapper: wrapperFor(createQueryClient()) });
    await act(async () => {
      await result.current.mutateAsync({ sessionId, content: 'x' }).catch(() => undefined);
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 once', async () => {
    mockPost
      .mockRejectedValueOnce(new ApiError({ code: 'SERVICE_UNAVAILABLE', message: 'down' }, 503))
      .mockResolvedValueOnce({ draftId: 'd1', savedAt: 'x', readyToShare: false });
    const { result } = renderHook(() => useSaveEmpathyDraft(), { wrapper: wrapperFor(createQueryClient()) });
    await act(async () => {
      await result.current.mutateAsync({ sessionId, content: 'x' });
    });
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('the review choice hides the review at once and restores it if the save fails', async () => {
    const client = createQueryClient();
    client.setQueryData(stageKeys.empathyDraft(sessionId), review);
    let fail!: (e: Error) => void;
    mockPost.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const { result } = renderHook(() => useSaveEmpathyDraft(), { wrapper: wrapperFor(client) });

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current
        .mutateAsync({ sessionId, content: review.draft.content, readyToShare: false, resolvePreJoinReview: true })
        .catch(() => undefined);
    });
    await waitFor(() =>
      expect(client.getQueryData<typeof review>(stageKeys.empathyDraft(sessionId))?.preJoinReview).toBeNull(),
    );
    expect(mockPost).toHaveBeenCalledWith(`/sessions/${sessionId}/empathy/draft`, {
      content: review.draft.content,
      readyToShare: false,
      resolvePreJoinReview: true,
    });
    await act(async () => {
      fail(new ApiError({ code: 'VALIDATION_ERROR', message: 'no' }, 400));
      await pending;
    });
    expect(client.getQueryData(stageKeys.empathyDraft(sessionId))).toEqual(review);
  });

  it('an ordinary save leaves a pending review in the cache and sends no resolve flag', async () => {
    const client = createQueryClient();
    client.setQueryData(stageKeys.empathyDraft(sessionId), review);
    const { result } = renderHook(() => useSaveEmpathyDraft(), { wrapper: wrapperFor(client) });
    let seen: unknown;
    // What the cache holds while the request is in flight (after onMutate).
    mockPost.mockImplementationOnce(async () => {
      seen = client.getQueryData(stageKeys.empathyDraft(sessionId));
      return { draftId: 'd1', savedAt: 'x', readyToShare: false };
    });
    await act(async () => {
      await result.current.mutateAsync({ sessionId, content: 'an AI proposal' });
    });
    expect(mockPost).toHaveBeenLastCalledWith(`/sessions/${sessionId}/empathy/draft`, {
      content: 'an AI proposal',
      readyToShare: undefined,
    });
    expect(seen).toMatchObject({
      preJoinReview: review.preJoinReview,
    });
  });
});
