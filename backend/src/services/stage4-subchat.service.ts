/**
 * Stage 4 Sub-chat service (Phase 3 — infrastructure).
 *
 * An ephemeral, anchor-scoped chat surface for three Stage 4 moments:
 *   - NEEDS_BRAINSTORM    (anchor = open IdentifiedNeed)
 *   - PROPOSAL_REFINEMENT (anchor = StrategyProposal)
 *   - NO_OVERLAP          (no anchor — inventory at large)
 *
 * The AI receives the full main-chat conversation history as part of its
 * system prompt; the user sees only sub-chat-scoped messages.
 *
 * Persona prompts are deliberately minimal placeholders for Phase 3.
 * Phase 6 tunes them to match the gold rubric.
 */

import {
  MessageRole as PrismaMessageRole,
  Prisma,
  Stage4ProposalKind as PrismaStage4ProposalKind,
  Stage4ProposalStatus as PrismaStage4ProposalStatus,
  Stage4SubChatAnchor as PrismaStage4SubChatAnchor,
  Stage4SubChatStatus as PrismaStage4SubChatStatus,
  StrategySource as PrismaStrategySource,
} from '../generated/prisma/client';
import {
  MessageRole as SharedMessageRole,
  Stage4ProposalDraft,
  Stage4SubChatAnchor,
  Stage4SubChatDTO,
  Stage4SubChatMessageDTO,
  Stage4SubChatStatus,
} from '@meet-without-fear/shared';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getCompletion } from '../lib/bedrock';
import {
  needsBrainstormPersona,
  noOverlapPersona,
  proposalRefinementPersona,
} from './stage4-prompts';

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
// Open / get-or-create
// ---------------------------------------------------------------------------

export interface OpenSubChatInput {
  sessionId: string;
  userId: string;
  anchorKind: Stage4SubChatAnchor;
  anchorId?: string | null;
}

/**
 * Returns the existing ACTIVE sub-chat for (sessionId, userId, anchorKind,
 * anchorId) if one exists; otherwise creates a new one.
 */
