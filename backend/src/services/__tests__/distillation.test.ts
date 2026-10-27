/**
 * Distillation Service Unit Tests — the pure halves (TS-12).
 *
 * - buildDistillationPrompt: message formatting
 * - normalizeTakeaways: defensive Haiku output normalization
 *
 * distillSession itself runs against the real target tables as mwf_app in
 * services/__tests__/reflection.target.test.ts (the Prisma-mock half of this
 * suite is gone: no suite mocks the Prisma client on the target).
 */

import { buildDistillationPrompt, normalizeTakeaways } from '../distillation';

// ============================================================================
// normalizeTakeaways
// ============================================================================

describe('normalizeTakeaways', () => {
  it('handles { takeaways: [...] } shape (primary)', () => {
    const raw = { takeaways: [{ content: 'I need space' }, { content: 'I felt unheard' }] };
    const result = normalizeTakeaways(raw);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('I need space');
  });

  it('handles top-level array fallback', () => {
    const raw = [{ content: 'I was exhausted' }, { content: 'I needed support' }];
    const result = normalizeTakeaways(raw);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('I was exhausted');
  });

  it('returns empty array for null', () => {
    expect(normalizeTakeaways(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(normalizeTakeaways(undefined)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeTakeaways({})).toEqual([]);
    expect(normalizeTakeaways([])).toEqual([]);
  });

  it('filters out items without a content string', () => {
    const raw = { takeaways: [{ content: 'Valid' }, { theme: 'only-theme' }, null, { content: 42 }] };
    const result = normalizeTakeaways(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Valid');
  });

  it('caps at 10 takeaways (hard limit)', () => {
    const raw = {
      takeaways: Array.from({ length: 15 }, (_, i) => ({ content: `Takeaway ${i + 1}` })),
    };
    const result = normalizeTakeaways(raw);
    expect(result).toHaveLength(10);
  });
});

// ============================================================================
// buildDistillationPrompt
// ============================================================================

describe('buildDistillationPrompt', () => {
  it('formats AI messages as "Journal Guide"', () => {
    const messages = [
      { role: 'AI', content: 'How are you feeling?' },
    ];
    const prompt = buildDistillationPrompt(messages);
    expect(prompt).toContain('Journal Guide');
    expect(prompt).toContain('How are you feeling?');
  });

  it('formats USER messages as "Me"', () => {
    const messages = [
      { role: 'USER', content: 'I felt really ignored today' },
    ];
    const prompt = buildDistillationPrompt(messages);
    expect(prompt).toContain('Me');
    expect(prompt).toContain('I felt really ignored today');
  });

  it('includes the rule about using the person\'s own words', () => {
    const messages = [{ role: 'USER', content: 'test' }];
    const prompt = buildDistillationPrompt(messages);
    expect(prompt.toLowerCase()).toMatch(/own words|verbatim/);
  });

  it('includes JSON output format instruction', () => {
    const messages = [{ role: 'USER', content: 'test' }];
    const prompt = buildDistillationPrompt(messages);
    expect(prompt).toContain('"takeaways"');
  });
});
