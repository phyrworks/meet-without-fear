/**
 * Shared Bedrock Client
 *
 * Provides a singleton AWS Bedrock client for all AI services.
 * Implements two-model stratification:
 * - Haiku: Fast, structured output for mechanics (classification, detection, planning)
 * - Sonnet: Empathetic responses for user-facing interactions
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { extractJsonFromResponse } from '../utils/json-extractor';
import type { PromptBlocks } from '../services/stage-prompts';
import { brainService, BrainActivityCallType } from '../services/brain-service';
import type { BrainActivity } from '../generated/prisma/client';
import { ActivityType } from '../generated/prisma/client';
import { recordLlmCall, getContextSizesForTurn } from '../services/llm-telemetry';
import { getFixtureResponseByIndex, getFixtureOperationResponse } from './e2e-fixtures';
import { getE2EFixtureId } from './request-context';
import { bedrockCircuitBreaker, embeddingCircuitBreaker } from '../utils/circuit-breaker';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

// Re-export circuit breakers for monitoring endpoints
export { bedrockCircuitBreaker, embeddingCircuitBreaker };

// AWS Bedrock Pricing (USD per 1,000 tokens) - Updated Feb 2026
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 0.001, output: 0.005, cacheRead: 0.0001, cacheWrite: 0.00125 },
  'amazon.titan-embed-text-v2:0': { input: 0.00002, output: 0.0, cacheRead: 0, cacheWrite: 0 },
  // Legacy entries for historical cost lookups
  'global.anthropic.claude-sonnet-4-6': { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 },
  'anthropic.claude-3-5-haiku-20241022-v1:0': { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
};

// ============================================================================
// Mock LLM Toggle (E2E Testing)
// ============================================================================

/**
 * Check if mock LLM mode is enabled (for E2E testing).
 * When enabled, getModelCompletion returns null, triggering mock response path.
 */
export function isMockLLMEnabled(): boolean {
  return process.env.MOCK_LLM === 'true';
}

// ============================================================================
// Prompt Debug Logging
// ============================================================================

/**
 * Directory for storing prompt debug logs.
 * Files are saved to backend/tmp/prompts/ (gitignored).
 */
const PROMPT_LOG_DIR = path.join(__dirname, '../../tmp/prompts');

/**
 * Save the final prompt to a text file for debugging.
 * Shows exactly what gets sent to the model.
 *
 * @param params - Prompt details to log
 * @returns The file path where the prompt was saved, or null if disabled/failed
 */
function logPromptToFile(params: {
  callType?: BrainActivityCallType | null;
  operation: string;
  model: string;
  systemPrompt: string | PromptBlocks;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  sessionId?: string;
  turnId?: string;
}): string | null {
  // Opt-in: only log when explicitly enabled AND not in production
  if (process.env.ENABLE_PROMPT_LOGGING !== 'true' || process.env.NODE_ENV === 'production') {
    return null;
  }

  try {
    // Ensure directory exists
    if (!fs.existsSync(PROMPT_LOG_DIR)) {
      fs.mkdirSync(PROMPT_LOG_DIR, { recursive: true });
    }

    // Create timestamp for filename: YYYY-MM-DD_HH-MM-SS-mmm
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/:/g, '-')
      .replace(/\./g, '-')
      .replace('T', '_')
      .replace('Z', '');

    // Use callType if available, otherwise operation name
    const identifier = params.callType || params.operation || 'unknown';

    // Sanitize identifier for filename
    const safeIdentifier = String(identifier)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .toLowerCase();

    const filename = `${timestamp}_${safeIdentifier}.txt`;
    const filepath = path.join(PROMPT_LOG_DIR, filename);

    // Build plain text prompt (exactly what gets sent to the model)
    const systemText = typeof params.systemPrompt === 'string'
      ? params.systemPrompt
      : `[STATIC BLOCK]\n${params.systemPrompt.staticBlock}\n\n[DYNAMIC BLOCK]\n${params.systemPrompt.dynamicBlock}`;
    let promptText = `[SYSTEM]\n${systemText}\n`;

    for (const msg of params.messages) {
      const roleLabel = msg.role.toUpperCase();
      promptText += `\n[${roleLabel}]\n${msg.content}\n`;
    }

    fs.writeFileSync(filepath, promptText);
    return filepath;
  } catch (error) {
    // Silent fail - don't let logging break the main flow
    logger.warn('[Bedrock] Failed to log prompt to file:', error);
    return null;
  }
}

