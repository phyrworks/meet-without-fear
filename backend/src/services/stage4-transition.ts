/**
 * The Stage 4 transition line ("You have both sent your needs … Let's start with one of yours: <label>."), one per
 * participant, in their own MAIN conversation, naming their own first live confirmed need.
 *
 * Owner decision 2026-11-18 (work-k5fk.10.7 review r1, after 10.36): each line is written from its OWN participant's
 * request, so a participant's need label never enters a co-participant's process. The request that completes the
 * mutual share writes the requester's line at once; every other participant's line is written lazily by their next
 * read of the session's state or messages (their client refetches on partner.stage_completed). The once-only key
 * STAGE4_TRANSITION (sql_message_once) makes it exactly one line per conversation, whoever writes first; the lazy
 * write happens only once some party holds a keyed line (app.stage4_transition_started), so a session that reached
 * Stage 4 before this rule, or a fixture, is left as it is.
 */
import { prisma } from '../lib/prisma';
import { createFacilitatorMessageOnce, type StoredMessage } from './message-store';
import { listOwnNeeds } from './needs';
import type { Seat } from './participant-resolver';

export function buildStage4TransitionContent(firstNeed?: string | null): string {
  const needText = firstNeed?.trim();
  const needLine = needText ? `Let's start with one of yours: ${needText}.` : "Let's start with one of yours.";
  return [
    'You have both sent your needs and can now see what each of you named.',
    `${needLine} The work now is not to decide everything, just to put ideas on the table. What might help honor that need?`,
  ].join('\n\n');
}

/**
 * Writes the caller's own transition line into their own MAIN conversation (their own label: an own-row read).
 * Null when the line already exists.
 */
export async function writeOwnStage4TransitionLine(seat: Seat, conversationId: string): Promise<StoredMessage | null> {
  const [first] = await listOwnNeeds(seat, { live: true, confirmed: true });
  return createFacilitatorMessageOnce({
    conversationId,
    dedupeKey: 'STAGE4_TRANSITION',
    content: buildStage4TransitionContent(first?.label ?? null),
  });
}

/**
 * The lazy half: on the caller's read of their session, write their transition line if the mutual share has
 * completed (their needs_shared milestone) and their conversation does not hold it yet. The existence probe keeps
 * a repeat read from taking a message number (a conflicting once-only insert leaves a hole, work-k5fk.4); the key
 * still settles two concurrent reads.
 */
export async function ensureOwnStage4TransitionLine(seat: Seat, conversationId: string): Promise<boolean> {
  const [reached, written] = await Promise.all([
    prisma.participantMilestone.count({
      where: { sessionId: seat.sessionId, userId: seat.userId, milestoneKey: 'needs_shared' },
    }),
    // A bounded probe (LIMIT 1 on sql_message_once): the session read's plan check holds every Message read to a limit.
    prisma.message.findFirst({ where: { conversationId, dedupeKey: 'STAGE4_TRANSITION' }, select: { seq: true } }),
  ]);
  if (reached === 0 || written) return false;
  // Only once the own-request rule has begun in this session: the completing request wrote its user's line. A
  // session that reached needs_shared otherwise (a fixture, lines that predate the key) gets no second line.
  const [{ started }] = await prisma.$queryRaw<Array<{ started: boolean }>>`
    SELECT app.stage4_transition_started(${seat.sessionId}::uuid) AS started`;
  if (!started) return false;
  return (await writeOwnStage4TransitionLine(seat, conversationId)) !== null;
}
