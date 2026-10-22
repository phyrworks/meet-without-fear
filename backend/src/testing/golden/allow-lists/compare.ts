/**
 * Golden harness — the allow-list comparator for normalised (concept) baselines.
 *
 * Pure: no database, no files. `runner.ts` records and verifies; this decides
 * whether a run is accepted under a scenario's allow-list (`./types.ts`).
 */

import type {
  AbsentKeysRule,
  AddedEntriesRule,
  AddedKeysRule,
  AllowList,
  AllowRule,
  MayBeAbsentRule,
  ReplacedEntryRule,
  TiedOrderRule,
} from './types';

function brief(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

// ============================================================================
// Allow-list comparison — the normalised (concept) baselines
// ============================================================================

export interface AllowListComparison {
  /** Every difference no rule names. Empty means the run is accepted. */
  violations: string[];
  /** Rules marked `mustMatch` whose pattern matched nothing in the baseline. */
  unmatchedRules: string[];
}

/** `*` = one segment, `**` = zero or more. */
function matchPath(pattern: string[], p: string[]): boolean {
  const go = (i: number, j: number): boolean => {
    if (i === pattern.length) return j === p.length;
    if (pattern[i] === '**') {
      for (let k = j; k <= p.length; k++) if (go(i + 1, k)) return true;
      return false;
    }
    if (j === p.length) return false;
    return (pattern[i] === '*' || pattern[i] === p[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function getDotted(v: unknown, dotted: string): unknown {
  let cur = v;
  for (const k of dotted.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Key-order-independent JSON. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x,
  );
}

/** A deep copy of `base` with each dot path in `overrides` set to its value. */
function withOverrides(base: unknown, overrides: Record<string, unknown>): unknown {
  const out = JSON.parse(JSON.stringify(base ?? {})) as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    const parts = path.split('.');
    let cur: Record<string, unknown> = out;
    for (const k of parts.slice(0, -1)) {
      if (!isObj(cur[k])) cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  }
  return out;
}

/**
 * `tiedOrder` (TS-5 fix round 3): in an array at a matching path, each run of
 * CONSECUTIVE entries whose `key` value is equal is put into canonical order;
 * entries with different keys keep their relative order. Applied to both
 * sides before any comparison (byte-level and normalised), so rows an
 * endpoint returns in database heap order because they tie on its only sort
 * key (rows one request wrote in one millisecond, or run-written stamps that
 * all normalise to `<ts:fresh>`) compare as a multiset within the tie, and as
 * a sequence across it. A changed value or a missing row still differs.
 */
export function applyTiedOrder(value: unknown, rules: readonly AllowRule[]): unknown {
  const tied = rules.filter((r): r is TiedOrderRule => r.kind === 'tiedOrder');
  if (!tied.length) return value;
  const patterns = tied.map(r => ({ key: r.key, pats: (Array.isArray(r.at) ? r.at : [r.at]).map(p => p.split('.')) }));
  const go = (v: unknown, p: string[]): unknown => {
    if (Array.isArray(v)) {
      let arr = v.map((x, i) => go(x, [...p, String(i)]));
      for (const { key, pats } of patterns) {
        if (!pats.some(pat => matchPath(pat, p))) continue;
        const out: unknown[] = [];
        let run: unknown[] = [];
        const flush = () => {
          out.push(...run.sort((x, y) => (canon(x) < canon(y) ? -1 : canon(x) > canon(y) ? 1 : 0)));
          run = [];
        };
        for (const x of arr) {
          if (run.length && JSON.stringify(getDotted(run[0], key)) !== JSON.stringify(getDotted(x, key))) flush();
          run.push(x);
        }
        flush();
        arr = out;
      }
      return arr;
    }
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, go(x, [...p, k])]));
    return v;
  };
  return go(value, []);
}

/**
 * Compare a run against its normalised baseline under an allow-list:
 * "subset plus named changes". Every baseline value must be present and equal
 * in the run unless a rule names the change; every key or entry the run adds
 * must be named; anything else is a violation.
 *
 * Unlike `diffJson` it never short-circuits on equal subtrees, so a rule's
 * match count reflects the whole baseline — that is what lets a `mustMatch`
 * rule report that its path no longer exists.
 */
export function compareWithAllowList(expected0: unknown, actual0: unknown, allow: AllowList): AllowListComparison {
  const expected = applyTiedOrder(expected0, allow.rules);
  const actual = applyTiedOrder(actual0, allow.rules);
  const rules = allow.rules.map(rule => ({
    rule,
    patterns: (Array.isArray(rule.at) ? rule.at : [rule.at]).map(p => p.split('.')),
    matched: 0,
    expValues: new Set<string>(),
    actValues: new Set<string>(),
  }));
  type Entry = (typeof rules)[number];
  const rulesAt = <K extends AllowRule['kind']>(kind: K, p: string[]): Entry[] =>
    rules.filter(r => r.rule.kind === kind && r.patterns.some(pat => matchPath(pat, p)));
  const violations: string[] = [];
  const show = (p: string[]): string => p.join('.') || '<root>';
  const fail = (p: string[], what: string, e?: unknown, a?: unknown): void => {
    violations.push(
      `  ${show(p)}: ${what}` +
        (e !== undefined || a !== undefined ? `\n    expected: ${brief(e)}\n    actual:   ${brief(a)}` : ''),
    );
  };
  /**
   * Find an unused `addedEntries` rule that admits `value` and consume it.
   * Each rule admits at most ONE entry per container: a rule names one
   * expected row, so a duplicate of it (or a second row that merely shares its
   * predicate) is a violation, not a second admission. `$key` in `where`
   * matches the entry's map key (for label-keyed row maps).
   */
  const admitEntry = (entries: Entry[], used: Set<Entry>, value: unknown, mapKey?: string): boolean => {
    const r = entries.find(x => {
      if (used.has(x)) return false;
      const rule = x.rule as AddedEntriesRule;
      // `exact`: the entry is exactly the object `where` spells out — no field
      // it does not name, so an unnamed field cannot ride in.
      if (rule.exact) return canon(value) === canon(withOverrides({}, rule.where));
      return Object.entries(rule.where).every(
        ([k, v]) => JSON.stringify(k === '$key' ? mapKey : getDotted(value, k)) === JSON.stringify(v),
      );
    });
    if (!r) return false;
    used.add(r);
    return true;
  };

  const satisfies = (value: unknown, where: Record<string, unknown>, mapKey?: string): boolean =>
    Object.entries(where).every(
      ([k, v]) => JSON.stringify(k === '$key' ? mapKey : getDotted(value, k)) === JSON.stringify(v),
    );

  const walk = (e0: unknown, a0: unknown, p: string[]): void => {
    if (Array.isArray(e0) && Array.isArray(a0)) {
      let e: unknown[] = e0;
      let a: unknown[] = a0;
      // `replacedEntry`: the baseline entry matching `where`, with the `with`
      // overrides applied, must EQUAL one run entry (every other field as
      // recorded); then both leave the positional comparison (TS-5). If no run
      // entry equals it, nothing is removed and the positional comparison
      // reports the difference.
      for (const r of rulesAt('replacedEntry', p)) {
        const rule = r.rule as ReplacedEntryRule;
        const ei = e.findIndex(x => satisfies(x, rule.where));
        if (ei >= 0) r.matched++;
        if (ei < 0) continue;
        const want = canon(withOverrides(e[ei], rule.with));
        const ai = a.findIndex(x => canon(x) === want);
        if (ai < 0) continue;
        e = e.filter((_, i) => i !== ei);
        a = a.filter((_, i) => i !== ai);
      }
      const adders = rulesAt('addedEntries', p);
      adders.forEach(r => r.matched++);
      let rest = a;
      if (adders.length) {
        const inBaseline = new Set(e.map(x => JSON.stringify(x)));
        const used = new Set<Entry>();
        rest = a.filter(x => inBaseline.has(JSON.stringify(x)) || !admitEntry(adders, used, x));
      }
      if (e.length !== rest.length) fail([...p, 'length'], 'array length differs', e.length, rest.length);
      for (let i = 0; i < Math.max(e.length, rest.length); i++) {
        if (i < e.length && i < rest.length) walk(e[i], rest[i], [...p, String(i)]);
        else if (i < e.length) fail([...p, String(i)], 'entry missing', e[i], undefined);
        else fail([...p, String(i)], 'entry added and not on the allow-list', undefined, rest[i]);
      }
      return;
    }
    const e = e0;
    const a = a0;
    if (isObj(e) && isObj(a)) {
      const absent = new Set(rulesAt('absentKeys', p).flatMap(r => (r.matched++, (r.rule as AbsentKeysRule).keys)));
      const added = new Set(rulesAt('addedKeys', p).flatMap(r => (r.matched++, (r.rule as AddedKeysRule).keys)));
      const removable = new Set(
        rulesAt('mayBeAbsent', p).flatMap(r => (r.matched++, (r.rule as MayBeAbsentRule).keys)),
      );
      const adders = rulesAt('addedEntries', p);
      adders.forEach(r => r.matched++);
      const used = new Set<Entry>();
      for (const k of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
        const kp = [...p, k];
        const inE = Object.prototype.hasOwnProperty.call(e, k);
        const inA = Object.prototype.hasOwnProperty.call(a, k);
        if (absent.has(k)) {
          if (inA) fail(kp, 'must be absent in the re-shaped run', inE ? e[k] : undefined, a[k]);
          continue;
        }
        if (inE && !inA) {
          if (!removable.has(k)) fail(kp, 'present in the baseline, missing from the run', e[k], undefined);
          continue;
        }
        if (!inE && inA) {
          if (added.has(k)) {
            // `each`: the added value must be an array whose every entry
            // satisfies the predicate (TS-5: a step's concept changes where
            // the baseline could record none).
            for (const r of rulesAt('addedKeys', p)) {
              const rule = r.rule as AddedKeysRule;
              if (!rule.each || !rule.keys.includes(k)) continue;
              const v = a[k];
              const bad = Array.isArray(v) ? v.filter(x => !satisfies(x, rule.each!)) : [v];
              if (bad.length) fail(kp, 'added value outside the rule’s `each` predicate', rule.each, bad);
            }
          } else if (!admitEntry(adders, used, a[k], k)) {
            fail(kp, 'added and not on the allow-list', undefined, a[k]);
          }
          continue;
        }
        const differ = rulesAt('mayDiffer', kp);
        if (differ.length) {
          differ.forEach(r => r.matched++);
          continue;
        }
        const subsets = rulesAt('valuesSubset', kp);
        if (subsets.length) {
          for (const r of subsets) {
            r.matched++;
            r.expValues.add(JSON.stringify(e[k]));
            r.actValues.add(JSON.stringify(a[k]));
          }
          continue;
        }
        walk(e[k], a[k], kp);
      }
      return;
    }
    if (JSON.stringify(e) !== JSON.stringify(a)) fail(p, 'value differs', e, a);
  };

  walk(expected, actual, []);

  for (const r of rules) {
    if (r.rule.kind !== 'valuesSubset') continue;
    const extra = [...r.actValues].filter(v => !r.expValues.has(v));
    if (extra.length) {
      violations.push(
        `  valuesSubset @ ${[r.rule.at].flat().join(', ')}: value(s) ${extra.join(', ')} not in the baseline's set ` +
          `[${[...r.expValues].join(', ')}]`,
      );
    }
  }

  return {
    violations,
    unmatchedRules: rules
      .filter(r => r.rule.mustMatch && r.matched === 0)
      .map(r => `${r.rule.kind} @ ${[r.rule.at].flat().join(', ')}`),
  };
}