/**
 * Save the model's response to a text file.
 * Uses the same prefix as the prompt file with _response suffix.
 *
 * @param promptFilepath - The filepath returned from logPromptToFile
 * @param response - The model's response text
 */
function logResponseToFile(promptFilepath: string | null, response: string | null): void {
  if (!promptFilepath || !response) return;
  if (process.env.ENABLE_PROMPT_LOGGING !== 'true' || process.env.NODE_ENV === 'production') return;

  try {
    // Replace .txt with _response.txt
    const responseFilepath = promptFilepath.replace(/\.txt$/, '_response.txt');
    fs.writeFileSync(responseFilepath, response);
  } catch (error) {
    logger.warn('[Bedrock] Failed to log response to file:', error);
  }
}

// ============================================================================
// Configuration - Two Model Stratification
// ============================================================================

// Haiku: Fast model for mechanics (retrieval planning, classification, detection)
// ~3x faster and cheaper than Sonnet, good for structured JSON output
export const BEDROCK_HAIKU_MODEL_ID =
  process.env.BEDROCK_HAIKU_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

// Sonnet: Empathetic model for user-facing responses
// Better at nuance, empathy, and natural conversation
export const BEDROCK_SONNET_MODEL_ID =
  process.env.BEDROCK_SONNET_MODEL_ID || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Titan: Embedding model for semantic search
// Outputs 1024-dimensional vectors for similarity matching
export const BEDROCK_TITAN_EMBED_MODEL_ID =
  process.env.BEDROCK_TITAN_EMBED_MODEL_ID || 'amazon.titan-embed-text-v2:0';

// Legacy export for backward compatibility
export const BEDROCK_MODEL_ID = BEDROCK_SONNET_MODEL_ID;

// ============================================================================
// Client Singletons
// ============================================================================

let bedrockClient: BedrockRuntimeClient | null | undefined;
let anthropicClient: AnthropicBedrock | null | undefined;

/**
 * Get raw Bedrock client singleton (for Titan embeddings).
 * Returns null if AWS credentials are not configured.
 */
export function getBedrockClient(): BedrockRuntimeClient | null {
  if (bedrockClient === undefined) {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      logger.warn('[Bedrock] AWS credentials not configured - AI services will use mock responses');
      bedrockClient = null;
    } else {
      bedrockClient = new BedrockRuntimeClient({
        region: process.env.AWS_REGION || 'us-east-1',
      });
    }
  }
  return bedrockClient;
}

/**
 * Get Anthropic Bedrock client singleton (for Claude models with caching).
 * Returns null if AWS credentials are not configured.
 */
export function getAnthropicBedrockClient(): AnthropicBedrock | null {
  if (anthropicClient === undefined) {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      anthropicClient = null;
    } else {
      anthropicClient = new AnthropicBedrock({
        awsRegion: process.env.AWS_REGION || 'us-east-1',
      });
    }
  }
  return anthropicClient;
}

/**
 * Reset both clients (useful for testing)
 */
export function resetBedrockClient(): void {
  bedrockClient = undefined;
  anthropicClient = undefined;
}

// ============================================================================
// Helper Types
// ============================================================================

export interface SimpleMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Base options for LLM completion requests.
 * sessionId and turnId are REQUIRED to ensure proper cost tracking and attribution.
 */
