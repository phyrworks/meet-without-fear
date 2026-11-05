/**
 * Full Partner Journey E2E Test
 *
 * Tests the complete two-user partner journey from Stages 0-4 (complete session).
 * This is the final verification that both users can reliably complete the full
 * partner session together.
 *
 * SUCCESS CRITERIA:
 * - Both users complete Stage 0 (compact signing)
 * - Both users complete Stage 1 (witnessing + feel-heard)
 * - Both users complete Stage 2 (empathy drafting + sharing + reconciler)
 * - Both users complete Stage 3 (needs extraction + mutual needs sharing)
 * - Both users complete Stage 4 (proposals + willingness selections + shared-agreement closure)
 * - Closure schedules Tending entries
 * - Test passes 3 consecutive runs without flakiness
 *
 * This test composes the proven patterns from two-browser-stage-2.spec.ts,
 * two-browser-stage-3.spec.ts, and two-browser-stage-4.spec.ts into a
 * dedicated full-flow test focused on the "proof" use case for milestone validation.
 */

import { test, expect, devices, APIRequestContext } from '@playwright/test';
import { TwoBrowserHarness, getE2EHeaders } from '../helpers';
import {
  signCompact,
  handleMoodCheck,
  completeInviterInvitationFlow,
  sendAndWaitForPanel,
  confirmFeelHeard,
  waitForReconcilerComplete,
  confirmNeedsSummaryAndConsent,
  expectNeedsComparisonFromApi,
  expectNeedsSummaryFromApi,
  waitForNeedsReveal,
  waitForStage,
  submitAndShareStage4Selections,
  closeStage4WithSharedAgreement,
} from '../helpers/test-utils';

// Use iPhone 12 viewport
test.use(devices['iPhone 12']);

// API base URL for Stage 3-4 operations
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

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

async function ensureNeedsSummary(
  api: ReturnType<typeof makeApiRequest>,
  sessionId: string,
  needs: Array<{ need: string; category: string }>
): Promise<void> {
  const response = await api.get(`${API_BASE_URL}/api/sessions/${sessionId}/needs`);
  const data = await response.json();
  if ((data.data?.needs?.length ?? 0) > 0) {
    return;
  }

  for (const need of needs) {
    const createResponse = await api.post(`${API_BASE_URL}/api/sessions/${sessionId}/needs`, need);
    expect(createResponse.ok(), `Failed to seed Stage 3 need: ${need.need}`).toBe(true);
  }
}

