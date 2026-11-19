export type ActivityType = 'LLM_CALL' | 'EMBEDDING' | 'RETRIEVAL' | 'TOOL_USE' | 'SYSTEM' | 'USER';
export type ActivityStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

/**
 * Call types for typed LLM event display.
 * Maps to specific display components for each type.
 */
export type BrainActivityCallType =
  | 'ORCHESTRATED_RESPONSE'
  | 'RETRIEVAL_PLANNING'
  | 'INTENT_DETECTION'
  | 'BACKGROUND_CLASSIFICATION'
  | 'PARTNER_SESSION_CLASSIFICATION'
  | 'CHAT_ROUTER_RESPONSE'
  | 'REFERENCE_DETECTION'
  | 'PEOPLE_EXTRACTION'
  | 'MEMORY_DETECTION'
  | 'MEMORY_VALIDATION'
  | 'RECONCILER_ANALYSIS'
  | 'SUMMARIZATION'
  | 'NEEDS_EXTRACTION'
  | 'WITNESSING_RESPONSE'
  | 'MEMORY_FORMATTING'
  | 'THEME_EXTRACTION';

/**
 * Sonnet call types (warm accent - user-facing)
 */
export const SONNET_CALL_TYPES: BrainActivityCallType[] = [
  'ORCHESTRATED_RESPONSE',
  'RECONCILER_ANALYSIS',
  'NEEDS_EXTRACTION',
  'WITNESSING_RESPONSE',
];

/**
 * Check if a call type is a Sonnet (user-facing) call
 */
export function isSonnetCallType(callType: BrainActivityCallType | null | undefined): boolean {
  return callType !== null && callType !== undefined && SONNET_CALL_TYPES.includes(callType);
}

export interface BrainActivity {
  id: string;
  sessionId: string;
  turnId?: string | null;
  activityType: ActivityType;
  model?: string | null;
  input: any;
  output: any;
  metadata: any;
  /** Typed call type for dashboard display */
  callType?: BrainActivityCallType | null;
  /**
   * Structured output data for typed display components. The backend no longer sends it: the column
   * brain_activity.structured_output never had a writer and is dropped (work-k5fk.9, J1); the components
   * fall back to `{}`.
   */
  structuredOutput?: any;
  tokenCountInput: number;
  tokenCountOutput: number;
  cost: number;
  durationMs: number;
  status: ActivityStatus;
  createdAt: string;
  completedAt?: string | null;
}

export interface AuditLogData {
  sessionId?: string;
  turnId?: string;
  data?: any;
}
