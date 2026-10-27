/**
 * Context Assembler Service
 *
 * Builds stage-scoped context bundles for the AI.
 * The AI receives pre-assembled context - it does NOT decide what to retrieve.
 *
 * From architecture docs:
 * "The large model receives a pre-assembled context bundle. It does not decide what to retrieve."
 *
 * Target shape (TS-9): `buildContextForParticipant(participantId)` is the ONE
 * entry point that assembles a prompt context for a participant, and the only
 * code in the backend that reads another participant's rows — the session's
 * shared vessel (S-class) and nothing else (spec §6 "Chat turn pipeline", §7
 * D2; P3 §7). See `buildSharedVessel`.
 */

import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { type MemoryIntentResult, type RetrievalDepth, getTurnBufferSize } from './memory-intent';
import { getSessionSummary } from './conversation-summarizer';
import { getCoParticipants, getParticipant, resolveParticipant } from './participant-resolver';
import { loadStageStates, messageStage, type MilestoneReached, type ShimStageRow } from './stage-shim';
import { legacyRole, type StoredMessage } from './message-store';
import type { CategorizedFact as GlobalFact } from './global-memory';

// ============================================================================
// Types
// ============================================================================

/**
 * A message in the conversation context
 */
export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface StageHistoryMessage {
  role: 'user' | 'assistant' | 'empathy_statement' | 'shared_context' | 'system';
  content: string;
  stage: number;
  timestamp: string;
}

export interface PriorStageSummary {
  stage: number;
  lifecycleStatus?: string;
  completedAt?: string;
  userTurnCount: number;
  assistantTurnCount: number;
  highlights: StageHistoryMessage[];
}

export interface PriorStageSummaries {
  stages: PriorStageSummary[];
}

export interface ConsentedShareStateItem {
  kind: 'empathy_attempt' | 'additional_context';
  direction: 'user_to_partner' | 'partner_to_user';
  lifecycleStatus: string;
  content?: string;
  sharedAt?: string;
  deliveredAt?: string;
  revealedAt?: string;
  validatedAt?: string;
}

export interface ConsentedShareState {
  items: ConsentedShareStateItem[];
}

/**
 * Emotional thread tracking for continuity
 */
export interface EmotionalThread {
  initialIntensity: number | null;
  currentIntensity: number | null;
  trend: 'escalating' | 'stable' | 'de-escalating' | 'unknown';
  notableShifts: Array<{
    turn: number;
    from: number;
    to: number;
    triggerSummary?: string;
  }>;
}

/**
 * Session summary for long sessions (>30 min)
 */
export interface SessionSummary {
  keyThemes: string[];
  emotionalJourney: string;
  currentFocus: string;
  userStatedGoals: string[];
  agreedFacts?: string[];
  userNeeds?: string[];
  partnerNeeds?: string[];
  openQuestions?: string[];
  agreements?: string[];
  /** Cliffhanger for long-idle resumption. Null when the user is at a milestone. */
  lastUnresolvedThread?: string | null;
}

/**
 * Prior themes from previous sessions in this relationship
 */
export interface PriorThemes {
  themes: string[];
  lastSessionDate: string | null;
  sessionCount: number;
}

/**
 * Inner Thoughts context - private reflections linked to this session
 */
export interface InnerThoughtsContext {
  /** Relevant messages from user's Inner Thoughts (with boost for linked sessions) */
  relevantReflections: Array<{
    content: string;
    similarity: number;
    isFromLinkedSession: boolean;
  }>;
  /** Whether a linked Inner Thoughts session exists */
  hasLinkedSession: boolean;
}

/**
 * User memories to honor in responses
 */
export interface UserMemoriesContext {
  global: Array<{ content: string; category: string }>;
  session: Array<{ content: string; category: string }>;
}

/**
 * The assembled context bundle provided to the AI
 */
