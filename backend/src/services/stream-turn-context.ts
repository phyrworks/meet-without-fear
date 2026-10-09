/**
 * Stream Turn Context
 *
 * Context assembly for a streaming chat turn, extracted (behavior-preserving)
 * from `sendMessageStream`: summary-aware history load, turn counting,
 * partner resolution, context-bundle assembly, Stage 2B (Informed Empathy)
 * routing, Stage 4 prompt contexts, Tending context, stage prompt build, and
 * the final model message array with injected context.
 */

import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { Message } from '../generated/prisma/client';
import { getSessionSummary } from './conversation-summarizer';
import { getPartnerUserId } from '../utils/session';
import { assembleContextBundle, formatContextForPrompt } from './context-assembler';
import type { MemoryIntentResult } from './memory-intent';
import { getMilestoneContext, getSharedContentContext } from './shared-context';
import { getSharedContextForGuesser } from './reconciler';
import { buildStagePrompt } from './stage-prompts';
import {
  buildTendingConversationPrompt,
  isExplicitAskForInput,
  type TendingConversationPromptContext,
} from './stage4-prompts';
import { getStage4State as buildStage4State, Stage4StateNotFoundError } from './stage4-state';
import { CONTEXT_WINDOW, trimConversationHistory } from '../utils/token-budget';
import { estimateContextSizes, recordContextSizes } from './llm-telemetry';
import { updateContext } from '../lib/request-context';
import type { RefiningNeedContext } from './stream-turn-actions';

// ============================================================================
// Stage 4 / Tending prompt-context helpers
// ============================================================================

async function getStage4InventoryPromptContext(sessionId: string, currentUserId: string): Promise<string | null> {
  const proposals = await prisma.strategyProposal.findMany({
    where: { sessionId },
    orderBy: { updatedAt: 'asc' },
    take: 12,
  });

  const activeProposals = proposals.filter((proposal) => proposal.status !== 'REMOVED');
  if (activeProposals.length === 0) return null;

  return activeProposals
    .map((proposal) => {
      const owner = proposal.createdByUserId === currentUserId
        ? 'current user'
        : proposal.createdByUserId
          ? 'partner'
          : 'shared/no owner';
      const details = [
        `id=${proposal.id}`,
        `kind=${proposal.kind}`,
        `owner=${owner}`,
        `description="${proposal.description}"`,
      ];
      if (proposal.duration) details.push(`duration="${proposal.duration}"`);
      if (proposal.measureOfSuccess) details.push(`success="${proposal.measureOfSuccess}"`);
      return `- ${details.join(' | ')}`;
    })
    .join('\n');
}

async function getStage4WalkthroughPromptContext(
  sessionId: string,
  currentUserId: string
): Promise<string | null> {
  try {
    const state = await buildStage4State(sessionId, currentUserId);
    const walkthrough = state.walkthrough;
    const lines = [
      `phase=${walkthrough.phase}`,
      `currentIndex=${walkthrough.currentIndex + 1}`,
      `totalInPhase=${walkthrough.totalInPhase}`,
    ];

    if (walkthrough.currentNeed) {
      lines.push(
        `currentNeedId=${walkthrough.currentNeed.id}`,
        `currentNeedLabel="${walkthrough.currentNeed.label}"`,
        `currentNeedSource=${walkthrough.currentNeed.source}`,
        `currentNeedStatus=${walkthrough.currentNeed.status}`,
      );
    } else {
      lines.push('currentNeedId=null');
    }

    const formatNeed = (need: typeof walkthrough.ownNeeds[number]) =>
      `- id=${need.id} | status=${need.status} | label="${need.label}"`;
    if (walkthrough.ownNeeds.length > 0) {
      lines.push('ownNeeds:', ...walkthrough.ownNeeds.map(formatNeed));
    }
    if (walkthrough.partnerNeeds.length > 0) {
      lines.push('partnerNeeds:', ...walkthrough.partnerNeeds.map(formatNeed));
    }

    const currentProposalLines = walkthrough.proposalGroups
      .flatMap((group) =>
        group.proposals.map((proposal) => {
          const details = [
            `- group=${group.key}`,
            `id=${proposal.id}`,
            `kind=${proposal.kind}`,
            `description="${proposal.description}"`,
          ];
          if (proposal.duration) details.push(`duration="${proposal.duration}"`);
          if (proposal.measureOfSuccess) details.push(`success="${proposal.measureOfSuccess}"`);
          return details.join(' | ');
        })
      );
    if (currentProposalLines.length > 0) {
      lines.push('currentNeedProposals:', ...currentProposalLines);
    }

    return lines.join('\n');
  } catch (error) {
    if (error instanceof Stage4StateNotFoundError) return null;
    logger.warn('[getStage4WalkthroughPromptContext] failed', { error });
    return null;
  }
}

