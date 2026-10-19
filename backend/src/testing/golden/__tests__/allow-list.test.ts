/**
 * Unit tests for the allow-list comparator (`compareWithAllowList`).
 *
 * The comparator is what replaces byte-identity once the database is
 * re-shaped, so it is the place a false pass would hide. The acceptance
 * criterion is the same as for the harness itself: it must FAIL on a change
 * the allow-list does not name. Each scenario's real allow-list is exercised
 * against a fabricated "target-like" body — the baseline plus exactly the
 * changes the plan permits — and against the same body with one unlisted
 * change.
 */

import { compareWithAllowList } from '../runner';
import type { AllowList } from '../allow-lists/types';
import { EMPATHY_REVEAL_ALLOW } from '../allow-lists/empathy-reveal';
import { SESSION_READ_ALLOW } from '../allow-lists/session-read';

// Fabricated golden JSON, mutated freely by each test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const clone = (v: Json): Json => JSON.parse(JSON.stringify(v));

/** Shaped like the empathy-reveal concept baseline's read-back steps. */
function revealBaseline(): Json {
  return {
    scenario: 'empathy-reveal',
    initial: {},
    steps: [
      {
        label: 'empathy status as ada',
        status: 200,
        body: {
          data: {
            myAttempt: { id: '<empathyAttempt:ada→bob@main#1>', status: 'REVEALED', revealedAt: '<ts:fresh>' },
            partnerAttempt: { id: '<empathyAttempt:bob→ada@main#1>', status: 'REVEALED', revealedAt: '<ts:fresh>' },
          },
        },
        changes: [
          { view: 'message', kind: 'added', key: '<message:ada@main#14>', after: { kind: 'CHAT', role: 'AI' } },
        ],
      },
      {
        label: 'partner empathy as bob',
        status: 200,
        body: { data: { attempt: { id: '<empathyAttempt:ada→bob@main#1>', statusVersion: 3 }, validated: false } },
        changes: [],
      },
    ],
  };
}

/** The plan's target-shaped re-record: `round` and `attemptId` added on reveal payloads. */
function revealTargetLike(): Json {
  const t = clone(revealBaseline());
  const d0 = t.steps[0].body.data as Record<string, Record<string, unknown>>;
  d0.myAttempt.round = 1;
  d0.myAttempt.attemptId = d0.myAttempt.id;
  d0.partnerAttempt.round = 1;
  const d1 = t.steps[1].body.data as Record<string, Record<string, unknown>>;
  d1.attempt.round = 1;
  d1.attempt.attemptId = d1.attempt.id;
  // ... and the delivered EMPATHY_STATEMENT copy the migration writes.
  t.steps[0].changes.push({
    view: 'message',
    kind: 'added',
    key: '<message:bob@main/EMPATHY_STATEMENT:ada#1>',
    after: { kind: 'EMPATHY_STATEMENT', role: 'USER' },
  });
  return t;
}

describe('compareWithAllowList — empathy-reveal (old ⊆ new, named additions)', () => {
  it('passes trivially on the current shape', () => {
    const r = compareWithAllowList(revealBaseline(), revealBaseline(), EMPATHY_REVEAL_ALLOW);
    expect(r.violations).toEqual([]);
    expect(r.unmatchedRules).toEqual([]);
  });

  it('accepts the target-like body: round and attemptId added on reveal payloads', () => {
    const r = compareWithAllowList(revealBaseline(), revealTargetLike(), EMPATHY_REVEAL_ALLOW);
    expect(r.violations).toEqual([]);
  });

  it('rejects an added key that is not on the list', () => {
    const t = revealTargetLike();
    (t.steps[0].body.data.myAttempt as Record<string, unknown>).subjectParticipantId = '<participant:bob@main>';
    const r = compareWithAllowList(revealBaseline(), t, EMPATHY_REVEAL_ALLOW);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain('steps.0.body.data.myAttempt.subjectParticipantId');
  });

  it('rejects a listed key added somewhere other than a reveal payload', () => {
    const t = revealTargetLike();
    (t.steps[1].body.data as Record<string, unknown>).round = 1;
    const r = compareWithAllowList(revealBaseline(), t, EMPATHY_REVEAL_ALLOW);
    expect(r.violations).toEqual([expect.stringContaining('steps.1.body.data.round')]);
  });

  it('rejects a baseline key that went missing (old must be a subset of new)', () => {
    const t = revealTargetLike();
    delete (t.steps[0].body.data.partnerAttempt as Record<string, unknown>).revealedAt;
    const r = compareWithAllowList(revealBaseline(), t, EMPATHY_REVEAL_ALLOW);
    expect(r.violations).toEqual([expect.stringContaining('steps.0.body.data.partnerAttempt.revealedAt')]);
  });

  it('rejects a changed value', () => {
    const t = revealTargetLike();
    t.steps[1].body.data.attempt.statusVersion = 2;
    const r = compareWithAllowList(revealBaseline(), t, EMPATHY_REVEAL_ALLOW);
    expect(r.violations).toEqual([expect.stringContaining('steps.1.body.data.attempt.statusVersion')]);
  });

  it('rejects an added row that is not a delivered EMPATHY_STATEMENT', () => {
    const t = revealTargetLike();
    t.steps[0].changes.push({ view: 'message', kind: 'added', key: '<message:bob@main#11>', after: { kind: 'CHAT', role: 'AI' } });
    const r = compareWithAllowList(revealBaseline(), t, EMPATHY_REVEAL_ALLOW);
    expect(r.violations.join('\n')).toContain('steps.0.changes');
  });
});

