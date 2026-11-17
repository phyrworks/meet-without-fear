/**
 * Playwright config for live-AI tests (MOCK_LLM=false).
 *
 * Picks up any spec named `live-ai-*.spec.ts` (single-user or two-browser).
 * No E2E_FIXTURE_ID in webServer env — per-user fixtures (when used) flow
 * through the X-E2E-Fixture-ID header from each browser context.
 *
 * Run with:
 *   npx playwright test --config=e2e/playwright.live-ai.config.ts
 */
import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { E2E_API_PORT, E2E_WEB_PORT, E2E_API_URL, E2E_API_URL_IP, E2E_WEB_URL, applyE2EPortEnv } from './e2e-ports';

// Load test environment variables
dotenv.config({ path: path.resolve(__dirname, '.env.test') });
applyE2EPortEnv();

export default defineConfig({
  testDir: './tests',
  testMatch: /live-ai-.*\.spec\.ts/,
  timeout: 1800000, // 30 minutes per test (two-browser real-AI flow can take 15+ min)
  expect: {
    timeout: 180000, // structured-output turns (invitation/empathy/strategy drafts) can spike to 120s+ on Bedrock
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: E2E_WEB_URL,
    screenshot: 'on',
    video: 'on',
    viewport: { width: 375, height: 667 },
    trace: 'on',
  },
  projects: [
    {
      name: 'live-ai-flow',
      testMatch: /live-ai-.*\.spec\.ts/,
      use: {
        baseURL: E2E_WEB_URL,
      },
    },
  ],
  webServer: [
    {
      command: 'npm run dev:api',
      url: `${E2E_API_URL}/health`,
      reuseExistingServer: false,
      cwd: '..',
      timeout: 60000,
      env: {
        ...process.env,
        E2E_AUTH_BYPASS: 'true',
        // The API honours E2E_AUTH_BYPASS only with NODE_ENV test/development/e2e
        // (backend/src/lib/e2e-bypass.ts) and refuses to start otherwise.
        NODE_ENV: 'development',
        MOCK_LLM: 'false',
        PORT: String(E2E_API_PORT),
        E2E_WEB_PORT: String(E2E_WEB_PORT),
        // No E2E_FIXTURE_ID — two-browser specs supply per-user fixtures via
        // X-E2E-Fixture-ID header. The single-user live-ai-full-flow spec
        // does not rely on a global fixture id either (it reaches real LLM).
      },
    },
    {
      // --no-dev forces production-mode bundle. Dev-mode ships hundreds of
      // lazy module fetches that race the test's first interaction (the
      // compact bar) on slower hardware (CI, EC2). Production-mode is
      // deterministic — single bundle, single round-trip, then mounts.
      // Mirrors the single-user-journey fix in PR #192.
      command: `cd ../mobile && EXPO_PUBLIC_E2E_MODE=true EXPO_PUBLIC_API_URL=${E2E_API_URL_IP} npx expo start --web --port ${E2E_WEB_PORT} --no-dev --clear`,
      url: E2E_WEB_URL,
      reuseExistingServer: false,
      timeout: 300000,
    },
  ],
  globalSetup: require.resolve('./global-setup'),
  outputDir: 'test-results/',
});
