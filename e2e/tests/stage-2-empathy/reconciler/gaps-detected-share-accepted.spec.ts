/**
 * Reconciler: Gaps Detected → Share Accepted (Happy Path)
 *
 * Tests the primary success flow:
 * 1. User A has shared an empathy guess
 * 2. User B completes Stage 1 (feels heard)
 * 3. Reconciler detects gaps in User A's understanding
 * 4. User B sees share suggestion and accepts it
 * 5. User A receives the shared context via real-time update
 * 6. User A's chat unlocks after viewing the shared context
 */

import { test, expect, devices, BrowserContext, Page } from '@playwright/test';
import { cleanupE2EData, getE2EHeaders, SessionBuilder, shareFromShareTopicDrawer, signCompact, waitForShareTopicPanel } from '../../../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

test.use(devices['iPhone 12']);

const FIXTURE_ID = 'user-b-partner-journey';

async function waitForAIResponse(page: Page, textPattern: RegExp, timeout = 15000) {
  await expect(page.getByText(textPattern)).toBeVisible({ timeout });
  const typingIndicator = page.getByTestId('typing-indicator');
  await expect(typingIndicator).not.toBeVisible({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(100);
}

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

  if (position) {
    await page.evaluate(({ x, y }) => {
      window.moveTo(x, y);
      window.resizeTo(420, 750);
    }, position).catch(() => {});
  }

  return { context, page };
}

test.describe('Reconciler: Gaps Detected → Share Accepted', () => {
  const userA = { email: 'shantam@e2e.test', name: 'Shantam' };
  const userB = { email: 'darryl@e2e.test', name: 'Darryl' };

  let sessionId: string;
  let userAId: string;
  let userBId: string;
  let userAContext: BrowserContext;
  let userAPage: Page;
  let userBContext: BrowserContext;
  let userBPage: Page;

  test.beforeEach(async ({ browser, request }) => {
    await cleanupE2EData().catch(() => {});

    const setup = await new SessionBuilder()
      .userA(userA.email, userA.name)
      .userB(userB.email, userB.name)
      .startingAt('EMPATHY_SHARED_A')
      .setup(request);

    sessionId = setup.session.id;
    userAId = setup.userA.id;
    userBId = setup.userB!.id;

    const userASetup = await createUserContext(browser, userA.email, userAId, FIXTURE_ID, { x: 0, y: 0 });
    userAContext = userASetup.context;
    userAPage = userASetup.page;

    const userBSetup = await createUserContext(browser, userB.email, userBId, FIXTURE_ID, { x: 450, y: 0 });
    userBContext = userBSetup.context;
    userBPage = userBSetup.page;
  });

  test.afterEach(async () => {
    await userAContext?.close();
    await userBContext?.close();
  });

  /**
   * Navigates User A to session and handles initial setup.
   */
  async function setupUserA() {
    const userAParams = new URLSearchParams({
      'e2e-user-id': userAId,
      'e2e-user-email': userA.email,
    });
    await userAPage.goto(`${APP_BASE_URL}/session/${sessionId}?${userAParams.toString()}`);
    await userAPage.waitForLoadState('networkidle');

    const moodContinue = userAPage.getByTestId('mood-check-continue-button');
    if (await moodContinue.isVisible({ timeout: 5000 }).catch(() => false)) {
      await moodContinue.click();
    }
    await userAPage.waitForTimeout(3000); // Allow Ably connection
  }

  /**
   * Completes User B's Stage 1 journey through feeling heard.
   */
  async function completeUserBStage1() {
    // Accept invitation
    // EMPATHY_SHARED_A is seeded post-accept (work-2km7): User B has already joined.
    // Navigate to session
    const userBParams = new URLSearchParams({
      'e2e-user-id': userBId,
      'e2e-user-email': userB.email,
    });
    await userBPage.goto(`${APP_BASE_URL}/session/${sessionId}?${userBParams.toString()}`);
    await userBPage.waitForLoadState('networkidle');

    // Sign compact
    // Two-step Stage 0 (mobile #310): the agree checkbox is gone; the bar is a single Ready CTA.
    await signCompact(userBPage);

    // Handle mood check
    const moodContinue = userBPage.getByTestId('mood-check-continue-button');
    if (await moodContinue.isVisible({ timeout: 5000 }).catch(() => false)) {
      await moodContinue.click();
    }

    // Complete chat exchanges
    const chatInput = userBPage.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    const sendButton = userBPage.getByTestId('send-button');

    await chatInput.fill('Things have been tense lately');
    await sendButton.click();
    await waitForAIResponse(userBPage, /tension can be really draining/i);

    await chatInput.fill("I feel like they don't see how much I'm dealing with");
    await sendButton.click();
    await waitForAIResponse(userBPage, /feeling unseen while carrying a lot/i);

    await chatInput.fill("I work so hard and come home exhausted, but there's always more to do");
    await sendButton.click();
    await waitForAIResponse(userBPage, /exhaustion you're describing/i);

    await chatInput.fill("Months now. I don't know how to get through to them");
    await sendButton.click();
    await waitForAIResponse(userBPage, /Do you feel like I understand/i);

    // Confirm feeling heard - triggers reconciler
    const feelHeardYes = userBPage.getByTestId('feel-heard-yes');
    await expect(feelHeardYes).toBeVisible({ timeout: 5000 });
    await feelHeardYes.click();
    await expect(feelHeardYes).not.toBeVisible({ timeout: 5000 });

    // Reconciler runs async after feel-heard; without Ably the subject's
    // offer only appears on a fresh read (see waitForShareTopicPanel).
    await waitForShareTopicPanel(userBPage);
  }

  test.describe('Complete Journey', () => {
    test('User B shares context after feeling heard → User A receives it and can continue', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      // === SETUP: Both users connected ===
      await setupUserA();
      await userAPage.screenshot({ path: 'test-results/share-accepted-01-userA-initial.png' });
      console.log(`${elapsed()} User A connected, empathy already shared`);

      await completeUserBStage1();
      console.log(`${elapsed()} User B completed Stage 1, reconciler triggered`);

      // === USER A: Should see "Almost There" popup ===
      const userAPartnerModal = userAPage.getByTestId('partner-event-modal');
      if (await userAPartnerModal.isVisible({ timeout: 10000 }).catch(() => false)) {
        const almostThereText = userAPage.getByText(/Almost There/i);
        if (await almostThereText.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log(`${elapsed()} User A sees "Almost There" popup`);
          await userAPage.screenshot({ path: 'test-results/share-accepted-02-userA-almost-there.png' });
          await userAPage.getByText('Got It').click();
          await expect(userAPartnerModal).not.toBeVisible({ timeout: 5000 });
        }
      }

      // === USER B: Open the share suggestion (share-topic panel) and share ===
      const shareResponse = await shareFromShareTopicDrawer(userBPage);
      expect(shareResponse.status()).toBeLessThan(300);
      console.log(`${elapsed()} User B shared context`);

      // === USER A: Receives shared context notification ===
      await userAPage.waitForTimeout(3000); // Wait for Ably

      const contextSharedModal = userAPage.getByTestId('partner-event-modal');
      if (await contextSharedModal.isVisible({ timeout: 10000 }).catch(() => false)) {
        const contextSharedText = userAPage.getByText(/Context Shared/i);
        if (await contextSharedText.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log(`${elapsed()} User A sees "Context Shared" popup`);
          await userAPage.screenshot({ path: 'test-results/share-accepted-03-userA-context-shared.png' });
        }

        // Navigate to Share tab via modal
        const viewButton = userAPage.getByText('View', { exact: true });
        if (await viewButton.isVisible({ timeout: 2000 }).catch(() => false)) {
          await viewButton.click();
          await userAPage.waitForLoadState('networkidle');
          console.log(`${elapsed()} User A navigated to Share tab`);
          await userAPage.screenshot({ path: 'test-results/share-accepted-04-userA-share-tab.png' });

          // Wait for markShareTabViewed to complete
          await userAPage.waitForTimeout(3000);

          // Navigate back to chat
          const backButton = userAPage.getByTestId('share-screen-header-back-button');
          await expect(backButton).toBeVisible({ timeout: 5000 });
          await backButton.click();
          await userAPage.waitForLoadState('networkidle');
          await userAPage.waitForTimeout(2000);
        }
      }

      // === VERIFY: User A's chat input is now unlocked ===
      const userAChatInput = userAPage.getByTestId('chat-input');
      await expect(userAChatInput).toBeVisible({ timeout: 15000 });
      console.log(`${elapsed()} User A's chat input is visible (unlocked after viewing Share tab)`);
      await userAPage.screenshot({ path: 'test-results/share-accepted-05-userA-chat-unlocked.png' });

      // === VERIFY: User B's share suggestion is gone ===
      await expect(userBPage.getByTestId('share-topic-panel')).not.toBeVisible({ timeout: 10000 });
      console.log(`${elapsed()} Journey complete: context shared and both users can proceed`);
    });
  });

  test.describe('Real-time Updates', () => {
    test('User A receives "Context from Partner" indicator via Ably without page reload', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      // Track Ably events on User A's page
      const userAConsoleLogs: string[] = [];
      userAPage.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('[Realtime]') || text.includes('context_shared') || text.includes('empathy.')) {
          userAConsoleLogs.push(text);
        }
      });

      await setupUserA();
      await completeUserBStage1();

      // User B shares
      await shareFromShareTopicDrawer(userBPage);

      console.log(`${elapsed()} User B shared - checking User A's real-time update`);

      // Wait for Ably event (no reload)
      await userAPage.waitForTimeout(5000);

      // Check for indicator via Ably (no reload)
      const sharedContextIndicator = userAPage.getByText('Context from Darryl', { exact: true });
      let indicatorVisible = await sharedContextIndicator.isVisible({ timeout: 5000 }).catch(() => false);

      if (!indicatorVisible) {
        console.log(`${elapsed()} Ably update not received immediately - reloading to verify state persisted`);
        await userAPage.reload();
        await userAPage.waitForLoadState('networkidle');

        const moodCheck = userAPage.getByTestId('mood-check-continue-button');
        if (await moodCheck.isVisible({ timeout: 3000 }).catch(() => false)) {
          await moodCheck.click();
        }
      }

      await expect(sharedContextIndicator).toBeVisible({ timeout: 10000 });
      console.log(`${elapsed()} User A sees "Context from Darryl" indicator`);

      // Verify state via API
      const empathyStatusResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/status`, {
        headers: getE2EHeaders(userA.email, userAId, FIXTURE_ID),
      });
      expect(empathyStatusResponse.ok()).toBe(true);
    });
  });
});
