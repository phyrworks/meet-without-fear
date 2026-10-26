/**
 * Messages on the target shape (TS-9, spec §1.1 `message`).
 *
 * A message belongs to a conversation, and a conversation to ONE participant:
 * the conversation is the audience. There is no recipient column and no
 * "sender OR recipient" filter any more — a participant reads exactly their
 * own MAIN conversation, which is what made the old privacy filter
 * unnecessary.
 *
 * Writers, by principal (spec "Key per row", writer-principal rule):
 *   - `createParticipantMessage` — the participant's own turn (role USER,
 *     kind CHAT, or a refining-need reply), on the APP connection;
 *   - `createFacilitatorMessage` — an AI or SYSTEM row in a participant's
 *     conversation, on the JOB connection (`getJobPrisma()`);
 *   - `deliverMessage` — a delivered kind (EMPATHY_STATEMENT, SHARED_CONTEXT,
 *     …) written into ANOTHER participant's conversation, on the JOB
 *     connection.
 *
 * The DTO (`shared` MessageDTO) is unchanged: `role` is the old single role
 * (the target's role, or its kind for a delivered item), `senderId` the sender
 * participant's user id, `sessionId` the conversation's session, `stage` the
 * owner's stage at the message's instant (stage shim), `timestamp` created_at.
 */

import type { PrismaClient } from '../generated/prisma/client';
import { getJobPrisma, prisma } from '../lib/prisma';
import { contentHash } from '../utils/content-hash';
import { messageStage, type MilestoneReached } from './stage-shim';

export type TargetMessageRole = 'USER' | 'AI' | 'SYSTEM';
export type TargetMessageKind =
  | 'CHAT'
  | 'EMPATHY_STATEMENT'
  | 'EMPATHY_REVEAL_INTRO'
  | 'SHARED_CONTEXT'
  | 'VALIDATION_FEEDBACK'
  | 'SHARE_SUGGESTION'
  | 'EMPATHY_VALIDATION_PROMPT';

/** The row shape every reader here works with. */
export interface StoredMessage {
  id: string;
  conversationId: string;
  senderParticipantId: string | null;
  role: TargetMessageRole;
  kind: TargetMessageKind;
  content: string;
  refiningNeedId: string | null;
  sourceAttemptId: string | null;
  createdAt: Date;
  senderParticipant: { userId: string | null } | null;
}

/** The DTO's single role: CHAT rows keep theirs, every other kind is named by its kind. */
export function legacyRole(role: TargetMessageRole, kind: TargetMessageKind): string {
  return kind === 'CHAT' ? role : kind;
}

/** The inverse, for writers that still receive an old role. */
export function targetRoleAndKind(
  legacy: string,
  hasSender: boolean,
): { role: TargetMessageRole; kind: TargetMessageKind } {
  if (legacy === 'USER' || legacy === 'AI' || legacy === 'SYSTEM') return { role: legacy, kind: 'CHAT' };
  return { role: hasSender ? 'USER' : 'AI', kind: legacy as TargetMessageKind };
}

export interface MessageDTOContext {
  sessionId: string;
  /** The conversation owner's milestones, for the stage shim. */
  ownerMilestones: MilestoneReached[];
}

export interface LegacyMessageDTO {
  id: string;
  sessionId: string;
  senderId: string | null;
  role: string;
  content: string;
  stage: number;
  timestamp: string;
}

export function toMessageDTO(m: StoredMessage, ctx: MessageDTOContext): LegacyMessageDTO {
  return {
    id: m.id,
    sessionId: ctx.sessionId,
    senderId: m.senderParticipant?.userId ?? null,
    role: legacyRole(m.role, m.kind),
    content: m.content,
    stage: messageStage(ctx.ownerMilestones, m.createdAt),
    timestamp: m.createdAt.toISOString(),
  };
}

export const MESSAGE_SELECT = {
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
} as const;

/**
 * A page of one conversation. `take` is `limit + 1`, so the caller can answer
 * `hasMore` without a second query — and so the read stays bounded.
 */
export async function listConversationMessages(opts: {
  conversationId: string;
  limit: number;
  order: 'asc' | 'desc';
  before?: Date;
  after?: Date;
  /** Only messages newer than this (summary boundary). */
  newerThan?: Date;
}): Promise<StoredMessage[]> {
  const createdAt: Record<string, Date> = {};
  if (opts.before) createdAt.lt = opts.before;
  if (opts.after) createdAt.gt = opts.after;
  if (opts.newerThan) createdAt.gt = opts.newerThan;
  return (await prisma.message.findMany({
    where: { conversationId: opts.conversationId, ...(Object.keys(createdAt).length ? { createdAt } : {}) },
    orderBy: { createdAt: opts.order },
    take: opts.limit + 1,
    select: MESSAGE_SELECT,
  })) as StoredMessage[];
}

/** Count of the participant's own turns in their conversation (role USER, kind CHAT). */
export async function countOwnTurns(conversationId: string, participantId: string, since?: Date): Promise<number> {
  return prisma.message.count({
    where: {
      conversationId,
      senderParticipantId: participantId,
      role: 'USER',
      kind: 'CHAT',
      ...(since ? { createdAt: { gte: since } } : {}),
    },
  });
}

