/**
 * TS-10 rule kinds (ruling R32; the R31/R37 `pendingCluster` kind is gone since
 * TS-12 — no cluster is pending on the target any more):
 *   - `changesMapped`: byte-level row changes on the target, compared through a
 *     table rename map (the analogue of `traceMapped`);
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
const ch = (table: string, kind: string) => ({
  table,
  kind,
  key: 'k',
  after: { secret: 'values are not compared here' },
});

describe('changesMapped', () => {
  it('accepts mapped tables with equal 1:1 counts and the named additions at their exact step', () => {
    const base = [ch('Message', 'added'), ch('EmpathyAttempt', 'changed')];
    const run = [
      ch('message', 'added'),
      ch('message', 'added'),
      ch('message', 'added'),
      ch('empathy_attempt', 'changed'),
      ch('participant_milestone', 'added'),
    ];
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
    expect(compareMappedChanges([ch('ConsentRecord', 'added')], [], rule, 0).join('\n')).toMatch(
      /no entry in the table map/,
    );
  });

  it('a kind the baseline never wrote for that table is not in the image', () => {
    const v = compareMappedChanges(
      [ch('EmpathyAttempt', 'changed')],
      [ch('empathy_attempt', 'changed'), ch('empathy_attempt', 'removed')],
      rule,
      0,
    );
    expect(v.join('\n')).toMatch(/writes removed empathy_attempt/);
  });

  it('a 1:N mapping checks membership, not counts', () => {
    const base = [ch('StageProgress', 'changed')];
    expect(
      compareMappedChanges(
        base,
        [ch('participant_milestone', 'changed'), ch('participant_milestone', 'changed')],
        rule,
        0,
      ),
    ).toEqual([]);
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
    expect(compareWithAllowList(e, { steps: [{ label: 'x', changes: [] }] }, allow).violations.join('\n')).toMatch(
      /no added image/,
    );
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
  const e = {
    steps: [
      {
        label: 'draft as bob',
        status: 200,
        body: { success: true, data: { id: 'd' } },
        changes: [draftAdded, userChange],
      },
    ],
  };
  const run = (status: number, code: string, changes: unknown[]) => ({
    steps: [{ label: 'draft as bob', status, body: { success: false, error: { code, message: 'x' } }, changes }],
  });

  it('admits the refusal: the named status and code, the dropped write absent, every other change as recorded', () => {
    expect(compareWithAllowList(e, run(404, 'NOT_FOUND', [userChange]), allow)).toEqual({
      violations: [],
      unmatchedRules: [],
    });
  });
  it('fails on another status or code, on the dropped write being made, and on any other change differing', () => {
    expect(compareWithAllowList(e, run(200, 'NOT_FOUND', [userChange]), allow).violations.join('\n')).toMatch(
      /refusedStep: expected 404/,
    );
    expect(compareWithAllowList(e, run(404, 'CONFLICT', [userChange]), allow).violations.join('\n')).toMatch(
      /refusedStep: expected 404/,
    );
    expect(
      compareWithAllowList(e, run(404, 'NOT_FOUND', [draftAdded, userChange]), allow).violations.join('\n'),
    ).toMatch(/the run made a write the refusal must not/);
    expect(compareWithAllowList(e, run(404, 'NOT_FOUND', []), allow).violations.join('\n')).toMatch(
      /steps\.0\.changes/,
    );
  });
  it('a refusal the baseline never recorded as a write is a stale rule', () => {
    const e2 = { steps: [{ ...e.steps[0], changes: [userChange] }] };
    expect(compareWithAllowList(e2, run(404, 'NOT_FOUND', [userChange]), allow).violations.join('\n')).toMatch(
      /stale rule/,
    );
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
    expect(compareMappedChanges([ch('StageProgress', 'changed')], [], dropRule, 4).join('\n')).toMatch(
      /no changed image/,
    );
  });

  it('fails when the run still writes the image (stale), or the baseline step has no such write', () => {
    const still = [
      ch('participant_milestone', 'changed'),
      ch('participant_milestone', 'added'),
      ch('participant_milestone', 'added'),
    ];
    expect(compareMappedChanges([ch('StageProgress', 'changed')], still, dropRule, 3).join('\n')).toMatch(
      /but the run writes its changed image \(stale\)/,
    );
    const noBase = [ch('participant_milestone', 'added'), ch('participant_milestone', 'added')];
    expect(compareMappedChanges([], noBase, dropRule, 3).join('\n')).toMatch(
      /which the baseline step does not write \(stale\)/,
    );
  });
});

describe('removedEntry (TS-11 post-merge)', () => {
  const allow: AllowList = {
    scenario: 's',
    rules: [{ kind: 'removedEntry', at: 'steps.0.changes', where: { key: 'm1' }, mustMatch: true, why: 'test' }],
  };
  const e = {
    steps: [
      {
        label: 'x',
        changes: [
          { key: 'm0', v: 1 },
          { key: 'm1', v: 2 },
        ],
      },
    ],
  };

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