export interface CompletionOptions {
  systemPrompt: string | PromptBlocks;
  messages: SimpleMessage[];
  maxTokens?: number;
  thinkingBudget?: number;
  /** Session ID (partner session) for cost attribution */
  sessionId?: string;
  /** Inner work session ID for cost attribution */
  innerWorkSessionId?: string;
  /** Operation name for cost breakdown (e.g., 'intent-detection', 'orchestrator-response') */
  operation: string;
  /** Turn ID to group all costs from a single user action - REQUIRED */
  turnId: string;
  /** Call type for dashboard display categorization */
  callType?: BrainActivityCallType;
  /** Optional Claude tools for structured metadata delivery */
  tools?: AnthropicToolDef[];
}

/**
 * Options for Haiku (fast model) completion requests.
 * sessionId and turnId are REQUIRED to ensure proper cost tracking.
 */
export interface HaikuCompletionOptions {
  systemPrompt: string;
  messages: SimpleMessage[];
  maxTokens?: number;
  /** Session ID (partner session) for cost attribution */
  sessionId?: string;
  /** Inner work session ID for cost attribution */
  innerWorkSessionId?: string;
  /** Operation name for cost breakdown */
  operation: string;
  /** Turn ID to group all costs from a single user action - REQUIRED */
  turnId: string;
  /** Call type for dashboard display categorization */
  callType?: BrainActivityCallType;
}

/**
 * Options for Sonnet (empathetic model) completion requests.
 * Extends CompletionOptions so sessionId and turnId are REQUIRED.
 */
export interface SonnetCompletionOptions extends CompletionOptions {
  // Sonnet-specific options can be added here
  maxTokens?: number;
  thinkingBudget?: number;
}

export type ModelType = 'haiku' | 'sonnet';

export interface CompletionWithToolsResult {
  text: string | null;
  toolInvocations: Array<{ name: string; input: Record<string, unknown> }>;
}

// Re-export BrainActivityCallType for convenience
export { BrainActivityCallType };

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Anthropic message parameter type for the Messages API.
 */
type AnthropicMessageParam = {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
};

/**
 * Convert simple messages to Anthropic Messages API format with cache_control.
 * Adds cache_control to the second-to-last message to cache conversation history prefix.
 */
function toAnthropicMessages(messages: SimpleMessage[]): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Cache conversation history prefix: add cache_control to second-to-last message
  // This caches all messages up to and including this one, so on the next turn
  // the entire history prefix is a cache hit.
  if (result.length >= 2) {
    const target = result[result.length - 2];
    const text = typeof target.content === 'string' ? target.content : '';
    target.content = [{
      type: 'text' as const,
      text,
      cache_control: { type: 'ephemeral' as const },
    }];
  }

  return result;
}


/**
 * Simple completion helper for text-based AI requests.
 * Uses Anthropic Bedrock SDK with prompt caching.
 * Returns the text response or null if client not configured.
 */
export async function getCompletion(options: CompletionOptions): Promise<string | null> {
  // Delegate to getModelCompletion with sonnet
  return getModelCompletion('sonnet', options);
}

/**
 * Get completion from a specific model (Haiku or Sonnet).
 * Uses Anthropic Bedrock SDK with prompt caching for Claude models.
 */
export async function getModelCompletion(
  model: ModelType,
  options: CompletionOptions
): Promise<string | null> {
  const result = await getModelCompletionWithTools(model, options);
  return result?.text ?? null;
}

/**
 * Get completion from a specific model and expose separated tool invocations.
 * Visible text and tool payloads are kept separate so structured metadata never
 * has to be scraped from or appended to user-facing prose.
 */
