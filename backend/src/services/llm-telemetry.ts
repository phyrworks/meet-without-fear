import { logger } from '../lib/logger';
import { estimateMessagesTokens, estimateTokens } from '../utils/token-budget';

export interface ContextSizeMetrics {
  pinnedTokens: number;
  summaryTokens: number;
  recentTokens: number;
  ragTokens: number;
}

export interface LlmCallMetrics {
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

interface TurnAggregate {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  models: Record<string, number>;
  contextSizes?: ContextSizeMetrics;
}

const turnMetrics = new Map<string, TurnAggregate>();

export function recordLlmCall(turnId: string | undefined, metrics: LlmCallMetrics): void {
  if (!turnId) return;
  const existing = turnMetrics.get(turnId) ?? {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    models: {},
  };

  existing.callCount += 1;
  existing.inputTokens += metrics.inputTokens;
  existing.outputTokens += metrics.outputTokens;
  existing.durationMs += metrics.durationMs;
  existing.cacheReadInputTokens += metrics.cacheReadInputTokens ?? 0;
  existing.cacheWriteInputTokens += metrics.cacheWriteInputTokens ?? 0;
  existing.models[metrics.model] = (existing.models[metrics.model] ?? 0) + 1;

  turnMetrics.set(turnId, existing);
}

export function recordContextSizes(turnId: string | undefined, sizes: ContextSizeMetrics): void {
  if (!turnId) return;
  const existing = turnMetrics.get(turnId) ?? {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    models: {},
  };
  existing.contextSizes = sizes;
  turnMetrics.set(turnId, existing);
}

export function finalizeTurnMetrics(turnId: string | undefined): void {
  if (!turnId) return;
  const aggregate = turnMetrics.get(turnId);
  if (!aggregate) return;

  const modelSummary = Object.entries(aggregate.models)
    .map(([model, count]) => `${model}x${count}`)
    .join(', ');

  const cacheInfo =
    aggregate.cacheReadInputTokens > 0 || aggregate.cacheWriteInputTokens > 0
      ? ` cache_read=${aggregate.cacheReadInputTokens} cache_write=${aggregate.cacheWriteInputTokens}` +
        ` cache_hit_rate=${aggregate.inputTokens > 0 ? Math.round((aggregate.cacheReadInputTokens / aggregate.inputTokens) * 100) : 0}%`
      : '';

  logger.info(
    `[LLM Metrics] turn=${turnId} calls=${aggregate.callCount} ` +
      `tokens_in=${aggregate.inputTokens} tokens_out=${aggregate.outputTokens} ` +
      `duration_ms=${aggregate.durationMs} models=[${modelSummary}]${cacheInfo}`,
  );

  if (aggregate.contextSizes) {
    const { pinnedTokens, summaryTokens, recentTokens, ragTokens } = aggregate.contextSizes;
    logger.info(
      `[Context Metrics] turn=${turnId} pinned=${pinnedTokens} summary=${summaryTokens} ` +
        `recent=${recentTokens} rag=${ragTokens}`,
    );
  }

  turnMetrics.delete(turnId);
}

export function getContextSizesForTurn(turnId: string | undefined): ContextSizeMetrics | undefined {
  if (!turnId) return undefined;
  return turnMetrics.get(turnId)?.contextSizes;
}

export function estimateContextSizes(params: {
  pinned: string;
  summary: string;
  recentMessages: Array<{ role: string; content: string }>;
  rag: string;
}): ContextSizeMetrics {
  return {
    pinnedTokens: estimateTokens(params.pinned),
    summaryTokens: estimateTokens(params.summary),
    recentTokens: estimateMessagesTokens(params.recentMessages),
    ragTokens: estimateTokens(params.rag),
  };
}
