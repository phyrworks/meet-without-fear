/**
 * Golden harness — the allow-list comparator for normalised (concept) baselines.
 *
 * Pure: no database, no files. `runner.ts` records and verifies; this decides
 * whether a run is accepted under a scenario's allow-list (`./types.ts`).
 */

import { PENDING_CLUSTER_READS } from './types';
import type {
  ChangesMappedRule,
  PendingClusterRule,
  AbsentKeysRule,
  AddedEntriesRule,
  AddedKeysRule,
  AllowList,
  AllowRule,
  FixtureMaskRule,
  MayBeAbsentRule,
  ReplacedEntryRule,
  TiedOrderRule,
  TraceMappedRule,
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
    isObj(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, x[k]]),
        )
      : x,
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
 * `tiedOrder` (TS-5 fix rounds 3–4). Rows an endpoint returns in heap order
 * because they tie on its only sort key must not decide a golden — but only a
 * GENUINE tie: rows with the same RAW key value (the same millisecond). Keying
 * the tie on the normalised value (round 3) merged every run-written row,
 * since all fresh stamps normalise to `<ts:fresh>`, and stopped asserting the
 * order between them.
 *
 * So the tie groups are found on the RAW step payload, before normalisation
 * (`rawTieRanges`), and recorded on the golden step as `tiedRanges` — index
 * ranges of genuinely tied entries, per array path. Comparison
 * (`alignTies`) takes the union of the baseline's and the run's ranges and
 * puts exactly those slices into canonical order on both sides; everything
 * else stays positional. Both sides matter: a tie can happen in the recording
 * run (heap order recorded) or in the verifying run (heap order observed), and
 * the endpoint's order outside a tie is not the canonical order. Rows whose
 * raw keys differ, even by a millisecond, keep the order the endpoint returned.
 */
export type TiedRanges = Record<string, Array<[number, number]>>;

/**
 * Genuine-tie ranges in one step's RAW payload: for each array at a
 * `tiedOrder` path, the [start, end) index ranges (length ≥ 2) of consecutive
 * entries whose raw `key` values are equal. Paths are dot-joined relative to
 * the step (`body.data.records`); `stepPath` (`['steps', '29']`) is prefixed
 * only to match the rules' `at` patterns.
 */
export function rawTieRanges(rawPayload: unknown, rules: readonly AllowRule[], stepPath: string[]): TiedRanges {
  const tied = rules.filter((r): r is TiedOrderRule => r.kind === 'tiedOrder');
  const out: TiedRanges = {};
  if (!tied.length) return out;
  const patterns = tied.map(r => ({ key: r.key, pats: (Array.isArray(r.at) ? r.at : [r.at]).map(p => p.split('.')) }));
  const go = (raw: unknown, p: string[]): void => {
    if (Array.isArray(raw)) {
      raw.forEach((x, i) => go(x, [...p, String(i)]));
      for (const { key, pats } of patterns) {
        if (!pats.some(pat => matchPath(pat, [...stepPath, ...p]))) continue;
        let start = 0;
        for (let i = 1; i <= raw.length; i++) {
          const ends =
            i === raw.length || JSON.stringify(getDotted(raw[i], key)) !== JSON.stringify(getDotted(raw[start], key));
          if (!ends) continue;
          if (i - start >= 2 && getDotted(raw[start], key) != null) (out[p.join('.')] ??= []).push([start, i]);
          start = i;
        }
      }
      return;
    }
    if (isObj(raw)) for (const [k, x] of Object.entries(raw)) go(x, [...p, k]);
  };
  go(rawPayload, []);
  return out;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * `fixtureMask` (TS-9, target shape only): a deep copy of one step's RAW
 * payload with every value at a mask path checked against the rule's
 * `expect` and replaced by its `baseline`. `stepPath` (`['steps', '1']`) is
 * prefixed to match the rules' `at` patterns. Returns the masked payload, how
 * many values each rule masked, and every value that failed its `expect`.
 */
export function applyFixtureMasks<T>(
  rawPayload: T,
  rules: readonly AllowRule[],
  stepPath: string[],
): { payload: T; masked: Map<FixtureMaskRule, number>; errors: string[] } {
  const masks = rules.filter((r): r is FixtureMaskRule => r.kind === 'fixtureMask');
  const masked = new Map<FixtureMaskRule, number>(masks.map(m => [m, 0]));
  const errors: string[] = [];
  if (!masks.length) return { payload: rawPayload, masked, errors };
  const copy = JSON.parse(JSON.stringify(rawPayload ?? null)) as unknown;
  const go = (v: unknown, p: string[]): unknown => {
    for (const m of masks) {
      const pats = (Array.isArray(m.at) ? m.at : [m.at]).map(x => x.split('.'));
      if (!pats.some(pat => matchPath(pat, [...stepPath, ...p]))) continue;
      const ok = m.expect === 'isoTimestamp' && typeof v === 'string' && ISO_INSTANT.test(v);
      if (!ok) {
        errors.push(`fixtureMask @ ${[...stepPath, ...p].join('.')}: expected ${m.expect}, got ${brief(v)}`);
        return v;
      }
      masked.set(m, (masked.get(m) ?? 0) + 1);
      return m.baseline;
    }
    if (Array.isArray(v)) return v.map((x, i) => go(x, [...p, String(i)]));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, go(x, [...p, k])]));
    return v;
  };
  return { payload: go(copy, []) as T, masked, errors };
}

