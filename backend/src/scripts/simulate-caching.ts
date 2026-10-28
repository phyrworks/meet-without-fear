#!/usr/bin/env npx ts-node
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Prompt Caching Simulation Script
 *
 * Simulates a user going through Onboarding → Invitation → Stage 1 → Stage 2,
 * making real Bedrock API calls and tracking cache hit/miss metrics.
 *
 * Usage:
 *   cd backend && source .env && npx tsx src/scripts/simulate-caching.ts
 *
 * What it does:
 *   1. Builds the same system prompts the app would build (using stage-prompts.ts)
 *   2. Makes real Bedrock API calls with cache_control breakpoints
 *   3. Tracks cache_read_input_tokens and cache_creation_input_tokens
 *   4. Reports a summary of cache effectiveness across the session
 *
 * Timing: Calls are made back-to-back (no 5-min TTL gap), which is the
 * best-case scenario for caching. Real users may pause longer.
 */

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { buildStagePrompt, type PromptBlocks, type PromptContext } from '../services/stage-prompts';
import type { ContextBundle } from '../services/context-assembler';

// ============================================================================
// Configuration
// ============================================================================

const SONNET_MODEL_ID = process.env.BEDROCK_SONNET_MODEL_ID || 'global.anthropic.claude-sonnet-4-6';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const MAX_TOKENS = 1024; // Keep responses short for the simulation

// Pricing (per 1,000 tokens)
const PRICING = {
  input: 0.003,
  output: 0.015,
  cacheRead: 0.0003,
  cacheWrite: 0.00375,
};

// ============================================================================
// Types
// ============================================================================

interface TurnResult {
  turn: number;
  stage: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalContentTokens: number;
  costWithCaching: number;
  costWithoutCaching: number;
  savings: number;
  savingsPercent: number;
  staticBlockChars: number;
  dynamicBlockChars: number;
  messageCount: number;
  durationMs: number;
  aiResponse: string;
}

interface SimpleMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ============================================================================
// Bedrock Client
// ============================================================================

function getClient(): AnthropicBedrock {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('❌ AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
    process.exit(1);
  }
  return new AnthropicBedrock({ awsRegion: AWS_REGION });
}

// ============================================================================
// Message Formatting (mirrors bedrock.ts)
// ============================================================================

type AnthropicMessageParam = {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
};

function toAnthropicMessages(messages: SimpleMessage[]): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // Cache conversation history prefix: add cache_control to second-to-last message
  if (result.length >= 2) {
    const target = result[result.length - 2];
    const text = typeof target.content === 'string' ? target.content : '';
    target.content = [
      {
        type: 'text' as const,
        text,
        cache_control: { type: 'ephemeral' as const },
      },
    ];
  }

  return result;
}

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

function buildSystemBlocks(prompt: PromptBlocks): SystemBlock[] {
  return [
    { type: 'text', text: prompt.staticBlock, cache_control: { type: 'ephemeral' as const } },
    { type: 'text', text: prompt.dynamicBlock },
  ];
}

// ============================================================================
// Simulated User Messages
// ============================================================================

/** Realistic user messages for each stage */
const STAGE1_USER_MESSAGES = [
  "My partner Sarah and I have been having a lot of arguments lately about money. She thinks I spend too much and I feel like she's being controlling.",
  "It's been going on for about 6 months now. Ever since she got promoted and started making more money, she's been acting like she gets to make all the financial decisions.",
  "I feel like she doesn't respect me. Like my contributions to the household don't matter because I make less than her.",
  "Yeah, it really hurts. We used to make decisions together and now I feel like I'm just along for the ride. Like I don't have a say in anything.",
  "I guess what's at stake is... our partnership. I don't want to feel like I'm living in someone else's house following their rules. I want to feel like we're a team.",
  "That's exactly it. I need to feel like we're equals in this relationship, regardless of who makes more money.",
  'Yeah, I do feel heard. You really got it.',
];

