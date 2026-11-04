/**
 * Reconciler: Gaps Detected → Share Refined
 *
 * Tests the flow when User B edits the share suggestion before sending:
 * 1. User A has shared an empathy guess
 * 2. User B completes Stage 1 (feels heard)
 * 3. Reconciler detects gaps in User A's understanding
 * 4. User B opens the share suggestion, refines it in the refinement chat, then shares
 * 5. User A receives the refined shared context
 */

import { test, expect, devices, BrowserContext, Page } from '@playwright/test';
import { cleanupE2EData, getE2EHeaders, SessionBuilder, handleMoodCheck, openShareTopicDrawer, shareFromShareTopicDrawer, signCompact, waitForShareTopicPanel } from '../../../helpers';

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

    // Two-step Stage 0 (mobile #310): the agree checkbox is gone; the bar is a single Ready CTA.
    await signCompact(userBPage);

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

    // Reconciler runs async after feel-heard; without Ably the subject's
    // offer only appears on a fresh read (see waitForShareTopicPanel).
    await waitForShareTopicPanel(userBPage);
  }

  // The share suggestion lives in the share-topic panel/drawer; refining it happens
  // in the refinement modal ("Yes, help me share"). The inline edit mode of the old
  // share-suggestion card and the Activity drawer (mobile #602, 506c3f9a) are gone.
  async function openRefinementModal() {
    await openShareTopicDrawer(userBPage);
    await userBPage.getByTestId('share-topic-accept').click();
    const modal = userBPage.getByTestId('refinement-modal');
    await expect(modal).toBeVisible({ timeout: 15000 });
    // The drawer slides out over the modal; typing before it is gone loses the input.
    await expect(userBPage.getByTestId('share-topic-drawer')).not.toBeVisible({ timeout: 10000 });
    return modal;
  }

  async function expectUserASeesSharedContext() {
    const sharedContextLabel = userAPage.getByText('Context from Darryl', { exact: true });
    if (!(await sharedContextLabel.isVisible({ timeout: 8000 }).catch(() => false))) {
      await userAPage.reload();
      await userAPage.waitForLoadState('networkidle');
      await handleMoodCheck(userAPage, 3000);
    }
    await expect(sharedContextLabel).toBeVisible({ timeout: 10000 });
  }

  test.describe('Refinement UI', () => {
    // FIXME(work-m5d2): product bug. Accepting the share topic marks the offer
    // responded locally before the refinement modal opens, so closing the modal
    // without sharing leaves no share-topic panel (the banner still says "Review the
    // suggestion below") until a reload. Everything before the last assertion passes.
    test.fixme('User B can open the refinement chat for the suggestion and close it without sharing', async () => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();
      const modal = await openRefinementModal();
      console.log(`${elapsed()} Refinement modal open`);

      // The refinement chat has its own input and a share action
      await expect(modal.getByTestId('chat-input')).toBeVisible({ timeout: 5000 });
      await expect(userBPage.getByTestId('refinement-modal-share-button')).toBeVisible({ timeout: 15000 });

      // Closing without chatting leaves the suggestion unshared and still offered
      await userBPage.getByTestId('refinement-modal-close').click();
      await expect(modal).not.toBeVisible({ timeout: 5000 });
      await expect(userBPage.getByTestId('share-topic-panel')).toBeVisible({ timeout: 10000 });
      console.log(`${elapsed()} Closed refinement without sharing`);
    });
  });

  test.describe('Complete Journey', () => {
    test('User B refines suggestion then shares → User A receives refined context', async () => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();
      const modal = await openRefinementModal();

      // Ask for a refinement in the refinement chat.
      // Harness stub (work-h3lk): the refinement-chat handler has no MOCK_LLM path and
      // answers 500 in the hermetic suite, so this one AI turn is fulfilled here. The
      // refined text then goes through the real /refinement/finalize, and User A must
      // see exactly that text.
      const refinedContent = "I'm exhausted from work and it feels like no one sees how hard I'm trying.";
      await userBPage.route('**/reconciler/refinement/message', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { response: "Here's a shorter version that centres how tired you are.", proposedContent: refinedContent },
          }),
        })
      );
      const refinementText = 'Please make it shorter and focus on how tired I feel';
      const [refineResponse] = await Promise.all([
        userBPage.waitForResponse(
          (response) =>
            response.url().includes('/reconciler/refinement/message') && response.request().method() === 'POST',
          { timeout: 30000 }
        ),
        (async () => {
          await modal.getByTestId('chat-input').fill(refinementText);
          await modal.getByTestId('send-button').click();
        })(),
      ]);
      expect(refineResponse.status()).toBeLessThan(300);
      console.log(`${elapsed()} Refinement sent: "${refinementText}"`);

      // Share the (refined) version
      await expect(modal.getByText(refinedContent)).toBeVisible({ timeout: 15000 });
      // Each draft card carries its own share button; the newest card is the refined one.
      const shareButton = userBPage.getByTestId('refinement-modal-share-button').last();
      await expect(shareButton).toBeVisible({ timeout: 15000 });
      const [shareResponse] = await Promise.all([
        userBPage.waitForResponse(
          (response) =>
            response.url().includes('/reconciler/refinement/finalize') && response.request().method() === 'POST',
          { timeout: 15000 }
        ),
        shareButton.click(),
      ]);
      expect(shareResponse.status()).toBeLessThan(300);
      expect(shareResponse.request().postDataJSON()).toMatchObject({ content: refinedContent });
      console.log(`${elapsed()} User B shared refined content`);

      // === VERIFY: User A receives the refined shared context ===
      await expectUserASeesSharedContext();
      const frame = userAPage.locator('[data-testid^="chat-bubble-"]').filter({
        has: userAPage.getByText('Context from Darryl', { exact: true }),
      });
      await expect(frame).toContainText(refinedContent);
      console.log(`${elapsed()} User A sees the refined "Context from Darryl"`);
    });
  });

  test.describe('Shared Context Visibility', () => {
    test('Shared context appears in User A chat after User B shares', async () => {
      test.setTimeout(300000);
      const testStart = Date.now();
      const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

      await setupUserA();
      await completeUserBStage1();

      // Share directly (no refinement needed for this test)
      const shareResponse = await shareFromShareTopicDrawer(userBPage);
      expect(shareResponse.status()).toBeLessThan(300);
      console.log(`${elapsed()} User B shared`);

      // Shared context renders inline in User A's chat as a "Context from Darryl" frame
      await expectUserASeesSharedContext();
      const frame = userAPage.locator('[data-testid^="chat-bubble-"]').filter({
        has: userAPage.getByText('Context from Darryl', { exact: true }),
      });
      await expect(frame).toContainText(/running on empty|exhausted/i);
    });
  });
});
