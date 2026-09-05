/**
 * Content Hashing for Encrypted Columns
 *
 * Field encryption is non-deterministic: `encrypt()` draws a fresh random IV per
 * write, so the same plaintext produces a different ciphertext every time. That
 * makes `where: { content: <plaintext> }` — and equality on the ciphertext —
 * useless for deduplication once encryption is on.
 *
 * The workaround is a companion column holding a deterministic digest of the
 * PLAINTEXT. Probes match on the digest; the content itself stays encrypted.
 *
 * This is a dedupe/equality key, not a security primitive. It is unsalted, so
 * two rows with identical plaintext are visibly identical, and a known candidate
 * string can be confirmed present. Only use it for content the application
 * itself generates (fixed system/AI copy), never for user-authored text.
 */

import crypto from 'crypto';

/**
 * SHA-256 hex digest of a plaintext string. 64 lowercase hex characters.
 */
export function contentHash(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}
