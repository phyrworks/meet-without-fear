/**
 * Per-role database connection URLs (Phase 3 W0; design note §6 "Roles").
 *
 * Each runtime role gets its own URL, so a code path connects as the role it
 * is entitled to:
 *
 *   APP_DATABASE_URL     HTTP requests (mwf_app)
 *   AI_DATABASE_URL      the AI: reconciler, facilitator lines, summaries, telemetry (mwf_ai)
 *   WORKER_DATABASE_URL  scheduled jobs, notification delivery, the Stage 4 closure (mwf_worker)
 *   OPS_DATABASE_URL     /api/brain/* (mwf_ops)
 *   AUTH_DATABASE_URL    sign-in lookup and first-login creation (mwf_auth)
 *
 * APP and AUTH fall back to DATABASE_URL when unset or empty (the role guard
 * refuses a privileged fallback at startup). OPS, AI and WORKER fail closed:
 * never the root URL (TS-12 for the read-only dashboard; work-k5fk.10.5 for the
 * AI and the worker, whose grants are narrow by design and which must never run
 * as the migration/root role). DATABASE_URL itself stays the migration/root URL
 * (prisma.config.ts, deploy.sh). JOB_DATABASE_URL (mwf_job) is retired with its
 * login (work-k5fk.10.5).
 */
import { z } from 'zod';

export const DATABASE_URL_VARS = {
  app: 'APP_DATABASE_URL',
  ai: 'AI_DATABASE_URL',
  worker: 'WORKER_DATABASE_URL',
  ops: 'OPS_DATABASE_URL',
  auth: 'AUTH_DATABASE_URL',
} as const;

export type DatabaseRole = keyof typeof DATABASE_URL_VARS;

const urlSchema = z.string().url();

/** The roles whose URL never falls back to DATABASE_URL. */
export const FAIL_CLOSED: ReadonlySet<DatabaseRole> = new Set<DatabaseRole>(['ops', 'ai', 'worker']);

/** Pure: the URL the given role connects with, or undefined if none is configured. */
export function databaseUrlFor(
  role: DatabaseRole,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const variable = DATABASE_URL_VARS[role];
  const own = env[variable];
  if (own !== undefined && own !== '') {
    if (!urlSchema.safeParse(own).success) {
      throw new Error(`${variable} is not a valid URL`);
    }
    return own;
  }
  // TS-12 fix round 1 (M13): the ops role is the read-only dashboard; DATABASE_URL is the
  // migration/root URL. Falling back would silently drop the read-only role, so ops fails closed.
  // work-k5fk.10.5: so do the AI and the worker.
  if (FAIL_CLOSED.has(role)) return undefined;
  return env.DATABASE_URL || undefined;
}
