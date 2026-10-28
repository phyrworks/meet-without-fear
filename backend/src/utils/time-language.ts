/**
 * Time Language Utility
 *
 * Converts timestamps to natural, human-readable language for AI prompts.
 * Designed to help the AI understand temporal context without being formulaic.
 */

export type RecencyBucket =
  | 'just_now' // < 1 hour
  | 'today' // Same day
  | 'yesterday' // Previous day
  | 'recently' // 2-6 days ago
  | 'last_week' // 7-13 days
  | 'weeks_ago' // 14-29 days
  | 'last_month' // 30-59 days
  | 'months_ago' // 60+ days
  | 'long_ago'; // 6+ months

export interface TimeContext {
  bucket: RecencyBucket;
  daysAgo: number;
  hoursAgo: number;
  /** Human-readable phrase like "a few days ago" or "last week" */
  phrase: string;
  /** Whether to use "remembering" language in prompts */
  useRememberingLanguage: boolean;
  /** Suggested prompt framing for this time distance */
  promptGuidance: string;
}

/**
 * Convert a timestamp to natural time context.
 *
 * @param timestamp - ISO timestamp string or Date object
 * @param now - Current time (for testing), defaults to new Date()
 * @returns TimeContext with bucket, phrase, and prompt guidance
 */
export function getTimeContext(timestamp: string | Date, now: Date = new Date()): TimeContext {
  const then = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const diffMs = now.getTime() - then.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  // Determine bucket and generate natural phrasing
  if (diffHours < 1) {
    return {
      bucket: 'just_now',
      daysAgo: 0,
      hoursAgo: Math.round(diffHours * 60) / 60,
      phrase: 'just now',
      useRememberingLanguage: false,
      promptGuidance: 'This is from the current conversation or very recent. No need for temporal framing.',
    };
  }

  if (isSameDay(then, now)) {
    return {
      bucket: 'today',
      daysAgo: 0,
      hoursAgo: Math.round(diffHours),
      phrase: 'earlier today',
      useRememberingLanguage: false,
      promptGuidance: 'This is from today. Treat as current context, no memory language needed.',
    };
  }

  if (isYesterday(then, now)) {
    return {
      bucket: 'yesterday',
      daysAgo: 1,
      hoursAgo: Math.round(diffHours),
      phrase: 'yesterday',
      useRememberingLanguage: false,
      promptGuidance: 'This is from yesterday. Can reference naturally without explicit memory language.',
    };
  }

  if (diffDays < 7) {
    const daysAgo = Math.floor(diffDays);
    const phrases = ['a few days ago', 'recently', 'in the past few days'];
    return {
      bucket: 'recently',
      daysAgo,
      hoursAgo: Math.round(diffHours),
      phrase: phrases[Math.floor(Math.random() * phrases.length)],
      useRememberingLanguage: true,
      promptGuidance:
        'Recent enough that user likely remembers. Can use light framing like "recently" or "a few days ago".',
    };
  }

  if (diffDays < 14) {
    return {
      bucket: 'last_week',
      daysAgo: Math.floor(diffDays),
      hoursAgo: Math.round(diffHours),
      phrase: 'last week',
      useRememberingLanguage: true,
      promptGuidance: 'From last week. Use natural framing like "last week" or "earlier this week".',
    };
  }

  if (diffDays < 30) {
    const weeksAgo = Math.floor(diffDays / 7);
    return {
      bucket: 'weeks_ago',
      daysAgo: Math.floor(diffDays),
      hoursAgo: Math.round(diffHours),
      phrase: weeksAgo === 2 ? 'a couple weeks ago' : 'a few weeks ago',
      useRememberingLanguage: true,
      promptGuidance: 'A few weeks back. Appropriate to reference with "a few weeks ago" or similar.',
    };
  }

  if (diffDays < 60) {
    return {
      bucket: 'last_month',
      daysAgo: Math.floor(diffDays),
      hoursAgo: Math.round(diffHours),
      phrase: 'last month',
      useRememberingLanguage: true,
      promptGuidance: 'From about a month ago. Can frame as "last month" or "about a month ago".',
    };
  }

  if (diffDays < 180) {
    const monthsAgo = Math.floor(diffDays / 30);
    return {
      bucket: 'months_ago',
      daysAgo: Math.floor(diffDays),
      hoursAgo: Math.round(diffHours),
      phrase: monthsAgo === 2 ? 'a couple months ago' : 'a few months ago',
      useRememberingLanguage: true,
      promptGuidance: 'Several months back. Use "a few months ago" or "some time ago".',
    };
  }

  // 6+ months
  return {
    bucket: 'long_ago',
    daysAgo: Math.floor(diffDays),
    hoursAgo: Math.round(diffHours),
    phrase: 'some time ago',
    useRememberingLanguage: true,
    promptGuidance: 'From a long time ago. Frame carefully - user may not recall details.',
  };
}

