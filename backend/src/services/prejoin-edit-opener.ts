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
 * — `awaitingRevision`, from `draft.reopened_at`.
 *
 * Mechanism: the same proactive-turn path as the invitation-confirm opener
 * (sessions.ts confirmInvitationMessage) — the request returns at once and
 * the opener is generated in the background: getOrchestratedResponse with the
 * participant's own history and a bracketed trigger line that is never
 * stored, then one facilitator message into their MAIN conversation. The
 * prompt is the regular Stage 2 prompt plus its REOPENED DRAFT section
 * (stage-prompts.ts buildReopenedPreJoinDraftSection).
 *
 *   - The reopen, durably: `draft.reopened_at` is set in the transaction that
 *     resolves the review — before any opener is generated — and cleared by
 *     the next draft write (the AI's proposal, the author's save). Awaiting
 *     revision is `reopened_at IS NOT NULL` (and no round submitted). The
 *     opener is "the first AI row at or after reopened_at".
 *   - At most one opener per Edit first: resolvePreJoinReviewForEdit ends the
 *     review under a row lock and only that call schedules the opener; the
 *     insert itself claims the draft row FOR UPDATE and re-checks for an
 *     opener (insertOpenerOnce). A retry, a second tap, a reload or another
 *     device gets the existing opener back, or none yet — never a second one.
 *   - Never silent: a model failure, an empty reply or a timeout writes the
 *     fixed template instead; a lost generation (the process died) is
 *     recovered with the template by the next Edit first or draft read once
 *     the reopen is older than the generation could take.
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
// The reopen: draft.reopened_at
// ============================================================================

/**
 * Is the author's draft reopened by Edit first and still awaiting the AI's
 * proposal? (work-9309, owner decision 2026-11-09.) `draft.reopened_at` is set
 * in the transaction that resolves the review and cleared by the next draft
 * write — the AI's proposal through the ReadyShare path (a revision, or the
 * original as is), or the author's own save (upsertDraft's DO UPDATE). Never
 * once a round is submitted.
 */
export function deriveAwaitingRevision(facts: {
  reopenedAt: Date | null | undefined;
  roundSubmitted: boolean;
}): boolean {
  return !!facts.reopenedAt && !facts.roundSubmitted;
}

/**
 * The opener of a reopen, if written: the first AI row in the author's MAIN
 * conversation at or after `reopenedAt`. (Nothing else the AI writes lands
 * there before it: the review was resolved, the author has not replied yet.)
 */
export async function findOpenerSince(conversationId: string, reopenedAt: Date): Promise<StoredMessage | null> {
  return (await prisma.message.findFirst({
    where: { conversationId, role: 'AI', kind: 'CHAT', createdAt: { gte: reopenedAt } },
    orderBy: { createdAt: 'asc' },
    select: MESSAGE_SELECT,
  })) as StoredMessage | null;
}

/** How long the opener's model call may take before the template is written instead. */
function openerTimeoutMs(): number {
  return Number(process.env.PREJOIN_OPENER_TIMEOUT_MS) || 45_000;
}

/** Beyond this, a reopen with no opener is a lost generation (the process died): recover it. */
export function staleOpenerAfterMs(): number {
  return openerTimeoutMs() + 15_000;
}

/**
 * Write `content` as the reopen's opener — at most once. The draft row is held
 * FOR UPDATE and the opener re-checked after the lock, so of two writers (the
 * background generation and a stale-reopen recovery, or two recoveries) only
 * the first writes. Nothing is written once the draft is gone (set aside).
 * Returns the opener written, or the one found.
 */
async function insertOpenerOnce(opts: {
  draftId: string;
  conversationId: string;
  reopenedAt: Date;
  content: string;
}): Promise<{ stored: StoredMessage; written: boolean } | null> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM draft WHERE id = ${opts.draftId}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    const existing = await findOpenerSince(opts.conversationId, opts.reopenedAt);
    if (existing) return { stored: existing, written: false };
    // The job connection writes the AI row (own transaction) while this one holds the lock.
    const stored = await createFacilitatorMessage({ conversationId: opts.conversationId, content: opts.content });
    return { stored, written: true };
  });
}