/** Shaped like a session-state body of the session-read concept baseline. */
function readBaseline(gates: Record<string, unknown> = { compactSigned: true, feelHeardConfirmed: true }): Json {
  return {
    scenario: 'session-read',
    initial: {},
    steps: [
      {
        label: 'session state as ada',
        status: 200,
        body: { data: { progress: { myProgress: { stage: 2, gatesSatisfied: gates } } } },
        changes: [],
      },
      {
        label: 'consents as ada',
        status: 200,
        body: {
          data: [
            { id: '<consent:ada@main/NEED/need:ada@main#1>', targetType: 'IDENTIFIED_NEED' },
            { id: '<consent:ada@main/EMPATHY_ATTEMPT/x>', targetType: 'EMPATHY_DRAFT' },
          ],
        },
        changes: [],
      },
    ],
  };
}

describe('compareWithAllowList — session-read (identical except named)', () => {
  it('passes trivially on the current shape', () => {
    const r = compareWithAllowList(readBaseline(), readBaseline(), SESSION_READ_ALLOW);
    expect(r.violations).toEqual([]);
  });

  it('accepts the dropped gate keys being absent, and a narrowed targetType', () => {
    const base = readBaseline({ compactSigned: true, feelHeardConfirmed: true, readyToRank: true, feelHeardCheckOffered: true });
    const target = readBaseline({ compactSigned: true, feelHeardConfirmed: true });
    (target.steps[1].body.data as Array<Record<string, unknown>>)[1].targetType = 'IDENTIFIED_NEED';
    const r = compareWithAllowList(base, target, SESSION_READ_ALLOW);
    expect(r.violations).toEqual([]);
  });

  it('rejects a dropped gate key that is still present', () => {
    const base = readBaseline({ compactSigned: true, readyToRank: true });
    const r = compareWithAllowList(base, clone(base), SESSION_READ_ALLOW);
    expect(r.violations).toEqual([expect.stringContaining('gatesSatisfied.readyToRank')]);
  });

  it('rejects any other gate key changing', () => {
    const target = readBaseline({ compactSigned: true });
    const r = compareWithAllowList(readBaseline(), target, SESSION_READ_ALLOW);
    expect(r.violations).toEqual([expect.stringContaining('gatesSatisfied.feelHeardConfirmed')]);
  });

  it('rejects a targetType value the baseline never showed', () => {
    const target = readBaseline();
    (target.steps[1].body.data as Array<Record<string, unknown>>)[0].targetType = 'SHARE_OFFER';
    const r = compareWithAllowList(readBaseline(), target, SESSION_READ_ALLOW);
    expect(r.violations).toEqual([expect.stringContaining('SHARE_OFFER')]);
  });

  it('rejects an added key anywhere (nothing may be added in session-read)', () => {
    const target = readBaseline();
    (target.steps[0].body.data.progress.myProgress as Record<string, unknown>).participantId = '<participant:ada@main>';
    const r = compareWithAllowList(readBaseline(), target, SESSION_READ_ALLOW);
    expect(r.violations).toEqual([expect.stringContaining('myProgress.participantId')]);
  });
});

describe('compareWithAllowList — mechanics', () => {
  const none: AllowList = { scenario: 'x', rules: [] };

  it('compares arrays positionally and reports a length change', () => {
    const r = compareWithAllowList({ a: [1, 2] }, { a: [1, 2, 3] }, none);
    expect(r.violations).toEqual([expect.stringContaining('a.length'), expect.stringContaining('a.2: entry added')]);
  });

  it('reports a rule marked mustMatch whose path matches nothing', () => {
    const list: AllowList = {
      scenario: 'x',
      rules: [{ kind: 'absentKeys', at: 'steps.*.body.nowhere', keys: ['k'], mustMatch: true, why: 'test' }],
    };
    const r = compareWithAllowList({ steps: [{ body: {} }] }, { steps: [{ body: {} }] }, list);
    expect(r.violations).toEqual([]);
    expect(r.unmatchedRules).toEqual(['absentKeys @ steps.*.body.nowhere']);
  });

  it('matches ** across any depth', () => {
    const list: AllowList = { scenario: 'x', rules: [{ kind: 'addedKeys', at: 'a.**.b', keys: ['n'], why: 'test' }] };
    const r = compareWithAllowList({ a: { x: { y: { b: {} } } } }, { a: { x: { y: { b: { n: 1 } } } } }, list);
    expect(r.violations).toEqual([]);
  });

  it('allows added entries in a keyed map of rows by predicate', () => {
    const list: AllowList = {
      scenario: 'x',
      rules: [{ kind: 'addedEntries', at: 'initial.message', where: { kind: 'EMPATHY_STATEMENT' }, why: 'test' }],
    };
    const base = { initial: { message: { '<message:a#1>': { kind: 'CHAT' } } } };
    const ok = { initial: { message: { '<message:a#1>': { kind: 'CHAT' }, '<message:b/E:a#1>': { kind: 'EMPATHY_STATEMENT' } } } };
    const bad = { initial: { message: { '<message:a#1>': { kind: 'CHAT' }, '<message:a#2>': { kind: 'CHAT' } } } };
    expect(compareWithAllowList(base, ok, list).violations).toEqual([]);
    expect(compareWithAllowList(base, bad, list).violations).toEqual([expect.stringContaining('<message:a#2>')]);
  });
});