const STAGE2_USER_MESSAGES = [
  "I don't know... I guess she's probably stressed about the extra responsibility from the promotion?",
  "Maybe she feels like she has to be responsible with the money because she's earning more now. Like there's more pressure on her.",
  "I think she might be scared that if we're not careful with money, something bad could happen. Like she feels responsible for our financial security.",
  "I guess she might also feel hurt that I don't seem to appreciate how hard she's working. Like she's doing all this for us and I'm just complaining about it.",
  "She might be feeling alone in carrying this weight. Like I'm not seeing her effort, just fighting against the rules she's trying to set.",
];

// ============================================================================
// Minimal Context Bundle (just enough to build prompts)
// ============================================================================

function makeContextBundle(stage: number, turnCount: number): ContextBundle {
  return {
    conversationContext: {
      recentTurns: [],
      turnCount,
      sessionDurationMinutes: turnCount * 2,
    },
    emotionalThread: {
      initialIntensity: 6,
      currentIntensity: Math.max(3, 6 - Math.floor(turnCount / 3)),
      trend: 'de-escalating',
      notableShifts: [],
    },
    stageContext: {
      stage,
      gatesSatisfied: {},
    },
    userName: 'Alex',
    partnerName: 'Sarah',
    intent: {
      intent: 'emotional_validation' as const,
      depth: 'light' as const,
      reason: 'simulation',
      threshold: 0.5,
      maxCrossSession: 5,
      allowCrossSession: false,
      surfaceStyle: 'silent' as const,
    },
    assembledAt: new Date().toISOString(),
  };
}

function makePromptContext(stage: number, turnCount: number, emotionalIntensity: number): PromptContext {
  return {
    userName: 'Alex',
    partnerName: 'Sarah',
    turnCount,
    emotionalIntensity,
    contextBundle: makeContextBundle(stage, turnCount),
  };
}

// ============================================================================
// API Call with Cache Tracking
// ============================================================================

async function makeCachedCall(
  client: AnthropicBedrock,
  systemBlocks: SystemBlock[],
  messages: SimpleMessage[],
): Promise<{
  response: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
}> {
  const anthropicMessages = toAnthropicMessages(messages);
  const startTime = Date.now();

  const result = await client.messages.create({
    model: SONNET_MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: systemBlocks,
    messages: anthropicMessages,
  });

  const durationMs = Date.now() - startTime;
  const usage = result.usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };

  const textBlock = result.content.find(block => block.type === 'text');
  const response = textBlock && textBlock.type === 'text' ? textBlock.text : '';

  return {
    response,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    durationMs,
  };
}

// ============================================================================
// Extract clean response (strip <thinking> tags)
// ============================================================================

function extractCleanResponse(raw: string): string {
  // Strip <thinking>...</thinking> blocks
  const cleaned = raw.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
  return cleaned || raw;
}

// ============================================================================
// Main Simulation
// ============================================================================

