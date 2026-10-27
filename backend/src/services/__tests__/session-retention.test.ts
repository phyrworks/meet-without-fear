/**
 * Session Retention: the policy constants.
 *
 * TS-12: the Prisma-mock cases of this suite are gone. enforceSessionRetention
 * runs as the job on real tables in
 * services/__tests__/deletion-retention.target.test.ts: stale ACTIVE →
 * ABANDONED → ARCHIVED through app.session_set_status, the latest message (not
 * updated_at) decides staleness with updated_at as the fallback, the inspected
 * count, and the hard delete of a long-ARCHIVED session tree.
 */

import { ACTIVE_SESSION_RETENTION_MS, ARCHIVED_SESSION_PURGE_MS } from '../session-retention';

describe('session retention policy', () => {
  it('retention constants are 90 and 90 days (180d total soft-to-hard window)', () => {
    expect(ACTIVE_SESSION_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(ARCHIVED_SESSION_PURGE_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });
});
