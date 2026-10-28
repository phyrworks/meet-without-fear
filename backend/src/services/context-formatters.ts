import type { ContextBundle } from './context-assembler';

export interface ContextFormattingOptions {
  sharedContentHistory?: string | null;
  milestoneContext?: string | null;
}

/**
 * Long-idle threshold (24h). Duplicated from conversation-summarizer to avoid
 * a circular import; kept here as the render-side gate so the threshold stays
 * in one logical place per direction of control.
 */
const LONG_IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const STAGE_HISTORY_CONTENT_LIMIT = 360;
const SHARE_STATE_CONTENT_LIMIT = 360;
const PRIOR_STAGE_CONTENT_LIMIT = 240;

/** Humanize an idle duration for inclusion in the prompt. */
function formatIdleDuration(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 36) return `~${Math.round(hours)} hours`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/**
 * Render the re-orientation hint block when the user is returning after a
 * long gap. Branches based on whether the summarizer produced a concrete
 * cliffhanger (`lastUnresolvedThread`) or explicitly null-ed it (milestone
 * reached / no two-sided dynamic to leave unresolved).
 *
 * Returns null when the bundle doesn't warrant a resumption framing at all
 * (active conversation or first-turn-ever).
 */
function renderResumptionSection(bundle: ContextBundle): string | null {
  const idleMs = bundle.conversationContext.timeSinceLastUserTurnMs;
  if (idleMs == null || idleMs < LONG_IDLE_THRESHOLD_MS) return null;

  const duration = formatIdleDuration(idleMs);
  const stage = bundle.stageContext.stage;
  const cliffhanger = bundle.sessionSummary?.lastUnresolvedThread ?? null;

  const lines = [`--- Resumption (${duration} since last turn) ---`];
  if (cliffhanger) {
    lines.push(`Paused mid-thread: "${cliffhanger}"`);
    lines.push('Weave a gentle re-orientation into your first response before picking up where they left off.');
  } else {
    lines.push(`Status: Just entered Stage ${stage}. Awaiting your orientation.`);
    lines.push(
      'Welcome them back without manufacturing unresolved tension — they reached a clean point before the gap.',
    );
  }
  return lines.join('\n');
}

export function formatContextForPromptLegacy(bundle: ContextBundle): string {
  const parts: string[] = [];

  if (bundle.globalFacts && bundle.globalFacts.length > 0) {
    parts.push('ABOUT THIS USER (from previous sessions):');
    const byCategory = new Map<string, string[]>();
    for (const fact of bundle.globalFacts) {
      const existing = byCategory.get(fact.category) || [];
      existing.push(fact.fact);
      byCategory.set(fact.category, existing);
    }
    for (const [category, facts] of byCategory) {
      parts.push(`[${category}]`);
      for (const fact of facts) {
        parts.push(`- ${fact}`);
      }
    }
    parts.push('');
  }

  {
    const intensity = bundle.emotionalThread.currentIntensity;
    const trend = bundle.emotionalThread.trend;
    const turnCount = bundle.conversationContext.turnCount;

    const trendLabel = trend === 'stable' ? 'Stable' : trend === 'unknown' ? 'Unknown' : 'Changed';
    const intensityStr = intensity !== null ? `${intensity}/10` : 'Unknown';

    parts.push(`[Intensity: ${intensityStr} (${trendLabel}) | Turn ${turnCount}]`);
    parts.push('');
  }

  if (bundle.priorThemes && bundle.priorThemes.themes.length > 0) {
    parts.push(`FROM PRIOR SESSIONS (use for continuity only):`);
    parts.push(bundle.priorThemes.themes.join(', '));
    parts.push('');
  }

  if (bundle.sessionSummary) {
    parts.push(`SESSION SUMMARY:`);
    parts.push(`Key themes: ${bundle.sessionSummary.keyThemes.join(', ')}`);
    parts.push(`Current focus: ${bundle.sessionSummary.currentFocus}`);
    if (bundle.sessionSummary.emotionalJourney) {
      parts.push(`Emotional journey: ${bundle.sessionSummary.emotionalJourney}`);
    }
    if (bundle.sessionSummary.userStatedGoals && bundle.sessionSummary.userStatedGoals.length > 0) {
      parts.push(`Topics that may need follow-up: ${bundle.sessionSummary.userStatedGoals.join(', ')}`);
    }
    parts.push('');
  }

  if (bundle.innerThoughtsContext && bundle.innerThoughtsContext.relevantReflections.length > 0) {
    parts.push(`FROM ${bundle.userName.toUpperCase()}'S PRIVATE REFLECTIONS:`);
    parts.push(`(These are from their Inner Thoughts - private processing they've done.`);
    parts.push(`Reference gently, don't quote directly, and respect their privacy.)`);
    for (const reflection of bundle.innerThoughtsContext.relevantReflections) {
      const marker = reflection.isFromLinkedSession ? '[linked to this session]' : '';
      parts.push(`- "${reflection.content}" ${marker}`);
    }
    parts.push('');
  }

  if (bundle.userMemories) {
    const allMemories = [...bundle.userMemories.global, ...bundle.userMemories.session];
    if (allMemories.length > 0) {
      parts.push('USER MEMORIES (Always Honor These):');
      for (const memory of allMemories) {
        parts.push(`- [${memory.category}] ${memory.content}`);
      }
      parts.push('');
    }
  }

  if (bundle.notableFacts && bundle.notableFacts.length > 0) {
    parts.push('NOTED FACTS FROM THIS SESSION:');
    const byCategory = new Map<string, string[]>();
    for (const fact of bundle.notableFacts) {
      const existing = byCategory.get(fact.category) || [];
      existing.push(fact.fact);
      byCategory.set(fact.category, existing);
    }
    for (const [category, facts] of byCategory) {
      parts.push(`[${category}]`);
      for (const fact of facts) {
        parts.push(`- ${fact}`);
      }
    }
    parts.push('');
  }

  const result = parts.join('\n');
  return result;
}

