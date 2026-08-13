/**
 * Golden harness — record / verify.
 *
 * Set `GOLDEN_UPDATE=1` to (re)record. Never bulk-regenerate: every accepted
 * change to a golden file should have a written reason, because a harness whose
 * baselines are refreshed on failure is a harness that always passes.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Harness, StepResult } from './driver';
import { buildLabelMap, normalize, timestampFacts, LabelMap } from './normalize';
import type { RowChange } from './snapshot';

const GOLDEN_DIR = path.join(__dirname, '__golden__');

export interface GoldenStep {
  label: string;
  status: number;
  body?: unknown;
  sse?: Array<{ event: string; data: unknown }>;
  /** Changes visible once background work has settled. */
  changes: unknown[];
  /** True when the response-time and settled snapshots differ — i.e. async writes. */
  hadAsyncWrites: boolean;
}

export interface GoldenFile {
  scenario: string;
  stage: string;
  steps: GoldenStep[];
}

function goldenPath(scenario: string): string {
  return path.join(GOLDEN_DIR, `${scenario}.json`);
}

function normalizeChange(c: RowChange, map: LabelMap): unknown {
  const before = c.before as Record<string, unknown> | undefined;
  const after = (c.after ?? {}) as Record<string, unknown>;
  const facts = timestampFacts(before, after);
  const n = normalize(
    {
      table: c.table,
      kind: c.kind,
      key: c.key,
      changedFields: c.changedFields?.slice().sort(),
      after: c.after,
      before: c.before,
    },
    map,
  );
  return Object.keys(facts).length ? { ...(n.value as object), timestampFacts: facts } : n.value;
}

export function normalizeStep(step: StepResult, map: LabelMap): { golden: GoldenStep; unresolved: string[] } {
  const unresolved: string[] = [];
  const body = normalize(step.body, map);
  unresolved.push(...body.unresolved);

  let sse: GoldenStep['sse'];
  if (step.sse) {
    const n = normalize(step.sse, map);
    unresolved.push(...n.unresolved);
    sse = n.value as GoldenStep['sse'];
  }

  const changes = step.changes.map(c => normalizeChange(c, map));

  return {
    golden: {
      label: step.label,
      status: step.status,
      ...(step.sse ? { sse } : { body: body.value }),
      changes,
      hadAsyncWrites: step.changes.length !== step.changesAtResponse.length,
    },
    unresolved: [...new Set(unresolved)],
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
  const map = await buildLabelMap(harness.fixture.target, harness.fixture.database, harness.fixture.manifest);

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
  if (process.env.GOLDEN_UPDATE === '1' || !fs.existsSync(p)) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(actual, null, 2) + '\n');
    return { scenario, recorded: true, unresolved: [...new Set(unresolved)], diff: null };
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
