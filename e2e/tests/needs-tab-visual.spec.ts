/**
 * Needs Review Visual Test
 *
 * Focused test for iterating on the Stage 3 needs UI. Starts at EMPATHY_REVEALED,
 * adds needs for both partners via the API, and opens User A's needs review.
 *
 * History: this spec opened the Share screen's Needs tab (removed in 90842bc3),
 * later via the Activity drawer (removed in mobile #602, 506c3f9a). A user's own
 * needs are now reviewed in the session's needs drawer, opened from the
 * "Review needs" panel above the chat input. The toHaveScreenshot baselines this
 * spec named were never committed, so it captures plain screenshots and asserts
 * the content instead.
 *
 * Privacy: User B has not shared their needs, so User A must not see them.
 */

import { test, expect, devices, BrowserContext, Page, APIRequestContext } from '@playwright/test';
import { cleanupE2EData, getE2EHeaders, SessionBuilder, handleMoodCheck } from '../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

// Test user
const userA = { email: 'needs-visual-test@e2e.test', name: 'Shantam' };
const userB = { email: 'needs-visual-partner@e2e.test', name: 'Darryl' };

async function createUserContext(
  browser: import('@playwright/test').Browser,
  userEmail: string,
  userId: string,
  fixtureId?: string
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...devices['iPhone 12'],
    extraHTTPHeaders: getE2EHeaders(userEmail, userId, fixtureId),
  });
  const page = await context.newPage();
  return { context, page };
}

function makeApiRequest(
  request: APIRequestContext,
  userEmail: string,
  userId: string,
  fixtureId?: string
) {
  const headers = getE2EHeaders(userEmail, userId, fixtureId);
  return {
    get: (url: string) => request.get(url, { headers }),
    post: (url: string, data?: object) => request.post(url, { headers, data }),
  };
}

test.describe('Needs Tab Visual', () => {
  let sessionId: string;
  let userAId: string;
  let userBId: string;
  let userAContext: BrowserContext;
  let pageA: Page;

  test.beforeEach(async ({ browser, request }) => {
    await cleanupE2EData().catch(() => {});

    // Start at EMPATHY_REVEALED - both users have completed Stage 2 and are in Stage 3
    const setup = await new SessionBuilder(API_BASE_URL)
      .userA(userA.email, userA.name)
      .userB(userB.email, userB.name)
      .startingAt('EMPATHY_REVEALED')
      .setup(request);

    sessionId = setup.session.id;
    userAId = setup.userA.id;
    userBId = setup.userB!.id;

    console.log(`[Setup] Session: ${sessionId} at EMPATHY_REVEALED stage`);

    // Create browser context for User A
    const userASetup = await createUserContext(browser, userA.email, userAId);
    userAContext = userASetup.context;
    pageA = userASetup.page;
  });

  test.afterEach(async () => {
    await userAContext?.close();
  });

  test('Needs drawer shows my needs and not my partner\'s unshared needs', async ({ request }) => {
    test.setTimeout(60000);

    const apiA = makeApiRequest(request, userA.email, userAId);
    const apiB = makeApiRequest(request, userB.email, userBId);

    // Create needs via API for User A
    // Note: The `need` field is what gets displayed as the description
    // The `category` field is the enum that gets displayed as the header
    console.log('Creating needs for User A...');
    await apiA.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, {
      need: 'I need to feel appreciated for the work I do around the house',
      category: 'RECOGNITION',
    });

    await apiA.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, {
      need: 'I need us to share responsibilities more equally',
      category: 'FAIRNESS',
    });

    await apiA.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, {
      need: 'I need us to talk about our schedules before making plans',
      category: 'CONNECTION',
    });

    // Create needs via API for User B
    console.log('Creating needs for User B...');
    await apiB.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, {
      need: 'I need you to understand how exhausted I am after work',
      category: 'CONNECTION',
    });

    await apiB.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, {
      need: 'I need emotional support when I come home tired',
      category: 'SAFETY',
    });

    const userANeeds = [
      'I need to feel appreciated for the work I do around the house',
      'I need us to share responsibilities more equally',
      'I need us to talk about our schedules before making plans',
    ];
    const userBNeeds = [
      'I need you to understand how exhausted I am after work',
      'I need emotional support when I come home tired',
    ];

    const userAParams = new URLSearchParams({
      'e2e-user-id': userAId,
      'e2e-user-email': userA.email,
    });
    await pageA.goto(`${APP_BASE_URL}/session/${sessionId}?${userAParams.toString()}`);
    await pageA.waitForLoadState('networkidle');
    await handleMoodCheck(pageA, 3000);

    // The compact "Review needs" panel above the chat input counts my needs
    // (a compact pressable GuidedActionPanel carries its primary action's testID)
    const needsPanel = pageA.getByTestId('needs-drawer-open-button');
    await expect(needsPanel).toBeVisible({ timeout: 15000 });
    await expect(needsPanel).toContainText('3 needs captured');
    await pageA.screenshot({ path: 'test-results/needs-tab-01-initial.png', fullPage: true });

    // Open the needs drawer
    await needsPanel.click();
    const needsDrawer = pageA.getByTestId('needs-drawer');
    await expect(needsDrawer).toBeVisible({ timeout: 10000 });
    await pageA.screenshot({ path: 'test-results/needs-tab-02-clicked.png', fullPage: true });

    // Each of my needs is listed with its category header
    for (const need of userANeeds) {
      await expect(needsDrawer.getByText(need, { exact: true })).toBeVisible();
    }
    for (const category of ['RECOGNITION', 'FAIRNESS', 'CONNECTION']) {
      await expect(needsDrawer.getByText(category, { exact: true })).toBeVisible();
    }
    await expect(needsDrawer.locator('[data-testid^="needs-drawer-row-"]')).toHaveCount(userANeeds.length);

    // Privacy: User B has not shared their needs, so User A cannot see them anywhere
    for (const need of userBNeeds) {
      await expect(pageA.getByText(need)).toHaveCount(0);
    }

    await pageA.screenshot({ path: 'test-results/needs-tab-final.png', fullPage: true });
  });
});