export async function openOrGetActiveSubChat(
  input: OpenSubChatInput
): Promise<Stage4SubChatRecord> {
  const { sessionId, userId, anchorKind } = input;
  const anchorId = input.anchorId ?? null;

  const existing = await prisma.stage4SubChat.findFirst({
    where: {
      sessionId,
      userId,
      anchorKind: anchorKind as unknown as PrismaStage4SubChatAnchor,
      anchorId,
      status: PrismaStage4SubChatStatus.ACTIVE,
    },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (existing) {
    return existing as unknown as Stage4SubChatRecord;
  }

  const created = await prisma.stage4SubChat.create({
    data: {
      sessionId,
      userId,
      anchorKind: anchorKind as unknown as PrismaStage4SubChatAnchor,
      anchorId,
      status: PrismaStage4SubChatStatus.ACTIVE,
    },
    include: { messages: true },
  });
  return created as unknown as Stage4SubChatRecord;
}

export async function getSubChatById(
  subChatId: string
): Promise<Stage4SubChatRecord | null> {
  const row = await prisma.stage4SubChat.findUnique({
    where: { id: subChatId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  return row as unknown as Stage4SubChatRecord | null;
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

export async function loadAnchorContext(
  _sessionId: string,
  anchorKind: Stage4SubChatAnchor,
  anchorId: string | null
): Promise<AnchorContext> {
  if (anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM && anchorId) {
    const need = await prisma.identifiedNeed.findUnique({
      where: { id: anchorId },
      select: { need: true },
    });
    return { anchorKind, needLabel: need?.need ?? null };
  }
  if (anchorKind === Stage4SubChatAnchor.PROPOSAL_REFINEMENT && anchorId) {
    const proposal = await prisma.strategyProposal.findUnique({
      where: { id: anchorId },
      select: { description: true },
    });
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
 * Construct the LLM system prompt: persona instruction, anchor info, full
 * main-chat history for this user, and current Stage 4 inventory snapshot.
 *
 * Exposed for testing so we can assert main-chat history is included.
 */
export async function buildSystemPrompt(
  input: PromptBuildInput
): Promise<BuiltPrompt> {
  const { sessionId, userId, anchor, anchorId } = input;
  const persona = personaFor(anchor);

  const anchorBlock =
    anchor.anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM
      ? `Anchor — open need: ${anchor.needLabel ?? '(unknown)'} (id: ${anchorId ?? 'none'})`
      : anchor.anchorKind === Stage4SubChatAnchor.PROPOSAL_REFINEMENT
        ? `Anchor — proposal under refinement: ${anchor.proposalDescription ?? '(unknown)'} (id: ${anchorId ?? 'none'})`
        : `Anchor — no-overlap: the inventory at large.`;

  const [conversationMessages, proposals, selections] = await Promise.all([
    prisma.message.findMany({
      where: {
        sessionId,
        OR: [
          { senderId: userId, forUserId: null },
          { forUserId: userId },
        ],
      },
      orderBy: { timestamp: 'asc' },
      take: MAIN_CHAT_HISTORY_LIMIT,
      select: { role: true, content: true },
    }),
    prisma.strategyProposal.findMany({
      where: { sessionId, status: PrismaStage4ProposalStatus.ACTIVE },
      select: {
        id: true,
        description: true,
        needsAddressed: true,
        kind: true,
      },
    }),
    prisma.stage4ProposalSelection.findMany({
      where: { sessionId },
      select: { proposalId: true, userId: true, decision: true },
    }),
  ]);

  const mainChatTranscript = conversationMessages
    .map((m) => `${m.role === 'USER' ? 'USER' : 'AI'}: ${m.content}`)
    .join('\n\n');

  const inventoryBlock = proposals.length
    ? proposals
        .map((p) => {
          const stances = selections
            .filter((s) => s.proposalId === p.id)
            .map((s) => `${s.userId === userId ? 'self' : 'partner'}=${s.decision}`)
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
}

export async function appendUserMessageAndRespond(
  input: SendMessageInput
): Promise<Stage4SubChatRecord> {
  const subChat = await prisma.stage4SubChat.findUnique({
    where: { id: input.subChatId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!subChat) {
    throw new SubChatNotFoundError();
  }
  if (subChat.userId !== input.userId) {
    throw new SubChatForbiddenError();
  }
  if (subChat.status !== PrismaStage4SubChatStatus.ACTIVE) {
    throw new SubChatResolvedError();
  }

  await prisma.stage4SubChatMessage.create({
    data: {
      subChatId: subChat.id,
      role: PrismaMessageRole.USER,
      content: input.content,
    },
  });

  const anchor = await loadAnchorContext(
    subChat.sessionId,
    subChat.anchorKind as Stage4SubChatAnchor,
    subChat.anchorId
  );
  const { systemPrompt } = await buildSystemPrompt({
    sessionId: subChat.sessionId,
    userId: subChat.userId,
    anchor,
    anchorId: subChat.anchorId,
  });

  const llmMessages = [
    ...subChat.messages.map((m) => ({
      role: (m.role === PrismaMessageRole.AI ? 'assistant' : 'user') as 'user' | 'assistant',
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
      operation: `stage4-subchat-${subChat.anchorKind}`,
      sessionId: subChat.sessionId,
      turnId: `stage4-subchat-${subChat.id}-${Date.now()}`,
    });
  } catch (err) {
    logger.error('[stage4-subchat] LLM error', err);
  }

  const fallback =
    'I had trouble responding just now. Could you try saying that again?';
  await prisma.stage4SubChatMessage.create({
    data: {
      subChatId: subChat.id,
      role: PrismaMessageRole.AI,
      content: aiText && aiText.trim().length ? aiText : fallback,
    },
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

export async function resolveSubChat(
  input: ResolveInput
): Promise<ResolveResult> {
  const subChat = await prisma.stage4SubChat.findUnique({
    where: { id: input.subChatId },
  });
  if (!subChat) throw new SubChatNotFoundError();
  if (subChat.userId !== input.userId) throw new SubChatForbiddenError();
  if (subChat.status !== PrismaStage4SubChatStatus.ACTIVE) {
    // Idempotent: already resolved — return current state.
    const current = await getSubChatById(subChat.id);
    if (!current) throw new SubChatNotFoundError();
    return { subChat: current, createdProposalIds: [], updatedProposalIds: [] };
  }

  const anchorKind = subChat.anchorKind as unknown as Stage4SubChatAnchor;
  const accepted = input.acceptedProposals ?? [];
  const updated = input.updatedProposals ?? [];

  const createdIds: string[] = [];
  const updatedIds: string[] = [];

  // For NEEDS_BRAINSTORM, resolve the anchor need's label up front so we can
  // (a) store the human-readable label in proposal.needsAddressed (the column
  // is treated as labels by the Stage 4 state builder) and (b) write the
  // StrategyProposalNeed link row so coverage joins resolve correctly.
  const anchorNeed =
    anchorKind === Stage4SubChatAnchor.NEEDS_BRAINSTORM && subChat.anchorId
      ? await prisma.identifiedNeed.findUnique({
          where: { id: subChat.anchorId },
          select: { id: true, need: true },
        })
      : null;

  await prisma.$transaction(async (tx) => {
    // NEEDS_BRAINSTORM / NO_OVERLAP — create new proposals.
    for (const draft of accepted) {
      const needsAddressed =
        draft.needsAddressed && draft.needsAddressed.length > 0
          ? draft.needsAddressed
          : anchorNeed
            ? [anchorNeed.need]
            : [];

      const created = await tx.strategyProposal.create({
        data: {
          sessionId: subChat.sessionId,
          createdByUserId: subChat.userId,
          description: draft.description,
          needsAddressed,
          duration: draft.duration ?? null,
          measureOfSuccess: draft.measureOfSuccess ?? null,
          kind: PrismaStage4ProposalKind.SHARED_PROPOSAL,
          status: PrismaStage4ProposalStatus.ACTIVE,
          source: PrismaStrategySource.AI_SUGGESTED,
        },
      });
      createdIds.push(created.id);

      if (anchorNeed) {
        await tx.strategyProposalNeed.create({
          data: { proposalId: created.id, needId: anchorNeed.id },
        });
      }
    }

    // PROPOSAL_REFINEMENT / NO_OVERLAP — update existing in place.
    for (const draft of updated) {
      if (!draft.proposalId) continue;
      const updatedRow = await tx.strategyProposal.update({
        where: { id: draft.proposalId },
        data: {
          description: draft.description,
          needsAddressed: draft.needsAddressed ?? undefined,
          duration: draft.duration ?? undefined,
          measureOfSuccess: draft.measureOfSuccess ?? undefined,
        },
      });
      updatedIds.push(updatedRow.id);

      await tx.stage4ProposalRevision.create({
        data: {
          proposalId: updatedRow.id,
          sessionId: subChat.sessionId,
          actorUserId: subChat.userId,
          action: 'subchat_refined',
          after: {
            description: draft.description,
            needsAddressed: draft.needsAddressed,
            duration: draft.duration,
            measureOfSuccess: draft.measureOfSuccess,
          } as Prisma.InputJsonValue,
        },
      });
    }

    await tx.stage4SubChat.update({
      where: { id: subChat.id },
      data: {
        status: PrismaStage4SubChatStatus.RESOLVED,
        resolvedAt: new Date(),
      },
    });
  });

  const refreshed = await getSubChatById(subChat.id);
  if (!refreshed) throw new SubChatNotFoundError();
  return {
    subChat: refreshed,
    createdProposalIds: createdIds,
    updatedProposalIds: updatedIds,
  };
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
