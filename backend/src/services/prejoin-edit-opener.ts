/**
 * work-9309: "Edit first" on a pre-join empathy draft — the AI opens the
 * revision conversation.
 *
 * Owner decision 2026-11-07: after the partner joins, the inviter reviews the
 * draft they wrote before the join (work-99k2). On "Edit first" the AI speaks
 * FIRST, in the author's own conversation: "Here's what you wrote <day>.
 * Reading it now, what feels different?" The author then revises with the
 * AI's coaching and shares through the normal Review/Share flow.
 * Owner decision 2026-11-09: the old draft's Review/Share panel stays hidden
 * from Edit first until the AI proposes (a revision, or the original as is)
 * — `awaitingRevision`, derived below.
 *
 * Mechanism: the same proactive-turn path as the invitation-confirm opener
 * (sessions.ts confirmInvitationMessage) — the request returns at once and
 * the opener is generated in the background: getOrchestratedResponse with the
 * participant's own history and a bracketed trigger line that is never
 * stored, then one facilitator message into their MAIN conversation. The
 * prompt is the regular Stage 2 prompt plus its REOPENED DRAFT section
 * (stage-prompts.ts buildReopenedPreJoinDraftSection).
 *
 *   - The reopen, durably: the opener is written with created_at = the
 *     resolving write's updated_at. "Awaiting revision" is "an opener exists at
 *     the draft's last write" — any later draft write (the AI's proposal, the
 *     author's save) ends it. No stored flag, no schema change.
 *   - At most one opener per Edit first: resolvePreJoinReviewForEdit ends the
 *     review under a row lock and only that call schedules the opener. A
 *     retry, a second tap, a reload or another device finds nothing pending:
 *     it gets the existing opener back (or nothing), never a second one.
 *   - Never silent: a model failure, an empty reply or a timeout writes the
 *     fixed template instead.
 *   - Private: the opener goes into the author's conversation only; the Ably
 *     notice carries the message id, never its text (publishMessageAIResponse).
 *   - Never a statement: the turn is ReadyShare:N by prompt and by code
 *     (orchestrator), and this path never writes the draft beyond the
 *     resolving write.
 */

import type { MessageDTO } from '@meet-without-fear/shared';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getOrchestratedResponse, type FullAIContext } from './ai';
import { getSessionSummary } from './conversation-summarizer';
import { resolvePreJoinReviewForEdit } from './empathy-draft-save';
import { messageDTO } from './empathy-messages';
import {
  MESSAGE_SELECT,
  createFacilitatorMessage,
  listConversationMessages,
  countOwnTurns,
  type StoredMessage,
} from './message-store';
import { publishMessageAIResponse } from './realtime';
import type { ReopenedPreJoinDraft } from './stage-prompts';
import { buildReopenedPreJoinDraftFallback } from './stage-prompts';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The trigger line of the opener turn: the author's choice, never stored. */
export const EDIT_FIRST_TRIGGER = '[I chose "Edit first": I want to look at what I wrote before sending it.]';