/**
 * Stage 4 Phase 6 — open needs (not declined, not yet willing-covered) with
 * their labels, so the AI can surface one at a time in main chat with the
 * user's own phrasing.
 */
async function getStage4OpenNeedsForPrompt(
  sessionId: string,
  userId: string
): Promise<Array<{ needLabel: string }> | null> {
  try {
    const [coverageRows, willingSelections, declinations] = await Promise.all([
      prisma.stage4NeedCoverage.findMany({
        where: { sessionId, coverageStatus: { in: ['OPEN', 'PARTIAL'] } },
        select: { id: true, needId: true, needLabel: true, coveringProposalIds: true },
      }),
      prisma.stage4ProposalSelection.findMany({
        where: { sessionId, userId, decision: 'WILLING' },
        select: { proposalId: true },
      }),
      prisma.stage4NeedDeclination.findMany({
        where: { sessionId, userId },
        select: { needId: true },
      }),
    ]);
    if (coverageRows.length === 0) return null;
    const willingIds = new Set(willingSelections.map((s) => s.proposalId));
    const declined = new Set(declinations.map((d) => d.needId));
    const candidateRows = coverageRows.filter((row) => {
      const needId = row.needId ?? row.id;
      if (declined.has(needId)) return false;
      const covered = row.coveringProposalIds.some((pid) => willingIds.has(pid));
      return !covered;
    });
    if (candidateRows.length === 0) return null;
    const needIds = candidateRows.map((r) => r.needId).filter((n): n is string => Boolean(n));
    const needs = needIds.length > 0
      ? await prisma.identifiedNeed.findMany({
          where: { id: { in: needIds }, vessel: { userId } },
          select: { id: true, need: true },
        })
      : [];
    const byId = new Map(needs.map((n) => [n.id, n.need] as const));
    const labels: Array<{ needLabel: string }> = [];
    for (const row of candidateRows) {
      // Prefer the user's exact phrasing from IdentifiedNeed; fall back to the
      // coverage row's needLabel so coverage rows without an IdentifiedNeed
      // link (or whose link belongs to the partner's vessel) still surface.
      const label = (row.needId && byId.get(row.needId)) || row.needLabel;
      if (label) labels.push({ needLabel: label });
    }
    return labels.length > 0 ? labels : null;
  } catch (err) {
    logger.warn('[getStage4OpenNeedsForPrompt] failed', { error: err });
    return null;
  }
}

/**
 * Stage 4 Phase 6 (Surface 6) — listen-first mode. Active when the session is
 * RESOLVED and the user hasn't yet explicitly asked the AI for input since
 * re-entry. Once any user message in history matches the explicit-ask regex,
 * advice mode persists for the rest of the conversation.
 */
async function isStage4ListenFirstMode(
  _sessionId: string,
  _userId: string,
  sessionStatus: string,
  history: Array<{ role: string; content: string }>
): Promise<boolean> {
  if (sessionStatus !== 'RESOLVED') return false;
  const askedForInput = history.some(
    (m) => m.role === 'USER' && isExplicitAskForInput(m.content)
  );
  return !askedForInput;
}

