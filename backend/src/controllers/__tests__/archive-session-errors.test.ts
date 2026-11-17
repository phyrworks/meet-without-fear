/**
 * work-k5fk.10.12: archiveSession answers only app.session_archive's own
 * refusals (class MW SQLSTATEs). No identity (MWA00) is a 500; any other
 * database error, a grant drift (42501) or an unrelated CHECK (23514)
 * included, is logged at warn and rethrown to the error middleware.
 */

const queryRaw = jest.fn();
jest.mock('../../lib/prisma', () => ({
  prisma: { $queryRaw: queryRaw },
  getAiPrisma: () => ({}),
  getWorkerPrisma: () => ({}),
}));
const warn = jest.fn();
const error = jest.fn();
jest.mock('../../lib/logger', () => ({ logger: { warn, error, info: jest.fn(), debug: jest.fn() } }));

import type { Request, Response } from 'express';
import { archiveRefusal, archiveSession } from '../invitations';

/** A node-postgres DatabaseError shape (getPgSqlState reads code + severity). */
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });

function call() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const req = { user: { id: 'u1' }, params: { id: '00000000-0000-7e00-8000-000000000001' } };
  return { res, run: () => archiveSession(req as unknown as Request, res as unknown as Response) };
}

describe('archiveSession error mapping', () => {
  it.each([
    ['MWA01', 404, 'NOT_FOUND'],
    ['MWA02', 403, 'FORBIDDEN'],
    ['MWA03', 400, 'VALIDATION_ERROR'],
  ])('%s → %i %s', async (code, status, apiCode) => {
    queryRaw.mockRejectedValueOnce(pgError(code));
    const { res, run } = call();
    await run();
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json.mock.calls[0][0].error.code).toBe(apiCode);
  });

  it('MWA00 (no identity) is a 500, logged as an error', async () => {
    queryRaw.mockRejectedValueOnce(pgError('MWA00'));
    const { res, run } = call();
    await run();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(error).toHaveBeenCalled();
  });

  it.each(['42501', '23514', 'P0002', '22P02'])('%s is not a refusal: warned and rethrown', async code => {
    const e = pgError(code);
    queryRaw.mockRejectedValueOnce(e);
    const { res, run } = call();
    await expect(run()).rejects.toBe(e);
    expect(res.status).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(code));
  });

  it('archiveRefusal knows exactly the three refusals', () => {
    expect(
      ['MWA00', 'MWA01', 'MWA02', 'MWA03', '42501', '23514', undefined].map(c => archiveRefusal(c)?.status ?? null),
    ).toEqual([null, 404, 403, 400, null, null, null]);
  });
});