interface ReopenFacts {
  draftId: string;
  content: string;
  reopenedAt: Date;
}

/** The caller's reopened EMPATHY draft about their present partner (no round submitted), if any. */
async function reopenedDraftOf(sessionId: string, participantId: string): Promise<ReopenFacts | null> {
  const partners = await prisma.participant.findMany({
    where: { sessionId, id: { not: participantId }, kind: 'human', leftAt: null },
    select: { id: true },
  });
  if (partners.length !== 1) return null;
  const draft = await prisma.draft.findFirst({
    where: { participantId, kind: 'EMPATHY', aboutParticipantId: partners[0].id },
    select: { id: true, content: true, reopenedAt: true },
  });
  if (!draft?.reopenedAt) return null;
  const submitted = await prisma.empathyAttempt.count({
    where: { authorParticipantId: participantId, subjectParticipantId: partners[0].id },
  });
  if (submitted) return null;
  return { draftId: draft.id, content: draft.content, reopenedAt: draft.reopenedAt };
}

/**
 * A reopen whose opener never came (the generation was lost: the process
 * died) and is older than the generation could take: write the fixed template
 * now — at most once (insertOpenerOnce). The day it was written is no longer
 * known (the resolving write replaced it), so the template names the join:
 * "Here's what you wrote before <partner> joined". Returns the opener, or null
 * when it is not stale (the generation may still be running) or not needed.
 */
export async function recoverStaleOpener(opts: {
  sessionId: string;
  userId: string;
  participantId: string;
  conversationId: string;
  partnerName?: string;
  reopen: ReopenFacts;
  now?: Date;
}): Promise<(MessageDTO & { stage: number }) | null> {
  const now = opts.now ?? new Date();
  if (now.getTime() - opts.reopen.reopenedAt.getTime() < staleOpenerAfterMs()) return null;
  if (await findOpenerSince(opts.conversationId, opts.reopen.reopenedAt)) return null;
  const content = buildReopenedPreJoinDraftFallback({
    content: opts.reopen.content,
    writtenAtPhrase: `before ${opts.partnerName || 'your partner'} joined`,
    writtenAtDate: '',
  });
  const result = await insertOpenerOnce({
    draftId: opts.reopen.draftId,
    conversationId: opts.conversationId,
    reopenedAt: opts.reopen.reopenedAt,
    content,
  });
  if (!result) return null;
  logger.warn(
    `[recoverStaleOpener] Reopen at ${opts.reopen.reopenedAt.toISOString()} had no opener; wrote the template`,
  );
  const opener = await messageDTO(result.stored, opts.sessionId, opts.participantId);
  if (result.written) {
    await publishMessageAIResponse(opts.sessionId, opts.userId, opener).catch((err: unknown) =>
      logger.warn('[recoverStaleOpener] Ably notice failed:', err),
    );
  }
  return opener;
}

/**
 * GET /empathy/draft's side of MED-2: a stale reopen with no opener gets the
 * template now (at most once). Best effort — a failure leaves the read intact.
 */
