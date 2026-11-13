/**
 * The canonical form of an email address (work-k5fk.5): trimmed,
 * NFC-normalized (RFC 6532 §3.1: NFC, never NFKC), then lowercased by full
 * Unicode case mapping. `user.email` stores exactly this form — the database's
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
  return s.trim().normalize('NFC').toLowerCase();
}
