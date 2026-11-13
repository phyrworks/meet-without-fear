import { canonicalEmail, foldEmail } from '../email';

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
    // final sigma folds to σ: ΑΣ, ασ and ας are one address
    expect(canonicalEmail('ΑΣ@x.test')).toBe('ασ@x.test');
    expect(canonicalEmail('ας@x.test')).toBe('ασ@x.test');
    expect(canonicalEmail('ασ@x.test')).toBe('ασ@x.test');
  });

  it('is idempotent', () => {
    for (const s of ['Ada@X.test', 'İ@x.test', 'Jose\u0301@x.test', 'ΑΣ@x.test', 'J\u030C@x.test', 'İ\u0316@x.test'])
      expect(canonicalEmail(canonicalEmail(s))).toBe(canonicalEmail(s));
  });

  it('normalizes AFTER lowercasing: J + U+030C becomes U+01F0, NFC and stable', () => {
    const j = canonicalEmail('J\u030C@x.test');
    expect(j).toBe('\u01F0@x.test');
    expect(j.normalize('NFC')).toBe(j);
    const i = canonicalEmail('İ\u0316@x.test');
    expect(i.normalize('NFC')).toBe(i);
    expect(i.toLowerCase()).toBe(i);
  });

  it('foldEmail folds a search fragment the same way, without trimming', () => {
    expect(foldEmail(' ADA@')).toBe(' ada@');
    expect(foldEmail('ΑΣ')).toBe('ασ');
    expect(canonicalEmail('  Ada@X.test ')).toBe(foldEmail('Ada@X.test'));
  });
});
