/**
 * E2E Test Utilities
 *
 * Shared helper functions extracted from test files to eliminate duplication.
 */

import { Page, Browser, BrowserContext, Response, devices, expect } from '@playwright/test';
import { getE2EHeaders } from './auth';
import type { MilestoneKey } from '@meet-without-fear/shared';

interface ApiResponseLike {
  ok(): boolean;
  status(): number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface E2EApiClient {
  get(url: string): Promise<ApiResponseLike>;
  post(url: string, data?: object): Promise<ApiResponseLike>;
}

interface NeedDTO {
  id: string;
  need: string;
}

interface ProgressResponseDTO {
  data?: {
    myProgress?: {
      stage?: number;
      status?: string;
      /** participant_milestone: milestone key → reachedAt ISO (shared MilestoneMap). */
      milestones?: Partial<Record<MilestoneKey, string>>;
    };
  };
}

interface NeedsResponseDTO {
  data?: {
    needs?: NeedDTO[];
    /** When the caller shared their needs (need_share), null before. */
    sharedAt?: string | null;
  };
}

interface NeedsComparisonResponseDTO {
  data?: {
    myNeeds?: NeedDTO[];
    partnerNeeds?: NeedDTO[];
    myValidated?: boolean;
    partnerValidated?: boolean;
    canAdvance?: boolean;
    analysisComplete?: boolean;
  };
}

async function expectApiResponseOk(response: ApiResponseLike, label: string): Promise<void> {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
  }
}

async function readJson<T>(response: ApiResponseLike, label: string): Promise<T> {
  await expectApiResponseOk(response, label);
  return await response.json() as T;
}

/**
 * Wait for AI response to complete streaming.
 * Checks for text pattern visibility and waits for typing indicator to disappear.
 *
 * @param page - Playwright Page instance
 * @param textPattern - RegExp pattern to match in AI response
 * @param timeout - Maximum time to wait in milliseconds (default: 15000)
 */
export async function waitForAIResponse(
  page: Page,
  textPattern: RegExp,
  timeout = 15000
): Promise<void> {
  await expect(page.getByText(textPattern)).toBeVisible({ timeout });

  const typingIndicator = page.getByTestId('typing-indicator');
  await expect(typingIndicator).not.toBeVisible({ timeout: 5000 }).catch(() => {});

  // Brief pause to ensure response is fully rendered
  await page.waitForTimeout(100);
}

/**
 * Create a new browser context with E2E headers for a specific user.
 * Configures the context with iPhone 12 device emulation and optional window positioning.
 *
 * @param browser - Playwright Browser instance
 * @param userEmail - User email for E2E auth headers
 * @param userId - User ID for E2E auth headers
 * @param fixtureId - Optional fixture ID for mock AI responses
 * @param position - Optional window position for side-by-side testing
 * @returns Object containing the context and page
 */
export async function createUserContext(
  browser: Browser,
  userEmail: string,
  userId: string,
  fixtureId?: string,
  position?: { x: number; y: number }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...devices['iPhone 12'],
    extraHTTPHeaders: getE2EHeaders(userEmail, userId, fixtureId),
  });
  const page = await context.newPage();

  if (position) {
    await page.evaluate(({ x, y }) => {
      window.moveTo(x, y);
      window.resizeTo(420, 750);
    }, position).catch(() => {});
  }

  return { context, page };
}

/**
 * Handle mood check modal if it appears.
 * Clicks the continue button if visible, otherwise does nothing.
 *
 * @param page - Playwright Page instance
 * @param timeout - Maximum time to wait for mood check (default: 5000)
 */
export async function handleMoodCheck(page: Page, timeout = 5000): Promise<void> {
  const moodContinue = page.getByTestId('mood-check-continue-button');
  if (await moodContinue.isVisible({ timeout }).catch(() => false)) {
    await moodContinue.click();
    await page.waitForLoadState('domcontentloaded');
  }
}

/**
 * Navigate a user to a session page with E2E query parameters.
 *
 * @param page - Playwright Page instance
 * @param appBaseUrl - Base URL of the application
 * @param sessionId - Session ID to navigate to
 * @param userId - User ID for query params
 * @param userEmail - User email for query params
 */
