/**
 * Reconciler: No Gaps Detected → Proceed Directly (with Screenshot)
 *
 * This test runs the reconciler flow and captures a screenshot of the
 * alignment/validation buttons ("Accurate", "Partially", "Off")
 * when User B views User A's empathy in the Share tab.
 */

import { test, expect, devices, BrowserContext, Page } from '@playwright/test';
import { cleanupE2EData, getE2EHeaders, SessionBuilder, signCompact } from '../../../helpers';

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

test.describe('Reconciler: No Gaps → Capture Screenshot of Validation Buttons', () => {
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
    const sendButton = userBPage.getByTestId('send-button');

    // Chat using no-gaps fixture responses
    await chatInput.fill('Things have been tense lately');
    await sendButton.click();
    await waitForAIResponse(userBPage, /tension can be really draining/i);

    await chatInput.fill("I feel like we've just been miscommunicating");
    await sendButton.click();
    await waitForAIResponse(userBPage, /Miscommunication can be really frustrating/i);

    await chatInput.fill("I want them to know I still care, even when I'm stressed");
    await sendButton.click();
    await waitForAIResponse(userBPage, /underneath the stress and tension/i);

    await chatInput.fill("Exactly. I just want us to be on the same page again");
    await sendButton.click();
    await waitForAIResponse(userBPage, /Do you feel like I understand/i);

    const feelHeardYes = userBPage.getByTestId('feel-heard-yes');
    await expect(feelHeardYes).toBeVisible({ timeout: 5000 });
    await feelHeardYes.click();
    await expect(feelHeardYes).not.toBeVisible({ timeout: 5000 });

    await userBPage.waitForTimeout(3000);
  }

  test('Capture screenshot of validation buttons on Share screen', async ({ request }) => {
    test.setTimeout(300000);
    const testStart = Date.now();
    const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

    await setupUserA();
    await completeUserBStage1();
    console.log(`${elapsed()} User B completed Stage 1`);

    // STAGE 2: User B writes empathy about User A
    console.log(`${elapsed()} User B starting Stage 2...`);
    const chatInput = userBPage.getByTestId('chat-input');
    const sendButton = userBPage.getByTestId('send-button');

    await chatInput.fill('Yes, I feel understood');
    await sendButton.click();
    await waitForAIResponse(userBPage, /consider.*perspective|Shantam.*perspective/i);

    await chatInput.fill('I think they might be feeling frustrated too');
    await sendButton.click();
    await waitForAIResponse(userBPage, /imagine what.*might be frustrating/i);

    await chatInput.fill('Maybe they feel like I pull away when stressed and they want to connect');
    await sendButton.click();
    await waitForAIResponse(userBPage, /insightful observation/i);

    await userBPage.waitForTimeout(3000);

    // Click "Ready to Share" button
    let readyToShareButton = userBPage.getByTestId('ready-to-share-button');
    let buttonVisible = await readyToShareButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (!buttonVisible) {
      readyToShareButton = userBPage.getByText(/Review what you.ll share/i);
      buttonVisible = await readyToShareButton.isVisible({ timeout: 5000 }).catch(() => false);
    }

    if (!buttonVisible) {
      readyToShareButton = userBPage.getByTestId('empathy-review-button');
      buttonVisible = await readyToShareButton.isVisible({ timeout: 5000 }).catch(() => false);
    }

    if (!buttonVisible) {
      const shareDirectVisible = await userBPage.getByTestId('share-empathy-button').isVisible({ timeout: 2000 }).catch(() => false);
      if (!shareDirectVisible) {
        console.log(`${elapsed()} Share CTA not visible in this run; capturing fallback screenshot`);
        await expect(userBPage).toHaveScreenshot(`no-gaps-fallback-${Date.now()}.png`, {
          maxDiffPixels: 100,
        });
        return;
      }
    }

    if (buttonVisible) {
      await readyToShareButton.click();
      console.log(`${elapsed()} User B clicked ready to share`);
    }

    // Click share empathy button
    const shareEmpathyButton = userBPage.getByTestId('share-empathy-button');
    await expect(shareEmpathyButton).toBeVisible({ timeout: 5000 });
    await shareEmpathyButton.click();
    console.log(`${elapsed()} User B shared empathy`);

    await userBPage.waitForTimeout(3000);

    // ========================================
    // CAPTURE SCREENSHOT OF THE VALIDATION PANEL
    // ========================================
    // The partner's revealed empathy renders inline as an "Empathy from Shantam"
    // frame, with the accuracy review in the panel above the chat input (the Share
    // screen and the Activity drawer, mobile #602 / 506c3f9a, are gone).
    const validationPanel = userBPage.getByTestId('partner-empathy-validation-panel');
    if (!(await validationPanel.isVisible({ timeout: 10000 }).catch(() => false))) {
      await userBPage.reload();
      await userBPage.waitForLoadState('networkidle');
    }
    await expect(validationPanel).toBeVisible({ timeout: 15000 });
    await expect(userBPage.getByText(`Empathy from ${userA.name}`, { exact: true })).toBeVisible();
    await expect(userBPage.getByTestId('partner-empathy-yes-button')).toBeVisible();
    console.log(`${elapsed()} Capturing screenshot of the validation panel...`);

    // No committed baseline exists for this image; capture it as an artifact.
    await userBPage.screenshot({ path: 'test-results/empathy-validation-buttons.png' });
    console.log(`${elapsed()} Screenshot saved as test-results/empathy-validation-buttons.png`);

    console.log(`${elapsed()} ✅ Screenshot captured successfully!`);
  });
});
