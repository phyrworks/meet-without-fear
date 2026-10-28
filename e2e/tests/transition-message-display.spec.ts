/**
 * Transition Message Display E2E Tests
 *
 * Regression tests for the bug where transition messages don't appear
 * after confirmation actions (feel-heard, invitation-sent) unless the
 * user navigates away and comes back.
 *
 * Root cause: Cache invalidation race conditions where optimistic updates
 * get overwritten by stale server data. See commits: 6c6504e, d16a32f, 1151ab9
 *
 * These tests verify that:
 * 1. After feel-heard confirmation, the transition message appears immediately
 * 2. After invitation confirmation, the transition message appears immediately
 * 3. No additional user message is needed to trigger the display
 */

import { test, expect, devices } from '@playwright/test';
import {
  cleanupE2EData,
  confirmInvitationTopicAndContinue,
  getE2EHeaders,
  waitForAIResponse,
} from '../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

// Use iPhone 12 viewport
test.use(devices['iPhone 12']);

test.describe('Transition Message Display', () => {
  const userA = {
    email: 'transition-test@e2e.test',
    name: 'Transition Tester',
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

  test('feel-heard confirmation shows transition message without additional user input', async ({
    page,
    request,
  }) => {
    // This test verifies the fix for the recurring bug where transition messages
    // don't appear after feel-heard confirmation.
    //
    // The bug was caused by cache invalidation race conditions:
    // - onSuccess called invalidateQueries on sessionKeys.state
    // - This triggered a refetch that overwrote the optimistic update
    // - The transition message was added to cache AFTER the refetch started
    // - Result: message cache didn't reflect the new message until manual refresh
    //
    // Fixed by: Using setQueryData instead of invalidateQueries (commit 6c6504e pattern)

    test.setTimeout(180000); // 3 minutes for this journey
    const testStart = Date.now();
    const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

    // Use the full journey fixture for predictable responses
    const FIXTURE_ID = 'user-a-full-journey';
    await page.setExtraHTTPHeaders({
      ...getE2EHeaders(userA.email, userId, FIXTURE_ID),
    });

    // Step 1: Create session via API
    console.log(`${elapsed()} Creating session...`);
    const createResponse = await request.post(`${API_BASE_URL}/api/sessions`, {
      headers: {
        ...getE2EHeaders(userA.email, userId, FIXTURE_ID),
        'Content-Type': 'application/json',
      },
      data: { inviteName: 'Partner' },
    });

    expect(createResponse.ok()).toBeTruthy();
    const createData = await createResponse.json();
    sessionId = createData.data.session.id; // ApiResponse envelope: { success, data: { session } }
    console.log(`${elapsed()} Session created: ${sessionId}`);

    // Step 2: Navigate to session and sign compact
    const params = new URLSearchParams({
      'e2e-user-id': userId,
      'e2e-user-email': userA.email,
    });
    await page.goto(`${APP_BASE_URL}/session/${sessionId}?${params.toString()}`);
    await page.waitForLoadState('networkidle');

    // Sign compact
    const agreeCheckbox = page.getByTestId('compact-agree-checkbox');
    await expect(agreeCheckbox).toBeVisible({ timeout: 10000 });
    await agreeCheckbox.click();
    await page.getByTestId('compact-sign-button').click();
    await page.waitForLoadState('networkidle');
    console.log(`${elapsed()} Compact signed`);

    // Step 3: Chat to get invitation panel
    const chatInput = page.getByTestId('chat-input');
    const sendButton = page.getByTestId('send-button');

    await chatInput.fill("Hi, I'm having a conflict with my partner");
    await sendButton.click();
    await waitForAIResponse(page, /I'm glad you reached out/i);
    console.log(`${elapsed()} First response received`);

    await chatInput.fill('We keep arguing about household chores');
    await sendButton.click();
    await waitForAIResponse(page, /invite your partner/i);
    console.log(`${elapsed()} Invitation draft received`);

    // Step 4: Confirm invitation sent
    const invitationPanel = page.getByTestId('invitation-draft-panel');
    await expect(invitationPanel).toBeVisible({ timeout: 5000 });
    await confirmInvitationTopicAndContinue(page);
    await expect(invitationPanel).not.toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Invitation confirmed`);

    // Step 5: Continue chatting to reach feel-heard check
    await chatInput.fill('Thanks, I sent the invitation');
    await sendButton.click();
    await waitForAIResponse(page, /exploring your perspective/i);
    console.log(`${elapsed()} Post-invitation response received`);

    await chatInput.fill("I feel like I do most of the work and they don't notice");
    await sendButton.click();
    await waitForAIResponse(page, /feel like I understand/i);
    console.log(`${elapsed()} Feel-heard check triggered`);

    // Step 6: Verify feel-heard buttons appear
    const feelHeardYes = page.getByTestId('feel-heard-yes');
    await expect(feelHeardYes).toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Feel-heard buttons visible`);

    // CRITICAL: Take screenshot and count messages BEFORE confirmation
    await page.screenshot({ path: 'test-results/transition-01-before-feel-heard.png' });

    // Get the current message count by checking for AI message content
    const messagesBefore = await page.locator('[data-testid="chat-message"]').count();
    console.log(`${elapsed()} Messages before confirmation: ${messagesBefore}`);

    // Step 7: Click feel-heard YES button
    console.log(`${elapsed()} Clicking feel-heard YES...`);
    await feelHeardYes.click();

    // Wait for button to disappear (confirms the mutation was triggered)
    await expect(feelHeardYes).not.toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Feel-heard button hidden`);

    // CRITICAL TEST: Wait for transition message to appear WITHOUT sending another message
    // The bug was that this message wouldn't appear until navigating away and back
    console.log(`${elapsed()} Waiting for transition message to appear...`);

    // Wait for the transition message content
    // In E2E mode with MOCK_LLM, the fallback message is:
    // "You've done important work sharing and being heard. When you're ready,
    //  I'm curious - have you ever wondered what [partner] might be experiencing?"
    // Or if AI responds, it should mention partner's perspective
    const transitionMessagePattern = /have you ever wondered|partner's perspective|understanding of your partner|explore.*perspective/i;

    // This is the key assertion - the message should appear without user input
    await expect(page.getByText(transitionMessagePattern)).toBeVisible({ timeout: 15000 });
    console.log(`${elapsed()} Transition message appeared!`);

    // Take screenshot after transition message appears
    await page.screenshot({ path: 'test-results/transition-02-after-feel-heard.png' });

    // Verify message count increased
    const messagesAfter = await page.locator('[data-testid="chat-message"]').count();
    console.log(`${elapsed()} Messages after confirmation: ${messagesAfter}`);

    // The count should have increased by at least 1 (the transition message)
    expect(messagesAfter).toBeGreaterThan(messagesBefore);

    console.log(`${elapsed()} TEST PASSED: Transition message displayed correctly after feel-heard confirmation`);
  });

  test('invitation confirmation shows transition message without additional user input', async ({
    page,
    request,
  }) => {
    // This test verifies that after confirming an invitation was sent,
    // the transition message appears immediately in the chat without
    // requiring the user to send another message.

    test.setTimeout(120000); // 2 minutes
    const testStart = Date.now();
    const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

    const FIXTURE_ID = 'user-a-full-journey';
    await page.setExtraHTTPHeaders({
      ...getE2EHeaders(userA.email, userId, FIXTURE_ID),
    });

    // Create session
    console.log(`${elapsed()} Creating session...`);
    const createResponse = await request.post(`${API_BASE_URL}/api/sessions`, {
      headers: {
        ...getE2EHeaders(userA.email, userId, FIXTURE_ID),
        'Content-Type': 'application/json',
      },
      data: { inviteName: 'Partner' },
    });

    expect(createResponse.ok()).toBeTruthy();
    const createData = await createResponse.json();
    sessionId = createData.data.session.id; // ApiResponse envelope: { success, data: { session } }

    // Navigate and sign compact
    const params = new URLSearchParams({
      'e2e-user-id': userId,
      'e2e-user-email': userA.email,
    });
    await page.goto(`${APP_BASE_URL}/session/${sessionId}?${params.toString()}`);
    await page.waitForLoadState('networkidle');

    const agreeCheckbox = page.getByTestId('compact-agree-checkbox');
    await expect(agreeCheckbox).toBeVisible({ timeout: 10000 });
    await agreeCheckbox.click();
    await page.getByTestId('compact-sign-button').click();
    await page.waitForLoadState('networkidle');
    console.log(`${elapsed()} Compact signed`);

    // Chat to get invitation panel
    const chatInput = page.getByTestId('chat-input');
    const sendButton = page.getByTestId('send-button');

    await chatInput.fill("Hi, I'm having a conflict with my partner");
    await sendButton.click();
    await waitForAIResponse(page, /I'm glad you reached out/i);

    await chatInput.fill('We keep arguing about household chores');
    await sendButton.click();
    await waitForAIResponse(page, /invite your partner/i);
    console.log(`${elapsed()} Invitation draft received`);

    // Verify invitation panel appears
    const invitationPanel = page.getByTestId('invitation-draft-panel');
    await expect(invitationPanel).toBeVisible({ timeout: 5000 });

    // Take screenshot and note message count BEFORE confirmation
    await page.screenshot({ path: 'test-results/transition-03-before-invitation-confirm.png' });
    const messagesBefore = await page.locator('[data-testid="chat-message"]').count();
    console.log(`${elapsed()} Messages before invitation confirmation: ${messagesBefore}`);

    // CRITICAL: Confirm invitation was sent
    console.log(`${elapsed()} Confirming invitation sent...`);
    await confirmInvitationTopicAndContinue(page);

    // Wait for panel to close
    await expect(invitationPanel).not.toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Invitation panel closed`);

    // CRITICAL TEST: Wait for transition message to appear WITHOUT sending another message
    // The transition message should mention continuing to explore, perspective, etc.
    console.log(`${elapsed()} Waiting for transition message after invitation...`);

    const transitionMessagePattern = /exploring your perspective|continue|let's|while we wait|great step/i;

    // This is the key assertion - message should appear without user input
    await expect(page.getByText(transitionMessagePattern)).toBeVisible({ timeout: 15000 });
    console.log(`${elapsed()} Transition message appeared!`);

    // Take screenshot after
    await page.screenshot({ path: 'test-results/transition-04-after-invitation-confirm.png' });

    // Verify message count increased
    const messagesAfter = await page.locator('[data-testid="chat-message"]').count();
    console.log(`${elapsed()} Messages after invitation confirmation: ${messagesAfter}`);
    expect(messagesAfter).toBeGreaterThan(messagesBefore);

    console.log(`${elapsed()} TEST PASSED: Transition message displayed correctly after invitation confirmation`);
  });
});