async function runSimulation() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║         PROMPT CACHING SIMULATION — Meet Without Fear      ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║ Model: ${SONNET_MODEL_ID.padEnd(52)}║`);
  console.log(`║ Region: ${AWS_REGION.padEnd(51)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  const client = getClient();
  const results: TurnResult[] = [];
  const conversationHistory: SimpleMessage[] = [];
  let turnNumber = 0;

  // Helper to run a turn
  async function runTurn(
    stageName: string,
    stageNum: number,
    userMessage: string,
    turnInStage: number,
    emotionalIntensity: number,
    options?: { isStageTransition?: boolean; previousStage?: number; isInvitationPhase?: boolean },
  ): Promise<void> {
    turnNumber++;
    const promptContext = makePromptContext(stageNum, turnInStage, emotionalIntensity);

    const prompt = buildStagePrompt(stageNum, promptContext, {
      isStageTransition: options?.isStageTransition,
      previousStage: options?.previousStage,
      isInvitationPhase: options?.isInvitationPhase,
    });

    const systemBlocks = buildSystemBlocks(prompt);

    // Add user message to history
    conversationHistory.push({ role: 'user', content: userMessage });

    console.log(`━━━ Turn ${turnNumber} [${stageName}] ━━━`);
    console.log(`  User: "${userMessage.substring(0, 70)}..."`);
    console.log(
      `  Static block: ${prompt.staticBlock.length} chars (~${Math.ceil(prompt.staticBlock.length / 4)} tokens)`,
    );
    console.log(
      `  Dynamic block: ${prompt.dynamicBlock.length} chars (~${Math.ceil(prompt.dynamicBlock.length / 4)} tokens)`,
    );
    console.log(`  Messages: ${conversationHistory.length}`);

    try {
      const apiResult = await makeCachedCall(client, systemBlocks, conversationHistory);

      const cleanResponse = extractCleanResponse(apiResult.response);

      // Add AI response to history
      conversationHistory.push({ role: 'assistant', content: apiResult.response });

      // input_tokens from Bedrock SDK = uncached portion only
      // Total content = input_tokens + cache_read + cache_write
      const totalContentTokens = apiResult.inputTokens + apiResult.cacheReadTokens + apiResult.cacheWriteTokens;

      // Cost calculation
      const costWithCaching =
        (apiResult.inputTokens / 1000) * PRICING.input +
        (apiResult.cacheReadTokens / 1000) * PRICING.cacheRead +
        (apiResult.cacheWriteTokens / 1000) * PRICING.cacheWrite +
        (apiResult.outputTokens / 1000) * PRICING.output;

      const costWithoutCaching =
        (totalContentTokens / 1000) * PRICING.input + (apiResult.outputTokens / 1000) * PRICING.output;

      const savings = costWithoutCaching - costWithCaching;
      const savingsPercent = costWithoutCaching > 0 ? (savings / costWithoutCaching) * 100 : 0;

      const result: TurnResult = {
        turn: turnNumber,
        stage: stageName,
        inputTokens: apiResult.inputTokens,
        outputTokens: apiResult.outputTokens,
        cacheReadTokens: apiResult.cacheReadTokens,
        cacheWriteTokens: apiResult.cacheWriteTokens,
        totalContentTokens,
        costWithCaching,
        costWithoutCaching,
        savings,
        savingsPercent,
        staticBlockChars: prompt.staticBlock.length,
        dynamicBlockChars: prompt.dynamicBlock.length,
        messageCount: conversationHistory.length,
        durationMs: apiResult.durationMs,
        aiResponse: cleanResponse.substring(0, 100),
      };

      results.push(result);

      // Cache status indicator
      const cacheStatus =
        apiResult.cacheReadTokens > 0
          ? `✅ CACHE HIT (${apiResult.cacheReadTokens} read)`
          : apiResult.cacheWriteTokens > 0
            ? `📝 CACHE WRITE (${apiResult.cacheWriteTokens} written)`
            : '❌ NO CACHE';

      console.log(`  ${cacheStatus}`);
      console.log(
        `  Input: ${apiResult.inputTokens} | Output: ${apiResult.outputTokens} | Time: ${apiResult.durationMs}ms`,
      );
      console.log(
        `  Cache: read=${apiResult.cacheReadTokens}, write=${apiResult.cacheWriteTokens}, total=${totalContentTokens}`,
      );
      console.log(
        `  Cost: $${costWithCaching.toFixed(5)} (vs $${costWithoutCaching.toFixed(5)} without cache, saving ${savingsPercent.toFixed(1)}%)`,
      );
      console.log(`  AI: "${cleanResponse.substring(0, 80)}..."`);
      console.log();
    } catch (err: unknown) {
      console.error(`  ❌ API Error: ${err instanceof Error ? err.message : String(err)}`);
      console.log();
      // Add a mock response so we can continue
      conversationHistory.push({ role: 'assistant', content: 'I hear you. Tell me more about that.' });
    }
  }

  // ========================================================================
  // STAGE 1: Witnessing (7 turns)
  // ========================================================================
  console.log('\n🎯 STAGE 1: Witnessing (Feel Heard)\n');

  for (let i = 0; i < STAGE1_USER_MESSAGES.length; i++) {
    const intensity = Math.max(3, 7 - i); // Intensity decreases over time
    await runTurn(
      'Stage 1',
      1,
      STAGE1_USER_MESSAGES[i],
      i + 1,
      intensity,
      i === 0 ? { isStageTransition: true, previousStage: 0 } : undefined,
    );
  }

  // ========================================================================
  // STAGE 2: Perspective Stretch (5 turns)
  // Note: Stage transition changes the static block → cache miss expected
  // ========================================================================
  console.log('\n🎯 STAGE 2: Perspective Stretch (Empathy Building)\n');

  for (let i = 0; i < STAGE2_USER_MESSAGES.length; i++) {
    const intensity = Math.max(3, 5 - Math.floor(i / 2)); // Lower intensity in Stage 2
    await runTurn(
      'Stage 2',
      2,
      STAGE2_USER_MESSAGES[i],
      i + 1,
      intensity,
      i === 0 ? { isStageTransition: true, previousStage: 1 } : undefined,
    );
  }

  // ========================================================================
  // Summary Report
  // ========================================================================
  printSummary(results);
}