export interface ContextBundle {
  // Conversation context
  conversationContext: {
    recentTurns: ContextMessage[];
    turnCount: number;
    sessionDurationMinutes: number;
    /**
     * Milliseconds since this user's own last USER message in the session.
     * Null when they haven't spoken yet (first-turn case), undefined when
     * the bundle was built by a caller that doesn't track this (e.g. mock
     * bundles in tests / replay harnesses). `assembleContextBundle` always
     * sets it. Used by the prompt layer to signal long-idle resumption
     * framing; measured on `senderId = userId` only so AI-side interrupts
     * don't age the clock.
     */
    timeSinceLastUserTurnMs?: number | null;
  };

  // Emotional state
  emotionalThread: EmotionalThread;

  // Prior session context (if depth allows)
  priorThemes?: PriorThemes;

  // Global facts consolidated across all sessions for this user
  // Injected at top of context per fact-ledger architecture
  globalFacts?: GlobalFact[];

  // Session summary (for long sessions)
  sessionSummary?: SessionSummary;

  // Inner Thoughts reflections (if depth allows)
  innerThoughtsContext?: InnerThoughtsContext;

  // User memories ("Things to Always Remember")
  userMemories?: UserMemoriesContext;

  // Notable facts extracted from the conversation
  // (emotional context, situational facts, people & relationships)
  // Stored as CategorizedFact[] - array of { category, fact } objects
  notableFacts?: CategorizedFact[];

  // Stage-specific data
  stageContext: {
    stage: number;
    gatesSatisfied: Record<string, unknown>;
  };

  // Confirmed conversation topic. This is orientation context only; the
  // confirmation timestamp on Session remains the source of truth.
  topicFrame?: {
    text: string;
    confirmedAt: string;
  };

  // Condensed prior-stage context from this user's own lane only.
  // StageProgress remains the gate source of truth; these summaries are only
  // continuity context for what has already been said and persisted.
  priorStageSummaries?: PriorStageSummaries;

  // Typed consent/share lifecycle state for orientation only.
  // Content is included only when owned by this user or delivered/revealed to
  // them; StageProgress and lifecycle tables remain the gate source of truth.
  consentedShareState?: ConsentedShareState;

  // Full current-stage history for this user's own lane only.
  // This is prompt orientation context, not a replacement for StageProgress or
  // lifecycle tables when deciding gates.
  currentStageHistory?: {
    stage: number;
    messages: StageHistoryMessage[];
  };

  // User info
  userName: string;
  partnerName?: string;

  // Metadata
  intent: MemoryIntentResult;
  assembledAt: string;
}

// ============================================================================
// The shared vessel (spec §6, D2; P3 §7)
// ============================================================================

/**
 * What one participant may know of the session beyond their own private
 * rows: the S-class material, read here and nowhere else. Every row is
 * either the participant's OWN (an attempt they authored, context they
 * shared, guidance about their own attempt) or something the schema makes
 * visible to them by an explicit act (an attempt about them that was
 * REVEALED, context DELIVERED to them, a need SHARED through `need_share`).
 * A co-participant's P-class rows — their conversation, drafts, unshared
 * needs, mood, AI memory, reflections (R1) — are never read.
 */
export interface SharedVessel {
  empathyAttempts: Array<{
    direction: 'user_to_partner' | 'partner_to_user';
    status: string;
    /** Present for the participant's own attempt, and for one about them once revealed. */
    content?: string;
    submittedAt: Date;
    deliveredAt: Date | null;
    revealedAt: Date | null;
    validatedAt: Date | null;
  }>;
  sharedContexts: Array<{
    direction: 'user_to_partner' | 'partner_to_user';
    status: string;
    deliveryStatus: string;
    content?: string;
    sharedAt: Date | null;
    deliveredAt: Date | null;
  }>;
  /** Live `need_share` rows of the session (`v_need_shared`): shared text only, never the private need. */
  sharedNeeds: Array<{
    direction: 'user_to_partner' | 'partner_to_user';
    category: string;
    sharedText: string;
    sharedAt: Date;
  }>;
  /** Reconciler guidance about attempts this participant AUTHORED — abstract hints only (P3 D8a). */
  guidance: Array<{ areaHint: string | null; guidanceType: string | null; promptSeed: string | null; iteration: number }>;
}

