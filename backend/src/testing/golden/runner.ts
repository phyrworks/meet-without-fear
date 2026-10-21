/**
 * Golden harness — record / verify.
 *
 * Set `GOLDEN_UPDATE=<scenario>` to (re)record that one scenario. The scenario
 * must be named: a blanket value is rejected, because "never bulk-regenerate"
 * was a convention with nothing enforcing it, and a harness whose baselines are
 * refreshed on failure is a harness that always passes. Every accepted change to
 * a golden file should have a written reason.
 */

import * as fs from 'fs';
import * as path from 'path';
import { compareWithAllowList } from './allow-lists/compare';
import type { AllowList } from './allow-lists/types';
import type { Harness, StepResult } from './driver';
import { CONCEPT_VIEWS, conceptOf } from './concept-views';
import { buildConceptLabelMap, buildLabelMap, conceptRowKey, normalize, timestampFacts, LabelMap } from './normalize';
import { diffSnapshots } from './snapshot';
import type { RowChange, Snapshot, SnapshotRow } from './snapshot';
import type { TraceSummary } from './trace';

const GOLDEN_DIR = path.join(__dirname, '__golden__');

/** What `changesAtResponse` records for a step whose writes outlive the response. */
export const ASYNC_BOUNDARY = '<async: response-time state is a race, not a boundary>';

export interface GoldenStep {
  label: string;
  status: number;
  body?: unknown;
  sse?: Array<{ event: string; data: unknown }>;
  /** Changes visible once background work has settled. */
  changes: unknown[];
  /** Changes visible the instant the response returned — the transaction boundary. */
  changesAtResponse: unknown[] | typeof ASYNC_BOUNDARY;
  /** False when quiescence polling timed out; a timed-out step is not a baseline. */
  settled: boolean;
  /**
   * What the step asked of Postgres. Present only for scenarios that record a
   * trace; absent leaves every existing golden byte-identical.
   */
  trace?: TraceSummary;
}

export interface GoldenFile {
  scenario: string;
  stage: string;
  steps: GoldenStep[];
}

function goldenPath(scenario: string): string {
  return path.join(GOLDEN_DIR, `${scenario}.json`);
}

/**
 * Recording requires naming the scenario: `GOLDEN_UPDATE=session-read`.
 *
 * It used to be `GOLDEN_UPDATE=1`, and that is one exported variable away from
 * disaster: left in a shell, the whole suite becomes a self-rewriting recorder
 * that is green by construction. "Never bulk-regenerate" was a convention with
 * nothing enforcing it, and a convention is exactly what gets skipped at 6pm on
 * the day a migration PR turns every trace field red.
 *
 * A comma-separated list is accepted, so re-recording two scenarios together is
 * possible — but it has to be typed out, which is the point.
 */
export function isRecording(scenario: string): boolean {
  const raw = process.env.GOLDEN_UPDATE;
  if (!raw) return false;
  const named = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (named.includes('1') || named.includes('true') || named.includes('all')) {
    throw new Error(
      `GOLDEN_UPDATE=${raw} is not accepted: recording must name the scenario, e.g.\n` +
        `    GOLDEN_UPDATE=${scenario} npx jest ${scenario}\n` +
        `A blanket value turns every scenario in the suite into a recorder, which is how a\n` +
        `harness silently stops being an oracle. Re-record one scenario at a time, with a reason.`,
    );
  }
  return named.includes(scenario);
}

function describeChange(c: RowChange): Record<string, unknown> {
  const facts = timestampFacts(
    c.before as Record<string, unknown> | undefined,
    (c.after ?? {}) as Record<string, unknown>,
  );
  return {
    table: c.table,
    kind: c.kind,
    key: c.key,
    changedFields: c.changedFields?.slice().sort(),
    after: c.after,
    before: c.before,
    ...(Object.keys(facts).length ? { timestampFacts: facts } : {}),
  };
}