// ============================================================================
// Summary Report
// ============================================================================

function printSummary(results: TurnResult[]) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    CACHING SUMMARY REPORT                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Per-turn table
  console.log('┌──────┬───────────┬────────┬────────┬────────┬────────┬─────────┬─────────┐');
  console.log('│ Turn │ Stage     │ Input  │ Cache  │ Cache  │ Total  │ Cost    │ Savings │');
  console.log('│      │           │ Tokens │ Read   │ Write  │ Contnt │ ($)     │ (%)     │');
  console.log('├──────┼───────────┼────────┼────────┼────────┼────────┼─────────┼─────────┤');

  for (const r of results) {
    const stage = r.stage.padEnd(9);
    const input = String(r.inputTokens).padStart(6);
    const read = String(r.cacheReadTokens).padStart(6);
    const write = String(r.cacheWriteTokens).padStart(6);
    const uncached = String(r.totalContentTokens).padStart(6);
    const cost = `$${r.costWithCaching.toFixed(4)}`.padStart(7);
    const savings = `${r.savingsPercent.toFixed(1)}%`.padStart(7);
    console.log(
      `│ ${String(r.turn).padStart(4)} │ ${stage} │ ${input} │ ${read} │ ${write} │ ${uncached} │ ${cost} │ ${savings} │`,
    );
  }
  console.log('└──────┴───────────┴────────┴────────┴────────┴────────┴─────────┴─────────┘');

  // Aggregate stats
  const totalInputTokens = results.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutputTokens = results.reduce((s, r) => s + r.outputTokens, 0);
  const totalCacheReads = results.reduce((s, r) => s + r.cacheReadTokens, 0);
  const totalCacheWrites = results.reduce((s, r) => s + r.cacheWriteTokens, 0);
  const totalCostWith = results.reduce((s, r) => s + r.costWithCaching, 0);
  const totalCostWithout = results.reduce((s, r) => s + r.costWithoutCaching, 0);
  const totalSavings = totalCostWithout - totalCostWith;
  const totalSavingsPercent = totalCostWithout > 0 ? (totalSavings / totalCostWithout) * 100 : 0;
  const turnsWithCacheRead = results.filter(r => r.cacheReadTokens > 0).length;
  const turnsWithCacheWrite = results.filter(r => r.cacheWriteTokens > 0).length;
  const avgDuration = results.reduce((s, r) => s + r.durationMs, 0) / results.length;

  console.log('\n📊 AGGREGATE METRICS');
  console.log('─'.repeat(50));
  console.log(`  Total turns:              ${results.length}`);
  console.log(
    `  Turns with cache READ:    ${turnsWithCacheRead} / ${results.length} (${((turnsWithCacheRead / results.length) * 100).toFixed(0)}%)`,
  );
  console.log(`  Turns with cache WRITE:   ${turnsWithCacheWrite} / ${results.length}`);
  console.log(`  Total input tokens:       ${totalInputTokens.toLocaleString()}`);
  console.log(`  Total output tokens:      ${totalOutputTokens.toLocaleString()}`);
  console.log(`  Total cache read tokens:  ${totalCacheReads.toLocaleString()}`);
  console.log(`  Total cache write tokens: ${totalCacheWrites.toLocaleString()}`);
  console.log(`  Average response time:    ${avgDuration.toFixed(0)}ms`);
  console.log();
  console.log('💰 COST ANALYSIS');
  console.log('─'.repeat(50));
  console.log(`  Cost WITH caching:        $${totalCostWith.toFixed(5)}`);
  console.log(`  Cost WITHOUT caching:     $${totalCostWithout.toFixed(5)}`);
  console.log(`  Total savings:            $${totalSavings.toFixed(5)} (${totalSavingsPercent.toFixed(1)}%)`);

  // Cache hit rate by stage
  const stage1Results = results.filter(r => r.stage === 'Stage 1');
  const stage2Results = results.filter(r => r.stage === 'Stage 2');

  const stage1Reads = stage1Results.filter(r => r.cacheReadTokens > 0).length;
  const stage2Reads = stage2Results.filter(r => r.cacheReadTokens > 0).length;

  console.log();
  console.log('📈 CACHE HIT RATE BY STAGE');
  console.log('─'.repeat(50));
  console.log(
    `  Stage 1 (${stage1Results.length} turns): ${stage1Reads} cache reads (${((stage1Reads / Math.max(1, stage1Results.length)) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  Stage 2 (${stage2Results.length} turns): ${stage2Reads} cache reads (${((stage2Reads / Math.max(1, stage2Results.length)) * 100).toFixed(0)}%)`,
  );

  // Caching verdict
  console.log();
  console.log('🔍 VERDICT');
  console.log('─'.repeat(50));

  if (totalSavingsPercent > 15) {
    console.log('  ✅ Caching is providing meaningful savings.');
    console.log(`  System prompt caching saves ${totalSavingsPercent.toFixed(1)}% on input costs.`);
  } else if (totalSavingsPercent > 5) {
    console.log('  ⚠️  Caching is providing modest savings.');
    console.log(`  ${totalSavingsPercent.toFixed(1)}% savings — helps but not transformative.`);
  } else if (totalSavingsPercent > 0) {
    console.log('  ⚠️  Caching is barely helping.');
    console.log(`  Only ${totalSavingsPercent.toFixed(1)}% savings — the overhead may not be worth it.`);
  } else {
    console.log('  ❌ Caching is NOT providing savings.');
    console.log('  Cache writes add 25% surcharge with no cache reads to offset.');
  }

  // Key observations
  console.log();
  console.log('📝 KEY OBSERVATIONS');
  console.log('─'.repeat(50));

  // Check if first turn in each stage gets cache write
  const firstStage1 = results.find(r => r.stage === 'Stage 1');
  const firstStage2 = results.find(r => r.stage === 'Stage 2');

  if (firstStage1 && firstStage1.cacheWriteTokens > 0) {
    console.log(
      `  • Stage 1 turn 1: Cache WRITE of ${firstStage1.cacheWriteTokens} tokens (expected: system prompt + no history to read)`,
    );
  } else if (firstStage1) {
    console.log(`  • Stage 1 turn 1: NO cache activity (system prompt may be below 1,024 token minimum)`);
  }

  if (firstStage2 && firstStage2.cacheWriteTokens > 0) {
    console.log(
      `  • Stage 2 turn 1: Cache WRITE of ${firstStage2.cacheWriteTokens} tokens (new system prompt after stage transition)`,
    );
  }

  // Check message count growth
  const lastResult = results[results.length - 1];
  console.log(`  • Final message count: ${lastResult?.messageCount ?? 0} messages in history`);
  console.log(
    `  • Static block range: ${Math.min(...results.map(r => r.staticBlockChars))} - ${Math.max(...results.map(r => r.staticBlockChars))} chars`,
  );

  // Cache read tokens as % of total input
  if (totalCacheReads > 0) {
    const cacheReadPercent = (totalCacheReads / totalInputTokens) * 100;
    console.log(`  • Cache read tokens are ${cacheReadPercent.toFixed(1)}% of total input tokens`);
  }

  // Note about TTL
  console.log();
  console.log('⚠️  IMPORTANT: This simulation runs turns back-to-back (no delay).');
  console.log('   In production, users often pause 5+ minutes between messages,');
  console.log('   exceeding the 5-minute Bedrock cache TTL. Real cache hit rates');
  console.log('   will be LOWER than what this simulation shows.');
  console.log();
}

// ============================================================================
// Run
// ============================================================================

runSimulation().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
