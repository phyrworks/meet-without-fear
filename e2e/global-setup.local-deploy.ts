/**
 * Global setup for the local production replica (playwright.local-deploy.config.ts).
 *
 * The replica is already running (infra/local/up.sh) and its schema is the
 * deployed baseline, so nothing here migrates, pushes or truncates: the suite
 * owns only the synthetic *@e2e.test users, and removes them through the API's
 * E2E endpoint on the replica's origin. No database connection is opened.
 */
import type { FullConfig } from '@playwright/test';

export const LOCAL_ORIGIN = process.env.MWF_LOCAL_ORIGIN || 'http://127.0.0.1:18180';

async function globalSetup(_config: FullConfig): Promise<void> {
  console.log(`\nE2E (local replica) global setup against ${LOCAL_ORIGIN}`);
  const health = await fetch(`${LOCAL_ORIGIN}/health`, { signal: AbortSignal.timeout(5000) }).catch((e: Error) => e);
  if (health instanceof Error || !health.ok) {
    throw new Error(
      `The local replica is not answering at ${LOCAL_ORIGIN}/health — run infra/local/up.sh first ` +
        `(${health instanceof Error ? health.message : `HTTP ${health.status}`})`,
    );
  }
  const r = await fetch(`${LOCAL_ORIGIN}/api/e2e/cleanup`, { method: 'POST', signal: AbortSignal.timeout(60000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`POST /api/e2e/cleanup failed: HTTP ${r.status} ${body.slice(0, 300)}`);
  console.log(`  cleanup: ${body}`);
}

export default globalSetup;
