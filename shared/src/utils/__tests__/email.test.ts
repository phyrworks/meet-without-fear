import { canonicalEmail } from '../email';

describe('canonicalEmail', () => {
  it('trims, lowercases and NFC-normalizes', () => {
    expect(canonicalEmail('  Ada@E2E.Test ')).toBe('ada@e2e.test');
    // 'e' + U+0301 COMBINING ACUTE → U+00E9
    expect(canonicalEmail('Jose\u0301@x.test')).toBe('josé@x.test');
  });

  it('folds case only: plus, dots, ß, fullwidth and other digits are kept', () => {
    expect(canonicalEmail('A.B+tag@Gmail.com')).toBe('a.b+tag@gmail.com');
    expect(canonicalEmail('Straße@x.test')).toBe('straße@x.test');
    expect(canonicalEmail('ａ@x.test')).toBe('ａ@x.test');
    expect(canonicalEmail('a١@x.test')).not.toBe('a1@x.test');
  });

  it('uses full Unicode case mapping, locale-independent (İ → i + U+0307), as the database CHECK does', () => {
    expect(canonicalEmail('İ@x.test')).toBe('i̇@x.test');
    expect(canonicalEmail('ΑΣ@x.test')).toBe('ας@x.test');
  });

  it('is idempotent', () => {
    for (const s of ['Ada@X.test', 'İ@x.test', 'Jose\u0301@x.test', 'ΑΣ@x.test'])
      expect(canonicalEmail(canonicalEmail(s))).toBe(canonicalEmail(s));
  });
});
