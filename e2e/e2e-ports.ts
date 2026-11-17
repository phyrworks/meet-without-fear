/**
 * Ports/URLs for the e2e harness. Override to run several Playwright suites
 * side by side on one machine:
 *   E2E_API_PORT=3100 E2E_WEB_PORT=8182 npx playwright test
 * Defaults match the historical hardcoded values (3000 / 8082).
 */
function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be a TCP port number, got "${raw}"`);
  }
  return n;
}

export const E2E_API_PORT = port('E2E_API_PORT', 3000);
export const E2E_WEB_PORT = port('E2E_WEB_PORT', 8082);
export const E2E_API_URL = `http://localhost:${E2E_API_PORT}`;
export const E2E_API_URL_IP = `http://127.0.0.1:${E2E_API_PORT}`;
export const E2E_WEB_URL = `http://localhost:${E2E_WEB_PORT}`;

/**
 * Point the process-wide URL env vars at the chosen ports. Must run after
 * dotenv (.env.test pins API_BASE_URL/APP_BASE_URL to the default ports) and
 * before Playwright forks workers, which inherit process.env; specs and
 * helpers read API_BASE_URL / APP_BASE_URL.
 */
export function applyE2EPortEnv(): void {
  process.env.E2E_API_PORT = String(E2E_API_PORT);
  process.env.E2E_WEB_PORT = String(E2E_WEB_PORT);
  process.env.API_BASE_URL = E2E_API_URL_IP;
  process.env.APP_BASE_URL = E2E_WEB_URL;
  process.env.EXPO_PUBLIC_API_URL = E2E_API_URL_IP;
}
