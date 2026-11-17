/**
 * The summarizer's pure result normalisation (no database). Moved out of
 * conversation-summarizer.target.test.ts (test audit 2026-11-17), which keeps
 * everything that reads or writes ai_memory.
 */
import { normalizeSummarizationResult } from '../conversation-summarizer';

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
});