/** The bundle for one participant, plus the shared vessel and its two prompt renderings. */
export interface ParticipantContext extends ContextBundle {
  participantId: string;
  sessionId: string;
  sharedVessel: SharedVessel;
  /** "What has been shared in this conversation" (null when nothing was). */
  sharedContentHistory: string | null;
  /** "Process milestones" (null when none). */
  milestoneContext: string | null;
}

async function buildSharedVessel(me: { id: string; sessionId: string }): Promise<SharedVessel> {
  const [attempts, offers, needs, guidance] = await Promise.all([
    prisma.empathyAttempt.findMany({
      where: {
        OR: [
          { authorParticipantId: me.id },
          { subjectParticipantId: me.id, revealedAt: { not: null } },
        ],
      },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      select: {
        authorParticipantId: true,
        status: true,
        content: true,
        submittedAt: true,
        deliveredAt: true,
        revealedAt: true,
        reviews: { where: { validated: true }, select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 1 },
      },
    }),
    prisma.contextShareOffer.findMany({
      where: {
        sharedContent: { not: null },
        OR: [
          { subjectParticipantId: me.id },
          { attempt: { authorParticipantId: me.id }, deliveryStatus: { in: ['DELIVERED', 'SEEN'] } },
        ],
      },
      orderBy: [{ sharedAt: 'asc' }, { id: 'asc' }],
      select: {
        subjectParticipantId: true,
        status: true,
        deliveryStatus: true,
        sharedContent: true,
        sharedAt: true,
        deliveredAt: true,
      },
    }),
    prisma.$queryRaw<Array<{ participant_id: string; category: string; shared_text: string; shared_at: Date }>>`
      SELECT participant_id, category::text AS category, shared_text, shared_at
      FROM v_need_shared WHERE session_id = ${me.sessionId}::uuid ORDER BY shared_at, need_id`,
    prisma.reconcilerGuidance.findMany({
      where: { authorParticipantId: me.id },
      orderBy: { createdAt: 'asc' },
      select: { areaHint: true, guidanceType: true, promptSeed: true, result: { select: { iteration: true, supersededAt: true } } },
    }),
  ]);

  return {
    empathyAttempts: attempts.map(a => {
      const own = a.authorParticipantId === me.id;
      return {
        direction: own ? ('user_to_partner' as const) : ('partner_to_user' as const),
        status: a.status,
        // The WHERE above admits a partner's attempt only once revealed.
        content: a.content,
        submittedAt: a.submittedAt,
        deliveredAt: a.deliveredAt,
        revealedAt: a.revealedAt,
        validatedAt: a.reviews[0]?.createdAt ?? null,
      };
    }),
    sharedContexts: offers.map(o => ({
      direction: o.subjectParticipantId === me.id ? ('user_to_partner' as const) : ('partner_to_user' as const),
      status: o.status,
      deliveryStatus: o.deliveryStatus,
      content: o.sharedContent ?? undefined,
      sharedAt: o.sharedAt,
      deliveredAt: o.deliveredAt,
    })),
    sharedNeeds: needs.map(n => ({
      direction: n.participant_id === me.id ? ('user_to_partner' as const) : ('partner_to_user' as const),
      category: n.category,
      sharedText: n.shared_text,
      sharedAt: new Date(n.shared_at),
    })),
    guidance: guidance
      .filter(g => g.result.supersededAt === null)
      .map(g => ({ areaHint: g.areaHint, guidanceType: g.guidanceType, promptSeed: g.promptSeed, iteration: g.result.iteration })),
  };
}

/**
 * The shared vessel of one participant, for a non-turn prompt that needs the
 * session's shared items about its owner (TS-12: a linked Inner Thoughts
 * reflection names the partner's REVEALED statement). Kept here so the context
 * builder stays the only code on the app connection that reads another
 * participant's rows (R35); it reads exactly what `buildSharedVessel` reads.
 */
export async function loadSharedVesselFor(participantId: string): Promise<SharedVessel | null> {
  const me = await getParticipant(participantId);
  if (!me) return null;
  return buildSharedVessel({ id: me.id, sessionId: me.sessionId });
}

