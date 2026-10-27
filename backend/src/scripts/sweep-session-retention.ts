/**
 * Sweep Session Retention
 *
 * CLI entrypoint for the session retention policy. Invoke via:
 *   npx tsx src/scripts/sweep-session-retention.ts
 *
 * Designed to be wired into any scheduler (Render cron, EC2 crontab, GitHub
 * Actions schedule). The policies are in `services/session-retention.ts`
 * (expired sessions) and `services/data-retention.ts` (brain_activity, spec
 * §1.8 short retention). Both run as the job (JOB_DATABASE_URL, mwf_job; TS-12).
 */

import { enforceSessionRetention } from '../services/session-retention';
import { enforceDataRetention } from '../services/data-retention';

async function main(): Promise<void> {
  const sessions = await enforceSessionRetention();
  const brainActivity = await enforceDataRetention();
  // Emit to stdout so cron hosts capture results in their log aggregation.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, ...sessions, brainActivity }, null, 2));
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[sweep-session-retention] failed:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