export async function navigateToSession(
  page: Page,
  appBaseUrl: string,
  sessionId: string,
  userId: string,
  userEmail: string
): Promise<void> {
  const params = new URLSearchParams({
    'e2e-user-id': userId,
    'e2e-user-email': userEmail,
  });
  await page.goto(`${appBaseUrl}/session/${sessionId}?${params.toString()}`);
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Open the reconciler's share suggestion (the "share topic" drawer) from the
 * session chat. Since mobile #602 (506c3f9a) removed the Activity drawer, the
 * subject's share offer lives in the share-topic panel above the chat input;
 * tapping it opens the share-topic drawer.
 */
export async function openShareTopicDrawer(page: Page, timeout = 15000): Promise<void> {
  await handleMoodCheck(page, 3000);
  const panel = page.getByTestId('share-topic-panel');
  await expect(panel).toBeVisible({ timeout });
  await panel.click();
  await expect(page.getByTestId('share-topic-drawer')).toBeVisible({ timeout: 10000 });
}

/**
 * Wait until the subject's share-topic panel is on screen, reloading the page
 * when it does not arrive by itself.
 *
 * The subject learns of a fresh share offer from the `empathy.share_suggestion`
 * Ably ping. The hermetic E2E servers run without ABLY_API_KEY (the backend
 * skips every publish, docs/development/local-setup.md §6), and a subject who
 * has not shared their own empathy has no polling fallback: the share-offer
 * query fetched at feel-heard time (before the async reconciler finishes) stays
 * `hasSuggestion: false`. Before #602 these specs navigated to the Share screen,
 * which refetched; this reload is that same fresh read, done in the chat.
 * Use it only where the subject has not shared (no poll); the panel itself, and
 * what it reveals, is still asserted by the caller.
 */
export async function waitForShareTopicPanel(page: Page, timeout = 60000): Promise<void> {
  const panel = page.getByTestId('share-topic-panel');
  if (await panel.isVisible({ timeout: 5000 }).catch(() => false)) return;
  await expect(async () => {
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await handleMoodCheck(page, 3000);
    await expect(panel).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout, intervals: [1000, 2000, 3000] });
}

/**
 * Accept the share suggestion and share the seeded draft as-is:
 * share-topic drawer -> "Yes, help me share" -> refinement modal -> "Share This Version".
 * Returns the finalize response.
 */
export async function shareFromShareTopicDrawer(page: Page, timeout = 15000): Promise<Response> {
  await openShareTopicDrawer(page, timeout);
  await page.getByTestId('share-topic-accept').click();
  const shareButton = page.getByTestId('refinement-modal-share-button');
  await expect(shareButton).toBeVisible({ timeout });
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().includes('/reconciler/refinement/finalize') && candidate.request().method() === 'POST',
      { timeout }
    ),
    shareButton.click(),
  ]);
  return response;
}

/**
 * Decline the share suggestion ("No thanks", confirmed in the web confirm dialog).
 * Returns the share-offer respond response.
 */
export async function declineShareTopic(page: Page, timeout = 15000): Promise<Response> {
  await openShareTopicDrawer(page, timeout);
  page.once('dialog', (dialog) => {
    void dialog.accept();
  });
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().includes('/reconciler/share-offer/respond') && candidate.request().method() === 'POST',
      { timeout }
    ),
    page.getByTestId('share-topic-decline').click(),
  ]);
  await expect(page.getByTestId('share-topic-drawer')).not.toBeVisible({ timeout: 10000 });
  return response;
}

/**
 * Sign the compact agreement for a user.
 * Checks the agree checkbox and clicks the sign button.
 *
 * @param page - Playwright Page instance
 * @param timeout - Maximum time to wait for compact UI (default: 10000)
 */
export async function signCompact(page: Page, timeout = 120000): Promise<void> {
  // The compact agreement bar was simplified — the standalone agree-checkbox
  // no longer exists; the bar is now just a single Sign/Ready CTA. Mirrors
  // the fix in PR #192 (single-user-journey.spec.ts).
  const signButton = page.getByTestId('compact-sign-button');
  await expect(signButton).toBeVisible({ timeout });
  await signButton.click();
}