/** A zone Intl knows, else UTC. */
function knownZone(timeZone: string | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** The calendar date (year, month 0-11, day, weekday 0-6) of an instant in a zone. */
function zonedDate(at: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const year = get('year');
  const month = get('month') - 1;
  const day = get('day');
  return { year, month, day, weekday: new Date(Date.UTC(year, month, day)).getUTCDay() };
}

/**
 * When the draft was written, as the review heading names it (mobile
 * PreJoinDraftReviewModal formatWrittenAt): "earlier today", "yesterday",
 * "on Tuesday" (within the last week), else "on Nov 2" (with the year when it
 * is not this year) — in the author's zone. Plus the full date for the prompt.
 */
export function describeWrittenAt(
  writtenAt: Date,
  now: Date,
  timeZone?: string,
): Pick<ReopenedPreJoinDraft, 'writtenAtPhrase' | 'writtenAtDate'> {
  const zone = knownZone(timeZone);
  const w = zonedDate(writtenAt, zone);
  const n = zonedDate(now, zone);
  const days = Math.round((Date.UTC(n.year, n.month, n.day) - Date.UTC(w.year, w.month, w.day)) / 86_400_000);
  let phrase: string;
  if (days <= 0) phrase = 'earlier today';
  else if (days === 1) phrase = 'yesterday';
  else if (days < 7) phrase = `on ${WEEKDAYS[w.weekday]}`;
  else phrase = `on ${MONTHS[w.month]} ${w.day}${w.year === n.year ? '' : `, ${w.year}`}`;
  return {
    writtenAtPhrase: phrase,
    writtenAtDate: `${WEEKDAYS[w.weekday]}, ${LONG_MONTHS[w.month]} ${w.day}, ${w.year}`,
  };
}

// ============================================================================
// The reopen, derived
// ============================================================================

/**
 * The opener of a reopen, if written: the AI row in the author's MAIN
 * conversation whose created_at is the draft's last write (the opener is
 * written at the resolving write's updated_at; any later draft write moves
 * updated_at on, so this finds it only while that write is still the last).
 */
export async function findReopenOpener(conversationId: string, draftUpdatedAt: Date): Promise<StoredMessage | null> {
  return (await prisma.message.findFirst({
    where: { conversationId, role: 'AI', kind: 'CHAT', createdAt: draftUpdatedAt },
    select: MESSAGE_SELECT,
  })) as StoredMessage | null;
}

/**
 * Is the author's draft reopened by Edit first and still awaiting the AI's
 * proposal? (work-9309, owner decision 2026-11-09.) True from the opener until
 * the next draft write — the AI's proposal through the ReadyShare path (a
 * revision, or the original as is), or the author's own save. Never while the
 * pre-join review is still pending, never once a round is submitted.
 */
export function deriveAwaitingRevision(facts: {
  partnerJoinedAt: Date | null;
  draftUpdatedAt: Date | null;
  roundSubmitted: boolean;
  /** An opener exists whose created_at is the draft's last write. */
  openerAtLastWrite: boolean;
}): boolean {
  if (!facts.partnerJoinedAt || !facts.draftUpdatedAt || facts.roundSubmitted) return false;
  if (facts.draftUpdatedAt < facts.partnerJoinedAt) return false; // the pre-join review is still pending
  return facts.openerAtLastWrite;
}

/**
 * awaitingRevision for a participant's EMPATHY draft about their partner, from
 * the database (GET /empathy/draft, the chat turn's prompt context).
 */
export async function isAwaitingRevision(opts: {
  conversationId: string | null;
  partnerJoinedAt: Date | null;
  draftUpdatedAt: Date | null;
  roundSubmitted: boolean;
}): Promise<boolean> {
  const candidate = deriveAwaitingRevision({ ...opts, openerAtLastWrite: true });
  if (!candidate || !opts.conversationId || !opts.draftUpdatedAt) return false;
  return !!(await findReopenOpener(opts.conversationId, opts.draftUpdatedAt));
}

// ============================================================================
// Edit first
// ============================================================================

export interface OpenPreJoinDraftRevisionParams {
  sessionId: string;
  userId: string;
  userName: string;
  participantId: string;
  mainConversationId: string;
  partnerName?: string;
  topicFrame?: string | null;
  timeZone?: string;
  /** For tests: the clock the day is named against. */
  now?: Date;
}

export type OpenPreJoinDraftRevisionResult =
  /** No reopen in effect (no review was pending and no opener at the draft's last write): nothing written. */
  | { resolved: false; opener: null; openerAt: null }
  /**
   * The reopen is in effect. `openerAt` is the opener's created_at (the
   * resolving write's time). `opener` is the row when it already exists (a
   * retry after it was written); on the call that ended the review it is
   * generated in the background, so null.
   */
  | {
      resolved: true;
      opener: (MessageDTO & { stage: number }) | null;
      openerAt: string;
      /** The background generation, for callers (tests) that wait on it. */
      generation?: Promise<void>;
    };

/** How long the opener's model call may take before the template is written instead. */
function openerTimeoutMs(): number {
  return Number(process.env.PREJOIN_OPENER_TIMEOUT_MS) || 45_000;
}

/**
 * End the pending pre-join review by the author's "Edit first" and schedule
 * the AI's opener in their own conversation. Returns at once: the model call
 * runs in the background (the client's request timeout is shorter than a slow
 * model call). A call that finds no pending review gets the existing opener
 * back while the reopen is in effect, else nothing — it never writes one.
 */
export async function openPreJoinDraftRevision(
  params: OpenPreJoinDraftRevisionParams,
): Promise<OpenPreJoinDraftRevisionResult> {
  const resolution = await resolvePreJoinReviewForEdit(params.participantId);
  if (resolution.status !== 'resolved') {
    return (await existingReopen(params)) ?? { resolved: false, opener: null, openerAt: null };
  }

  const reopened: ReopenedPreJoinDraft = {
    content: resolution.draft.content,
    ...describeWrittenAt(resolution.writtenAt, params.now ?? new Date(), params.timeZone),
  };
  const openerAt = resolution.draft.updatedAt;
  const generation = writeOpener(params, reopened, openerAt).catch((err: unknown) => {
    logger.error('[openPreJoinDraftRevision] Failed to write the opener:', err);
  });
  return { resolved: true, opener: null, openerAt: openerAt.toISOString(), generation };
}

/** A retry after the opener was written: the reopen is in effect; hand back the opener. */
async function existingReopen(params: OpenPreJoinDraftRevisionParams): Promise<OpenPreJoinDraftRevisionResult | null> {
  const partners = await prisma.participant.findMany({
    where: { sessionId: params.sessionId, id: { not: params.participantId }, kind: 'human', leftAt: null },
    select: { id: true },
  });
  if (partners.length !== 1) return null;
  const draft = await prisma.draft.findFirst({
    where: { participantId: params.participantId, kind: 'EMPATHY', aboutParticipantId: partners[0].id },
    select: { updatedAt: true },
  });
  if (!draft) return null;
  const opener = await findReopenOpener(params.mainConversationId, draft.updatedAt);
  if (!opener) return null;
  return {
    resolved: true,
    opener: await messageDTO(opener, params.sessionId, params.participantId),
    openerAt: draft.updatedAt.toISOString(),
  };
}

/** The model's opener, bounded by openerTimeoutMs; null on a timeout or an empty reply. */
async function generateOpener(
  params: OpenPreJoinDraftRevisionParams,
  reopened: ReopenedPreJoinDraft,
): Promise<string | null> {
  // The participant's own conversation, summary-aware (as the invitation opener).
  const summary = await getSessionSummary(params.sessionId, params.userId);
  const boundary = summary?.summary.newestMessageAt;
  const historyDesc = await listConversationMessages({
    conversationId: params.mainConversationId,
    limit: boundary ? 29 : 19,
    order: 'desc',
    newerThan: boundary,
  });
  const history = historyDesc
    .slice()
    .reverse()
    .filter(m => m.content && m.content.trim().length > 0)
    .map(m => ({
      role: m.role === 'USER' && m.kind === 'CHAT' ? ('user' as const) : ('assistant' as const),
      content: m.content,
    }));
  const turnCount = await countOwnTurns(params.mainConversationId, params.participantId);
  const aiContext: FullAIContext = {
    sessionId: params.sessionId,
    userId: params.userId,
    turnId: `${params.sessionId}-${params.userId}-prejoin-edit-first`,
    userName: params.userName,
    partnerName: params.partnerName,
    stage: 2,
    turnCount,
    emotionalIntensity: 5,
    sessionDurationMinutes: 0,
    isFirstTurnInSession: false,
    // The draft rides in the REOPENED DRAFT section only (not CURRENT EMPATHY DRAFT).
    reopenedPreJoinDraft: reopened,
    topicFrame: params.topicFrame ?? undefined,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      logger.warn('[openPreJoinDraftRevision] Opener generation timed out; writing the template');
      resolve(null);
    }, openerTimeoutMs());
  });
  try {
    const result = await Promise.race([
      getOrchestratedResponse([...history, { role: 'user' as const, content: EDIT_FIRST_TRIGGER }], aiContext),
      timeout,
    ]);
    return result?.response?.trim() || null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Write the opener — the model's, else the fixed template, so the author is
 * never left in a silent chat — at `openerAt`, then the private Ably notice.
 */
async function writeOpener(
  params: OpenPreJoinDraftRevisionParams,
  reopened: ReopenedPreJoinDraft,
  openerAt: Date,
): Promise<void> {
  let content: string | null = null;
  try {
    content = await generateOpener(params, reopened);
  } catch (err) {
    logger.error('[openPreJoinDraftRevision] Opener generation failed; writing the template:', err);
  }
  if (!content) content = buildReopenedPreJoinDraftFallback(reopened);

  // Only the call that ended the review gets here; this guards a second write regardless.
  if (await findReopenOpener(params.mainConversationId, openerAt)) return;
  const stored = await createFacilitatorMessage({
    conversationId: params.mainConversationId,
    content,
    createdAt: openerAt,
  });
  const opener = await messageDTO(stored, params.sessionId, params.participantId);
  await publishMessageAIResponse(params.sessionId, params.userId, opener).catch((err: unknown) =>
    logger.warn('[openPreJoinDraftRevision] Ably notice failed:', err),
  );
}