export async function getModelCompletionWithTools(
  model: ModelType,
  options: CompletionOptions
): Promise<CompletionWithToolsResult | null> {
  // E2E Mock Mode: Return null immediately to trigger mock response path
  if (isMockLLMEnabled()) {
    logger.info(`[Bedrock] MOCK_LLM enabled, skipping ${model} call`);
    return null;
  }

  const client = getAnthropicBedrockClient();
  if (!client) {
    return null;
  }

  // Circuit breaker fast-fail: if Bedrock is in OPEN state, return null immediately
  const cbStats = bedrockCircuitBreaker.getStats();
  if (cbStats.state === 'OPEN') {
    logger.warn(`[Bedrock] Circuit breaker OPEN - skipping ${model} call for ${options.operation}`);
    return null;
  }

  const { systemPrompt, messages, tools, maxTokens = 2048 } = options;
  const modelId = model === 'haiku' ? BEDROCK_HAIKU_MODEL_ID : BEDROCK_SONNET_MODEL_ID;
  const operation = options.operation ?? `converse-${model}`;
  const startTime = Date.now();

  // Resolve system prompt text for logging
  const systemPromptText = typeof systemPrompt === 'string'
    ? systemPrompt
    : `${systemPrompt.staticBlock}\n\n${systemPrompt.dynamicBlock}`;

  // Log prompt to file for debugging
  const promptFilepath = logPromptToFile({
    callType: options.callType,
    operation,
    model: modelId,
    systemPrompt,
    messages,
    maxTokens,
    sessionId: options.sessionId,
    turnId: options.turnId,
  });

  // System prompt with cache_control — split into static (cached) and dynamic (uncached) blocks
  type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
  const system: SystemBlock[] = typeof systemPrompt === 'string'
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' as const } }]
    : [
        { type: 'text', text: systemPrompt.staticBlock, cache_control: { type: 'ephemeral' as const } },
        { type: 'text', text: systemPrompt.dynamicBlock },
      ];

  // Messages with cache_control on second-to-last for history caching
  const anthropicMessages = toAnthropicMessages(messages);

  // Start logging via BrainService
  const activity = await brainService.startActivity({
    sessionId: options.sessionId,
    innerWorkSessionId: options.innerWorkSessionId,
    turnId: options.turnId,
    activityType: ActivityType.LLM_CALL,
    model: modelId,
    input: { operation, messageCount: messages.length, systemPromptLength: systemPromptText.length },
    metadata: { maxTokens, toolCount: tools?.length ?? 0 },
    callType: options.callType,
  });

  try {
    const result = await client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      system,
      messages: anthropicMessages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    } as any);

    // Record success with circuit breaker (resets consecutive failure count)
    bedrockCircuitBreaker.recordSuccess();

    const durationMs = Date.now() - startTime;
    const inputTokens = result.usage.input_tokens;
    const outputTokens = result.usage.output_tokens;
    const cacheReadTokens = (result.usage as any).cache_read_input_tokens ?? 0;
    const cacheWriteTokens = (result.usage as any).cache_creation_input_tokens ?? 0;

    // Cost with cache pricing
    // NOTE: input_tokens from the Bedrock SDK already excludes cache_read and cache_creation tokens.
    // input_tokens = uncached input only. Total content = input_tokens + cache_read + cache_creation.
    const price = PRICING[modelId] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const cost =
      (inputTokens / 1000) * price.input +
      (cacheReadTokens / 1000) * price.cacheRead +
      (cacheWriteTokens / 1000) * price.cacheWrite +
      (outputTokens / 1000) * price.output;

    // Extract text
    const textBlocks = result.content.filter((block) => block.type === 'text');
    const responseText = textBlocks.length > 0
      ? textBlocks.map((block) => block.type === 'text' ? block.text : '').join('')
      : null;
    const toolInvocations = result.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => {
        const toolBlock = block as unknown as { name?: string; input?: unknown };
        return {
          name: toolBlock.name ?? 'unknown',
          input: toolBlock.input && typeof toolBlock.input === 'object'
            ? toolBlock.input as Record<string, unknown>
            : {},
        };
      });

    const contextSizes = getContextSizesForTurn(options.turnId);
    await brainService.completeActivity(activity.id, {
      output: { text: responseText, stopReason: result.stop_reason },
      tokenCountInput: inputTokens,
      tokenCountOutput: outputTokens,
      durationMs,
      cost,
      metadata: {
        cacheReadInputTokens: cacheReadTokens,
        cacheWriteInputTokens: cacheWriteTokens,
        toolInvocations: toolInvocations.map((tool) => ({ name: tool.name })),
        ...(contextSizes ? { contextSizes } : {}),
      },
    });

    recordLlmCall(options.turnId, {
      model: modelId,
      operation,
      inputTokens,
      outputTokens,
      durationMs,
      cacheReadInputTokens: cacheReadTokens,
      cacheWriteInputTokens: cacheWriteTokens,
    });

    if (!responseText) {
      return { text: null, toolInvocations };
    }

    logResponseToFile(promptFilepath, responseText);
    return { text: responseText, toolInvocations };
  } catch (error) {
    // Record failure with circuit breaker (may trip to OPEN state)
    bedrockCircuitBreaker.recordFailure(operation);
    logger.error(`[Bedrock] Failed to get response from ${model}:`, error);
    await brainService.failActivity(activity.id, error);
    return null;
  }
}

