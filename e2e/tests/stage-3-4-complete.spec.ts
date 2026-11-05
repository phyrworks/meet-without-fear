/**
 * Stage 3-4 Complete Flow Test
 *
 * Tests the flow from EMPATHY_REVEALED (Stage 2 complete) through:
 * - Stage 3: Need Mapping
 * - Stage 4: Strategic Repair
 *
 * Uses the 'EMPATHY_REVEALED' fixture which sets up:
 * - Both users have completed Stage 0 (compact signed)
 * - Both users have completed Stage 1 (feel heard)
 * - Both users have completed Stage 2 (empathy exchanged and validated)
 * - Both users are now in Stage 3 IN_PROGRESS
 */

import { test, expect, devices, BrowserContext, Page, APIRequestContext } from '@playwright/test';
import {
  cleanupE2EData,
  getE2EHeaders,
  SessionBuilder,
  expectNeedsComparisonFromApi,
  expectNeedsSummaryFromApi,
  waitForNeedsReveal,
  waitForStage,
  submitAndShareStage4Selections,
  closeStage4WithSharedAgreement,
} from '../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

// Test users
const userA = { email: 'stage3-4-shantam@e2e.test', name: 'Shantam' };
const userB = { email: 'stage3-4-darryl@e2e.test', name: 'Darryl' };

// Use the reconciler-no-gaps fixture for AI responses
const FIXTURE_ID = 'reconciler-no-gaps';

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

/**
 * Helper to make authenticated API requests for a specific user
 */
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

