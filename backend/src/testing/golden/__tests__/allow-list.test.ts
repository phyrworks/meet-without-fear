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

import { alignTies, compareWithAllowList, rawTieRanges } from '../allow-lists/compare';
import { LabelMap, normalize } from '../normalize';
import { diffJson } from '../runner';
import type { AllowList } from '../allow-lists/types';
import { EMPATHY_REVEAL_ALLOW } from '../allow-lists/empathy-reveal';
import { SESSION_READ_ALLOW } from '../allow-lists/session-read';
import {
  ADA_ORIGINAL,
  ADA_REVISED,
  R2_RESUBMIT_STEP,
  R2_REVEAL_STEP,
  UNREVEALED_ATTEMPT_HIDDEN_ALLOW,
} from '../allow-lists/unrevealed-attempt-hidden';

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
  // ... and the two delivered EMPATHY_STATEMENT copies the migration writes,
  // one into each subject's conversation.
  t.steps[0].changes.push(deliveredCopy('ada', 'bob'), deliveredCopy('bob', 'ada'));
  return t;
}

/** A delivered copy of `author`'s statement, as the target writes it into `subject`'s conversation. */
function deliveredCopy(author: string, subject: string): Json {
  const key = `<message:${subject}@main/EMPATHY_STATEMENT:${author}#1>`;
  return {
    view: 'message',
    kind: 'added',
    key,
    after: {
      id: key,
      kind: 'EMPATHY_STATEMENT',
      role: 'USER',
      conversation_id: `<conversation:${subject}@main/MAIN>`,
      sender_participant_id: `<participant:${author}@main>`,
      source_attempt_id: `<empathyAttempt:${author}→${subject}@main#1>`,
      content: `${author}'s statement`,
    },
  };
}