/**
 * Get structured JSON output from Haiku.
 * Use for: retrieval planning, classification, detection, extraction.
 * Fast and cheap - ideal for mechanical tasks.
 *
 * @returns Parsed JSON object or null if parsing fails
 */
export async function getHaikuJson<T>(
  options: HaikuCompletionOptions
): Promise<T | null> {
  const response = await getModelCompletion('haiku', {
    ...options,
    maxTokens: options.maxTokens ?? 1024,
    operation: options.operation ?? 'haiku-json',
  });

  if (!response) {
    return null;
  }

  try {
    return extractJsonFromResponse(response) as T;
  } catch (error) {
    logger.error('[Bedrock] Failed to parse Haiku JSON response:', error);
    logger.error('[Bedrock] Raw response:', response);
    // Retry once
    const retry = await getModelCompletion('haiku', {
      ...options,
      maxTokens: options.maxTokens ?? 1024,
      operation: options.operation ? `${options.operation}-retry` : 'haiku-json-retry',
    });
    if (!retry) return null;
    try {
      return extractJsonFromResponse(retry) as T;
    } catch {
      logger.error('[Bedrock] Retry also failed to parse Haiku JSON');
      return null;
    }
  }
}

/**
 * Get empathetic response from Sonnet.
 * Use for: user-facing responses, witnessing, empathy building.
 * Better at nuance and natural conversation.
 */
export async function getSonnetResponse(
  options: SonnetCompletionOptions
): Promise<string | null> {
  // E2E Mock Mode: Check for operation-specific fixture response first
  if (isMockLLMEnabled()) {
    const fixtureId = getE2EFixtureId();
    const operation = options.operation ?? 'sonnet-response';
    if (fixtureId) {
      const mockResponse = getFixtureOperationResponse(fixtureId, operation);
      if (mockResponse) {
        logger.info(`[Bedrock] MOCK_LLM enabled, returning fixture response for operation: ${operation}`);
        return mockResponse;
      }
      logger.info(`[Bedrock] MOCK_LLM enabled, no fixture response for operation: ${operation}`);
    }
    // Fall through to getModelCompletion which will return null
  }

  return getModelCompletion('sonnet', {
    ...options,
    maxTokens: options.maxTokens ?? 2048,
    operation: options.operation ?? 'sonnet-response',
  });
}

// ============================================================================
// Embeddings (Titan)
// ============================================================================

/**
 * Embedding dimensions for vector storage.
 * Titan v2 supports 256, 512, or 1024 dimensions.
 * We use 1024 for best quality - matches schema: vector(1024).
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Generate an embedding vector for text using Titan.
 * Use for: semantic search, similarity matching, vector storage.
 *
 * @param text - The text to embed (max ~8000 tokens)
 * @returns Float array of embedding dimensions, or null if unavailable
 */