/**
 * Normalize a whole step in ONE pass.
 *
 * Two reasons this is not done piecewise:
 *
 * 1. Timestamp ranks must share a universe across the response body and every
 *    row change, or cross-row ordering is never asserted. Normalizing each
 *    change separately meant a row whose timestamp was written from `now()`
 *    instead of a carried value ranked identically inside its own object — a
 *    false pass on exactly the kind of clock-basis error the migration invites.
 * 2. Unresolved ids found in row changes were previously discarded, so the
 *    advertised "any unresolved id fails the run" guard did not apply to the
 *    channel where write regressions actually appear. Only 8 of 68 tables are
 *    labelled, so that channel is where unknown ids are most likely.
 */
export function normalizeStep(step: StepResult, map: LabelMap): { golden: GoldenStep; unresolved: string[] } {
  const payload = {
    body: step.sse ? undefined : step.body,
    sse: step.sse,
    changes: step.changes.map(describeChange),
    changesAtResponse: step.changesAtResponse.map(describeChange),
  };

  const n = normalize(payload, map, step.window);
  const v = n.value as typeof payload;

  return {
    golden: {
      label: step.label,
      status: step.status,
      ...(step.sse ? { sse: v.sse as GoldenStep['sse'] } : { body: v.body }),
      changes: (v.changes ?? []) as unknown[],
      // Recorded as content, not as a count. A length-only flag cannot see
      // background work that further mutates rows already changed at response
      // time, nor a sync/async move where the counts happen to coincide — and
      // the response-time state is precisely the transaction boundary the
      // migration is most likely to shift.
      //
      // Unless the step declares that its writes outlive the response, in which
      // case there is no boundary to record: the same endpoint was measured
      // returning with its empathy attempt on READY in one run and REVEALED in
      // the next. Recording a race as a baseline is how a harness starts failing
      // for reasons that have nothing to do with the code under test.
      changesAtResponse: step.asyncBoundary ? ASYNC_BOUNDARY : ((v.changesAtResponse ?? []) as unknown[]),
      settled: step.settled,
      // Deliberately not passed through `normalize`. A trace carries no ids and
      // no timestamps by construction — `trace.ts` builds it out of
      // classifications, relation names and counts — so normalizing it could
      // only ever damage it. `TIMESTAMP_RE` and `CUID_RE` have nothing to match,
      // and the "unresolved id fails the run" guard has nothing to guard.
      ...(step.trace ? { trace: step.trace } : {}),
    },
    unresolved: n.unresolved,
  };
}

export interface RunReport {
  scenario: string;
  recorded: boolean;
  unresolved: string[];
  diff: string | null;
}

/**
 * Compare (or record) a scenario's steps.
 *
 * Returns a report rather than asserting, so callers can decide how to fail —
 * jest expectations, a CLI exit code, or a mutation-testing driver.
 */
