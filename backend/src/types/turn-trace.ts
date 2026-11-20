/**
 * Turn Trace Types
 *
 * Defines the structure for pipeline tracing in the AI orchestrator.
 * Each orchestrateResponse() call produces a TurnTrace with TraceStep[] entries
 * recording timing, status, and result for every pipeline stage.
 */

export type TraceStepType = 'decision' | 'llm_call' | 'retrieval' | 'parsing' | 'dispatch';

export type TraceStepStatus = 'success' | 'error' | 'skipped';

export interface TraceStep {
  /** Step name, one of STEP_RESULTS' keys (e.g., "Memory Intent", "LLM Call") */
  name: string;
  /** Step category for coloring/grouping */
  type: TraceStepType;
  /** Milliseconds from orchestration start when this step began */
  startMs: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Short code-built summary of the step result (counts, flags, enums; see STEP_RESULTS) */
  result: string;
  /** Whether the step succeeded, failed, or was skipped */
  status: TraceStepStatus;
}

export interface TurnTrace {
  /** Total orchestration duration in milliseconds */
  totalDurationMs: number;
  /** Model used for the main LLM call */
  modelUsed: string;
  /** Whether a mock response was used */
  usedMock: boolean;
  /** Ordered list of pipeline steps */
  steps: TraceStep[];
}

// ============================================================================
// What a stored trace may hold (review r1 F1, F2; work-k5fk.9)
// ============================================================================
//
// The trace is merged into brain_activity.metadata, which mwf_ops reads in plain. So it holds telemetry only:
// enumerable step names, timings, and results built by code from counts, flags and enums — never the model's text
// (a dispatch tag beyond its kind), never a classification of what the user wrote (crisis severity or categories),
// never an exception message. sanitizeTurnTrace is the guard at the writer (brain-service mergeTurnTrace): a step
// whose name or result does not match its template keeps its timing and loses its result.

/** The dispatch tags the dispatch handler knows; anything else a model writes is 'other'. */
export const DISPATCH_TAG_KINDS = [
  'EXPLAIN_PROCESS',
  'EXPLAIN_EMPATHY_PURPOSE',
  'HANDLE_MEMORY_REQUEST',
  'SAFETY_CONCERN',
] as const;
export type DispatchTagKind = (typeof DISPATCH_TAG_KINDS)[number] | 'other';

/** A dispatch tag's kind: the identifier before ':' (or any space), if it is a known tag; otherwise 'other'. */
export function dispatchTagKind(tag: string): DispatchTagKind {
  const head = (tag.trim().split(/[:\s]/, 1)[0] ?? '').toUpperCase();
  return (DISPATCH_TAG_KINDS as readonly string[]).includes(head) ? (head as DispatchTagKind) : 'other';
}

/** An error as telemetry: its code (error.code), else its class (error.name), at most 64 identifier characters. */
export function errorClass(error: unknown): string {
  const e = error !== null && typeof error === 'object' ? (error as { code?: unknown; name?: unknown }) : null;
  const raw = (typeof e?.code === 'string' && e.code) || (typeof e?.name === 'string' && e.name) || 'Error';
  return raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'Error';
}

const KIND = `(?:none|other|${DISPATCH_TAG_KINDS.join('|')})`;
const ID = '[A-Za-z0-9_.:-]{1,128}';
const RETRIEVAL_PART =
  '\\d+ (?:messages in current conversation|pre-session messages|relevant from other sessions|' +
  'relevant from earlier in session|references detected)';

/** Each step name the orchestrator writes → the only results it may carry. */
const STEP_RESULTS: Record<string, RegExp> = {
  'Crisis Detection': /^evaluated$/,
  'Memory Intent': /^[a-z_]+ \([a-z]+\)$/,
  'Context Assembly': /^\d+ turns$/,
  'Context Retrieval': new RegExp(
    `^(?:skipped|No additional context retrieved|${RETRIEVAL_PART}(?:; ${RETRIEVAL_PART})*)$`,
  ),
  'Shared Content': /^(?:loaded|none)$/,
  Milestones: /^(?:loaded|none)$/,
  'Surfacing Policy': /^shouldSurface=(?:true|false), style=[a-z_]+$/,
  'Retrieval Planning': /^(?:\d+ queries|failed, using mock|skipped \(depth != full or no context\))$/,
  'Prompt Building': /^stage=\d+, \d+ chars$/,
  'Token Budget': /^\d+ msgs, \d+ truncated$/,
  'Model Routing': new RegExp(`^model=${ID}, score=-?[0-9.]+$`),
  'LLM Call': new RegExp(`^(?:${ID}, \\d+ chars|null response|error: [A-Za-z0-9_.-]{1,64})$`),
  'Response Parsing': new RegExp(`^thinking=(?:true|false), draft=(?:true|false), dispatch=${KIND}$`),
  Dispatch: new RegExp(`^${KIND}: \\d+ chars$`),
  'Dispatch (ignored)': new RegExp(`^${KIND}: unknown tag, fell through to the normal response$`),
};
const STEP_TYPES: readonly TraceStepType[] = ['decision', 'llm_call', 'retrieval', 'parsing', 'dispatch'];
const STEP_STATUSES: readonly TraceStepStatus[] = ['success', 'error', 'skipped'];
const MODEL_ID = new RegExp(`^${ID}$`);

const ms = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The trace as it may be stored: known step names, template results, timings and enums only (see above). */
export function sanitizeTurnTrace(trace: TurnTrace): { trace: TurnTrace; redacted: number } {
  let redacted = 0;
  const steps = (Array.isArray(trace.steps) ? trace.steps : []).map((s): TraceStep => {
    const pattern = typeof s.name === 'string' ? STEP_RESULTS[s.name] : undefined;
    const ok = !!pattern && typeof s.result === 'string' && pattern.test(s.result);
    if (!ok) redacted++;
    return {
      name: pattern ? s.name : 'Unknown step',
      type: STEP_TYPES.includes(s.type) ? s.type : 'decision',
      startMs: ms(s.startMs),
      durationMs: ms(s.durationMs),
      result: ok ? s.result : '[redacted]',
      status: STEP_STATUSES.includes(s.status) ? s.status : 'error',
    };
  });
  return {
    trace: {
      totalDurationMs: ms(trace.totalDurationMs),
      modelUsed: typeof trace.modelUsed === 'string' && MODEL_ID.test(trace.modelUsed) ? trace.modelUsed : 'unknown',
      usedMock: trace.usedMock === true,
      steps,
    },
    redacted,
  };
}
