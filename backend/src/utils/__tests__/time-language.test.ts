/**
 * Tests for time-language utility functions
 */

import { getTimeContext, formatMessageWithTimeContext, getRecencyGuidance } from '../time-language';

describe('time-language utilities', () => {
  // Pin the wall clock to a fixed local midday. Two reasons:
  //
  // 1. `getTimeContext` buckets via local-calendar-day (`isSameDay` uses
  //    `getDate`/`getMonth`/`getYear`). Under `new Date()` + UTC CI, any run
  //    between 00:00–04:00 UTC made `NOW - 4h` cross the previous UTC midnight,
  //    bucketing "earlier same day" content as 'yesterday'.
  //
  // 2. `getRecencyGuidance` calls `getTimeContext(t)` without passing `now`,
  //    so production code falls back to `new Date()`. Pinning only a local
  //    `NOW` constant would desync it from production's real clock. Fake
  //    timers mock `Date` globally so both sides see the same instant.
  //
  // Noon gives every `NOW - Xh` case here enough headroom to stay on the
  // same local day, in any timezone.
  const NOW = new Date('2026-04-15T12:00:00');

  beforeAll(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'setImmediate', 'setInterval'] });
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('getTimeContext', () => {
    it('should identify just_now for content < 1 hour old', () => {
      const thirtyMinutesAgo = new Date(NOW.getTime() - 30 * 60 * 1000);
      const ctx = getTimeContext(thirtyMinutesAgo.toISOString(), NOW);

      expect(ctx.bucket).toBe('just_now');
      expect(ctx.phrase).toBe('just now');
      expect(ctx.useRememberingLanguage).toBe(false);
    });

    it('should identify today for content earlier same day', () => {
      const fourHoursAgo = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
      const ctx = getTimeContext(fourHoursAgo.toISOString(), NOW);

      expect(ctx.bucket).toBe('today');
      expect(ctx.phrase).toBe('earlier today');
      expect(ctx.useRememberingLanguage).toBe(false);
    });

    it('should identify yesterday correctly', () => {
      const yesterday = new Date(NOW);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(12, 0, 0, 0);
      const ctx = getTimeContext(yesterday.toISOString(), NOW);

      expect(ctx.bucket).toBe('yesterday');
      expect(ctx.phrase).toBe('yesterday');
      expect(ctx.useRememberingLanguage).toBe(false);
    });

    it('should identify recently for 2-6 days ago', () => {
      const fourDaysAgo = new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000);
      const ctx = getTimeContext(fourDaysAgo.toISOString(), NOW);

      expect(ctx.bucket).toBe('recently');
      expect(ctx.daysAgo).toBe(4);
      expect(ctx.useRememberingLanguage).toBe(true);
      expect(['a few days ago', 'recently', 'in the past few days']).toContain(ctx.phrase);
    });

    it('should identify last_week for 7-13 days ago', () => {
      const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
      const ctx = getTimeContext(tenDaysAgo.toISOString(), NOW);

      expect(ctx.bucket).toBe('last_week');
      expect(ctx.phrase).toBe('last week');
      expect(ctx.useRememberingLanguage).toBe(true);
    });

    it('should identify weeks_ago for 14-29 days', () => {
      const twentyDaysAgo = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000);
      const ctx = getTimeContext(twentyDaysAgo.toISOString(), NOW);

      expect(ctx.bucket).toBe('weeks_ago');
      // Could be "a couple weeks ago" or "a few weeks ago" depending on exact days
      expect(['a couple weeks ago', 'a few weeks ago']).toContain(ctx.phrase);
      expect(ctx.useRememberingLanguage).toBe(true);
    });

    it('should identify last_month for 30-59 days', () => {
      const fortyFiveDaysAgo = new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000);
      const ctx = getTimeContext(fortyFiveDaysAgo.toISOString(), NOW);

      expect(ctx.bucket).toBe('last_month');
      expect(ctx.phrase).toBe('last month');
      expect(ctx.useRememberingLanguage).toBe(true);
    });

    it('should identify months_ago for 60-179 days', () => {
      const ninetyDaysAgo = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
      const ctx = getTimeContext(ninetyDaysAgo.toISOString(), NOW);

      expect(ctx.bucket).toBe('months_ago');
      expect(ctx.useRememberingLanguage).toBe(true);
    });

    it('should identify long_ago for 180+ days', () => {
      const yearAgo = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000);
      const ctx = getTimeContext(yearAgo.toISOString(), NOW);

      expect(ctx.bucket).toBe('long_ago');
      expect(ctx.phrase).toBe('some time ago');
      expect(ctx.useRememberingLanguage).toBe(true);
    });

    it('should accept Date objects as well as strings', () => {
      const yesterday = new Date(NOW);
      yesterday.setDate(yesterday.getDate() - 1);
      const ctx = getTimeContext(yesterday, NOW);

      expect(ctx.bucket).toBe('yesterday');
    });
  });

  describe('formatMessageWithTimeContext', () => {
    it('should format today content with minimal framing when partnerName provided', () => {
      // For today (useRememberingLanguage = false), when partnerName is given but no sessionContext,
      // it still uses session context format
      const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
      const formatted = formatMessageWithTimeContext('I feel upset', twoHoursAgo.toISOString(), 'user', 'Sarah');

      // Today content - no memory language but still includes session info
      expect(formatted).toContain('User: I feel upset');
    });

    it('should format older content with time phrase', () => {
      const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
      const formatted = formatMessageWithTimeContext('I feel upset', tenDaysAgo.toISOString(), 'user', 'Sarah');

      expect(formatted).toContain('Session with Sarah');
      expect(formatted).toContain('last week');
      expect(formatted).toContain('User: I feel upset');
    });

    it('should include session context if provided', () => {
      // Very recent content with explicit session context
      const thirtyMinAgo = new Date(NOW.getTime() - 30 * 60 * 1000);
      const formatted = formatMessageWithTimeContext(
        'I understand',
        thirtyMinAgo.toISOString(),
        'assistant',
        undefined,
        'Session with John',
      );

      expect(formatted).toContain('Session with John');
      expect(formatted).toContain('AI: I understand');
    });
  });

  describe('getRecencyGuidance', () => {
    it('should return empty string for no timestamps', () => {
      const guidance = getRecencyGuidance([]);
      expect(guidance).toBe('');
    });

    it('should indicate today content needs no special framing', () => {
      const recentTimestamps = [
        new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
        new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      ];
      const guidance = getRecencyGuidance(recentTimestamps);

      // Today-only timestamps should get "very recent" guidance
      expect(guidance.toLowerCase()).toContain('recent');
    });

    it('should provide guidance for older content', () => {
      const oldTimestamps = [
        new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
      ];
      const guidance = getRecencyGuidance(oldTimestamps);

      // Should mention time language
      expect(guidance).toContain('time');
    });

    it('should handle mixed recency content', () => {
      const mixedTimestamps = [
        new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(), // 30 minutes ago
        new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
      ];
      const guidance = getRecencyGuidance(mixedTimestamps);

      // Should mention spanning different periods
      expect(guidance).toContain('spans different time periods');
    });
  });
});
