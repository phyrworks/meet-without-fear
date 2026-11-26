/**
 * work-k5fk.35 (C1, owner decision): "Start New Anyway" ends the live session
 * the pair already shares, then creates the new one — one request, one
 * transaction. The old session goes ABANDONED through app.session_set_status
 * (its sole writer; a current participant's ACTIVE → ABANDONED) before the new
 * session is written, and its other side hears session.abandoned after commit.
 * Without forceCreate the inviter is only told about the live session.
 */

const calls: string[] = [];
const sqlOf = (strings: TemplateStringsArray, values: unknown[]) =>
  strings.reduce((acc, s, i) => acc + s + (i < values.length ? `{${String(values[i])}}` : ''), '');

// The old session's status as the transaction reads it under its lock (work-k5fk.34).
let oldStatus = 'ACTIVE';
const tx = {
  $queryRaw: jest.fn(() => {
    calls.push('lock old session');
    return Promise.resolve([{ status: oldStatus }]);
  }),
  $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(`sql:${sqlOf(strings, values)}`);
    return Promise.resolve(1);
  }),
  session: {
    create: jest.fn(() => {
      calls.push('session.create');
      return Promise.resolve({ id: 'new-session', status: 'CREATED', createdAt: new Date('2026-11-25T00:00:00Z') });
    }),
  },
  participant: { create: jest.fn(() => Promise.resolve({ sessionId: 'new-session' })) },
  conversation: { create: jest.fn(() => Promise.resolve({})) },
  conversationReadState: { create: jest.fn(() => Promise.resolve({})) },
  invitation: { create: jest.fn(() => Promise.resolve({ id: 'new-invitation' })) },
};
const $transaction = jest.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
jest.mock('../../lib/prisma', () => ({
  prisma: {
    $queryRaw: jest.fn(() => Promise.resolve([{ known: true }])),
    participant: { findFirst: jest.fn(() => Promise.resolve(null)) },
    $transaction: (cb: (t: typeof tx) => Promise<unknown>) => $transaction(cb),
  },
  getAiPrisma: () => ({}),
  getWorkerPrisma: () => ({}),
}));
jest.mock('../../lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const findLiveSessionWith = jest.fn();
jest.mock('../../services/contacts', () => ({
  ...jest.requireActual('../../services/contacts'),
  findLiveSessionWith: (...a: unknown[]) => findLiveSessionWith(...a),
  getNickname: jest.fn(() => Promise.resolve(null)),
  setNickname: jest.fn(() => Promise.resolve()),
}));

const publishSessionEvent = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('../../services/realtime', () => ({
  ...jest.requireActual('../../services/realtime'),
  publishSessionCreated: jest.fn(() => Promise.resolve()),
  publishSessionEvent: (...a: unknown[]) => publishSessionEvent(...a),
}));
jest.mock('../../utils/urls', () => ({ createInvitationUrl: (id: string) => `https://example.test/invitation/${id}` }));

import type { Request, Response } from 'express';
import { createSession } from '../invitations';

const LIVE = { id: 'old-session', status: 'ACTIVE', updatedAt: new Date('2026-11-24T00:00:00Z') };

async function call(body: Record<string, unknown>) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const req = { user: { id: 'inviter', name: 'Ada' }, body };
  await createSession(req as unknown as Request, res as unknown as Response);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
}

describe('createSession with a live session already shared with that person', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    oldStatus = 'ACTIVE';
    findLiveSessionWith.mockResolvedValue(LIVE);
  });

  it('without forceCreate: answers with the live session and writes nothing', async () => {
    const { status, body } = await call({ personId: 'partner' });
    expect(status).toBe(200);
    expect(body.data.existingActiveSession).toMatchObject({ id: 'old-session', status: 'ACTIVE' });
    expect($transaction).not.toHaveBeenCalled();
    expect(publishSessionEvent).not.toHaveBeenCalled();
  });

  it('forceCreate: abandons the live session, then creates the new one, in one transaction', async () => {
    const { status, body } = await call({ personId: 'partner', forceCreate: true });
    expect(status).toBe(201);
    expect(body.data.session.id).toBe('new-session');
    expect(body.data.endedSessionId).toBe('old-session');
    expect($transaction).toHaveBeenCalledTimes(1);
    // The end comes first: the new session is written only after the old one is ABANDONED.
    expect(calls[0]).toBe('lock old session');
    expect(calls[1]).toMatch(/app\.session_set_status\(\{old-session\}::uuid, 'ABANDONED'/);
    expect(calls.indexOf('session.create')).toBeGreaterThan(0);
    // After commit, the old session's other side hears that it ended (content-free).
    expect(publishSessionEvent).toHaveBeenCalledWith('old-session', 'session.abandoned', {
      reason: 'partner_started_new_session',
    });
  });

  it('forceCreate when the old session ended meanwhile (RESOLVED): creates the new one, ends nothing (work-k5fk.34)', async () => {
    oldStatus = 'RESOLVED';
    const { status, body } = await call({ personId: 'partner', forceCreate: true });
    expect(status).toBe(201);
    expect(body.data.session.id).toBe('new-session');
    expect(body.data.endedSessionId).toBeUndefined();
    expect(calls.some(c => c.includes('session_set_status'))).toBe(false);
    expect(publishSessionEvent).not.toHaveBeenCalled();
  });

  it('forceCreate with no live session: just creates (nothing to end)', async () => {
    findLiveSessionWith.mockResolvedValue(null);
    const { status, body } = await call({ personId: 'partner', forceCreate: true });
    expect(status).toBe(201);
    expect(body.data.endedSessionId).toBeUndefined();
    expect(calls.some(c => c.includes('session_set_status'))).toBe(false);
    expect(publishSessionEvent).not.toHaveBeenCalled();
  });
});