/**
 * Drive the inviter through the fixture-backed Stage 0 conversation until the
 * invitation is ready for the partner to accept.
 *
 * All mocked two-browser journeys use the same User A fixture for these first
 * two turns. Keeping the valid ordering here prevents deeper-stage specs from
 * accepting an invitation before its topic has been confirmed.
 */
export async function completeInviterInvitationFlow(
  page: Page,
  timeout = 60000
): Promise<void> {
  const chatInput = page.getByTestId('chat-input');
  const sendButton = page.getByTestId('send-button');

  await expect(chatInput).toBeVisible({ timeout });
  await chatInput.fill("Hi, I'm having a conflict with my partner");
  await sendButton.click();
  await waitForAIResponse(page, /glad you reached out/i, timeout);

  await chatInput.fill('We keep arguing about household chores');
  await sendButton.click();
  await expect(page.getByTestId('topic-proposal-use-button')).toBeVisible({ timeout });
  await confirmInvitationTopicAndContinue(page, timeout);
}

/**
 * Complete the Stage 0 invitation gate by confirming the AI topic frame, then
 * dismissing the invitation-ready UI so the normal invitation confirmation
 * request and Stage 0 transition run.
 *
 * The current UI presents a topic proposal panel followed by a centered
 * invitation-ready modal. The legacy inline invitation panel is retained as a
 * fallback so this helper remains usable with older fixtures/screens.
 *
 * @param page - Playwright Page instance
 * @param timeout - Maximum time to wait for the topic/continue flow
 */
export async function confirmInvitationTopicAndContinue(
  page: Page,
  timeout = 30000
): Promise<void> {
  const topicProposalButton = page.getByTestId('topic-proposal-use-button');
  const legacyConfirmTopicButton = page.getByTestId('topic-frame-confirm-button');
  const regenerateTopicButton = page.getByTestId('topic-frame-generate-button');

  if (await regenerateTopicButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    const generateResponse = page.waitForResponse(
      response => response.url().includes('/topic-frame/generate'),
      { timeout }
    );
    await regenerateTopicButton.click();
    await generateResponse;
  }

  await expect(topicProposalButton.or(legacyConfirmTopicButton)).toBeVisible({ timeout });
  const confirmTopicButton = await topicProposalButton.isVisible()
    ? topicProposalButton
    : legacyConfirmTopicButton;
  const confirmResponse = page.waitForResponse(
    response => response.url().includes('/topic-frame/confirm'),
    { timeout }
  );
  await confirmTopicButton.click();
  const topicResponse = await confirmResponse;
  expect(topicResponse.ok()).toBe(true);

  const invitationPanel = page.getByTestId('invitation-draft-panel');
  const invitationModal = page.getByTestId('invitation-ready-modal');
  await expect(invitationModal.or(invitationPanel)).toBeVisible({ timeout });
  if (await invitationModal.isVisible()) {
    const invitationResponse = page.waitForResponse(
      response => response.url().includes('/invitation/confirm'),
      { timeout }
    );
    await page.getByTestId('invitation-modal-close-button').click();
    const response = await invitationResponse;
    expect(response.ok()).toBe(true);
    await expect(invitationModal).not.toBeVisible({ timeout });
    return;
  }

  const continueButton = page.getByTestId('invitation-continue-button');
  const invitationResponse = page.waitForResponse(
    response => response.url().includes('/invitation/confirm'),
    { timeout }
  );
  await continueButton.click();
  const response = await invitationResponse;
  expect(response.ok()).toBe(true);
}

/**
 * Complete the "feel heard" confirmation by clicking the Yes button.
 * Waits for the backend API request to complete to ensure stage transition
 * has propagated before subsequent messages are sent.
 *
 * Uses a retry loop to handle the case where the button is visible but not yet
 * interactive: the FeelHeardConfirmation panel is inside an Animated.View with
 * pointer-events: none while the typewriter animation is running (~3-5s for
 * typical AI responses). The click is retried with force:true every 2s until
 * the API call succeeds.
 *
 * @param page - Playwright Page instance
 * @param timeout - Maximum time to wait for feel heard buttons (default: 5000)
 */