/**
 * Copies of a baseline and a run golden (`{steps: [{…, tiedRanges?}]}`) with,
 * per step, every range in EITHER side's `tiedRanges` put into canonical order
 * on BOTH sides, and `tiedRanges` removed (it is metadata, not behaviour).
 */
export function alignTies<T>(expected: T, actual: T): [T, T] {
  const e = JSON.parse(JSON.stringify(expected)) as { steps?: Array<Record<string, unknown>> };
  const a = JSON.parse(JSON.stringify(actual)) as { steps?: Array<Record<string, unknown>> };
  const sortSlice = (step: Record<string, unknown> | undefined, path: string, [s, t]: [number, number]): void => {
    const arr = step && getDotted(step, path);
    if (!Array.isArray(arr) || arr.length < t) return;
    const slice = arr.slice(s, t).sort((x, y) => (canon(x) < canon(y) ? -1 : canon(x) > canon(y) ? 1 : 0));
    arr.splice(s, t - s, ...slice);
  };
  const n = Math.max(e.steps?.length ?? 0, a.steps?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const es = e.steps?.[i];
    const as = a.steps?.[i];
    const ranges: TiedRanges = {};
    for (const r of [es?.tiedRanges, as?.tiedRanges] as Array<TiedRanges | undefined>) {
      for (const [path, rs] of Object.entries(r ?? {})) (ranges[path] ??= []).push(...rs);
    }
    for (const [path, rs] of Object.entries(ranges)) {
      for (const range of rs) {
        sortSlice(es, path, range);
        sortSlice(as, path, range);
      }
    }
    if (es) delete es.tiedRanges;
    if (as) delete as.tiedRanges;
  }
  return [e as T, a as T];
}

/** `steps.N.<…>` → the baseline's `steps[N].label`. */
function labelOf(root: unknown, p: string[]): string {
  if (p[0] !== 'steps' || !isObj(root)) return '';
  const steps = (root as { steps?: Array<{ label?: string }> }).steps;
  return steps?.[Number(p[1])]?.label ?? '';
}

type TraceLike = {
  complete?: boolean;
  rowsRead?: Record<string, number> | string;
  shapes?: Array<{ isolation?: string | null; statements?: Array<{ kind: string; protocol: string; relations: string[] }> }>;
};

const TX_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SET_TX']);

