/**
 * work-9309: "Edit first" in the review of a pre-join draft, through the app's
 * real QueryClient:
 *   - it calls the edit-first endpoint (with the device's time zone);
 *   - the review leaves the cache at once and comes back if the call fails
 *     (cache-first: onMutate / onError);
 *   - the AI's opener from the response goes straight into the chat's message
 *     caches (no Ably, no reload), once, and the conversation is refetched.
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider, onlineManager, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import React from 'react';
import { MessageRole, type GetMessagesResponse, type MessageDTO } from '@meet-without-fear/shared';
import * as api from '../../lib/api';
import { createQueryClient } from '../../providers/QueryProvider';
import { useEditPreJoinDraftFirst, stageKeys } from '../useStages';
import { messageKeys } from '../queryKeys';

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
const sessionId = 'session-9309';
const wrapperFor = (client: QueryClient): React.FC<{ children: React.ReactNode }> =>
  function Wrapper({ children }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };

const review = {
  draft: { id: 'd1', content: 'written before the join', readyToShare: true, version: 1, updatedAt: 'x' },
  canConsent: true,
  alreadyConsented: false,
  awaitingPartner: false,
  preJoinReview: { writtenAt: '2026-11-03T09:00:00.000Z', partnerJoinedAt: '2026-11-04T09:00:00.000Z' },
};

const earlier: MessageDTO = {
  id: 'm1',
  sessionId,
  senderId: null,
  role: MessageRole.AI,
  content: 'An earlier reply.',
  stage: 2,
  timestamp: '2026-11-03T09:00:00.000Z',
};
const opener: MessageDTO = {
  id: 'opener-1',
  sessionId,
  senderId: null,
  role: MessageRole.AI,
  content: "Here's what you wrote on Tuesday. Reading it now, what feels different?",
  stage: 2,
  timestamp: '2026-11-07T10:00:00.000Z',
};

const chatOf = (client: QueryClient) =>
  client
    .getQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId))
    ?.pages.flatMap((p) => p.messages);

describe('useEditPreJoinDraftFirst (work-9309)', () => {
  beforeAll(() => onlineManager.setOnline(true));
  beforeEach(() => jest.clearAllMocks());
  // Clear every client so no cache gc timer keeps jest alive.
  const clients: QueryClient[] = [];
  const createClient = () => {
    const client = createQueryClient();
    clients.push(client);
    return client;
  };
  afterEach(() => clients.splice(0).forEach((c) => c.clear()));

  it('ends the review at once, then puts the AI opener in the chat', async () => {
    const client = createClient();
    client.setQueryData(stageKeys.empathyDraft(sessionId), review);
    client.setQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId), {
      pages: [{ messages: [earlier], hasMore: false }],
      pageParams: [undefined],
    });
    let respond!: (v: unknown) => void;
    mockPost.mockImplementationOnce(() => new Promise((r) => (respond = r)));
    const { result } = renderHook(() => useEditPreJoinDraftFirst(), { wrapper: wrapperFor(client) });

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ sessionId });
    });
    await waitFor(() =>
      expect(client.getQueryData<typeof review>(stageKeys.empathyDraft(sessionId))?.preJoinReview).toBeNull(),
    );
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe(`/sessions/${sessionId}/empathy/draft/edit-first`);
    expect(body).toEqual(expect.objectContaining({ timeZone: expect.any(String) }));

    await act(async () => {
      respond({ resolved: true, opener });
      await pending;
    });
    expect(chatOf(client)).toEqual([earlier, opener]);
    expect(client.getQueryData<GetMessagesResponse>(messageKeys.list(sessionId))?.messages).toEqual([opener]);
  });

  it('never adds the opener twice (the response, then the same id again)', async () => {
    const client = createClient();
    client.setQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId), {
      pages: [{ messages: [earlier, opener], hasMore: false }],
      pageParams: [undefined],
    });
    mockPost.mockResolvedValueOnce({ resolved: true, opener });
    const { result } = renderHook(() => useEditPreJoinDraftFirst(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync({ sessionId });
    });
    expect(chatOf(client)).toEqual([earlier, opener]);
  });

  it('adds nothing when the review was already ended (resolved: false)', async () => {
    const client = createClient();
    client.setQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId), {
      pages: [{ messages: [earlier], hasMore: false }],
      pageParams: [undefined],
    });
    mockPost.mockResolvedValueOnce({ resolved: false, opener: null });
    const { result } = renderHook(() => useEditPreJoinDraftFirst(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync({ sessionId });
    });
    expect(chatOf(client)).toEqual([earlier]);
  });

  it('restores the review when the call fails', async () => {
    const client = createClient();
    client.setQueryData(stageKeys.empathyDraft(sessionId), review);
    mockPost.mockRejectedValueOnce(new ApiError({ code: 'VALIDATION_ERROR', message: 'no' }, 400));
    const { result } = renderHook(() => useEditPreJoinDraftFirst(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync({ sessionId }).catch(() => undefined);
    });
    expect(client.getQueryData(stageKeys.empathyDraft(sessionId))).toEqual(review);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});
