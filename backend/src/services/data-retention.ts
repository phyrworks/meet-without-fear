/**
 * Data Retention Service — brain_activity (TS-12; spec §1.8 telemetry,
 * "short retention instead — P3 §7").
 *
 * `brain_activity` stores full LLM prompts and outputs. It has no `mwf_app`
 * grant at all: the JOB writes it at capture and runs this sweep (R35); the
 * ops dashboard reads it as `mwf_ops`.
 *
 * Retention policy:
 * - rows with no session (reflection turns, standalone features): their
 *   input/output blobs are purged within days (spec §1.8: "input/output … under
 *   the session key where session_id is set, else purged within days");
 * - session rows: blobs purged after 30 days (keep the stats row);
 * - every row: deleted after 90 days.
 *
 * The purge sets the four blobs NULL on every row past its window: the job
 * holds no SELECT on the blob columns (it never reads a prompt), so the WHERE
 * cannot ask whether a blob is still there. Re-purging an already-purged row
 * is a no-op write.
 */

import { getJobPrisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export const RETENTION_POLICY = {
  /** Days after which a row WITHOUT a session loses its input/output blobs */
  sessionlessBlobPurgeDays: 7,
  /** Days after which input/output blobs are nullified (keep stats) */
  brainActivityPurgeDays: 30,
  /** Days after which records are fully deleted */
  brainActivityDeleteDays: 90,
};

export interface RetentionResult {
  blobsPurged: number;
  recordsDeleted: number;
}

const daysAgo = (now: Date, days: number): Date => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

/**
 * Run the data retention policy (idempotent).
 *
 * Phase 1: Nullify input/output/metadata/structured_output past the purge windows
 * Phase 2: Delete records older than deleteDays
 */
export async function enforceDataRetention(now: Date = new Date()): Promise<RetentionResult> {
  const job = getJobPrisma();
  const sessionlessCutoff = daysAgo(now, RETENTION_POLICY.sessionlessBlobPurgeDays);
  const purgeDate = daysAgo(now, RETENTION_POLICY.brainActivityPurgeDays);
  const deleteDate = daysAgo(now, RETENTION_POLICY.brainActivityDeleteDays);

  // Phase 1: Purge blobs (keep the row for cost/usage stats)
  const blobsPurged = await job.$executeRaw`UPDATE brain_activity
    SET input = NULL, output = NULL, metadata = NULL, structured_output = NULL
    WHERE created_at >= ${deleteDate}
      AND (created_at < ${purgeDate} OR (session_id IS NULL AND created_at < ${sessionlessCutoff}))`;

  // Phase 2: Delete old records entirely
  const recordsDeleted = await job.$executeRaw`DELETE FROM brain_activity WHERE created_at < ${deleteDate}`;

  logger.info('[DataRetention] Retention policy enforced', {
    blobsPurged,
    recordsDeleted,
    sessionlessCutoff: sessionlessCutoff.toISOString(),
    purgeCutoff: purgeDate.toISOString(),
    deleteCutoff: deleteDate.toISOString(),
  });

  return { blobsPurged, recordsDeleted };
}
