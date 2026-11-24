/**
 * work-k5fk.10.39: acknowledgeInvitation checks expiry by the app's clock, then
 * app.invitation_claim checks it again by the database's. An invitation that
 * expires (or is answered, or withdrawn by an archive) in between is refused by
 * the claim with check_violation; that answers as the app's own check would
 * have (200, not acknowledged), never a 500.
 */

const peekInvitation = jest.fn();
const claimInvitation = jest.fn();
jest.mock('../../services/invitation-peek', () => ({
  ...jest.requireActual('../../services/invitation-peek'),
  peekInvitation: (...a: unknown[]) => peekInvitation(...a),
  claimInvitation: (...a: unknown[]) => claimInvitation(...a),
}));
jest.mock('../../lib/prisma', () => ({ prisma: {}, getAiPrisma: () => ({}), getWorkerPrisma: () => ({}) }));
jest.mock('../../lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import type { Request, Response } from 'express';
import { acknowledgeInvitation } from '../invitations';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });

const peek = (over: Record<string, unknown> = {}) => ({
  id: 'inv1',
  sessionId: 's1',
  invitedByUserId: 'inviter',
  inviterDisplayName: 'Ada',
  inviteeName: null,
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  sessionStatus: 'INVITED',
  messageConfirmedAt: new Date(),
  topicFrameConfirmed: true,
  claimedBy: null,
  ...over,
});

async function call() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const req = { user: { id: 'opener' }, params: { id: 'inv1' } };
  await acknowledgeInvitation(req as unknown as Request, res as unknown as Response);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
}

describe('acknowledgeInvitation: the claim refuses after the app checked', () => {
  beforeEach(() => jest.clearAllMocks());

  it('expired in between: not acknowledged, EXPIRED (200)', async () => {
    peekInvitation.mockResolvedValueOnce(peek()).mockResolvedValueOnce(peek({ expiresAt: new Date(Date.now() - 1) }));
    claimInvitation.mockRejectedValueOnce(pgError('23514'));
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ acknowledged: false, reason: 'expired', invitation: { status: 'EXPIRED' } });
  });

  it('declined in between: not acknowledged, with the status now read', async () => {
    peekInvitation.mockResolvedValueOnce(peek()).mockResolvedValueOnce(peek({ status: 'DECLINED' }));
    claimInvitation.mockRejectedValueOnce(pgError('23514'));
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ acknowledged: false, reason: 'declined', invitation: { status: 'DECLINED' } });
  });

  it('any other database error is still a 500', async () => {
    peekInvitation.mockResolvedValueOnce(peek());
    claimInvitation.mockRejectedValueOnce(pgError('42501'));
    const { status } = await call();
    expect(status).toBe(500);
  });
});
