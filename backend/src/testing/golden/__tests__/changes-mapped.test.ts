/**
 * TS-10 rule kinds (rulings R31, R32):
 *   - `changesMapped`: byte-level row changes on the target, compared through a
 *     table rename map (the analogue of `traceMapped`);
 *   - `pendingCluster`: a read of a cluster not yet on this branch may answer
 *     500 — and a listed read that answers anything else fails; its changes are
 *     compared exactly, a shifted rank only where pinned (ruling R37);
 *   - `refusedStep` (fix round 1, m1): a step the target refuses by a ruled fix.
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

  // Ruling R37: only status and the error body are blurred; a rank the 500
  // shifts must be pinned by step and path, never canonicalised wholesale.
  it('compares a listed read\'s changes exactly: an unpinned rank shift fails (R37)', () => {
    const row = (created: string, updated: string, email = 'a@x') => [{ table: 'User', after: { email, created_at: created, updated_at: updated } }];
    const e = { steps: [step('p: needs as ada@e2e.test', 200, { data: { at: '<ts:1>' } }, row('<ts:2>', '<ts:fresh>'))] };
    const v = compareWithAllowList(e, { steps: [step('p: needs as ada@e2e.test', 500, err, row('<ts:1>', '<ts:fresh>'))] }, allow([{ read: 'needs', owner: 'TS-11' }]));
    expect(v.violations.join('\n')).toMatch(/steps\.0\.changes\.0\.after\.created_at: value differs/);
  });

  it('a pinned rank shift (step + path + from → to) is admitted, and only that one', () => {
    const row = (created: string, updated: string, email = 'a@x') => [{ table: 'User', after: { email, created_at: created, updated_at: updated } }];
    const e = { steps: [step('p: needs as ada@e2e.test', 200, { data: { at: '<ts:1>' } }, row('<ts:2>', '<ts:fresh>'))] };
    const pinned: AllowList = {
      scenario: 's',
      rules: [
        {
          kind: 'pendingCluster',
          at: 'steps',
          why: 'test',
          mustMatch: true,
          reads: [
            {
              read: 'needs',
              owner: 'TS-11',
              rankShifts: [{ step: 'p: needs as ada@e2e.test', at: 'changes.0.after.created_at', from: '<ts:2>', to: '<ts:1>' }],
            },
          ],
        },
      ],
    };
    const run = (r: unknown[]) => ({ steps: [step('p: needs as ada@e2e.test', 500, err, r)] });
    expect(compareWithAllowList(e, run(row('<ts:1>', '<ts:fresh>')), pinned)).toEqual({ violations: [], unmatchedRules: [] });
    // Values and other stamps are still compared.
    expect(compareWithAllowList(e, run(row('<ts:1>', '<ts:fresh>', 'b@x')), pinned).violations.join('\n')).toMatch(/email/);
    expect(compareWithAllowList(e, run(row('<ts:1>', '<ts:3>')), pinned).violations.join('\n')).toMatch(/updated_at/);
    // A pin that does not hold fails, and so does one that never fires.
    expect(compareWithAllowList(e, run(row('<ts:3>', '<ts:fresh>')), pinned).violations.join('\n')).toMatch(
      /pinned rank shift <ts:2> → <ts:1> does not hold/,
    );
    const other = { steps: [step('q: needs as ada@e2e.test', 500, err, row('<ts:2>', '<ts:fresh>'))] };
    const eOther = { steps: [step('q: needs as ada@e2e.test', 200, { data: {} }, row('<ts:2>', '<ts:fresh>'))] };
    expect(compareWithAllowList(eOther, other, pinned).violations.join('\n')).toMatch(/rank pin never fired/);
  });

  it('reads it does not list are compared as usual', () => {
    const e = { steps: [step('p: stage4 as ada@e2e.test', 200, { data: 1 })] };
    const v = compareWithAllowList(e, { steps: [step('p: stage4 as ada@e2e.test', 500, err)] }, allow([{ read: 'needs', owner: 'TS-11' }]));
    expect(v.violations.join('\n')).toMatch(/value differs/);
  });
});

describe('refusedStep (fix round 1, m1)', () => {
  const allow: AllowList = {
    scenario: 's',
    rules: [
      {
        kind: 'refusedStep',
        at: 'steps',
        mustMatch: true,
        why: 'test',
        label: 'draft as bob',
        status: 404,
        code: 'NOT_FOUND',
        droppedWrites: [{ table: 'draft', kind: 'added' }],
      },
    ],
  };
  const userChange = { table: 'user', kind: 'changed', key: 'u' };
  const draftAdded = { table: 'draft', kind: 'added', key: 'd' };
  const e = { steps: [{ label: 'draft as bob', status: 200, body: { success: true, data: { id: 'd' } }, changes: [draftAdded, userChange] }] };
  const run = (status: number, code: string, changes: unknown[]) => ({
    steps: [{ label: 'draft as bob', status, body: { success: false, error: { code, message: 'x' } }, changes }],
  });

  it('admits the refusal: the named status and code, the dropped write absent, every other change as recorded', () => {
    expect(compareWithAllowList(e, run(404, 'NOT_FOUND', [userChange]), allow)).toEqual({ violations: [], unmatchedRules: [] });
  });
  it('fails on another status or code, on the dropped write being made, and on any other change differing', () => {
    expect(compareWithAllowList(e, run(200, 'NOT_FOUND', [userChange]), allow).violations.join('\n')).toMatch(/refusedStep: expected 404/);
    expect(compareWithAllowList(e, run(404, 'CONFLICT', [userChange]), allow).violations.join('\n')).toMatch(/refusedStep: expected 404/);
    expect(compareWithAllowList(e, run(404, 'NOT_FOUND', [draftAdded, userChange]), allow).violations.join('\n')).toMatch(
      /the run made a write the refusal must not/,
    );
    expect(compareWithAllowList(e, run(404, 'NOT_FOUND', []), allow).violations.join('\n')).toMatch(/steps\.0\.changes/);
  });
  it('a refusal the baseline never recorded as a write is a stale rule', () => {
    const e2 = { steps: [{ ...e.steps[0], changes: [userChange] }] };
    expect(compareWithAllowList(e2, run(404, 'NOT_FOUND', [userChange]), allow).violations.join('\n')).toMatch(/stale rule/);
  });
});

describe('changesMapped droppedTables (TS-11 post-merge)', () => {
  const dropRule: ChangesMappedRule = {
    ...rule,
    addedTables: [{ step: 3, table: 'participant_milestone', kind: 'added', count: 2, why: 'milestone rows' }],
    droppedTables: [{ step: 3, table: 'StageProgress', kind: 'changed', why: 'a gate update is a milestone insert' }],
  };

  it('admits a named dropped write at its exact step, with the named additions', () => {
    const base = [ch('StageProgress', 'changed'), ch('Message', 'added')];
    const run = [ch('participant_milestone', 'added'), ch('participant_milestone', 'added'), ch('message', 'added')];
    expect(compareMappedChanges(base, run, dropRule, 3)).toEqual([]);
  });

  it('is pinned to its step: the same drop at another step is a violation', () => {
    expect(compareMappedChanges([ch('StageProgress', 'changed')], [], dropRule, 4).join('\n')).toMatch(/no changed image/);
  });

  it('fails when the run still writes the image (stale), or the baseline step has no such write', () => {
    const still = [ch('participant_milestone', 'changed'), ch('participant_milestone', 'added'), ch('participant_milestone', 'added')];
    expect(compareMappedChanges([ch('StageProgress', 'changed')], still, dropRule, 3).join('\n')).toMatch(
      /but the run writes its changed image \(stale\)/,
    );
    const noBase = [ch('participant_milestone', 'added'), ch('participant_milestone', 'added')];
    expect(compareMappedChanges([], noBase, dropRule, 3).join('\n')).toMatch(/which the baseline step does not write \(stale\)/);
  });
});

describe('removedEntry (TS-11 post-merge)', () => {
  const allow: AllowList = {
    scenario: 's',
    rules: [{ kind: 'removedEntry', at: 'steps.0.changes', where: { key: 'm1' }, mustMatch: true, why: 'test' }],
  };
  const e = { steps: [{ label: 'x', changes: [{ key: 'm0', v: 1 }, { key: 'm1', v: 2 }] }] };

  it('admits the one pinned baseline entry missing from the run', () => {
    const run = { steps: [{ label: 'x', changes: [{ key: 'm0', v: 1 }] }] };
    expect(compareWithAllowList(e, run, allow)).toEqual({ violations: [], unmatchedRules: [] });
  });

  it('admits nothing else: another missing entry is still a violation', () => {
    const run = { steps: [{ label: 'x', changes: [{ key: 'm1', v: 2 }] }] };
    expect(compareWithAllowList(e, run, allow).violations.length).toBeGreaterThan(0);
  });

  it('keeps the entry when the run still holds it, and goes unmatched when the baseline lacks it', () => {
    expect(compareWithAllowList(e, e, allow)).toEqual({ violations: [], unmatchedRules: [] });
    const none = { steps: [{ label: 'x', changes: [{ key: 'm0', v: 1 }] }] };
    expect(compareWithAllowList(none, none, allow).unmatchedRules).toHaveLength(1);
  });
});
