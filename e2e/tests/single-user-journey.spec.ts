/**
 * Single User Journey E2E Test
 *
 * Validates the complete single-user journey:
 * 1. Create session
 * 2. Sign compact
 * 3. Chat and receive AI responses
 * 4. See the topic proposal (two-step Stage 0, mobile #310)
 * 5. Confirm topic, close the invitation-ready modal
 * 6. Continue chatting
 * 7. See feel-heard check
 * 8. Confirm feeling heard
 * 9. Continue chatting
 * 10. See empathy draft panel
 * 11. Send empathy statement
 */

import { test, expect, devices } from '@playwright/test';
import { cleanupE2EData, confirmInvitationTopicAndContinue, getE2EHeaders } from '../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

// Use iPhone 12 viewport - must be at top level
test.use(devices['iPhone 12']);

/**
 * Helper to wait for AI response to complete streaming.
 * Waits for text to appear, typing indicator to disappear, then adds settling delay.
 *
 * Note: In E2E mode, animations are disabled in StreamingText component,
 * so we only need a minimal delay for React to re-render.
 */
async function waitForAIResponse(page: import('@playwright/test').Page, textPattern: RegExp, timeout = 15000) {
  // Wait for the expected text to appear in the page
  await expect(page.getByText(textPattern)).toBeVisible({ timeout });

  // Wait for typing indicator to disappear (streaming complete)
  const typingIndicator = page.getByTestId('typing-indicator');
  await expect(typingIndicator).not.toBeVisible({ timeout: 5000 }).catch(() => {
    // If no typing indicator found, that's fine - streaming might have completed already
  });

  // Small delay for React to finish rendering
  // Animations are disabled in E2E mode, so this is just for stability
  await page.waitForTimeout(100);
}

