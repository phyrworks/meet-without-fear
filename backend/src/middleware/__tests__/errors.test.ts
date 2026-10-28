import { Request, Response, NextFunction } from 'express';
import { ErrorCode } from '@meet-without-fear/shared';
import { Prisma } from '../../generated/prisma/client';
import { errorHandler, isMalformedIdError, scrubPgDetail, AppError } from '../errors';
import { logger } from '../../lib/logger';

function run(err: Error) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  errorHandler(
    err,
    { path: '/x', method: 'GET' } as Request,
    { status } as unknown as Response,
    jest.fn() as NextFunction,
  );
  return { status, json };
}

const malformed = () =>
  new Prisma.PrismaClientKnownRequestError('Invalid input value: invalid input syntax for type uuid: "not-a-uuid"', {
    code: 'P2007',
    clientVersion: 'test',
  });

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

// ============================================================================
// Postgres constraint violations must not leak row contents (TS-2)
// Shapes below are the ones observed from Prisma 7.10 + @prisma/adapter-pg
// against PG 18 (see errors.pg.test.ts for the real-database proof).
// ============================================================================

const SENTINEL = 'SECRET_ROW_CONTENT_7f3a';

/** The DriverAdapterError @prisma/adapter-pg hangs off meta.driverAdapterError. */
function adapterError(cause: Record<string, unknown>) {
  const e = new Error(String(cause.originalMessage ?? 'driver error'));
  e.name = 'DriverAdapterError';
  (e as Error & { cause: unknown }).cause = cause;
  return e;
}

function known(code: string, message: string, meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: '7.10.0', meta });
}

const checkCause = {
  originalCode: '23514',
  originalMessage: 'new row for relation "t" violates check constraint "t_n_pos"',
  kind: 'postgres',
  code: '23514',
  severity: 'ERROR',
  message: 'new row for relation "t" violates check constraint "t_n_pos"',
  detail: `Failing row contains (1, ${SENTINEL}, -1).`,
};

const pgError = (message: string, props: Record<string, unknown>) =>
  Object.assign(new Error(message), { name: 'error', severity: 'ERROR', ...props });

const shapes: Array<{ name: string; err: () => Error; status: number; code: ErrorCode; constraint: string }> = [
  {
    name: 'raw-query CHECK (P2010, kind postgres, detail in meta)',
    err: () =>
      known(
        'P2010',
        'Raw query failed. Code: `23514`. Message: `new row for relation "t" violates check constraint "t_n_pos"`',
        {
          driverAdapterError: adapterError(checkCause),
        },
      ),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    constraint: 't_n_pos',
  },
  {
    name: 'model CHECK (P2039 database error)',
    err: () =>
      known(
        'P2039',
        'Database error. Code: `23514`. Message: `new row for relation "User" violates check constraint "user_chk"`',
        {
          modelName: 'User',
          driverAdapterError: adapterError({
            ...checkCause,
            originalMessage: 'new row for relation "User" violates check constraint "user_chk"',
            message: 'new row for relation "User" violates check constraint "user_chk"',
          }),
        },
      ),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    constraint: 'user_chk',
  },
  {
    name: 'Prisma-6-style raw CHECK (P2010, meta.code + meta.message carrying DETAIL)',
    err: () =>
      known(
        'P2010',
        `Raw query failed. Code: \`23514\`. Message: \`ERROR: new row for relation "t" violates check constraint "t_n_pos"\nDETAIL: Failing row contains (1, ${SENTINEL}, -1).\``,
        {
          code: '23514',
          message: `ERROR: new row for relation "t" violates check constraint "t_n_pos"\nDETAIL: Failing row contains (1, ${SENTINEL}, -1).`,
        },
      ),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    constraint: 't_n_pos',
  },
  {
    name: 'raw NOT NULL (P2010, NullConstraintViolation)',
    err: () =>
      known(
        'P2010',
        'Raw query failed. Code: `23502`. Message: `null value in column "body" of relation "t" violates not-null constraint`',
        {
          driverAdapterError: adapterError({
            originalCode: '23502',
            originalMessage: 'null value in column "body" of relation "t" violates not-null constraint',
            kind: 'NullConstraintViolation',
          }),
        },
      ),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    constraint: 'body',
  },
  {
    name: 'model UNIQUE (P2002)',
    err: () =>
      known('P2002', 'Unique constraint failed on the constraint: `User_email_key`', {
        modelName: 'User',
        driverAdapterError: adapterError({
          originalCode: '23505',
          originalMessage: 'duplicate key value violates unique constraint "User_email_key"',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'User_email_key' },
        }),
      }),
    status: 409,
    code: ErrorCode.CONFLICT,
    constraint: 'User_email_key',
  },
  {
    name: 'Prisma-6-style UNIQUE (P2002, meta.target only)',
    err: () => known('P2002', 'Unique constraint failed on the fields: (`email`)', { target: ['email'] }),
    status: 409,
    code: ErrorCode.CONFLICT,
    constraint: 'email',
  },
  {
    name: 'model FK (P2003)',
    err: () =>
      known('P2003', 'Foreign key constraint violated on the constraint: `Session_relationshipId_fkey`', {
        modelName: 'Session',
        driverAdapterError: adapterError({
          originalCode: '23503',
          originalMessage:
            'insert or update on table "Session" violates foreign key constraint "Session_relationshipId_fkey"',
          kind: 'ForeignKeyConstraintViolation',
          constraint: { index: 'Session_relationshipId_fkey' },
        }),
      }),
    status: 409,
    code: ErrorCode.CONFLICT,
    constraint: 'Session_relationshipId_fkey',
  },
  {
    name: 'raw pg DatabaseError (CHECK, detail own property)',
    err: () =>
      pgError('new row for relation "t" violates check constraint "t_n_check"', {
        code: '23514',
        detail: `Failing row contains (1, ${SENTINEL}, -1).`,
        table: 't',
        constraint: 't_n_check',
      }),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    constraint: 't_n_check',
  },
  {
    name: 'raw pg DatabaseError (UNIQUE, Key (...)=(...) detail)',
    err: () =>
      pgError('duplicate key value violates unique constraint "t_body_uq"', {
        code: '23505',
        detail: `Key (body)=(${SENTINEL}) already exists.`,
        constraint: 't_body_uq',
      }),
    status: 409,
    code: ErrorCode.CONFLICT,
    constraint: 't_body_uq',
  },
  {
    name: 'raw pg DatabaseError (FK, Key (...)=(...) detail)',
    err: () =>
      pgError('insert or update on table "c" violates foreign key constraint "c_parent_fkey"', {
        code: '23503',
        detail: `Key (parent)=(${SENTINEL}) is not present in table "t".`,
        constraint: 'c_parent_fkey',
      }),
    status: 409,
    code: ErrorCode.CONFLICT,
    constraint: 'c_parent_fkey',
  },
];

