/**
 * The API's message id (work-k5fk.4, owner decision Q6).
 *
 * A message is keyed (conversation_id, seq) in the database. The API keeps
 * `MessageDTO.id: string` as the derived `"<conversationId>:<seq>"` (and adds
 * `seq`), so clients that use the id as an opaque list key, animation identity
 * or optimistic-replacement sentinel need no change.
 */

import { UUID_V7_RE } from './uuid-v7';

export interface MessageKey {
  conversationId: string;
  seq: number;
}

/** `"<conversationId>:<seq>"`. */
export function formatMessageId(conversationId: string, seq: number): string {
  return `${conversationId}:${seq}`;
}

const MESSAGE_ID_RE = new RegExp(`^(${UUID_V7_RE.source.slice(1, -1)}):([1-9][0-9]{0,9})$`, 'i');

/**
 * The key of a message id, or null when `value` is not one: a UUIDv7
 * conversation id, a colon, and a positive int4 seq (no leading zero), so
 * every id `formatMessageId` makes parses back to its key and nothing else does.
 */
export function parseMessageId(value: unknown): MessageKey | null {
  if (typeof value !== 'string') return null;
  const m = MESSAGE_ID_RE.exec(value);
  if (!m) return null;
  const seq = Number(m[2]);
  if (seq > 2147483647) return null;
  return { conversationId: m[1].toLowerCase(), seq };
}
