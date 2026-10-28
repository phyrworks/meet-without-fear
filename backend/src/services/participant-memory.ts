/**
 * The caller's own ai_memory documents in a session (spec §1.1 ai_memory,
 * participant scope). One read seam for the turn pipeline's background jobs
 * (TS-12), so their scheduling logic is unit-tested against this module, not
 * against a mocked Prisma client.
 */

import { prisma } from '../lib/prisma';
import { resolveParticipant } from './participant-resolver';

/**
 * The `facts` value of the user's NOTABLE_FACTS document in this session, as
 * stored (an array of `{ category, fact, id? }`, or legacy strings), or
 * undefined when the user has no participant or no document.
 */
export async function loadOwnNotableFacts(sessionId: string, userId: string): Promise<unknown> {
  const participant = await resolveParticipant(sessionId, userId);
  if (!participant) return undefined;
  const memory = await prisma.aiMemory.findUnique({
    where: { participantId_kind: { participantId: participant.id, kind: 'NOTABLE_FACTS' } },
    select: { doc: true },
  });
  return (memory?.doc as { facts?: unknown } | null)?.facts;
}