export async function recordOrVerify(opts: {
  scenario: string;
  harness: Harness;
  steps: StepResult[];
}): Promise<RunReport> {
  const { scenario, harness, steps } = opts;
  const map = await buildLabelMap(
    harness.fixture.target,
    harness.fixture.database,
    harness.fixture.manifest,
    harness.fixture.seededClerkIds,
  );
  // Rows the run deleted (TS-5 R5: account deletion) are gone from the run
  // database but still named in the `before` side of its changes. The fixture
  // template holds them under the same ids (the run is its clone), labelled by
  // the same rules; the run's own label wins wherever both have one, so a
  // scenario that deletes nothing labels exactly as before.
  const fixtureMap = await buildLabelMap(
    harness.fixture.target,
    harness.fixture.manifest.database,
    harness.fixture.manifest,
    harness.fixture.seededClerkIds,
  );
  for (const [id, label] of fixtureMap.labels) if (!map.labels.has(id)) map.labels.set(id, label);

  const normalized: GoldenStep[] = [];
  const unresolved: string[] = [];
  for (const s of steps) {
    const n = normalizeStep(s, map);
    normalized.push(n.golden);
    unresolved.push(...n.unresolved);
  }

  const actual: GoldenFile = {
    scenario,
    stage: harness.fixture.manifest.stage,
    steps: normalized,
  };

  const p = goldenPath(scenario);
  const recording = isRecording(scenario);

  if (recording) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(actual, null, 2) + '\n');
    return { scenario, recorded: true, unresolved: [...new Set(unresolved)], diff: null };
  }

  // A missing baseline must FAIL, never silently record. Auto-recording in
  // verify mode meant a deleted, renamed or never-committed golden produced a
  // suite that passed forever while asserting nothing — verified by deleting
  // the file and watching all three tests pass. That is the oracle deleting
  // itself and staying green, which is the worst failure this harness can have.
  if (!fs.existsSync(p)) {
    return {
      scenario,
      recorded: false,
      unresolved: [...new Set(unresolved)],
      diff:
        `No recorded baseline at ${path.relative(process.cwd(), p)}.\n` +
        `A missing golden is a failure, not a first run. If this scenario is new, record it\n` +
        `deliberately and commit the file:\n` +
        `    GOLDEN_UPDATE=${scenario} npx jest ${scenario}`,
    };
  }

  const expected = JSON.parse(fs.readFileSync(p, 'utf8')) as GoldenFile;
  const diff = diffJson(expected, actual);
  return { scenario, recorded: false, unresolved: [...new Set(unresolved)], diff };
}

/** Compact structural diff — reports paths that differ, not a wall of JSON. */
export function diffJson(expected: unknown, actual: unknown, pathPrefix = ''): string | null {
  const lines: string[] = [];
  walk(expected, actual, pathPrefix, lines);
  return lines.length ? lines.join('\n') : null;
}

function walk(e: unknown, a: unknown, p: string, out: string[]): void {
  if (JSON.stringify(e) === JSON.stringify(a)) return;

  const bothObjects = e && a && typeof e === 'object' && typeof a === 'object' && Array.isArray(e) === Array.isArray(a);

  if (!bothObjects) {
    out.push(`  ${p || '<root>'}\n    expected: ${brief(e)}\n    actual:   ${brief(a)}`);
    return;
  }

  if (Array.isArray(e) && Array.isArray(a)) {
    if (e.length !== a.length) {
      out.push(`  ${p}.length\n    expected: ${e.length}\n    actual:   ${a.length}`);
    }
    for (let i = 0; i < Math.max(e.length, a.length); i++) walk(e[i], a[i], `${p}[${i}]`, out);
    return;
  }

  const keys = new Set([...Object.keys(e as object), ...Object.keys(a as object)]);
  for (const k of [...keys].sort()) {
    walk((e as Record<string, unknown>)[k], (a as Record<string, unknown>)[k], p ? `${p}.${k}` : k, out);
  }
}

