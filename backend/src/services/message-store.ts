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
 *     conversation, on the AI connection (`getAiPrisma()`, mwf_ai, scoped to
 *     the session by app.session_scope — work-k5fk.10.5);
 *   - `createFacilitatorMessageOnce` — a once-only AI line keyed by
 *     `dedupe_key` (work-fdc1; one raw INSERT … ON CONFLICT DO NOTHING), on
 *     the AI connection;
 *   - `deliverMessage` — a delivered kind (EMPATHY_STATEMENT, SHARED_CONTEXT,
 *     …) written into ANOTHER participant's conversation, through the definer
 *     app.deliver_message: on the APP connection as the author, or inside the
 *     reconciler's AI transaction (sharing.ts deliverAcceptedShare).
 *
 * Keys (work-k5fk.4): a message is (conversation_id, seq); the trigger
 * t_message_seq numbers every INSERT, so no writer here sends seq, and each
 * reads it back with RETURNING. `StoredMessage.id` — and the DTO's — is the
 * derived "<conversationId>:<seq>" (shared formatMessageId); `seq` rides along.
 *
 * The DTO (`shared` MessageDTO) adds `seq`; otherwise: `role` is the old single role
 * (the target's role, or its kind for a delivered item), `senderId` the sender's
 * user id (`sender_user_id`; the sender participant is (session_id, sender_user_id)), `sessionId` the conversation's session, `stage` the
 * owner's stage at the message's instant (stage shim), `timestamp` created_at.
 */

import { formatMessageId, parseMessageId, type MessageKey } from '@meet-without-fear/shared';
import type { DbClient } from '../lib/prisma';
import { getAiPrisma, prisma } from '../lib/prisma';
import { encryptColumnValue } from '../lib/prisma-encryption-middleware';
import type { Seat } from './participant-resolver';
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

/**
 * The once-only facilitator lines (enum message_dedupe_key, work-fdc1): an
 * app-generated AI line written at most once per conversation. The key is the
 * line's identity, so nothing derived from its content is stored — the old
 * sha256(content) probe was an unsalted plaintext oracle on every message.
 * sql_message_once (unique on conversation_id, dedupe_key) is the guard, so
 * two concurrent writers still produce one row.
 */
export const MESSAGE_DEDUPE_KEYS = ['STAGE2_VALIDATED_WAIT', 'STAGE4_HANDOFF_BRIDGE'] as const;
export type MessageDedupeKey = (typeof MESSAGE_DEDUPE_KEYS)[number];

/** The row shape every reader here works with. */
export interface StoredMessage {
  /** "<conversationId>:<seq>" — derived, never stored. */
  id: string;
  conversationId: string;
  /** The line's place in its conversation (the key with conversationId). */
  seq: number;
  /** The sender's user id (the sender participant is the message's (session_id, sender_user_id)); null for AI/SYSTEM. */
  senderUserId: string | null;
  role: TargetMessageRole;
  kind: TargetMessageKind;
  content: string;
  refiningNeedId: string | null;
  sourceAttemptId: string | null;
  createdAt: Date;
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
  /** The owner's invitation is unsent (stage shim `invitationPending`). Required: see `StageOpts`. */
  ownerInvitationPending: boolean;
}

export interface LegacyMessageDTO {
  id: string;
  seq: number;
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
    seq: m.seq,
    sessionId: ctx.sessionId,
    senderId: m.senderUserId,
    role: legacyRole(m.role, m.kind),
    content: m.content,
    stage: messageStage(ctx.ownerMilestones, m.createdAt, { invitationPending: ctx.ownerInvitationPending }),
    timestamp: m.createdAt.toISOString(),
  };
}

export const MESSAGE_SELECT = {
  conversationId: true,
  seq: true,
  senderUserId: true,
  role: true,
  kind: true,
  content: true,
  refiningNeedId: true,
  sourceAttemptId: true,
  createdAt: true,
} as const;

/** A row read with MESSAGE_SELECT (or any select holding the key), with its derived id. */
export function withMessageId<T extends { conversationId: string; seq: number }>(row: T): T & { id: string } {
  return { ...row, id: formatMessageId(row.conversationId, row.seq) };
}

/** The key of an API message id ("<conversationId>:<seq>"), or null. */
export function messageKeyOf(id: unknown): MessageKey | null {
  return parseMessageId(id);
}

