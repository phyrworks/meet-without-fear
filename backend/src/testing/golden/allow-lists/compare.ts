/**
 * Golden harness — the allow-list comparator for normalised (concept) baselines.
 *
 * Pure: no database, no files. `runner.ts` records and verifies; this decides
 * whether a run is accepted under a scenario's allow-list (`./types.ts`).
 */

import type { AbsentKeysRule, AddedEntriesRule, AddedKeysRule, AllowList, AllowRule } from './types';

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
export function compareWithAllowList(expected: unknown, actual: unknown, allow: AllowList): AllowListComparison {
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
    const r = entries.find(
      x =>
        !used.has(x) &&
        Object.entries((x.rule as AddedEntriesRule).where).every(
          ([k, v]) => JSON.stringify(k === '$key' ? mapKey : getDotted(value, k)) === JSON.stringify(v),
        ),
    );
    if (!r) return false;
    used.add(r);
    return true;
  };

  const walk = (e: unknown, a: unknown, p: string[]): void => {
    if (Array.isArray(e) && Array.isArray(a)) {
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
    if (isObj(e) && isObj(a)) {
      const absent = new Set(rulesAt('absentKeys', p).flatMap(r => (r.matched++, (r.rule as AbsentKeysRule).keys)));
      const added = new Set(rulesAt('addedKeys', p).flatMap(r => (r.matched++, (r.rule as AddedKeysRule).keys)));
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
          fail(kp, 'present in the baseline, missing from the run', e[k], undefined);
          continue;
        }
        if (!inE && inA) {
          if (!added.has(k) && !admitEntry(adders, used, a[k], k))
            fail(kp, 'added and not on the allow-list', undefined, a[k]);
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
