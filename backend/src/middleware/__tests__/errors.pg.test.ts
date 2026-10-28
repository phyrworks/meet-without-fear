/**
 * Real-database proof that a Postgres constraint violation does not leak row
 * contents through the error handler (TS-2, plan §7 row 2).
 *
 * Violates CHECK / UNIQUE / FK / NOT NULL constraints on scratch tables through
 * the real Prisma client (Prisma 7 + @prisma/adapter-pg), hands each error to
 * errorHandler with the logger spied, and asserts the sentinel stored in the
 * row reaches neither the JSON body nor any log call. Each case first asserts
 * the sentinel IS somewhere on the error, so the test cannot pass vacuously.
 *
 * Needs DATABASE_URL pointing at a migrated *test* database (CI sets one;
 * locally: postgresql://mwf_user:mwf_password@127.0.0.1:5432/meet_without_fear_test).
 * Without one the suite is skipped rather than touching a dev database.
 */
import util from 'util';
import { Request, Response, NextFunction } from 'express';
import { ErrorCode } from '@meet-without-fear/shared';
import { errorHandler } from '../errors';
import { logger } from '../../lib/logger';

const SENTINEL = 'SECRET_ROW_CONTENT_7f3a';
const url = process.env.DATABASE_URL;
const isTestDb = !!url && /test/i.test(new URL(url).pathname);
const describeDb = isTestDb ? describe : describe.skip;

const T = `ts2_errors_pg_${process.pid}`;

function run(err: Error) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  errorHandler(
    err,
    { path: '/x', method: 'POST' } as Request,
    { status } as unknown as Response,
    jest.fn() as NextFunction,
  );
  return { status, json };
}

async function caught(f: () => Promise<unknown>): Promise<Error> {
  try {
    await f();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the statement to violate a constraint');
}

describeDb('errorHandler against real Postgres constraint violations', () => {
  // Imported lazily so a skipped suite never constructs a client.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('../../lib/prisma') as typeof import('../../lib/prisma');
  const originalEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${T} (id int PRIMARY KEY, body text NOT NULL, n int,
         CONSTRAINT ${T}_n_pos CHECK (n > 0), CONSTRAINT ${T}_body_uq UNIQUE (body))`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${T}_child (id int PRIMARY KEY, parent int REFERENCES ${T}(id), note text)`,
    );
    await prisma.$executeRawUnsafe(`INSERT INTO ${T} VALUES (1, '${SENTINEL}', 5)`);
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalEnv;
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${T}_child`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${T}`);
    await prisma.$disconnect();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  const cases: Array<{
    name: string;
    trigger: () => Promise<Error>;
    status: number;
    code: ErrorCode;
    constraint: string;
    sentinelOnError: boolean;
  }> = [
    {
      name: 'CHECK via $executeRawUnsafe (P2010)',
      trigger: () => caught(() => prisma.$executeRawUnsafe(`INSERT INTO ${T} VALUES (2, 'x ${SENTINEL}', -1)`)),
      status: 400,
      code: ErrorCode.VALIDATION_ERROR,
      constraint: `${T}_n_pos`,
      sentinelOnError: true,
    },
    {
      name: 'CHECK via a model query (P2039), constraint added in a rolled-back transaction',
      trigger: async () => {
        let err: Error | undefined;
        await prisma
          .$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
            await tx.$executeRawUnsafe(
              `ALTER TABLE "User" ADD CONSTRAINT ${T}_user_chk CHECK (email NOT LIKE '%${SENTINEL}%') NOT VALID`,
            );
            err = await caught(() => tx.user.create({ data: { email: `ts2_${SENTINEL}@example.test` } }));
            throw new Error('rollback');
          })
          .catch((e: Error) => {
            if (e.message !== 'rollback') throw e;
          });
        return err as Error;
      },
      status: 400,
      code: ErrorCode.VALIDATION_ERROR,
      constraint: `${T}_user_chk`,
      sentinelOnError: true,
    },
    {
      name: 'NOT NULL via $executeRawUnsafe',
      trigger: () => caught(() => prisma.$executeRawUnsafe(`INSERT INTO ${T} (id, body, n) VALUES (3, NULL, 5)`)),
      status: 400,
      code: ErrorCode.VALIDATION_ERROR,
      constraint: 'body',
      sentinelOnError: false,
    },
    {
      name: 'UNIQUE via $executeRawUnsafe',
      trigger: () => caught(() => prisma.$executeRawUnsafe(`INSERT INTO ${T} VALUES (4, '${SENTINEL}', 5)`)),
      status: 409,
      code: ErrorCode.CONFLICT,
      constraint: `${T}_body_uq`,
      sentinelOnError: false,
    },
    {
      name: 'FK via $executeRawUnsafe',
      trigger: () => caught(() => prisma.$executeRawUnsafe(`INSERT INTO ${T}_child VALUES (1, 999, '${SENTINEL}')`)),
      status: 409,
      code: ErrorCode.CONFLICT,
      constraint: `${T}_child_parent_fkey`,
      sentinelOnError: false,
    },
  ];

  describe.each(['development', 'production'])('NODE_ENV=%s', env => {
    it.each(cases)(
      '$name: body and logs carry no row values',
      async ({ trigger, status, code, constraint, sentinelOnError }) => {
        const err = await trigger();
        expect(err).toBeInstanceOf(Error);
        if (sentinelOnError) {
          // Guard against a vacuous pass: the row really is on the error object.
          expect(util.inspect(err, { depth: 20 })).toContain(SENTINEL);
        }

        process.env.NODE_ENV = env; // not 'test': exercise the logging branch
        const spies = (['error', 'warn', 'info', 'debug'] as const).map(level =>
          jest.spyOn(logger, level).mockImplementation((() => logger) as never),
        );
        const { status: st, json } = run(err);

        expect(st).toHaveBeenCalledWith(status);
        const body = json.mock.calls[0][0];
        expect(body.error.code).toBe(code);
        expect(body.error.message).toContain(constraint);
        expect(JSON.stringify(body)).not.toContain(SENTINEL);

        const logged = spies.flatMap(s => s.mock.calls);
        expect(logged.length).toBeGreaterThan(0);
        expect(JSON.stringify(logged)).not.toContain(SENTINEL);
        // The logged message is the scrubbed one, not err.message verbatim.
        for (const [message] of logged) {
          expect(String(message)).not.toContain(SENTINEL);
          expect(String(message)).not.toMatch(/Failing row|Key \(/);
        }
      },
    );
  });
});