export function formatContextForPrompt(bundle: ContextBundle, options?: ContextFormattingOptions): string {
  const parts: string[] = [];

  const intensity = bundle.emotionalThread.currentIntensity;
  const trend = bundle.emotionalThread.trend;
  const intensityStr = intensity !== null ? `${intensity}/10` : 'Unknown';
  parts.push(`Intensity: ${intensityStr} (${trend}) | Turn ${bundle.conversationContext.turnCount}`);

  // Long-idle resumption framing — surfaces before the rolling summary so the
  // AI orients on it first. No-op for active conversations.
  const resumption = renderResumptionSection(bundle);
  if (resumption) parts.push(resumption);

  if (bundle.sessionSummary) {
    parts.push('--- Rolling summary ---');
    parts.push(bundle.sessionSummary.currentFocus);

    if (bundle.sessionSummary.keyThemes.length > 0) {
      parts.push(`Themes: ${bundle.sessionSummary.keyThemes.join(', ')}`);
    }

    if (bundle.sessionSummary.agreedFacts?.length) {
      parts.push(`Agreed facts: ${bundle.sessionSummary.agreedFacts.join('; ')}`);
    }

    if (bundle.sessionSummary.userNeeds?.length || bundle.sessionSummary.partnerNeeds?.length) {
      const userNeeds = bundle.sessionSummary.userNeeds?.length
        ? bundle.sessionSummary.userNeeds.join('; ')
        : 'Not yet named';
      // Only reveal partner needs when the consent gate has been satisfied.
      // Without this guard the AI sees the summarizer's "partnerNeeds" (which
      // may just be the user's empathy *guesses*) and presents them as if the
      // partner actually said them — a critical consent violation (issue #312).
      const partnerNeedsShared = bundle.stageContext?.gatesSatisfied?.needsShared === true;
      if (partnerNeedsShared) {
        const partnerNeeds = bundle.sessionSummary.partnerNeeds?.length
          ? bundle.sessionSummary.partnerNeeds.join('; ')
          : 'Not yet named';
        parts.push(`Needs: User → ${userNeeds}. Partner → ${partnerNeeds}.`);
      } else {
        parts.push(`Needs: User → ${userNeeds}.`);
      }
    }

    if (bundle.sessionSummary.openQuestions?.length || bundle.sessionSummary.userStatedGoals?.length) {
      const openQuestions = bundle.sessionSummary.openQuestions?.length
        ? bundle.sessionSummary.openQuestions.join('; ')
        : bundle.sessionSummary.userStatedGoals.join('; ');
      if (openQuestions) {
        parts.push(`Open questions: ${openQuestions}`);
      }
    }

    if (bundle.sessionSummary.agreements?.length) {
      parts.push(`Agreements/experiments: ${bundle.sessionSummary.agreements.join('; ')}`);
    }
  }

  if (bundle.userMemories) {
    const allMemories = [...bundle.userMemories.global, ...bundle.userMemories.session];
    if (allMemories.length > 0) {
      const memoryLines = allMemories.slice(0, 5).map(memory => `- ${memory.content}`);
      parts.push('--- User preferences to honor ---');
      parts.push(...memoryLines);
    }
  }

  if (bundle.notableFacts && bundle.notableFacts.length > 0) {
    const factLines = bundle.notableFacts.slice(0, 5).map(fact => `- ${fact.fact}`);
    parts.push('--- Notable facts ---');
    parts.push(...factLines);
  }

  if (bundle.topicFrame?.text) {
    parts.push('--- Conversation topic ---');
    parts.push(`Confirmed topic: "${bundle.topicFrame.text}"`);
    parts.push(
      'Use this as orientation only. Stage gates still come from StageProgress and explicit product lifecycle state.',
    );
  }

  if (bundle.priorStageSummaries?.stages.length) {
    parts.push('--- Prior stage summaries (current user lane only) ---');
    parts.push(
      'Use this only for continuity. Stage gates still come from StageProgress and explicit product lifecycle state.',
    );
    for (const summary of bundle.priorStageSummaries.stages) {
      parts.push(renderPriorStageSummary(summary));
    }
  }

  if (bundle.consentedShareState?.items.length) {
    parts.push('--- Consented partner/share state ---');
    parts.push(
      'Use this only for orientation. Stage gates still come from StageProgress and empathy/share/validation lifecycle state.',
    );
    for (const item of bundle.consentedShareState.items) {
      parts.push(renderConsentedShareStateItem(item));
    }
  }

  if (bundle.currentStageHistory?.messages.length) {
    parts.push(`--- Current Stage ${bundle.currentStageHistory.stage} history (current user lane only) ---`);
    parts.push(
      'Use this only for continuity. Stage gates still come from StageProgress and explicit product lifecycle state.',
    );
    for (const message of bundle.currentStageHistory.messages) {
      parts.push(`- ${renderStageHistoryRole(message.role)}: ${truncateStageHistoryContent(message.content)}`);
    }
  }

  if (bundle.innerThoughtsContext?.relevantReflections?.length) {
    parts.push('--- Private reflections (gentle reference) ---');
    for (const reflection of bundle.innerThoughtsContext.relevantReflections.slice(0, 2)) {
      parts.push(`- ${reflection.content}`);
    }
  }

  if (options?.sharedContentHistory) {
    parts.push('--- Shared/consent state ---');
    parts.push(options.sharedContentHistory);
  }

  if (options?.milestoneContext) {
    parts.push('--- Milestones ---');
    parts.push(options.milestoneContext);
  }

  return parts.filter(part => part.trim().length > 0).join('\n');
}

