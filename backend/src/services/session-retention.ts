/**
 * Session Retention
 *
 * Enforces the two-tier session decay policy for MWF conflict-resolution
 * sessions. Runs as the JOB (`mwf_job`; TS-12, R35 — retention is job work):
 *
 *   - `ACTIVE` sessions with no activity for 90 days → ended. The target's
 *     transition set (spec §1.1 session; `app.session_set_status`) has no
 *     ACTIVE → ARCHIVED: a stale session is ABANDONED, then ARCHIVED, in one
 *     transaction. Users can still read their own history (the rows remain)
 *     but the session takes no new turns.
 *   - `ARCHIVED` sessions untouched for another 90 days (180 days total) →
 *     hard-deleted. Every child FKs `session` ON DELETE CASCADE (spec
 *     Conventions: "→ session: CASCADE (retention hard-deletes whole
 *     sessions)"); `user` rows are never touched (FK RESTRICT; P3 D9).
 *
 * Activity is the latest message in any of the session's conversations,
 * else the session's own `updated_at`. Scheduling is the deploy's (see
 * `scripts/sweep-session-retention.ts`).
 */

import { getJobPrisma } from '../lib/prisma';
import { logger } from '../lib/logger';

// Policy constants — exported for tests and ops observability.
export const ACTIVE_SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const ARCHIVED_SESSION_PURGE_MS = 90 * 24 * 60 * 60 * 1000; // 90d after archive → 180d total

export interface SessionRetentionResult {
  /** Sessions moved ACTIVE → ABANDONED → ARCHIVED on this run. */
  archived: number;
  /** Sessions hard-deleted (status ARCHIVED, untouched for the purge window). */
  deleted: number;
  /** Number of ACTIVE sessions we inspected. */
  inspected: number;
}

/**
 * Run the session retention policy once. Idempotent — safe to call multiple
 * times; an ARCHIVED session stays put, a deleted one cannot reappear.
 *
 * `now` is injectable for testing.
 */
export async function enforceSessionRetention(now: Date = new Date()): Promise<SessionRetentionResult> {
  const job = getJobPrisma();
  const archiveCutoff = new Date(now.getTime() - ACTIVE_SESSION_RETENTION_MS);
  const deleteCutoff = new Date(now.getTime() - ARCHIVED_SESSION_PURGE_MS);

  // ----- Archive phase -----
  // Pre-filter with `updated_at` (cheap): a session touched in the last 90d
  // cannot be stale. Then confirm with the latest message of any of its
  // conversations — message writes do not touch session.updated_at.
  const staleCandidates = await job.$queryRaw<Array<{ id: string; last_activity: Date }>>`SELECT s.id,
           coalesce((SELECT max(m.created_at) FROM message m
                     JOIN conversation c ON c.id = m.conversation_id
                     JOIN participant p ON p.id = c.participant_id
                     WHERE p.session_id = s.id), s.updated_at) AS last_activity
    FROM session s
    WHERE s.status = 'ACTIVE' AND s.updated_at < ${archiveCutoff}`;

  let archived = 0;
  for (const candidate of staleCandidates) {
    if (new Date(candidate.last_activity) >= archiveCutoff) continue;
    await job.$transaction(async tx => {
      await tx.$executeRaw`SELECT app.session_set_status(${candidate.id}::uuid, 'ABANDONED'::session_status)`;
      await tx.$executeRaw`SELECT app.session_set_status(${candidate.id}::uuid, 'ARCHIVED'::session_status)`;
    });
    archived++;
  }

  // ----- Hard-delete phase -----
  // ARCHIVED long enough ago that the soft-retention window is up (the
  // archive's status write stamped updated_at). The cascade removes the
  // session's participants, conversations, messages, keys and every other
  // session-scoped row in the same statement.
  const deleted = await job.$executeRaw`DELETE FROM session WHERE status = 'ARCHIVED' AND updated_at < ${deleteCutoff}`;

  const result: SessionRetentionResult = {
    archived,
    deleted,
    inspected: staleCandidates.length,
  };

  logger.info('[SessionRetention] Retention policy enforced', {
    ...result,
    archiveCutoff: archiveCutoff.toISOString(),
    deleteCutoff: deleteCutoff.toISOString(),
  });

  return result;
}
