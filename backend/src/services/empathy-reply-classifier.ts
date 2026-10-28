/**
 * Empathy Reply Classifier
 *
 * Classifies a user's free-text reply to an empathy attempt into one of
 * three intents: accept, revise, or decline. Used by the Stage 2B flow over
 * Slack where we can't offer Block Kit buttons in long-idle async sessions.
 *
 * Why Haiku over a regex/keyword heuristic:
 * - Humans rarely pick cleanly. "Acceptable, but I really want to emphasize
 *   that I was also scared" should classify as `revise` with the qualifier
 *   captured as the `correction` payload, not as `accept` because the first
 *   word was "Acceptable".
 * - "That's not how I'd put it — try again?" is `revise` but contains no
 *   keyword; "Close, but actually I was more disappointed than angry" is
 *   `revise` with a very specific correction hint.
 * - Haiku adds ~200–300ms on top of the existing turn — negligible
 *   against the Sonnet call (3–8s) that follows.
 *
 * Why not Block Kit buttons:
 * - Async long-running sessions + button expiry = race conditions when a
 *   user clicks an old button after the state has already moved on.
 * - Clicks-that-lose-nuance: users naturally want to qualify their accept
 *   with "yes, but…" which pure buttons throw away.
 */

import { getHaikuJson, BrainActivityCallType } from '../lib/bedrock';
import { logger } from '../lib/logger';

export type EmpathyReplyIntent = 'accept' | 'revise' | 'decline';

export interface EmpathyReplyClassification {
  /** Primary intent of the user's reply. */
  intent: EmpathyReplyIntent;
  /**
   * When intent === 'revise', the user's qualifier / correction if any.
   * Plain text the Stage 2B refinement prompt can ingest as
   * `sharedContextFromPartner` equivalent. Null when the model didn't find
   * a specific correction, or when intent is 'accept' / 'decline'.
   */
  correction: string | null;
}

export interface ClassifyEmpathyValidationReplyInput {
  /** User's reply to the partner's empathy attempt. */
  replyText: string;
  /** The empathy attempt they were responding to — prompt context. */
  empathyAttempt: string;
  /** Session ID for cost attribution. */
  sessionId: string;
  /** Turn ID — the same turnId the Sonnet call for this reply will use. */
  turnId: string;
}

/**
 * Ask Haiku to classify a single free-text empathy reply. Returns a default
 * of `{ intent: 'revise', correction: null }` if Haiku is unavailable or
 * returns malformed output — "revise" is the safest ambiguous-case default
 * because it keeps the conversation moving without falsely advancing a gate.
 */
export async function classifyEmpathyValidationReply(
  input: ClassifyEmpathyValidationReplyInput,
): Promise<EmpathyReplyClassification> {
  const { replyText, empathyAttempt, sessionId, turnId } = input;

  const systemPrompt = `You classify a user's reply to an empathy attempt their partner made about their experience.

Three intents are possible:
- "accept": The user confirms the empathy lands. "Yes exactly", "that captures it", "you get it" — even with caveats that DON'T change the core understanding (e.g. "yeah, mostly").
- "revise": The user agrees in part but wants the empathy adjusted. "Close, but…", "not quite — I was more disappointed than angry", "acceptable, but I want to emphasize X". Captures any qualifier/correction as the \`correction\` field.
- "decline": The user rejects the attempt outright. "No, that's not it at all", "way off", "I don't feel understood".

When intent === "revise", extract the CORRECTION the user wants as a clean plain-text phrase (strip "close, but" / "not quite" / etc.). When the user just says "revise" or "try again" with no specifics, set \`correction\` to null.

When intent === "accept" or "decline", set \`correction\` to null.

Output strict JSON:
{
  "intent": "accept" | "revise" | "decline",
  "correction": string | null
}`;

  const userPrompt = `Partner's empathy attempt:
"${empathyAttempt}"

User's reply:
"${replyText}"

Classify.`;

  try {
    const result = await getHaikuJson<EmpathyReplyClassification>({
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 200,
      sessionId,
      turnId,
      operation: 'empathy-reply-classifier',
      callType: BrainActivityCallType.INTENT_DETECTION,
    });

    if (!result || !isValidClassification(result)) {
      logger.warn('[EmpathyReplyClassifier] Haiku returned invalid output; defaulting to revise', {
        result,
      });
      return { intent: 'revise', correction: null };
    }

    return {
      intent: result.intent,
      correction:
        typeof result.correction === 'string' && result.correction.trim().length > 0 ? result.correction.trim() : null,
    };
  } catch (err) {
    logger.warn('[EmpathyReplyClassifier] Haiku call failed; defaulting to revise:', err);
    return { intent: 'revise', correction: null };
  }
}

function isValidClassification(v: unknown): v is EmpathyReplyClassification {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    (obj.intent === 'accept' || obj.intent === 'revise' || obj.intent === 'decline') &&
    (obj.correction === null || typeof obj.correction === 'string' || obj.correction === undefined)
  );
}
