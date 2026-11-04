/**
 * Live AI Full Flow E2E Test
 *
 * Exercises the User A path (Stages 0→2) with MOCK_LLM=false and real AI responses.
 * Proves the full pipeline: prompt → LLM → streaming → micro-tag parsing → SSE → frontend → metadata-driven panels.
 *
 * Uses structural assertions (testIDs, typing indicators) instead of text matching,
 * since real AI responses are non-deterministic.
 *
 * Run with:
 *   npx playwright test --config=e2e/playwright.live-ai.config.ts
 */

import { test, expect, devices } from '@playwright/test';
import {
  cleanupE2EData,
  getE2EHeaders,
  SessionBuilder,
  sendAndWaitForPanel,
  handleMoodCheck,
  signCompact,
  navigateToSession,
  confirmInvitationTopicAndContinue,
} from '../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

// Longer timeout per AI response (real AI takes 5-30s)
const AI_RESPONSE_TIMEOUT = 60000;

test.use(devices['iPhone 12']);

// Pre-written messages designed to naturally progress through each stage

const STAGE_0_MESSAGES = [
  "My partner Taylor and I have been struggling to communicate lately. Every conversation turns into an argument and I feel like we're not hearing each other.",
  'Last night we tried to talk about household responsibilities and it blew up again. I ended up sleeping on the couch.',
  "I just want us to be able to talk without it turning into a fight.",
  "We've been together 5 years and this is the worst it's been. I want to invite them to try this process with me.",
];

const STAGE_1_MESSAGES = [
  "The worst part is feeling like Taylor doesn't care about my perspective. When I try to explain how I feel, they just shut down.",
  "I've started dreading coming home because I never know if it's going to be a good night or a fight.",
  "Sometimes I wonder if Taylor even wants to be in this relationship anymore.",
  "I think what I really need is to feel like my feelings matter. Like I'm not just being dismissed.",
  "Yeah, I just want to be heard. That's really what it comes down to.",
  "It hurts because I know we used to be so good at talking to each other. Something changed.",
  "I feel unappreciated and invisible in my own home.",
];

const STAGE_2_MESSAGES = [
  "I guess Taylor might be dealing with a lot of stress at work. They mentioned their team is understaffed and they feel overwhelmed.",
  "Taylor grew up in a family where nobody talked about feelings. Shutting down is probably the only way they know to cope when things get intense.",
  "When I bring up problems, Taylor probably hears it as criticism, like they're failing at the relationship. That must feel awful for someone who's already trying so hard.",
  "I think Taylor is scared of losing us. They shut down not because they don't care, but because they care so much that the conflict feels threatening.",
  "I think I really understand now. Taylor loves me but feels overwhelmed, criticized, and afraid. Their shutting down is their way of trying to protect what we have, even though it pushes me away.",
  "Yes, I feel ready to share this with Taylor. I want them to know that I see their struggle and I understand why they withdraw.",
  "I understand Taylor's perspective well enough now. They're dealing with work stress, feeling criticized at home, and shutting down out of fear. I'd like to share my understanding with them.",
];