export async function getEmbedding(text: string, options?: { sessionId?: string; innerWorkSessionId?: string; turnId?: string }): Promise<number[] | null> {
  const client = getBedrockClient();
  if (!client) {
    return null;
  }

  // Circuit breaker fast-fail: if embedding service is in OPEN state, return null
  const embCbStats = embeddingCircuitBreaker.getStats();
  if (embCbStats.state === 'OPEN') {
    logger.warn('[Bedrock] Embedding circuit breaker OPEN - skipping embedding call');
    return null;
  }

  // Truncate text if too long (Titan has ~8000 token limit)
  const truncatedText = text.slice(0, 30000); // Rough character limit

  try {
    const command = new InvokeModelCommand({
      modelId: BEDROCK_TITAN_EMBED_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: truncatedText,
        dimensions: EMBEDDING_DIMENSIONS,
        normalize: true,
      }),
    });

    const startTime = Date.now();

    // Start logging via BrainService (non-blocking — don't let logging failures prevent embeddings)
    let activity: BrainActivity | null = null;
    if (options?.sessionId || options?.innerWorkSessionId) {
      try {
        activity = await brainService.startActivity({
          sessionId: options.sessionId,
          innerWorkSessionId: options.innerWorkSessionId,
          turnId: options?.turnId,
          activityType: ActivityType.EMBEDDING,
          model: BEDROCK_TITAN_EMBED_MODEL_ID,
          input: { textLength: truncatedText.length },
        });
      } catch (logError) {
        logger.warn('[Bedrock] Failed to log embedding activity (continuing without logging):', (logError as Error).message);
      }
    }

    const response = await client.send(command);
    const durationMs = Date.now() - startTime;

    if (!response.body) {
      if (activity) {
        await brainService.failActivity(activity.id, 'No response body from Bedrock').catch(() => {});
      }
      return null;
    }

    // Extract actual token count from response headers (Bedrock returns this for InvokeModel)
    // Fallback to estimation if not available
    const headerTokenCount = (response as any).$metadata?.httpHeaders?.['x-amzn-bedrock-input-token-count'];
    const inputTokens = headerTokenCount ? parseInt(headerTokenCount, 10) : Math.ceil(truncatedText.length / 4);

    // Calculate cost (Titan Embeddings V2)
    // Price: $0.00002 per 1,000 tokens
    const cost = (inputTokens / 1000) * 0.00002;

    if (activity) {
      await brainService.completeActivity(activity.id, {
        output: { success: true }, // Don't log vector to avoid bloat
        tokenCountInput: inputTokens,
        cost,
        durationMs,
      }).catch(() => {});
    }

    // Record success with embedding circuit breaker
    embeddingCircuitBreaker.recordSuccess();

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    return responseBody.embedding as number[];
  } catch (error) {
    // Record failure with embedding circuit breaker (may trip to OPEN state)
    embeddingCircuitBreaker.recordFailure('embedding');
    logger.error('[Bedrock] Failed to generate embedding:', error);
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in batch.
 * More efficient than calling getEmbedding() multiple times.
 *
 * @param texts - Array of texts to embed
 * @returns Array of embeddings (null for any that failed)
 */
export async function getEmbeddings(texts: string[]): Promise<(number[] | null)[]> {
  // Titan doesn't support batch embeddings natively, so we parallelize
  const results = await Promise.all(texts.map((text) => getEmbedding(text)));
  return results;
}

// ============================================================================
// Streaming (SSE Support)
// ============================================================================

/**
 * Stream event types for SSE response handling.
 */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number }; error?: undefined }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number }; error: string };

/**
 * Anthropic tool definition type for the Messages API.
 */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Options for Sonnet streaming completion requests.
 */
export interface SonnetStreamingOptions {
  systemPrompt: string | PromptBlocks;
  messages: SimpleMessage[];
  tools?: AnthropicToolDef[];
  maxTokens?: number;
  /** Session ID for cost attribution - REQUIRED */
  sessionId: string;
  /** Operation name for cost breakdown */
  operation: string;
  /** Turn ID to group all costs from a single user action - REQUIRED */
  turnId: string;
  /** Call type for dashboard display categorization */
  callType?: BrainActivityCallType;
  /** Response index for mock mode - used to select which fixture response to return */
  mockResponseIndex?: number;
}

