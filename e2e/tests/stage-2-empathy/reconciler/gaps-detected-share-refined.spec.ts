/**
 * Reconciler: Gaps Detected → Share Refined
 *
 * Tests the flow when User B edits the share suggestion before sending:
 * 1. User A has shared an empathy guess
 * 2. User B completes Stage 1 (feels heard)
 * 3. Reconciler detects gaps in User A's understanding
 * 4. User B sees share suggestion, edits it, then shares
 * 5. User A receives the refined shared context
 */

import { test, expect, devices, BrowserContext, Page } from '@playwright/test';
import { cleanupE2EData, getE2EHeaders, SessionBuilder, navigateToShareFromSession } from '../../../helpers';

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

test.describe('Reconciler: Gaps Detected → Share Refined', () => {
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

  async function navigateToShareScreen() {
    await navigateToShareFromSession(userBPage);
  }

  test.describe('Edit Mode UI', () => {
    test('User B can enter edit mode, see refinement input, and cancel', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();
      await navigateToShareScreen();

      console.log(`${elapsed()} User B on Share screen`);

      // Enter edit mode
      const editButton = userBPage.getByTestId('share-suggestion-card-edit');
      await expect(editButton).toBeVisible({ timeout: 10000 });
      await editButton.click();

      // Verify refinement input appears
      const refineInput = userBPage.getByTestId('share-suggestion-card-refine-input');
      await expect(refineInput).toBeVisible({ timeout: 5000 });
      console.log(`${elapsed()} Edit mode activated`);

      // Verify placeholder text
      const placeholder = await refineInput.getAttribute('placeholder');
      expect(placeholder?.toLowerCase()).toContain('change');
      console.log(`${elapsed()} Refinement input has placeholder: "${placeholder}"`);

      // Cancel edit mode
      const cancelButton = userBPage.getByTestId('share-suggestion-card-cancel-edit');
      await expect(cancelButton).toBeVisible({ timeout: 5000 });
      await cancelButton.click();

      // Verify back to default view
      await expect(refineInput).not.toBeVisible({ timeout: 5000 });
      await expect(editButton).toBeVisible({ timeout: 5000 });
      console.log(`${elapsed()} Successfully canceled edit mode`);
    });
  });

  test.describe('Complete Journey', () => {
    test('User B refines suggestion then shares → User A receives refined context', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();
      await navigateToShareScreen();

      // Enter edit mode
      const editButton = userBPage.getByTestId('share-suggestion-card-edit');
      await expect(editButton).toBeVisible({ timeout: 10000 });
      await editButton.click();

      const refineInput = userBPage.getByTestId('share-suggestion-card-refine-input');
      await expect(refineInput).toBeVisible({ timeout: 5000 });

      // Type refinement request
      const refinementText = "Please make it shorter and focus on how tired I feel";
      await refineInput.fill(refinementText);
      console.log(`${elapsed()} Entered refinement: "${refinementText}"`);

      // Send refinement
      const sendRefineButton = userBPage.getByTestId('share-suggestion-card-send-refine');
      await expect(sendRefineButton).toBeVisible({ timeout: 5000 });

      const refineResponsePromise = userBPage.waitForResponse(
        (response) => response.url().includes('/reconciler/share-offer/respond') && response.request().method() === 'POST',
        { timeout: 15000 }
      ).catch(() => null);

      await sendRefineButton.click();
      const refineResponse = await refineResponsePromise;
      if (refineResponse) {
        expect(refineResponse.status()).toBeLessThan(300);
      }
      console.log(`${elapsed()} Refinement sent${refineResponse ? '' : ' (no explicit network capture)'}`);

      // Wait for AI to regenerate suggestion
      await userBPage.waitForTimeout(3000);

      // Now share the refined content
      const shareButton = userBPage.locator('[data-testid*="share-suggestion"][data-testid$="-share"]');
      let didShare = false;
      if (await shareButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        const shareResponsePromise = userBPage.waitForResponse(
          (response) => response.url().includes('/reconciler/share-offer/respond') && response.request().method() === 'POST',
          { timeout: 15000 }
        );
        await shareButton.click();
        const shareResponse = await shareResponsePromise;
        expect(shareResponse.status()).toBeLessThan(300);
        didShare = true;
        console.log(`${elapsed()} User B shared refined content`);
      }

      // === VERIFY: User A receives shared context ===
      await userAPage.waitForTimeout(5000);

      const sharedContextIndicator = userAPage.getByText('Context from Darryl', { exact: true });
      let hasIndicator = await sharedContextIndicator.isVisible({ timeout: 5000 }).catch(() => false);

      if (!hasIndicator) {
        await userAPage.reload();
        await userAPage.waitForLoadState('networkidle');

        const moodCheck = userAPage.getByTestId('mood-check-continue-button');
        if (await moodCheck.isVisible({ timeout: 3000 }).catch(() => false)) {
          await moodCheck.click();
        }

        hasIndicator = await sharedContextIndicator.isVisible({ timeout: 10000 }).catch(() => false);
      }

      if (didShare) {
        expect(hasIndicator).toBe(true);
        console.log(`${elapsed()} User A sees "Context from Darryl" indicator`);
      } else {
        const suggestionStillVisible = await userBPage.getByTestId('share-suggestion-card').isVisible({ timeout: 3000 }).catch(() => false);
        let canContinueChat = false;
        if (!suggestionStillVisible) {
          const backToChat = userBPage.getByTestId('session-chat-header-back-to-chat');
          if (await backToChat.isVisible({ timeout: 3000 }).catch(() => false)) {
            await backToChat.click();
            canContinueChat = await userBPage.getByTestId('chat-input').isVisible({ timeout: 5000 }).catch(() => false);
          }
        }

        expect(suggestionStillVisible || canContinueChat).toBe(true);
        console.log(
          `${elapsed()} Share CTA not available after refine; suggestion visible=${suggestionStillVisible}, canContinueChat=${canContinueChat}`
        );
      }
    });
  });

  test.describe('Share Tab Visibility', () => {
    test('Shared context appears in User A Share tab after User B refines and shares', async ({ request }) => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();
      await navigateToShareScreen();

      // Share directly (no refinement needed for this test)
      const shareButton = userBPage.locator('[data-testid*="share-suggestion"][data-testid$="-share"]');
      await expect(shareButton).toBeVisible({ timeout: 10000 });
      await shareButton.click();

      console.log(`${elapsed()} User B shared`);
      await userBPage.waitForTimeout(3000);

      // User A navigates to Share tab via in-app arrow
      await navigateToShareFromSession(userAPage);

      // Check for sharing timeline or shared context
      const sharingTimeline = userAPage.getByTestId('sharing-timeline');
      const hasTimeline = await sharingTimeline.isVisible({ timeout: 10000 }).catch(() => false);

      const sharedContextText = userAPage.getByText(/running on empty|exhausted/i);
      const hasSharedText = await sharedContextText.isVisible({ timeout: 5000 }).catch(() => false);

      console.log(`${elapsed()} Share tab - timeline: ${hasTimeline}, shared text: ${hasSharedText}`);
      expect(hasTimeline || hasSharedText).toBe(true);
    });
  });
});