/** The consented/shared lifecycle items, as the old `consentedShareState` presented them. */
function consentedShareStateFrom(vessel: SharedVessel): ConsentedShareState | undefined {
  const items: ConsentedShareStateItem[] = [];
  for (const a of vessel.empathyAttempts) {
    items.push({
      kind: 'empathy_attempt',
      direction: a.direction,
      lifecycleStatus: a.status,
      ...(a.content !== undefined ? { content: a.content } : {}),
      sharedAt: a.submittedAt.toISOString(),
      ...(a.deliveredAt ? { deliveredAt: a.deliveredAt.toISOString() } : {}),
      ...(a.revealedAt ? { revealedAt: a.revealedAt.toISOString() } : {}),
      ...(a.validatedAt ? { validatedAt: a.validatedAt.toISOString() } : {}),
    });
  }
  for (const o of vessel.sharedContexts) {
    items.push({
      kind: 'additional_context',
      direction: o.direction,
      lifecycleStatus: `${o.status}/${o.deliveryStatus}`,
      ...(o.content !== undefined ? { content: o.content } : {}),
      ...(o.sharedAt ? { sharedAt: o.sharedAt.toISOString() } : {}),
      ...(o.deliveredAt ? { deliveredAt: o.deliveredAt.toISOString() } : {}),
    });
  }
  if (items.length === 0) return undefined;
  items.sort((a, b) => {
    const aTime = a.revealedAt ?? a.deliveredAt ?? a.sharedAt ?? '';
    const bTime = b.revealedAt ?? b.deliveredAt ?? b.sharedAt ?? '';
    return aTime.localeCompare(bTime);
  });
  return { items };
}

/**
 * "What has been shared in this conversation" — the prompt section the old
 * `getSharedContentContext` built, from the shared vessel only: revealed
 * empathy statements, shared context, shared needs.
 */
export function formatSharedContentHistory(vessel: SharedVessel): string | null {
  const items: Array<{ at: Date; who: 'You' | 'Your partner'; line: string }> = [];
  const who = (d: 'user_to_partner' | 'partner_to_user') => (d === 'user_to_partner' ? 'You' : 'Your partner');
  for (const a of vessel.empathyAttempts) {
    if (!a.revealedAt || a.content === undefined) continue;
    items.push({ at: a.revealedAt, who: who(a.direction), line: `shared an empathy statement: "${a.content}"` });
  }
  for (const o of vessel.sharedContexts) {
    if (!o.sharedAt || !o.content) continue;
    if (o.direction === 'partner_to_user' && o.deliveryStatus === 'PENDING') continue;
    items.push({ at: o.sharedAt, who: who(o.direction), line: `shared additional context: "${o.content}"` });
  }
  for (const n of vessel.sharedNeeds) {
    items.push({ at: n.sharedAt, who: who(n.direction), line: `shared their perspective: "${n.sharedText}"` });
  }
  if (items.length === 0) return null;
  items.sort((a, b) => a.at.getTime() - b.at.getTime());
  return ['## What has been shared in this conversation:', ...items.map(i => `- [${i.at.toISOString()}] ${i.who} ${i.line}`)].join('\n');
}

/**
 * "Process milestones" — the lines on the participant's own screen: their
 * invitation, the acceptance, their compact signature, their feel-heard.
 */
export function formatMilestoneContext(input: {
  isInviter: boolean;
  invitationConfirmedAt: Date | null;
  invitationAcceptedAt: Date | null;
  milestones: MilestoneReached[];
}): string | null {
  const lines: Array<{ label: string; at: Date }> = [];
  if (input.isInviter && input.invitationConfirmedAt) lines.push({ label: 'Invitation ready', at: input.invitationConfirmedAt });
  if (input.invitationAcceptedAt) {
    lines.push({
      label: input.isInviter ? 'Partner accepted invitation' : 'You accepted the invitation',
      at: input.invitationAcceptedAt,
    });
  }
  const signed = input.milestones.find(m => m.key === 'compact_signed');
  if (signed) lines.push({ label: 'You signed the curiosity compact', at: signed.reachedAt });
  const heard = input.milestones.find(m => m.key === 'feel_heard');
  if (heard) lines.push({ label: 'You confirmed feeling heard', at: heard.reachedAt });
  if (lines.length === 0) return null;
  lines.sort((a, b) => a.at.getTime() - b.at.getTime());
  return ['## Process milestones:', ...lines.map(l => `- ${l.label}`)].join('\n');
}

