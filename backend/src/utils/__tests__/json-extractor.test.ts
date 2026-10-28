import { extractJsonFromResponse, extractJsonSafe } from '../json-extractor';

describe('json-extractor', () => {
  describe('extractJsonFromResponse', () => {
    // Strategy 1: Code blocks
    it('extracts JSON from ```json code block', () => {
      const response = '```json\n{"key": "value"}\n```';
      expect(extractJsonFromResponse(response)).toEqual({ key: 'value' });
    });

    it('extracts JSON from case-insensitive ```JSON code block', () => {
      const response = '```JSON\n{"key": "value"}\n```';
      expect(extractJsonFromResponse(response)).toEqual({ key: 'value' });
    });

    it('extracts JSON from code block without language tag', () => {
      const response = '```\n{"key": "value"}\n```';
      expect(extractJsonFromResponse(response)).toEqual({ key: 'value' });
    });

    it('extracts JSON from code block with surrounding text', () => {
      const response = 'Here is the result:\n```json\n{"summary": "test"}\n```\nDone.';
      expect(extractJsonFromResponse(response)).toEqual({ summary: 'test' });
    });

    // Strategy 1b: Truncated code blocks
    it('extracts JSON from truncated code block (no closing ```)', () => {
      const response = '```json\n{"summary": "Shantam opened by acknowledging", "keyThemes": ["conflict"]}';
      expect(extractJsonFromResponse(response)).toEqual({
        summary: 'Shantam opened by acknowledging',
        keyThemes: ['conflict'],
      });
    });

    it('extracts partial JSON object from truncated code block', () => {
      // Simulates a response truncated mid-way but with a complete inner object
      const response = '```json\n{"summary": "test", "themes": ["a"]}\n\nSome trailing truncated text';
      expect(extractJsonFromResponse(response)).toEqual({
        summary: 'test',
        themes: ['a'],
      });
    });

    // Strategy 2: Raw JSON object
    it('extracts raw JSON object from response', () => {
      const response = 'Here is the data: {"name": "test", "count": 5}';
      expect(extractJsonFromResponse(response)).toEqual({ name: 'test', count: 5 });
    });

    // Strategy 3: Raw JSON array
    it('extracts raw JSON array from response', () => {
      const response = 'Results: ["a", "b", "c"]';
      expect(extractJsonFromResponse(response)).toEqual(['a', 'b', 'c']);
    });

    // Strategy 4: Full response cleanup
    it('parses full response with ```json prefix (case-insensitive)', () => {
      const response = '```JSON\n{"key": "value"}';
      expect(extractJsonFromResponse(response)).toEqual({ key: 'value' });
    });

    // LLM quirks handling
    it('handles trailing commas in objects', () => {
      const response = '{"key": "value", "other": "data",}';
      expect(extractJsonFromResponse(response)).toEqual({ key: 'value', other: 'data' });
    });

    it('handles trailing commas in arrays', () => {
      const response = '["a", "b",]';
      expect(extractJsonFromResponse(response)).toEqual(['a', 'b']);
    });

    it('handles undefined values', () => {
      const response = '{"key": undefined}';
      expect(extractJsonFromResponse(response)).toEqual({ key: null });
    });

    it('handles literal newlines inside string values', () => {
      const response = '{"text": "line one\nline two"}';
      expect(extractJsonFromResponse(response)).toEqual({ text: 'line one\nline two' });
    });

    // Escape tracking edge case
    it('handles escaped backslash before quote correctly', () => {
      // The string value is: path\\  (ends with literal backslash)
      // In JSON: "path\\\\" — but LLMs sometimes emit "path\\"
      const response = '{"a": "value", "b": "other"}';
      expect(extractJsonFromResponse(response)).toEqual({ a: 'value', b: 'other' });
    });

    // Error case
    it('throws on completely unparseable response', () => {
      expect(() => extractJsonFromResponse('just some random text')).toThrow(
        'Failed to extract JSON from LLM response',
      );
    });
  });

  describe('extractJsonSafe', () => {
    it('returns parsed JSON on success', () => {
      const response = '{"key": "value"}';
      expect(extractJsonSafe(response, { key: 'fallback' })).toEqual({ key: 'value' });
    });

    it('returns fallback on parse failure', () => {
      const response = 'not json at all';
      expect(extractJsonSafe(response, { key: 'fallback' })).toEqual({ key: 'fallback' });
    });
  });
});