/** The newest own turn's instant, or null. */
export async function lastOwnTurnAt(conversationId: string, participantId: string): Promise<Date | null> {
  const last = await prisma.message.findFirst({
    where: { conversationId, senderParticipantId: participantId, role: 'USER', kind: 'CHAT' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return last?.createdAt ?? null;
}

// ----------------------------------------------------------------------------
// Writers
// ----------------------------------------------------------------------------

/**
 * One INSERT … RETURNING id, created_at — nothing else: the job's SELECT
 * grant on message is exactly (id, created_at) (trailer T7, TS-9 fix round
 * 2), so a job writer can never read back a row's content, and the written
 * row is built from the inputs the writer already holds.
 */
async function insert(
  client: PrismaClient,
  data: {
    conversationId: string;
    senderParticipantId: string | null;
    /** The sender's user id, when the caller knows it (for the DTO's senderId). */
    senderUserId?: string | null;
    role: TargetMessageRole;
    kind: TargetMessageKind;
    content: string;
    refiningNeedId?: string | null;
    sourceAttemptId?: string | null;
    createdAt?: Date;
  },
): Promise<StoredMessage> {
  const row = await client.message.create({
    data: {
      conversationId: data.conversationId,
      senderParticipantId: data.senderParticipantId,
      role: data.role,
      kind: data.kind,
      content: data.content,
      // Written here as well as by the encryption middleware, which computes
      // it only when encryption is on; dedupe probes need it either way.
      contentHash: contentHash(data.content),
      refiningNeedId: data.refiningNeedId ?? null,
      sourceAttemptId: data.sourceAttemptId ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
    select: { id: true, createdAt: true },
  });
  return {
    id: row.id,
    conversationId: data.conversationId,
    senderParticipantId: data.senderParticipantId,
    role: data.role,
    kind: data.kind,
    content: data.content,
    refiningNeedId: data.refiningNeedId ?? null,
    sourceAttemptId: data.sourceAttemptId ?? null,
    createdAt: row.createdAt,
    senderParticipant: data.senderParticipantId ? { userId: data.senderUserId ?? null } : null,
  };
}

/**
 * The participant's own turn, into their MAIN conversation (app connection).
 * `conversationId` is required: the caller resolved it with the participant.
 */
export function createParticipantMessage(opts: {
  conversationId: string;
  participantId: string;
  /** The participant's user id (the DTO's senderId). */
  userId?: string | null;
  content: string;
  refiningNeedId?: string | null;
  createdAt?: Date;
}): Promise<StoredMessage> {
  return insert(prisma, {
    conversationId: opts.conversationId,
    senderParticipantId: opts.participantId,
    senderUserId: opts.userId ?? null,
    role: 'USER',
    kind: 'CHAT',
    content: opts.content,
    refiningNeedId: opts.refiningNeedId,
    createdAt: opts.createdAt,
  });
}

/**
 * An AI or SYSTEM row in a participant's conversation — the facilitator never
 * has a sender (CHECK `role NOT IN ('AI','SYSTEM') OR sender IS NULL`).
 * Written through the JOB connection.
 */
export function createFacilitatorMessage(opts: {
  conversationId: string;
  role?: 'AI' | 'SYSTEM';
  kind?: TargetMessageKind;
  content: string;
  sourceAttemptId?: string | null;
  /** The participant's need this reply refines (Stage 3 refinement turns). */
  refiningNeedId?: string | null;
  createdAt?: Date;
  /** For tests: the client the job connection resolves to. */
  client?: PrismaClient;
}): Promise<StoredMessage> {
  return insert(opts.client ?? getJobPrisma(), {
    conversationId: opts.conversationId,
    senderParticipantId: null,
    role: opts.role ?? 'AI',
    kind: opts.kind ?? 'CHAT',
    content: opts.content,
    refiningNeedId: opts.refiningNeedId,
    sourceAttemptId: opts.sourceAttemptId,
    createdAt: opts.createdAt,
  });
}

/**
 * A delivered item authored by one participant, written into ANOTHER
 * participant's conversation (role USER — delivered items are the author's;
 * spec T-message-immutable). JOB connection: the request path never writes
 * into someone else's conversation.
 */
export function deliverMessage(opts: {
  toConversationId: string;
  fromParticipantId: string;
  kind: Exclude<TargetMessageKind, 'CHAT'>;
  content: string;
  sourceAttemptId?: string | null;
  createdAt?: Date;
  client?: PrismaClient;
}): Promise<StoredMessage> {
  return insert(opts.client ?? getJobPrisma(), {
    conversationId: opts.toConversationId,
    senderParticipantId: opts.fromParticipantId,
    role: 'USER',
    kind: opts.kind,
    content: opts.content,
    sourceAttemptId: opts.sourceAttemptId,
    createdAt: opts.createdAt,
  });
}

/** Delete one message (failed-turn cleanup); the owner's own connection. */
export async function deleteMessage(id: string): Promise<void> {
  await prisma.message.delete({ where: { id } });
}
