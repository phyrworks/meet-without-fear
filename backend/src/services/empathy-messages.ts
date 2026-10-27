/**
 * Stage 2 / reconciler messages on the target shape (TS-10).
 *
 * Every message these flows write, by principal (spec §1.1 message, "Key per
 * row"; TS-9 message-store):
 *   - the author's own EMPATHY_STATEMENT copy in their own conversation — the
 *     participant's own row (app connection);
 *   - AI rows (transition, alignment, reveal notice, reflections) — the job,
 *     into exactly one participant's conversation;
 *   - delivered items (SHARED_CONTEXT, VALIDATION_FEEDBACK) — the job, into the
 *     RECIPIENT's conversation, sender = the author. (The subject's delivered
 *     EMPATHY_STATEMENT is written by app.empathy_set_status itself.)
 *
 * The DTO is TS-9's `toMessageDTO` (role = the kind for a delivered item;
 * stage from the owner's milestones).
 */

import type { MessageDTO } from '@meet-without-fear/shared';
import { prisma } from '../lib/prisma';
import type { PrismaClient } from '../generated/prisma/client';
import { contentHash } from '../utils/content-hash';
import {
  createFacilitatorMessage,
  deliverMessage,
  toMessageDTO,
  type StoredMessage,
  type TargetMessageKind,
} from './message-store';
import { loadMilestones } from './stage-shim';

/** The DTO of a stored message in `ownerParticipantId`'s conversation. */
export async function messageDTO(
  stored: StoredMessage,
  sessionId: string,
  ownerParticipantId: string,
): Promise<MessageDTO & { stage: number }> {
  const milestones = (await loadMilestones([ownerParticipantId])).get(ownerParticipantId) ?? [];
  return toMessageDTO(stored, { sessionId, ownerMilestones: milestones }) as unknown as MessageDTO & { stage: number };
}

/** An AI row in one participant's conversation (job connection). */
export function aiNote(conversationId: string, content: string, createdAt?: Date): Promise<StoredMessage> {
  return createFacilitatorMessage({ conversationId, content, createdAt });
}

/** A delivered item into the recipient's conversation (job connection). */
export function deliver(opts: {
  toConversationId: string;
  fromParticipantId: string;
  kind: Exclude<TargetMessageKind, 'CHAT'>;
  content: string;
  sourceAttemptId?: string | null;
  createdAt?: Date;
}): Promise<StoredMessage> {
  return deliverMessage(opts);
}

/**
 * The author's own copy of their statement (kind EMPATHY_STATEMENT, their own
 * conversation, app connection), naming the round it states.
 */
export async function ownStatementCopy(opts: {
  conversationId: string;
  participantId: string;
  userId: string | null;
  content: string;
  attemptId: string;
}): Promise<StoredMessage> {
  const row = await prisma.message.create({
    data: {
      conversationId: opts.conversationId,
      senderParticipantId: opts.participantId,
      role: 'USER',
      kind: 'EMPATHY_STATEMENT',
      content: opts.content,
      contentHash: contentHash(opts.content),
      sourceAttemptId: opts.attemptId,
    },
    select: { id: true, createdAt: true },
  });
  return {
    id: row.id,
    conversationId: opts.conversationId,
    senderParticipantId: opts.participantId,
    role: 'USER',
    kind: 'EMPATHY_STATEMENT',
    content: opts.content,
    refiningNeedId: null,
    sourceAttemptId: opts.attemptId,
    createdAt: row.createdAt,
    senderParticipant: { userId: opts.userId },
  };
}

/**
 * Has this exact AI text already been written into this conversation (dedupe
 * on the content hash — content may be encrypted, the hash is stable)?
 */
export async function aiNoteExists(conversationId: string, content: string): Promise<boolean> {
  const found = await prisma.message.findFirst({
    where: { conversationId, role: 'AI', contentHash: contentHash(content) },
    select: { id: true },
  });
  return !!found;
}

/** The newest AI row's text in a conversation (the alignment-message de-dup guard). */
export async function lastAiNote(conversationId: string, client: PrismaClient = prisma): Promise<string | null> {
  const last = await client.message.findFirst({
    where: { conversationId, role: 'AI' },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  });
  return last?.content ?? null;
}
