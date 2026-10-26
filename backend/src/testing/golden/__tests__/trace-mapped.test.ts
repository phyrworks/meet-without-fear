/**
 * `traceMapped` (TS-9 fix round 1): the byte-level trace on the target,
 * compared through a relation rename map instead of wholesale `mayDiffer`.
 */

import { compareMappedTrace } from '../allow-lists/compare';
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
  shapes: [{ isolation: null, statements: [stmt('SELECT', 'extended', ['Message']), stmt('INSERT', 'extended', ['User'])] }],
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
    const v = compareMappedTrace(base, run({ shapes: [{ isolation: null, statements: [stmt('SELECT', 'simple', ['message'])] }] }), rule, 'x');
    expect(v.join('\n')).toMatch(/protocol simple/);
  });

  it('flags a relation no baseline relation maps to', () => {
    const v = compareMappedTrace(base, run({ shapes: [{ isolation: null, statements: [stmt('SELECT', 'extended', ['need'])] }] }), rule, 'x');
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
    const unmapped = { ...base, shapes: [{ isolation: null, statements: [stmt('SELECT', 'extended', ['StageProgress'])] }] };
    expect(compareMappedTrace(unmapped, run(), rule, 'x').join('\n')).toMatch(/StageProgress has no entry/);
  });
});