async function getTendingConversationContextForPrompt(
  sessionId: string,
  userId: string
): Promise<TendingConversationPromptContext | null> {
  try {
    const [entries, needs, selectedNotes, latestCheckins] = await Promise.all([
      prisma.tendingEntry.findMany({
        where: {
          sessionId,
          OR: [
            { scope: 'SHARED' },
            { scope: 'INDIVIDUAL', ownerUserId: userId },
            { scope: 'INDIVIDUAL', optedInShared: true },
          ],
        },
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        take: 8,
        select: {
          id: true,
          summary: true,
          scope: true,
          agreement: { select: { measureOfSuccess: true } },
        },
      }),
      prisma.stage4NeedCoverage.findMany({
        where: { sessionId, sourceUserId: userId },
        orderBy: [{ updatedAt: 'desc' }],
        take: 8,
        select: { needId: true, needLabel: true },
      }),
      prisma.tendingBetweenPeriodNote.findMany({
        where: {
          sessionId,
          userId,
          carryForwardSelected: true,
        },
        orderBy: [{ createdAt: 'asc' }],
        take: 8,
        select: {
          id: true,
          content: true,
          consentToShareWithPartner: true,
        },
      }),
      prisma.tendingCheckin.findMany({
        where: { sessionId, userId },
        orderBy: [{ submittedAt: 'desc' }],
        take: 3,
        include: {
          entryOutcomes: true,
          needOutcomes: true,
          adjustments: true,
        },
      }),
    ]);

    if (entries.length === 0 && selectedNotes.length === 0 && latestCheckins.length === 0) {
      return null;
    }

    const latestStructuredOutcomes = latestCheckins.flatMap((checkin) => [
      `Check-in ${checkin.id}: continueChoice=${checkin.continueChoice ?? 'none'} nextAction=${checkin.nextAction ?? 'none'}`,
      ...checkin.entryOutcomes.map((outcome) =>
        `Entry ${outcome.tendingEntryId}: followThrough=${outcome.followThroughStatus}; helpfulness=${outcome.helpfulnessStatus ?? 'none'}; blockers=${outcome.blockerCategories.join(', ') || 'none'}; stillWorthTrying=${outcome.stillWorthTrying ?? 'unknown'}`
      ),
      ...checkin.needOutcomes.map((outcome) =>
        `Need ${outcome.needLabel}: ${outcome.resolutionStatus}${outcome.nextAction ? `; nextAction=${outcome.nextAction}` : ''}`
      ),
      ...checkin.adjustments.map((adjustment) =>
        `Adjustment ${adjustment.tendingEntryId}: ${adjustment.revisedCommitmentText ?? 'no text'}${adjustment.revisedCadence ? `; cadence=${adjustment.revisedCadence}` : ''}${adjustment.revisedSuccessCriteria ? `; success=${adjustment.revisedSuccessCriteria}` : ''}`
      ),
    ]).join('\n');

    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        summary: entry.summary,
        scope: entry.scope,
        successCriteria: entry.agreement?.measureOfSuccess ?? null,
      })),
      needs: needs.map((need) => ({
        id: need.needId,
        label: need.needLabel,
      })),
      selectedBetweenPeriodNotes: selectedNotes.map((note) => ({
        id: note.id,
        content: note.content,
        consentToShareWithPartner: note.consentToShareWithPartner,
      })),
      latestStructuredOutcomes: latestStructuredOutcomes || null,
    };
  } catch (err) {
    logger.warn('[getTendingConversationContextForPrompt] failed', { sessionId, userId, error: err });
    return null;
  }
}

// ============================================================================
// Turn context assembly
// ============================================================================

export interface StreamTurnContextParams {
  requestId: string;
  sessionId: string;
  user: { id: string; name?: string | null };
  session: { status: string; topicFrame: string | null; topicFrameConfirmedAt: Date | null };
  currentStage: number;
  refiningNeedContext: RefiningNeedContext | null;
}

