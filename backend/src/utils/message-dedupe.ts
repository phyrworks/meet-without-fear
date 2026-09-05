/**
 * Message Deduplication Probe
 *
 * Several flows insert a fixed system/AI message exactly once per (session, user)
 * and use a "does this message already exist?" probe to stay idempotent.
 *
 * Those probes used to compare `Message.content` to the plaintext they were about
 * to insert. Under field-level encryption that comparison can never match — the
 * stored value is ciphertext with a random IV — so the probe silently returned
 * null and the message was inserted on every call.
 *
 * The probe now matches on `Message.contentHash`, the SHA-256 of the plaintext
 * written by the Prisma encryption middleware. It is backed by the
 * (sessionId, forUserId, role, contentHash) index.
 *
 * Rows written before the contentHash column existed have a NULL hash and will
 * not match. That is a one-time, self-healing duplicate at worst — never data loss.
 */

import { contentHash } from './content-hash';

/** The subset of Prisma's Message delegate this probe needs. */
export interface MessageFindFirstDelegate {
  findFirst(args: {
    where: Record<string, unknown>;
    select: { id: true };
  }): Promise<{ id: string } | null>;
}

export interface MessageContentCriteria {
  sessionId: string;
  forUserId: string;
  role: string;
  /** The PLAINTEXT content about to be inserted. */
  content: string;
}

/**
 * Find an existing Message with this exact content for this session/user/role.
 * Returns `{ id }` if one exists, otherwise null.
 */
export async function findMessageByContent(
  message: MessageFindFirstDelegate,
  { sessionId, forUserId, role, content }: MessageContentCriteria,
): Promise<{ id: string } | null> {
  return message.findFirst({
    where: {
      sessionId,
      forUserId,
      role,
      contentHash: contentHash(content),
    },
    select: { id: true },
  });
}