/** `traceMapped` (TS-9 fix round 1) — see TraceMappedRule. Returns the violations. */
export function compareMappedTrace(e0: unknown, a0: unknown, rule: TraceMappedRule, label: string): string[] {
  const e = (e0 ?? {}) as TraceLike;
  const a = (a0 ?? {}) as TraceLike;
  const out: string[] = [];
  if (a.complete !== true) out.push('trace: the run\'s trace is not complete');
  const statements = (t: TraceLike) => (t.shapes ?? []).flatMap(sh => sh.statements ?? []);
  for (const st of statements(a)) {
    // Exempt only genuine transaction control: the keyword AND no relation
    // touched (a multi-statement `BEGIN; INSERT …` is classified `other` by
    // the trace parser, and anything that touched a relation is data).
    const txControl = TX_CONTROL.has(st.kind) && st.relations.length === 0;
    if (st.protocol !== 'extended' && !txControl) {
      out.push(`trace: a ${st.kind} on [${st.relations.join(', ')}] used protocol ${st.protocol} (data statements must bind parameters)`);
    }
  }
  const isolations = (t: TraceLike) =>
    [...new Set((t.shapes ?? []).map(sh => sh.isolation).filter((x): x is string => !!x))].sort().join(',');
  if (isolations(a) !== isolations(e)) out.push(`trace: isolation levels [${isolations(e)}] → [${isolations(a)}]`);
  const allowed = new Set<string>(Object.keys(rule.addedRelations));
  const baseRelations = new Set(statements(e).flatMap(st => st.relations));
  for (const r of baseRelations) {
    const mapped = rule.relationMap[r];
    if (!mapped) out.push(`trace: baseline relation ${r} has no entry in the relation map`);
    for (const m of mapped ?? []) allowed.add(m);
  }
  for (const r of new Set(statements(a).flatMap(st => st.relations))) {
    if (!allowed.has(r)) out.push(`trace: the run touches ${r}, which no baseline relation maps to and the rule does not add`);
  }
  for (const s of rule.sameRowsRead) {
    if (!label.startsWith(s.steps)) continue;
    const er = typeof e.rowsRead === 'object' ? e.rowsRead[s.relation] : undefined;
    const ar = typeof a.rowsRead === 'object' ? a.rowsRead[s.as] : undefined;
    if (er === undefined || ar !== er) out.push(`trace: rowsRead ${s.relation}=${er} → ${s.as}=${ar}`);
  }
  return out;
}

type ChangeLike = { table?: string; kind?: string };

/**
 * `changesMapped` (TS-10) — see ChangesMappedRule. `e0`/`a0` are one step's
 * byte-level `changes` (or `changesAtResponse`) arrays, or equal
 * async-boundary markers. Returns the violations.
 */
