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
 * 11. Before the partner joins: the draft is kept, the share waits (work-99k2)
 * 12. The partner joins; on reopening, A reviews the pre-join draft and sends it as is
 */

import { test, expect, devices } from '@playwright/test';
import { cleanupE2EData, confirmInvitationTopicAndContinue, getE2EHeaders, handleMoodCheck } from '../helpers';

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

  // work-99k2 (owner rule 2026-11-04): the partner has not joined when A writes the
  // empathy draft. The draft is kept, the share waits for the join (no consent before
  // it), nothing is sent on the join, and A reviews the draft the next time they open
  // the session (send as is / edit first / set aside).
  /**
   * Steps 1-20, shared by the review paths: A creates the session, works
   * through Stage 0-1, drafts the empathy statement before Darryl joins (kept,
   * not shared: work-99k2), Darryl joins, and on reopening A sees the review.
   */
  async function reachPreJoinReview(
    page: import('@playwright/test').Page,
    request: import('@playwright/test').APIRequestContext,
    FIXTURE_ID: string,
  ) {
    const testStart = Date.now();
    const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;
    const darryl = { email: 'darryl@e2e.test', name: 'Darryl' };

    // Every empathy draft write's status, and the consent POSTs: before the join a draft
    // write must never be refused (the old 400 loop) and no consent may be attempted.
    const draftWrites: number[] = [];
    let consentPosts = 0;
    page.on('response', response => {
      const req = response.request();
      if (req.method() !== 'POST') return;
      if (/\/empathy\/draft$/.test(req.url())) draftWrites.push(response.status());
      if (/\/empathy\/consent$/.test(req.url())) consentPosts += 1;
    });

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
      throw new Error('unreachable');
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

    // Step 16 (work-99k2): Darryl has not joined. The draft is saved, the Share
    // step explains that it can be shared once Darryl joins, and no consent is
    // attempted.
    console.log(`${elapsed()} Step 16: Opening the draft before the partner joins...`);
    await empathyReviewButton.click();
    const afterJoinNote = page.getByTestId('empathy-share-after-join-note');
    await expect(afterJoinNote).toBeVisible({ timeout: 5000 });
    await expect(afterJoinNote).toContainText("Darryl hasn't joined yet");
    await expect(afterJoinNote).toContainText('once Darryl joins');
    await expect(page.getByTestId('share-empathy-button')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/single-user-08-share-after-join.png' });

    console.log(`${elapsed()} Step 17: Keeping the draft for later...`);
    await page.getByTestId('empathy-keep-for-later-button').click();
    await expect(afterJoinNote).not.toBeVisible({ timeout: 5000 });

    // Step 18: the draft is kept on the server; nothing was refused or sent.
    console.log(`${elapsed()} Step 18: Verifying the kept draft via API...`);
    const draftResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/draft`, {
      headers: getE2EHeaders(userA.email, userId),
    });
    expect(draftResponse.ok()).toBe(true);
    const draftData = (await draftResponse.json()).data;
    expect(draftData.awaitingPartner).toBe(true);
    expect(draftData.canConsent).toBe(false);
    expect(draftData.preJoinReview).toBeNull();
    expect(draftData.draft?.content).toBeTruthy();
    expect(draftWrites.filter(status => status >= 400)).toEqual([]);
    expect(draftWrites.length).toBeGreaterThan(0);
    expect(consentPosts).toBe(0);

    // Chat stays open while the partner has not joined.
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 5000 });

    // Step 19: Darryl joins (API: the hermetic E2E auto-accept on Darryl's first
    // session read). Nothing is sent on the join.
    console.log(`${elapsed()} Step 19: Darryl joins...`);
    const darrylSeed = await request.post(`${API_BASE_URL}/api/e2e/seed`, {
      headers: { 'Content-Type': 'application/json' },
      data: { email: darryl.email, name: darryl.name },
    });
    expect(darrylSeed.ok()).toBe(true);
    const darrylId: string = (await darrylSeed.json()).id;
    const darrylState = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/state`, {
      headers: getE2EHeaders(darryl.email, darrylId),
    });
    expect(darrylState.ok()).toBe(true);
    const afterJoin = (await (
      await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/draft`, {
        headers: getE2EHeaders(userA.email, userId),
      })
    ).json()).data;
    expect(afterJoin.awaitingPartner).toBe(false);
    expect(afterJoin.alreadyConsented).toBe(false);
    expect(afterJoin.preJoinReview?.writtenAt).toBe(draftData.draft.updatedAt);

    // Step 20: the next time A opens the session, the review prompt shows what
    // they wrote and when. (Hermetic E2E has no Ably: reload is the next open.)
    console.log(`${elapsed()} Step 20: Reopening the session for the review...`);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await handleMoodCheck(page, 3000);
    const reviewHeading = page.getByTestId('pre-join-review-heading');
    await expect(reviewHeading).toBeVisible({ timeout: 30000 });
    // "earlier today" (or "yesterday" for a run that straddles local midnight)
    await expect(reviewHeading).toHaveText(/^Darryl has joined. Here's what you wrote (earlier today|yesterday).$/);
    await expect(page.getByTestId('pre-join-review-statement')).toHaveText(draftData.draft.content);
    await page.screenshot({ path: 'test-results/single-user-09-pre-join-review.png' });

    return { elapsed, draftData, draftWrites, consentPostCount: () => consentPosts };
  }

  test('new session to empathy draft, kept until the partner joins, then reviewed and sent', async ({
    page,
    request,
  }) => {
    // Increase timeout for this long journey test (5 minutes)
    test.setTimeout(300000);
    const { elapsed, consentPostCount } = await reachPreJoinReview(page, request, 'user-a-full-journey');

    // Step 21: Send as is — the consent happens now, after the join.
    console.log(`${elapsed()} Step 21: Sending as is...`);
    await page.getByTestId('pre-join-review-send-button').click();
    await expect(page.getByTestId('pre-join-review-modal')).not.toBeVisible({ timeout: 10000 });
    // The submission's reply (the copy predating #602 said "took courage") and the waiting status.
    await expect(page.getByText(/Your empathy attempt has been submitted/i)).toBeVisible({ timeout: 60000 });
    await expect(page.getByText(/Darryl is working on their perspective/i)).toBeVisible({ timeout: 10000 });
    expect(consentPostCount()).toBe(1);

    const stateResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/state`, {
      headers: getE2EHeaders(userA.email, userId),
    });
    expect(stateResponse.ok()).toBe(true);
    const stateData = await stateResponse.json();
    const empathyMessages = stateData.data.messages.messages.filter(
      (m: { role: string }) => m.role === 'EMPATHY_STATEMENT'
    );
    expect(empathyMessages.length).toBeGreaterThan(0);
    console.log(`${elapsed()} Test complete! Found ${empathyMessages.length} empathy statement(s)`);
  });

  // work-9309 (owner decision 2026-11-07): "Edit first" ends the review and the AI
  // speaks first ("Here's what you wrote <day>. Reading it now, what feels
  // different?"); A revises with the AI and shares through the normal
  // Review/Share flow. Fixture user-a-edit-first-journey: the same storyline up to
  // the draft, its prejoin-edit-first-opener operation, and the revision reply.
  test('pre-join draft reviewed after the join: Edit first, the AI opens, A revises and shares', async ({
    page,
    request,
  }) => {
    test.setTimeout(300000);
    const { elapsed, draftData, consentPostCount } = await reachPreJoinReview(
      page,
      request,
      'user-a-edit-first-journey'
    );
    const editFirstPosts: number[] = [];
    page.on('response', response => {
      const req = response.request();
      if (req.method() === 'POST' && /\/empathy\/draft\/edit-first$/.test(req.url())) {
        editFirstPosts.push(response.status());
      }
    });
    const opener =
      /^Here's what you wrote (earlier today|yesterday), before your partner joined\. Nothing has been sent\. Reading it now, what feels different\?$/;

    // Step 21: Edit first — the review closes and the AI speaks first, without a reload.
    console.log(`${elapsed()} Step 21: Edit first...`);
    await page.getByTestId('pre-join-review-edit-button').click();
    await expect(page.getByTestId('pre-join-review-modal')).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText(opener)).toBeVisible({ timeout: 30000 });
    // 202: the opener is generated in the background; without Ably the client
    // refetches the conversation until it is there.
    expect(editFirstPosts).toEqual([202]);
    expect(consentPostCount()).toBe(0);
    // Owner decision 2026-11-09: the old draft's Review/Share panel is ABSENT
    // until the AI proposes.
    await expect(page.getByTestId('empathy-review-button')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/single-user-10-edit-first-opener.png' });

    // The review is over; the draft is kept as written, not ready (A is editing); nothing sent.
    const afterEdit = (
      await (
        await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/draft`, {
          headers: getE2EHeaders(userA.email, userId),
        })
      ).json()
    ).data;
    expect(afterEdit.preJoinReview).toBeNull();
    expect(afterEdit.alreadyConsented).toBe(false);
    expect(afterEdit.draft).toMatchObject({ content: draftData.draft.content, readyToShare: false });
    expect(afterEdit.awaitingRevision).toBe(true);

    // One opener, in A's conversation; still one after a reload (and the review does not return).
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await handleMoodCheck(page, 3000);
    await expect(page.getByText(opener)).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(opener)).toHaveCount(1);
    await expect(page.getByTestId('pre-join-review-modal')).toHaveCount(0);
    expect(editFirstPosts).toEqual([202]);
    // Still absent after a reload: the state is the server's, not the client's.
    await expect(page.getByTestId('empathy-review-button')).toHaveCount(0);

    // Step 22: A replies; the AI proposes the revised statement.
    console.log(`${elapsed()} Step 22: Replying to the opener...`);
    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    await chatInput.fill(
      "Reading it now, I made it about the chores. I think they're just worn out and scared of letting me down."
    );
    await page.getByTestId('send-button').click();
    await waitForAIResponse(page, /That's a real shift/i, 30000);

    // Step 23: the normal Review/Share flow, with the revised text.
    console.log(`${elapsed()} Step 23: Reviewing and sharing the revision...`);
    // The AI's proposal brings the panel back (PRESENT), on the revised text.
    const empathyReviewButton = page.getByTestId('empathy-review-button');
    await expect(empathyReviewButton).toBeVisible({ timeout: 10000 });
    const afterProposal = (
      await (
        await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/draft`, {
          headers: getE2EHeaders(userA.email, userId),
        })
      ).json()
    ).data;
    expect(afterProposal.awaitingRevision).toBe(false);
    expect(afterProposal.draft.content).toContain('worn out, and maybe scared');
    await empathyReviewButton.click();
    const shareButton = page.getByTestId('share-empathy-button');
    await expect(shareButton).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/worn out, and maybe scared that you're letting me down/).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/single-user-11-revised-draft.png' });
    await shareButton.click();
    await expect(page.getByText(/Your empathy attempt has been submitted/i)).toBeVisible({ timeout: 60000 });
    expect(consentPostCount()).toBe(1);

    const stateData = await (
      await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/state`, {
        headers: getE2EHeaders(userA.email, userId),
      })
    ).json();
    const statements: Array<{ content: string }> = stateData.data.messages.messages.filter(
      (m: { role: string }) => m.role === 'EMPATHY_STATEMENT'
    );
    expect(statements.map(m => m.content)).toEqual([expect.stringContaining('worn out, and maybe scared')]);
    console.log(`${elapsed()} Edit first path complete`);
  });
});
