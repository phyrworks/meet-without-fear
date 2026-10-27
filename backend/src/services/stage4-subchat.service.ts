/**
 * Stage 4 Sub-chat service (Phase 3 — infrastructure).
 *
 * An ephemeral, anchor-scoped chat surface for three Stage 4 moments:
 *   - NEEDS_BRAINSTORM    (anchor = an open shared need, need_share id)
 *   - PROPOSAL_REFINEMENT (anchor = proposal)
 *   - NO_OVERLAP          (no anchor — inventory at large)
 *
 * The AI receives the full main-chat conversation history as part of its
 * system prompt; the user sees only sub-chat-scoped messages.
 *
 * Persona prompts are deliberately minimal placeholders for Phase 3.
 * Phase 6 tunes them to match the gold rubric.
 */

import {
  MessageRole as SharedMessageRole,
  Stage4ProposalDraft,
  Stage4SubChatAnchor,
  Stage4SubChatDTO,
  Stage4SubChatMessageDTO,
  Stage4SubChatStatus,
} from '@meet-without-fear/shared';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getCompletion } from '../lib/bedrock';
import { needsBrainstormPersona, noOverlapPersona, proposalRefinementPersona } from './stage4-prompts';
import { createFacilitatorMessage, createParticipantMessage } from './message-store';
import { resolveParticipant } from './participant-resolver';
import { loadProposals, loadStage4Needs, loadVisibleChoices, resolveNeedLabels, setProposalNeeds } from './stage4-store';

const MAIN_CHAT_HISTORY_LIMIT = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Stage4SubChatRecord {
  id: string;
  sessionId: string;
  userId: string;
  anchorKind: Stage4SubChatAnchor;
  anchorId: string | null;
  status: Stage4SubChatStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  messages: Array<{
    id: string;
    role: SharedMessageRole;
    content: string;
    createdAt: Date;
  }>;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toSubChatDTO(record: Stage4SubChatRecord): Stage4SubChatDTO {
  const refinementAnchorId =
    record.anchorKind === Stage4SubChatAnchor.PROPOSAL_REFINEMENT
      ? record.anchorId
      : null;
  return {
    id: record.id,
    sessionId: record.sessionId,
    userId: record.userId,
    anchorKind: record.anchorKind,
    anchorId: record.anchorId,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    resolvedAt: record.resolvedAt ? record.resolvedAt.toISOString() : null,
    messages: record.messages.map((m) => toMessageDTO(m, refinementAnchorId)),
  };
}

/**
 * AI messages may end with a structured proposal block:
 *   <<<PROPOSAL>>>{"description":"..."}<<<END>>>
 * We strip that block from the user-facing text and expose it as a structured
 * candidate so the UI can render a single "Use this version" affordance.
 * The block is the only sanctioned way for the AI to commit a proposal — see
 * the persona prompts in stage4-prompts.ts.
 */
const PROPOSAL_BLOCK_RE = /<<<PROPOSAL>>>([\s\S]*?)<<<END>>>\s*$/;

function extractCandidate(content: string): {
  content: string;
  candidate: Stage4ProposalDraft | null;
} {
  const match = content.match(PROPOSAL_BLOCK_RE);
  if (!match) return { content, candidate: null };
  const stripped = content.slice(0, match.index).trimEnd();
  try {
    const parsed = JSON.parse(match[1].trim()) as Partial<Stage4ProposalDraft>;
    const description =
      typeof parsed.description === 'string' ? parsed.description.trim() : '';
    if (!description) return { content: stripped, candidate: null };
    return {
      content: stripped,
      candidate: {
        description,
        duration: parsed.duration ?? null,
        measureOfSuccess: parsed.measureOfSuccess ?? null,
      },
    };
  } catch {
    return { content: stripped, candidate: null };
  }
}

function toMessageDTO(
  m: {
    id: string;
    role: SharedMessageRole;
    content: string;
    createdAt: Date;
  },
  refinementProposalId: string | null,
): Stage4SubChatMessageDTO {
  if (m.role !== SharedMessageRole.AI) {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      candidate: null,
    };
  }
  const { content, candidate } = extractCandidate(m.content);
  return {
    id: m.id,
    role: m.role,
    content,
    createdAt: m.createdAt.toISOString(),
    candidate: candidate
      ? { ...candidate, ...(refinementProposalId ? { proposalId: refinementProposalId } : {}) }
      : null,
  };
}
// ---------------------------------------------------------------------------
// Storage (TS-11): a sub-chat is a SUBCHAT `conversation` of the participant
// (anchor_kind; anchor_proposal_id for PROPOSAL_REFINEMENT), its messages are
// `message` rows — the user's turn on the app connection, the AI's on the job
// connection. A NEEDS_BRAINSTORM anchor (a shared need's id) has no column on
// `conversation`: it rides on the user's messages as `refining_need_id`
// (FK need; a need_share id is its need's id), so an anchored sub-chat with
// no message yet reports `anchorId: null` until its first message.
// ---------------------------------------------------------------------------