function spyAllLogLevels() {
  return (['error', 'warn', 'info', 'debug'] as const).map(level =>
    jest.spyOn(logger, level).mockImplementation((() => logger) as never),
  );
}

describe('errorHandler: Postgres constraint violations', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe.each(['development', 'production'])('NODE_ENV=%s', env => {
    it.each(shapes)(
      '$name -> stable 4xx naming the constraint, no row values in body or log',
      ({ err, status, code, constraint }) => {
        process.env.NODE_ENV = env; // anything but 'test', so the logging branch runs
        const spies = spyAllLogLevels();
        const { status: st, json } = run(err());

        expect(st).toHaveBeenCalledWith(status);
        const body = json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(body.error.code).toBe(code);
        expect(body.error.message).toContain(constraint);
        expect(JSON.stringify(body)).not.toContain(SENTINEL);
        expect(JSON.stringify(body)).not.toMatch(/Failing row|Key \(/);

        const logged = spies.flatMap(s => s.mock.calls);
        expect(logged.length).toBeGreaterThan(0);
        expect(JSON.stringify(logged)).not.toContain(SENTINEL);
        expect(JSON.stringify(logged)).toContain(constraint);
      },
    );
  });
});

describe('errorHandler: generic errors are scrubbed too', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it.each([
    `insert failed: Failing row contains (1, ${SENTINEL}, -1).`,
    `ERROR: something\nDETAIL: Key (body)=(${SENTINEL}) already exists.`,
    `Key (lower(email))=(${SENTINEL}) conflicts with existing key (lower(email))=(${SENTINEL}x).`,
  ])('development echo and log never carry %j', message => {
    process.env.NODE_ENV = 'development';
    const spies = spyAllLogLevels();
    const { status, json } = run(new Error(message));
    expect(status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain(SENTINEL);
    const logged = spies.flatMap(s => s.mock.calls);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(SENTINEL);
  });

  it('leaves ordinary development messages and stacks intact', () => {
    process.env.NODE_ENV = 'development';
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation((() => logger) as never);
    const e = new Error('boom: widget 42 missing');
    const { json } = run(e);
    expect(json.mock.calls[0][0].error.message).toBe('boom: widget 42 missing');
    expect(errorSpy).toHaveBeenCalledWith(
      '[Error] boom: widget 42 missing',
      expect.objectContaining({ stack: e.stack }),
    );
  });

  it('scrubs an AppError whose message embeds a detail string', () => {
    process.env.NODE_ENV = 'development';
    const spies = spyAllLogLevels();
    const { status, json } = run(
      new AppError(ErrorCode.CONFLICT, `dup: Key (email)=(${SENTINEL}) already exists.`, 409),
    );
    expect(status).toHaveBeenCalledWith(409);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain(SENTINEL);
    expect(JSON.stringify(spies.flatMap(s => s.mock.calls))).not.toContain(SENTINEL);
  });
});

describe('scrubPgDetail', () => {
  it('removes Failing row, Key (...)=(...) and DETAIL fragments', () => {
    expect(scrubPgDetail(`a Failing row contains (x, ${SENTINEL}).`)).not.toContain(SENTINEL);
    expect(scrubPgDetail(`Key (a, b)=(1, ${SENTINEL}) already exists.`)).not.toContain(SENTINEL);
    expect(scrubPgDetail(`x\nDETAIL:  ${SENTINEL}`)).not.toContain(SENTINEL);
    expect(scrubPgDetail('plain message')).toBe('plain message');
  });
});
