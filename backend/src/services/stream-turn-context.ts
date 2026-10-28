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
 * helpers above the assembly are the repair cluster's (TS-11): they read the
 * participant's own rows and the session's S-class repair rows only (shared
 * proposals, need_share via v_need_shared, coverage) — never a partner's
 * need label, unshared choice or private individual commitment.
 */

import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getSessionSummary } from './conversation-summarizer';
import { buildContextForParticipant, formatContextForPrompt } from './context-assembler';
import type { MemoryIntentResult } from './memory-intent';
import { getPartnerParticipant, resolveParticipant, type ResolvedParticipant } from './participant-resolver';
import { loadProposals, loadStage4Needs, loadVisibleCoverage } from './stage4-store';
import { loadFollowUpsForParticipant } from './tending.service';
import { followUpCheckinPayloadSchema } from '@meet-without-fear/shared';
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

/**
 * The Stage 4 inventory for the prompt: the proposals THIS participant may
 * see (TS-11: proposal — every shared proposal, their own or shared
 * individual commitments; never the partner's private ones).
 */
async function getStage4InventoryPromptContext(sessionId: string, currentUserId: string): Promise<string | null> {
  const me = await resolveParticipant(sessionId, currentUserId);
  if (!me) return null;
  const proposals = (await loadProposals(sessionId, me.id))
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
    .slice(0, 12)
    .filter(proposal => proposal.status !== 'REMOVED');
  if (proposals.length === 0) return null;

  return proposals
    .map(proposal => {
      const owner =
        proposal.createdByParticipantId === me.id
          ? 'current user'
          : proposal.createdByParticipantId
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

async function getStage4WalkthroughPromptContext(sessionId: string, currentUserId: string): Promise<string | null> {
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

    const formatNeed = (need: (typeof walkthrough.ownNeeds)[number]) =>
      `- id=${need.id} | status=${need.status} | label="${need.label}"`;
    if (walkthrough.ownNeeds.length > 0) {
      lines.push('ownNeeds:', ...walkthrough.ownNeeds.map(formatNeed));
    }
    if (walkthrough.partnerNeeds.length > 0) {
      lines.push('partnerNeeds:', ...walkthrough.partnerNeeds.map(formatNeed));
    }

    const currentProposalLines = walkthrough.proposalGroups.flatMap(group =>
      group.proposals.map(proposal => {
        const details = [
          `- group=${group.key}`,
          `id=${proposal.id}`,
          `kind=${proposal.kind}`,
          `description="${proposal.description}"`,
        ];
        if (proposal.duration) details.push(`duration="${proposal.duration}"`);
        if (proposal.measureOfSuccess) details.push(`success="${proposal.measureOfSuccess}"`);
        return details.join(' | ');
      }),
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
 * Stage 4 Phase 6 — open needs (not declined, not yet covered by a proposal
 * this participant is WILLING on), so the AI can surface one at a time in
 * main chat. TS-11: over the shared needs (v_need_shared / v_need_coverage);
 * the participant's own needs by their own label, the partner's by the
 * shared text — never the partner's private label.
 */
export async function getStage4OpenNeedsForPrompt(
  sessionId: string,
  userId: string,
): Promise<Array<{ needLabel: string }> | null> {
  try {
    const me = await resolveParticipant(sessionId, userId);
    if (!me) return null;
    const [needs, coverage, mine, declined] = await Promise.all([
      loadStage4Needs(sessionId, me.id),
      // Visible coverage only (fix round 2): a partner's unshared WILLING must not drop a need from the prompt.
      loadVisibleCoverage(sessionId, me.id),
      prisma.proposalChoice.findMany({
        where: { participantId: me.id, decision: 'WILLING', proposal: { sessionId } },
        select: { proposalId: true },
      }),
      prisma.needDisposition.findMany({
        where: { participantId: me.id, status: 'DECLINED' },
        select: { needId: true },
      }),
    ]);
    const willing = new Set(mine.map(c => c.proposalId));
    const declinedIds = new Set(declined.map(d => d.needId));
    const byNeed = new Map(coverage.map(c => [c.needId, c]));
    const labels = needs
      .filter(n => {
        const c = byNeed.get(n.id);
        if (c?.status === 'COVERED') return false;
        if (declinedIds.has(n.id)) return false;
        return !(c?.coveringProposalIds ?? []).some(pid => willing.has(pid));
      })
      .map(n => ({ needLabel: n.label }));
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
  history: Array<{ role: string; content: string }>,
): Promise<boolean> {
  if (sessionStatus !== 'RESOLVED') return false;
  const askedForInput = history.some(m => m.role === 'USER' && isExplicitAskForInput(m.content));
  return !askedForInput;
}

async function getTendingConversationContextForPrompt(
  sessionId: string,
  userId: string,
): Promise<TendingConversationPromptContext | null> {
  try {
    const me = await resolveParticipant(sessionId, userId);
    if (!me) return null;
    // TS-11: follow_up (what the participant may see), the participant's OWN
    // shared needs (their labels), their carried-forward notes, and their own
    // latest check-ins' payloads.
    const [entries, needs, selectedNotes, latestCheckins] = await Promise.all([
      loadFollowUpsForParticipant(sessionId, me.id).then(rows => rows.slice(0, 8)),
      loadStage4Needs(sessionId, me.id).then(rows => rows.filter(n => n.ownerParticipantId === me.id).slice(0, 8)),
      prisma.followUpNote.findMany({
        where: { participantId: me.id, carryForward: true },
        orderBy: [{ createdAt: 'asc' }],
        take: 8,
        select: { id: true, content: true, carriedIntoCheckinId: true },
      }),
      prisma.followUpCheckin.findMany({
        where: { participantId: me.id },
        orderBy: [{ submittedAt: 'desc' }],
        take: 3,
        select: { id: true, continueChoice: true, nextAction: true, payload: true },
      }),
    ]);

    if (entries.length === 0 && selectedNotes.length === 0 && latestCheckins.length === 0) {
      return null;
    }
    const agreementIds = entries.map(e => e.agreementId).filter((id): id is string => Boolean(id));
    const agreements = new Map(
      (
        await prisma.agreement.findMany({
          where: { id: { in: agreementIds } },
          select: { id: true, measureOfSuccess: true },
        })
      ).map(a => [a.id, a.measureOfSuccess] as const),
    );

    const latestStructuredOutcomes = latestCheckins
      .flatMap(checkin => {
        const parsed = followUpCheckinPayloadSchema.safeParse(checkin.payload);
        const payload = parsed.success ? parsed.data : null;
        return [
          `Check-in ${checkin.id}: continueChoice=${checkin.continueChoice ?? 'none'} nextAction=${checkin.nextAction ?? 'none'}`,
          ...(payload?.entryOutcomes ?? []).map(
            outcome =>
              `Entry ${outcome.followUpId}: followThrough=${outcome.followThroughStatus}; helpfulness=${outcome.helpfulnessStatus ?? 'none'}; blockers=${outcome.blockerCategories.join(', ') || 'none'}; stillWorthTrying=${outcome.stillWorthTrying ?? 'unknown'}`,
          ),
          ...(payload?.needOutcomes ?? []).map(
            outcome =>
              `Need ${outcome.needLabel}: ${outcome.resolutionStatus}${outcome.nextAction ? `; nextAction=${outcome.nextAction}` : ''}`,
          ),
          ...(payload?.adjustments ?? []).map(
            adjustment =>
              `Adjustment ${adjustment.followUpId}: ${adjustment.revisedCommitmentText ?? 'no text'}${adjustment.revisedCadence ? `; cadence=${adjustment.revisedCadence}` : ''}${adjustment.revisedSuccessCriteria ? `; success=${adjustment.revisedSuccessCriteria}` : ''}`,
          ),
        ];
      })
      .join('\n');

    return {
      entries: entries.map(entry => ({
        id: entry.id,
        summary: entry.summary,
        scope: entry.scope,
        successCriteria: entry.agreementId ? (agreements.get(entry.agreementId) ?? null) : null,
      })),
      needs: needs.map(need => ({ id: need.id, label: need.label })),
      selectedBetweenPeriodNotes: selectedNotes.map(note => ({
        id: note.id,
        content: note.content,
        consentToShareWithPartner: note.carriedIntoCheckinId !== null,
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

export async function assembleStreamTurnContext(params: StreamTurnContextParams): Promise<StreamTurnContext> {
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
    threshold: 0.6,
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

  logger.info(
    `[sendMessageStream:${requestId}] Context assembled: notableFacts=${contextBundle.notableFacts?.length ?? 0}, emotionalIntensity=${emotionalIntensity}`,
  );

  // ===========================================================================
  // Stage 2B routing: the participant's own attempt in REFINING → Stage 21
  // (Informed Empathy). Gap context is the reconciler GUIDANCE about their own
  // attempt (abstract hints only; never the subject's raw content), and the
  // context the subject shared comes from the shared vessel — both through
  // buildContextForParticipant. The old direct reads of the reconciler result
  // and of the guesser's shared context are gone (plan §5; P3 §7).
  // ===========================================================================
  let effectiveStage = currentStage;
  let reconcilerGapContext:
    | {
        areaHint: string | null;
        guidanceType: string | null;
        promptSeed: string | null;
        iteration: number;
      }
    | undefined;
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
      stage2BSharedContext = delivered.length ? (delivered[delivered.length - 1].content ?? null) : null;
    } else if (ownDraft) {
      // Regular Stage 2 — the AI can see/edit the current draft
      empathyDraftContent = ownDraft.content;
      logger.info(
        `[sendMessageStream:${requestId}] Stage 2: found existing empathy draft (${empathyDraftContent.length} chars)`,
      );
    }
  }
  const stage4InventoryContext = currentStage === 4 ? await getStage4InventoryPromptContext(sessionId, user.id) : null;

  const stage4WalkthroughContext =
    currentStage === 4 ? await getStage4WalkthroughPromptContext(sessionId, user.id) : null;

  const stage4OpenNeeds = currentStage === 4 ? await getStage4OpenNeedsForPrompt(sessionId, user.id) : null;

  const stage4ListenFirstMode = await isStage4ListenFirstMode(sessionId, user.id, session.status, history);
  const tendingConversationContext =
    session.status === 'RESOLVED' ? await getTendingConversationContextForPrompt(sessionId, user.id) : null;
  const tendingConversationPrompt = tendingConversationContext
    ? buildTendingConversationPrompt('whatHappened', {
        ...tendingConversationContext,
        userName,
        partnerName,
      })
    : null;

  const prompt = buildStagePrompt(
    effectiveStage,
    {
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
    },
    { isInvitationPhase },
  );

  // Format context bundle and inject into last user message (includes notable facts)
  const formattedContext = formatContextForPrompt(contextBundle, {
    sharedContentHistory,
    milestoneContext,
  });
  logger.info(`[sendMessageStream:${requestId}] Formatted context: ${formattedContext.length} chars`);

  // Filter out empty messages to prevent Bedrock ValidationException
  const validHistory = history.filter(m => m.content && m.content.trim().length > 0);
  if (validHistory.length !== history.length) {
    logger.warn(
      `[sendMessageStream:${requestId}] Filtered out ${history.length - validHistory.length} empty message(s) from history`,
    );
  }

  const summaryExists = Boolean(summaryBoundary);
  const { trimmed: trimmedHistory, truncated } = trimConversationHistory(
    validHistory.map(m => ({
      role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
      content: m.content,
    })),
    summaryExists ? CONTEXT_WINDOW.recentTurnsWithSummary : CONTEXT_WINDOW.recentTurnsWithoutSummary,
  );

  if (truncated > 0) {
    logger.info(`[sendMessageStream:${requestId}] Trimmed ${truncated} old messages (summaryExists=${summaryExists})`);
  }

  // Build messages with context injected into the last user message
  const messagesWithContext = trimmedHistory.map((m, i) => {
    const isLastUserMessage = i === trimmedHistory.length - 1 && m.role === 'user';
    const content =
      isLastUserMessage && formattedContext.trim()
        ? `Context:\n${formattedContext}\n\nUser message: ${m.content}`
        : m.content;
    return {
      role: m.role,
      content,
    };
  });

  recordContextSizes(
    turnId,
    estimateContextSizes({
      pinned: `${prompt.staticBlock}\n\n${prompt.dynamicBlock}`,
      summary: formattedContext,
      recentMessages: trimmedHistory,
      rag: '',
    }),
  );

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
