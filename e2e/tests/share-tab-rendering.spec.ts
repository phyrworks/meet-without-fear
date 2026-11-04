/**
 * Shared Context Rendering Test (from database)
 *
 * Seeds a session at CONTEXT_SHARED_B (User B accepted the reconciler's share
 * offer; User A's empathy attempt is held back for refinement) and verifies how
 * the shared context renders when the session is loaded from the database.
 *
 * History: this spec used to open the Share screen, later the "Between you and..."
 * Activity drawer (e2e helper navigateToShareFromSession). Mobile #602 (506c3f9a)
 * removed the drawer; shared context and empathy statements are rendered inline in
 * the session chat as shared frames (ChatBubble: "Context shared with X" /
 * "Context from X" / "Empathy shared with X", plus a delivery line on content the
 * viewer sent). The guarantees this spec checks are unchanged:
 * 1. No duplicate copies of the shared context (the bug this spec was written for)
 * 2. The sender sees a delivered status, never "Not delivered yet"
 * 3. The share suggestion is not offered again once the content was shared
 * 4. The recipient sees the shared context and still sees their own empathy statement
 * 5. Privacy: the subject (User B) does not see User A's held empathy statement
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import { SessionBuilder, SessionSetupResult } from '../helpers/session-builder';
import { getE2EHeaders, handleMoodCheck } from '../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

// Test users
const userA = { email: 'render-test-shantam@e2e.test', name: 'Shantam' };
const userB = { email: 'render-test-darryl@e2e.test', name: 'Darryl' };

// Seeded content: backend/src/testing/fixture-scenarios/scenarios.ts
// (SHARE_CONTENT, ADA_EMPATHY_STATEMENT).
const SHARED_CONTEXT_TEXT = /running on empty/i;
const USER_A_EMPATHY_TEXT = /I understand you might be feeling stressed from work/i;

/**
 * Open the session chat as the given user, loading it from the database.
 */
async function openSessionChat(
  context: BrowserContext,
  sessionSetup: SessionSetupResult,
  user: 'A' | 'B'
): Promise<Page> {
  const userInfo = user === 'A' ? sessionSetup.userA : sessionSetup.userB;
  if (!userInfo) {
    throw new Error(`User ${user} not found in session setup`);
  }
  const page = await context.newPage();

  const url = `${APP_BASE_URL}/session/${sessionSetup.session.id}?e2e-user-id=${userInfo.id}&e2e-user-email=${encodeURIComponent(userInfo.email)}`;
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await handleMoodCheck(page, 3000);

  return page;
}

/** The inline shared-frame chat bubbles whose top-rule label is exactly `label`. */
function sharedFrames(page: Page, label: string) {
  return page.locator('[data-testid^="chat-bubble-"]').filter({
    has: page.getByText(label, { exact: true }),
  });
}

test.describe('Shared context rendering (from database)', () => {
  let setup: SessionSetupResult;

  test.beforeAll(async ({ request }) => {
    // Seed the session at CONTEXT_SHARED_B: User B has already shared context
    const builder = new SessionBuilder(API_BASE_URL);
    setup = await builder
      .userA(userA.email, userA.name)
      .userB(userB.email, userB.name)
      .startingAt('CONTEXT_SHARED_B')
      .setup(request);

    console.log('[Setup] Session:', setup.session.id);
    console.log('[Setup] User A:', setup.userA.id);
    console.log('[Setup] User B:', setup.userB?.id);
  });

  test.afterAll(async ({ request }) => {
    await request.post(`${API_BASE_URL}/api/e2e/cleanup`);
  });

  test('User B sees shared context once, delivered, without a repeat suggestion', async ({ browser }) => {
    const context = await browser.newContext({
      extraHTTPHeaders: getE2EHeaders(setup.userB!.email, setup.userB!.id),
    });
    const page = await openSessionChat(context, setup, 'B');

    const sentFrame = sharedFrames(page, `Context shared with ${userA.name}`);
    await expect(sentFrame).toHaveCount(1, { timeout: 15000 });
    await page.screenshot({ path: 'test-results/share-tab-user-b-view.png' });

    // THE KEY ASSERTION: the shared content renders exactly once. Before the fix it
    // rendered twice (one "Delivered", one "Not delivered yet").
    await expect(sentFrame).toContainText(SHARED_CONTEXT_TEXT);
    await expect(page.getByText(SHARED_CONTEXT_TEXT)).toHaveCount(1);

    // Delivery status is shown on the sender's frame, and never "Not delivered yet"
    await expect(sentFrame.getByText(/^(Delivered|✓ Seen)$/)).toBeVisible();
    await expect(page.getByText('Not delivered yet', { exact: true })).toHaveCount(0);

    // The share suggestion is not offered again (content was already shared)
    await expect(page.getByTestId('share-topic-panel')).toHaveCount(0);
    await expect(page.getByTestId('share-topic-drawer')).toHaveCount(0);

    // The acknowledgement that B shared it is in the chat
    await expect(page.getByText(/You shared this to help Shantam understand/i)).toBeVisible();

    // Privacy: A's empathy attempt is held for refinement, so B must not see it
    await expect(page.getByText(USER_A_EMPATHY_TEXT)).toHaveCount(0);
    await expect(page.getByText(`Empathy from ${userA.name}`, { exact: true })).toHaveCount(0);

    await context.close();
  });

  test('User A sees received context and their own empathy statement', async ({ browser }) => {
    const context = await browser.newContext({
      extraHTTPHeaders: getE2EHeaders(setup.userA.email, setup.userA.id),
    });
    const page = await openSessionChat(context, setup, 'A');

    // User A sees the context Darryl shared, once, in a received frame
    const receivedFrame = sharedFrames(page, `Context from ${userB.name}`);
    await expect(receivedFrame).toHaveCount(1, { timeout: 15000 });
    await page.screenshot({ path: 'test-results/share-tab-user-a-view.png' });
    await expect(receivedFrame).toContainText(SHARED_CONTEXT_TEXT);
    await expect(page.getByText(SHARED_CONTEXT_TEXT)).toHaveCount(1);

    // User A still sees their own empathy statement
    await expect(page.getByText(USER_A_EMPATHY_TEXT).first()).toBeVisible();

    await context.close();
  });

  test('Shared context still renders once after the partner has opened the session', async ({ browser }) => {
    // Runs after User A has loaded the session (previous test), so the delivery line
    // may read "Delivered" or "✓ Seen". Reloading must not duplicate the frame.
    const context = await browser.newContext({
      extraHTTPHeaders: getE2EHeaders(setup.userB!.email, setup.userB!.id),
    });
    const page = await openSessionChat(context, setup, 'B');

    const sentFrame = sharedFrames(page, `Context shared with ${userA.name}`);
    await expect(sentFrame).toHaveCount(1, { timeout: 15000 });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await handleMoodCheck(page, 3000);
    await page.screenshot({ path: 'test-results/share-tab-navigation-load.png' });

    await expect(sentFrame).toHaveCount(1, { timeout: 15000 });
    await expect(page.getByText(SHARED_CONTEXT_TEXT)).toHaveCount(1);
    await expect(sentFrame.getByText(/^(Delivered|✓ Seen)$/)).toBeVisible();

    await context.close();
  });
});