// ============================================================================
// Context Assembly — the single entry point
// ============================================================================

/**
 * THE per-participant prompt-assembly entry point (TS-9; spec §6 "Chat turn
 * pipeline", §7 D2): a prompt built for participant X contains only X's
 * private material — X's conversation, X's drafts and AI memory, X's mood,
 * X's own reflections and memories — plus the session's shared vessel
 * (`buildSharedVessel`). This module is the only code that may read another
 * participant's rows, and it reads only the shared vessel.
 *
 * `stage` defaults to the participant's current stage (stage shim).
 */
export async function buildContextForParticipant(
  participantId: string,
  opts: { intent: MemoryIntentResult; stage?: number },
): Promise<ParticipantContext> {
  const now = new Date();
  const { intent } = opts;
  const depth = intent.depth;

  const me = await getParticipant(participantId);
  if (!me || !me.userId) throw new Error(`Participant ${participantId} not found`);
  const userId = me.userId;
  const conversationId = me.mainConversationId;

  const [session, coParticipants, stageStates, invitation] = await Promise.all([
    prisma.session.findUnique({
      where: { id: me.sessionId },
      select: {
        id: true,
        relationshipId: true,
        createdAt: true,
        topicFrame: true,
        topicFrameConfirmedAt: true,
        relationship: { select: { members: { where: { userId }, select: { nickname: true } } } },
      },
    }),
    getCoParticipants(me.id),
    loadStageStates([{ id: me.id, joinedAt: me.joinedAt }]),
    prisma.invitation.findFirst({
      where: { sessionId: me.sessionId },
      orderBy: { createdAt: 'desc' },
      select: { invitedByParticipantId: true, messageConfirmedAt: true, acceptedAt: true, status: true },
    }),
  ]);
  if (!session) throw new Error(`Session ${me.sessionId} not found`);

  const stageState = stageStates.get(me.id);
  const stage = opts.stage ?? stageState?.current.stage ?? 0;
  const milestones = stageState?.milestones ?? [];
  const stageRow = stageState?.rows.find(r => r.stage === stage);

  // Names. The partner MUST be named by the nickname this participant gave
  // them (relationship_member.nickname), then the co-participant's display name.
  const partner = coParticipants.find(c => c.kind === 'human' && !c.leftAt) ?? coParticipants[0];
  const userName = me.displayName || (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name || 'there';
  const partnerName = session.relationship.members[0]?.nickname || partner?.displayName || 'your partner';

  const turnBufferSize = getTurnBufferSize(stage, intent.intent);
  const ownMessages = conversationId ? await loadOwnConversation(conversationId, me.id) : [];

  const [emotionalThread, priorThemes, sessionSummary, userMemories, aiMemory, sharedVessel] = await Promise.all([
    buildEmotionalThread(me.id, depth),
    depth === 'full' || depth === 'light' ? buildPriorThemes(me.sessionId, session.relationshipId) : Promise.resolve(undefined),
    depth !== 'none' ? buildSessionSummary(me.sessionId, userId) : Promise.resolve(undefined),
    buildUserMemoriesContext(userId, me.sessionId),
    loadAiMemory(me.id),
    buildSharedVessel({ id: me.id, sessionId: me.sessionId }),
  ]);

  const conversationContext = buildConversationContext(ownMessages, turnBufferSize, depth);
  const finalInnerThoughts =
    depth === 'full' || depth === 'light' ? await buildInnerThoughtsContext(me.sessionId, userId, conversationContext) : undefined;

  const lastUserTurnAt = [...ownMessages].reverse().find(m => m.senderParticipantId === me.id && m.role === 'USER' && m.kind === 'CHAT')
    ?.createdAt;

  logger.info(
    `[Context Assembler] buildContextForParticipant: participant=${me.id}, notableFacts=${aiMemory.notableFacts ? `${aiMemory.notableFacts.length} facts` : 'undefined'}`,
  );

  return {
    participantId: me.id,
    sessionId: me.sessionId,
    conversationContext: {
      recentTurns: conversationContext,
      turnCount: conversationContext.length,
      sessionDurationMinutes: Math.floor((now.getTime() - session.createdAt.getTime()) / 60000),
      timeSinceLastUserTurnMs: lastUserTurnAt ? now.getTime() - lastUserTurnAt.getTime() : null,
    },
    emotionalThread,
    priorThemes,
    // Global facts disabled until consent UI is implemented (unchanged).
    globalFacts: undefined,
    sessionSummary,
    innerThoughtsContext: finalInnerThoughts,
    userMemories,
    notableFacts: aiMemory.notableFacts,
    stageContext: { stage, gatesSatisfied: stageRow?.gatesSatisfied ?? {} },
    topicFrame:
      session.topicFrame && session.topicFrameConfirmedAt
        ? { text: session.topicFrame, confirmedAt: session.topicFrameConfirmedAt.toISOString() }
        : undefined,
    priorStageSummaries: buildPriorStageSummaries(ownMessages, milestones, stageState?.rows ?? [], stage, depth),
    consentedShareState: depth === 'none' ? undefined : consentedShareStateFrom(sharedVessel),
    currentStageHistory: buildCurrentStageHistory(ownMessages, milestones, stage, depth),
    userName,
    partnerName,
    intent,
    assembledAt: now.toISOString(),
    sharedVessel,
    sharedContentHistory: stage >= 2 ? formatSharedContentHistory(sharedVessel) : null,
    milestoneContext: formatMilestoneContext({
      isInviter: invitation?.invitedByParticipantId === me.id,
      invitationConfirmedAt: invitation?.messageConfirmedAt ?? null,
      invitationAcceptedAt: invitation?.status === 'ACCEPTED' ? (invitation.acceptedAt ?? null) : null,
      milestones,
    }),
  };
}

/**
 * Compatibility wrapper for callers that hold a (session, user) pair: resolves
 * the participant, then the single entry point.
 */
export async function assembleContextBundle(
  sessionId: string,
  userId: string,
  stage: number,
  intent: MemoryIntentResult,
): Promise<ParticipantContext> {
  const participant = await resolveParticipant(sessionId, userId);
  if (!participant) throw new Error(`Session ${sessionId} not found`);
  return buildContextForParticipant(participant.id, { intent, stage });
}

// ============================================================================
// The participant's own rows
// ============================================================================

type OwnMessage = StoredMessage;

/**
 * The participant's whole MAIN conversation, oldest first: their turns, the
 * AI's replies, and items delivered to them. The conversation IS the
 * audience, so no other participant's rows can appear here.
 */
async function loadOwnConversation(conversationId: string, _participantId: string): Promise<OwnMessage[]> {
  return (await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      conversationId: true,
      senderParticipantId: true,
      role: true,
      kind: true,
      content: true,
      refiningNeedId: true,
      sourceAttemptId: true,
      createdAt: true,
      senderParticipant: { select: { userId: true } },
    },
  })) as OwnMessage[];
}