type SubchatConversation = {
  id: string;
  participantId: string;
  anchorKind: Stage4SubChatAnchor | null;
  anchorProposalId: string | null;
  status: 'ACTIVE' | 'RESOLVED';
  resolvedAt: Date | null;
  createdAt: Date;
  participant: { sessionId: string; userId: string | null };
  messages: Array<{ id: string; role: string; content: string; createdAt: Date; refiningNeedId: string | null }>;
};

const SUBCHAT_SELECT = {
  id: true,
  participantId: true,
  anchorKind: true,
  anchorProposalId: true,
  status: true,
  resolvedAt: true,
  createdAt: true,
  participant: { select: { sessionId: true, userId: true } },
  messages: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, role: true, content: true, createdAt: true, refiningNeedId: true },
  },
} satisfies Prisma.ConversationSelect;

function toRecord(c: SubchatConversation): Stage4SubChatRecord {
  const anchorKind = (c.anchorKind ?? Stage4SubChatAnchor.NO_OVERLAP) as Stage4SubChatAnchor;
  const anchorId =
    anchorKind === Stage4SubChatAnchor.PROPOSAL_REFINEMENT
      ? c.anchorProposalId
      : anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM
        ? (c.messages.find((m) => m.refiningNeedId)?.refiningNeedId ?? null)
        : null;
  return {
    id: c.id,
    sessionId: c.participant.sessionId,
    userId: c.participant.userId ?? '',
    anchorKind,
    anchorId,
    status: c.status as Stage4SubChatStatus,
    createdAt: c.createdAt,
    resolvedAt: c.resolvedAt,
    messages: c.messages.map((m) => ({
      id: m.id,
      role: (m.role === 'AI' ? SharedMessageRole.AI : SharedMessageRole.USER) as SharedMessageRole,
      content: m.content,
      createdAt: m.createdAt,
    })),
  };
}

export interface OpenSubChatInput {
  sessionId: string;
  userId: string;
  anchorKind: Stage4SubChatAnchor;
  anchorId?: string | null;
}

/**
 * Returns the existing ACTIVE sub-chat for (participant, anchorKind, anchor)
 * if one exists; otherwise creates a new one.
 */
export async function openOrGetActiveSubChat(input: OpenSubChatInput): Promise<Stage4SubChatRecord> {
  const participant = await resolveParticipant(input.sessionId, input.userId);
  if (!participant) throw new SubChatNotFoundError();
  const anchorId = input.anchorId ?? null;
  const active = (await prisma.conversation.findMany({
    where: { participantId: participant.id, kind: 'SUBCHAT', status: 'ACTIVE', anchorKind: input.anchorKind },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: SUBCHAT_SELECT,
  })) as unknown as SubchatConversation[];
  const match = active.find((c) => {
    if (input.anchorKind === Stage4SubChatAnchor.PROPOSAL_REFINEMENT) return c.anchorProposalId === anchorId;
    if (input.anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM) {
      const anchored = c.messages.find((m) => m.refiningNeedId)?.refiningNeedId ?? null;
      return anchored === anchorId || (anchored === null && c.messages.length === 0);
    }
    return true;
  });
  if (match) return toRecord(match);

  // The anchor must be something this participant may see: a shared need of
  // the session (NEEDS_BRAINSTORM) or a visible proposal (PROPOSAL_REFINEMENT).
  const anchorNeed =
    input.anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM && anchorId
      ? (await loadStage4Needs(input.sessionId, participant.id)).find((n) => n.id === anchorId)
      : undefined;
  if (input.anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM && anchorId && !anchorNeed) throw new SubChatNotFoundError();
  if (input.anchorKind === Stage4SubChatAnchor.PROPOSAL_REFINEMENT && anchorId) {
    const visible = (await loadProposals(input.sessionId, participant.id)).some((p) => p.id === anchorId);
    if (!visible) throw new SubChatNotFoundError();
  }

  const created = (await prisma.conversation.create({
    data: {
      participantId: participant.id,
      kind: 'SUBCHAT',
      anchorKind: input.anchorKind,
      anchorProposalId: input.anchorKind === Stage4SubChatAnchor.PROPOSAL_REFINEMENT ? anchorId : null,
      status: 'ACTIVE',
    },
    select: SUBCHAT_SELECT,
  })) as unknown as SubchatConversation;
  // Fix round 1 (Important 4): `conversation` has no column for a need anchor,
  // so the NEEDS_BRAINSTORM anchor is persisted AT OPEN as the sub-chat's
  // opening facilitator line, whose `refining_need_id` is the shared need (a
  // need_share id is its need's id). The need is named as this participant
  // names it (their own label, or the partner's shared text).
  if (anchorNeed) {
    await createFacilitatorMessage({
      conversationId: created.id,
      content: `Let's look for small, concrete ways to honor this need: ${anchorNeed.label}. What comes to mind?`,
      refiningNeedId: anchorNeed.id,
    });
    const reread = await loadSubChat(created.id);
    if (reread) return toRecord(reread);
  }
  return toRecord(created);
}