test.describe('Full Partner Journey: Stages 0-4', () => {
  let harness: TwoBrowserHarness;

  test.beforeEach(async ({ browser, request }) => {
    // Create harness with asymmetric fixtures:
    // User A: user-a-full-journey (no reconciler ops, shares first)
    // User B: reconciler-no-gaps (reconciler ops, shares second triggers reconciler)
    harness = new TwoBrowserHarness({
      userA: {
        email: 'full-flow-a@e2e.test',
        name: 'Shantam',
        fixtureId: 'user-a-full-journey',
      },
      userB: {
        email: 'full-flow-b@e2e.test',
        name: 'Darryl',
        fixtureId: 'reconciler-no-gaps',
      },
    });

    // Clean up database
    await harness.cleanup();

    // Set up User A and create session
    await harness.setupUserA(browser, request);
    await harness.createSession();
  });

  test.afterEach(async () => {
    await harness.teardown();
  });

  test('both users complete full session: Stages 0-4', async ({ browser, request }) => {
    test.setTimeout(900000); // 15 minutes - Stage 2 requires 13 AI interactions

    // ==========================================
    // === STAGE 0: COMPACT SIGNING ===
    // ==========================================

    // The inviter must confirm the topic before the invitation is acceptable.
    await harness.navigateUserA();
    await signCompact(harness.userAPage);
    await handleMoodCheck(harness.userAPage);
    await completeInviterInvitationFlow(harness.userAPage);

    await harness.setupUserB(browser, request);
    await harness.acceptInvitation();
    await harness.navigateUserB();
    await signCompact(harness.userBPage);
    await handleMoodCheck(harness.userBPage);

    // Verify both see chat input
    await expect(harness.userAPage.getByTestId('chat-input')).toBeVisible();
    await expect(harness.userBPage.getByTestId('chat-input')).toBeVisible();

    // ==========================================
    // === STAGE 1: USER A WITNESSING ===
    // ==========================================

    // Send remaining messages until feel-heard panel appears
    const remainingMessagesA = [
      'Thanks, I sent the invitation', // Response 2: post-invitation
      "I feel like I do most of the work and they don't notice or appreciate it", // Response 3: FeelHeardCheck: Y
    ];
    await sendAndWaitForPanel(harness.userAPage, remainingMessagesA, 'feel-heard-yes', 2);

    // User A confirms feel-heard
    await confirmFeelHeard(harness.userAPage);

    // ==========================================
    // === STAGE 1: USER B WITNESSING ===
    // ==========================================

    // User B sends messages matching reconciler-no-gaps fixture
    const userBStage1Messages = [
      'Things have been tense lately', // Response 0
      "I feel like we've just been miscommunicating", // Response 1
      "I want them to know I still care, even when I'm stressed", // Response 2
      'Exactly. I just want us to be on the same page again', // Response 3: FeelHeardCheck: Y
    ];

    await sendAndWaitForPanel(harness.userBPage, userBStage1Messages, 'feel-heard-yes', 4);

    // User B confirms feel-heard
    await confirmFeelHeard(harness.userBPage);

    // ==========================================
    // === STAGE 2: BOTH USERS DRAFT EMPATHY ===
    // ==========================================
    // IMPORTANT: Both users must complete empathy drafting BEFORE either shares.
    // When User A shares empathy, the backend generates a transition message
    // delivered to User B via Ably, which injects an extra AI message into
    // User B's chat and breaks waitForAnyAIResponse's message counting.

    // --- User A empathy draft ---
    // Response 4: Post-feel-heard transition
    // Response 5: ReadyShare: Y with empathy draft
    const userAStage2Messages = [
      'Yes, I feel heard now', // Response 4: post-feel-heard
      'I guess they might be stressed from work too', // Response 5: ReadyShare: Y, empathy draft
    ];

    await sendAndWaitForPanel(harness.userAPage, userAStage2Messages, 'empathy-review-button', 2);

    // --- User B empathy draft ---
    // Response 4: Post-feel-heard
    // Response 5: Empathy building
    // Response 6: ReadyShare: Y with empathy draft
    const userBStage2Messages = [
      'Yes, I feel understood', // Response 4: post-feel-heard
      'I think they might be feeling frustrated too', // Response 5: empathy building
      'Maybe they feel like I pull away when stressed and they want to connect', // Response 6: ReadyShare: Y
    ];

    await sendAndWaitForPanel(harness.userBPage, userBStage2Messages, 'empathy-review-button', 3);

    // ==========================================
    // === STAGE 2: BOTH USERS SHARE EMPATHY ===
    // ==========================================
    // User A shares first (has no reconciler operations).
    // User B shares second (triggers reconciler via reconciler-no-gaps fixture).

    // --- User A shares ---
    const empathyReviewButton = harness.userAPage.getByTestId('empathy-review-button');
    await expect(empathyReviewButton).toBeVisible({ timeout: 5000 });
    // Use JS click to bypass pointer-events: none from typewriter animation wrapper
    await empathyReviewButton.evaluate((el: HTMLElement) => el.click());

    const shareEmpathyButton = harness.userAPage.getByTestId('share-empathy-button');
    await expect(shareEmpathyButton).toBeVisible({ timeout: 5000 });
    await shareEmpathyButton.evaluate((el: HTMLElement) => el.click());

    // Wait for Ably event delivery (User A's share triggers transition message to User B)
    await harness.userAPage.waitForTimeout(2000);

    // --- User B shares (triggers reconciler) ---
    const empathyReviewButtonB = harness.userBPage.getByTestId('empathy-review-button');
    await expect(empathyReviewButtonB).toBeVisible({ timeout: 5000 });
    await empathyReviewButtonB.evaluate((el: HTMLElement) => el.click());

    const shareEmpathyButtonB = harness.userBPage.getByTestId('share-empathy-button');
    await expect(shareEmpathyButtonB).toBeVisible({ timeout: 5000 });
    await shareEmpathyButtonB.evaluate((el: HTMLElement) => el.click());

    // ==========================================
    // === RECONCILER COMPLETION ===
    // ==========================================

    // Wait 2s for reconciler trigger, then poll with waitForReconcilerComplete
    await harness.userAPage.waitForTimeout(2000);

    const userAReconcilerComplete = await waitForReconcilerComplete(harness.userAPage, 60000);
    if (!userAReconcilerComplete) {
      // Take diagnostic screenshots if reconciler timeout
      await harness.userAPage.screenshot({ path: 'test-results/full-flow-user-a-reconciler-timeout.png' });
      await harness.userBPage.screenshot({ path: 'test-results/full-flow-user-b-reconciler-timeout.png' });
      throw new Error('Reconciler did not complete within 60s for User A');
    }

    // Also check User B sees empathy-shared indicator
    const userBReconcilerComplete = await waitForReconcilerComplete(harness.userBPage, 60000);
    if (!userBReconcilerComplete) {
      await harness.userBPage.screenshot({ path: 'test-results/full-flow-user-b-reconciler-timeout.png' });
      throw new Error('Reconciler did not complete within 60s for User B');
    }

    // ==========================================
    // === STAGE 3: VERIFY INLINE EMPATHY REVIEW ===
    // ==========================================

    // Create API helpers for both users (needed for empathy validation and Stage 3-4 ops)
    const apiA = makeApiRequest(
      request,
      harness.config.userA.email,
      harness.userAId,
      harness.config.userA.fixtureId
    );
    const apiB = makeApiRequest(
      request,
      harness.config.userB.email,
      harness.userBId,
      harness.config.userB.fixtureId
    );

    // The redesigned session keeps partner empathy and accuracy feedback inline
    // in chat instead of navigating to the retired Share tab.
    await expect(harness.userAPage.getByTestId('partner-empathy-validation-panel'))
      .toBeVisible({ timeout: 30000 });
    await expect(harness.userBPage.getByTestId('partner-empathy-validation-panel'))
      .toBeVisible({ timeout: 30000 });
    await expect(harness.userAPage.getByTestId('partner-empathy-yes-button')).toBeVisible();
    await expect(harness.userBPage.getByTestId('partner-empathy-yes-button')).toBeVisible();

    // ==========================================
    // === STAGE 2 → STAGE 3 TRANSITION ===
    // ==========================================
    // CRITICAL: Both users must validate each other's empathy to trigger the
    // Stage 3 (Need Mapping) transition. Without this, Stage 3 never begins
    // and the needs extraction API returns empty data.

    await Promise.all([
      apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/empathy/validate`, {
        validated: true,
      }),
      apiB.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/empathy/validate`, {
        validated: true,
      }),
    ]);

    // Allow time for stage transition processing (backend creates Stage 3 progress records)
    await harness.userAPage.waitForTimeout(2000);

    // ==========================================
    // === STAGE 3: VERIFY CHAT CONTINUES ===
    // ==========================================

    // Handle a mood check if the stage transition presents one.
    await handleMoodCheck(harness.userAPage);
    await handleMoodCheck(harness.userBPage);

    // Verify chat input visible for both users (Stage 3 continues conversation)
    await expect(harness.userAPage.getByTestId('chat-input')).toBeVisible({ timeout: 5000 });
    await expect(harness.userBPage.getByTestId('chat-input')).toBeVisible({ timeout: 5000 });

    // Take screenshots after Stage 2 completion
    await expect(harness.userAPage).toHaveScreenshot('full-flow-01-stage2-complete-user-a.png', {
      maxDiffPixels: 500,
    });
    await expect(harness.userBPage).toHaveScreenshot('full-flow-02-stage2-complete-user-b.png', {
      maxDiffPixels: 500,
    });

    // ==========================================
    // === STAGE 3: NEEDS EXTRACTION ===
    // ==========================================

    // Trigger needs extraction for both users
    await Promise.all([
      apiA.get(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs`),
      apiB.get(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs`),
    ]);

    // The current Stage 3 contract waits for a Stage 3 conversation turn before
    // automatic extraction. This legacy full-flow test advances via API, so seed
    // deterministic needs only when extraction has not produced any yet.
    await Promise.all([
      ensureNeedsSummary(apiA, harness.sessionId, [
        {
          need: 'I need to feel appreciated for the work I do around the house',
          category: 'RECOGNITION',
        },
        {
          need: 'I need us to share responsibilities more equally',
          category: 'FAIRNESS',
        },
      ]),
      ensureNeedsSummary(apiB, harness.sessionId, [
        {
          need: 'I need understanding about how exhausted I am after work',
          category: 'CONNECTION',
        },
        {
          need: 'I need emotional support when I come home tired',
          category: 'SAFETY',
        },
      ]),
    ]);

    // Wait for extraction to complete
    await harness.userAPage.waitForTimeout(2000);

    // Reload both pages to show the needs drawer CTA
    await Promise.all([
      harness.userAPage.reload(),
      harness.userBPage.reload(),
    ]);

    await Promise.all([
      harness.userAPage.waitForLoadState('networkidle'),
      harness.userBPage.waitForLoadState('networkidle'),
    ]);

    // Handle mood check after reload
    await handleMoodCheck(harness.userAPage);
    await handleMoodCheck(harness.userBPage);

    await expectNeedsSummaryFromApi(apiA, API_BASE_URL, harness.sessionId, 'User A');
    await expectNeedsSummaryFromApi(apiB, API_BASE_URL, harness.sessionId, 'User B');
    await expect(harness.userAPage.getByTestId('needs-drawer-open-button')).toBeVisible({ timeout: 30000 });
    await expect(harness.userBPage.getByTestId('needs-drawer-open-button')).toBeVisible({ timeout: 30000 });

    // Screenshot needs CTA state
    await expect(harness.userAPage).toHaveScreenshot('full-flow-03-needs-cta-user-a.png', {
      maxDiffPixels: 500,
    });
    await expect(harness.userBPage).toHaveScreenshot('full-flow-04-needs-cta-user-b.png', {
      maxDiffPixels: 500,
    });

    await confirmNeedsSummaryAndConsent(harness.userAPage, apiA, API_BASE_URL, harness.sessionId, 'User A');
    await confirmNeedsSummaryAndConsent(harness.userBPage, apiB, API_BASE_URL, harness.sessionId, 'User B');
    await waitForNeedsReveal(apiA, API_BASE_URL, harness.sessionId, 'User A', 30000);

    // Reload both pages to show needs reveal UI
    await Promise.all([
      harness.userAPage.reload(),
      harness.userBPage.reload(),
    ]);

    await Promise.all([
      harness.userAPage.waitForLoadState('networkidle'),
      harness.userBPage.waitForLoadState('networkidle'),
    ]);

    // Handle mood check after reload
    await handleMoodCheck(harness.userAPage);
    await handleMoodCheck(harness.userBPage);

    await expectNeedsComparisonFromApi(apiA, API_BASE_URL, harness.sessionId, 'User A');
    await expectNeedsComparisonFromApi(apiB, API_BASE_URL, harness.sessionId, 'User B');

    // Screenshot needs reveal state
    await expect(harness.userAPage).toHaveScreenshot('full-flow-05-common-ground-user-a.png', {
      maxDiffPixels: 500,
    });
    await expect(harness.userBPage).toHaveScreenshot('full-flow-06-common-ground-user-b.png', {
      maxDiffPixels: 500,
    });

    // ==========================================
    // === STAGE 3 → STAGE 4 TRANSITION ===
    // ==========================================
    // The backend creates Stage 4 as soon as both users send needs.

    await Promise.all([
      waitForStage(apiA, API_BASE_URL, harness.sessionId, 4, 'User A', 30000),
      waitForStage(apiB, API_BASE_URL, harness.sessionId, 4, 'User B', 30000),
    ]);

    // ==========================================
    // === STAGE 4: STRATEGIES & AGREEMENT ===
    // ==========================================

    // Propose strategies via API - User A proposes 2, User B proposes 1 (3 total)
    const strategyA1Response = await apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies`, {
      description: 'Have a 10-minute phone-free conversation at dinner each day',
      needsAddressed: ['Connection', 'Recognition'],
    });
    expect(strategyA1Response.ok(), 'User A first strategy was not created').toBe(true);

    const strategyA2Response = await apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies`, {
      description: 'Use a pause signal when conversations get heated',
      needsAddressed: ['Safety', 'Connection'],
    });
    expect(strategyA2Response.ok(), 'User A second strategy was not created').toBe(true);

    const strategyB1Response = await apiB.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies`, {
      description: 'Say one specific thing I appreciate each morning',
      needsAddressed: ['Recognition'],
    });
    expect(strategyB1Response.ok(), 'User B strategy was not created').toBe(true);

    // Redesigned Stage 4: proposals are Proposal rows; each partner takes a
    // WILLING / NOT_WILLING stance per proposal (private until shared,
    // milestone choices_shared); mutual WILLING closes as a shared agreement
    // and schedules Tending. Ranking and the pre-redesign agreement
    // confirmation were dropped, so those routes are not exercised here.
    const stage4Url = `${API_BASE_URL}/api/sessions/${harness.sessionId}/stage4`;
    const stateA0 = await (await apiA.get(stage4Url)).json();
    const stateB0 = await (await apiB.get(stage4Url)).json();
    for (const [label, state] of [['User A', stateA0], ['User B', stateB0]] as const) {
      const descriptions = state.data?.inventory?.sharedProposals?.map((p: { description: string }) => p.description);
      expect(descriptions, `${label} should see all three proposals in the Stage 4 inventory`).toEqual(
        expect.arrayContaining([
          'Have a 10-minute phone-free conversation at dinner each day',
          'Use a pause signal when conversations get heated',
          'Say one specific thing I appreciate each morning',
        ])
      );
      expect(state.data?.mySelectionStatus).toBe('NOT_STARTED');
      expect(state.data?.outcome).toBeNull();
    }

    // Both stand WILLING on every proposal and share. Selections stay private
    // until the partner has shared too: after A shares alone, A sees no
    // partner decision on any proposal.
    await submitAndShareStage4Selections(apiA, API_BASE_URL, harness.sessionId, 'User A');
    const heldState = await (await apiA.get(stage4Url)).json();
    expect(heldState.data?.partnerSelectionStatus).toBe('NOT_STARTED');
    for (const proposal of heldState.data.inventory.sharedProposals) {
      expect(proposal.partnerDecisionVisible, 'partner stance must stay hidden until both share').toBeUndefined();
    }
    await submitAndShareStage4Selections(apiB, API_BASE_URL, harness.sessionId, 'User B');

    // No Ably in hermetic E2E: reload to pick up the revealed Stage 4 state.
    await Promise.all([harness.userAPage.reload(), harness.userBPage.reload()]);
    await Promise.all([
      harness.userAPage.waitForLoadState('networkidle'),
      harness.userBPage.waitForLoadState('networkidle'),
    ]);
    await handleMoodCheck(harness.userAPage);
    await handleMoodCheck(harness.userBPage);

    const closeData = await closeStage4WithSharedAgreement(apiA, API_BASE_URL, harness.sessionId, 'User A');
    expect(closeData.data.closed).toBe(true);
    expect(closeData.data.outcome.kind).toBe('SHARED_AGREEMENT');
    expect(closeData.data.outcome.agreements.length).toBeGreaterThanOrEqual(1);

    const finalB = await (await apiB.get(stage4Url)).json();
    expect(finalB.data?.outcome?.kind, 'User B sees the closed shared agreement').toBe('SHARED_AGREEMENT');
    const tendingResponse = await apiB.get(`${API_BASE_URL}/api/sessions/${harness.sessionId}/tending`);
    expect(tendingResponse.ok(), 'Tending list should be routed after closure').toBe(true);
    const tending = await tendingResponse.json();
    expect(tending.data?.entries?.length ?? 0, 'Closure schedules Tending entries').toBeGreaterThanOrEqual(1);

    await Promise.all([harness.userAPage.reload(), harness.userBPage.reload()]);
    await Promise.all([
      harness.userAPage.waitForLoadState('networkidle'),
      harness.userBPage.waitForLoadState('networkidle'),
    ]);

    // ==========================================
    // SUCCESS: Full partner journey complete
    // ==========================================
    // - Both users completed Stage 0 (compact signing)
    // - Both users completed Stage 1 (witnessing + feel-heard)
    // - Both users completed Stage 2 (empathy drafting + sharing + reconciler)
    // - Both users completed Stage 3 (needs extraction + side-by-side validation)
    // - Both users completed Stage 4 (proposals + willingness selections shared
    //   + shared-agreement closure + scheduled Tending)
  });
});