export function compareMappedChanges(e0: unknown, a0: unknown, rule: ChangesMappedRule, step: number): string[] {
  if (!Array.isArray(e0) || !Array.isArray(a0)) {
    return JSON.stringify(e0) === JSON.stringify(a0) ? [] : [`changes: ${brief(e0)} → ${brief(a0)}`];
  }
  const out: string[] = [];
  const count = (xs: ChangeLike[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(`${x.table}|${x.kind}`, (m.get(`${x.table}|${x.kind}`) ?? 0) + 1);
    return m;
  };
  const base = count(e0 as ChangeLike[]);
  const run = count(a0 as ChangeLike[]);
  const added = rule.addedTables.filter(t => t.step === step);
  const addedCount = (table: string, kind: string) =>
    added.filter(t => t.table === table && t.kind === kind).reduce((n, t) => n + t.count, 0);
  // Which of the tables this baseline step wrote map onto each target table
  // (1:1 = one target table, the image of no other table written at the step).
  const sources = new Map<string, Set<string>>();
  for (const key of base.keys()) {
    const table = key.split('|')[0];
    for (const to of rule.tableMap[table] ?? []) sources.set(to, new Set([...(sources.get(to) ?? []), table]));
  }

  const image = new Set<string>();
  for (const key of base.keys()) {
    const [table, kind] = key.split('|');
    const tos = rule.tableMap[table];
    if (!tos) {
      out.push(`changes: baseline table ${table} has no entry in the table map`);
      continue;
    }
    for (const to of tos) image.add(`${to}|${kind}`);
    if (!tos.some(to => run.has(`${to}|${kind}`))) out.push(`changes: the baseline's ${kind} ${table} row(s) have no ${kind} image in [${tos.join(', ')}]`);
    const oneToOne = tos.length === 1 && (sources.get(tos[0])?.size ?? 0) === 1;
    if (oneToOne) {
      const want = base.get(key)! + addedCount(tos[0], kind);
      const got = run.get(`${tos[0]}|${kind}`) ?? 0;
      if (got !== want) out.push(`changes: ${kind} ${table}=${base.get(key)} (+${addedCount(tos[0], kind)} named) → ${tos[0]}=${got}`);
    }
  }
  for (const key of run.keys()) {
    const [table, kind] = key.split('|');
    if (image.has(key)) continue;
    const named = addedCount(table, kind);
    if (!named) out.push(`changes: the run writes ${kind} ${table}, which no baseline write maps to and the rule does not add at step ${step}`);
    else if (run.get(key) !== named) out.push(`changes: ${kind} ${table} added ${run.get(key)}, the rule names ${named} at step ${step}`);
  }
  return out;
}

/** `<phase>: <read> as <email>` → `<read>` (the full-read step labels, privacy.ts). */
function readNameOf(label: string): string | null {
  const m = /^[^:]+: (.+) as \S+$/.exec(label);
  return m ? m[1] : null;
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
  const ruleProblems: string[] = [];
  for (const r of rules) {
    if (r.rule.kind !== 'pendingCluster') continue;
    for (const entry of (r.rule as PendingClusterRule).reads) {
      if (PENDING_CLUSTER_READS[entry.read] !== entry.owner) {
        ruleProblems.push(
          `  pendingCluster may not list "${entry.read}" (owner ${entry.owner}): only another cluster's read, with its owner, can be pending`,
        );
      }
    }
  }
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
      // pendingCluster: a step (`steps.N`) that is a listed read of a cluster not yet on this branch.
      const pendingRead = p.length === 2 && p[0] === 'steps' && typeof e.label === 'string' ? readNameOf(e.label) : null;
      const pending = pendingRead
        ? rules.filter(r => r.rule.kind === 'pendingCluster' && (r.rule as PendingClusterRule).reads.some(x => x.read === pendingRead))
        : [];
      if (pending.length) {
        pending.forEach(r => r.matched++);
        const body = a.body as { success?: unknown; error?: { code?: unknown } } | undefined;
        if (a.status !== 500 || body?.success !== false || !body?.error) {
          fail([...p, 'status'], `stale pendingCluster entry: "${pendingRead}" now answers ${a.status} — delete the entry`, 500, a.status);
        }
      }
      for (const k of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
        const kp = [...p, k];
        if (pending.length && (k === 'status' || k === 'body' || k === 'sse')) continue;
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
        const changeRules = inE && inA ? rulesAt('changesMapped', kp) : [];
        if (changeRules.length) {
          for (const r of changeRules) {
            r.matched++;
            for (const v of compareMappedChanges(e[k], a[k], r.rule as ChangesMappedRule, Number(kp[1]))) fail(kp, v);
          }
          continue;
        }
        const traceRules = rulesAt('traceMapped', kp);
        if (traceRules.length) {
          for (const r of traceRules) {
            r.matched++;
            const label = labelOf(expected, kp);
            for (const v of compareMappedTrace(e[k], a[k], r.rule as TraceMappedRule, label)) fail(kp, v);
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
  violations.push(...ruleProblems);

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
