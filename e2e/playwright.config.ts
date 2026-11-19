import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { E2E_API_PORT, E2E_WEB_PORT, E2E_API_URL, E2E_API_URL_IP, E2E_WEB_URL, applyE2EPortEnv } from './e2e-ports';

// Load test environment variables
dotenv.config({ path: path.resolve(__dirname, '.env.test') });
applyE2EPortEnv();

// Shared web server configurations
const webServers = (fixtureId: string) => [
  {
    // Prepare the database before the API boots (as playwright.two-browser.config.ts): Playwright starts managed
    // web servers before globalSetup, and a stale baseline is rebuilt by dropping the database, which must not
    // happen beneath a live API. globalSetup runs again afterwards as a no-op check.
    command: 'npx tsx e2e/prepare-database.ts && npm run dev:api',
    url: `${E2E_API_URL}/health`,
    reuseExistingServer: false,
    cwd: '..',
    // a rebuilt baseline (prepare-database) takes longer than a boot
    timeout: 180000,
    env: {
      ...process.env,
      E2E_AUTH_BYPASS: 'true',
      // The API honours E2E_AUTH_BYPASS only with NODE_ENV test/development/e2e
      // (backend/src/lib/e2e-bypass.ts) and refuses to start otherwise.
      NODE_ENV: 'development',
      MOCK_LLM: 'true',
      PORT: String(E2E_API_PORT),
      E2E_WEB_PORT: String(E2E_WEB_PORT),
      E2E_FIXTURE_ID: fixtureId,
    },
  },
  {
    // --no-dev forces a production-mode bundle. The dev-mode bundle ships
    // hundreds of lazy module fetches that race the test's first interaction
    // on slower hardware (CI, EC2), producing intermittent "blank page"
    // failures even after the dev server reports ready. Production-mode is
    // deterministic — single bundle, single network round-trip, then mounts.
    command: `cd ../mobile && EXPO_PUBLIC_E2E_MODE=true EXPO_PUBLIC_API_URL=${E2E_API_URL_IP} npx expo start --web --port ${E2E_WEB_PORT} --no-dev --clear`,
    url: E2E_WEB_URL,
    reuseExistingServer: false,
    timeout: 300000,
  },
];

export default defineConfig({
  testDir: './tests',
  testIgnore: /live-ai-.*\.spec\.ts/,
  timeout: 120000,
  expect: {
    timeout: 10000, // 10s for Ably events
    toHaveScreenshot: {
      maxDiffPixels: 100,
      threshold: 0.2,
      animations: 'disabled',
    },
  },
  fullyParallel: false, // Run tests sequentially to avoid DB conflicts
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: E2E_WEB_URL,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 375, height: 667 },
    trace: 'retain-on-failure',
  },
  // Projects for different test scenarios
  projects: [
    {
      name: 'user-a-journey',
      testMatch: /single-user-journey\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
    {
      name: 'partner-journey',
      testMatch: /partner-journey\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
    {
      name: 'homepage',
      testMatch: /homepage\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
    {
      name: 'share-tab-rendering',
      testMatch: /share-tab-rendering\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
    // Stage 2 Empathy: Reconciler tests
    {
      name: 'reconciler-share-accepted',
      testMatch: /stage-2-empathy\/reconciler\/gaps-detected-share-accepted\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
    {
      name: 'reconciler-share-declined',
      testMatch: /stage-2-empathy\/reconciler\/gaps-detected-share-declined\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
    {
      name: 'reconciler-share-refined',
      testMatch: /stage-2-empathy\/reconciler\/gaps-detected-share-refined\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
    {
      name: 'reconciler-no-gaps',
      testMatch: /stage-2-empathy\/reconciler\/no-gaps-proceed-directly\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
    // Stage 3-4: Complete flow test
    {
      name: 'stage-3-4-complete',
      testMatch: /stage-3-4-complete\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
    // Stage 3 needs drawer: A's needs listed, B's unshared needs never shown to A.
    {
      name: 'needs-tab-visual',
      testMatch: /needs-tab-visual\.spec\.ts/,
    },
    // Transition messages appear right after feel-heard / invitation confirmation.
    {
      name: 'transition-message-display',
      testMatch: /transition-message-display\.spec\.ts/,
    },
    // two-browser-circuit-breaker, -stage-3 and -stage-4-redesign are not
    // projects here: playwright.two-browser.config.ts matches every
    // two-browser-*.spec.ts, so listing them here ran each one twice in a full
    // e2e pass (test audit 2026-11-17, ~3 min). The smoke tier
    // (playwright.smoke.config.ts) runs -stage-4-redesign on this server setup.
  ],
  // Web server configuration
  // Each test specifies its fixture via the X-E2E-Fixture-ID header.
  // The default fixture is used for tests that don't specify one.
  webServer: webServers(process.env.E2E_FIXTURE_ID || 'user-a-full-journey'),
  // Global setup: Clean database and run migrations before tests
  globalSetup: require.resolve('./global-setup'),
  outputDir: 'test-results/',
});
