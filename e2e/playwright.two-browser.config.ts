/**
 * Playwright config for two-browser tests (MOCK_LLM=true, no global fixture ID).
 *
 * Key differences from main config:
 * - No E2E_FIXTURE_ID in webServer env (per-user fixtures via X-E2E-Fixture-ID header)
 * - MOCK_LLM=true for deterministic AI responses
 * - testMatch covers two-browser-*.spec.ts files
 *
 * Run with:
 *   cd e2e && npx playwright test --config=playwright.two-browser.config.ts
 */
import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load test environment variables
dotenv.config({ path: path.resolve(__dirname, '.env.test') });

export default defineConfig({
  testDir: './tests',
  testMatch: /two-browser-.*\.spec\.ts/,
  // Real-Bedrock journeys have their own on-demand config. The broad
  // two-browser filename pattern also matches them, but this deterministic
  // harness always starts the backend with MOCK_LLM=true.
  testIgnore: /live-ai-.*\.spec\.ts/,
  // Existing image baselines capture the retired pre-redesign UI. Keep this
  // suite focused on live semantic/wire contracts until visual baselines are
  // deliberately reviewed and regenerated as a separate change.
  ignoreSnapshots: true,
  timeout: 900000, // 15 minutes per test (Stage 2 needs 13 AI interactions + reconciler)
  expect: {
    timeout: 15000, // 15s for Ably events and partner updates
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
    browserName: 'chromium',
    baseURL: 'http://localhost:8082',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 375, height: 667 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'two-browser',
      testMatch: /two-browser-.*\.spec\.ts/,
      testIgnore: /live-ai-.*\.spec\.ts/,
      use: {
        browserName: 'chromium',
        baseURL: 'http://localhost:8082',
      },
    },
  ],
  // Web server configuration
  // CRITICAL: No E2E_FIXTURE_ID here - each user sets fixture via X-E2E-Fixture-ID header
  webServer: [
    {
      // Playwright starts managed web servers before globalSetup. Prepare the
      // database in this command so Prisma is created only after truncate and
      // migrations finish; mutating the schema beneath a live client causes
      // long pool stalls on the first browser requests.
      command: 'npx tsx e2e/prepare-database.ts && npm run dev:api',
      url: 'http://localhost:3000/health',
      reuseExistingServer: false,
      cwd: '..',
      timeout: 60000,
      env: {
        ...process.env,
        E2E_AUTH_BYPASS: 'true',
        // The API honours E2E_AUTH_BYPASS only with NODE_ENV test/development
        // (backend/src/lib/e2e-bypass.ts) and refuses to start otherwise.
        NODE_ENV: 'development',
        MOCK_LLM: 'true',
        // NO E2E_FIXTURE_ID - per-user fixtures via request headers
      },
    },
    {
      // Keep the two-browser harness on the same production-mode bundle as
      // the main E2E suite. In dev mode, CREATED sessions intentionally use a
      // lightweight __DEV__ chat surface that omits the compact/invitation
      // controls exercised by these tests.
      command: 'cd ../mobile && EXPO_PUBLIC_E2E_MODE=true EXPO_PUBLIC_API_URL=http://127.0.0.1:3000 npx expo start --web --port 8082 --no-dev',
      url: 'http://localhost:8082',
      reuseExistingServer: false,
      timeout: 300000,
    },
  ],
  outputDir: 'test-results/',
});
