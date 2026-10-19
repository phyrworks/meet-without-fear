/**
 * Per-role database connection URLs (Phase 3 W0).
 *
 * Each runtime role gets its own URL so that, once the roles carry different
 * privileges, a code path connects as the role it is entitled to:
 *
 *   APP_DATABASE_URL   HTTP requests (mwf_app)
 *   JOB_DATABASE_URL   background jobs, two-party paths (mwf_job)
 *   OPS_DATABASE_URL   /api/brain/* (mwf_ops)
 *   AUTH_DATABASE_URL  first-login user creation (mwf_auth)
 *
 * Every one falls back to DATABASE_URL when unset or empty, so a deployment
 * that sets only DATABASE_URL behaves exactly as before. DATABASE_URL itself
 * stays the migration/root URL (prisma.config.ts, deploy.sh).
 *
 * Only the app role is wired today (lib/prisma.ts). Moving job, brain and
 * auth paths onto their URLs is W4a/W10.
 */
import { z } from 'zod';

export const DATABASE_URL_VARS = {
  app: 'APP_DATABASE_URL',
  job: 'JOB_DATABASE_URL',
  ops: 'OPS_DATABASE_URL',
  auth: 'AUTH_DATABASE_URL',
} as const;

export type DatabaseRole = keyof typeof DATABASE_URL_VARS;

const urlSchema = z.string().url();

/** Pure: the URL the given role connects with, or undefined if none is configured. */
export function databaseUrlFor(
  role: DatabaseRole,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const variable = DATABASE_URL_VARS[role];
  const own = env[variable];
  if (own !== undefined && own !== '') {
    if (!urlSchema.safeParse(own).success) {
      throw new Error(`${variable} is not a valid URL`);
    }
    return own;
  }
  return env.DATABASE_URL || undefined;
}
