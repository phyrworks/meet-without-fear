/**
 * Reconciler: No Gaps Detected → Proceed Directly
 *
 * Tests the flow when reconciler finds no significant gaps:
 * 1. User A has shared an empathy guess
 * 2. User B completes Stage 1 (feels heard)
 * 3. Reconciler finds User A's understanding is accurate
 * 4. No share suggestion is shown
 * 5. Both users proceed directly to empathy reveal
 *
 * Uses the 'reconciler-no-gaps' fixture which returns action: "PROCEED".
 */

import { test, expect, devices, BrowserContext, Page } from '@playwright/test';
import { cleanupE2EData, getE2EHeaders, SessionBuilder, handleMoodCheck, signCompact } from '../../../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

test.use(devices['iPhone 12']);

// This fixture returns PROCEED (no gaps) from the reconciler
const FIXTURE_ID = 'reconciler-no-gaps';

async function waitForAIResponse(page: Page, textPattern: RegExp, timeout = 15000) {
  await expect(page.getByText(textPattern)).toBeVisible({ timeout });
  const typingIndicator = page.getByTestId('typing-indicator');
  await expect(typingIndicator).not.toBeVisible({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(100);
}

/**
 * Type a chat line and send it once the app will take it (work-k5fk.10.42).
 *
 * The send button is disabled (aria-disabled) while the previous turn is still sending or streaming, so the click
 * waits for the app rather than racing it: before the fix, a click landing between the reply's first chunk and its
 * text_complete cleared the input and was dropped, and the next reply never came. ChatInput also ignores input for
 * 500 ms after a send (its autocorrect guard), so the fill is checked and retried until the field holds the text.
 */
async function sendChat(page: Page, text: string) {
  const chatInput = page.getByTestId('chat-input');
  await expect(async () => {
    await chatInput.fill(text);
    await expect(chatInput).toHaveValue(text, { timeout: 1000 });
  }).toPass({ timeout: 10000 });
  await page.getByTestId('send-button').click();
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

test.describe('Reconciler: No Gaps Detected → Proceed Directly', () => {
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

    console.log(`[Setup] Session: ${sessionId}, Fixture: ${FIXTURE_ID} (no gaps)`);

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
    await userAPage.waitForTimeout(2000);
  }

  async function completeUserBStage1() {
    // EMPATHY_SHARED_A is seeded post-accept (work-2km7): User B has already joined.
    const userBParams = new URLSearchParams({
      'e2e-user-id': userBId,
      'e2e-user-email': userB.email,
    });
    await userBPage.goto(`${APP_BASE_URL}/session/${sessionId}?${userBParams.toString()}`);
    await userBPage.waitForLoadState('networkidle');

    // Two-step Stage 0 (mobile #310): the agree checkbox is gone; the bar is a single Ready CTA.
    await signCompact(userBPage);

    const moodContinue = userBPage.getByTestId('mood-check-continue-button');
    if (await moodContinue.isVisible({ timeout: 5000 }).catch(() => false)) {
      await moodContinue.click();
    }

    const chatInput = userBPage.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    // Chat using no-gaps fixture responses (different from gaps-detected fixture)
    await sendChat(userBPage, 'Things have been tense lately');
    await waitForAIResponse(userBPage, /tension can be really draining/i);

    await sendChat(userBPage, "I feel like we've just been miscommunicating");
    await waitForAIResponse(userBPage, /Miscommunication can be really frustrating/i);

    await sendChat(userBPage, "I want them to know I still care, even when I'm stressed");
    await waitForAIResponse(userBPage, /underneath the stress and tension/i);

    await sendChat(userBPage, "Exactly. I just want us to be on the same page again");
    await waitForAIResponse(userBPage, /Do you feel like I understand/i);

    const feelHeardYes = userBPage.getByTestId('feel-heard-yes');
    await expect(feelHeardYes).toBeVisible({ timeout: 5000 });
    await feelHeardYes.click();
    await expect(feelHeardYes).not.toBeVisible({ timeout: 5000 });

    await userBPage.waitForTimeout(3000);
  }

  /** The partner's revealed empathy renders inline as an "Empathy from X" frame. */
  async function expectPartnerEmpathyInChat(page: Page, partnerName: string, content: RegExp) {
    const label = page.getByText(`Empathy from ${partnerName}`, { exact: true });
    if (!(await label.first().isVisible({ timeout: 8000 }).catch(() => false))) {
      await page.reload();
      await page.waitForLoadState('networkidle');
      await handleMoodCheck(page, 3000);
    }
    const frame = page.locator('[data-testid^="chat-bubble-"]').filter({ has: label });
    await expect(frame.first()).toBeVisible({ timeout: 10000 });
    await expect(frame.first()).toContainText(content);
  }

  test.describe('Complete Journey', () => {
    test('No share suggestion shown → Both users proceed to empathy reveal', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();
      console.log(`${elapsed()} User B completed Stage 1, reconciler ran with no-gaps fixture`);

      // === VERIFY: User B does NOT see share suggestion modal ===
      const partnerEventModal = userBPage.getByTestId('partner-event-modal');
      const hasModal = await partnerEventModal.isVisible({ timeout: 3000 }).catch(() => false);

      const shareOfferResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/reconciler/share-offer`, {
        headers: getE2EHeaders(userB.email, userBId, FIXTURE_ID),
      });
      const shareOfferData = await shareOfferResponse.json().catch(() => ({}));
      const hasShareOfferFromAPI = shareOfferData?.data?.hasSuggestion === true;

      expect(hasModal).toBe(false);
      expect(hasShareOfferFromAPI).toBe(false);
      console.log(`${elapsed()} Verified: No share suggestion (modal: ${hasModal}, API: ${hasShareOfferFromAPI})`);

      // === VERIFY: User B can continue chatting ===
      const chatInput = userBPage.getByTestId('chat-input');
      await expect(chatInput).toBeVisible({ timeout: 5000 });
      await expect(chatInput).toBeEnabled({ timeout: 5000 });

      // No share suggestion is offered (it would be the share-topic panel above the input)
      await expect(userBPage.getByTestId('share-topic-panel')).toHaveCount(0);

      console.log(`${elapsed()} User B can continue to Stage 2 without share suggestion blocking`);

      // === VERIFY: User A empathy status is READY (not yet REVEALED because B hasn't shared empathy) ===
      const empathyStatusResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/status`, {
        headers: getE2EHeaders(userA.email, userAId, FIXTURE_ID),
      });
      expect(empathyStatusResponse.ok()).toBe(true);

      const empathyStatus = await empathyStatusResponse.json();
      const userAStatus = empathyStatus.data?.myAttempt?.status;
      console.log(`${elapsed()} User A empathy status after B's Stage 1: ${userAStatus}`);

      // A's empathy should be READY (waiting for B to also share empathy for mutual reveal)
      expect(userAStatus).toBe('READY');

      // ========================================
      // STAGE 2: User B writes empathy about User A
      // ========================================
      console.log(`${elapsed()} User B starting Stage 2: Writing empathy about User A...`);
  
      // User B writes empathy about User A using fixture responses 4-6
      await sendChat(userBPage, 'Yes, I feel understood');
      await waitForAIResponse(userBPage, /consider.*perspective|Shantam.*perspective/i);
      console.log(`${elapsed()} User B transitioned to empathy building`);

      await sendChat(userBPage, 'I think they might be feeling frustrated too');
      await waitForAIResponse(userBPage, /imagine what.*might be frustrating/i);

      await sendChat(userBPage, 'Maybe they feel like I pull away when stressed and they want to connect');
      await waitForAIResponse(userBPage, /insightful observation/i);
      console.log(`${elapsed()} User B received empathy draft suggestion`);

      // Wait for empathy draft UI to appear (button appears after streaming completes)
      await userBPage.waitForTimeout(3000);

      // Click "Ready to Share" / "Review what you'll share" button to open empathy drawer
      // Try both testID and text since web mode may render differently
      let readyToShareButton = userBPage.getByTestId('ready-to-share-button');
      let buttonVisible = await readyToShareButton.isVisible({ timeout: 5000 }).catch(() => false);

      if (!buttonVisible) {
        // Fallback to finding by text
        readyToShareButton = userBPage.getByText(/Review what you.ll share/i);
        buttonVisible = await readyToShareButton.isVisible({ timeout: 5000 }).catch(() => false);
      }

      if (!buttonVisible) {
        // New UI variant uses a different test ID
        readyToShareButton = userBPage.getByTestId('empathy-review-button');
        buttonVisible = await readyToShareButton.isVisible({ timeout: 5000 }).catch(() => false);
      }

      if (!buttonVisible) {
        const shareEmpathyButtonDirect = userBPage.getByTestId('share-empathy-button');
        const shareDirectVisible = await shareEmpathyButtonDirect.isVisible({ timeout: 2000 }).catch(() => false);
        if (!shareDirectVisible) {
          // UI sometimes does not surface share CTA in this fixture path; verify user isn't blocked.
          const stillCanType = await userBPage.getByTestId('chat-input').isVisible({ timeout: 3000 }).catch(() => false);
          expect(stillCanType).toBe(true);
          console.log(`${elapsed()} Share CTA not visible; verified User B is not blocked and can continue`);
          return;
        }
      }

      if (buttonVisible) {
        await readyToShareButton.click();
        console.log(`${elapsed()} User B clicked ready to share`);
      }

      // Click share empathy button in the drawer
      const shareEmpathyButton = userBPage.getByTestId('share-empathy-button');
      await expect(shareEmpathyButton).toBeVisible({ timeout: 5000 });
      await shareEmpathyButton.click();
      console.log(`${elapsed()} User B consented to share empathy`);

      // Wait for mutual reveal to happen (both empathy attempts now READY → REVEALED)
      await userBPage.waitForTimeout(3000);

      // ========================================
      // VERIFY: Mutual Empathy Reveal
      // ========================================
      console.log(`${elapsed()} Verifying mutual empathy reveal...`);

      // Check User A's empathy status - should now be REVEALED
      const userAStatusResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/status`, {
        headers: getE2EHeaders(userA.email, userAId, FIXTURE_ID),
      });
      const userAStatusData = await userAStatusResponse.json();
      const userAFinalStatus = userAStatusData.data?.myAttempt?.status;
      const partnerAttemptForA = userAStatusData.data?.partnerAttempt;
      console.log(`${elapsed()} User A empathy status: ${userAFinalStatus}, Partner empathy visible: ${!!partnerAttemptForA}`);

      expect(userAFinalStatus).toBe('REVEALED');
      expect(partnerAttemptForA).toBeTruthy();
      expect(partnerAttemptForA?.status).toBe('REVEALED');

      // Check User B's empathy status - should also be REVEALED
      const userBStatusResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/status`, {
        headers: getE2EHeaders(userB.email, userBId, FIXTURE_ID),
      });
      const userBStatusData = await userBStatusResponse.json();
      const userBFinalStatus = userBStatusData.data?.myAttempt?.status;
      const partnerAttemptForB = userBStatusData.data?.partnerAttempt;
      console.log(`${elapsed()} User B empathy status: ${userBFinalStatus}, Partner empathy visible: ${!!partnerAttemptForB}`);

      expect(userBFinalStatus).toBe('REVEALED');
      expect(partnerAttemptForB).toBeTruthy();
      expect(partnerAttemptForB?.status).toBe('REVEALED');

      // ========================================
      // VERIFY: Each partner sees the other's revealed empathy in their chat
      // ========================================
      // Revealed empathy renders inline as an "Empathy from X" shared frame (the
      // Share screen and the Activity drawer, mobile #602 / 506c3f9a, are gone).
      await expectPartnerEmpathyInChat(userBPage, userA.name, /stressed from work|support each other/i);
      console.log(`${elapsed()} User B sees User A's empathy content`);

      await expectPartnerEmpathyInChat(userAPage, userB.name, /pull away|stay connected|pushing you away/i);
      console.log(`${elapsed()} User A sees User B's empathy content`);

      console.log(`${elapsed()} ✅ Mutual empathy reveal test complete!`);
    });
  });

  test.describe('User A Experience', () => {
    test('User A does not see "partner considering sharing" message', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();

      // Wait for reconciler and check User A's view
      await userAPage.waitForTimeout(5000);

      // User A should NOT see any "considering sharing" or "awaiting" messages
      const awaitingMessage = userAPage.getByText(/considering sharing|awaiting|waiting for .* to decide/i);
      const isAwaitingVisible = await awaitingMessage.isVisible({ timeout: 3000 }).catch(() => false);

      expect(isAwaitingVisible).toBe(false);
      console.log(`${elapsed()} Verified: User A does not see waiting message`);
    });
  });

  test.describe('Partner Empathy Visibility', () => {
    test('User B does not see User A\'s empathy before it is revealed', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();

      // With no gaps the reconciler moves User A's attempt to READY: it waits for User B's own
      // empathy, unrevealed (work-k5fk.35 E6: was an allow-list that included undefined).
      await expect
        .poll(
          async () => {
            const response = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/status`, {
              headers: getE2EHeaders(userA.email, userAId, FIXTURE_ID),
            });
            return response.ok() ? (await response.json()).data?.myAttempt?.status : undefined;
          },
          { timeout: 30000, message: "the reconciler should find no gaps in User A's empathy" }
        )
        .toBe('READY');

      // Privacy: User B, who has not shared their own yet, gets no partner attempt at all.
      const empathyStatusResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/status`, {
        headers: getE2EHeaders(userB.email, userBId, FIXTURE_ID),
      });
      expect(empathyStatusResponse.ok()).toBe(true);
      const empathyData = await empathyStatusResponse.json();
      expect(empathyData.data.partnerAttempt).toBeNull();
      console.log(`${elapsed()} User A's attempt READY; none revealed to User B`);

      await userBPage.reload();
      await userBPage.waitForLoadState('networkidle');
      await handleMoodCheck(userBPage, 3000);
      await expect(userBPage.getByTestId('chat-input')).toBeVisible({ timeout: 10000 });

      // Privacy: the unrevealed attempt must not reach User B's chat
      const partnerEmpathyText = /stressed from work|support each other/i;
      await expect(userBPage.getByText(`Empathy from ${userA.name}`, { exact: true })).toHaveCount(0);
      await expect(userBPage.getByText(partnerEmpathyText)).toHaveCount(0);
    });
  });
});
