import fs from 'fs';
import path from 'path';
import { buildStagePromptString } from '../services/stage-prompts';
import { formatContextForPrompt } from '../services/context-formatters';
import type { ContextBundle } from '../services/context-assembler';
import { estimateMessagesTokens, estimateTokens, trimConversationHistory, CONTEXT_WINDOW } from '../utils/token-budget';
import { determineMemoryIntent } from '../services/memory-intent';

type FixtureMessage = { role: 'user' | 'assistant'; content: string };

type Fixture = {
  id: string;
  stage: number;
  userName: string;
  partnerName?: string;
  emotionalIntensity: number;
  summary?: {
    currentFocus: string;
    keyThemes: string[];
    emotionalJourney: string;
    userStatedGoals: string[];
    agreedFacts?: string[];
    userNeeds?: string[];
    partnerNeeds?: string[];
    openQuestions?: string[];
    agreements?: string[];
  };
  messages: FixtureMessage[];
};

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'llm-fixtures.json');

function loadFixtures(): Fixture[] {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  return JSON.parse(raw) as Fixture[];
}

function buildBundle(fixture: Fixture, useSummary: boolean): ContextBundle {
  return {
    conversationContext: {
      recentTurns: [],
      turnCount: fixture.messages.length,
      sessionDurationMinutes: 0,
    },
    emotionalThread: {
      initialIntensity: fixture.emotionalIntensity,
      currentIntensity: fixture.emotionalIntensity,
      trend: 'stable',
      notableShifts: [],
    },
    stageContext: {
      stage: fixture.stage,
      gatesSatisfied: {},
    },
    userName: fixture.userName,
    partnerName: fixture.partnerName,
    intent: determineMemoryIntent({
      stage: fixture.stage,
      emotionalIntensity: fixture.emotionalIntensity,
      userMessage: fixture.messages.at(-1)?.content ?? '',
      turnCount: fixture.messages.length,
    }),
    assembledAt: new Date().toISOString(),
    sessionSummary:
      useSummary && fixture.summary
        ? {
            ...fixture.summary,
          }
        : undefined,
  };
}

function buildMessagesWithContext(history: FixtureMessage[], contextText: string): FixtureMessage[] {
  if (history.length === 0) return [];
  const base = history.slice(0, -1);
  const current = history[history.length - 1];
  const prefix = contextText.trim() ? `Context:\n${contextText}\n\nUser message: ${current.content}` : current.content;
  return [...base, { role: 'user', content: prefix }];
}

function estimateTurnTokens(systemPrompt: string, messages: FixtureMessage[]): number {
  return estimateTokens(systemPrompt) + estimateMessagesTokens(messages);
}

function simulateFixture(fixture: Fixture) {
  let totalTokens = 0;
  let totalCalls = 0;
  let turnCount = 0;

  const useSummary = Boolean(fixture.summary);
  const bundle = buildBundle(fixture, useSummary);

  for (let i = 0; i < fixture.messages.length; i++) {
    if (fixture.messages[i].role !== 'user') continue;
    const history = fixture.messages.slice(0, i + 1);

    const prompt = buildStagePromptString(fixture.stage, {
      userName: fixture.userName,
      partnerName: fixture.partnerName,
      turnCount: i + 1,
      emotionalIntensity: fixture.emotionalIntensity,
      contextBundle: bundle,
    });

    const contextText = formatContextForPrompt(bundle);

    const { trimmed } = trimConversationHistory(
      history.map(m => ({ role: m.role, content: m.content })),
      useSummary ? CONTEXT_WINDOW.recentTurnsWithSummary : CONTEXT_WINDOW.recentTurnsWithoutSummary,
    );

    const messagesWithContext = buildMessagesWithContext(trimmed, contextText);
    const tokens = estimateTurnTokens(prompt, messagesWithContext);

    const intent = determineMemoryIntent({
      stage: fixture.stage,
      emotionalIntensity: fixture.emotionalIntensity,
      userMessage: history[history.length - 1].content,
      turnCount: i + 1,
    });

    const calls = 1 + (intent.depth === 'full' ? 1 : 0);

    totalTokens += tokens;
    totalCalls += calls;
    turnCount += 1;
  }

  return {
    totalTokens,
    averageTokens: turnCount ? Math.round(totalTokens / turnCount) : 0,
    averageCalls: turnCount ? Number((totalCalls / turnCount).toFixed(2)) : 0,
    turnCount,
  };
}

function main() {
  const fixtures = loadFixtures();
  const results = fixtures.map(fixture => {
    const stats = simulateFixture(fixture);
    return { fixture: fixture.id, stats };
  });

  for (const result of results) {
    console.log(`\nFixture: ${result.fixture}`);
    console.log(`  avg tokens/turn: ${result.stats.averageTokens}, avg calls/turn: ${result.stats.averageCalls}`);
  }
}

main();
