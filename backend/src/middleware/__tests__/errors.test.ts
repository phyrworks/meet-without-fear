import { Request, Response, NextFunction } from 'express';
import { ErrorCode } from '@meet-without-fear/shared';
import { Prisma } from '../../generated/prisma/client';
import { errorHandler, isMalformedIdError } from '../errors';

function run(err: Error) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  errorHandler(err, { path: '/x', method: 'GET' } as Request, { status } as unknown as Response, jest.fn() as NextFunction);
  return { status, json };
}

const malformed = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Invalid input value: invalid input syntax for type uuid: "not-a-uuid"',
    { code: 'P2007', clientVersion: 'test' },
  );

describe('errorHandler: malformed ids', () => {
  // Ids are Postgres uuids since cuid_to_uuidv7. A lookup by a string that is
  // not a uuid now fails in the database instead of finding nothing; it must
  // still read as "not found", not as a 500.
  it('answers 404 NOT_FOUND for an id Postgres rejects as a uuid', () => {
    const { status, json } = run(malformed());
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: ErrorCode.NOT_FOUND, message: 'Resource not found' },
    });
  });

  it('does not claim other P2007 validation errors', () => {
    const other = new Prisma.PrismaClientKnownRequestError('Invalid input value: something else', {
      code: 'P2007',
      clientVersion: 'test',
    });
    expect(isMalformedIdError(other)).toBe(false);
    expect(run(other).status).toHaveBeenCalledWith(500);
  });

  it('does not claim non-Prisma errors', () => {
    expect(isMalformedIdError(new Error('invalid input syntax for type uuid'))).toBe(false);
  });
});