/** Prisma's where for one message by its API id (`conversationId_seq`); throws on a malformed id. */
export function whereMessageId(id: string): { conversationId_seq: MessageKey } {
  const key = parseMessageId(id);
  if (!key) throw new Error(`not a message id: ${id}`);
  return { conversationId_seq: key };
}

/**
 * A page of one conversation. `take` is `limit + 1`, so the caller can answer
 * `hasMore` without a second query — and so the read stays bounded.
 */
export async function listConversationMessages(opts: {
  conversationId: string;
  limit: number;
  order: 'asc' | 'desc';
  /** Page cursors: lines before / after this seq (review F3 — the order is seq, so the cursor is too). */
  beforeSeq?: number;
  afterSeq?: number;
  /** Only messages newer than this (summary boundary). */
  newerThan?: Date;
}): Promise<StoredMessage[]> {
  const seq: Record<string, number> = {};
  if (opts.beforeSeq !== undefined) seq.lt = opts.beforeSeq;
  if (opts.afterSeq !== undefined) seq.gt = opts.afterSeq;
  // seq is the chat order (work-k5fk.4: the key).
  const rows = await prisma.message.findMany({
    where: {
      conversationId: opts.conversationId,
      ...(Object.keys(seq).length ? { seq } : {}),
      ...(opts.newerThan ? { createdAt: { gt: opts.newerThan } } : {}),
    },
    orderBy: { seq: opts.order },
    take: opts.limit + 1,
    select: MESSAGE_SELECT,
  });
  return rows.map(withMessageId) as StoredMessage[];
}

/** Count of the participant's own turns in their conversation (role USER, kind CHAT). */
export async function countOwnTurns(conversationId: string, seat: Seat, since?: Date): Promise<number> {
  return prisma.message.count({
    where: {
      conversationId,
      sessionId: seat.sessionId,
      senderUserId: seat.userId,
      role: 'USER',
      kind: 'CHAT',
      ...(since ? { createdAt: { gte: since } } : {}),
    },
  });
}

/** The newest own turn's instant, or null. */
export async function lastOwnTurnAt(conversationId: string, seat: Seat): Promise<Date | null> {
  const last = await prisma.message.findFirst({
    where: {
      conversationId,
      sessionId: seat.sessionId,
      senderUserId: seat.userId,
      role: 'USER',
      kind: 'CHAT',
    },
    orderBy: { seq: 'desc' },
    select: { createdAt: true },
  });
  return last?.createdAt ?? null;
}

// ----------------------------------------------------------------------------
// Writers
// ----------------------------------------------------------------------------

/**
 * One INSERT … RETURNING seq, created_at — nothing else: the job's SELECT
 * grant on message is exactly the key and the instant (tables.sql; TS-9 fix
 * round 2, work-k5fk.4), so a job writer can never read back a row's content,
 * and the written row is built from the inputs the writer already holds.
 * seq is not sent: t_message_seq numbers the row.
 */
async function insert(
  client: DbClient,
  data: {
    conversationId: string;
    /** The conversation's session, when the caller holds it (else read from the conversation). */
    sessionId?: string | null;
    /** The sender's user id (a participant of the conversation's session); null for AI/SYSTEM. */
    senderUserId: string | null;
    role: TargetMessageRole;
    kind: TargetMessageKind;
    content: string;
    refiningNeedId?: string | null;
    sourceAttemptId?: string | null;
    createdAt?: Date;
  },
): Promise<StoredMessage> {
  // work-k5fk.3: the row carries its session and its sender's user — the keys pin both (message
  // (conversation_id, session_id) → conversation; (session_id, sender_user_id) → participant). A
  // caller without the session has it read from the conversation in the INSERT.
  // created_at is the client's instant, as the Prisma create sent it (@default(now())).
  const [row] = await client.$queryRaw<Array<{ seq: number; created_at: Date }>>`
    INSERT INTO message (conversation_id, session_id, sender_user_id, role, kind, content,
                         refining_need_id, source_attempt_id, created_at)
    VALUES (${data.conversationId}::uuid,
            coalesce(${data.sessionId ?? null}::uuid,
                     (SELECT c.session_id FROM conversation c WHERE c.id = ${data.conversationId}::uuid)),
            ${data.senderUserId}::uuid,
            ${data.role}::message_role, ${data.kind}::message_kind, ${encryptColumnValue('message', 'content', data.content)},
            ${data.refiningNeedId ?? null}::uuid, ${data.sourceAttemptId ?? null}::uuid, ${data.createdAt ?? new Date()})
    RETURNING seq, created_at`;
  const createdAt = row.created_at;
  return {
    id: formatMessageId(data.conversationId, row.seq),
    conversationId: data.conversationId,
    seq: row.seq,
    senderUserId: data.senderUserId,
    role: data.role,
    kind: data.kind,
    content: data.content,
    refiningNeedId: data.refiningNeedId ?? null,
    sourceAttemptId: data.sourceAttemptId ?? null,
    createdAt,
  };
}