export async function confirmFeelHeard(page: Page, timeout = 5000): Promise<void> {
  const feelHeardYes = page.getByTestId('feel-heard-yes');
  await expect(feelHeardYes).toBeVisible({ timeout });

  // Retry clicking until the API response is received.
  // The FeelHeardConfirmation panel is inside an Animated.View that has pointer-events: none
  // while the typewriter animation is running. We use force:true to bypass the hit-test
  // interceptor and directly dispatch the click event. The React handler fires when the
  // pointer-events become 'auto' (typewriter finishes). We retry every 2s for up to 30s.
  const maxRetries = 15;
  let responseReceived = false;

  for (let i = 0; i < maxRetries && !responseReceived; i++) {
    // Register response listener BEFORE click to avoid missing fast responses.
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/sessions/') && response.url().includes('/feel-heard'),
      { timeout: 3000 }
    ).then(() => {
      responseReceived = true;
    }).catch(() => {
      // Timeout - will retry after brief wait
    });

    // Use force:true to bypass pointer-events: none interceptor check.
    // This dispatches the click event directly to the element. When the element is
    // blocked by pointer-events: none on an ancestor, the event may not propagate
    // to React, so we retry until the API call succeeds.
    await feelHeardYes.click({ force: true });
    await responsePromise;

    if (!responseReceived && i < maxRetries - 1) {
      // Wait before retrying to allow typewriter animation to progress
      await page.waitForTimeout(2000);
    }
  }

  if (!responseReceived) {
    throw new Error('confirmFeelHeard: API response not received after 15 retries (pointer-events may be stuck)');
  }

  // Wait for the button to disappear (UI reflects stage change via optimistic update)
  await expect(feelHeardYes).not.toBeVisible({ timeout: 10000 });

  // Additional delay to ensure React state updates propagate fully
  await page.waitForTimeout(1000);
}

/**
 * Wait for any AI response to complete (without matching specific text).
 * Counts AI message elements before and polls until a new one appears,
 * then waits for the typing indicator to disappear (streaming complete).
 * Used for live-AI tests where response text is non-deterministic.
 *
 * @param page - Playwright Page instance
 * @param timeout - Maximum time to wait in milliseconds (default: 60000)
 */
export async function waitForAnyAIResponse(page: Page, timeout = 60000): Promise<void> {
  const typingIndicator = page.getByTestId('typing-indicator');

  // Wait for typing indicator to appear (AI started processing)
  await typingIndicator.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

  // Wait for typing indicator to disappear (streaming complete)
  await typingIndicator.waitFor({ state: 'hidden', timeout });
}

/**
 * Send messages one at a time, checking for a panel after each AI response.
 * Returns the number of messages it took for the panel to appear.
 * Throws if the panel doesn't appear after maxAttempts messages.
 *
 * @param page - Playwright Page instance
 * @param messages - Array of pre-written messages to send
 * @param panelTestId - testID of the panel to wait for
 * @param maxAttempts - Maximum number of messages to try
 * @param responseTimeout - Timeout per AI response (default: 60000)
 * @returns Number of messages sent before panel appeared
 */
export async function sendAndWaitForPanel(
  page: Page,
  messages: string[],
  panelTestId: string,
  maxAttempts: number,
  responseTimeout = 60000
): Promise<number> {
  // WebKit throttles requestAnimationFrame for background pages. The inline
  // panels use React Native Web animations, so foreground the browser page
  // before driving the conversation and waiting for a panel to slide in.
  await page.bringToFront();

  const attemptCount = Math.min(messages.length, maxAttempts);
  for (let i = 0; i < attemptCount; i++) {
    // Type and send message
    await page.getByTestId('chat-input').fill(messages[i]);
    await page.getByTestId('send-button').click();
    // Wait for AI response
    await waitForAnyAIResponse(page, responseTimeout);
    // Check if panel appeared (metadata arrives via a separate SSE event after
    // text, so give it time to process through React state updates).
    const panel = page.getByTestId(panelTestId);
    // Earlier turns get a short probe so a deterministic fixture can advance
    // without paying a full panel timeout each time. The final allowed turn
    // must wait through the UI animation/metadata tail before declaring failure.
    const panelTimeout = i === attemptCount - 1 ? 30000 : 3000;
    const panelAppeared = await panel
      .waitFor({ state: 'visible', timeout: panelTimeout })
      .then(() => true)
      .catch(() => false);
    if (panelAppeared) {
      // Wait for typewriter animation to complete so pointer-events become 'auto'
      await page.waitForTimeout(3000);
      return i + 1; // turns it took
    }
  }
  throw new Error(`Panel '${panelTestId}' did not appear after ${attemptCount} messages`);
}

