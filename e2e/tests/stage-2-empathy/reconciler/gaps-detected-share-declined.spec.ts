/**
 * Reconciler: Gaps Detected → Share Declined
 *
 * Tests the flow when User B declines to share context:
 * 1. User A has shared an empathy guess
 * 2. User B completes Stage 1 (feels heard)
 * 3. Reconciler detects gaps in User A's understanding
 * 4. User B sees share suggestion but declines
 * 5. User A does NOT receive shared context
 * 6. Both users can continue the conversation
 */

import { test, expect, devices, BrowserContext, Page } from '@playwright/test';
import { cleanupE2EData, getE2EHeaders, SessionBuilder, declineShareTopic } from '../../../helpers';

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

test.describe('Reconciler: Gaps Detected → Share Declined', () => {
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

    const agreeCheckbox = userBPage.getByTestId('compact-agree-checkbox');
    await expect(agreeCheckbox).toBeVisible({ timeout: 10000 });
    await agreeCheckbox.click();
    await userBPage.getByTestId('compact-sign-button').click();

    const moodContinue = userBPage.getByTestId('mood-check-continue-button');
    if (await moodContinue.isVisible({ timeout: 5000 }).catch(() => false)) {
      await moodContinue.click();
    }

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

    const feelHeardYes = userBPage.getByTestId('feel-heard-yes');
    await expect(feelHeardYes).toBeVisible({ timeout: 5000 });
    await feelHeardYes.click();
    await expect(feelHeardYes).not.toBeVisible({ timeout: 5000 });

    await userBPage.waitForTimeout(3000);
  }

  async function navigateToShareAndDecline() {
    // The share suggestion lives in the share-topic panel/drawer (mobile #602
    // removed the Activity drawer this spec used to open).
    const declineResponse = await declineShareTopic(userBPage);
    expect(declineResponse.status()).toBeLessThan(300);

    await userBPage.waitForTimeout(2000);
  }

  test.describe('Complete Journey', () => {
    test('User B declines to share → User A does not receive context, both can continue', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();
      console.log(`${elapsed()} User B completed Stage 1, reconciler triggered`);

      await navigateToShareAndDecline();
      console.log(`${elapsed()} User B declined to share`);

      // === VERIFY: User A does NOT see shared context ===
      await userAPage.waitForTimeout(3000);
      await userAPage.reload();
      await userAPage.waitForLoadState('networkidle');

      const moodCheck = userAPage.getByTestId('mood-check-continue-button');
      if (await moodCheck.isVisible({ timeout: 3000 }).catch(() => false)) {
        await moodCheck.click();
      }

      const sharedContextIndicator = userAPage.getByText('Context from Darryl', { exact: true });
      const hasSharedContext = await sharedContextIndicator.isVisible({ timeout: 5000 }).catch(() => false);
      expect(hasSharedContext).toBe(false);
      console.log(`${elapsed()} Verified: User A does NOT see shared context`);

      // === VERIFY: User B can continue chatting ===
      const userBParams = new URLSearchParams({
        'e2e-user-id': userBId,
        'e2e-user-email': userB.email,
      });
      await userBPage.goto(`${APP_BASE_URL}/session/${sessionId}?${userBParams.toString()}`);
      await userBPage.waitForLoadState('networkidle');

      const userBMoodContinue = userBPage.getByTestId('mood-check-continue-button');
      if (await userBMoodContinue.isVisible({ timeout: 3000 }).catch(() => false)) {
        await userBMoodContinue.click();
      }

      const chatInput = userBPage.getByTestId('chat-input');
      await expect(chatInput).toBeVisible({ timeout: 10000 });
      await expect(chatInput).toBeEnabled({ timeout: 5000 });

      await chatInput.fill("I want to understand their perspective better");
      await userBPage.getByTestId('send-button').click();
      await userBPage.waitForTimeout(5000);

      console.log(`${elapsed()} User B can continue conversation after declining`);
    });
  });

  test.describe('Empathy Flow Continues', () => {
    test('Empathy can still be revealed after User B declines to share', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();
      await navigateToShareAndDecline();

      console.log(`${elapsed()} User B declined - checking empathy status`);

      await userBPage.waitForTimeout(5000);

      // Verify empathy is not stuck in AWAITING_SHARING
      const empathyStatusResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/status`, {
        headers: getE2EHeaders(userA.email, userAId, FIXTURE_ID),
      });

      expect(empathyStatusResponse.ok()).toBe(true);
      const empathyData = await empathyStatusResponse.json();
      const myStatus = empathyData.data?.myAttempt?.status;

      console.log(`${elapsed()} User A empathy status: ${myStatus}`);

      // After declining, empathy should NOT be stuck in AWAITING_SHARING
      expect(myStatus).not.toBe('AWAITING_SHARING');
    });
  });
});
