/**
 * work-9309: "Edit first" in the review of a pre-join draft, through the app's
 * real QueryClient:
 *   - it calls the edit-first endpoint (with the device's time zone);
 *   - the review leaves the cache at once and the reopen begins (the old
 *     draft's panel hides: awaitingRevision), rolled back if the call fails
 *     (cache-first: onMutate / onError);
 *   - the opener is generated in the background (202): the client refetches the
 *     conversation, bounded, until the first AI message at or after `reopenedAt` is there (no Ably,
 *     no reload); a retry's opener goes into the chat once.
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider, onlineManager, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import React from 'react';
import { MessageRole, type GetMessagesResponse, type MessageDTO } from '@meet-without-fear/shared';
import * as api from '../../lib/api';
import { createQueryClient } from '../../providers/QueryProvider';
import {
  useEditPreJoinDraftFirst,
  awaitEditFirstOpener,
  cancelEditFirstOpenerWait,
  mergeEmpathyDraftFromServer,
  EDIT_FIRST_OPENER_POLL,
  stageKeys,
} from '../useStages';
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
const mockGet = api.get as jest.MockedFunction<typeof api.get>;
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

  const withChat = (client: QueryClient, messages: MessageDTO[]) =>
    client.setQueryData<InfiniteData<GetMessagesResponse>>(messageKeys.infinite(sessionId), {
      pages: [{ messages, hasMore: false }],
      pageParams: [undefined],
    });
  const reopenedAt = '2026-11-07T09:59:59.000Z'; // the marker: the opener lands at or after it
  const activeInfinite = { queryKey: messageKeys.infinite(sessionId), type: 'active' };

  it('ends the review and hides the old draft at once; the 202 opener then arrives through the refetch', async () => {
    EDIT_FIRST_OPENER_POLL.intervalMs = 10;
    EDIT_FIRST_OPENER_POLL.attempts = 20;
    const client = createClient();
    client.setQueryData(stageKeys.empathyDraft(sessionId), review);
    withChat(client, [earlier]);
    // The test caches have no queryFn: a real refetch would retry; the call itself is what is asserted.
    const refetch = jest.spyOn(client, 'refetchQueries').mockResolvedValue(undefined);
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    let respond!: (v: unknown) => void;
    mockPost.mockImplementationOnce(() => new Promise((r) => (respond = r)));
    const { result } = renderHook(() => useEditPreJoinDraftFirst(), { wrapper: wrapperFor(client) });

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ sessionId });
    });
    // Optimistic: the review is gone and the reopen is in effect (panel hidden).
    await waitFor(() =>
      expect(client.getQueryData<typeof review>(stageKeys.empathyDraft(sessionId))).toMatchObject({
        preJoinReview: null,
        awaitingRevision: true,
      })
    );
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe(`/sessions/${sessionId}/empathy/draft/edit-first`);
    expect(body).toEqual(expect.objectContaining({ timeZone: expect.any(String) }));

    await act(async () => {
      respond({ resolved: true, opener: null, reopenedAt });
      await pending;
    });
    // Only the active conversation queries are refetched, until the opener is there.
    await waitFor(() => expect(refetch).toHaveBeenCalledWith(activeInfinite));
    act(() => withChat(client, [earlier, opener]));
    const calls = () => refetch.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    const settled = calls();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls()).toBe(settled); // stopped once found
    expect(chatOf(client)).toEqual([earlier, opener]);
    // The reopen is the server's: nothing un-hides the draft.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: stageKeys.empathyDraft(sessionId) });
    expect(client.getQueryData<typeof review>(stageKeys.empathyDraft(sessionId))?.awaitingRevision).toBe(true);
  });

  it('a later call while the opener is still being generated (resolved, no opener) waits the same way and keeps the draft hidden', async () => {
    EDIT_FIRST_OPENER_POLL.intervalMs = 1;
    EDIT_FIRST_OPENER_POLL.attempts = 3;
    const client = createClient();
    client.setQueryData(stageKeys.empathyDraft(sessionId), { ...review, preJoinReview: null, awaitingRevision: true });
    withChat(client, [earlier]);
    const refetch = jest.spyOn(client, 'refetchQueries').mockResolvedValue(undefined);
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    mockPost.mockResolvedValueOnce({ resolved: true, opener: null, reopenedAt });
    const { result } = renderHook(() => useEditPreJoinDraftFirst(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync({ sessionId });
    });
    await waitFor(() => expect(refetch).toHaveBeenCalledWith(activeInfinite));
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: stageKeys.empathyDraft(sessionId) });
    expect(client.getQueryData<typeof review>(stageKeys.empathyDraft(sessionId))?.awaitingRevision).toBe(true);
  });

  it('awaitEditFirstOpener is bounded, and a newer wait or a cancel stops an older one', async () => {
    EDIT_FIRST_OPENER_POLL.intervalMs = 5;
    EDIT_FIRST_OPENER_POLL.attempts = 3;
    const client = createClient();
    withChat(client, [earlier]);
    const refetch = jest.spyOn(client, 'refetchQueries').mockResolvedValue(undefined);
    await expect(awaitEditFirstOpener(client, sessionId, reopenedAt)).resolves.toBe('gave-up');
    expect(refetch.mock.calls.filter(([f]) => JSON.stringify(f) === JSON.stringify(activeInfinite))).toHaveLength(3);

    EDIT_FIRST_OPENER_POLL.attempts = 50;
    const older = awaitEditFirstOpener(client, sessionId, reopenedAt);
    const newer = awaitEditFirstOpener(client, sessionId, reopenedAt);
    await expect(older).resolves.toBe('cancelled');
    cancelEditFirstOpenerWait(sessionId); // unmount / session switch
    await expect(newer).resolves.toBe('cancelled');
    // A message before the marker is not the opener; one at or after it is.
    withChat(client, [earlier]);
    EDIT_FIRST_OPENER_POLL.attempts = 2;
    await expect(awaitEditFirstOpener(client, sessionId, reopenedAt)).resolves.toBe('gave-up');
    withChat(client, [earlier, opener]);
    await expect(awaitEditFirstOpener(client, sessionId, reopenedAt)).resolves.toBe('found');
  });

  it('a later call gets the written opener back and it goes into the chat once', async () => {
    const client = createClient();
    withChat(client, [earlier, opener]);
    mockPost.mockResolvedValueOnce({ resolved: true, opener, reopenedAt });
    const { result } = renderHook(() => useEditPreJoinDraftFirst(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync({ sessionId });
    });
    expect(chatOf(client)).toEqual([earlier, opener]);

    const fresh = createClient();
    withChat(fresh, [earlier]);
    mockPost.mockResolvedValueOnce({ resolved: true, opener, reopenedAt });
    const second = renderHook(() => useEditPreJoinDraftFirst(), { wrapper: wrapperFor(fresh) });
    await act(async () => {
      await second.result.current.mutateAsync({ sessionId });
    });
    expect(chatOf(fresh)).toEqual([earlier, opener]);
  });

  it('adds nothing and refreshes the draft state when no reopen is in effect (resolved: false)', async () => {
    const client = createClient();
    withChat(client, [earlier]);
    mockPost.mockResolvedValueOnce({ resolved: false, opener: null, reopenedAt: null });
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useEditPreJoinDraftFirst(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync({ sessionId });
    });
    expect(chatOf(client)).toEqual([earlier]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: stageKeys.empathyDraft(sessionId) });
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

  it('mergeEmpathyDraftFromServer merges the server draft with setQueryData (an AI proposal elsewhere ends the reopen)', async () => {
    const client = createClient();
    client.setQueryData(stageKeys.empathyDraft(sessionId), { ...review, preJoinReview: null, awaitingRevision: true });
    mockGet.mockResolvedValueOnce({ ...review, preJoinReview: null, awaitingRevision: false, draft: { ...review.draft, content: 'the revision' } });
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    await mergeEmpathyDraftFromServer(client, sessionId);
    expect(client.getQueryData(stageKeys.empathyDraft(sessionId))).toMatchObject({
      awaitingRevision: false,
      draft: { content: 'the revision' },
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
