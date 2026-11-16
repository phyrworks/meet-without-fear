/**
 * Retry a Serializable transaction that lost (step 7 review F2, work-k5fk.4).
 *
 * Since work-k5fk.4 every message INSERT also UPDATEs its conversation's
 * next_seq (t_message_seq), so a Serializable transaction that writes a line
 * into a conversation conflicts with any line committed there after its
 * snapshot: PostgreSQL answers 40001 ("could not serialize access"), which
 * Prisma surfaces as P2034 from the transaction, or as the raw statement's
 * SQLSTATE (P2010, meta.code 40001) from inside it. Such a round did nothing
 * (it rolled back), so running the whole transaction again is safe.
 *
 * The two Serializable transactions in the app (audited): the reveal
 * (reconciler/state.ts checkAndRevealBothIfReady) and getInitialMessage's
 * once-only write (controllers/messages.ts).
 */

import { Prisma } from '../generated/prisma/client';

/** A lost Serializable round: P2034, or SQLSTATE 40001 from a raw statement inside it. */
export function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') return true;
    const meta = error.meta as { code?: unknown } | undefined;
    return meta?.code === '40001' || /\b40001\b|could not serialize/.test(error.message);
  }
  // node-postgres (a pg client inside a test or a script)
  return (error as { code?: unknown } | null)?.code === '40001';
}

/** Run `fn` (one whole transaction) again while it loses a Serializable round, at most `attempts` times. */
export async function withSerializableRetry<T>(fn: () => Promise<T>, opts: { attempts?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  for (let round = 1; ; round++) {
    try {
      return await fn();
    } catch (error) {
      if (round >= attempts || !isSerializationFailure(error)) throw error;
    }
  }
}
