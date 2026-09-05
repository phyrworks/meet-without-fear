/**
 * Encryption Service — Higher-Level Field Encryption for Prisma Models
 *
 * Provides helpers to encrypt/decrypt specified string fields on any record.
 * Integration into Prisma is handled by prisma-encryption-middleware.ts
 * via $extends — see lib/prisma-encryption-middleware.ts for the field map.
 *
 * These helpers remain available for manual encryption outside Prisma
 * (e.g. migration scripts, one-off operations).
 */

import { encrypt, decrypt } from '../utils/field-encryption';

/**
 * Encrypt specified string fields on a record, returning a shallow copy.
 * Non-string fields in the list are silently skipped.
 */
export function encryptSensitiveFields<T extends Record<string, unknown>>(
  record: T,
  fields: (keyof T)[],
): T {
  const copy = { ...record };
  for (const field of fields) {
    const value = copy[field];
    if (typeof value === 'string') {
      (copy as Record<string, unknown>)[field as string] = encrypt(value);
    }
  }
  return copy;
}

/**
 * Decrypt specified string fields on a record, returning a shallow copy.
 * Non-string fields in the list are silently skipped.
 *
 * @throws {FieldDecryptionError} if a field is in the encrypted format but cannot
 * be decrypted. This propagates deliberately — see utils/field-encryption.ts.
 */
export function decryptSensitiveFields<T extends Record<string, unknown>>(
  record: T,
  fields: (keyof T)[],
): T {
  const copy = { ...record };
  for (const field of fields) {
    const value = copy[field];
    if (typeof value === 'string') {
      (copy as Record<string, unknown>)[field as string] = decrypt(value);
    }
  }
  return copy;
}