/** The last N turns: the participant's own chat and the AI's (not delivered items). */
function buildConversationContext(messages: OwnMessage[], bufferSize: number, depth: RetrievalDepth): ContextMessage[] {
  if (depth === 'none' || bufferSize === 0) return [];
  const turns = messages.filter(m => m.kind === 'CHAT');
  return turns.slice(-bufferSize * 2).map(m => ({
    role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
    content: m.content,
    timestamp: m.createdAt.toISOString(),
  }));
}

function mapStageHistoryRole(role: string): StageHistoryMessage['role'] {
  switch (role) {
    case 'USER':
      return 'user';
    case 'AI':
      return 'assistant';
    case 'EMPATHY_STATEMENT':
      return 'empathy_statement';
    case 'SHARED_CONTEXT':
      return 'shared_context';
    default:
      return 'system';
  }
}

const HISTORY_KINDS = new Set(['CHAT', 'EMPATHY_STATEMENT', 'SHARED_CONTEXT']);

function toHistory(m: OwnMessage, milestones: MilestoneReached[]): StageHistoryMessage {
  return {
    role: mapStageHistoryRole(legacyRole(m.role, m.kind)),
    content: m.content,
    stage: messageStage(milestones, m.createdAt),
    timestamp: m.createdAt.toISOString(),
  };
}