/**
 * Wait for the reconciler to complete by polling for the empathy-shared indicator.
 * Returns true if the indicator becomes visible within the timeout, false if timeout expires.
 *
 * @param page - Playwright Page instance
 * @param timeout - Maximum time to wait in milliseconds (default: 30000)
 * @returns Promise resolving to true if indicator appears, false if timeout
 */
export async function waitForReconcilerComplete(page: Page, timeout = 30000): Promise<boolean> {
  const completionSurface = page
    .getByTestId('partner-empathy-validation-panel')
    .or(page.getByTestId('chat-indicator-empathy-shared'))
    .or(page.getByTestId('share-topic-panel'));
  try {
    await completionSurface.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Navigate back to the chat screen from a legacy share route.
 * If already on chat, returns immediately.
 *
 * @param page - Playwright Page instance
 * @param timeout - Maximum time to wait for navigation (default: 10000)
 */
export async function navigateBackToChat(page: Page, timeout = 10000): Promise<void> {
  // If already on chat (not on a legacy share route), return immediately
  if (!page.url().includes('/share')) {
    return;
  }

  // Try clicking the back button if visible
  const backButton = page.getByTestId('share-header-back-button');
  if (await backButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await backButton.click();
  } else {
    // Fallback: use browser back navigation
    await page.goBack();
  }

  // Wait for URL to match session chat pattern (not /share)
  await page.waitForURL(/\/session\/[^/]+$/, { timeout });
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Fetch identified needs and assert that Stage 3 produced a non-empty summary.
 */
export async function expectNeedsSummaryFromApi(
  api: E2EApiClient,
  apiBaseUrl: string,
  sessionId: string,
  label: string
): Promise<NeedDTO[]> {
  const response = await api.get(`${apiBaseUrl}/api/sessions/${sessionId}/needs`);
  const data = await readJson<NeedsResponseDTO>(response, `${label} needs summary`);
  const needs = data.data?.needs ?? [];
  expect(needs.length, `${label} should have at least one identified need`).toBeGreaterThan(0);
  return needs;
}

/**
 * Share Stage 3 needs through the needs drawer.
 */
export async function confirmNeedsSummaryAndConsent(
  page: Page,
  api: E2EApiClient,
  apiBaseUrl: string,
  sessionId: string,
  label: string,
  timeout = 30000
): Promise<void> {
  await expect(page.getByTestId('needs-drawer-open-button')).toBeVisible({ timeout });
  await page.getByTestId('needs-drawer-open-button').click();
  await expect(page.getByTestId('needs-drawer-send')).toBeVisible({ timeout });
  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await page.getByTestId('needs-drawer-send').click();

  // Wait for THIS participant's share to land (GET /needs sharedAt). Not the
  // needs_shared milestone: it is session-scoped and the job writes it for
  // everyone only once ALL have shared (R33), so the first sharer never sees
  // it here (work-keq6 root cause).
  await waitForOwnNeedsShared(api, apiBaseUrl, sessionId, label, timeout);
}

async function waitForOwnNeedsShared(
  api: E2EApiClient,
  apiBaseUrl: string,
  sessionId: string,
  label: string,
  timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const response = await api.get(`${apiBaseUrl}/api/sessions/${sessionId}/needs`);
    const data = await readJson<NeedsResponseDTO>(response, `${label} needs`);
    if (data.data?.sharedAt) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`${label} needs share was not recorded within ${timeout}ms`);
}

/**
 * Wait until both needs lists are available for the side-by-side reveal.
 */
export async function waitForNeedsReveal(
  api: E2EApiClient,
  apiBaseUrl: string,
  sessionId: string,
  label: string,
  timeout = 30000
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastMyCount = 0;
  let lastPartnerCount = 0;

  while (Date.now() < deadline) {
    const response = await api.get(`${apiBaseUrl}/api/sessions/${sessionId}/needs/comparison`);
    const data = await readJson<NeedsComparisonResponseDTO>(response, `${label} needs reveal`);
    lastMyCount = data.data?.myNeeds?.length ?? 0;
    lastPartnerCount = data.data?.partnerNeeds?.length ?? 0;

    if (lastMyCount > 0 && lastPartnerCount > 0) {
      // Both lists are visible, so everyone has shared: the session-scoped
      // needs_shared milestone must be in this participant's progress.
      await waitForMilestone(api, apiBaseUrl, sessionId, 'needs_shared', label, Math.max(deadline - Date.now(), 5000));
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`${label} needs reveal did not complete within ${timeout}ms (last counts: my=${lastMyCount}, partner=${lastPartnerCount})`);
}

/**
 * Legacy fallback: assert the side-by-side needs reveal and continue through it.
 * Current sessions normally advance to Stage 4 automatically once both partners
 * send needs.
 */
export async function confirmSideBySideRevealAndValidation(
  page: Page,
  partnerName: string,
  timeout = 30000
): Promise<void> {
  await expect(page.getByTestId('needs-reveal-validate-button')).toBeVisible({ timeout });
  await page.getByTestId('needs-reveal-validate-button').click();

  const modal = page.getByTestId('needs-reveal-modal');
  await expect(modal).toBeVisible({ timeout });
  await expect(modal.getByText('Needs side by side')).toBeVisible({ timeout });
  await expect(modal.getByText(/You have both sent your needs/i)).toBeVisible({ timeout });
  await expect(modal.getByText('You')).toBeVisible({ timeout });
  await expect(modal.getByText(partnerName)).toBeVisible({ timeout });

  await modal.getByTestId('needs-reveal-validate').click();
}

/**
 * Assert both needs-comparison API halves are present after the side-by-side reveal.
 */
export async function expectNeedsComparisonFromApi(
  api: E2EApiClient,
  apiBaseUrl: string,
  sessionId: string,
  label: string
): Promise<void> {
  const response = await api.get(`${apiBaseUrl}/api/sessions/${sessionId}/needs/comparison`);
  const data = await readJson<NeedsComparisonResponseDTO>(response, `${label} needs comparison`);

  expect(data.data?.myNeeds?.length ?? 0, `${label} comparison should include my needs`).toBeGreaterThan(0);
  expect(data.data?.partnerNeeds?.length ?? 0, `${label} comparison should include partner needs`).toBeGreaterThan(0);
}

/**
 * Wait for the current user's latest progress to reach the expected stage.
 */
export async function waitForStage(
  api: E2EApiClient,
  apiBaseUrl: string,
  sessionId: string,
  expectedStage: number,
  label: string,
  timeout = 30000
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastStage: number | undefined;
  let lastStatus: string | undefined;

  while (Date.now() < deadline) {
    const response = await api.get(`${apiBaseUrl}/api/sessions/${sessionId}/progress`);
    const data = await readJson<ProgressResponseDTO>(response, `${label} progress`);
    lastStage = data.data?.myProgress?.stage;
    lastStatus = data.data?.myProgress?.status;

    if (lastStage === expectedStage) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`${label} did not reach stage ${expectedStage} within ${timeout}ms (last: stage ${lastStage}, status ${lastStatus})`);
}

/**
 * Wait until the current user's progress carries a reached milestone
 * (GET /progress myProgress.milestones, straight from participant_milestone).
 */
export async function waitForMilestone(
  api: E2EApiClient,
  apiBaseUrl: string,
  sessionId: string,
  milestone: MilestoneKey,
  label: string,
  timeout = 30000
): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const response = await api.get(`${apiBaseUrl}/api/sessions/${sessionId}/progress`);
    const data = await readJson<ProgressResponseDTO>(response, `${label} progress`);
    if (data.data?.myProgress?.milestones?.[milestone]) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`${label} milestone '${milestone}' was not reached within ${timeout}ms`);
}

interface Stage4StateDTO {
  data: {
    inventory: {
      sharedProposals: Array<{ id: string; description: string; partnerDecisionVisible?: string }>;
    };
    coverageAudit: { open: Array<{ id: string; label: string }> };
    mySelectionStatus: string;
    partnerSelectionStatus: string;
    outcome: { kind: string } | null;
  };
}

/**
 * Drive the redesigned Stage 4 selection flow for one user over the API:
 * WILLING on every shared proposal, set aside every still-open need ("leave
 * for now"), then share the selections (milestone choices_shared). Every
 * request is asserted OK, so a missing route fails loudly instead of a 404
 * being swallowed.
 *
 * @returns the proposal ids this user marked WILLING
 */
export async function submitAndShareStage4Selections(
  api: E2EApiClient,
  apiBaseUrl: string,
  sessionId: string,
  label: string
): Promise<string[]> {
  const base = `${apiBaseUrl}/api/sessions/${sessionId}`;
  const state = await readJson<Stage4StateDTO>(await api.get(`${base}/stage4`), `${label} get Stage 4 state`);
  const proposals = state.data.inventory.sharedProposals;
  expect(proposals.length, `${label} should see shared proposals in the Stage 4 inventory`).toBeGreaterThan(0);

  // `submitted` means shared (choices_shared), so it is still false here.
  const recorded = await readJson<{ data: { state: { mySelections: unknown[] } } }>(
    await api.post(`${base}/stage4/selections`, {
      selections: proposals.map((proposal) => ({ proposalId: proposal.id, decision: 'WILLING' })),
    }),
    `${label} submit Stage 4 selections`
  );
  expect(recorded.data.state.mySelections, `${label} selections should be recorded`).toHaveLength(proposals.length);

  // Needs no WILLING proposal covers must be addressed or set aside before sharing.
  const afterSelect = await readJson<Stage4StateDTO>(await api.get(`${base}/stage4`), `${label} re-read Stage 4 state`);
  for (const need of afterSelect.data.coverageAudit.open) {
    await readJson(await api.post(`${base}/stage4/needs/${need.id}/decline`), `${label} set aside need "${need.label}"`);
  }

  await readJson(await api.post(`${base}/stage4/share-selections`), `${label} share Stage 4 selections`);
  await waitForMilestone(api, apiBaseUrl, sessionId, 'choices_shared', label);
  return proposals.map((proposal) => proposal.id);
}

/**
 * Once both users have shared (choices_shared), close Stage 4 as a shared
 * agreement on the first proposal both are visibly WILLING on, with a
 * follow-up one week out. Returns the close response data.
 */
export async function closeStage4WithSharedAgreement(
  api: E2EApiClient,
  apiBaseUrl: string,
  sessionId: string,
  label: string
): Promise<{ data: { closed: boolean; outcome: { kind: string; agreements: Array<{ id: string }> } } }> {
  const base = `${apiBaseUrl}/api/sessions/${sessionId}`;
  const state = await readJson<Stage4StateDTO>(await api.get(`${base}/stage4`), `${label} get revealed Stage 4 state`);
  expect(state.data.partnerSelectionStatus, `${label} partner selections should be visible after both shared`).toBe('SUBMITTED');
  const mutual = state.data.inventory.sharedProposals.find((proposal) => proposal.partnerDecisionVisible === 'WILLING');
  expect(mutual, `${label} should see a proposal the partner is WILLING on`).toBeTruthy();

  const followUp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return readJson(
    await api.post(`${base}/stage4/close`, {
      kind: 'SHARED_AGREEMENT',
      followUpDatesByProposalId: { [mutual!.id]: followUp },
    }),
    `${label} close Stage 4 as a shared agreement`
  );
}
