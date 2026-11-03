/*
 * work-yvt0: a client-supplied id reaches Prisma only as a UUIDv7. Every id
 * column of the target schema is the `uuid7` domain, so anything else fails in
 * Postgres (P2007 / 23514) and used to surface as a 500. These tests stop at
 * the request boundary: the service is mocked and must not be called.
 */
import { Request, Response } from 'express';
import { uuidv7 } from '@meet-without-fear/shared';

jest.mock('../../services/tending.service', () => {
  const actual = jest.requireActual('../../services/tending.service');
  return {
    ...actual,
    submitTendingCheckin: jest.fn(),
    submitTendingResponse: jest.fn(),
    setIndividualEntryShare: jest.fn(),
  };
});

import { postTendingCheckin, postTendingEntryShare, postTendingResponse } from '../tending';
import * as service from '../../services/tending.service';

const V4 = '3f1c2b9e-8a4d-4c1e-9b2a-6d5e4f3a2b1c';

function mockRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

function req(body: unknown, params: Record<string, string> = {}): Request {
  return {
    user: { id: uuidv7(), email: 'a@example.com' },
    params: { id: uuidv7(), ...params },
    body,
  } as unknown as Request;
}

function checkinBody(needOutcome: Record<string, unknown>) {
  return {
    orientations: {
      whatWorked: { reflection: '' },
      whereMoreSupport: { reflection: '' },
      whatComesNext: { continueChoice: 'ANOTHER_ROUND' },
    },
    needOutcomes: [{ needLabel: 'Partnership', resolutionStatus: 'STILL_OPEN', ...needOutcome }],
  };
}

function expectValidation400(status: jest.Mock, json: jest.Mock) {
  expect(status).toHaveBeenCalledWith(400);
  expect(json).toHaveBeenCalledWith(
    expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR' }) }),
  );
}

describe('POST /sessions/:id/tending/checkin id validation', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['a non-uuid needId', { needId: 'need-partnership' }],
    ['a v4 needId', { needId: V4 }],
    ['a non-uuid sourceUserId', { sourceUserId: 'user-a' }],
  ])('answers 400 VALIDATION_ERROR for %s without reaching the service', async (_label, needOutcome) => {
    const { res, status, json } = mockRes();
    await postTendingCheckin(req(checkinBody(needOutcome)), res);
    expectValidation400(status, json);
    expect(service.submitTendingCheckin).not.toHaveBeenCalled();
  });

  it.each([
    ['entryOutcomes[].tendingEntryId', { entryOutcomes: [{ tendingEntryId: 'e1', followThroughStatus: 'HAPPENED' }] }],
    ['includedBetweenPeriodNoteIds', { includedBetweenPeriodNoteIds: ['note-1'] }],
    ['shareBetweenPeriodNoteIds', { shareBetweenPeriodNoteIds: [V4] }],
    ['adjustments[].tendingEntryId', { adjustments: [{ tendingEntryId: 'e1' }] }],
  ])('answers 400 for a non-v7 id in %s', async (_label, extra) => {
    const { res, status, json } = mockRes();
    await postTendingCheckin(req({ ...checkinBody({}), ...extra }), res);
    expectValidation400(status, json);
    expect(service.submitTendingCheckin).not.toHaveBeenCalled();
  });

  it('passes a UUIDv7 needId through to the service', async () => {
    (service.submitTendingCheckin as jest.Mock).mockResolvedValue({
      entries: [],
      checkin: null,
      coordinationCycle: null,
      newSessionId: null,
      continueChoice: 'ANOTHER_ROUND',
      nextScheduledFor: null,
    });
    const needId = uuidv7();
    const { res, status } = mockRes();
    await postTendingCheckin(req(checkinBody({ needId })), res);
    expect(status).toHaveBeenCalledWith(200);
    expect((service.submitTendingCheckin as jest.Mock).mock.calls[0][0].needOutcomes[0].needId).toBe(needId);
  });

  it('answers 400 (not 500) when the service refuses a need that is not shared in this session', async () => {
    (service.submitTendingCheckin as jest.Mock).mockRejectedValue(
      new service.TendingInvalidStateError('Need outcome references a need not shared in this session'),
    );
    const { res, status, json } = mockRes();
    await postTendingCheckin(req(checkinBody({ needId: uuidv7() })), res);
    expectValidation400(status, json);
  });
});

describe('Tending :entryId routes id validation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POST /tending/:entryId/responses answers 404 for a non-v7 entryId without reaching the service', async () => {
    const { res, status } = mockRes();
    await postTendingResponse(req({ status: 'WORKED' }, { entryId: 'entry-1' }), res);
    expect(status).toHaveBeenCalledWith(404);
    expect(service.submitTendingResponse).not.toHaveBeenCalled();
  });

  it('POST /tending/:entryId/share answers 404 for a v4 entryId without reaching the service', async () => {
    const { res, status } = mockRes();
    await postTendingEntryShare(req({}, { entryId: V4 }), res);
    expect(status).toHaveBeenCalledWith(404);
    expect(service.setIndividualEntryShare).not.toHaveBeenCalled();
  });
});
