/**
 * Stream Turn Context
 *
 * Context assembly for a streaming chat turn, extracted (behavior-preserving)
 * from `sendMessageStream`: summary-aware history load, turn counting,
 * partner resolution, context-bundle assembly, Stage 2B (Informed Empathy)
 * routing, Stage 4 prompt contexts, Tending context, stage prompt build, and
 * the final model message array with injected context.
 *
 * Target shape (TS-9): history is the participant's MAIN conversation; the
 * context — including everything shared by the partner — comes from the
 * single entry point `buildContextForParticipant`. The Stage 4 / Tending
 * helpers above the assembly are the repair cluster's (TS-11) and unchanged.
 */

import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getSessionSummary } from './conversation-summarizer';
import { buildContextForParticipant, formatContextForPrompt } from './context-assembler';
import type { MemoryIntentResult } from './memory-intent';
import { getPartnerParticipant, type ResolvedParticipant } from './participant-resolver';
import { countOwnTurns, legacyRole, listConversationMessages } from './message-store';
import { loadStageStates } from './stage-shim';
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
  /** The caller's participant (requireSessionAccess → req.participant). */
  participant: ResolvedParticipant;
  session: { status: string; topicFrame: string | null; topicFrameConfirmedAt: Date | null };
  currentStage: number;
  refiningNeedContext: RefiningNeedContext | null;
}

/** One history row as the prompt layer reads it: the DTO's single role. */
export interface TurnHistoryMessage {
  id: string;
  role: string;
  content: string;
  timestamp: Date;
}

export interface StreamTurnContext {
  /** Chronological (oldest-first) recent history of the participant's conversation. */
  history: TurnHistoryMessage[];
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
  const { requestId, sessionId, user, participant, session, currentStage, refiningNeedContext } = params;
  const conversationId = participant.mainConversationId;
  if (!conversationId) throw new Error(`Participant ${participant.id} has no MAIN conversation`);

  // ===========================================================================
  // Conversation history (summary-aware): the participant's own conversation
  // ===========================================================================
  const existingSummary = await getSessionSummary(sessionId, user.id);
  const summaryBoundary = existingSummary?.summary.newestMessageAt;
  const historyLimit = summaryBoundary ? 30 : 20;

  const historyDesc = await listConversationMessages({
    conversationId,
    limit: historyLimit - 1, // the store reads limit + 1
    order: 'desc',
    newerThan: summaryBoundary,
  });
  const history: TurnHistoryMessage[] = historyDesc
    .slice()
    .reverse()
    .map(m => ({ id: m.id, role: legacyRole(m.role, m.kind), content: m.content, timestamp: m.createdAt }));

  // Count ALL own turns (not just the window), and the turns in the CURRENT
  // stage — stage-specific guards (feel-heard check, early-stage guidance)
  // need stage-scoped counts. The stage's start is the stage shim's.
  const stageStates = await loadStageStates([{ id: participant.id, joinedAt: participant.joinedAt }]);
  const stageStart = stageStates.get(participant.id)?.rows.find(r => r.stage === currentStage)?.startedAt ?? undefined;
  const [userTurnCount, stageTurnCount] = await Promise.all([
    countOwnTurns(conversationId, participant.id),
    countOwnTurns(conversationId, participant.id, stageStart),
  ]);
  const turnId = `${sessionId}-${user.id}-${userTurnCount}`;
  updateContext({ turnId, sessionId, userId: user.id, participantId: participant.id });

  // Partner (v_co_participant), or the invitee's name before they joined.
  const partner = await getPartnerParticipant(participant.id);
  const partnerId = partner?.userId ?? null;
  let partnerName: string | undefined;
  if (partner) {
    partnerName = partner.displayName || undefined;
  } else if (session.status === 'CREATED' || session.status === 'INVITED') {
    const invitation = await prisma.invitation.findFirst({
      where: { sessionId, invitedByParticipantId: participant.id },
      select: { name: true },
    });
    partnerName = invitation?.name || undefined;
  }

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

  // The single entry point: everything the prompt may know beyond this
  // participant's own rows comes from its shared vessel (TS-9).
  const [contextBundle, emotionalIntensity, capturedNeeds] = await Promise.all([
    buildContextForParticipant(participant.id, { intent: streamingIntent, stage: currentStage }),
    (async () => {
      const latest = await prisma.moodReading.findFirst({
        where: { participantId: participant.id },
        orderBy: { recordedAt: 'desc' },
        select: { intensity: true },
      });
      return latest?.intensity ?? 5; // Default if no reading
    })(),
    // Stage 3: the participant's own captured needs, so the AI avoids duplicates
    currentStage === 3
      ? (async () => {
          const needs = await prisma.need.findMany({
            where: { participantId: participant.id, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true, label: true, confirmedAt: true },
          });
          return needs.length > 0
            ? needs.map(n => ({ id: n.id, need: n.label, confirmed: n.confirmedAt !== null }))
            : null;
        })()
      : Promise.resolve(null),
  ]);

  // Stage gate: no shared content for Stages 0-1 (witnessing).
  const sharedContentHistory = currentStage >= 2 ? contextBundle.sharedContentHistory : null;
  const milestoneContext = contextBundle.milestoneContext;

  logger.info(`[sendMessageStream:${requestId}] Context assembled: notableFacts=${contextBundle.notableFacts?.length ?? 0}, emotionalIntensity=${emotionalIntensity}`);

  // ===========================================================================
  // Stage 2B routing: the participant's own attempt in REFINING → Stage 21
  // (Informed Empathy). Gap context is the reconciler GUIDANCE about their own
  // attempt (abstract hints only; never the subject's raw content), and the
  // context the subject shared comes from the shared vessel — both through
  // buildContextForParticipant. The old direct reads of the reconciler result
  // and of the guesser's shared context are gone (plan §5; P3 §7).
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
      where: { authorParticipantId: participant.id, status: 'REFINING' },
      orderBy: { submittedAt: 'desc' },
      select: { content: true },
    });
    const ownDraft = await prisma.draft.findFirst({
      where: { participantId: participant.id, kind: 'EMPATHY' },
      orderBy: { updatedAt: 'desc' },
      select: { content: true },
    });

    if (refiningAttempt) {
      effectiveStage = 21; // Stage 2B: Informed Empathy
      previousEmpathyContent = refiningAttempt.content;
      isRefiningEmpathy = true;
      logger.info(`[sendMessageStream:${requestId}] Stage 2B routing: user has REFINING empathy, using stage 21`);

      // The current draft, else the previous attempt as the starting draft.
      empathyDraftContent = ownDraft?.content ?? refiningAttempt.content;

      const guidance = contextBundle.sharedVessel.guidance;
      reconcilerGapContext = guidance.length ? guidance[guidance.length - 1] : undefined;

      const delivered = contextBundle.sharedVessel.sharedContexts.filter(
        c => c.direction === 'partner_to_user' && c.content,
      );
      stage2BSharedContext = delivered.length ? delivered[delivered.length - 1].content ?? null : null;
    } else if (ownDraft) {
      // Regular Stage 2 — the AI can see/edit the current draft
      empathyDraftContent = ownDraft.content;
      logger.info(`[sendMessageStream:${requestId}] Stage 2: found existing empathy draft (${empathyDraftContent.length} chars)`);
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
