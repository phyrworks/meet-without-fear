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
import {
  createFacilitatorMessage,
  createFacilitatorMessageOnce,
  deliverMessage,
  toMessageDTO,
  type StoredMessage,
  type TargetMessageKind,
} from './message-store';
import { loadInvitationPending, loadMilestones } from './stage-shim';
import type { Seat } from './participant-resolver';

/** The DTO of a stored message in the conversation of `owner` (whose session is the message's). */
export async function messageDTO(stored: StoredMessage, owner: Seat): Promise<MessageDTO & { stage: number }> {
  const [milestones, pending] = await Promise.all([loadMilestones([owner]), loadInvitationPending([owner])]);
  return toMessageDTO(stored, {
    sessionId: owner.sessionId,
    ownerMilestones: milestones.get(owner) ?? [],
    ownerInvitationPending: pending.has(owner),
  }) as unknown as MessageDTO & { stage: number };
}

/** An AI row in one participant's conversation (job connection). */
export function aiNote(conversationId: string, content: string, createdAt?: Date): Promise<StoredMessage> {
  return createFacilitatorMessage({ conversationId, content, createdAt });
}

/** A delivered item into the recipient's conversation (job connection). */
export function deliver(opts: {
  toConversationId: string;
  /** The session of both conversations. */
  sessionId: string;
  /** The author: a participant of `sessionId`. */
  fromUserId: string;
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
  /** The author's seat (the conversation's session and the author's user). */
  sessionId: string;
  userId: string;
  content: string;
  attemptId: string;
}): Promise<StoredMessage> {
  const row = await prisma.message.create({
    data: {
      conversationId: opts.conversationId,
      sessionId: opts.sessionId,
      senderUserId: opts.userId,
      role: 'USER',
      kind: 'EMPATHY_STATEMENT',
      content: opts.content,
      sourceAttemptId: opts.attemptId,
    },
    select: { id: true, createdAt: true },
  });
  return {
    id: row.id,
    conversationId: opts.conversationId,
    senderUserId: opts.userId,
    role: 'USER',
    kind: 'EMPATHY_STATEMENT',
    content: opts.content,
    refiningNeedId: null,
    sourceAttemptId: opts.attemptId,
    createdAt: row.createdAt,
  };
}

/**
 * The hold-here note after a participant validates the partner's statement
 * while the partner has not yet validated theirs: written at most once per
 * conversation (dedupe_key STAGE2_VALIDATED_WAIT, work-fdc1). Null when it was
 * already there.
 */
export function validatedWaitNote(
  conversationId: string,
  content: string,
  createdAt?: Date,
): Promise<StoredMessage | null> {
  return createFacilitatorMessageOnce({ conversationId, dedupeKey: 'STAGE2_VALIDATED_WAIT', content, createdAt });
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
