import type { ContextWindow } from './costs';

/*
 * The prompt inspector's data is structure only: sizes, roles, cache flags and which tags a response carried —
 * never the text a user or the AI wrote (owner decision, work-k5fk.9: "close all").
 */
export interface SystemPromptBlock {
  type: 'static' | 'dynamic';
  chars: number;
  tokenCount: number;
  cached: boolean;
}

export interface PromptMessage {
  role: string;
  chars: number;
  hasCacheControl: boolean;
}

export interface ParsedResponse {
  chars: number;
  stopReason: string | null;
  streaming: boolean;
  hasThinking: boolean;
  hasDraft: boolean;
  hasDispatch: boolean;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  total: number;
  savings: number;
}

export interface PromptDetail {
  systemPrompt: { blocks: SystemPromptBlock[] };
  messages: PromptMessage[];
  response: ParsedResponse;
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  timing: {
    durationMs: number;
    model: string;
    callType: string;
    status: string;
  };
  contextWindow?: ContextWindow;
}