/**
 * The participant's own turn, into their MAIN conversation (app connection).
 * `conversationId` is required: the caller resolved it with the participant.
 */
export function createParticipantMessage(opts: {
  conversationId: string;
  /** The sender: the participant whose conversation this is. */
  seat: Seat;
  content: string;
  refiningNeedId?: string | null;
  createdAt?: Date;
}): Promise<StoredMessage> {
  return insert(prisma, {
    conversationId: opts.conversationId,
    sessionId: opts.seat.sessionId,
    senderUserId: opts.seat.userId,
    role: 'USER',
    kind: 'CHAT',
    content: opts.content,
    refiningNeedId: opts.refiningNeedId,
    createdAt: opts.createdAt,
  });
}

/**
 * The author's own copy of their empathy statement (kind EMPATHY_STATEMENT, in
 * their own conversation, app connection; t_message_app_insert admits it),
 * naming the attempt it states. Raw like every writer here: seq is the
 * trigger's, so a Prisma create (which would demand it) cannot write a message.
 */
export function createOwnStatementMessage(opts: {
  conversationId: string;
  sessionId: string;
  userId: string;
  content: string;
  attemptId: string;
}): Promise<StoredMessage> {
  return insert(prisma, {
    conversationId: opts.conversationId,
    sessionId: opts.sessionId,
    senderUserId: opts.userId,
    role: 'USER',
    kind: 'EMPATHY_STATEMENT',
    content: opts.content,
    sourceAttemptId: opts.attemptId,
  });
}

/**
 * An AI or SYSTEM row in a participant's conversation — the facilitator never
 * has a sender (CHECK `role NOT IN ('AI','SYSTEM') OR sender IS NULL`).
 * Written through the AI connection.
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
  /** For tests, and the AI's own transactions: the client the AI connection resolves to. */
  client?: DbClient;
}): Promise<StoredMessage> {
  return insert(opts.client ?? getAiPrisma(), {
    conversationId: opts.conversationId,
    senderUserId: null,
    role: opts.role ?? 'AI',
    kind: opts.kind ?? 'CHAT',
    content: opts.content,
    refiningNeedId: opts.refiningNeedId,
    sourceAttemptId: opts.sourceAttemptId,
    createdAt: opts.createdAt,
  });
}

/**
 * A once-only facilitator line (work-fdc1): an AI row in a participant's
 * conversation, written at most once per (conversation, key). Returns the
 * written row, or null when the line was already there.
 *
 * One statement, `INSERT … ON CONFLICT DO NOTHING RETURNING id, created_at`;
 * the conflict it absorbs is sql_message_once (see below for why it names no
 * target). A conflict is not an error, so there is no check-then-insert
 * window (two concurrent calls write one row) and it is safe inside an
 * interactive transaction: nothing aborts it (a caught P2002 would leave the
 * caller's transaction in 25P02). Raw SQL, so the content is sealed here with
 * `encryptColumnValue('message', 'content', …)`, as the Prisma extension seals
 * a model write (the same field of SENSITIVE_FIELD_MAP, key class per-row).
 * AI connection, like every facilitator row (it may INSERT dedupe_key but
 * never SELECT it; RETURNING reads only seq, created_at).
 */
