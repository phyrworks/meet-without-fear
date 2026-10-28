/**
 * `traceMapped` (TS-9 fix round 1): the byte-level trace on the target,
 * compared through a relation rename map instead of wholesale `mayDiffer`.
 */

import { compareMappedTrace } from '../allow-lists/compare';
import { buildTrace, kindFromText, parsePostgresLog } from '../trace';
import type { TraceMappedRule } from '../allow-lists/types';

const rule: TraceMappedRule = {
  kind: 'traceMapped',
  at: 'steps.*.trace',
  why: 'test',
  relationMap: { Message: ['message'], User: ['user'] },
  addedRelations: { conversation: 'the audience' },
  sameRowsRead: [{ steps: 'messages', relation: 'Message', as: 'message' }],
};

const stmt = (kind: string, protocol: string, relations: string[]) => ({ kind, protocol, relations });
const base = {
  complete: true,
  rowsRead: { Message: 6 },
  shapes: [
    { isolation: null, statements: [stmt('SELECT', 'extended', ['Message']), stmt('INSERT', 'extended', ['User'])] },
  ],
};
const run = (over: Record<string, unknown> = {}) => ({
  complete: true,
  rowsRead: { message: 6, conversation: 1 },
  shapes: [
    {
      isolation: null,
      statements: [
        stmt('BEGIN', 'simple', []),
        stmt('SELECT', 'extended', ['message', 'conversation']),
        stmt('COMMIT', 'simple', []),
      ],
    },
  ],
  ...over,
});

describe('traceMapped', () => {
  it('accepts mapped relations, added ones, simple transaction control and the same paged row count', () => {
    expect(compareMappedTrace(base, run(), rule, 'messages page')).toEqual([]);
  });

  it('flags a DATA statement sent without bind parameters (the SQL-injection tripwire)', () => {
    const v = compareMappedTrace(
      base,
      run({ shapes: [{ isolation: null, statements: [stmt('SELECT', 'simple', ['message'])] }] }),
      rule,
      'x',
    );
    expect(v.join('\n')).toMatch(/protocol simple/);
  });

  it('flags a relation no baseline relation maps to', () => {
    const v = compareMappedTrace(
      base,
      run({ shapes: [{ isolation: null, statements: [stmt('SELECT', 'extended', ['need'])] }] }),
      rule,
      'x',
    );
    expect(v.join('\n')).toMatch(/touches need/);
  });

  it('flags a changed row count of the same read, and a changed isolation level', () => {
    expect(compareMappedTrace(base, run({ rowsRead: { message: 13 } }), rule, 'messages page').join('\n')).toMatch(
      /rowsRead Message=6 → message=13/,
    );
    const v = compareMappedTrace(
      base,
      run({ shapes: [{ isolation: 'SERIALIZABLE', statements: [stmt('SELECT', 'extended', ['message'])] }] }),
      rule,
      'x',
    );
    expect(v.join('\n')).toMatch(/isolation levels/);
  });

  it('flags an incomplete run trace and an unmapped baseline relation', () => {
    expect(compareMappedTrace(base, run({ complete: false }), rule, 'x').join('\n')).toMatch(/not complete/);
    const unmapped = {
      ...base,
      shapes: [{ isolation: null, statements: [stmt('SELECT', 'extended', ['StageProgress'])] }],
    };
    expect(compareMappedTrace(unmapped, run(), rule, 'x').join('\n')).toMatch(/StageProgress has no entry/);
  });

  it('exempts transaction control only when it touches no relation', () => {
    const v = compareMappedTrace(
      base,
      run({ shapes: [{ isolation: null, statements: [stmt('COMMIT', 'simple', ['message'])] }] }),
      rule,
      'x',
    );
    expect(v.join('\n')).toMatch(/a COMMIT on \[message\] used protocol simple/);
  });
});

describe('trace parser: transaction control (TS-9 fix round 2)', () => {
  const APP = 'mwf-app-under-test';
  const line = (msg: string) => `2026-10-26 12:00:00.000 UTC [7] db=probe,app=${APP},vxid=3/1,xid=0 LOG:  ${msg}`;

  it('classifies a multi-statement `BEGIN; INSERT …` as other, never as BEGIN', () => {
    expect(kindFromText('BEGIN; INSERT INTO message (content) VALUES (1)').kind).toBe('other');
    expect(kindFromText('COMMIT; DELETE FROM message').kind).toBe('other');
    expect(kindFromText('BEGIN').kind).toBe('BEGIN');
    expect(kindFromText('COMMIT;').kind).toBe('COMMIT');
  });

  it('a `BEGIN; INSERT …` sent on the simple protocol fails the mapped trace', () => {
    const stmts = buildTrace(parsePostgresLog(line("statement: BEGIN; INSERT INTO message (content) VALUES ('x')")), {
      database: 'probe',
      application: APP,
    });
    const trace = { complete: true, rowsRead: {}, shapes: [{ isolation: null, statements: stmts }] };
    expect(compareMappedTrace(base, trace, rule, 'x').join('\n')).toMatch(/a other on \[\] used protocol simple/);
  });

  it("attributes a portal's late plan to its statement, not to the COMMIT logged before it", () => {
    const raw = [
      line('statement: BEGIN'),
      line('execute <unnamed>: SELECT id FROM message WHERE conversation_id = $1'),
      line('statement: COMMIT'),
      line('duration: 0.02 ms  plan:'),
      '\tQuery Text: SELECT id FROM message WHERE conversation_id = $1',
      '\tSeq Scan on message  (cost=0.00..1.00 rows=3 width=16) (actual rows=3 loops=1)',
    ].join('\n');
    const stmts = buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP });
    expect(stmts.map(s => [s.kind, s.protocol, s.relations])).toEqual([
      ['BEGIN', 'simple', []],
      ['SELECT', 'extended', ['message']],
      ['COMMIT', 'simple', []],
    ]);
    expect(stmts[1].rowsRead).toEqual({ message: 3 });
  });
});
