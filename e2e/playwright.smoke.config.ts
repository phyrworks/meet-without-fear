/**
 * The e2e smoke tier: the on-demand default (`npm run test:e2e`).
 *
 * Two specs on one server boot (the default config's API + web servers and
 * global setup):
 *   - single-user-journey: the one pre-join journey from a new session.
 *   - two-browser-stage-4-redesign: two users; includes "selection privacy
 *     holds while one partner is inactive" (a partner's private choices are
 *     not revealed before both share).
 *
 * Kept small on purpose: headless Chromium runs track the kernel memory growth
 * that has panicked the development Mac overnight. Everything else is in the
 * full tier (`npm run test:e2e:full`): docs/architecture/testing.md,
 * "Which tests to run when".
 */
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  projects: [
    { name: 'user-a-journey', testMatch: /single-user-journey\.spec\.ts/ },
    { name: 'two-browser-stage-4-redesign', testMatch: /two-browser-stage-4-redesign\.spec\.ts/ },
  ],
  outputDir: 'test-results/smoke/',
});