test.describe('Stage 3-4 Complete Flow', () => {
  let sessionId: string;
  let userAId: string;
  let userBId: string;
  let userAContext: BrowserContext;
  let userBContext: BrowserContext;
  let pageA: Page;
  let pageB: Page;

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

    // Create browser contexts for both users
    const userASetup = await createUserContext(browser, userA.email, userAId, FIXTURE_ID, { x: 0, y: 0 });
    const userBSetup = await createUserContext(browser, userB.email, userBId, FIXTURE_ID, { x: 450, y: 0 });
    userAContext = userASetup.context;
    userBContext = userBSetup.context;
    pageA = userASetup.page;
    pageB = userBSetup.page;
  });

  test.afterEach(async () => {
    await userAContext?.close();
    await userBContext?.close();
  });

  test('Complete Stage 3-4 flow from empathy revealed state', async ({ request }) => {
    test.setTimeout(180000);
    const testStart = Date.now();
    const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

    // Create API helpers for both users
    const apiA = makeApiRequest(request, userA.email, userAId, FIXTURE_ID);
    const apiB = makeApiRequest(request, userB.email, userBId, FIXTURE_ID);

    // Navigate both users to session
    const userAParams = new URLSearchParams({
      'e2e-user-id': userAId,
      'e2e-user-email': userA.email,
    });
    const userBParams = new URLSearchParams({
      'e2e-user-id': userBId,
      'e2e-user-email': userB.email,
    });

    await Promise.all([
      pageA.goto(`${APP_BASE_URL}/session/${sessionId}?${userAParams.toString()}`),
      pageB.goto(`${APP_BASE_URL}/session/${sessionId}?${userBParams.toString()}`),
    ]);

    await Promise.all([
      pageA.waitForLoadState('networkidle'),
      pageB.waitForLoadState('networkidle'),
    ]);

    console.log(`${elapsed()} Both users navigated to session`);

    // Take initial screenshot
    await pageA.screenshot({ path: 'test-results/stage-3-4-01-initial-user-a.png' });
    await pageB.screenshot({ path: 'test-results/stage-3-4-01-initial-user-b.png' });

    // ========================================
    // Handle mood check if visible
    // ========================================
    const moodCheckA = pageA.getByTestId('mood-check-continue-button');
    const moodVisibleA = await moodCheckA.isVisible({ timeout: 3000 }).catch(() => false);

    if (moodVisibleA) {
      console.log(`${elapsed()} Mood check visible on User A - clicking continue`);
      await moodCheckA.click();
      await pageA.waitForTimeout(1000);
    }

    const moodCheckB = pageB.getByTestId('mood-check-continue-button');
    const moodVisibleB = await moodCheckB.isVisible({ timeout: 2000 }).catch(() => false);

    if (moodVisibleB) {
      console.log(`${elapsed()} Mood check visible on User B - clicking continue`);
      await moodCheckB.click();
      await pageB.waitForTimeout(1000);
    }

    // ========================================
    // STAGE 3: Need Mapping
    // ========================================
    // Needs, strategies and the agreement are surfaced in the session chat
    // itself (the Share screen and its tabs went in 90842bc3; the Activity drawer
    // that replaced them went in mobile #602, 506c3f9a). Both partners start in
    // the Stage 3 chat.
    console.log(`${elapsed()} === STAGE 3: Need Mapping ===`);
    await Promise.all([
      expect(pageA.getByTestId('chat-input')).toBeVisible({ timeout: 15000 }),
      expect(pageB.getByTestId('chat-input')).toBeVisible({ timeout: 15000 }),
    ]);

    await pageA.screenshot({ path: 'test-results/stage-3-4-02-stage3-chat-user-a.png' });
    await pageB.screenshot({ path: 'test-results/stage-3-4-02-stage3-chat-user-b.png' });

    // Create needs via API (since AI extraction returns empty in mock mode)
    console.log(`${elapsed()} Creating needs via API...`);

    // User A creates needs
    const needA1Response = await apiA.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, {
      need: 'I need to feel appreciated for the work I do around the house',
      category: 'RECOGNITION',
    });
    const needA1 = await needA1Response.json();
    console.log(`${elapsed()} User A need 1 response: ${JSON.stringify(needA1)}`);

    const needA2Response = await apiA.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, {
      need: 'I need us to share responsibilities more equally',
      category: 'FAIRNESS',
    });
    const needA2 = await needA2Response.json();
    console.log(`${elapsed()} User A need 2 created: ${needA2.data?.need?.id}`);

    // User B creates needs
    const needB1Response = await apiB.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, {
      need: 'I need understanding about how exhausted I am after work',
      category: 'CONNECTION',
    });
    const needB1 = await needB1Response.json();
    console.log(`${elapsed()} User B need 1 created: ${needB1.data?.need?.id}`);

    const needB2Response = await apiB.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, {
      need: 'I need emotional support when I come home tired',
      category: 'SAFETY',
    });
    const needB2 = await needB2Response.json();
    console.log(`${elapsed()} User B need 2 created: ${needB2.data?.need?.id}`);

    // Get needs via API to get all IDs
    const needsResponseA = await apiA.get(`${API_BASE_URL}/api/sessions/${sessionId}/needs`);
    const needsDataA = await needsResponseA.json();
    console.log(`${elapsed()} User A needs: ${needsDataA.data?.needs?.length || 0} needs`);

    const needsResponseB = await apiB.get(`${API_BASE_URL}/api/sessions/${sessionId}/needs`);
    const needsDataB = await needsResponseB.json();
    console.log(`${elapsed()} User B needs: ${needsDataB.data?.needs?.length || 0} needs`);

    // Confirm needs via API
    const needsA = needsDataA.data?.needs || [];
    const needsB = needsDataB.data?.needs || [];
    expect(needsA.length, 'User A needs summary should not be empty').toBeGreaterThan(0);
    expect(needsB.length, 'User B needs summary should not be empty').toBeGreaterThan(0);
    await expectNeedsSummaryFromApi(apiA, API_BASE_URL, sessionId, 'User A');
    await expectNeedsSummaryFromApi(apiB, API_BASE_URL, sessionId, 'User B');

    if (needsA.length > 0) {
      const needIdsA = needsA.map((n: { id: string }) => n.id);
      console.log(`${elapsed()} User A confirming ${needIdsA.length} needs...`);

      // Confirm needs
      const confirmResponseA = await apiA.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs/confirm`, {
        needIds: needIdsA,
      });
      const confirmDataA = await confirmResponseA.json();
      console.log(`${elapsed()} User A confirmed needs: ${confirmDataA.data?.confirmed}`);

      // Consent to share needs
      const consentResponseA = await apiA.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs/consent`, {
        needIds: needIdsA,
      });
      const consentDataA = await consentResponseA.json();
      console.log(`${elapsed()} User A consented to share: ${consentDataA.data?.consented}`);
    }

    if (needsB.length > 0) {
      const needIdsB = needsB.map((n: { id: string }) => n.id);
      console.log(`${elapsed()} User B confirming ${needIdsB.length} needs...`);

      // Confirm needs
      const confirmResponseB = await apiB.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs/confirm`, {
        needIds: needIdsB,
      });
      const confirmDataB = await confirmResponseB.json();
      console.log(`${elapsed()} User B confirmed needs: ${confirmDataB.data?.confirmed}`);

      // Consent to share needs
      const consentResponseB = await apiB.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs/consent`, {
        needIds: needIdsB,
      });
      const consentDataB = await consentResponseB.json();
      console.log(`${elapsed()} User B consented to share: ${consentDataB.data?.consented}`);
    }

    console.log(`${elapsed()} Waiting for needs reveal...`);
    await waitForNeedsReveal(apiA, API_BASE_URL, sessionId, 'User A', 30000);
    await expectNeedsComparisonFromApi(apiA, API_BASE_URL, sessionId, 'User A');
    await expectNeedsComparisonFromApi(apiB, API_BASE_URL, sessionId, 'User B');

    await Promise.all([
      waitForStage(apiA, API_BASE_URL, sessionId, 4, 'User A', 30000),
      waitForStage(apiB, API_BASE_URL, sessionId, 4, 'User B', 30000),
    ]);
    console.log(`${elapsed()} Both users advanced to Stage 4`);

    // Reload pages to reflect new state
    await Promise.all([
      pageA.reload(),
      pageB.reload(),
    ]);
    await Promise.all([
      pageA.waitForLoadState('networkidle'),
      pageB.waitForLoadState('networkidle'),
    ]);

    // Screenshot after Stage 3 completion
    await pageA.screenshot({ path: 'test-results/stage-3-4-04-stage3-complete-user-a.png' });
    await pageB.screenshot({ path: 'test-results/stage-3-4-04-stage3-complete-user-b.png' });
    console.log(`${elapsed()} Stage 3 complete`);

    // ========================================
    // STAGE 4: Strategic Repair
    // ========================================
    console.log(`${elapsed()} === STAGE 4: Strategic Repair ===`);

    // Propose strategies via API
    console.log(`${elapsed()} Proposing strategies...`);

    const strategy1Response = await apiA.post(`${API_BASE_URL}/api/sessions/${sessionId}/strategies`, {
      description: 'Weekly check-in on Sundays to discuss the upcoming week and divide tasks',
      needsAddressed: ['Partnership', 'Appreciation'],
      duration: 'ongoing',
    });
    const strategy1 = await strategy1Response.json();
    console.log(`${elapsed()} User A strategy proposal response: ${JSON.stringify(strategy1)}`);

    const strategy2Response = await apiB.post(`${API_BASE_URL}/api/sessions/${sessionId}/strategies`, {
      description: 'Express appreciation for at least one thing your partner did each day',
      needsAddressed: ['Appreciation', 'Connection'],
      duration: 'ongoing',
    });
    const strategy2 = await strategy2Response.json();
    if (!strategy2.success) {
      console.log(`${elapsed()} User B strategy error: ${JSON.stringify(strategy2.error)}`);
    } else {
      console.log(`${elapsed()} User B proposed strategy: ${strategy2.data?.strategy?.id}`);
    }

    const strategy3Response = await apiA.post(`${API_BASE_URL}/api/sessions/${sessionId}/strategies`, {
      description: 'Take 10 minutes to decompress when arriving home before discussing responsibilities',
      needsAddressed: ['Understanding', 'Support'],
      duration: 'ongoing',
    });
    const strategy3 = await strategy3Response.json();
    console.log(`${elapsed()} User A proposed second strategy: ${strategy3.data?.strategy?.id}`);

    for (const [name, response] of [
      ['User A first proposal', strategy1Response],
      ['User B proposal', strategy2Response],
      ['User A second proposal', strategy3Response],
    ] as const) {
      expect(response.ok(), `${name} was not created`).toBe(true);
    }

    // Redesigned Stage 4 (ranking and overlap routes were dropped): everyone
    // takes a WILLING / NOT_WILLING stance per proposal, shares it, and mutual
    // WILLING closes as a shared agreement. Each call asserts its response.
    console.log(`${elapsed()} Submitting and sharing Stage 4 selections...`);
    await submitAndShareStage4Selections(apiA, API_BASE_URL, sessionId, 'User A');
    await submitAndShareStage4Selections(apiB, API_BASE_URL, sessionId, 'User B');

    await pageA.screenshot({ path: 'test-results/stage-3-4-05-strategies-user-a.png' });
    await pageB.screenshot({ path: 'test-results/stage-3-4-05-strategies-user-b.png' });

    console.log(`${elapsed()} Closing Stage 4 as a shared agreement...`);
    const closeData = await closeStage4WithSharedAgreement(apiA, API_BASE_URL, sessionId, 'User A');
    expect(closeData.data.closed).toBe(true);
    expect(closeData.data.outcome.kind).toBe('SHARED_AGREEMENT');
    expect(closeData.data.outcome.agreements.length).toBeGreaterThan(0);

    await pageA.screenshot({ path: 'test-results/stage-3-4-06-agreement-user-a.png' });
    await pageB.screenshot({ path: 'test-results/stage-3-4-06-agreement-user-b.png' });

    // Verify final state from both sides
    console.log(`${elapsed()} Verifying final state...`);
    for (const [label, api] of [['User A', apiA], ['User B', apiB]] as const) {
      const stateResponse = await api.get(`${API_BASE_URL}/api/sessions/${sessionId}/stage4`);
      expect(stateResponse.ok(), `${label} Stage 4 state`).toBe(true);
      const state = await stateResponse.json();
      expect(state.data?.outcome?.kind, `${label} sees the closed shared agreement`).toBe('SHARED_AGREEMENT');
      expect(state.data?.outcome?.agreements?.length).toBeGreaterThan(0);

      const tendingResponse = await api.get(`${API_BASE_URL}/api/sessions/${sessionId}/tending`);
      expect(tendingResponse.ok(), `${label} Tending list`).toBe(true);
      const tending = await tendingResponse.json();
      expect(tending.data?.entries?.length ?? 0, `${label} has scheduled Tending`).toBeGreaterThan(0);
    }

    // Take final screenshots
    await pageA.screenshot({ path: 'test-results/stage-3-4-07-final-user-a.png' });
    await pageB.screenshot({ path: 'test-results/stage-3-4-07-final-user-b.png' });

    console.log(`${elapsed()} === TEST COMPLETE ===`);
    console.log(`${elapsed()} Stage 3-4 flow verified successfully!`);
  });
});