/**
 * Get streaming response from Sonnet using Anthropic Bedrock SDK.
 * Use for: real-time user-facing responses with SSE delivery.
 * Includes prompt caching for system prompts and conversation history.
 *
 * Yields StreamEvent objects:
 * - { type: 'text', text: string } - Text delta as it arrives
 * - { type: 'tool_use', toolUseId: string, name: string, input: object } - Tool call when complete
 * - { type: 'done', usage: { inputTokens, outputTokens } } - Final event with token usage
 */
export async function* getSonnetStreamingResponse(
  options: SonnetStreamingOptions
): AsyncGenerator<StreamEvent, void, unknown> {
  // E2E Mock Mode: Yield fixture response as text events
  if (isMockLLMEnabled()) {
    const fixtureId = getE2EFixtureId();
    if (fixtureId && options.mockResponseIndex !== undefined) {
      try {
        logger.info(`[Bedrock] MOCK_LLM enabled, loading fixture ${fixtureId} index ${options.mockResponseIndex}`);
        const mockResponse = getFixtureResponseByIndex(fixtureId, options.mockResponseIndex);
        logger.info(`[Bedrock] Yielding mock response: "${mockResponse.substring(0, 80)}..."`);

        yield { type: 'text', text: mockResponse };
        yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } };
        return;
      } catch (error) {
        logger.error('[Bedrock] Failed to load fixture response:', error);
      }
    } else {
      logger.info('[Bedrock] MOCK_LLM enabled but no fixture configured, returning empty');
    }
    yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } };
    return;
  }

  const client = getAnthropicBedrockClient();
  if (!client) {
    yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } };
    return;
  }

  // Circuit breaker fast-fail for streaming
  const streamCbStats = bedrockCircuitBreaker.getStats();
  if (streamCbStats.state === 'OPEN') {
    logger.warn('[Bedrock] Circuit breaker OPEN - skipping streaming call');
    yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } };
    return;
  }

  const { systemPrompt, messages, tools, maxTokens = 2048 } = options;
  const startTime = Date.now();

  // Resolve system prompt text for logging
  const systemPromptText = typeof systemPrompt === 'string'
    ? systemPrompt
    : `${systemPrompt.staticBlock}\n\n${systemPrompt.dynamicBlock}`;

  // Log prompt to file for debugging
  const promptFilepath = logPromptToFile({
    callType: options.callType,
    operation: options.operation,
    model: BEDROCK_SONNET_MODEL_ID,
    systemPrompt,
    messages,
    maxTokens,
    sessionId: options.sessionId,
    turnId: options.turnId,
  });

  // System prompt with cache_control — split into static (cached) and dynamic (uncached) blocks
  type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
  const system: SystemBlock[] = typeof systemPrompt === 'string'
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' as const } }]
    : [
        { type: 'text', text: systemPrompt.staticBlock, cache_control: { type: 'ephemeral' as const } },
        { type: 'text', text: systemPrompt.dynamicBlock },
      ];

  // Messages with cache_control on second-to-last for history caching
  const anthropicMessages = toAnthropicMessages(messages);

  // Start logging via BrainService
  const activity = await brainService.startActivity({
    sessionId: options.sessionId,
    turnId: options.turnId,
    activityType: ActivityType.LLM_CALL,
    model: BEDROCK_SONNET_MODEL_ID,
    input: {
      operation: options.operation,
      messageCount: messages.length,
      systemPromptLength: systemPromptText.length,
      streaming: true,
    },
    metadata: {
      maxTokens,
      toolCount: tools?.length ?? 0,
    },
    callType: options.callType,
  });

  try {
    const stream = client.messages.stream({
      model: BEDROCK_SONNET_MODEL_ID,
      max_tokens: maxTokens,
      system,
      messages: anthropicMessages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    } as any);

    // Track visible prose separately from tool invocations. Tool payloads must
    // never be appended to the text buffer that is streamed or logged as prose.
    let currentToolUseId: string | undefined;
    let currentToolName: string | undefined;
    let accumulatedToolInput = '';
    let accumulatedResponseText = '';
    const toolInvocations: Array<{ name: string; input: Record<string, unknown> }> = [];

    for await (const event of stream) {
      // Text delta
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        accumulatedResponseText += event.delta.text;
        yield { type: 'text', text: event.delta.text };
      }

      // Tool use start
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        currentToolUseId = event.content_block.id;
        currentToolName = event.content_block.name;
        accumulatedToolInput = '';
      }

      // Tool use delta (accumulate input JSON)
      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        accumulatedToolInput += event.delta.partial_json;
      }

      // Content block stop - emit accumulated tool use
      if (event.type === 'content_block_stop' && currentToolUseId && currentToolName) {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = accumulatedToolInput ? JSON.parse(accumulatedToolInput) : {};
        } catch (parseError) {
          logger.error('[Bedrock] Failed to parse tool input JSON:', parseError);
        }

        toolInvocations.push({ name: currentToolName, input: parsedInput });

        yield {
          type: 'tool_use',
          toolUseId: currentToolUseId,
          name: currentToolName,
          input: parsedInput,
        };
        currentToolUseId = undefined;
        currentToolName = undefined;
        accumulatedToolInput = '';
      }
    }

    // Get final message with full usage stats
    const finalMessage = await stream.finalMessage();
    const durationMs = Date.now() - startTime;
    const inputTokens = finalMessage.usage.input_tokens;
    const outputTokens = finalMessage.usage.output_tokens;
    const cacheReadTokens = (finalMessage.usage as any).cache_read_input_tokens ?? 0;
    const cacheWriteTokens = (finalMessage.usage as any).cache_creation_input_tokens ?? 0;

    // Calculate cost with cache pricing
    // NOTE: input_tokens from the Bedrock SDK already excludes cache_read and cache_creation tokens.
    // input_tokens = uncached input only. Total content = input_tokens + cache_read + cache_creation.
    const price = PRICING[BEDROCK_SONNET_MODEL_ID] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const cost =
      (inputTokens / 1000) * price.input +
      (cacheReadTokens / 1000) * price.cacheRead +
      (cacheWriteTokens / 1000) * price.cacheWrite +
      (outputTokens / 1000) * price.output;

    // Complete activity log
    const streamContextSizes = getContextSizesForTurn(options.turnId);
    await brainService.completeActivity(activity.id, {
      output: { streaming: true, stopReason: finalMessage.stop_reason },
      tokenCountInput: inputTokens,
      tokenCountOutput: outputTokens,
      durationMs,
      cost,
      metadata: {
        cacheReadInputTokens: cacheReadTokens,
        cacheWriteInputTokens: cacheWriteTokens,
        toolInvocations: toolInvocations.map((tool) => ({ name: tool.name })),
        ...(streamContextSizes ? { contextSizes: streamContextSizes } : {}),
      },
    });

    recordLlmCall(options.turnId, {
      model: BEDROCK_SONNET_MODEL_ID,
      operation: options.operation,
      inputTokens,
      outputTokens,
      durationMs,
      cacheReadInputTokens: cacheReadTokens,
      cacheWriteInputTokens: cacheWriteTokens,
    });

    // Record success with circuit breaker
    bedrockCircuitBreaker.recordSuccess();

    // Log the accumulated response
    logResponseToFile(promptFilepath, accumulatedResponseText);

    // Yield done event with usage
    yield { type: 'done', usage: { inputTokens, outputTokens } };
  } catch (error) {
    // Record failure with circuit breaker (may trip to OPEN state)
    bedrockCircuitBreaker.recordFailure('streaming');

    const errorMessage = (error as Error).message ?? String(error);
    logger.error('[Bedrock] Streaming error:', errorMessage);
    await brainService.failActivity(activity.id, error);
    // Yield a done event with error flag instead of throwing.
    // This lets the consumer handle the error gracefully via the
    // normal event loop rather than requiring a try/catch around
    // the async iterator.
    yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 }, error: errorMessage };
  }
}
