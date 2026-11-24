/**
 * work-k5fk.30: a log line never carries what a Postgres constraint error quotes from the row. The errors are
 * built in the shapes the drivers raise them (errors.ts lists them): node-postgres' DatabaseError with its own
 * `detail`, and a Prisma known-request error whose adapter cause carries the detail and the original message.
 * They are logged the way the services log them — `logger.error('… failed:', error)` — through the real logger's
 * format, and the line that reaches a transport (the console, Sentry) is inspected.
 */

import winston from 'winston';
import Transport from 'winston-transport';
import { DatabaseError } from 'pg';
import { Prisma } from '../../generated/prisma/client';
import { redactForLog, redactLogInfo, scrubPgDetail } from '../log-redact';

const SECRET = 'PROBE_PRIVATE_LINE';

function checkViolation(): DatabaseError {
  const e = new DatabaseError('new row for relation "message" violates check constraint "message_check"', 120, 'error');
  e.code = '23514';
  e.severity = 'ERROR';
  e.table = 'message';
  e.constraint = 'message_check';
  e.detail = `Failing row contains (0190…, 1, ${SECRET}, USER, …).`;
  return e;
}

function prismaCheckViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Raw query failed. Code: \`23514\`. Message: \`new row violates check constraint "need_check" DETAIL: Failing row contains (${SECRET})\``,
    {
      code: 'P2010',
      clientVersion: '7.10.0',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '23514',
            originalMessage: `new row for relation "need" violates check constraint "need_check"`,
            kind: 'postgres',
            detail: `Failing row contains (${SECRET}).`,
            constraint: { index: 'need_check' },
          },
        },
      },
    },
  );
}

/** What a transport receives from the real logger's format pipeline (logger.ts). */
async function logged(...args: unknown[]): Promise<string> {
  const lines: string[] = [];
  class Capture extends Transport {
    log(info: Record<string | symbol, unknown>, done: () => void) {
      const splat = info[Symbol.for('splat')];
      lines.push(JSON.stringify({ ...info, splat }), String(info[Symbol.for('message')]));
      done();
    }
  }
  const { logger } = await import('../logger');
  const l = winston.createLogger({ level: 'debug', format: logger.format, transports: [new Capture()] });
  (l.error as (...a: unknown[]) => void)(...args);
  return lines.join('\n');
}

describe('log redaction of Postgres row data (work-k5fk.30)', () => {
  it('a node-postgres CHECK violation logged as meta keeps its code and constraint, not the row', async () => {
    const out = await logged('[BrainService] Failed to start activity:', checkViolation());
    expect(out).not.toContain(SECRET);
    expect(out).toContain('23514');
    expect(out).toContain('message_check');
  });

  it('a Prisma error keeps its codes and constraint, not the adapter cause’s detail or message tail', async () => {
    const out = await logged('Failed:', prismaCheckViolation());
    expect(out).not.toContain(SECRET);
    expect(out).toContain('P2010');
    expect(out).toContain('need_check');
  });

  it('nested in a meta object, or as one of several arguments, it is redacted too', async () => {
    expect(await logged('x', { error: checkViolation(), sessionId: 's1' })).not.toContain(SECRET);
    expect(await logged('x %s', 'a', { cause: prismaCheckViolation() })).not.toContain(SECRET);
    expect(
      await logged(`failed: ${checkViolation().message} DETAIL: Key (id)=(${SECRET}) already exists`),
    ).not.toContain(SECRET);
  });

  it('leaves ordinary log data alone', () => {
    const meta = { sessionId: 's1', count: 3, at: new Date(0), list: ['a', 'b'] };
    expect(redactForLog(meta)).toEqual(meta);
    expect(redactLogInfo({ message: 'Stage transition', level: 'info', from: 'HELD' })).toEqual({
      message: 'Stage transition',
      level: 'info',
      from: 'HELD',
    });
    expect(scrubPgDetail('no data here')).toBe('no data here');
  });

  it('survives a cycle', () => {
    const a: Record<string, unknown> = { detail: `Failing row contains (${SECRET})` };
    a.self = a;
    expect(JSON.stringify(redactForLog(a))).not.toContain(SECRET);
  });
});