function buildCurrentStageHistory(
  messages: OwnMessage[],
  milestones: MilestoneReached[],
  stage: number,
  depth: RetrievalDepth,
): ContextBundle['currentStageHistory'] | undefined {
  if (depth === 'none') return undefined;
  const inStage = messages.filter(m => HISTORY_KINDS.has(m.kind) && messageStage(milestones, m.createdAt) === stage);
  if (inStage.length === 0) return undefined;
  return { stage, messages: inStage.map(m => toHistory(m, milestones)) };
}

function buildPriorStageSummaries(
  messages: OwnMessage[],
  milestones: MilestoneReached[],
  rows: ShimStageRow[],
  currentStage: number,
  depth: RetrievalDepth,
): ContextBundle['priorStageSummaries'] | undefined {
  if (depth === 'none' || currentStage <= 0) return undefined;
  const byStage = new Map<number, PriorStageSummary>();
  const ensure = (stage: number): PriorStageSummary => {
    const existing = byStage.get(stage);
    if (existing) return existing;
    const summary: PriorStageSummary = { stage, userTurnCount: 0, assistantTurnCount: 0, highlights: [] };
    byStage.set(stage, summary);
    return summary;
  };
  for (const row of rows) {
    if (row.stage >= currentStage || milestones.length === 0) continue;
    const summary = ensure(row.stage);
    summary.lifecycleStatus = row.status;
    if (row.completedAt) summary.completedAt = row.completedAt.toISOString();
  }
  for (const m of messages) {
    if (!HISTORY_KINDS.has(m.kind)) continue;
    const stage = messageStage(milestones, m.createdAt);
    if (stage >= currentStage) continue;
    const summary = ensure(stage);
    if (m.kind === 'CHAT' && m.role === 'USER') summary.userTurnCount += 1;
    else if (m.kind === 'CHAT' && m.role === 'AI') summary.assistantTurnCount += 1;
    summary.highlights.push(toHistory(m, milestones));
  }
  const stages = [...byStage.values()]
    .sort((a, b) => a.stage - b.stage)
    .map(s => ({ ...s, highlights: s.highlights.slice(-4) }));
  return stages.length > 0 ? { stages } : undefined;
}

/** Emotional thread from the participant's own mood readings. */
async function buildEmotionalThread(participantId: string, depth: RetrievalDepth): Promise<EmotionalThread> {
  const empty: EmotionalThread = { initialIntensity: null, currentIntensity: null, trend: 'unknown', notableShifts: [] };
  if (depth === 'none') return empty;
  const readings = await prisma.moodReading.findMany({
    where: { participantId },
    orderBy: { recordedAt: 'asc' },
    select: { intensity: true },
  });
  if (readings.length === 0) return empty;

  const initialIntensity = readings[0].intensity;
  const currentIntensity = readings[readings.length - 1].intensity;
  let trend: EmotionalThread['trend'] = 'stable';
  if (readings.length >= 2) {
    const recent = readings.slice(-3);
    const avgRecent = recent.reduce((sum, r) => sum + r.intensity, 0) / recent.length;
    const earlier = readings.slice(0, Math.min(3, readings.length));
    const avgEarlier = earlier.reduce((sum, r) => sum + r.intensity, 0) / earlier.length;
    if (avgRecent - avgEarlier >= 2) trend = 'escalating';
    else if (avgEarlier - avgRecent >= 2) trend = 'de-escalating';
  }
  const notableShifts: EmotionalThread['notableShifts'] = [];
  for (let i = 1; i < readings.length && notableShifts.length < 3; i++) {
    if (Math.abs(readings[i].intensity - readings[i - 1].intensity) >= 3) {
      notableShifts.push({ turn: i, from: readings[i - 1].intensity, to: readings[i].intensity });
    }
  }
  return { initialIntensity, currentIntensity, trend, notableShifts };
}

