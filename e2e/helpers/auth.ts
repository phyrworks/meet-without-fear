/**
 * E2E Auth Helper
 *
 * Creates authentication headers for E2E testing.
 */

import { createHash } from 'crypto';

export interface E2EAuthHeaders {
  'x-e2e-user-id': string;
  'x-e2e-user-email': string;
}

/**
 * A stable UUID for an email, for callers that do not know the user's id.
 *
 * The backend upserts `User` by this id and `User.id` is a uuid column, so the
 * old default (the email's local part) is rejected. Same email, same id, on
 * every run. Version nibble 8 (RFC 9562 custom), variant 10.
 */
export function e2eUserIdForEmail(email: string): string {
  const h = createHash('sha256').update(email).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Create E2E auth headers for a given user email.
 * @param email - User email (should end with @e2e.test)
 * @param userId - Optional user ID (defaults to a stable UUID derived from the email)
 */
export function createAuthHeaders(
  email: string,
  userId?: string
): E2EAuthHeaders {
  const id = userId ?? e2eUserIdForEmail(email);
  return {
    'x-e2e-user-id': id,
    'x-e2e-user-email': email,
  };
}

/**
 * Create extra HTTP headers object for fetch/Playwright requests.
 * @param email - User email (should end with @e2e.test)
 * @param userId - Optional user ID (defaults to a stable UUID derived from the email)
 * @param fixtureId - Optional fixture ID for mock AI responses
 */
export function getE2EHeaders(
  email: string,
  userId?: string,
  fixtureId?: string
): Record<string, string> {
  const headers = createAuthHeaders(email, userId);
  const result: Record<string, string> = {
    'x-e2e-user-id': headers['x-e2e-user-id'],
    'x-e2e-user-email': headers['x-e2e-user-email'],
  };

  if (fixtureId) {
    result['x-e2e-fixture-id'] = fixtureId;
  }

  return result;
}