export interface StreamTurnContext {
  /** Chronological (oldest-first) recent history for this user. */
  history: Message[];
  userTurnCount: number;
  stageTurnCount: number;
  turnId: string;
  partnerId: string | null;
  partnerName: string | undefined;
  userName: string;
  isInvitationPhase: boolean;
  /** Stage used for prompting/persistence (21 = Stage 2B Informed Empathy). */
  effectiveStage: number;
  prompt: { staticBlock: string; dynamicBlock: string };
  /** Trimmed history with the context bundle injected into the last user message. */
  messagesWithContext: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export async function assembleStreamTurnContext(
  params: StreamTurnContextParams
): Promise<StreamTurnContext> {
  const { requestId, sessionId, user, session, currentStage, refiningNeedContext } = params;

  // ===========================================================================
  // Get conversation history for context (summary-aware)
  // ===========================================================================
  const existingSummary = await getSessionSummary(sessionId, user.id);
  const summaryBoundary = existingSummary?.summary.newestMessageAt;
  const historyLimit = summaryBoundary ? 30 : 20;

  const historyDesc = await prisma.message.findMany({
    where: {
      sessionId,
      OR: [
        { senderId: user.id, forUserId: null },
        { forUserId: user.id },
      ],
      ...(summaryBoundary ? { timestamp: { gt: summaryBoundary } } : {}),
    },
    orderBy: { timestamp: 'desc' },
    take: historyLimit,
  });
  const history = historyDesc.slice().reverse();

  // Count ALL user messages for this session (not just from the limited history window)
  // This prevents turn IDs from getting stuck when conversation exceeds 20 messages
  // Also count user messages in the CURRENT stage only — stage-specific guards
  // (e.g., feel-heard check, early-stage guidance) need stage-scoped counts so they
  // don't fire prematurely due to accumulated turns from earlier stages.
  const [userTurnCount, stageTurnCount] = await Promise.all([
    prisma.message.count({
      where: {
        sessionId,
        role: 'USER',
        senderId: user.id,
        forUserId: null,
      },
    }),
    prisma.message.count({
      where: {
        sessionId,
        role: 'USER',
        senderId: user.id,
        forUserId: null,
        stage: currentStage,
      },
    }),
  ]);
  const turnId = `${sessionId}-${user.id}-${userTurnCount}`;
  updateContext({ turnId, sessionId, userId: user.id });

  // Get partner name for context
  const partnerId = await getPartnerUserId(sessionId, user.id);
  let partnerName: string | undefined;
  if (partnerId) {
    const partner = await prisma.user.findUnique({
      where: { id: partnerId },
      select: { name: true },
    });
    partnerName = partner?.name || undefined;
  } else if (session.status === 'CREATED' || session.status === 'INVITED') {
    // Partner hasn't joined yet - get name from invitation
    const invitation = await prisma.invitation.findFirst({
      where: { sessionId, invitedById: user.id },
      select: { name: true },
    });
    partnerName = invitation?.name || undefined;
  }

  // Build stage prompt with full context assembly (includes notable facts)
  const userName = user.name || 'there';
  const isInvitationPhase = session.status === 'CREATED';

  // Create intent for context assembly - use 'light' depth to load notable facts
  const streamingIntent: MemoryIntentResult = {
    intent: 'stage_enforcement',
    depth: 'light', // Changed from 'minimal' to ensure notable facts are included
    reason: 'Streaming response',
    threshold: 0.60,
    maxCrossSession: 0,
    allowCrossSession: false,
    surfaceStyle: 'silent',
  };

  // Assemble full context including notable facts from UserVessel
  // Also fetch latest emotional reading for intensity-dependent prompt behavior
  const [contextBundle, sharedContentHistory, milestoneContext, emotionalIntensity, capturedNeeds] = await Promise.all([
    assembleContextBundle(
      sessionId,
      user.id,
      currentStage,
      streamingIntent
    ),
    // Stage gate: no shared content should exist for Stages 0-1 (witnessing).
    // Defense-in-depth: even if the query has user isolation, skip entirely for early stages.
    currentStage >= 2
      ? getSharedContentContext(sessionId, user.id).catch((err: Error) => {
          logger.warn(`[sendMessageStream:${requestId}] Shared content context fetch failed:`, err);
          return null;
        })
      : Promise.resolve(null),
    getMilestoneContext(sessionId, user.id).catch((err: Error) => {
      logger.warn(`[sendMessageStream:${requestId}] Milestone context fetch failed:`, err);
      return null;
    }),
    (async () => {
      const vessel = await prisma.userVessel.findUnique({
        where: { userId_sessionId: { userId: user.id, sessionId } },
        select: { id: true },
      });
      if (vessel) {
        const latestReading = await prisma.emotionalReading.findFirst({
          where: { vesselId: vessel.id },
          orderBy: { timestamp: 'desc' },
          select: { intensity: true },
        });
        if (latestReading) return latestReading.intensity;
      }
      return 5; // Default if no reading
    })(),
    // Stage 3: fetch already-captured needs so the AI avoids duplicates
    currentStage === 3
      ? (async () => {
          const vessel = await prisma.userVessel.findUnique({
            where: { userId_sessionId: { userId: user.id, sessionId } },
            select: { id: true },
          });
          if (!vessel) return null;
          const needs = await prisma.identifiedNeed.findMany({
            where: { vesselId: vessel.id },
            orderBy: { createdAt: 'asc' },
            select: { id: true, need: true, confirmed: true },
          });
          return needs.length > 0 ? needs : null;
        })()
      : Promise.resolve(null),
  ]);

  logger.info(`[sendMessageStream:${requestId}] Context assembled: notableFacts=${contextBundle.notableFacts?.length ?? 0}, emotionalIntensity=${emotionalIntensity}`);

  // ===========================================================================
  // Stage 2B routing: Check if user is in REFINING empathy status
  // If so, route to Stage 21 (Informed Empathy) prompt instead of Stage 2
  // ===========================================================================
  let effectiveStage = currentStage;
  let reconcilerGapContext: {
    areaHint: string | null;
    guidanceType: string | null;
    promptSeed: string | null;
    iteration: number;
  } | undefined;
  let previousEmpathyContent: string | null = null;
  let stage2BSharedContext: string | null = null;
  let isRefiningEmpathy = false;
  let empathyDraftContent: string | null = null;

  if (currentStage === 2) {
    const refiningAttempt = await prisma.empathyAttempt.findFirst({
      where: {
        sessionId,
        sourceUserId: user.id,
        status: 'REFINING',
      },
      orderBy: { sharedAt: 'desc' },
    });

    if (refiningAttempt) {
      effectiveStage = 21; // Stage 2B: Informed Empathy
      previousEmpathyContent = refiningAttempt.content;
      isRefiningEmpathy = true;
      logger.info(`[sendMessageStream:${requestId}] Stage 2B routing: user has REFINING empathy, using stage 21`);

      // Fetch current empathy draft (may have been saved from a previous turn in this conversation)
      const currentEmpathyDraft = await prisma.empathyDraft.findUnique({
        where: { sessionId_userId: { sessionId, userId: user.id } },
        select: { content: true },
      });
      if (currentEmpathyDraft) {
        empathyDraftContent = currentEmpathyDraft.content;
        logger.info(`[sendMessageStream:${requestId}] Stage 2B: found existing empathy draft (${empathyDraftContent.length} chars)`);
      } else {
        // Use the previous empathy attempt content as starting draft
        empathyDraftContent = refiningAttempt.content;
        logger.info(`[sendMessageStream:${requestId}] Stage 2B: using previous empathy attempt as draft`);
      }

      // Fetch reconciler result for gap context
      const reconcilerResult = await prisma.reconcilerResult.findFirst({
        where: {
          sessionId,
          guesserId: user.id,
          supersededAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (reconcilerResult) {
        // Use abstract guidance fields only — never inject raw partner content
        // (missedFeelings, gapSummary, mostImportantGap) into the guesser's prompt
        reconcilerGapContext = {
          areaHint: reconcilerResult.areaHint,
          guidanceType: reconcilerResult.guidanceType,
          promptSeed: reconcilerResult.promptSeed,
          iteration: reconcilerResult.iteration,
        };
      }

      // Fetch shared context from partner
      const sharedContextResult = await getSharedContextForGuesser(sessionId, user.id);
      stage2BSharedContext = sharedContextResult.content;
    } else {
      // Regular Stage 2 — load empathy draft so AI can see/edit the current draft
      const currentEmpathyDraft = await prisma.empathyDraft.findUnique({
        where: { sessionId_userId: { sessionId, userId: user.id } },
        select: { content: true },
      });
      if (currentEmpathyDraft) {
        empathyDraftContent = currentEmpathyDraft.content;
        logger.info(`[sendMessageStream:${requestId}] Stage 2: found existing empathy draft (${empathyDraftContent.length} chars)`);
      }
    }
  }
  const stage4InventoryContext = currentStage === 4
    ? await getStage4InventoryPromptContext(sessionId, user.id)
    : null;

  const stage4WalkthroughContext = currentStage === 4
    ? await getStage4WalkthroughPromptContext(sessionId, user.id)
    : null;

  const stage4OpenNeeds = currentStage === 4
    ? await getStage4OpenNeedsForPrompt(sessionId, user.id)
    : null;

  const stage4ListenFirstMode = await isStage4ListenFirstMode(
    sessionId,
    user.id,
    session.status,
    history
  );
  const tendingConversationContext = session.status === 'RESOLVED'
    ? await getTendingConversationContextForPrompt(sessionId, user.id)
    : null;
  const tendingConversationPrompt = tendingConversationContext
    ? buildTendingConversationPrompt('whatHappened', {
        ...tendingConversationContext,
        userName,
        partnerName,
      })
    : null;

  const prompt = buildStagePrompt(effectiveStage, {
    userName,
    currentUserId: user.id,
    partnerUserId: partnerId,
    partnerName,
    turnCount: stageTurnCount,
    emotionalIntensity,
    contextBundle,
    sharedContentHistory,
    milestoneContext,
    reconcilerGapContext,
    previousEmpathyContent,
    sharedContextFromPartner: stage2BSharedContext || undefined,
    empathyDraft: empathyDraftContent || undefined,
    isRefiningEmpathy: isRefiningEmpathy || undefined,
    refiningNeed: refiningNeedContext,
    capturedNeeds,
    stage4InventoryContext,
    stage4WalkthroughContext,
    stage4OpenNeeds,
    stage4ListenFirstMode,
    tendingConversationContext,
    tendingConversationPrompt,
    topicFrame: session.topicFrameConfirmedAt ? session.topicFrame : undefined,
  }, { isInvitationPhase });

  // Format context bundle and inject into last user message (includes notable facts)
  const formattedContext = formatContextForPrompt(contextBundle, {
    sharedContentHistory,
    milestoneContext,
  });
  logger.info(`[sendMessageStream:${requestId}] Formatted context: ${formattedContext.length} chars`);

  // Filter out empty messages to prevent Bedrock ValidationException
  const validHistory = history.filter((m) => m.content && m.content.trim().length > 0);
  if (validHistory.length !== history.length) {
    logger.warn(`[sendMessageStream:${requestId}] Filtered out ${history.length - validHistory.length} empty message(s) from history`);
  }

  const summaryExists = Boolean(summaryBoundary);
  const { trimmed: trimmedHistory, truncated } = trimConversationHistory(
    validHistory.map((m) => ({
      role: m.role === 'USER' ? 'user' as const : 'assistant' as const,
      content: m.content,
    })),
    summaryExists ? CONTEXT_WINDOW.recentTurnsWithSummary : CONTEXT_WINDOW.recentTurnsWithoutSummary
  );

  if (truncated > 0) {
    logger.info(`[sendMessageStream:${requestId}] Trimmed ${truncated} old messages (summaryExists=${summaryExists})`);
  }

  // Build messages with context injected into the last user message
  const messagesWithContext = trimmedHistory.map((m, i) => {
    const isLastUserMessage = i === trimmedHistory.length - 1 && m.role === 'user';
    const content = isLastUserMessage && formattedContext.trim()
      ? `Context:\n${formattedContext}\n\nUser message: ${m.content}`
      : m.content;
    return {
      role: m.role,
      content,
    };
  });

  recordContextSizes(turnId, estimateContextSizes({
    pinned: `${prompt.staticBlock}\n\n${prompt.dynamicBlock}`,
    summary: formattedContext,
    recentMessages: trimmedHistory,
    rag: '',
  }));

  return {
    history,
    userTurnCount,
    stageTurnCount,
    turnId,
    partnerId,
    partnerName,
    userName,
    isInvitationPhase,
    effectiveStage,
    prompt,
    messagesWithContext,
  };
}
