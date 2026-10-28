/**
 * URL Utility Functions
 *
 * Centralized URL generation for environment-aware URLs.
 */

/**
 * Get the website base URL for sharing invitation links.
 * In development: http://localhost:3001
 * In production: https://meetwithoutfear.com
 */
export function getWebsiteUrl(): string {
  // Check for explicit environment variable first
  if (process.env.WEBSITE_URL) {
    return process.env.WEBSITE_URL;
  }

  // Check for legacy APP_URL variable
  if (process.env.APP_URL) {
    return process.env.APP_URL;
  }

  // Only fall back to localhost when we explicitly know we're in development.
  // Any other case (production, test, or unset NODE_ENV) must use the
  // production URL so a missing env var can never leak localhost links to users.
  if (process.env.NODE_ENV === 'development') {
    return 'http://localhost:3001';
  }

  return 'https://meetwithoutfear.com';
}

/**
 * Generate an invitation link URL for sharing.
 * Uses website URLs (not deep links) so recipients can open in browser,
 * then log in/sign up before being redirected to the app.
 */
export function createInvitationUrl(invitationId: string): string {
  const websiteUrl = getWebsiteUrl();
  return `${websiteUrl}/invitation/${invitationId}`;
}
