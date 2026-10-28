/**
 * Playwright config for the local production replica (docs/deployment/local-replica.md).
 *
 *   infra/local/up.sh && npm run e2e:local
 *
 * No webServer: the suite targets the running replica, whose single origin
 * (default http://127.0.0.1:18180, MWF_LOCAL_ORIGIN) serves both the Expo web
 * export and the API, so API_BASE_URL and APP_BASE_URL are the same URL.
 * Every spec except live-ai-* runs, in two projects:
 *   - `two-browser`: two-browser-*.spec.ts, with playwright.two-browser.config.ts's
 *     timeouts; the name matches the committed *-two-browser-darwin.png baselines;
 *   - `single`: everything else, with playwright.config.ts's timeouts.
 * Snapshots are compared, never written (updateSnapshots: 'none').
 * The replica's API runs with E2E_FIXTURE_ID=user-a-full-journey, as the main
 * config's API does; specs that need another fixture send X-E2E-Fixture-ID.
 */
import { defineConfig } from '@playwright/test';
import { LOCAL_ORIGIN } from './global-setup.local-deploy';

process.env.API_BASE_URL = LOCAL_ORIGIN;
process.env.APP_BASE_URL = LOCAL_ORIGIN;

export default defineConfig({
  testDir: './tests',
  testIgnore: /live-ai-.*\.spec\.ts/,
  timeout: 120000,
  expect: {
    timeout: 10000,
    toHaveScreenshot: { maxDiffPixels: 100, threshold: 0.2, animations: 'disabled' },
  },
  updateSnapshots: 'none',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report-local-deploy' }],
    ['json', { outputFile: 'test-results-local-deploy/results.json' }],
    ['list'],
  ],
  use: {
    browserName: 'chromium',
    baseURL: LOCAL_ORIGIN,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 375, height: 667 },
  },
  projects: [
    {
      name: 'two-browser',
      testMatch: /two-browser-.*\.spec\.ts/,
      timeout: 900000,
      expect: { timeout: 15000 },
    },
    {
      name: 'single',
      testIgnore: [/two-browser-.*\.spec\.ts/, /live-ai-.*\.spec\.ts/],
    },
  ],
  globalSetup: require.resolve('./global-setup.local-deploy'),
  outputDir: 'test-results-local-deploy/',
});