async function loadSubChat(subChatId: string): Promise<SubchatConversation | null> {
  return (await prisma.conversation.findFirst({
    where: { id: subChatId, kind: 'SUBCHAT' },
    select: SUBCHAT_SELECT,
  })) as unknown as SubchatConversation | null;
}

export async function getSubChatById(subChatId: string): Promise<Stage4SubChatRecord | null> {
  const c = await loadSubChat(subChatId);
  return c ? toRecord(c) : null;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function personaFor(anchor: AnchorContext): string {
  switch (anchor.anchorKind) {
    case Stage4SubChatAnchor.NEEDS_BRAINSTORM:
      return needsBrainstormPersona(anchor.needLabel);
    case Stage4SubChatAnchor.PROPOSAL_REFINEMENT:
      return proposalRefinementPersona(anchor.proposalDescription);
    case Stage4SubChatAnchor.NO_OVERLAP:
      return noOverlapPersona();
  }
}

export interface AnchorContext {
  anchorKind: Stage4SubChatAnchor;
  needLabel?: string | null;
  proposalDescription?: string | null;
}

/**
 * The anchor as the participant may name it: a shared need by their own
 * label (their need) or its shared text (the partner's) — never the
 * partner's private label; a proposal by its description.
 */
export async function loadAnchorContext(
  sessionId: string,
  anchorKind: Stage4SubChatAnchor,
  anchorId: string | null,
  viewerParticipantId?: string,
): Promise<AnchorContext> {
  if (anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM && anchorId) {
    const needs = viewerParticipantId ? await loadStage4Needs(sessionId, viewerParticipantId) : [];
    return { anchorKind, needLabel: needs.find((n) => n.id === anchorId)?.label ?? null };
  }
  if (anchorKind === Stage4SubChatAnchor.PROPOSAL_REFINEMENT && anchorId) {
    // Only a proposal the participant may see (spec §1.4 proposal RLS arm).
    const proposal = viewerParticipantId
      ? (await loadProposals(sessionId, viewerParticipantId)).find((p) => p.id === anchorId)
      : undefined;
    return { anchorKind, proposalDescription: proposal?.description ?? null };
  }
  return { anchorKind };
}

interface PromptBuildInput {
  sessionId: string;
  userId: string;
  anchor: AnchorContext;
  anchorId: string | null;
}

interface BuiltPrompt {
  systemPrompt: string;
  mainChatTranscript: string;
}

/**
 * The system prompt: persona, anchor, the participant's own MAIN-chat history
 * and the Stage 4 inventory with the stances the participant may see (their
 * own; the partner's only once the partner has shared — the proposal_choice
 * rule; the old prompt showed the partner's unshared stances).
 */
export async function buildSystemPrompt(input: PromptBuildInput): Promise<BuiltPrompt> {
  const { sessionId, userId, anchor, anchorId } = input;
  const participant = await resolveParticipant(sessionId, userId);
  const persona = personaFor(anchor);

  const anchorBlock =
    anchor.anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM
      ? `Anchor — open need: ${anchor.needLabel ?? '(unknown)'} (id: ${anchorId ?? 'none'})`
      : anchor.anchorKind === Stage4SubChatAnchor.PROPOSAL_REFINEMENT
        ? `Anchor — proposal under refinement: ${anchor.proposalDescription ?? '(unknown)'} (id: ${anchorId ?? 'none'})`
        : `Anchor — no-overlap: the inventory at large.`;

  const [conversationMessages, proposals, choices] = participant
    ? await Promise.all([
        participant.mainConversationId
          ? prisma.message.findMany({
              where: { conversationId: participant.mainConversationId },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: MAIN_CHAT_HISTORY_LIMIT,
              select: { role: true, content: true },
            })
          : Promise.resolve([] as Array<{ role: string; content: string }>),
        loadProposals(sessionId, participant.id),
        loadVisibleChoices(sessionId, participant.id),
      ])
    : [[], [], []];

  const mainChatTranscript = conversationMessages
    .map((m) => `${m.role === 'USER' ? 'USER' : 'AI'}: ${m.content}`)
    .join('\n\n');

  const active = proposals.filter((p) => p.status === 'ACTIVE');
  const inventoryBlock = active.length
    ? active
        .map((p) => {
          const stances = choices
            .filter((s) => s.proposalId === p.id)
            .map((s) => `${s.participantId === participant?.id ? 'self' : 'partner'}=${s.decision}`)
            .join(', ');
          return `- [${p.kind}] ${p.description}${stances ? ` (stances: ${stances})` : ''}`;
        })
        .join('\n')
    : '(empty)';

  const systemPrompt =
    `${persona}\n\n` +
    `${anchorBlock}\n\n` +
    `--- MAIN CHAT HISTORY ---\n${mainChatTranscript || '(no main-chat history yet)'}\n\n` +
    `--- STAGE 4 STATE ---\n${inventoryBlock}\n\n` +
    `--- INSTRUCTIONS ---\n` +
    `Keep replies short, concrete, and scoped to the anchor. The user cannot type proposal text directly — they describe what should change, and you propose a concrete version. When you have a candidate proposal the user can choose to accept, end your message with a single structured block on its own line, exactly:\n` +
    `<<<PROPOSAL>>>{"description":"<full proposal text in one sentence>"}<<<END>>>\n` +
    `Rules for the block:\n` +
    `- Emit it only when you are offering a concrete candidate (one per turn, never multiple).\n` +
    `- Do not emit it when you're still asking what to change, or when the user has already agreed and there's nothing new to propose.\n` +
    `- The description is the full proposal text; everything before the block is conversational. Do not refer to the block in the conversational text — the UI renders the candidate as a separate card with a "Use this version" action.\n` +
    `- Use plain JSON, no markdown fences, no trailing commentary after <<<END>>>.\n` +
    `Do not invent stances on the user's behalf.`;

  return { systemPrompt, mainChatTranscript };
}

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------

export interface SendMessageInput {
  subChatId: string;
  userId: string;
  content: string;
  /** The NEEDS_BRAINSTORM anchor, when the client opened the sub-chat with one (first message remembers it). */
  anchorId?: string | null;
}

export async function appendUserMessageAndRespond(input: SendMessageInput): Promise<Stage4SubChatRecord> {
  const subChat = await loadSubChat(input.subChatId);
  if (!subChat) throw new SubChatNotFoundError();
  if (subChat.participant.userId !== input.userId) throw new SubChatForbiddenError();
  if (subChat.status !== 'ACTIVE') throw new SubChatResolvedError();
  const record = toRecord(subChat);
  const anchorId = record.anchorId ?? input.anchorId ?? null;

  await createParticipantMessage({
    conversationId: subChat.id,
    participantId: subChat.participantId,
    userId: input.userId,
    content: input.content,
    refiningNeedId: record.anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM ? anchorId : null,
  });

  const anchor = await loadAnchorContext(record.sessionId, record.anchorKind, anchorId, subChat.participantId);
  const { systemPrompt } = await buildSystemPrompt({
    sessionId: record.sessionId,
    userId: input.userId,
    anchor,
    anchorId,
  });

  const llmMessages = [
    ...record.messages.map((m) => ({
      role: (m.role === SharedMessageRole.AI ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: input.content },
  ];

  let aiText: string | null = null;
  try {
    aiText = await getCompletion({
      systemPrompt,
      messages: llmMessages,
      maxTokens: 768,
      operation: `stage4-subchat-${record.anchorKind}`,
      sessionId: record.sessionId,
      turnId: `stage4-subchat-${subChat.id}-${Date.now()}`,
    });
  } catch (err) {
    logger.error('[stage4-subchat] LLM error', err);
  }

  const fallback = 'I had trouble responding just now. Could you try saying that again?';
  await createFacilitatorMessage({
    conversationId: subChat.id,
    content: aiText && aiText.trim().length ? aiText : fallback,
  });

  const refreshed = await getSubChatById(subChat.id);
  if (!refreshed) throw new SubChatNotFoundError();
  return refreshed;
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export interface ResolveInput {
  subChatId: string;
  userId: string;
  acceptedProposals?: Stage4ProposalDraft[];
  updatedProposals?: Stage4ProposalDraft[];
}

export interface ResolveResult {
  subChat: Stage4SubChatRecord;
  createdProposalIds: string[];
  updatedProposalIds: string[];
}

export async function resolveSubChat(input: ResolveInput): Promise<ResolveResult> {
  const subChat = await loadSubChat(input.subChatId);
  if (!subChat) throw new SubChatNotFoundError();
  if (subChat.participant.userId !== input.userId) throw new SubChatForbiddenError();
  const record = toRecord(subChat);
  if (subChat.status !== 'ACTIVE') {
    // Idempotent: already resolved — return current state.
    return { subChat: record, createdProposalIds: [], updatedProposalIds: [] };
  }

  const accepted = input.acceptedProposals ?? [];
  const updated = input.updatedProposals ?? [];
  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const sessionId = record.sessionId;
  const me = subChat.participantId;
  // NEEDS_BRAINSTORM: the anchored shared need is linked to every accepted proposal.
  const anchorNeedId = record.anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM ? record.anchorId : null;

  const links: Array<{ proposalId: string; labels: string[] | undefined; extraNeedIds: string[] }> = [];
  const editable = new Set((await loadProposals(sessionId, me)).map((p) => p.id));
  await prisma.$transaction(async (tx) => {
    for (const draft of accepted) {
      const created = await tx.proposal.create({
        data: {
          sessionId,
          createdByParticipantId: me,
          description: draft.description,
          duration: draft.duration ?? null,
          measureOfSuccess: draft.measureOfSuccess ?? null,
          kind: 'SHARED_PROPOSAL',
          status: 'ACTIVE',
          source: 'AI_SUGGESTED',
        },
        select: { id: true },
      });
      createdIds.push(created.id);
      links.push({ proposalId: created.id, labels: draft.needsAddressed, extraNeedIds: anchorNeedId ? [anchorNeedId] : [] });
    }

    for (const draft of updated) {
      if (!draft.proposalId) continue;
      // Only a proposal of this session the participant may see.
      if (!editable.has(draft.proposalId)) continue;
      const row = await tx.proposal.update({
        where: { id: draft.proposalId },
        data: {
          description: draft.description,
          duration: draft.duration ?? undefined,
          measureOfSuccess: draft.measureOfSuccess ?? undefined,
        },
        select: { id: true },
      });
      updatedIds.push(row.id);
      if (draft.needsAddressed) links.push({ proposalId: row.id, labels: draft.needsAddressed, extraNeedIds: [] });
      await tx.proposalRevision.create({
        data: {
          proposalId: row.id,
          actorParticipantId: me,
          action: 'SUBCHAT_REFINED',
          after: {
            description: draft.description,
            duration: draft.duration ?? null,
            measureOfSuccess: draft.measureOfSuccess ?? null,
          },
        },
      });
    }

    await tx.conversation.update({ where: { id: subChat.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
  });

  for (const link of links) {
    const { needIds, unresolved } = await resolveNeedLabels(sessionId, me, link.labels);
    await setProposalNeeds(prisma, link.proposalId, [...needIds, ...link.extraNeedIds], unresolved);
  }

  const refreshed = await getSubChatById(subChat.id);
  if (!refreshed) throw new SubChatNotFoundError();
  return { subChat: refreshed, createdProposalIds: createdIds, updatedProposalIds: updatedIds };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SubChatNotFoundError extends Error {
  constructor() {
    super('Sub-chat not found');
    this.name = 'SubChatNotFoundError';
  }
}
export class SubChatForbiddenError extends Error {
  constructor() {
    super('Sub-chat belongs to a different user');
    this.name = 'SubChatForbiddenError';
  }
}
export class SubChatResolvedError extends Error {
  constructor() {
    super('Sub-chat is already resolved');
    this.name = 'SubChatResolvedError';
  }
}