/** Prior resolved sessions in this relationship (session rows only). */
async function buildPriorThemes(sessionId: string, relationshipId: string): Promise<PriorThemes> {
  const previous = await prisma.session.findMany({
    where: { relationshipId, id: { not: sessionId }, status: 'RESOLVED' },
    orderBy: { updatedAt: 'desc' },
    take: 3,
    select: { updatedAt: true },
  });
  return {
    themes: [],
    lastSessionDate: previous[0]?.updatedAt.toISOString() ?? null,
    sessionCount: previous.length,
  };
}

/** The participant's rolling summary (ai_memory SUMMARY, via the summarizer). */
async function buildSessionSummary(sessionId: string, userId: string): Promise<SessionSummary | undefined> {
  const summaryData = await getSessionSummary(sessionId, userId);
  if (!summaryData) return undefined;
  return {
    keyThemes: summaryData.keyThemes ?? [],
    emotionalJourney: summaryData.emotionalJourney ?? '',
    currentFocus: summaryData.summary.text ?? '',
    userStatedGoals: summaryData.unresolvedTopics ?? [],
    agreedFacts: summaryData.agreedFacts ?? [],
    userNeeds: summaryData.userNeeds ?? [],
    partnerNeeds: summaryData.partnerNeeds ?? [],
    openQuestions: summaryData.openQuestions ?? [],
    agreements: summaryData.agreements ?? [],
    lastUnresolvedThread: summaryData.lastUnresolvedThread ?? null,
  };
}

/**
 * The participant's OWN Inner Work reflections (R1: never anyone else's).
 * The semantic search over reflections is the reflection cluster's (TS-12;
 * spec D8 disables or moves it app-side); until then only the linked
 * reflection's presence is reported.
 */
async function buildInnerThoughtsContext(
  sessionId: string,
  userId: string,
  _conversationContext: ContextMessage[],
): Promise<InnerThoughtsContext | undefined> {
  const linked = await prisma.reflection.findFirst({
    where: { userId, linkedSessionId: sessionId, status: 'ACTIVE' },
    select: { id: true },
  });
  return { relevantReflections: [], hasLinkedSession: !!linked };
}

/** Active user memories: global and this session's. */
async function buildUserMemoriesContext(userId: string, sessionId: string): Promise<UserMemoriesContext> {
  const memories = await prisma.userMemory.findMany({
    where: { userId, status: 'ACTIVE', OR: [{ sessionId: null }, { sessionId }] },
    select: { content: true, category: true, sessionId: true },
  });
  return {
    global: memories.filter(m => m.sessionId === null).map(m => ({ content: m.content, category: m.category })),
    session: memories.filter(m => m.sessionId === sessionId).map(m => ({ content: m.content, category: m.category })),
  };
}

/** Categorized fact format */
interface CategorizedFact {
  category: string;
  fact: string;
}

/** The participant's AI memory (ai_memory, kind NOTABLE_FACTS: `{ facts: [...] }`). */
async function loadAiMemory(participantId: string): Promise<{ notableFacts?: CategorizedFact[] }> {
  const row = await prisma.aiMemory.findUnique({
    where: { participantId_kind: { participantId, kind: 'NOTABLE_FACTS' } },
    select: { doc: true },
  });
  const facts = (row?.doc as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(facts)) return {};
  const categorized = facts.filter((f): f is CategorizedFact => {
    if (typeof f !== 'object' || f === null) return false;
    const o = f as Record<string, unknown>;
    return typeof o.category === 'string' && typeof o.fact === 'string';
  });
  return categorized.length ? { notableFacts: categorized } : {};
}

export {
  formatContextForPrompt,
  formatContextForPromptLegacy,
  type ContextFormattingOptions,
} from './context-formatters';
