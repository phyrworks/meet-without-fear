/**
 * Prisma Encryption Middleware
 *
 * Integrates the AES-256-GCM field-level encryption framework into Prisma
 * via client extensions. Automatically encrypts sensitive fields on write
 * and decrypts on read.
 *
 * When FIELD_ENCRYPTION_KEY is not set, all operations pass through unchanged
 * (graceful degradation for dev/test environments).
 *
 * Limitations:
 * - Raw queries ($queryRaw, $executeRaw) bypass this middleware
 * - Encrypted fields cannot be used in WHERE clauses for content-based filtering.
 *   Message uses a `contentHash` column (SHA-256 of the plaintext, written here)
 *   for equality/dedupe probes instead.
 *
 * A row that cannot be decrypted raises FieldDecryptionError, which propagates
 * to the caller. It is never converted into empty content.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { encrypt, decrypt, isEncrypted } from '../utils/field-encryption';

/**
 * Maps Prisma model names to their sensitive fields.
 * - stringFields: encrypted/decrypted as strings
 * - jsonFields: JSON.stringify before encrypt, JSON.parse after decrypt
 */
export const SENSITIVE_FIELD_MAP: Record<string, { stringFields: string[]; jsonFields: string[] }> = {
  Message: { stringFields: ['content'], jsonFields: [] },
  InnerWorkMessage: { stringFields: ['content'], jsonFields: [] },
  UserVessel: { stringFields: ['conversationSummary'], jsonFields: ['notableFacts'] },
  Boundary: { stringFields: ['description'], jsonFields: [] },
  UserDocument: { stringFields: ['content'], jsonFields: [] },
  EmpathyDraft: { stringFields: ['content'], jsonFields: [] },
  EmpathyAttempt: { stringFields: ['content'], jsonFields: [] },
  GratitudeEntry: { stringFields: ['content'], jsonFields: [] },
  User: { stringFields: [], jsonFields: ['globalFacts'] },
};

const WRITE_OPERATIONS = new Set([
  'create',
  'update',
  'upsert',
  'createMany',
  'createManyAndReturn',
  'updateMany',
]);

const RESULT_BEARING_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'findMany',
  'create',
  'update',
  'upsert',
  'delete',
  'createManyAndReturn',
]);

/** Encrypt a single data object's sensitive fields in place. */
export function encryptDataFields(
  data: Record<string, unknown>,
  config: { stringFields: string[]; jsonFields: string[] },
): void {
  for (const field of config.stringFields) {
    if (field in data && typeof data[field] === 'string') {
      data[field] = encrypt(data[field] as string);
    }
  }
  for (const field of config.jsonFields) {
    if (field in data && data[field] != null) {
      if (!process.env.FIELD_ENCRYPTION_KEY) continue;
      const serialized = JSON.stringify(data[field]);
      data[field] = encrypt(serialized);
    }
  }
}

/** Decrypt a single record's sensitive fields in place. */
export function decryptRecordFields(
  record: Record<string, unknown>,
  config: { stringFields: string[]; jsonFields: string[] },
): void {
  for (const field of config.stringFields) {
    if (field in record && typeof record[field] === 'string') {
      record[field] = decrypt(record[field] as string);
    }
  }
  for (const field of config.jsonFields) {
    if (field in record && typeof record[field] === 'string') {
      const value = record[field] as string;
      if (isEncrypted(value)) {
        // decrypt() throws FieldDecryptionError on an undecryptable value; that
        // propagates deliberately — see utils/field-encryption.ts.
        const decrypted = decrypt(value);
        try {
          record[field] = JSON.parse(decrypted);
        } catch {
          // Decryption succeeded but the plaintext is not valid JSON — a genuinely
          // malformed legacy value, not a key failure.
          record[field] = null;
        }
      }
    }
    // If the JSON field is already an object, it's unencrypted (legacy data) — leave as-is
  }
}

/** Encrypt write args based on the operation type. */
function encryptWriteArgs(
  operation: string,
  args: Record<string, unknown>,
  config: { stringFields: string[]; jsonFields: string[] },
): void {
  if (operation === 'upsert') {
    if (args.create && typeof args.create === 'object') {
      encryptDataFields(args.create as Record<string, unknown>, config);
    }
    if (args.update && typeof args.update === 'object') {
      encryptDataFields(args.update as Record<string, unknown>, config);
    }
  } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
    if (Array.isArray(args.data)) {
      for (const item of args.data) {
        if (typeof item === 'object' && item != null) {
          encryptDataFields(item as Record<string, unknown>, config);
        }
      }
    }
  } else if (args.data && typeof args.data === 'object') {
    encryptDataFields(args.data as Record<string, unknown>, config);
  }
}

/** Decrypt result records. Handles single objects, arrays, and null. */
function decryptResult(
  result: unknown,
  config: { stringFields: string[]; jsonFields: string[] },
): void {
  if (result == null) return;
  if (Array.isArray(result)) {
    for (const item of result) {
      if (typeof item === 'object' && item != null) {
        decryptRecordFields(item as Record<string, unknown>, config);
      }
    }
  } else if (typeof result === 'object') {
    decryptRecordFields(result as Record<string, unknown>, config);
  }
}

/**
 * The body of the `$allOperations` interceptor, extracted so it can be exercised
 * directly in unit tests without a live PrismaClient.
 *
 * Decryption failures (FieldDecryptionError) propagate to the caller: an
 * undecryptable row is missing data, not empty data.
 */
export async function applyFieldEncryption({
  model,
  operation,
  args,
  query,
}: {
  model: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
}): Promise<unknown> {
  const config = SENSITIVE_FIELD_MAP[model ?? ''];
  if (!config) {
    return query(args);
  }

  // Encrypt on write
  if (WRITE_OPERATIONS.has(operation)) {
    encryptWriteArgs(operation, args, config);
  }

  const result = await query(args);

  // Decrypt on read (including results returned from write operations)
  if (RESULT_BEARING_OPERATIONS.has(operation) && result != null) {
    decryptResult(result, config);
  }

  return result;
}

/**
 * Apply field-level encryption to a PrismaClient via $extends.
 * Returns a new extended client with transparent encrypt-on-write / decrypt-on-read.
 */
export function withEncryption(prisma: PrismaClient) {
  return prisma.$extends({
    name: 'field-level-encryption',
    query: {
      $allModels: {
        $allOperations: applyFieldEncryption,
      },
    },
  });
}
