/**
 * work-k5fk.1 (review L5): `changesMapped.primaryImage` keeps the per-step row
 * count of a baseline table whose image became two target tables (User →
 * user + user_identity) on the one that still holds its rows 1:1.
 */
import { compareMappedChanges } from '../allow-lists/compare';
import type { ChangesMappedRule } from '../allow-lists/types';

describe('compareMappedChanges — primaryImage', () => {
  const rule: ChangesMappedRule = {
    kind: 'changesMapped',
    at: 'steps.*.changes',
    why: 'test',
    tableMap: { User: ['user', 'user_identity'] },
    primaryImage: { User: 'user' },
    addedTables: [],
  };
  const base = [{ table: 'User', kind: 'changed' }];

  it('accepts the primary image at the same count, with the second image beside it', () => {
    const run = [
      { table: 'user', kind: 'changed' },
      { table: 'user_identity', kind: 'changed' },
    ];
    expect(compareMappedChanges(base, run, rule, 0)).toEqual([]);
  });

  it('still counts rows on the primary image although User has two images', () => {
    const run = [
      { table: 'user', kind: 'changed' },
      { table: 'user', kind: 'changed' },
      { table: 'user_identity', kind: 'changed' },
    ];
    expect(compareMappedChanges(base, run, rule, 0)).toEqual(['changes: changed User=1 (+0 named) → user=2']);
    expect(compareMappedChanges(base, [{ table: 'user_identity', kind: 'changed' }], rule, 0)).toEqual([
      'changes: changed User=1 (+0 named) → user=0',
    ]);
  });

  it('without primaryImage a two-image table is not counted (the gap the option closes)', () => {
    const loose: ChangesMappedRule = { ...rule, primaryImage: undefined };
    const run = [
      { table: 'user', kind: 'changed' },
      { table: 'user', kind: 'changed' },
    ];
    expect(compareMappedChanges(base, run, loose, 0)).toEqual([]);
  });
});