export async function recoverStaleOpenerForRead(opts: {
  sessionId: string;
  userId: string;
  participantId: string;
  conversationId: string | null;
  partnerName?: string;
  draft: { id: string; content: string; reopenedAt?: Date | null };
}): Promise<void> {
  if (!opts.conversationId || !opts.draft.reopenedAt) return;
  try {
    await recoverStaleOpener({
      sessionId: opts.sessionId,
      userId: opts.userId,
      participantId: opts.participantId,
      conversationId: opts.conversationId,
      partnerName: opts.partnerName,
      reopen: { draftId: opts.draft.id, content: opts.draft.content, reopenedAt: opts.draft.reopenedAt },
    });
  } catch (err) {
    logger.error('[recoverStaleOpenerForRead] Failed:', err);
  }
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
  /** No reopen in effect (no review pending, no reopened draft): nothing was written. */
  | { resolved: false; opener: null; reopenedAt: null }
  /**
   * The reopen is in effect (`reopenedAt`: the marker). `opener` when already
   * written; null while it is being generated — the client waits for the
   * first AI message at or after `reopenedAt`.
   */
  | {
      resolved: true;
      opener: (MessageDTO & { stage: number }) | null;
      reopenedAt: string;
      /** The background generation (only on the call that ended the review), for tests. */
      generation?: Promise<void>;
    };

/**
 * End the pending pre-join review by the author's "Edit first" (the marker is
 * set in the same transaction) and schedule the AI's opener in their own
 * conversation. Returns at once: the model call runs in the background (the
 * client's request timeout is shorter than a slow model call). A later call
 * while the reopen is in effect gets the opener (or, still generating, none
 * — the client keeps waiting); a stale reopen with no opener is recovered
 * with the template. No call writes a second opener.
 */
export async function openPreJoinDraftRevision(
  params: OpenPreJoinDraftRevisionParams,
): Promise<OpenPreJoinDraftRevisionResult> {
  const resolution = await resolvePreJoinReviewForEdit(params.participantId);
  if (resolution.status !== 'resolved') {
    return (await existingReopen(params)) ?? { resolved: false, opener: null, reopenedAt: null };
  }

  const reopened: ReopenedPreJoinDraft = {
    content: resolution.draft.content,
    ...describeWrittenAt(resolution.writtenAt, params.now ?? new Date(), params.timeZone),
  };
  const reopen = {
    draftId: resolution.draft.id,
    content: resolution.draft.content,
    reopenedAt: resolution.draft.reopenedAt,
  };
  const generation = writeOpener(params, reopened, reopen).catch((err: unknown) => {
    logger.error('[openPreJoinDraftRevision] Failed to write the opener:', err);
  });
  return { resolved: true, opener: null, reopenedAt: reopen.reopenedAt.toISOString(), generation };
}

/** A later call while the reopen is in effect: the opener, a recovered one, or none yet. */
async function existingReopen(params: OpenPreJoinDraftRevisionParams): Promise<OpenPreJoinDraftRevisionResult | null> {
  const reopen = await reopenedDraftOf(params.sessionId, params.participantId);
  if (!reopen) return null;
  const found = await findOpenerSince(params.mainConversationId, reopen.reopenedAt);
  const opener = found
    ? await messageDTO(found, params.sessionId, params.participantId)
    : await recoverStaleOpener({
        sessionId: params.sessionId,
        userId: params.userId,
        participantId: params.participantId,
        conversationId: params.mainConversationId,
        partnerName: params.partnerName,
        reopen,
        now: params.now,
      });
  return { resolved: true, opener, reopenedAt: reopen.reopenedAt.toISOString() };
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
 * never left in a silent chat — at most once, then the private Ably notice.
 */
async function writeOpener(
  params: OpenPreJoinDraftRevisionParams,
  reopened: ReopenedPreJoinDraft,
  reopen: ReopenFacts,
): Promise<void> {
  let content: string | null = null;
  try {
    content = await generateOpener(params, reopened);
  } catch (err) {
    logger.error('[openPreJoinDraftRevision] Opener generation failed; writing the template:', err);
  }
  if (!content) content = buildReopenedPreJoinDraftFallback(reopened);

  const result = await insertOpenerOnce({
    draftId: reopen.draftId,
    conversationId: params.mainConversationId,
    reopenedAt: reopen.reopenedAt,
    content,
  });
  if (!result?.written) return;
  const opener = await messageDTO(result.stored, params.sessionId, params.participantId);
  await publishMessageAIResponse(params.sessionId, params.userId, opener).catch((err: unknown) =>
    logger.warn('[openPreJoinDraftRevision] Ably notice failed:', err),
  );
}
