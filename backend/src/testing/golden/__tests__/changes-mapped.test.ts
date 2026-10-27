/**
 * TS-10 rule kinds (rulings R31, R32):
 *   - `changesMapped`: byte-level row changes on the target, compared through a
 *     table rename map (the analogue of `traceMapped`);
 *   - `pendingCluster`: a read of a cluster not yet on this branch may answer
 *     500 — and a listed read that answers anything else fails.
 */

import { compareMappedChanges, compareWithAllowList } from '../allow-lists/compare';
import type { AllowList, ChangesMappedRule } from '../allow-lists/types';

const rule: ChangesMappedRule = {
  kind: 'changesMapped',
  at: 'steps.*.changes',
  why: 'test',
  tableMap: {
    Message: ['message'],
    EmpathyAttempt: ['empathy_attempt'],
    StageProgress: ['participant_milestone', 'milestone'],
    UserVessel: ['conversation_read_state'],
  },
  addedTables: [
    { step: 1, table: 'message', kind: 'added', count: 2, why: 'the delivered copies' },
    { step: 1, table: 'participant_milestone', kind: 'added', count: 1, why: 'empathy_submitted' },
  ],
};
const ch = (table: string, kind: string) => ({ table, kind, key: 'k', after: { secret: 'values are not compared here' } });

describe('changesMapped', () => {
  it('accepts mapped tables with equal 1:1 counts and the named additions at their exact step', () => {
    const base = [ch('Message', 'added'), ch('EmpathyAttempt', 'changed')];
    const run = [ch('message', 'added'), ch('message', 'added'), ch('message', 'added'), ch('empathy_attempt', 'changed'), ch('participant_milestone', 'added')];
    expect(compareMappedChanges(base, run, rule, 1)).toEqual([]);
  });

  it('flags a 1:1 count that moved (an extra or a lost row)', () => {
    const base = [ch('Message', 'added')];
    expect(compareMappedChanges(base, [ch('message', 'added'), ch('message', 'added')], rule, 0).join('\n')).toMatch(
      /added Message=1 \(\+0 named\) → message=2/,
    );
  });

  it('pins an addition to its step: the same row written at another step is a violation', () => {
    const v = compareMappedChanges([], [ch('participant_milestone', 'added')], rule, 2);
    expect(v.join('\n')).toMatch(/writes added participant_milestone, which no baseline write maps to/);
  });

  it('flags a write that disappeared, and a baseline table with no map entry', () => {
    expect(compareMappedChanges([ch('EmpathyAttempt', 'changed')], [], rule, 0).join('\n')).toMatch(/no changed image/);
    expect(compareMappedChanges([ch('ConsentRecord', 'added')], [], rule, 0).join('\n')).toMatch(/no entry in the table map/);
  });

  it('a kind the baseline never wrote for that table is not in the image', () => {
    const v = compareMappedChanges([ch('EmpathyAttempt', 'changed')], [ch('empathy_attempt', 'changed'), ch('empathy_attempt', 'removed')], rule, 0);
    expect(v.join('\n')).toMatch(/writes removed empathy_attempt/);
  });

  it('a 1:N mapping checks membership, not counts', () => {
    const base = [ch('StageProgress', 'changed')];
    expect(compareMappedChanges(base, [ch('participant_milestone', 'changed'), ch('participant_milestone', 'changed')], rule, 0)).toEqual([]);
  });

  it('async-boundary markers must be equal', () => {
    expect(compareMappedChanges('<async boundary>', '<async boundary>', rule, 0)).toEqual([]);
    expect(compareMappedChanges('<async boundary>', [], rule, 0)).toHaveLength(1);
  });

  it('is applied by compareWithAllowList at its path', () => {
    const allow: AllowList = { scenario: 's', rules: [{ ...rule, mustMatch: true }] };
    const e = { steps: [{ label: 'x', changes: [ch('Message', 'added')] }] };
    expect(compareWithAllowList(e, { steps: [{ label: 'x', changes: [ch('message', 'added')] }] }, allow)).toEqual({
      violations: [],
      unmatchedRules: [],
    });
    expect(compareWithAllowList(e, { steps: [{ label: 'x', changes: [] }] }, allow).violations.join('\n')).toMatch(/no added image/);
  });
});

describe('pendingCluster', () => {
  const allow = (reads: Array<{ read: string; owner: 'TS-11' | 'TS-12' }>): AllowList => ({
    scenario: 's',
    rules: [{ kind: 'pendingCluster', at: 'steps', reads, why: 'test', mustMatch: true }],
  });
  const step = (label: string, status: number, body: unknown, changes: unknown[] = []) => ({ label, status, body, changes });
  const err = { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get needs' } };

  it('lets a listed read of another cluster answer 500 (status and body), and still compares its changes', () => {
    const e = { steps: [step('author: needs as ada@e2e.test', 200, { data: { needs: [1] } }, [{ table: 'User' }])] };
    const ok = compareWithAllowList(e, { steps: [step('author: needs as ada@e2e.test', 500, err, [{ table: 'User' }])] }, allow([{ read: 'needs', owner: 'TS-11' }]));
    expect(ok).toEqual({ violations: [], unmatchedRules: [] });
    const changed = compareWithAllowList(e, { steps: [step('author: needs as ada@e2e.test', 500, err, [])] }, allow([{ read: 'needs', owner: 'TS-11' }]));
    expect(changed.violations.join('\n')).toMatch(/changes/);
  });

  it('FAILS when a listed read answers 200 — a stale entry, like a stale KNOWN leak', () => {
    const e = { steps: [step('p: tending as bob@e2e.test', 200, { data: {} })] };
    const v = compareWithAllowList(e, { steps: [step('p: tending as bob@e2e.test', 200, { data: {} })] }, allow([{ read: 'tending', owner: 'TS-11' }]));
    expect(v.violations.join('\n')).toMatch(/stale pendingCluster entry: "tending" now answers 200/);
  });

  it('never excuses a TS-10 read, nor a read under the wrong owner', () => {
    const e = { steps: [step('p: empathy status as ada@e2e.test', 200, { data: {} })] };
    const a = { steps: [step('p: empathy status as ada@e2e.test', 500, err)] };
    const v = compareWithAllowList(e, a, allow([{ read: 'empathy status', owner: 'TS-11' }]));
    expect(v.violations.join('\n')).toMatch(/may not list "empathy status"/);
    expect(v.violations.join('\n')).toMatch(/stale pendingCluster entry|status/);
    expect(compareWithAllowList({ steps: [] }, { steps: [] }, allow([{ read: 'emotions', owner: 'TS-11' }])).violations.join('\n')).toMatch(
      /may not list "emotions" \(owner TS-11\)/,
    );
  });

  it('reads it does not list are compared as usual', () => {
    const e = { steps: [step('p: stage4 as ada@e2e.test', 200, { data: 1 })] };
    const v = compareWithAllowList(e, { steps: [step('p: stage4 as ada@e2e.test', 500, err)] }, allow([{ read: 'needs', owner: 'TS-11' }]));
    expect(v.violations.join('\n')).toMatch(/value differs/);
  });
});