describe('compareWithAllowList — empathy-reveal (old ⊆ new, named additions)', () => {
  it('passes trivially on the current shape', () => {
    const r = compareWithAllowList(revealBaseline(), revealBaseline(), EMPATHY_REVEAL_ALLOW);
    expect(r.violations).toEqual([]);
    // TS-10's target rules are pinned to steps of the recorded scenario
    // (status_version at steps 1/3/6) that this synthetic baseline does not
    // have; every other rule must match.
    expect(r.unmatchedRules).toEqual([
      'mayDiffer @ steps.3.body.data.attempt.statusVersion, steps.6.body.data.attempt.statusVersion',
      'replacedEntry @ steps.1.changes',
      'replacedEntry @ steps.1.changes',
    ]);
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
    t.steps[0].changes.push({
      view: 'message',
      kind: 'added',
      key: '<message:bob@main#11>',
      after: { kind: 'CHAT', role: 'AI' },
    });
    const r = compareWithAllowList(revealBaseline(), t, EMPATHY_REVEAL_ALLOW);
    expect(r.violations.join('\n')).toContain('steps.0.changes');
  });

  // The review probe's case (a): Ada's statement copied into Ada's OWN
  // conversation, twice, carrying the wrong lineage. A kind-only predicate
  // accepted it.
  it("rejects a copy into the author's own conversation, duplicated, with the wrong lineage", () => {
    const t = revealTargetLike();
    for (const n of [2, 3]) {
      const key = `<message:ada@main/EMPATHY_STATEMENT:ada#${n}>`;
      t.steps[0].changes.push({
        view: 'message',
        kind: 'added',
        key,
        after: {
          id: key,
          kind: 'EMPATHY_STATEMENT',
          role: 'USER',
          conversation_id: '<conversation:ada@main/MAIN>',
          source_attempt_id: '<empathyAttempt:bob→ada@main#1>',
          content: 'leaked',
        },
      });
    }
    const r = compareWithAllowList(revealBaseline(), t, EMPATHY_REVEAL_ALLOW);
    const text = r.violations.join('\n');
    expect(text).toContain('<message:ada@main/EMPATHY_STATEMENT:ada#2>');
    expect(text).toContain('<message:ada@main/EMPATHY_STATEMENT:ada#3>');
  });

  it('rejects the right copy delivered with the wrong lineage, or into the wrong conversation', () => {
    for (const mutate of [
      (c: Json) => (c.after.source_attempt_id = '<empathyAttempt:bob→ada@main#1>'),
      (c: Json) => (c.after.conversation_id = '<conversation:ada@main/MAIN>'),
      (c: Json) => (c.after.sender_participant_id = null),
    ]) {
      const t = revealTargetLike();
      mutate(t.steps[0].changes.find((c: Json) => c.key === '<message:bob@main/EMPATHY_STATEMENT:ada#1>'));
      expect(compareWithAllowList(revealBaseline(), t, EMPATHY_REVEAL_ALLOW).violations).not.toEqual([]);
    }
  });

  it('admits each expected copy once: a duplicate of a correct copy is rejected', () => {
    const t = revealTargetLike();
    t.steps[0].changes.push(deliveredCopy('ada', 'bob'));
    const r = compareWithAllowList(revealBaseline(), t, EMPATHY_REVEAL_ALLOW);
    expect(r.violations).toEqual([
      expect.stringContaining('steps.0.changes.length'),
      expect.stringContaining('entry added and not on the allow-list'),
    ]);
  });

  // The review probe's case (b): unrevealed Bob text sitting in Ada's
  // conversation in the restored state. Nothing may be added to `initial`.
  it("rejects an initial message row holding the partner's unrevealed statement", () => {
    const base = revealBaseline();
    base.initial = { message: { '<message:ada@main#1>': { kind: 'CHAT' } } };
    const t = clone(base);
    t.initial.message['<message:ada@main/EMPATHY_STATEMENT:bob#1>'] = {
      kind: 'EMPATHY_STATEMENT',
      conversation_id: '<conversation:ada@main/MAIN>',
      content: 'unrevealed bob text',
    };
    const r = compareWithAllowList(base, t, EMPATHY_REVEAL_ALLOW);
    expect(r.violations).toEqual([
      expect.stringContaining('initial.message.<message:ada@main/EMPATHY_STATEMENT:bob#1>'),
    ]);
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
    const base = readBaseline({
      compactSigned: true,
      feelHeardConfirmed: true,
      readyToRank: true,
      feelHeardCheckOffered: true,
    });
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

describe('compareWithAllowList — unrevealed-attempt-hidden (R2 rounds, TS-5 fix 1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const baseline: Json = require('../__golden__/unrevealed-attempt-hidden.concept.json');
  const R1 = '<empathyAttempt:ada→bob@main#1>';
  const R2 = '<empathyAttempt:ada→bob@main#2>';

  /** Round 2 as the target inserts it: every column of the view. */
  const round2 = (overrides: Json = {}): Json => ({
    view: 'empathy_attempt',
    kind: 'added',
    key: R2,
    after: {
      id: R2,
      author_participant_id: '<participant:ada@main>',
      subject_participant_id: '<participant:bob@main>',
      round: 2,
      supersedes_attempt_id: R1,
      content: ADA_REVISED,
      status: 'READY',
      status_version: 1,
      submitted_at: '<ts:fresh>',
      revealed_at: null,
      delivery_status: 'PENDING',
      delivered_at: null,
      seen_at: null,
      ...overrides,
    },
  });

  /**
   * The baseline as the target would record it, built from the RECORDED rows
   * (complete objects, not predicates): resubmit = round 1 superseded + round
   * 2 inserted; reveal = round 2 revealed. `mutate` corrupts it for negatives.
   */
  function targetLike(copySource = R2, mutate: (t: Json) => void = () => undefined): Json {
    const t = clone(baseline);
    const rs = t.steps[R2_RESUBMIT_STEP].changes;
    const r1 = rs.find((c: Json) => c.view === 'empathy_attempt' && c.key === R1);
    r1.changedFields = ['status', 'status_version'];
    Object.assign(r1.after, { round: 1, content: ADA_ORIGINAL, status: 'SUPERSEDED', status_version: 2 });
    rs.push(round2());
    const m = rs.find((c: Json) => c.key === '<message:ada@main/EMPATHY_STATEMENT:ada#2>');
    m.after.source_attempt_id = R2;
    const rv = t.steps[R2_REVEAL_STEP].changes;
    const rev = rv.find((c: Json) => c.view === 'empathy_attempt' && c.key === R1);
    rev.key = R2;
    for (const side of ['before', 'after']) {
      Object.assign(rev[side], { id: R2, supersedes_attempt_id: R1, submitted_at: '<ts:fresh>' });
    }
    rev.before.status_version = 1;
    rev.after.status_version = 2;
    mutate(t);
    for (const [author, subject, src] of [
      ['ada', 'bob', copySource],
      ['bob', 'ada', '<empathyAttempt:bob→ada@main#1>'],
    ]) {
      rv.push({
        view: 'message',
        kind: 'added',
        key: `<message:${subject}@main/EMPATHY_STATEMENT:${author}#1>`,
        after: {
          kind: 'EMPATHY_STATEMENT',
          role: 'USER',
          conversation_id: `<conversation:${subject}@main/MAIN>`,
          sender_participant_id: `<participant:${author}@main>`,
          source_attempt_id: src,
        },
      });
    }
    return t;
  }

  it('accepts the target’s round-2 representation of the resubmit and the reveal', () => {
    expect(compareWithAllowList(baseline, targetLike(), UNREVEALED_ATTEMPT_HIDDEN_ALLOW).violations).toEqual([]);
  });

  it('passes trivially on the current shape', () => {
    expect(compareWithAllowList(baseline, baseline, UNREVEALED_ATTEMPT_HIDDEN_ALLOW)).toEqual({
      violations: [],
      unmatchedRules: [],
    });
  });

  it('rejects a delivered copy of the superseded round 1', () => {
    expect(compareWithAllowList(baseline, targetLike(R1), UNREVEALED_ATTEMPT_HIDDEN_ALLOW).violations).not.toEqual([]);
  });

  it('rejects a target that stamps revealed_at on the superseded round 1 at the resubmit', () => {
    const t = targetLike(R2, x => {
      const r1 = x.steps[R2_RESUBMIT_STEP].changes.find((c: Json) => c.key === R1 && c.view === 'empathy_attempt');
      r1.after.revealed_at = '<ts:fresh>';
    });
    expect(compareWithAllowList(baseline, t, UNREVEALED_ATTEMPT_HIDDEN_ALLOW).violations).not.toEqual([]);
  });

  it('rejects a round 2 inserted already delivered, or carrying an extra field', () => {
    for (const bad of [round2({ delivery_status: 'DELIVERED', delivered_at: '<ts:fresh>' }), round2({ extra: 1 })]) {
      const t = targetLike(R2, x => {
        const rs = x.steps[R2_RESUBMIT_STEP].changes;
        rs[rs.findIndex((c: Json) => c.key === R2)] = bad;
      });
      expect(compareWithAllowList(baseline, t, UNREVEALED_ATTEMPT_HIDDEN_ALLOW).violations).not.toEqual([]);
    }
  });

  it('rejects a reveal step that also stamps the superseded round', () => {
    const t = targetLike(R2, x => {
      const rv = x.steps[R2_REVEAL_STEP].changes;
      const rev = rv.find((c: Json) => c.key === R2);
      rev.after.supersedes_attempt_id = null;
    });
    expect(compareWithAllowList(baseline, t, UNREVEALED_ATTEMPT_HIDDEN_ALLOW).violations).not.toEqual([]);
  });

  it('rejects the delivered copy written by any step other than the reveal', () => {
    const t = targetLike();
    const copy = t.steps[R2_REVEAL_STEP].changes.pop();
    t.steps[R2_REVEAL_STEP + 1].changes.push(copy);
    expect(compareWithAllowList(baseline, t, UNREVEALED_ATTEMPT_HIDDEN_ALLOW).violations).not.toEqual([]);
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

  it('mayDiffer lets a value change but not disappear, and only at its path (TS-5)', () => {
    const list: AllowList = {
      scenario: 'x',
      rules: [{ kind: 'mayDiffer', at: 'steps.*.body.partnerNeeds.*.need', mustMatch: true, why: 'test' }],
    };
    const base = { steps: [{ body: { partnerNeeds: [{ need: 'label', category: 'SAFETY' }] } }] };
    const changed = { steps: [{ body: { partnerNeeds: [{ need: 'shared text', category: 'SAFETY' }] } }] };
    const gone = { steps: [{ body: { partnerNeeds: [{ category: 'SAFETY' }] } }] };
    const elsewhere = { steps: [{ body: { partnerNeeds: [{ need: 'label', category: 'FAIRNESS' }] } }] };
    expect(compareWithAllowList(base, base, list)).toEqual({ violations: [], unmatchedRules: [] });
    expect(compareWithAllowList(base, changed, list).violations).toEqual([]);
    expect(compareWithAllowList(base, gone, list).violations).toEqual([expect.stringContaining('partnerNeeds.0.need')]);
    expect(compareWithAllowList(base, elsewhere, list).violations).toEqual([expect.stringContaining('category')]);
  });

  it('mayBeAbsent lets a key disappear, holds when it stays equal, and still compares it when present (TS-5)', () => {
    const list: AllowList = {
      scenario: 'x',
      rules: [{ kind: 'mayBeAbsent', at: 'steps.*', keys: ['unrepresentable'], mustMatch: true, why: 'test' }],
    };
    const base = { steps: [{ label: 's', unrepresentable: 'reason' }] };
    expect(compareWithAllowList(base, base, list)).toEqual({ violations: [], unmatchedRules: [] });
    expect(compareWithAllowList(base, { steps: [{ label: 's' }] }, list).violations).toEqual([]);
    expect(compareWithAllowList(base, { steps: [{ label: 's', unrepresentable: 'other' }] }, list).violations).toEqual([
      expect.stringContaining('steps.0.unrepresentable'),
    ]);
    expect(compareWithAllowList(base, { steps: [{ unrepresentable: 'reason' }] }, list).violations).toEqual([
      expect.stringContaining('steps.0.label'),
    ]);
  });

  it('addedKeys with `each` admits the key only if every entry of its array satisfies the predicate (TS-5)', () => {
    const list: AllowList = {
      scenario: 'x',
      rules: [
        { kind: 'addedKeys', at: 'steps.1', keys: ['changes'], each: { view: 'user', key: '<user:bob>' }, why: 'test' },
      ],
    };
    const base = { steps: [{ changes: [] }, { label: 'after' }] };
    const ok = { steps: [{ changes: [] }, { label: 'after', changes: [{ view: 'user', key: '<user:bob>' }] }] };
    const empty = { steps: [{ changes: [] }, { label: 'after', changes: [] }] };
    const bad = {
      steps: [
        { changes: [] },
        {
          label: 'after',
          changes: [
            { view: 'user', key: '<user:bob>' },
            { view: 'message', key: 'm' },
          ],
        },
      ],
    };
    expect(compareWithAllowList(base, ok, list).violations).toEqual([]);
    expect(compareWithAllowList(base, empty, list).violations).toEqual([]);
    expect(compareWithAllowList(base, bad, list).violations).toEqual([expect.stringContaining('steps.1.changes')]);
    // Not on step 0: there `changes` is in the baseline and compared as usual.
    const elsewhere = { steps: [{ changes: [{ view: 'user', key: '<user:bob>' }] }, { label: 'after' }] };
    expect(compareWithAllowList(base, elsewhere, list).violations).not.toEqual([]);
  });

  it('replacedEntry swaps exactly one baseline entry for one pinned run entry (TS-5)', () => {
    const list: AllowList = {
      scenario: 'x',
      rules: [
        {
          kind: 'replacedEntry',
          at: 'steps.0.changes',
          where: { key: '<attempt:#1>', 'after.status': 'REVEALED' },
          with: { key: '<attempt:#2>', 'after.status': 'REVEALED' },
          mustMatch: true,
          why: 'test',
        },
      ],
    };
    const base = { steps: [{ changes: [{ key: '<attempt:#1>', after: { status: 'REVEALED' } }, { key: 'm' }] }] };
    const ok = { steps: [{ changes: [{ key: '<attempt:#2>', after: { status: 'REVEALED' } }, { key: 'm' }] }] };
    const wrong = { steps: [{ changes: [{ key: '<attempt:#2>', after: { status: 'READY' } }, { key: 'm' }] }] };
    const both = {
      steps: [
        {
          changes: [
            { key: '<attempt:#1>', after: { status: 'REVEALED' } },
            { key: '<attempt:#2>', after: { status: 'REVEALED' } },
            { key: 'm' },
          ],
        },
      ],
    };
    expect(compareWithAllowList(base, base, list).violations).toEqual([]);
    expect(compareWithAllowList(base, ok, list).violations).toEqual([]);
    expect(compareWithAllowList(base, wrong, list).violations).not.toEqual([]);
    expect(compareWithAllowList(base, both, list).violations).not.toEqual([]);
  });

  describe('tiedOrder — ties keyed on the RAW sort key (fix round 4)', () => {
    const rules = [{ kind: 'tiedOrder' as const, at: 'steps.*.body.data.records', key: 'createdAt', why: 'test' }];
    const list: AllowList = { scenario: 'x', rules };
    const T0 = '2026-10-22T10:00:00.000Z';
    const T1 = '2026-10-22T10:00:00.001Z'; // 1 ms later: normalises to the same <ts:fresh>
    const OLD = '2026-10-21T09:00:00.000Z';
    const window = { from: '2026-10-22T09:59:00.000Z', to: '2026-10-22T10:01:00.000Z' };
    const map: LabelMap = {
      labels: new Map([
        ['0190f3a2-6c1e-7b4d-9a8e-000000000001', '<c:1>'],
        ['0190f3a2-6c1e-7b4d-9a8e-000000000002', '<c:2>'],
        ['0190f3a2-6c1e-7b4d-9a8e-000000000003', '<c:3>'],
      ]),
    };
    const id = (n: number) => `0190f3a2-6c1e-7b4d-9a8e-00000000000${n}`;
    /** One step's golden as the runner builds it: the normalised payload plus its raw tie ranges. */
    const step = (raw: Json): Json => {
      const tiedRanges = rawTieRanges(raw, rules, ['steps', '0']);
      return {
        ...(normalize(raw, map, window).value as Json),
        ...(Object.keys(tiedRanges).length ? { tiedRanges } : {}),
      };
    };
    const golden = (rows: Array<[number, string, Json?]>): Json => ({
      steps: [
        step({ body: { data: { records: rows.map(([n, at, extra]) => ({ id: id(n), createdAt: at, ...extra })) } } }),
      ],
    });
    /** Both comparisons, as the runner makes them. */
    const concept = (e: Json, a: Json) => compareWithAllowList(...alignTies(e, a), list).violations;
    const byte = (e: Json, a: Json) => diffJson(...alignTies(e, a));

    it('rows in the same millisecond compare equal in either order — normalised and byte-level', () => {
      const a = golden([
        [3, OLD],
        [1, T0],
        [2, T0],
      ]);
      const b = golden([
        [3, OLD],
        [2, T0],
        [1, T0],
      ]);
      expect(a.steps[0].body.data.records[1].createdAt).toBe('<ts:fresh>');
      expect(a.steps[0].tiedRanges).toEqual({ 'body.data.records': [[1, 3]] });
      expect(concept(a, b)).toEqual([]);
      expect(byte(a, b)).toBeNull();
    });

    it('a tie on only one side (recorded tied, verified 1 ms apart, or the reverse) still compares equal', () => {
      const tiedHeap = golden([
        [3, OLD],
        [1, T0],
        [2, T0],
      ]); // heap order in the recording run
      const apart = golden([
        [3, OLD],
        [2, T1],
        [1, T0],
      ]); // the endpoint's order when not tied
      expect(apart.steps[0].tiedRanges).toBeUndefined();
      expect(concept(tiedHeap, apart)).toEqual([]);
      expect(byte(apart, tiedHeap)).toBeNull();
    });

    it('rows 1 ms apart that normalise to the same <ts:fresh> keep their order: a swap FAILS', () => {
      const a = golden([
        [3, OLD],
        [1, T0],
        [2, T1],
      ]);
      const b = golden([
        [3, OLD],
        [2, T1],
        [1, T0],
      ]);
      expect(JSON.stringify(a.steps[0].body.data.records.map((r: Json) => r.createdAt))).toBe(
        JSON.stringify(b.steps[0].body.data.records.map((r: Json) => r.createdAt)),
      );
      expect(concept(a, b)).not.toEqual([]);
      expect(byte(a, b)).not.toBeNull();
    });

    it('a changed value or a missing row in a genuine tie still fails', () => {
      const a = golden([
        [3, OLD],
        [1, T0],
        [2, T0],
      ]);
      const changed = golden([
        [3, OLD],
        [2, T0],
        [1, T0, { decision: 'DENIED' }],
      ]);
      const missing = golden([
        [3, OLD],
        [1, T0],
      ]);
      for (const bad of [changed, missing]) {
        expect(concept(a, bad)).not.toEqual([]);
        expect(byte(a, bad)).not.toBeNull();
      }
    });

    it('does nothing at other paths', () => {
      const g = (ns: number[]) => ({
        steps: [step({ body: { data: { items: ns.map(n => ({ id: id(n), createdAt: T0 })) } } })],
      });
      expect(g([1, 2]).steps[0].tiedRanges).toBeUndefined();
      expect(byte(g([1, 2]), g([2, 1]))).not.toBeNull();
    });
  });

  it('allows added entries in a keyed map of rows by predicate', () => {
    const list: AllowList = {
      scenario: 'x',
      rules: [{ kind: 'addedEntries', at: 'initial.message', where: { kind: 'EMPATHY_STATEMENT' }, why: 'test' }],
    };
    const base = { initial: { message: { '<message:a#1>': { kind: 'CHAT' } } } };
    const ok = {
      initial: { message: { '<message:a#1>': { kind: 'CHAT' }, '<message:b/E:a#1>': { kind: 'EMPATHY_STATEMENT' } } },
    };
    const bad = { initial: { message: { '<message:a#1>': { kind: 'CHAT' }, '<message:a#2>': { kind: 'CHAT' } } } };
    expect(compareWithAllowList(base, ok, list).violations).toEqual([]);
    expect(compareWithAllowList(base, bad, list).violations).toEqual([expect.stringContaining('<message:a#2>')]);
  });
});
