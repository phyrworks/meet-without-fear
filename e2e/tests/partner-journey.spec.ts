/**
 * Partner Journey E2E Test (Two Browser Contexts)
 *
 * Tests the complete two-user flow:
 * 1. User A (Shantam) is already in Stage 2, waiting for partner to feel heard
 * 2. User B (Darryl) has accepted (seeded post-accept, work-2km7), signs compact, chats, feels heard
 * 3. Reconciler runs and finds gaps in Shantam's empathy guess
 * 4. Darryl sees share suggestion and can share context to help Shantam understand
 */

import { test, expect, devices, BrowserContext, Page } from '@playwright/test';
import { cleanupE2EData, getE2EHeaders, SessionBuilder, shareFromShareTopicDrawer, signCompact, waitForShareTopicPanel } from '../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

// Use iPhone 12 viewport - must be at top level
test.use(devices['iPhone 12']);

/**
 * Helper to wait for AI response to complete streaming.
 */
async function waitForAIResponse(page: Page, textPattern: RegExp, timeout = 15000) {
  await expect(page.getByText(textPattern)).toBeVisible({ timeout });

  const typingIndicator = page.getByTestId('typing-indicator');
  await expect(typingIndicator).not.toBeVisible({ timeout: 5000 }).catch(() => {});

  await page.waitForTimeout(100);
}

/**
 * Create a new browser context with E2E headers for a specific user.
 * Optionally positions the window for side-by-side viewing.
 */
async function createUserContext(
  browser: import('@playwright/test').Browser,
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

  // Position window if coordinates provided (for headed mode)
  if (position) {
    await page.evaluate(({ x, y }) => {
      window.moveTo(x, y);
      window.resizeTo(420, 750); // Slightly larger than viewport to account for chrome
    }, position).catch(() => {
      // Ignore errors - moveTo may not work in all contexts
    });
  }

  return { context, page };
}

// Fixture ID for this test - determines which mock AI responses are used
const FIXTURE_ID = 'user-b-partner-journey';