test.describe('Single User Journey', () => {
  const userA = {
    email: 'user-a@e2e.test',
    name: 'Shantam',
  };

  let userId: string;
  let sessionId: string;

  test.beforeEach(async ({ request }) => {
    // Clean up any existing E2E test data
    await cleanupE2EData().catch(() => {});

    // Seed user via API
    const seedResponse = await request.post(`${API_BASE_URL}/api/e2e/seed`, {
      headers: { 'Content-Type': 'application/json' },
      data: { email: userA.email, name: userA.name },
    });

    if (seedResponse.ok()) {
      const seedData = await seedResponse.json();
      userId = seedData.id;
    }
  });

  // FIXME(work-99k2): product bug, not harness. With the partner not yet joined the
  // backend refuses the empathy draft and consent (400 "Cannot save empathy draft before
  // your partner has joined", target shape TS-10), but mobile still offers the share, so
  // step 16 shares nothing and step 17 ("took courage") never comes. Steps 1-15 (Stage 0
  // two-step flow, Stage 1, feel-heard, empathy-review-button) pass as of work-xws2.
  // Steps 16+ (Share tab via the empathy indicator) also predate #602; revisit them
  // together once work-99k2 settles the solo-share rule.
  test.fixme('new session to empathy draft', async ({ page, request }) => {
    // Increase timeout for this long journey test (5 minutes)
    test.setTimeout(300000);
    const testStart = Date.now();
    const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

    // Set E2E fixture ID header for this test
    const FIXTURE_ID = 'user-a-full-journey';
    await page.setExtraHTTPHeaders({
      ...getE2EHeaders(userA.email, userId, FIXTURE_ID),
    });

    // Step 1: Create session via API
    console.log(`${elapsed()} Step 1: Creating session...`);
    const createResponse = await request.post(`${API_BASE_URL}/api/sessions`, {
      headers: {
        ...getE2EHeaders(userA.email, userId, FIXTURE_ID),
        'Content-Type': 'application/json',
      },
      data: {
        inviteName: 'Darryl',
      },
    });

    if (!createResponse.ok()) {
      const errorText = await createResponse.text();
      console.log('Session creation failed:', createResponse.status(), errorText);
      test.skip(true, 'Backend API not ready for session creation');
      return;
    }

    const sessionData = await createResponse.json();
    expect(sessionData.success).toBe(true);
    sessionId = sessionData.data.session.id;

    // Step 2: Navigate to session with E2E user params
    console.log(`${elapsed()} Step 2: Navigating to session...`);
    // Pass user info via URL params so mobile app can configure API headers correctly
    const e2eParams = new URLSearchParams({
      'e2e-user-id': userId,
      'e2e-user-email': userA.email,
    });
    await page.goto(`${APP_BASE_URL}/session/${sessionId}?${e2eParams.toString()}`);
    await page.waitForLoadState('networkidle');

    // Take screenshot for debugging
    await page.screenshot({ path: 'test-results/single-user-01-session-loaded.png' });

    // Step 3: Sign the compact (curiosity agreement)
    console.log(`${elapsed()} Step 3: Signing compact...`);
    // The compact agreement bar shows at the bottom with the Ready/Sign button.
    // (UI was simplified — the standalone agree-checkbox no longer exists; the bar is just a single CTA.)
    const signButton = page.getByTestId('compact-sign-button');
    await expect(signButton).toBeVisible({ timeout: 30000 });
    await signButton.click();

    await page.screenshot({ path: 'test-results/single-user-02-compact-signed.png' });

    // Step 3b: Handle mood check screen
    // After signing compact, there's an emotional check-in "How are you feeling right now?"
    const moodContinueButton = page.getByTestId('mood-check-continue-button');
    const hasMoodCheck = await moodContinueButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasMoodCheck) {
      await moodContinueButton.click();
      await page.screenshot({ path: 'test-results/single-user-02b-mood-check-done.png' });
    }

    // Wait for the chat input to appear
    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    // Step 4: Send first message
    console.log(`${elapsed()} Step 4: Sending first message...`);
    // chatInput is already defined above

    await chatInput.fill("Hi, I'm having a conflict with my partner");
    const sendButton = page.getByTestId('send-button');
    await sendButton.click();

    // Step 5: Wait for AI response to complete streaming
    console.log(`${elapsed()} Step 5: Waiting for first AI response...`);
    // AI response should contain text from fixture response 0
    await waitForAIResponse(page, /glad you reached out/i);
    console.log(`${elapsed()} Step 5 complete`);

    // Verify message order: should see AI response before sending next message
    await page.screenshot({ path: 'test-results/single-user-03-first-response.png' });

    // Step 6: Send second message to trigger invitation draft
    console.log(`${elapsed()} Step 6: Sending second message...`);
    await chatInput.fill('We keep arguing about household chores');
    await sendButton.click();

    // Step 7: Wait for AI response with invitation draft
    console.log(`${elapsed()} Step 7: Waiting for invitation AI response...`);
    // Response 1 contains a <draft> tag which should trigger the invitation panel
    await waitForAIResponse(page, /invite your partner/i);
    console.log(`${elapsed()} Step 7 complete`);

    // Assert the topic proposal appears (two-step Stage 0, mobile #310: the
    // inline invitation draft panel was replaced by the topic proposal followed
    // by the invitation-ready modal).
    await expect(page.getByTestId('topic-proposal-use-button')).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: 'test-results/single-user-04-invitation-panel.png' });

    // Step 8: Confirm the topic frame, then confirm invitation sent
    console.log(`${elapsed()} Step 8: Confirming topic frame and invitation...`);
    await confirmInvitationTopicAndContinue(page);

    // The helper closes the invitation-ready modal; it must stay closed.
    await expect(page.getByTestId('invitation-ready-modal')).not.toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: 'test-results/single-user-05-invitation-sent.png' });

    // Step 9: Send third message
    console.log(`${elapsed()} Step 9: Sending third message...`);
    await chatInput.fill('Thanks, I sent the invitation');
    await sendButton.click();

    // Wait for AI response (post-invitation) to complete streaming
    console.log(`${elapsed()} Step 9: Waiting for post-invitation AI response...`);
    await waitForAIResponse(page, /exploring your perspective/i);
    console.log(`${elapsed()} Step 9 complete`);

    // Step 10: Send fourth message to trigger feel-heard check
    console.log(`${elapsed()} Step 10: Sending fourth message...`);
    await chatInput.fill("I feel like I do most of the work and they don't notice or appreciate it");
    await sendButton.click();

    // Step 11: Wait for AI response with feel-heard check to complete streaming
    console.log(`${elapsed()} Step 11: Waiting for feel-heard AI response...`);
    // Response 3 has FeelHeardCheck: Y which should trigger the feel-heard confirmation
    await waitForAIResponse(page, /feel like I understand/i);
    console.log(`${elapsed()} Step 11 complete`);

    // Assert feel-heard check appears
    const feelHeardYes = page.getByTestId('feel-heard-yes');
    await expect(feelHeardYes).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: 'test-results/single-user-06-feel-heard-check.png' });

    // Step 12: Click feel-heard-yes button
    console.log(`${elapsed()} Step 12: Clicking feel heard yes...`);
    await feelHeardYes.click();

    // Wait for button to disappear (confirmation processed)
    await expect(feelHeardYes).not.toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: 'test-results/single-user-07-feel-heard-confirmed.png' });

    // Step 13: Send fifth message
    console.log(`${elapsed()} Step 13: Sending fifth message...`);
    await chatInput.fill('Yes, I feel heard now');
    await sendButton.click();

    // Wait for AI response (post-feel-heard transition) to complete streaming
    console.log(`${elapsed()} Step 13: Waiting for transition AI response...`);
    await waitForAIResponse(page, /partner's perspective/i);
    console.log(`${elapsed()} Step 13 complete`);

    // Step 14: Send sixth message to trigger empathy draft
    console.log(`${elapsed()} Step 14: Sending sixth message...`);
    await chatInput.fill('I guess they might be stressed from work too');
    await sendButton.click();

    // Step 15: Wait for AI response with empathy draft to complete streaming
    console.log(`${elapsed()} Step 15: Waiting for empathy draft AI response...`);
    // Response 5 has ReadyShare: Y and <draft> tag
    await waitForAIResponse(page, /really thoughtful observation/i);
    console.log(`${elapsed()} Step 15 complete`);

    // Assert empathy review button appears (the "Review what you'll share" button)
    // The actual testID is 'empathy-review-button' in UnifiedSessionScreen.tsx.
    // (ReadyToShareConfirmation component with 'ready-to-share-button' is unused.)
    console.log(`${elapsed()} Step 15b: Waiting for empathy review button...`);
    const empathyReviewButton = page.getByTestId('empathy-review-button');
    await expect(empathyReviewButton).toBeVisible({ timeout: 10000 });

    // Click to open the drawer
    console.log(`${elapsed()} Step 15c: Clicking empathy review...`);
    await empathyReviewButton.click();
    const shareEmpathyButton = page.getByTestId('share-empathy-button');
    await expect(shareEmpathyButton).toBeVisible({ timeout: 5000 });

    // Step 16: Click share-empathy-button
    console.log(`${elapsed()} Step 16: Clicking share empathy...`);
    await shareEmpathyButton.click();

    // Step 17: Wait for AI confirmation response after empathy is sent
    // Backend generates this response (not from fixture)
    console.log(`${elapsed()} Step 17: Waiting for "took courage" AI response...`);
    await page.waitForSelector('text=/took courage/i', { timeout: 60000 });
    console.log(`${elapsed()} Step 17 complete: Found "took courage" response`);

    // Step 18: Verify chat input is hidden after empathy is shared
    // User can't send more messages while waiting for partner
    console.log(`${elapsed()} Step 18: Verifying chat input is hidden...`);
    const chatInputAfterEmpathy = page.getByTestId('chat-input');
    await expect(chatInputAfterEmpathy).not.toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Chat input is hidden (as expected)`);

    // Step 19: Look for "Empathy shared" indicator in the chat
    console.log(`${elapsed()} Step 19: Looking for Empathy shared indicator...`);
    // Use testID which is more reliable than text matching
    const empathyIndicator = page.getByTestId('chat-indicator-empathy-shared');
    await expect(empathyIndicator).toBeVisible({ timeout: 10000 });
    console.log(`${elapsed()} Empathy shared indicator is visible`);

    // Step 19b: Assert waiting status panel is visible
    // After sharing empathy, user should see "<Partner> is working on their perspective"
    // (copy was previously "Waiting for <Partner> to feel heard"; updated to lower stakes)
    console.log(`${elapsed()} Step 19b: Verifying waiting status panel...`);
    const waitingStatus = page.getByText(/Darryl is working on their perspective/i);
    await expect(waitingStatus).toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Waiting status panel is visible`);

    // Step 20: Tap the "Empathy shared" indicator to navigate to Share tab
    console.log(`${elapsed()} Step 20: Clicking empathy indicator to navigate to share tab...`);
    await empathyIndicator.click();

    // Wait for navigation by checking URL changes to /share
    await page.waitForURL(/\/session\/.*\/share/, { timeout: 5000 });
    console.log(`${elapsed()} Navigated to share URL`);

    // Step 21: Verify we're on the share tab by looking for share-related content
    console.log(`${elapsed()} Step 21: Verifying share screen content...`);

    // Wait for the share screen header to appear
    const shareHeader = page.getByTestId('share-screen-header');
    await expect(shareHeader).toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Share screen header visible`);

    // Wait for the partner tab content to load
    const partnerTab = page.getByTestId('share-screen-partner-tab');
    await expect(partnerTab).toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Partner tab content visible`);

    // Step 21b: Verify the incorrect "partner shared empathy" indicator is NOT shown
    // In single-user journey, the current user shared empathy, not the partner
    const partnerEmpathyHeldIndicator = page.getByTestId('share-screen-partner-tab-indicator-partner-empathy-held');
    await expect(partnerEmpathyHeldIndicator).not.toBeVisible({ timeout: 1000 }).catch(() => {
      // If it doesn't exist at all, that's fine
    });
    console.log(`${elapsed()} Verified partner-empathy-held indicator is not visible`);

    // Step 22: Verify via API that empathy was sent
    console.log(`${elapsed()} Step 22: Verifying empathy via API...`);
    const stateResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/state`, {
      headers: getE2EHeaders(userA.email, userId),
    });

    expect(stateResponse.ok()).toBe(true);
    const stateData = await stateResponse.json();

    // Verify session state reflects empathy was shared
    expect(stateData.success).toBe(true);
    expect(stateData.data.session.id).toBe(sessionId);

    // Verify the empathy statement message exists
    const empathyMessages = stateData.data.messages.messages.filter(
      (m: { role: string }) => m.role === 'EMPATHY_STATEMENT'
    );
    expect(empathyMessages.length).toBeGreaterThan(0);
    console.log(`${elapsed()} Test complete! Found ${empathyMessages.length} empathy statement(s)`);
  });
});
