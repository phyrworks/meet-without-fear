/**
 * work-9309: "Edit first" on a pre-join empathy draft — the AI opens the
 * revision conversation.
 *
 * Owner decision 2026-11-07: after the partner joins, the inviter reviews the
 * draft they wrote before the join (work-99k2). On "Edit first" the AI speaks
 * FIRST, in the author's own conversation: "Here's what you wrote <day>.
 * Reading it now, what feels different?" The author then revises with the
 * AI's coaching and shares through the normal Review/Share flow.
 *
 * Mechanism: the same proactive-turn path as the invitation-confirm opener
 * (sessions.ts confirmInvitationMessage) — getOrchestratedResponse with the
 * participant's own history and a bracketed trigger line that is never
 * stored, then one facilitator message into their MAIN conversation. The
 * prompt is the regular Stage 2 prompt plus its REOPENED DRAFT section
 * (stage-prompts.ts buildReopenedPreJoinDraftSection).
 *
 *   - Once per Edit first: resolvePreJoinReviewForEdit ends the review under
 *     a row lock; only the call that ended it writes the opener. A retry, a
 *     second tap, a reload or another device finds nothing pending and writes
 *     nothing.
 *   - Private: the opener goes into the author's conversation only; the Ably
 *     notice carries the message id, never its text (publishMessageAIResponse).
 *   - Never a statement: the turn is ReadyShare:N by prompt and by code
 *     (orchestrator), and this path never writes the draft beyond the
 *     resolving write.
 */

import type { MessageDTO } from '@meet-without-fear/shared';
import { logger } from '../lib/logger';
import { getOrchestratedResponse, type FullAIContext } from './ai';
import { getSessionSummary } from './conversation-summarizer';
import { resolvePreJoinReviewForEdit } from './empathy-draft-save';
import { messageDTO } from './empathy-messages';
import { createFacilitatorMessage, listConversationMessages, countOwnTurns } from './message-store';
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
  | { resolved: false; opener: null }
  | { resolved: true; opener: (MessageDTO & { stage: number }) | null };

/**
 * End the pending pre-join review by the author's "Edit first" and write the
 * AI's opener into their own conversation. `resolved: false` when no review
 * was pending: nothing is written.
 */
export async function openPreJoinDraftRevision(
  params: OpenPreJoinDraftRevisionParams,
): Promise<OpenPreJoinDraftRevisionResult> {
  const resolution = await resolvePreJoinReviewForEdit(params.participantId);
  if (resolution.status !== 'resolved') return { resolved: false, opener: null };

  const reopened: ReopenedPreJoinDraft = {
    content: resolution.draft.content,
    ...describeWrittenAt(resolution.writtenAt, params.now ?? new Date(), params.timeZone),
  };

  // From here the review is ended; the opener is best effort, falling back to
  // the fixed template so the author is never left in a silent chat.
  let content = buildReopenedPreJoinDraftFallback(reopened);
  try {
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
    const turnId = `${params.sessionId}-${params.userId}-prejoin-edit-first`;
    const aiContext: FullAIContext = {
      sessionId: params.sessionId,
      userId: params.userId,
      turnId,
      userName: params.userName,
      partnerName: params.partnerName,
      stage: 2,
      turnCount,
      emotionalIntensity: 5,
      sessionDurationMinutes: 0,
      isFirstTurnInSession: false,
      currentEmpathyDraft: reopened.content,
      reopenedPreJoinDraft: reopened,
      topicFrame: params.topicFrame ?? undefined,
    };
    const result = await getOrchestratedResponse(
      [...history, { role: 'user' as const, content: EDIT_FIRST_TRIGGER }],
      aiContext,
    );
    if (result.response?.trim()) content = result.response.trim();
  } catch (err) {
    logger.error('[openPreJoinDraftRevision] Opener generation failed; using the template:', err);
  }

  let opener: (MessageDTO & { stage: number }) | null = null;
  try {
    const stored = await createFacilitatorMessage({ conversationId: params.mainConversationId, content });
    opener = await messageDTO(stored, params.sessionId, params.participantId);
    await publishMessageAIResponse(params.sessionId, params.userId, opener).catch((err: unknown) =>
      logger.warn('[openPreJoinDraftRevision] Ably notice failed:', err),
    );
  } catch (err) {
    logger.error('[openPreJoinDraftRevision] Failed to write the opener:', err);
  }
  return { resolved: true, opener };
}
