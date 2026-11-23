/**
 * Turn Trace Types
 *
 * Defines the structure for pipeline tracing in the AI orchestrator.
 * Each orchestrateResponse() call produces a TurnTrace with TraceStep[] entries
 * recording timing, status, and result for every pipeline stage.
 */

import type { ModelType } from '../lib/bedrock';
import type { MemoryIntent, RetrievalDepth, SurfaceStyle } from '../services/memory-intent';

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

/**
 * The error codes and classes the monitor may see (review r2 R2-1): JavaScript's built-in errors, the Anthropic SDK's
 * and AWS Bedrock's error classes, Prisma's request errors, and Node's network codes. A closed set, so no thrown
 * value can carry text into ops-readable metadata.
 */
export const ERROR_CLASSES = new Set<string>([
  // JavaScript
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'AbortError',
  'TimeoutError',
  // Anthropic SDK (Bedrock client)
  'APIError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIUserAbortError',
  'BadRequestError',
  'AuthenticationError',
  'PermissionDeniedError',
  'NotFoundError',
  'ConflictError',
  'UnprocessableEntityError',
  'RateLimitError',
  'InternalServerError',
  // AWS Bedrock runtime
  'ThrottlingException',
  'ValidationException',
  'AccessDeniedException',
  'ModelTimeoutException',
  'ModelErrorException',
  'ModelNotReadyException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ResourceNotFoundException',
  'ServiceQuotaExceededException',
  // Prisma
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientValidationError',
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
  // Node network codes
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

/** An error as telemetry: its code (error.code), else its class (error.name), if in ERROR_CLASSES; else 'other'. */
export function errorClass(error: unknown): string {
  const e = error !== null && typeof error === 'object' ? (error as { code?: unknown; name?: unknown }) : null;
  for (const v of [e?.code, e?.name]) if (typeof v === 'string' && ERROR_CLASSES.has(v)) return v;
  return 'other';
}

// Closed sets for every enum slot (review r2 R2-1). A Record over each union makes the compiler require every member.
const MEMORY_INTENTS: Record<MemoryIntent, true> = {
  emotional_validation: true,
  stage_enforcement: true,
  recall_commitment: true,
  offer_continuity: true,
  avoid_recall: true,
};
const RETRIEVAL_DEPTHS: Record<RetrievalDepth, true> = { none: true, minimal: true, light: true, full: true };
const MODELS: Record<ModelType, true> = { haiku: true, sonnet: true };
const SURFACE_STYLES: Record<SurfaceStyle, true> = { silent: true, tentative: true, explicit: true };
const alt = (o: object) => `(?:${Object.keys(o).join('|')})`;
const KIND = `(?:none|other|${DISPATCH_TAG_KINDS.join('|')})`;
const MODEL = alt(MODELS);
const ERROR = `(?:other|${[...ERROR_CLASSES].join('|')})`;
const RETRIEVAL_PART =
  '\\d+ (?:messages in current conversation|pre-session messages|relevant from other sessions|' +
  'relevant from earlier in session|references detected)';

/** Each step name the orchestrator writes → the only results it may carry. A Map, so no prototype key matches. */
const STEP_RESULTS = new Map<string, RegExp>(
  Object.entries({
    'Crisis Detection': /^evaluated$/,
    'Memory Intent': new RegExp(`^${alt(MEMORY_INTENTS)} \\(${alt(RETRIEVAL_DEPTHS)}\\)$`),
    'Context Assembly': /^\d+ turns$/,
    'Context Retrieval': new RegExp(
      `^(?:skipped|No additional context retrieved|${RETRIEVAL_PART}(?:; ${RETRIEVAL_PART})*)$`,
    ),
    'Shared Content': /^(?:loaded|none)$/,
    Milestones: /^(?:loaded|none)$/,
    'Surfacing Policy': new RegExp(`^shouldSurface=(?:true|false), style=${alt(SURFACE_STYLES)}$`),
    'Retrieval Planning': /^(?:\d+ queries|failed, using mock|skipped \(depth != full or no context\))$/,
    'Prompt Building': /^stage=\d+, \d+ chars$/,
    'Token Budget': /^\d+ msgs, \d+ truncated$/,
    'Model Routing': new RegExp(`^model=${MODEL}, score=-?[0-9.]+$`),
    'LLM Call': new RegExp(`^(?:${MODEL}, \\d+ chars|null response|error: ${ERROR})$`),
    'Response Parsing': new RegExp(`^thinking=(?:true|false), draft=(?:true|false), dispatch=${KIND}$`),
    Dispatch: new RegExp(`^${KIND}: \\d+ chars$`),
    'Dispatch (ignored)': new RegExp(`^${KIND}: unknown tag, fell through to the normal response$`),
  }),
);
const STEP_TYPES: readonly TraceStepType[] = ['decision', 'llm_call', 'retrieval', 'parsing', 'dispatch'];
const STEP_STATUSES: readonly TraceStepStatus[] = ['success', 'error', 'skipped'];
const MODEL_ID = new RegExp(`^${MODEL}$`);

const ms = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The trace as it may be stored: known step names, template results, timings and enums only (see above). */
export function sanitizeTurnTrace(trace: TurnTrace): { trace: TurnTrace; redacted: number } {
  let redacted = 0;
  // review r2 R2-3: a step that is not an object is skipped, and a name is looked up in the Map only
  const raw: unknown[] = Array.isArray(trace.steps) ? trace.steps : [];
  const objects = raw.filter((s): s is TraceStep => s !== null && typeof s === 'object' && !Array.isArray(s));
  redacted += raw.length - objects.length;
  const steps = objects.map((s): TraceStep => {
    const pattern = typeof s.name === 'string' ? STEP_RESULTS.get(s.name) : undefined;
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

// ============================================================================
// Activity metadata (review r2 R2-2)
// ============================================================================
//
// brain_activity.metadata is ops-readable, so every writer stores a whitelisted ActivityMetadata: numbers, the names of
// the tools the app declares, and the context window sizes. sanitizeActivityMetadata is the guard in brain-service's
// startActivity / completeActivity; anything else is dropped. (The turn trace and the error class have their own.)
//
// The database mirrors this whitelist: brain_activity.metadata is the activity_metadata domain, whose CHECK
// app.activity_metadata_violation (backend/scripts/target-shape/tables.sql) refuses any key but ActivityMetadata's,
// turnTrace and error, and any value of another type. A key, a field or a closed set (TOOL_NAMES, STEP_TYPES,
// STEP_STATUSES) added here must be added there too, or every write carrying it fails.

/** The tools the app declares to the model (stage-tools.ts); any other name is 'other'. */
const TOOL_NAMES = new Set(['update_session_state']);

export interface ActivityMetadata {
  maxTokens?: number;
  toolCount?: number;
  queryCount?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  toolInvocations?: Array<{ name: string }>;
  contextSizes?: { pinnedTokens: number; summaryTokens: number; recentTokens: number; ragTokens: number };
}

const NUMBER_KEYS = ['maxTokens', 'toolCount', 'queryCount', 'cacheReadInputTokens', 'cacheWriteInputTokens'] as const;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The metadata as it may be stored: the ActivityMetadata keys with values of their type; the rest is dropped. */
export function sanitizeActivityMetadata(meta: unknown): { metadata: ActivityMetadata; dropped: number } {
  const out: ActivityMetadata = {};
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { metadata: out, dropped: meta === undefined || meta === null ? 0 : 1 };
  }
  const m = meta as Record<string, unknown>;
  let kept = 0;
  for (const k of NUMBER_KEYS) {
    if (num(m[k])) {
      out[k] = m[k] as number;
      kept++;
    }
  }
  if (Array.isArray(m.toolInvocations)) {
    out.toolInvocations = m.toolInvocations.map(t => {
      const name = t !== null && typeof t === 'object' ? (t as { name?: unknown }).name : undefined;
      return { name: typeof name === 'string' && TOOL_NAMES.has(name) ? name : 'other' };
    });
    kept++;
  }
  const cs = m.contextSizes as Record<string, unknown> | undefined;
  if (cs && typeof cs === 'object' && !Array.isArray(cs)) {
    out.contextSizes = {
      pinnedTokens: num(cs.pinnedTokens) ? cs.pinnedTokens : 0,
      summaryTokens: num(cs.summaryTokens) ? cs.summaryTokens : 0,
      recentTokens: num(cs.recentTokens) ? cs.recentTokens : 0,
      ragTokens: num(cs.ragTokens) ? cs.ragTokens : 0,
    };
    kept++;
  }
  return { metadata: out, dropped: Object.keys(m).length - kept };
}
