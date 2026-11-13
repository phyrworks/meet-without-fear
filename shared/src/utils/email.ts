/**
 * The case and normalization fold of an email address or a fragment of one:
 * lowercase by full Unicode case mapping, final sigma ς folded to σ (Σ, σ and ς
 * are one letter; toLowerCase writes ς only at a word end), then NFC
 * (RFC 6532 §3.1: NFC, never NFKC). NFC comes LAST: lowercasing an NFC string
 * can un-normalize it ('J̌' → j + U+030C, whose NFC is U+01F0).
 *
 * Not trimmed, so a search fragment folds the same way and still matches as a
 * substring (routes/brain.ts).
 */
export function foldEmail(s: string): string {
  return s.toLowerCase().replace(/\u03C2/g, '\u03C3').normalize('NFC');
}

/**
 * The canonical form of an email address (work-k5fk.5): trimmed, then
 * foldEmail(). `user.email` stores exactly this form — the database's
 * `email` domain (CHECK email_canonical) refuses anything else rather than
 * rewriting it — so every writer AND every lookup must pass an address through
 * here first.
 *
 * Case is the only equivalence: a plus-address, Gmail's dots, an accent, ß, a
 * fullwidth form or another script's digit are kept as they are.
 *
 * `toLowerCase()` is locale-independent full case mapping ('İ' → 'i̇'), the same
 * as PostgreSQL's lower() under pg_unicode_fast, which the CHECK uses.
 */
export function canonicalEmail(s: string): string {
  return foldEmail(s.trim());
}
