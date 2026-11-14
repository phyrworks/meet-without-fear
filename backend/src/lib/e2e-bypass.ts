/**
 * The E2E auth bypass (x-e2e-user-id headers, /api/e2e helpers, relaxed CORS
 * and rate limits) is on only when BOTH hold:
 *   - E2E_AUTH_BYPASS is exactly 'true', and
 *   - NODE_ENV is exactly one of E2E_BYPASS_ENVIRONMENTS.
 *
 * An allow-list, not "anything but production": an unset, misspelt or new
 * NODE_ENV (staging, prod, 'Test') leaves it off. Every bypass gate calls
 * this; server.ts refuses to start when the flag is set anywhere else.
 */
export const E2E_BYPASS_ENVIRONMENTS: readonly string[] = ['test', 'development'];

type Env = { NODE_ENV?: string; E2E_AUTH_BYPASS?: string };

export function isE2EBypassEnabled(env: Env = process.env): boolean {
  return env.E2E_AUTH_BYPASS === 'true' && E2E_BYPASS_ENVIRONMENTS.includes(env.NODE_ENV ?? '');
}

/** The flag is set but the environment is not allowed to honour it. */
export function isE2EBypassMisconfigured(env: Env = process.env): boolean {
  return env.E2E_AUTH_BYPASS === 'true' && !isE2EBypassEnabled(env);
}