/**
 * Format a message with its time context for AI prompts.
 *
 * @param content - The message content
 * @param timestamp - When the message was sent
 * @param role - Who sent the message (user or AI)
 * @param partnerName - Name of the partner (for session context)
 * @param sessionContext - Optional session context like "Session with [partner]"
 * @returns Formatted string with appropriate temporal context
 */
export function formatMessageWithTimeContext(
  content: string,
  timestamp: string | Date,
  role: 'user' | 'assistant',
  partnerName?: string,
  sessionContext?: string,
): string {
  const timeCtx = getTimeContext(timestamp);
  const speaker = role === 'user' ? 'User' : 'AI';

  // For very recent content (today/yesterday), minimal framing
  if (!timeCtx.useRememberingLanguage) {
    if (sessionContext) {
      return `[${sessionContext}]\n${speaker}: ${content}`;
    }
    return `${speaker}: ${content}`;
  }

  // For older content, include time context
  const sessionInfo = sessionContext || (partnerName ? `Session with ${partnerName}` : 'Previous session');
  return `[${sessionInfo}, ${timeCtx.phrase}]\n${speaker}: ${content}`;
}

/**
 * Get AI prompt guidance for a set of retrieved messages based on their recency.
 *
 * @param timestamps - Array of timestamps from retrieved messages
 * @returns Guidance string for how to reference this content in the prompt
 */
export function getRecencyGuidance(timestamps: (string | Date)[]): string {
  if (timestamps.length === 0) {
    return '';
  }

  const contexts = timestamps.map(t => getTimeContext(t));
  const buckets = new Set(contexts.map(c => c.bucket));

  // If all content is from today/yesterday, no special guidance needed
  if (buckets.size === 1 && (buckets.has('just_now') || buckets.has('today') || buckets.has('yesterday'))) {
    return 'This context is very recent - reference naturally without memory language.';
  }

  // If there's a mix, provide nuanced guidance
  const hasRecent = buckets.has('just_now') || buckets.has('today') || buckets.has('yesterday');
  const hasOld =
    buckets.has('weeks_ago') || buckets.has('last_month') || buckets.has('months_ago') || buckets.has('long_ago');

  if (hasRecent && hasOld) {
    return 'Context spans different time periods. Recent content can be referenced naturally, older content should use appropriate time framing like "a few weeks ago" or "some time back".';
  }

  if (hasOld) {
    const oldest = contexts.reduce((a, b) => (a.daysAgo > b.daysAgo ? a : b));
    return `This content is from ${oldest.phrase}. If referencing, use natural time language. Don't force connections if the user doesn't bring it up.`;
  }

  return 'Recent context - can be referenced naturally.';
}

// ============================================================================
// Helpers
// ============================================================================

function isSameDay(d1: Date, d2: Date): boolean {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

function isYesterday(then: Date, now: Date): boolean {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return isSameDay(then, yesterday);
}