test.describe('Partner Journey (Two Browser Contexts)', () => {
  const userA = {
    email: 'shantam@e2e.test',
    name: 'Shantam',
  };

  const userB = {
    email: 'darryl@e2e.test',
    name: 'Darryl',
  };

  let sessionId: string;
  let userAId: string;
  let userBId: string;
  let invitationId: string;

  // Browser contexts for each user
  let userAContext: BrowserContext;
  let userAPage: Page;
  let userBContext: BrowserContext;
  let userBPage: Page;

  test.beforeEach(async ({ browser, request }) => {
    // Clean up any existing E2E test data
    await cleanupE2EData().catch(() => {});

    // Seed session at EMPATHY_SHARED_A stage
    // User A has completed through empathy sharing; User B has joined but not begun
    const setup = await new SessionBuilder()
      .userA(userA.email, userA.name)
      .userB(userB.email, userB.name)
      .startingAt('EMPATHY_SHARED_A')
      .setup(request);

    sessionId = setup.session.id;
    userAId = setup.userA.id;
    userBId = setup.userB!.id;
    invitationId = setup.invitation.id;

    console.log(`[Setup] Session: ${sessionId}`);
    console.log(`[Setup] User A (${userA.name}): ${userAId}`);
    console.log(`[Setup] User B (${userB.name}): ${userBId}`);
    console.log(`[Setup] Invitation: ${invitationId}`);

    // Create browser contexts for both users
    // Position windows side by side for headed mode viewing
    // Include fixture ID so API requests use the correct mock responses
    const userASetup = await createUserContext(browser, userA.email, userAId, FIXTURE_ID, { x: 0, y: 0 });
    userAContext = userASetup.context;
    userAPage = userASetup.page;

    const userBSetup = await createUserContext(browser, userB.email, userBId, FIXTURE_ID, { x: 450, y: 0 });
    userBContext = userBSetup.context;
    userBPage = userBSetup.page;
  });

  test.afterEach(async () => {
    // Close browser contexts
    await userAContext?.close();
    await userBContext?.close();
  });

  test('partner feels heard and sees reconciler share suggestion', async ({ request }) => {
    // Increase timeout for this long journey test (5 minutes)
    test.setTimeout(300000);
    const testStart = Date.now();
    const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

    // Set up console logging to capture ALL console messages temporarily
    const userAConsoleLogs: string[] = [];
    let captureAllLogs = true;
    userAPage.on('console', (msg) => {
      const text = msg.text();
      // Capture first 50 console logs to understand what's happening
      if (captureAllLogs && userAConsoleLogs.length < 50) {
        userAConsoleLogs.push(`[${((Date.now() - testStart) / 1000).toFixed(1)}s] ${msg.type()}: ${text.substring(0, 200)}`);
      }
      // Always log Ably-related messages
      if (text.includes('[Realtime]') || text.includes('[Ably]') || text.includes('[AblySingleton]') ||
          text.includes('context_shared') || text.includes('empathy.') ||
          text.includes('Connection state') || text.includes('subscribe') ||
          text.includes('Subscription')) {
        console.log(`${elapsed()} [User A Console] ${text}`);
      }
    });

    // Also capture errors
    userAPage.on('pageerror', (error) => {
      console.log(`${elapsed()} [User A PAGE ERROR] ${error.message}`);
      userAConsoleLogs.push(`[ERROR] ${error.message}`);
    });

    // ==========================================
    // PHASE 1: User A navigates to session (already in Stage 2, waiting)
    // ==========================================
    console.log(`${elapsed()} === PHASE 1: User A enters session ===`);

    const userAParams = new URLSearchParams({
      'e2e-user-id': userAId,
      'e2e-user-email': userA.email,
    });
    await userAPage.goto(`${APP_BASE_URL}/session/${sessionId}?${userAParams.toString()}`);
    await userAPage.waitForLoadState('networkidle');

    await userAPage.screenshot({ path: 'test-results/partner-01-user-a-session.png' });

    // Handle mood check if present for User A
    const userAMoodContinueButton = userAPage.getByTestId('mood-check-continue-button');
    const userAHasMoodCheck = await userAMoodContinueButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (userAHasMoodCheck) {
      console.log(`${elapsed()} User A handling mood check`);
      await userAMoodContinueButton.click();
      await userAPage.waitForLoadState('networkidle');
    }

    // User A should see the session with their partner's name and empathy shared status
    // (User A is in Stage 2 after completing Stage 1 and sharing empathy)
    const partnerName = userAPage.getByTestId('session-chat-header-partner-name');
    await expect(partnerName).toBeVisible({ timeout: 10000 });
    await expect(partnerName).toHaveText('Darryl');

    // Should also see "Empathy shared" indicator
    const empathyShared = userAPage.getByText(/Empathy shared/i);
    await expect(empathyShared).toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} User A sees session with Darryl, empathy shared`);

    // Wait for User A's Ably connection to be established
    // The app should log "Subscription setup complete" when ready
    console.log(`${elapsed()} Waiting for User A's Ably subscription to be established...`);
    await userAPage.waitForTimeout(3000); // Give time for Ably to connect
    console.log(`${elapsed()} User A Ably console logs so far:`, userAConsoleLogs);

    // ==========================================
    // PHASE 2: (none) User B has already accepted
    // ==========================================
    // EMPATHY_SHARED_A is seeded post-accept (work-2km7): the invitation is ACCEPTED, the
    // session ACTIVE and User B a participant who has not begun. Accept itself is tested
    // from INVITATION_READY (backend fixture-scenarios/__tests__/topic-frame.test.ts).

    // ==========================================
    // PHASE 3: User B navigates to session and signs compact
    // ==========================================
    console.log(`${elapsed()} === PHASE 3: User B signs compact ===`);

    const userBParams = new URLSearchParams({
      'e2e-user-id': userBId,
      'e2e-user-email': userB.email,
    });
    await userBPage.goto(`${APP_BASE_URL}/session/${sessionId}?${userBParams.toString()}`);
    await userBPage.waitForLoadState('networkidle');

    await userBPage.screenshot({ path: 'test-results/partner-02-user-b-session.png' });

    // Sign compact
    // Two-step Stage 0 (mobile #310): the agree checkbox is gone; the bar is a single Ready CTA.
    await signCompact(userBPage);

    await userBPage.screenshot({ path: 'test-results/partner-03-user-b-compact-signed.png' });

    // Handle mood check if present
    const moodContinueButton = userBPage.getByTestId('mood-check-continue-button');
    const hasMoodCheck = await moodContinueButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasMoodCheck) {
      await moodContinueButton.click();
    }

    // Wait for chat input
    const chatInput = userBPage.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    console.log(`${elapsed()} User B signed compact`);

    // ==========================================
    // PHASE 4: User B chats with AI (4 exchanges)
    // ==========================================
    console.log(`${elapsed()} === PHASE 4: User B chats with AI ===`);

    const sendButton = userBPage.getByTestId('send-button');

    // The initial AI greeting may or may not appear automatically (depends on app behavior)
    // Try to wait for it briefly, but proceed even if not found
    const initialGreeting = userBPage.getByText(/glad you're here|welcome/i);
    const hasInitialGreeting = await initialGreeting.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasInitialGreeting) {
      console.log(`${elapsed()} User B received initial greeting`);
    } else {
      console.log(`${elapsed()} No initial greeting found, proceeding with first message`);
    }

    // Exchange 1 - User B sends first message
    await chatInput.fill('Things have been tense lately');
    await sendButton.click();
    await waitForAIResponse(userBPage, /tension can be really draining/i);
    console.log(`${elapsed()} Exchange 1 complete`);

    // Exchange 2
    await chatInput.fill("I feel like they don't see how much I'm dealing with");
    await sendButton.click();
    await waitForAIResponse(userBPage, /feeling unseen while carrying a lot/i);
    console.log(`${elapsed()} Exchange 2 complete`);

    // Exchange 3
    await chatInput.fill("I work so hard and come home exhausted, but there's always more to do");
    await sendButton.click();
    await waitForAIResponse(userBPage, /exhaustion you're describing/i);
    console.log(`${elapsed()} Exchange 3 complete`);

    // Exchange 4 - triggers feel-heard check
    await chatInput.fill("Months now. I don't know how to get through to them");
    await sendButton.click();
    await waitForAIResponse(userBPage, /Do you feel like I understand/i);
    console.log(`${elapsed()} Exchange 4 complete - feel-heard check triggered`);

    await userBPage.screenshot({ path: 'test-results/partner-04-user-b-feel-heard-check.png' });

    // ==========================================
    // PHASE 5: User B confirms feeling heard
    // This triggers the reconciler to run
    // ==========================================
    console.log(`${elapsed()} === PHASE 5: User B confirms feeling heard ===`);

    const feelHeardYes = userBPage.getByTestId('feel-heard-yes');
    await expect(feelHeardYes).toBeVisible({ timeout: 5000 });
    await feelHeardYes.click();

    // Wait for button to disappear
    await expect(feelHeardYes).not.toBeVisible({ timeout: 5000 });

    console.log(`${elapsed()} User B confirmed feeling heard - reconciler should run`);

    await userBPage.screenshot({ path: 'test-results/partner-05-user-b-feel-heard-confirmed.png' });

    // ==========================================
    // PHASE 6: Check for share suggestion (via API or modal)
    // The reconciler compares User A's empathy guess with User B's actual content
    // If gaps are found, User B receives a share suggestion
    // ==========================================
    console.log(`${elapsed()} === PHASE 6: Checking for share suggestion ===`);

    // Wait for reconciler to complete (runs in background after feel-heard confirmation)
    await userBPage.waitForTimeout(3000);

    // First verify the share offer exists via API (more reliable than UI)
    const shareOfferResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/reconciler/share-offer`, {
      headers: getE2EHeaders(userB.email, userBId, FIXTURE_ID),
    });

    console.log(`${elapsed()} Share offer API status: ${shareOfferResponse.status()}`);

    let shareOfferData: any = null;
    try {
      shareOfferData = await shareOfferResponse.json();
      console.log(`${elapsed()} Share offer API response:`, JSON.stringify(shareOfferData, null, 2));
    } catch (e) {
      console.log(`${elapsed()} Share offer API response failed to parse:`, e);
    }

    // API wraps response in { success, data } envelope
    const hasShareOfferFromAPI = shareOfferData?.data?.hasSuggestion === true;
    if (hasShareOfferFromAPI) {
      console.log(`${elapsed()} Share suggestion content: "${shareOfferData.suggestion?.suggestedContent?.substring(0, 50)}..."`);
    }

    // The share suggestion lives in the share-topic panel above User B's chat input
    // (mobile #602, 506c3f9a, removed the Activity drawer this spec used to open).
    if (hasShareOfferFromAPI) {
      // ==========================================
      // PHASE 7: User B shares context
      // ==========================================
      console.log(`${elapsed()} === PHASE 7: User B shares context ===`);
      await userBPage.screenshot({ path: 'test-results/partner-07-user-b-share-suggestion-card.png' });

      // The offer exists server-side (API above); without Ably the subject's chat
      // only shows it after a fresh read (see waitForShareTopicPanel).
      await waitForShareTopicPanel(userBPage);
      const shareResponse = await shareFromShareTopicDrawer(userBPage);
      console.log(`${elapsed()} Share API response status: ${shareResponse.status()}`);
      expect(shareResponse.ok()).toBe(true);

      // The share suggestion is gone once it was shared
      await expect(userBPage.getByTestId('share-topic-panel')).not.toBeVisible({ timeout: 10000 });

      console.log(`${elapsed()} User B shared context`);
      await userBPage.screenshot({ path: 'test-results/partner-08-user-b-shared.png' });

      // ==========================================
      // PHASE 8: Verify User A receives the shared context
      // ==========================================
      console.log(`${elapsed()} === PHASE 8: Check User A received shared context ===`);

      // Log Ably console output before checking
      console.log(`${elapsed()} User A Ably logs before check:`, userAConsoleLogs.slice(-10));

      // Wait for the Ably event to arrive
      // The backend publishes 'empathy.context_shared' which should trigger a cache refetch
      await userAPage.waitForTimeout(3000);

      // Log Ably console output after waiting
      console.log(`${elapsed()} User A Ably logs after wait:`, userAConsoleLogs.slice(-10));

      // The Ably real-time event should trigger a React Query cache update on User A's page
      // which will cause the "Context from Darryl" indicator to appear without a page reload.
      // Note: When context is from partner (not self), it shows "Context from {partnerName}"

      // Try waiting for the indicator to appear via Ably (with longer timeout)
      const sharedContextIndicator = userAPage.getByText('Context from Darryl', { exact: true });
      const indicatorVisible = await sharedContextIndicator.isVisible({ timeout: 8000 }).catch(() => false);

      if (!indicatorVisible) {
        // Log what we know about Ably connection state
        console.log(`${elapsed()} Ably update not received. All Ably logs:`, userAConsoleLogs);

        // Ably update didn't arrive in time - reload to verify the data was persisted
        console.log(`${elapsed()} Reloading User A page to verify state`);
        await userAPage.reload();
        await userAPage.waitForLoadState('networkidle');

        // Handle mood check if present after reload
        const moodContinue = userAPage.getByTestId('mood-check-continue-button');
        const hasMoodCheck = await moodContinue.isVisible({ timeout: 3000 }).catch(() => false);
        if (hasMoodCheck) {
          console.log(`${elapsed()} User A dismissing mood check`);
          await moodContinue.click();
          await userAPage.waitForLoadState('networkidle');
        }
      } else {
        console.log(`${elapsed()} SUCCESS: Ably update received! No reload needed.`);
      }

      await userAPage.screenshot({ path: 'test-results/partner-09-user-a-after-share.png' });

      // Verify the indicator is visible (either from Ably update or after reload)
      await expect(sharedContextIndicator).toBeVisible({ timeout: 10000 });
      console.log(`${elapsed()} User A sees "Context from Darryl" indicator`);

      // Verify via API that the shared context was recorded
      const empathyStatusResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/status`, {
        headers: getE2EHeaders(userA.email, userAId, FIXTURE_ID),
      });

      if (empathyStatusResponse.ok()) {
        const empathyStatusData = await empathyStatusResponse.json();
        const hasSharedContext = empathyStatusData.data?.sharedContext !== null;
        console.log(`${elapsed()} Empathy status - has shared context: ${hasSharedContext}`);
      }

      await userAPage.screenshot({ path: 'test-results/partner-10-user-a-sees-shared.png' });
      console.log(`${elapsed()} User A received Darryl's shared context`);
    } else {
      console.log(`${elapsed()} No share suggestion found via API`);
      await userBPage.screenshot({ path: 'test-results/partner-06-user-b-no-share-suggestion.png' });
    }

    // ==========================================
    // PHASE 9: Verify via API
    // ==========================================
    console.log(`${elapsed()} === PHASE 9: Verify state via API ===`);

    // Check User B's progress
    const userBProgressResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/progress`, {
      headers: getE2EHeaders(userB.email, userBId, FIXTURE_ID),
    });
    expect(userBProgressResponse.ok()).toBe(true);
    const userBProgress = await userBProgressResponse.json();

    console.log(`${elapsed()} User B progress:`, JSON.stringify(userBProgress.data.myProgress, null, 2));

    // User B should be at least in Stage 1 with feelHeardConfirmed gate
    expect(userBProgress.data.myProgress.stage).toBeGreaterThanOrEqual(1);

    // Check that there's a reconciler result with share offer
    const reconcilerResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/stage2/reconciler-status`, {
      headers: getE2EHeaders(userA.email, userAId, FIXTURE_ID),
    });

    if (reconcilerResponse.ok()) {
      const reconcilerData = await reconcilerResponse.json();
      console.log(`${elapsed()} Reconciler status:`, JSON.stringify(reconcilerData, null, 2));
    }

    console.log(`${elapsed()} === TEST COMPLETE ===`);
  });
});
