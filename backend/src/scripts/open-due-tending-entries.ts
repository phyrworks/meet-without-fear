/**
 * Open Due Tending Entries
 *
 * CLI entrypoint for scheduled check-ins (TS-11: on `follow_up`). Runs as the
 * JOB: both writers use the job connection (JOB_DATABASE_URL = mwf_job) and
 * find their work by the partial indexes — sql_follow_up_due (SCHEDULED by
 * scheduled_for) and sql_reminder_due (SCHEDULED reminders by remind_at).
 * Invoke via:
 *   npx tsx src/scripts/open-due-tending-entries.ts
 */

import { openDueTendingEntries, processDueTendingReminders } from '../services/tending.service';

async function main(): Promise<void> {
  const [entries, reminders] = await Promise.all([
    openDueTendingEntries(),
    processDueTendingReminders(),
  ]);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, entries, reminders }, null, 2));
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[open-due-tending-entries] failed:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