export async function createFacilitatorMessageOnce(opts: {
  conversationId: string;
  dedupeKey: MessageDedupeKey;
  content: string;
  createdAt?: Date;
  /** The AI connection by default; a transaction client of it is fine. */
  client?: DbClient;
}): Promise<StoredMessage | null> {
  const client = opts.client ?? getAiPrisma();
  // No conflict target: inferring one (ON CONFLICT (conversation_id, dedupe_key)
  // WHERE …) needs SELECT on the arbiter columns, and mwf_ai must not read
  // dedupe_key (42501, verified). Without a target the arbiters are message's
  // unique indexes: the key and (key, session_id), whose seq t_message_seq has
  // just taken (cannot collide), and sql_message_once — so the only conflict is
  // the dedupe key. The number taken for a conflicting line is a hole (work-k5fk.4).
  const rows = await client.$queryRaw<Array<{ seq: number; created_at: Date }>>`
    INSERT INTO message (conversation_id, session_id, role, kind, content, dedupe_key, created_at)
    VALUES (${opts.conversationId}::uuid, (SELECT c.session_id FROM conversation c WHERE c.id = ${opts.conversationId}::uuid),
            'AI'::message_role, 'CHAT'::message_kind,
            ${encryptColumnValue('message', 'content', opts.content)},
            ${opts.dedupeKey}::message_dedupe_key, coalesce(${opts.createdAt ?? null}::timestamptz, CURRENT_TIMESTAMP))
    ON CONFLICT DO NOTHING
    RETURNING seq, created_at`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: formatMessageId(opts.conversationId, row.seq),
    conversationId: opts.conversationId,
    seq: row.seq,
    senderUserId: null,
    role: 'AI',
    kind: 'CHAT',
    content: opts.content,
    refiningNeedId: null,
    sourceAttemptId: null,
    createdAt: row.created_at,
  };
}

/**
 * A delivered item authored by one participant, written into ANOTHER
 * participant's conversation (role USER — delivered items are the author's;
 * spec T-message-immutable), through app.deliver_message (work-k5fk.10.5): the
 * request path never INSERTs into someone else's conversation — the definer
 * does, for the author (the APP connection, identity-bound: the default) or for
 * the AI within its session scope (a transaction client of the AI connection).
 * The content is sealed here, as the Prisma extension seals a model write.
 */
export function deliverMessage(opts: {
  toConversationId: string;
  /** The session of both conversations (every participant of the row is of it). */
  sessionId: string;
  /** The author: a participant of `sessionId`. */
  fromUserId: string;
  kind: Exclude<TargetMessageKind, 'CHAT'>;
  content: string;
  sourceAttemptId?: string | null;
  createdAt?: Date;
  client?: DbClient;
}): Promise<StoredMessage> {
  return deliverThroughDefiner(opts.client ?? prisma, opts);
}

async function deliverThroughDefiner(
  client: DbClient,
  opts: {
    toConversationId: string;
    fromUserId: string;
    kind: Exclude<TargetMessageKind, 'CHAT'>;
    content: string;
    sourceAttemptId?: string | null;
    createdAt?: Date;
  },
): Promise<StoredMessage> {
  const [row] = await client.$queryRaw<Array<{ seq: number; created_at: Date }>>`SELECT d.seq, d.created_at
    FROM app.deliver_message(${opts.toConversationId}::uuid, ${opts.fromUserId}::uuid, ${opts.kind}::message_kind,
                             ${encryptColumnValue('message', 'content', opts.content)}, ${opts.sourceAttemptId ?? null}::uuid,
                             ${opts.createdAt ?? new Date()}::timestamptz) d`;
  return {
    id: formatMessageId(opts.toConversationId, row.seq),
    conversationId: opts.toConversationId,
    seq: row.seq,
    senderUserId: opts.fromUserId,
    role: 'USER',
    kind: opts.kind,
    content: opts.content,
    refiningNeedId: null,
    sourceAttemptId: opts.sourceAttemptId ?? null,
    createdAt: row.created_at,
  };
}

/** Delete one message by its API id (failed-turn cleanup); the owner's own connection. */
export async function deleteMessage(id: string): Promise<void> {
  await prisma.message.delete({ where: whereMessageId(id) });
}

/** The API id of a read state's seen message ("<conversationId>:<seq>"), or null (work-k5fk.4). */
export function lastSeenMessageIdOf(
  rs: { lastSeenConversationId: string | null; lastSeenSeq: number | null } | null | undefined,
): string | null {
  return rs?.lastSeenConversationId && rs.lastSeenSeq != null
    ? formatMessageId(rs.lastSeenConversationId, rs.lastSeenSeq)
    : null;
}