function renderStageHistoryRole(
  role: NonNullable<ContextBundle['currentStageHistory']>['messages'][number]['role'],
): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'AI';
    case 'empathy_statement':
      return 'Empathy statement';
    case 'shared_context':
      return 'Shared context';
    default:
      return 'System';
  }
}

function truncateStageHistoryContent(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= STAGE_HISTORY_CONTENT_LIMIT) return compact;
  return `${compact.slice(0, STAGE_HISTORY_CONTENT_LIMIT - 1)}…`;
}

function renderPriorStageSummary(summary: NonNullable<ContextBundle['priorStageSummaries']>['stages'][number]): string {
  const status = summary.lifecycleStatus
    ? ` (${summary.lifecycleStatus}${summary.completedAt ? `; completed ${summary.completedAt}` : ''})`
    : '';
  const lines = [
    `Stage ${summary.stage}${status}: ${summary.userTurnCount} user turn(s), ${summary.assistantTurnCount} AI turn(s).`,
  ];

  for (const highlight of summary.highlights) {
    lines.push(`  - ${renderStageHistoryRole(highlight.role)}: ${truncatePriorStageContent(highlight.content)}`);
  }

  return lines.join('\n');
}

function truncatePriorStageContent(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= PRIOR_STAGE_CONTENT_LIMIT) return compact;
  return `${compact.slice(0, PRIOR_STAGE_CONTENT_LIMIT - 1)}…`;
}

function renderConsentedShareStateItem(
  item: NonNullable<ContextBundle['consentedShareState']>['items'][number],
): string {
  const direction = item.direction === 'user_to_partner' ? 'You shared' : 'Partner shared';
  const kind = item.kind === 'empathy_attempt' ? 'empathy attempt' : 'additional context';
  const timestamps = [
    item.sharedAt ? `shared ${item.sharedAt}` : null,
    item.deliveredAt ? `delivered ${item.deliveredAt}` : null,
    item.revealedAt ? `revealed ${item.revealedAt}` : null,
    item.validatedAt ? `validated ${item.validatedAt}` : null,
  ].filter(Boolean);
  const lifecycle = [item.lifecycleStatus, ...timestamps].join('; ');
  const content = item.content
    ? `: ${truncateShareStateContent(item.content)}`
    : ' (content not yet visible to this user)';

  return `- ${direction} ${kind} (${lifecycle})${content}`;
}

function truncateShareStateContent(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= SHARE_STATE_CONTENT_LIMIT) return compact;
  return `${compact.slice(0, SHARE_STATE_CONTENT_LIMIT - 1)}…`;
}