test.describe('Live AI Full Flow', () => {
  const userA = { email: 'live-ai-a@e2e.test', name: 'Shantam' };
  const userB = { email: 'live-ai-b@e2e.test', name: 'Taylor' };

  let sessionId: string;
  let userAId: string;

  test.beforeEach(async ({ request }) => {
    await cleanupE2EData().catch(() => {});

    // Seed session at CREATED with both users
    const setup = await new SessionBuilder()
      .userA(userA.email, userA.name)
      .userB(userB.email, userB.name)
      .startingAt('CREATED')
      .setup(request);

    sessionId = setup.session.id;
    userAId = setup.userA.id;

    console.log(`[Setup] Session: ${sessionId}, User A: ${userAId}`);
  });

  test('User A completes Stages 0→2 with real AI', async ({ page, request }) => {
    test.setTimeout(900000); // 15 minute timeout (real AI: ~50-60s per response including classifier timeout)
    const testStart = Date.now();
    const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

    // No fixture header — let backend call real LLM
    await page.setExtraHTTPHeaders(
      getE2EHeaders(userA.email, userAId)
    );

    // === NAVIGATE & SIGN COMPACT ===
    console.log(`${elapsed()} Navigating to session...`);
    await navigateToSession(page, APP_BASE_URL, sessionId, userAId, userA.email);

    console.log(`${elapsed()} Signing compact...`);
    await signCompact(page);

    // Handle mood check if it appears
    await handleMoodCheck(page);

    // Wait for chat input to be ready
    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 10000 });
    console.log(`${elapsed()} Chat ready`);

    // === STAGE 0: INVITATION CRAFTING ===
    console.log(`${elapsed()} === STAGE 0: Invitation Crafting ===`);

    const invitationTurns = await sendAndWaitForPanel(
      page,
      STAGE_0_MESSAGES,
      'topic-proposal-use-button', // two-step Stage 0 (mobile #310) replaced the invitation draft panel
      STAGE_0_MESSAGES.length,
      AI_RESPONSE_TIMEOUT
    );
    console.log(`${elapsed()} Invitation panel appeared after ${invitationTurns} message(s)`);

    await page.screenshot({ path: 'test-results/live-ai-01-invitation-panel.png' });

    await confirmInvitationTopicAndContinue(page, AI_RESPONSE_TIMEOUT);

    // Wait for invitation panel to close
    await expect(page.getByTestId('invitation-ready-modal')).not.toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Invitation confirmed, moving to Stage 1`);

    // === STAGE 1: WITNESSING (FEEL HEARD) ===
    console.log(`${elapsed()} === STAGE 1: Witnessing ===`);

    // Send messages until feel-heard check appears
    const feelHeardTurns = await sendAndWaitForPanel(
      page,
      STAGE_1_MESSAGES,
      'feel-heard-yes',
      STAGE_1_MESSAGES.length,
      AI_RESPONSE_TIMEOUT
    );
    console.log(`${elapsed()} Feel-heard check appeared after ${feelHeardTurns} message(s)`);

    await page.screenshot({ path: 'test-results/live-ai-02-feel-heard.png' });

    // Click feel-heard yes
    const feelHeardYes = page.getByTestId('feel-heard-yes');
    await feelHeardYes.click();
    await expect(feelHeardYes).not.toBeVisible({ timeout: 5000 });
    console.log(`${elapsed()} Feel-heard confirmed, moving to Stage 2`);

    // === STAGE 2: PERSPECTIVE STRETCH (EMPATHY DRAFT) ===
    console.log(`${elapsed()} === STAGE 2: Perspective Stretch ===`);

    // Send messages until empathy review button appears.
    // The AI must produce ReadyShare:Y metadata tag with a <draft> block.
    // The actual testID is 'empathy-review-button' (ReadyToShareConfirmation is unused).
    let empathyTurns: number | null = null;

    try {
      empathyTurns = await sendAndWaitForPanel(
        page,
        STAGE_2_MESSAGES,
        'empathy-review-button',
        STAGE_2_MESSAGES.length,
        AI_RESPONSE_TIMEOUT
      );
    } catch {
      // empathy-review-button didn't appear after all messages
      empathyTurns = null;
    }

    await page.screenshot({ path: 'test-results/live-ai-03-empathy-panel.png' });

    if (empathyTurns !== null) {
      // Happy path: panel appeared in the UI
      console.log(`${elapsed()} Empathy review panel appeared after ${empathyTurns} message(s)`);

      // Click empathy review button to open drawer
      const empathyReviewButton = page.getByTestId('empathy-review-button');
      await empathyReviewButton.click();

      // Click "Share empathy" in the drawer
      const shareEmpathyButton = page.getByTestId('share-empathy-button');
      await expect(shareEmpathyButton).toBeVisible({ timeout: 5000 });
      await shareEmpathyButton.click();
      console.log(`${elapsed()} Empathy shared via UI`);

      // === VERIFY: Empathy shared indicator ===
      console.log(`${elapsed()} Verifying empathy shared indicator...`);
      const empathyIndicator = page.getByTestId('chat-indicator-empathy-shared');
      await expect(empathyIndicator).toBeVisible({ timeout: 15000 });
      console.log(`${elapsed()} Empathy shared indicator visible`);

      await page.screenshot({ path: 'test-results/live-ai-04-empathy-shared.png' });

      // === VERIFY: Chat input hidden (waiting for partner) ===
      console.log(`${elapsed()} Verifying chat input hidden...`);
      await expect(chatInput).not.toBeVisible({ timeout: 10000 });
      console.log(`${elapsed()} Chat input hidden (waiting for partner)`);
    } else {
      // The AI didn't produce ReadyShare:Y / <draft> metadata tags.
      // This is a known prompt compliance issue with real AI.
      // Check if the backend has an empathy draft anyway.
      console.log(`${elapsed()} Empathy panel did NOT appear after ${STAGE_2_MESSAGES.length} messages`);
      console.log(`${elapsed()} Checking backend for empathy draft via API...`);

      const draftResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/empathy/draft`, {
        headers: getE2EHeaders(userA.email, userAId),
      });
      const draftData = await draftResponse.json().catch(() => ({}));
      const hasDraft = !!(draftData?.data?.draft?.content);
      console.log(`${elapsed()} Backend empathy draft exists: ${hasDraft}`);

      if (hasDraft) {
        console.log(`${elapsed()} Draft content: "${draftData.data.draft.content.substring(0, 100)}..."`);
        console.log(`${elapsed()} PARTIAL SUCCESS: AI produced draft in backend but panel didn't render in UI`);
      } else {
        console.log(`${elapsed()} AI did not produce <draft> metadata tags — prompt compliance issue`);
      }

      // Take diagnostic screenshot
      await page.screenshot({ path: 'test-results/live-ai-03-no-empathy-panel.png' });

      // Fail with clear diagnostic
      expect(empathyTurns,
        'Empathy panel (empathy-review-button) never appeared. ' +
        `Backend has draft: ${hasDraft}. ` +
        'The real AI likely did not produce ReadyShare:Y + <draft> metadata tags, ' +
        'or the stage cache did not advance to PERSPECTIVE_STRETCH.'
      ).not.toBeNull();
    }

    // === VERIFY: Session state via API ===
    console.log(`${elapsed()} Verifying session state via API...`);
    const stateResponse = await request.get(`${API_BASE_URL}/api/sessions/${sessionId}/state`, {
      headers: getE2EHeaders(userA.email, userAId),
    });

    expect(stateResponse.ok()).toBe(true);
    const stateData = await stateResponse.json();
    expect(stateData.success).toBe(true);

    console.log(`${elapsed()} === TEST COMPLETE ===`);
    console.log(`Stages completed: 0 (invitation: ${invitationTurns} turns), 1 (feel-heard: ${feelHeardTurns} turns), 2 (empathy: ${empathyTurns ?? 'N/A - panel missing'} turns)`);
  });
});
