/**
 * Golden harness — privacy scenarios (R1–R7, plan §4 "New golden scenarios").
 *
 * Three pieces the seven scenarios share:
 *
 * 1. **A full read.** Every GET a participant's client can make about a
 *    session (`SESSION_READS`) and about themselves (`USER_READS`), each a
 *    harness step, so each body lands in both baselines. "Full" is the plan's
 *    word: a leak through an endpoint the scenario forgot to read is a leak the
 *    scenario cannot see.
 *
 * 2. **Probes.** A probe is a distinctive string from content that must not
 *    reach a reader — a reflection line, a gap summary, an unrevealed
 *    statement. `findLeaks` scans response bodies (and SSE events) for them.
 *
 * 3. **Known leaks.** A probe found where it must not be, against the CURRENT
 *    code, is a finding, not a fix (TS-5 brief). The scenario asserts the
 *    correct behaviour, and lists each observed violation as a `KnownLeak`
 *    with a bead-style description; `unexpectedLeakReport` fails on any leak
 *    not listed AND on any listed leak no longer observed. The suite stays
 *    green on today's code, and the day a leak is fixed (the target shape, or a
 *    fix to current code) the scenario fails until its entry is deleted — a
 *    stale entry would otherwise excuse the leak's return.
 *
 * Prompt context is probed the same way through `capturePrompts`: under
 * MOCK_LLM no prompt reaches the database (`BrainActivity` is written only on
 * a real model call), so the harness wraps the exports of `lib/bedrock` and
 * records every argument the app passes them — the prompt as built — while
 * still calling through. Calls made inside `lib/bedrock` itself do not pass
 * through its exports and are not seen; every call the turn pipeline makes
 * does (`stream-turn-model.ts` calls `getSonnetStreamingResponse`).
 */

import type { Harness, StepResult } from './driver';
import { isTargetShape } from './shape';

/** Session-scoped GETs, as `[name, path suffix]` under `/api/v1/sessions/:id`. */
export const SESSION_READS: ReadonlyArray<readonly [string, string]> = [
  ['session', ''],
  ['state', '/state'],
  ['progress', '/progress'],
  ['messages', '/messages'],
  ['emotions', '/emotions'],
  ['pending actions', '/pending-actions'],
  ['compact status', '/compact/status'],
  ['empathy status', '/empathy/status'],
  ['partner empathy', '/empathy/partner'],
  ['empathy draft', '/empathy/draft'],
  ['share suggestion', '/empathy/share-suggestion'],
  ['reconciler status', '/reconciler/status'],
  ['share offer', '/reconciler/share-offer'],
  ['reconciler summary', '/reconciler/summary'],
  ['pending consent', '/consent/pending'],
  ['consent history', '/consent/history'],
  ['needs', '/needs'],
  ['needs comparison', '/needs/comparison'],
  ['stage4', '/stage4'],
  ['strategies', '/strategies'],
  ['agreements', '/agreements'],
  ['tending', '/tending'],
  ['tending history', '/tending/history'],
  ['inner thoughts', '/inner-thoughts'],
];

/** User-scoped GETs that can surface session or partner content, as `[name, path]` under `/api/v1`. */
export const USER_READS: ReadonlyArray<readonly [string, string]> = [
  ['session list', '/sessions'],
  ['badge count', '/notifications/badge-count'],
  ['inner thoughts list', '/inner-thoughts'],
  ['inner work list', '/inner-work'],
  ['knowledge base recent', '/knowledge-base/recent'],
  ['knowledge base themes', '/knowledge-base/themes'],
  ['people', '/people'],
];

export type ReadSet = 'session' | 'user' | 'all';

/** TS-10: the target table that holds each current-shape table a read scenario snapshots (spec §1 Absorbs). */
const TARGET_READ_TABLE: Record<string, string> = {
  User: 'user',
  Message: 'message',
  UserVessel: 'conversation_read_state',
  EmpathyAttempt: 'empathy_attempt',
  ReconcilerResult: 'reconciler_result',
  ReconcilerShareOffer: 'context_share_offer',
  ConsentRecord: 'consent',
};

/** A scenario's snapshot tables in the shape in use (TS-10). */
export function shapeTables(currentShapeNames: string[]): string[] {
  if (!isTargetShape()) return currentShapeNames;
  return currentShapeNames.map(n => {
    const t = TARGET_READ_TABLE[n];
    if (!t) throw new Error(`shapeTables: no target table for ${n}`);
    return t;
  });
}

/**
 * The reads that can carry Stage 2 content (attempts, results, offers,
 * delivered messages), for scenarios that read at many phases: R2, R3, R7.
 * R1 and R6 — whose plan rows say "full read" — read everything.
 */
export const EMPATHY_READS = [
  'session',
  'state',
  'messages',
  'pending actions',
  'empathy status',
  'partner empathy',
  'empathy draft',
  'share suggestion',
  'reconciler status',
  'share offer',
  'reconciler summary',
  'pending consent',
  'consent history',
  'session list',
  'badge count',
];

/**
 * One full read by `actor`: every session read, then (with `set: 'all'`) every
 * user read, each a step labelled `<phase>: <name> as <email>`.
 */