function brief(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

// ============================================================================
// Normalised (concept) baselines — record / verify
// ============================================================================

/**
 * A normalised baseline: what a scenario looks like through the
 * `old_concept_*` views, in the target schema's vocabulary.
 *
 * It holds no trace and no response-time state — both are shape-bound and stay
 * in the byte-level golden — and its rows are keyed by structural label
 * (`initial.participant["<participant:ada@main>"]`), never by array position,
 * because the order of rows by id is not preserved where the target mints new
 * ids.
 */
export interface ConceptGoldenFile {
  scenario: string;
  stage: string;
  /** Every concept view as restored, by concept, then by row key. */
  initial: Record<string, Record<string, unknown>>;
  steps: ConceptGoldenStep[];
}

export interface ConceptGoldenStep {
  label: string;
  status: number;
  body?: unknown;
  sse?: Array<{ event: string; data: unknown }>;
  /**
   * Why the concept views could not represent the database after this step
   * (harness `conceptUnrepresentable: 'record'`); `changes` is absent then.
   */
  unrepresentable?: string;
  /** Concept-view row changes once the step settled, sorted by view then key. */
  changes?: Array<{
    view: string;
    kind: RowChange['kind'];
    key: string;
    changedFields?: string[];
    before?: unknown;
    after?: unknown;
  }>;
}

export interface ConceptRunReport {
  scenario: string;
  recorded: boolean;
  unresolved: string[];
  /** Differences the allow-list does not name (or a missing baseline). Empty = accepted. */
  violations: string[];
  /** Allow-list rules marked `mustMatch` that matched nothing in the baseline. */
  unmatchedRules: string[];
}

/** The `GOLDEN_UPDATE` name, and file stem, of a scenario's normalised baseline. */
export function conceptGoldenName(scenario: string): string {
  return `${scenario}.concept`;
}

/** Concept-view tables of a snapshot, by concept name. */
function conceptTables(snap: Snapshot): Record<string, SnapshotRow[]> {
  const out: Record<string, SnapshotRow[]> = {};
  for (const [view, rows] of Object.entries(snap.tables)) out[conceptOf(view)] = rows;
  return out;
}

/**
 * Build the normalised baseline for a run and record it, or compare it with
 * the recorded one under the scenario's allow-list.
 *
 * Recording is `GOLDEN_UPDATE=<scenario>.concept` — named, like the byte-level
 * goldens, and distinct from them, so recording a normalised baseline can
 * never rewrite a byte-level one.
 */
export async function recordOrVerifyConcept(opts: {
  scenario: string;
  harness: Harness;
  steps: StepResult[];
  allowList: AllowList;
  /**
   * Old-shape ids that denote a concept row under another id, labelled as
   * that row (TS-5). Today's Stage 4 DTOs name a need by its
   * `Stage4NeedCoverage` row id when the coverage row has no `needId`
   * (`needIdentifier = row.needId ?? row.id`); the target names the need
   * itself. Aliasing the coverage id to the need it covers labels both runs
   * the same. An alias whose `sameAs` has no concept label is left unresolved.
   */
  aliases?: Array<{ id: string; sameAs: string }>;
}): Promise<ConceptRunReport> {
  const { scenario, harness, steps, allowList } = opts;
  if (allowList.scenario !== scenario) {
    throw new Error(`Allow-list for "${allowList.scenario}" used for scenario "${scenario}"`);
  }
  const initial = harness.conceptInitial;
  if (!initial || steps.some(s => !s.concept)) {
    throw new Error(`Scenario "${scenario}": the harness was created without \`concept: true\``);
  }

  // Labels come from every row the run ever showed, so a row deleted mid-run
  // keeps its label. Later snapshots win, but identity (and so the label's
  // natural key) cannot change for a given id.
  const merged = new Map<string, Map<string, SnapshotRow>>();
  const snaps = [initial, ...steps.flatMap(s => [s.concept!.before, s.concept!.after])].filter(
    (x): x is Snapshot => !!x,
  );
  for (const snap of snaps) {
    for (const [concept, rows] of Object.entries(conceptTables(snap))) {
      const identity = [...(CONCEPT_VIEWS as Record<string, { identity: readonly string[] }>)[concept].identity];
      const m = merged.get(concept) ?? new Map<string, SnapshotRow>();
      for (const r of rows) m.set(identity.map(c => String(r[c])).join('\u0000'), r);
      merged.set(concept, m);
    }
  }
  const { seeded } = harness.fixture.manifest;
  const map = buildConceptLabelMap({
    manifest: {
      sessionId: seeded.sessionId,
      relationshipId: seeded.relationshipId,
      invitationId: seeded.invitationId,
      users: [seeded.userA, ...(seeded.userB ? [seeded.userB] : [])],
    },
    seededClerkIds: harness.fixture.seededClerkIds,
    rows: Object.fromEntries([...merged].map(([c, m]) => [c, [...m.values()]])),
  });
  for (const { id, sameAs } of opts.aliases ?? []) {
    const label = map.labels.get(sameAs);
    if (label) map.labels.set(id, label);
  }

  const unresolved = new Set<string>();
  const keyed = (concept: string, rows: SnapshotRow[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      const k = conceptRowKey(concept, r);
      // Two rows under one structural key would silently become one.
      if (k in out) throw new Error(`Concept "${concept}": two rows share the structural key ${k}`);
      out[k] = r;
    }
    // Sorted by key: snapshot order follows raw ids, which the target mints
    // afresh for participants and conversations.
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  };

  const n0 = normalize(conceptTables(initial), map);
  n0.unresolved.forEach(u => unresolved.add(u));
  const initialOut: ConceptGoldenFile['initial'] = {};
  for (const [concept, rows] of Object.entries(n0.value).sort(([a], [b]) => (a < b ? -1 : 1))) {
    initialOut[concept] = keyed(concept, rows);
  }

  const goldenSteps: ConceptGoldenStep[] = steps.map(s => {
    const concept = s.concept!;
    if (concept.unrepresentable !== undefined) {
      // The views cannot represent the state after this step: record why, in
      // place of its changes. On the target there is a state to compare, so
      // the allow-list must name both `changes` (added) and `unrepresentable`
      // (absent) for these steps — see driver `conceptUnrepresentable`.
      const n = normalize({ body: s.sse ? undefined : s.body, sse: s.sse, reason: concept.unrepresentable }, map, s.window);
      n.unresolved.forEach(u => unresolved.add(u));
      const v = n.value as { body?: unknown; sse?: ConceptGoldenStep['sse']; reason: string };
      return {
        label: s.label,
        status: s.status,
        ...(s.sse ? { sse: v.sse } : { body: v.body }),
        unrepresentable: v.reason,
      };
    }
    const raw = diffSnapshots(concept.before, concept.after).map(c => ({
      view: conceptOf(c.table),
      kind: c.kind,
      changedFields: c.changedFields?.slice().sort(),
      before: c.before,
      after: c.after,
    }));
    const n = normalize({ body: s.sse ? undefined : s.body, sse: s.sse, changes: raw }, map, s.window);
    n.unresolved.forEach(u => unresolved.add(u));
    const v = n.value as { body?: unknown; sse?: ConceptGoldenStep['sse']; changes: typeof raw };
    const changes = v.changes
      .map(c => ({
        view: c.view,
        kind: c.kind,
        key: conceptRowKey(c.view, (c.after ?? c.before) as Record<string, unknown>),
        ...(c.changedFields ? { changedFields: c.changedFields } : {}),
        ...(c.before !== undefined ? { before: c.before } : {}),
        ...(c.after !== undefined ? { after: c.after } : {}),
      }))
      .sort((a, b) => (a.view === b.view ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.view < b.view ? -1 : 1));
    return {
      label: s.label,
      status: s.status,
      ...(s.sse ? { sse: v.sse } : { body: v.body }),
      changes,
    };
  });

  const actual: ConceptGoldenFile = {
    scenario,
    stage: harness.fixture.manifest.stage,
    initial: initialOut,
    steps: goldenSteps,
  };

  const name = conceptGoldenName(scenario);
  const p = goldenPath(name);
  const base = { scenario, unresolved: [...unresolved] };

  if (isRecording(name)) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(actual, null, 2) + '\n');
    return { ...base, recorded: true, violations: [], unmatchedRules: [] };
  }
  if (!fs.existsSync(p)) {
    return {
      ...base,
      recorded: false,
      unmatchedRules: [],
      violations: [
        `No recorded normalised baseline at ${path.relative(process.cwd(), p)}. A missing baseline is a failure.\n` +
          `Record it deliberately and commit the file:\n    GOLDEN_UPDATE=${name} npx jest ${scenario}.golden`,
      ],
    };
  }
  const expected = JSON.parse(fs.readFileSync(p, 'utf8')) as ConceptGoldenFile;
  const cmp = compareWithAllowList(expected, actual, allowList);
  return { ...base, recorded: false, violations: cmp.violations, unmatchedRules: cmp.unmatchedRules };
}
