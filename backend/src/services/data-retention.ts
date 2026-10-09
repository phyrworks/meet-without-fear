/**
 * Data Retention Service
 *
 * Enforces retention policies for telemetry and diagnostic data.
 * BrainActivity records store full LLM prompts/outputs which are expensive
 * to retain indefinitely and contain sensitive conversation content.
 *
 * Retention policy:
 * - BrainActivity: 30 days (keeps stats, purges input/output blobs)
 * - Full deletion after 90 days
 */

import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export const RETENTION_POLICY = {
  /** Days after which input/output blobs are nullified (keep stats) */
  brainActivityPurgeDays: 30,
  /** Days after which records are fully deleted */
  brainActivityDeleteDays: 90,
};

export interface RetentionResult {
  blobsPurged: number;
  recordsDeleted: number;
}

/**
 * Run the data retention policy.
 * Safe to call multiple times — idempotent.
 *
 * Phase 1: Nullify input/output/metadata blobs on records older than purgeDays
 * Phase 2: Delete records entirely older than deleteDays
 */
export async function enforceDataRetention(): Promise<RetentionResult> {
  const purgeDate = new Date();
  purgeDate.setDate(purgeDate.getDate() - RETENTION_POLICY.brainActivityPurgeDays);

  const deleteDate = new Date();
  deleteDate.setDate(deleteDate.getDate() - RETENTION_POLICY.brainActivityDeleteDays);

  // Phase 1: Purge blobs (keep record for cost/usage stats)
  const purgeResult = await prisma.brainActivity.updateMany({
    where: {
      createdAt: { lt: purgeDate },
      // Only purge records that still have blobs
      OR: [
        { input: { not: Prisma.DbNull } },
        { output: { not: Prisma.DbNull } },
        { metadata: { not: Prisma.DbNull } },
        { structuredOutput: { not: Prisma.DbNull } },
      ],
    },
    data: {
      input: Prisma.DbNull,
      output: Prisma.DbNull,
      metadata: Prisma.DbNull,
      structuredOutput: Prisma.DbNull,
    },
  });

  // Phase 2: Delete old records entirely
  const deleteResult = await prisma.brainActivity.deleteMany({
    where: {
      createdAt: { lt: deleteDate },
    },
  });

  logger.info('[DataRetention] Retention policy enforced', {
    blobsPurged: purgeResult.count,
    recordsDeleted: deleteResult.count,
    purgeCutoff: purgeDate.toISOString(),
    deleteCutoff: deleteDate.toISOString(),
  });

  return {
    blobsPurged: purgeResult.count,
    recordsDeleted: deleteResult.count,
  };
}
