/**
 * The summarizer's pure result normalisation (no database). Moved out of
 * conversation-summarizer.target.test.ts (test audit 2026-11-17), which keeps
 * everything that reads or writes ai_memory.
 */
import { normalizeSummarizationResult } from '../conversation-summarizer';
import { logger } from '../../lib/logger';

describe('normalizeSummarizationResult', () => {
  it('coerces each field; no summary text means nothing to store', () => {
    const n = normalizeSummarizationResult({ summary: 'abcd efgh', keyThemes: 'x' });
    expect(n).toMatchObject({
      summary: 'abcd efgh',
      keyThemes: ['x'],
      emotionalJourney: '',
      lastUnresolvedThread: null,
    });
    expect(normalizeSummarizationResult({ summary: '   ' })).toBeNull();
    expect(normalizeSummarizationResult(null)).toBeNull();
  });

  it('logs what it drops (the field and the count or type, never the content) (work-k5fk.19)', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const n = normalizeSummarizationResult({
      summary: 'abcd',
      keyThemes: ['kept', 7, { secret: 'MY SECRET THEME' }],
      userNeeds: { secret: 'MY SECRET NEED' },
      agreements: ['fine'],
    });
    expect(n).toMatchObject({ keyThemes: ['kept'], userNeeds: [], agreements: ['fine'], openQuestions: [] });
    expect(warn.mock.calls.map(c => (c as unknown[])[1])).toEqual([
      { field: 'keyThemes', dropped: 2, of: 3 },
      { field: 'userNeeds', type: 'object' },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });
});
