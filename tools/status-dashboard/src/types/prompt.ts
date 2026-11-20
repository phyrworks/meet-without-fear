import type { ContextWindow } from './costs';

/*
 * The prompt inspector's data: tokens, cost, timing and the context window. No prompt or response, not even
 * their structure: the monitor's role holds no grant on brain_activity input or output (work-k5fk.9).
 */
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
