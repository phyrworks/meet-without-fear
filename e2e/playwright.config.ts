import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load test environment variables
dotenv.config({ path: path.resolve(__dirname, '.env.test') });

// Shared web server configurations
const webServers = (fixtureId: string) => [
  {
    command: 'npm run dev:api',
    url: 'http://localhost:3000/health',
    reuseExistingServer: false,
    cwd: '..',
    timeout: 60000,
    env: {
      ...process.env,
      E2E_AUTH_BYPASS: 'true',
      MOCK_LLM: 'true',
      E2E_FIXTURE_ID: fixtureId,
    },
  },
  {
    // --no-dev forces a production-mode bundle. The dev-mode bundle ships
    // hundreds of lazy module fetches that race the test's first interaction
    // on slower hardware (CI, EC2), producing intermittent "blank page"
    // failures even after the dev server reports ready. Production-mode is
    // deterministic — single bundle, single network round-trip, then mounts.
    command: 'cd ../mobile && EXPO_PUBLIC_E2E_MODE=true EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo start --web --port 8082 --no-dev',
    url: 'http://localhost:8082',
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
    baseURL: 'http://localhost:8082',
    screenshot: 'on',
    video: 'on',
    viewport: { width: 375, height: 667 },
    trace: 'on',
  },
  // Projects for different test scenarios
  projects: [
    {
      name: 'user-a-journey',
      testMatch: /single-user-journey\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    {
      name: 'partner-journey',
      testMatch: /partner-journey\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    {
      name: 'homepage',
      testMatch: /homepage\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    {
      name: 'share-tab-rendering',
      testMatch: /share-tab-rendering\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    // Stage 2 Empathy: Reconciler tests
    {
      name: 'reconciler-share-accepted',
      testMatch: /stage-2-empathy\/reconciler\/gaps-detected-share-accepted\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    {
      name: 'reconciler-share-declined',
      testMatch: /stage-2-empathy\/reconciler\/gaps-detected-share-declined\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    {
      name: 'reconciler-share-refined',
      testMatch: /stage-2-empathy\/reconciler\/gaps-detected-share-refined\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    {
      name: 'reconciler-no-gaps',
      testMatch: /stage-2-empathy\/reconciler\/no-gaps-proceed-directly\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    {
      name: 'reconciler-no-gaps-screenshot',
      testMatch: /stage-2-empathy\/reconciler\/no-gaps-screenshot\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    // Stage 3-4: Complete flow test
    {
      name: 'stage-3-4-complete',
      testMatch: /stage-3-4-complete\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    // Circuit breaker: Two-browser test
    {
      name: 'circuit-breaker',
      testMatch: /two-browser-circuit-breaker\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    // Stage 3: Two-browser need mapping test
    {
      name: 'two-browser-stage-3',
      testMatch: /two-browser-stage-3\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
    // Stage 4: Two-browser strategic repair test (redesign flow)
    {
      name: 'two-browser-stage-4-redesign',
      testMatch: /two-browser-stage-4-redesign\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:8082',
      },
    },
  ],
  // Web server configuration
  // Each test specifies its fixture via the X-E2E-Fixture-ID header.
  // The default fixture is used for tests that don't specify one.
  webServer: webServers(process.env.E2E_FIXTURE_ID || 'user-a-full-journey'),
  // Global setup: Clean database and run migrations before tests
  globalSetup: require.resolve('./global-setup'),
  outputDir: 'test-results/',
});
