/**
 * E2E Test Helpers
 *
 * Re-exports all helper functions for convenient imports.
 */

export { createAuthHeaders, e2eUserIdForEmail, getE2EHeaders } from './auth';
export { cleanupE2EData } from './cleanup';
export { SessionBuilder, setupSession } from './session-builder';
export type { TargetStage, UserConfig, SessionSetupResult } from './session-builder';
export {
  waitForAIResponse,
  waitForAnyAIResponse,
  sendAndWaitForPanel,
  createUserContext,
  handleMoodCheck,
  navigateToSession,
  navigateToShareFromSession,
  signCompact,
  completeInviterInvitationFlow,
  confirmInvitationTopicAndContinue,
  confirmFeelHeard,
  expectNeedsSummaryFromApi,
  confirmNeedsSummaryAndConsent,
  waitForNeedsReveal,
  confirmSideBySideRevealAndValidation,
  expectNeedsComparisonFromApi,
  waitForStage,
} from './test-utils';
export { TwoBrowserHarness, waitForPartnerUpdate } from './two-browser-harness';
export type { TwoBrowserConfig } from './two-browser-harness';