export async function fullRead(
  harness: Harness,
  actor: { id: string; email: string; name: string },
  phase: string,
  opts: { tables: string[]; set?: ReadSet; only?: string[]; except?: string[] },
): Promise<StepResult[]> {
  const set = opts.set ?? 'session';
  const reads: Array<readonly [string, string]> = [
    ...(set !== 'user' ? SESSION_READS.map(([n, p]) => [n, `/sessions/${harness.sessionId}${p}`] as const) : []),
    ...(set !== 'session' ? USER_READS : []),
  ].filter(([n]) => (!opts.only || opts.only.includes(n)) && !opts.except?.includes(n));
  const out: StepResult[] = [];
  for (const [name, path] of reads) {
    out.push(
      await harness.step({
        label: `${phase}: ${name} as ${actor.email}`,
        actor,
        tables: opts.tables,
        call: agent => agent.get(`/api/v1${path}`),
      }),
    );
  }
  return out;
}

export interface Leak {
  step: string;
  probe: string;
}

/** Every (step, probe) where the probe's text appears in the step's response. */
export function findLeaks(steps: StepResult[], probes: Record<string, string>): Leak[] {
  const out: Leak[] = [];
  for (const s of steps) {
    const text = JSON.stringify(s.sse ?? s.body ?? null);
    for (const [probe, needle] of Object.entries(probes)) {
      if (needle && text.includes(needle)) out.push({ step: s.label, probe });
    }
  }
  return out;
}

/**
 * A violation the current code commits, recorded rather than fixed. `finding`
 * is written as a bead title; `evidence` says which read leaked what.
 */
export interface KnownLeak {
  /** `<step label> ⊃ <probe>` — the exact (step, probe) pair observed. */
  at: string;
  finding: string;
  evidence: string;
}

export const leakKey = (l: Leak): string => `${l.step} ⊃ ${l.probe}`;

/**
 * The mirror of `findLeaks` for content that MUST stay readable (R5: what
 * survives a partner's account deletion): every probe found in none of the
 * steps, reported as a `Leak` with step `<scope> ✗` so the same known-list
 * contract (`unexpectedLeakReport`) applies — a missing probe not on the list
 * fails, a listed one that reappears fails until its entry goes.
 */
export function findMissing(steps: StepResult[], probes: Record<string, string>, scope: string): Leak[] {
  const text = steps.map(s => JSON.stringify(s.sse ?? s.body ?? null)).join('\n');
  return Object.entries(probes)
    .filter(([, needle]) => !text.includes(needle))
    .map(([probe]) => ({ step: `${scope} ✗`, probe }));
}

/**
 * Leaks not on the known list, and known leaks no longer observed. Both must
 * be empty: the first is a new leak, the second a fixed one whose entry has to
 * go (or the fix reverted unnoticed).
 */
export function unexpectedLeakReport(observed: Leak[], known: KnownLeak[]): { unexpected: string[]; stale: string[] } {
  const seen = new Set(observed.map(leakKey));
  const listed = new Set(known.map(k => k.at));
  return {
    unexpected: [...seen].filter(k => !listed.has(k)).sort(),
    stale: [...listed].filter(k => !seen.has(k)).sort(),
  };
}

// ============================================================================
// Prompt capture
// ============================================================================

/** Every `lib/bedrock` export that takes a prompt or text to embed. */
const PROMPT_FUNCTIONS = [
  'getCompletion',
  'getModelCompletion',
  'getModelCompletionWithTools',
  'getHaikuJson',
  'getSonnetResponse',
  'getSonnetStreamingResponse',
  'getEmbedding',
  'getEmbeddings',
] as const;

export interface CapturedCall {
  /** The step running when the call was made (set by `capturePrompts().during`). */
  step: string;
  fn: string;
  /** Every argument, serialised: the prompt as built. */
  text: string;
}

/**
 * Wrap every function export of `lib/bedrock` so each call records its
 * arguments and then calls through. Must run after the harness has imported
 * the app (the module is shared through jest's registry). `during(label, fn)`
 * attributes the calls made while `fn` runs to `label`.
 */
export async function capturePrompts(): Promise<{
  calls: CapturedCall[];
  during<T>(label: string, fn: () => Promise<T>): Promise<T>;
}> {
  const bedrock = (await import('../../lib/bedrock')) as unknown as Record<string, unknown>;
  const calls: CapturedCall[] = [];
  let current = '<outside any step>';
  for (const name of PROMPT_FUNCTIONS) {
    const value = bedrock[name];
    if (typeof value !== 'function') throw new Error(`lib/bedrock no longer exports ${name}`);
    const original = value as (...a: unknown[]) => unknown;
    jest.spyOn(bedrock as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation((...args) => {
      calls.push({ step: current, fn: name, text: safeStringify(args) });
      return original(...args);
    });
  }
  return {
    calls,
    async during(label, fn) {
      current = label;
      try {
        return await fn();
      } finally {
        current = '<outside any step>';
      }
    },
  };
}

function safeStringify(v: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === 'function') return undefined;
    if (x && typeof x === 'object') {
      if (seen.has(x)) return '<cycle>';
      seen.add(x);
    }
    return x;
  });
}

/** Every (call, probe) where a captured prompt contains the probe. */
export function findPromptLeaks(calls: CapturedCall[], probes: Record<string, string>): Leak[] {
  const out: Leak[] = [];
  for (const c of calls) {
    for (const [probe, needle] of Object.entries(probes)) {
      if (needle && c.text.includes(needle)) out.push({ step: `${c.step} [prompt ${c.fn}]`, probe });
    }
  }
  return [...new Map(out.map(l => [leakKey(l), l])).values()];
}
