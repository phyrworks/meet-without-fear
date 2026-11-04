/**
 * Live AI Two-Browser Full Flow E2E Test
 *
 * Two users + real Bedrock + Stages 0→4. Companion to:
 *   - live-ai-full-flow.spec.ts        (real AI, single user, stages 0-2)
 *   - two-browser-full-flow.spec.ts    (mocked AI, two users, stages 0-4)
 *
 * This spec proves real AI quality across the entire arc with both partners.
 * It is the highest-coverage but slowest scenario in the suite — ~25 min,
 * ~$1-3 in Bedrock per run. Run on demand only via @slam_paws.
 *
 * Assertion strategy:
 *   - testIDs only (real AI text is non-deterministic)
 *   - generous timeouts (real AI: 50-90s per turn; reconciler: up to 90s)
 *   - no toHaveScreenshot snapshots (chat content varies between runs)
 *
 * Run with:
 *   npx playwright test --config=e2e/playwright.live-ai.config.ts \
 *     --grep live-ai-two-browser-full-flow
 */

import { test, expect, devices, APIRequestContext } from '@playwright/test';
import { TwoBrowserHarness, getE2EHeaders } from '../helpers';
import {
  signCompact,
  handleMoodCheck,
  sendAndWaitForPanel,
  confirmInvitationTopicAndContinue,
  waitForReconcilerComplete,
  expectNeedsComparisonFromApi,
  expectNeedsSummaryFromApi,
  waitForNeedsReveal,
  waitForStage,
} from '../helpers/test-utils';

test.use(devices['iPhone 12']);

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Robust feel-heard confirmation. The shared confirmFeelHeard helper uses
// click({ force: true }), which still waits for the locator to be visible
// — if the element re-renders or briefly detaches mid-stage-transition
// (which happens with real-AI's longer streaming windows), Playwright waits
// up to the full test timeout (30 min) for it to reattach. We saw User B
// hang for ~26 min on this in run 01KQ8YJRDMP1D14EYF6BHF38H9.
//
// JS-evaluate-click bypasses every Playwright actionability check; we then
// poll for disappearance with a hard cap.
async function confirmFeelHeardRobust(
  page: import('@playwright/test').Page
): Promise<void> {
  const btn = page.getByTestId('feel-heard-yes');
  await expect(btn).toBeVisible({ timeout: 10000 });

  for (let attempt = 0; attempt < 8; attempt++) {
    await btn.evaluate((el: HTMLElement) => el.click()).catch(() => {});
    // Poll for panel to disappear; if it does, we're done.
    for (let poll = 0; poll < 5; poll++) {
      await page.waitForTimeout(1000);
      if (!(await btn.isVisible().catch(() => false))) {
        await page.waitForTimeout(1000);
        return;
      }
    }
  }
  throw new Error('feel-heard-yes panel did not disappear after 8 click attempts (40s)');
}

// Note: There is no longer a separate /share or /sharing-status screen —
// `sharing-status.tsx` is a redirect stub back to /session/{id} ("@deprecated
// Sharing functionality has been moved to the Partner tab"). The
// share-screen-partner-tab-item-partner-empathy-* testID two-browser-full-flow
// asserts against has also been removed from the codebase. We skip share-screen
// UI verification entirely and rely on the empathy/validate API call to
// advance the state machine into Stage 3.

// Real-AI roundtrip per turn can hit 60-90s for plain followups, but
// structured-output turns (invitation draft, empathy draft, strategy proposal)
// can spike to 120s+ on Bedrock. Padded to 180s — first EC2 run hung at 90s
// on the invitation-draft turn after 4 successful followups.
const AI_RESPONSE_TIMEOUT = 180000;
// Reconciler involves multiple AI calls; pad for real AI.
const RECONCILER_TIMEOUT = 180000;

// User A messages — Stage 0 needs concrete dialogue, not just "we argued",
// because the AI gates the invitation draft on having enough substance to
// summarize. First EC2 retry hit prompt compliance: AI kept asking "what was
// actually said?" and never produced <draft> until 5 messages were exhausted.
const USER_A_STAGE_0_MESSAGES = [
  "My partner Taylor and I have been struggling to communicate lately. Every conversation about household responsibilities turns into an argument and I feel like we're not hearing each other.",
  "Last night I came home and the kitchen was a mess. I asked Taylor 'didn't we agree you'd handle the dishes today?' and they snapped 'I had a bad day, can you not start with this right now?' I said 'I'm not starting anything, I just walked in.' They said 'this is exactly what I mean, you always have something to complain about.' I went to the couch and slept there.",
  "I keep replaying it. I feel unheard and dismissed — like nothing I bring up gets received as me reaching for them, only as criticism.",
  "We've been together 5 years and this is the worst it's been. I want to invite Taylor to try this Meet Without Fear process with me — to have a conversation that doesn't blow up.",
  "Yes, I'm ready to send the invitation now.",
  "I've told you what happened — Taylor said I always have something to complain about, and I slept on the couch. I want to invite them to do this with me.",
];

const USER_A_STAGE_1_MESSAGES = [
  "The worst part is feeling like Taylor doesn't care about my perspective. When I try to explain how I feel, they just shut down.",
  "I've started dreading coming home because I never know if it's going to be a good night or a fight.",
  "Sometimes I wonder if Taylor even wants to be in this relationship anymore.",
  "I think what I really need is to feel like my feelings matter. Like I'm not just being dismissed.",
  "Yeah, I just want to be heard. That's really what it comes down to.",
  "It hurts because I know we used to be so good at talking to each other. Something changed.",
  "I feel unappreciated and invisible in my own home.",
];

const USER_A_STAGE_2_MESSAGES = [
  "I guess Taylor might be dealing with a lot of stress at work. They mentioned their team is understaffed and they feel overwhelmed.",
  "Taylor grew up in a family where nobody talked about feelings. Shutting down is probably the only way they know to cope when things get intense.",
  "When I bring up problems, Taylor probably hears it as criticism, like they're failing at the relationship. That must feel awful for someone who's already trying so hard.",
  "I think Taylor is scared of losing us. They shut down not because they don't care, but because they care so much that the conflict feels threatening.",
  "I think I really understand now. Taylor loves me but feels overwhelmed, criticized, and afraid. Their shutting down is their way of trying to protect what we have, even though it pushes me away.",
  "Yes, I feel ready to share this with Taylor. I want them to know that I see their struggle and I understand why they withdraw.",
  "I understand Taylor's perspective well enough now. I'd like to share my understanding with them.",
];

// User B (Taylor) — mirror of User A's narrative from Taylor's POV.
const USER_B_STAGE_1_MESSAGES = [
  "My partner Shantam has been bringing up complaints about chores constantly, and I just shut down because nothing I do seems good enough.",
  "I've been working really long hours and coming home is supposed to feel safe, but it feels like another performance review.",
  "What hurts is that I'm trying so hard at home and at work, and Shantam only seems to notice the things I haven't done yet.",
  "I just want to feel like Shantam sees the effort I'm putting in, even when I'm overwhelmed.",
  "I think what I really need is to feel like my struggles matter too, not just the household stuff.",
  "I want us to be a team again, not adversaries on opposite sides of the kitchen.",
  "Yes, I feel like you really hear me now. That's exactly it.",
];

const USER_B_STAGE_2_MESSAGES = [
  "I think Shantam might feel taken for granted. They probably do a lot of invisible work that I don't acknowledge.",
  "Shantam grew up in a household where keeping things tidy was how love was shown. When I let things slide, that probably feels like I'm withdrawing love.",
  "When Shantam asks about chores, they're probably not criticizing me — they're trying to feel partnered with me, like we're a team.",
  "Shantam doesn't want me to be perfect. They just want to feel seen and like we're in this together.",
  "I think Shantam wants connection and partnership. My shutting down probably reads as 'I don't care', when really I'm just overwhelmed and afraid of failing.",
  "I really understand now. Shantam wants us to be a team — they're not attacking me, they're reaching for me.",
  "Yes, I'm ready to share this with Shantam.",
];

function makeApiRequest(
  request: APIRequestContext,
  userEmail: string,
  userId: string
) {
  const headers = getE2EHeaders(userEmail, userId);
  return {
    get: (url: string) => request.get(url, { headers }),
    post: (url: string, data?: object) => request.post(url, { headers, data }),
  };
}

test.describe('Live AI Full Partner Journey: Stages 0-4', () => {
  let harness: TwoBrowserHarness;

  test.beforeEach(async ({ browser, request }) => {
    // No fixtureId — real Bedrock, not mocked.
    harness = new TwoBrowserHarness({
      userA: { email: 'live-ai-2b-a@e2e.test', name: 'Shantam' },
      userB: { email: 'live-ai-2b-b@e2e.test', name: 'Taylor' },
    });

    await harness.cleanup();
    await harness.setupUserA(browser, request);
    await harness.createSession();
  });

  test.afterEach(async () => {
    await harness.teardown();
  });

  test('both users complete full session with real AI', async ({ browser, request }) => {
    test.setTimeout(1800000); // 30 minutes — real AI is ~50-90s per turn
    const testStart = Date.now();
    const elapsed = () => `[${((Date.now() - testStart) / 1000).toFixed(1)}s]`;

    // ==========================================
    // === STAGE 0: USER A ALONE (invitation crafting) ===
    // ==========================================
    // CRITICAL: User B's invitation must remain PENDING during Stage 0. The
    // Stage 0 system prompt's job is to get User A to draft an invitation
    // for their partner. With real AI, if the invitation is already ACCEPTED
    // (the mocked-test default in TwoBrowserHarness), the AI correctly
    // recognizes "the partner is already onboard" and refuses to produce
    // the <draft> tag. So we set up + sign in only User A here, mirroring
    // the real-life flow: A drafts → "sends" → B accepts.

    console.log(`${elapsed()} User A navigating + signing compact...`);
    await harness.navigateUserA();
    await signCompact(harness.userAPage);
    await handleMoodCheck(harness.userAPage);

    await expect(harness.userAPage.getByTestId('chat-input')).toBeVisible();
    console.log(`${elapsed()} Compact signed, chat ready for User A`);

    console.log(`${elapsed()} === USER A: Invitation Crafting ===`);
    const invitationTurns = await sendAndWaitForPanel(
      harness.userAPage,
      USER_A_STAGE_0_MESSAGES,
      'topic-proposal-use-button', // two-step Stage 0 (mobile #310) replaced the invitation draft panel
      USER_A_STAGE_0_MESSAGES.length,
      AI_RESPONSE_TIMEOUT
    );
    console.log(`${elapsed()} Invitation panel appeared after ${invitationTurns} message(s)`);

    await confirmInvitationTopicAndContinue(harness.userAPage, AI_RESPONSE_TIMEOUT);
    await expect(harness.userAPage.getByTestId('invitation-ready-modal')).not.toBeVisible({ timeout: 10000 });
    console.log(`${elapsed()} Invitation confirmed — User B can now join`);

    // ==========================================
    // === USER B: ACCEPT + JOIN ===
    // ==========================================

    await harness.setupUserB(browser, request);
    await harness.acceptInvitation();
    await harness.navigateUserB();
    await signCompact(harness.userBPage);
    await handleMoodCheck(harness.userBPage);
    await expect(harness.userBPage.getByTestId('chat-input')).toBeVisible();
    console.log(`${elapsed()} User B accepted + signed compact`);

    // ==========================================
    // === STAGE 1: WITNESSING (parallel) ===
    // ==========================================
    // Both users drive their own conversations toward feel-heard. No
    // cross-user side effects until either shares empathy in Stage 2, so we
    // can run the Stage 1 message loops in parallel.

    console.log(`${elapsed()} === STAGE 1: Witnessing (parallel) ===`);
    const [userATurns1, userBTurns1] = await Promise.all([
      sendAndWaitForPanel(
        harness.userAPage,
        USER_A_STAGE_1_MESSAGES,
        'feel-heard-yes',
        USER_A_STAGE_1_MESSAGES.length,
        AI_RESPONSE_TIMEOUT
      ),
      sendAndWaitForPanel(
        harness.userBPage,
        USER_B_STAGE_1_MESSAGES,
        'feel-heard-yes',
        USER_B_STAGE_1_MESSAGES.length,
        AI_RESPONSE_TIMEOUT
      ),
    ]);
    console.log(`${elapsed()} Feel-heard appeared (A: ${userATurns1} turns, B: ${userBTurns1} turns)`);

    await Promise.all([
      confirmFeelHeardRobust(harness.userAPage),
      confirmFeelHeardRobust(harness.userBPage),
    ]);
    console.log(`${elapsed()} Both users confirmed feel-heard`);

    // ==========================================
    // === STAGE 2: EMPATHY DRAFT (parallel) ===
    // ==========================================
    // Both must reach empathy-review-button BEFORE either shares — sharing
    // triggers an Ably-delivered transition message into the partner's chat,
    // which would inject an unexpected AI message mid-loop.

    console.log(`${elapsed()} === STAGE 2: Empathy Drafting (parallel) ===`);
    const [userATurns2, userBTurns2] = await Promise.all([
      sendAndWaitForPanel(
        harness.userAPage,
        USER_A_STAGE_2_MESSAGES,
        'empathy-review-button',
        USER_A_STAGE_2_MESSAGES.length,
        AI_RESPONSE_TIMEOUT
      ),
      sendAndWaitForPanel(
        harness.userBPage,
        USER_B_STAGE_2_MESSAGES,
        'empathy-review-button',
        USER_B_STAGE_2_MESSAGES.length,
        AI_RESPONSE_TIMEOUT
      ),
    ]);
    console.log(`${elapsed()} Empathy review appeared (A: ${userATurns2} turns, B: ${userBTurns2} turns)`);

    // ==========================================
    // === STAGE 2: SHARE EMPATHY (sequential) ===
    // ==========================================
    // User A shares first (no reconciler trigger). User B shares second
    // (triggers reconciler).

    console.log(`${elapsed()} User A sharing empathy...`);
    const reviewBtnA = harness.userAPage.getByTestId('empathy-review-button');
    await expect(reviewBtnA).toBeVisible({ timeout: 10000 });
    // JS click bypasses pointer-events: none from the typewriter wrapper.
    await reviewBtnA.evaluate((el: HTMLElement) => el.click());

    const shareBtnA = harness.userAPage.getByTestId('share-empathy-button');
    await expect(shareBtnA).toBeVisible({ timeout: 10000 });
    await shareBtnA.evaluate((el: HTMLElement) => el.click());
    console.log(`${elapsed()} User A shared`);

    // Allow Ably delivery to User B before B shares (which triggers reconciler).
    await harness.userAPage.waitForTimeout(2000);

    console.log(`${elapsed()} User B sharing empathy (triggers reconciler)...`);
    const reviewBtnB = harness.userBPage.getByTestId('empathy-review-button');
    await expect(reviewBtnB).toBeVisible({ timeout: 10000 });
    await reviewBtnB.evaluate((el: HTMLElement) => el.click());

    const shareBtnB = harness.userBPage.getByTestId('share-empathy-button');
    await expect(shareBtnB).toBeVisible({ timeout: 10000 });
    await shareBtnB.evaluate((el: HTMLElement) => el.click());
    console.log(`${elapsed()} User B shared`);

    // ==========================================
    // === RECONCILER COMPLETION ===
    // ==========================================

    await harness.userAPage.waitForTimeout(2000);
    console.log(`${elapsed()} Waiting for reconciler...`);

    const userAReconcilerComplete = await waitForReconcilerComplete(harness.userAPage, RECONCILER_TIMEOUT);
    if (!userAReconcilerComplete) {
      await harness.userAPage.screenshot({ path: 'test-results/live-ai-2b-reconciler-timeout-A.png' });
      await harness.userBPage.screenshot({ path: 'test-results/live-ai-2b-reconciler-timeout-B.png' });
      throw new Error(`Reconciler did not complete within ${RECONCILER_TIMEOUT}ms for User A`);
    }
    const userBReconcilerComplete = await waitForReconcilerComplete(harness.userBPage, RECONCILER_TIMEOUT);
    if (!userBReconcilerComplete) {
      await harness.userBPage.screenshot({ path: 'test-results/live-ai-2b-reconciler-timeout-B.png' });
      throw new Error(`Reconciler did not complete within ${RECONCILER_TIMEOUT}ms for User B`);
    }
    console.log(`${elapsed()} Reconciler complete for both users`);

    // ==========================================
    // === STAGE 2 → 3 TRANSITION ===
    // ==========================================

    const apiA = makeApiRequest(request, harness.config.userA.email, harness.userAId);
    const apiB = makeApiRequest(request, harness.config.userB.email, harness.userBId);

    // Validate empathy via API to advance both into Stage 3. Skips
    // share-screen UI verification — that path is covered by mocked
    // two-browser-* specs and the route + testIDs have shifted under us.
    await Promise.all([
      apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/empathy/validate`, { validated: true }),
      apiB.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/empathy/validate`, { validated: true }),
    ]);
    await harness.userAPage.waitForTimeout(2000);
    console.log(`${elapsed()} Empathy validated by both, advancing to Stage 3`);

    // ==========================================
    // === STAGE 3: NEEDS EXTRACTION ===
    // ==========================================
    // Backend gate (stage3.ts:191): needs extraction won't run unless the
    // user has sent at least one message in Stage 3 — prevents needs from
    // appearing before any conversation. Each user sends one message
    // answering the AI's "what do you need?" opener so extraction triggers
    // on the GET /needs call.

    // After empathy share, chat-input was hidden ("waiting for partner").
    // Reload to pick up Stage 3 state after empathy/validate, then wait for
    // chat-input to become visible before attempting to send messages —
    // otherwise fill() silently no-ops on a hidden input.
    console.log(`${elapsed()} === STAGE 3: Need Mapping (parallel) ===`);
    await Promise.all([harness.userAPage.reload(), harness.userBPage.reload()]);
    await Promise.all([
      harness.userAPage.waitForLoadState('networkidle'),
      harness.userBPage.waitForLoadState('networkidle'),
    ]);
    await handleMoodCheck(harness.userAPage);
    await handleMoodCheck(harness.userBPage);
    await expect(harness.userAPage.getByTestId('chat-input')).toBeVisible({ timeout: 30000 });
    await expect(harness.userBPage.getByTestId('chat-input')).toBeVisible({ timeout: 30000 });

    const sendStage3Message = async (
      page: import('@playwright/test').Page,
      message: string
    ): Promise<void> => {
      await page.getByTestId('chat-input').fill(message);
      await page.getByTestId('send-button').click();
      const typingIndicator = page.getByTestId('typing-indicator');
      // Wait for typing-indicator to appear (AI started). If it doesn't appear
      // within 30s, the message didn't dispatch — fail loudly rather than
      // silently no-op the hidden-wait.
      await typingIndicator.waitFor({ state: 'visible', timeout: 30000 });
      await typingIndicator.waitFor({ state: 'hidden', timeout: AI_RESPONSE_TIMEOUT });
    };

    await Promise.all([
      sendStage3Message(
        harness.userAPage,
        "What I really need is to feel like Taylor sees the effort I'm putting in and to feel partnered with, not interrogated. I need to be able to bring up something at home without it feeling like an attack."
      ),
      sendStage3Message(
        harness.userBPage,
        "What I need is to feel like I can come home and recover without it feeling like another performance review. I need space to be human, not perfect, and to feel appreciated for what I do manage."
      ),
    ]);
    console.log(`${elapsed()} Stage 3 messages exchanged — triggering needs extraction`);

    // Trigger needs extraction via API. Real AI takes ~30-60s — the GET
    // endpoint blocks until extraction completes, so the Promise.all is the
    // wait. (Mocked specs need a tiny waitForTimeout because their fixture
    // returns instantly; with real AI the API itself is the wait.)
    await Promise.all([
      apiA.get(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs`),
      apiB.get(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs`),
    ]);
    console.log(`${elapsed()} Needs extraction complete`);

    const needsResponseA = await apiA.get(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs`);
    const needsDataA = await needsResponseA.json();
    const needsA = needsDataA.data?.needs || [];

    const needsResponseB = await apiB.get(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs`);
    const needsDataB = await needsResponseB.json();
    const needsB = needsDataB.data?.needs || [];

    expect(needsA.length, 'Needs extraction returned no needs for User A').toBeGreaterThan(0);
    expect(needsB.length, 'Needs extraction returned no needs for User B').toBeGreaterThan(0);
    await expectNeedsSummaryFromApi(apiA, API_BASE_URL, harness.sessionId, 'User A');
    await expectNeedsSummaryFromApi(apiB, API_BASE_URL, harness.sessionId, 'User B');

    if (needsA.length > 0) {
      const needIdsA = needsA.map((n: { id: string }) => n.id);
      await apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs/confirm`, { needIds: needIdsA });
      await apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs/consent`, { needIds: needIdsA });
    }
    if (needsB.length > 0) {
      const needIdsB = needsB.map((n: { id: string }) => n.id);
      await apiB.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs/confirm`, { needIds: needIdsB });
      await apiB.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs/consent`, { needIds: needIdsB });
    }
    console.log(`${elapsed()} Needs confirmed + consented (A: ${needsA.length}, B: ${needsB.length})`);

    // ==========================================
    // === STAGE 3: NEEDS REVEAL ===
    // ==========================================

    await waitForNeedsReveal(apiA, API_BASE_URL, harness.sessionId, 'User A', 180000);
    console.log(`${elapsed()} Needs reveal ready`);

    await expectNeedsComparisonFromApi(apiA, API_BASE_URL, harness.sessionId, 'User A');
    await expectNeedsComparisonFromApi(apiB, API_BASE_URL, harness.sessionId, 'User B');

    await Promise.all([
      apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs/validate`, { validated: true }),
      apiB.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/needs/validate`, { validated: true }),
    ]);
    await harness.userAPage.waitForTimeout(1000);
    await Promise.all([
      waitForStage(apiA, API_BASE_URL, harness.sessionId, 4, 'User A', 30000),
      waitForStage(apiB, API_BASE_URL, harness.sessionId, 4, 'User B', 30000),
    ]);
    console.log(`${elapsed()} Advanced to Stage 4`);

    // ==========================================
    // === STAGE 4: STRATEGIES + AGREEMENT ===
    // ==========================================

    await apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies`, {
      description: 'Have a 10-minute phone-free conversation at dinner each day',
      needsAddressed: ['Connection', 'Recognition'],
    });
    await apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies`, {
      description: 'Use a pause signal when conversations get heated',
      needsAddressed: ['Safety', 'Connection'],
    });
    await apiB.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies`, {
      description: 'Say one specific thing I appreciate each morning',
      needsAddressed: ['Recognition'],
    });

    const strategiesResponse = await apiA.get(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies`);
    const strategiesData = await strategiesResponse.json();
    const strategies = strategiesData.data?.strategies || [];
    expect(strategies.length).toBe(3);

    await Promise.all([harness.userAPage.reload(), harness.userBPage.reload()]);
    await Promise.all([
      harness.userAPage.waitForLoadState('networkidle'),
      harness.userBPage.waitForLoadState('networkidle'),
    ]);
    await handleMoodCheck(harness.userAPage);
    await handleMoodCheck(harness.userBPage);

    await Promise.all([
      apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies/ready`),
      apiB.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies/ready`),
    ]);

    const [s1, s2, s3] = strategies;
    await apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies/rank`, {
      rankedIds: [s1.id, s2.id, s3.id],
    });
    const rankBResponse = await apiB.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies/rank`, {
      rankedIds: [s1.id, s3.id, s2.id],
    });
    const rankBData = await rankBResponse.json();
    expect(rankBData.data?.canReveal).toBe(true);

    const overlapResponse = await apiA.get(`${API_BASE_URL}/api/sessions/${harness.sessionId}/strategies/overlap`);
    const overlapData = await overlapResponse.json();
    const overlapStrategies = overlapData.data?.overlap || [];
    expect(overlapStrategies.length).toBeGreaterThanOrEqual(1);
    console.log(`${elapsed()} Strategy overlap: ${overlapStrategies.length} strategies`);

    const followUpDate = new Date();
    followUpDate.setDate(followUpDate.getDate() + 7);

    const agreementResponse = await apiA.post(`${API_BASE_URL}/api/sessions/${harness.sessionId}/agreements`, {
      strategyId: overlapStrategies[0].id,
      description: overlapStrategies[0].description,
      type: 'MICRO_EXPERIMENT',
      followUpDate: followUpDate.toISOString(),
    });
    const agreementData = await agreementResponse.json();
    const agreementId = agreementData.data?.agreement?.id;
    expect(agreementId, 'Agreement creation did not return an id').toBeTruthy();

    const confirmResponse = await apiB.post(
      `${API_BASE_URL}/api/sessions/${harness.sessionId}/agreements/${agreementId}/confirm`,
      { confirmed: true }
    );
    const confirmData = await confirmResponse.json();
    // The API returns `sessionCanResolve`, not `sessionComplete` — that field
    // name is stale in two-browser-full-flow.spec.ts too (asserts undefined).
    expect(confirmData.data?.sessionCanResolve).toBe(true);
    console.log(`${elapsed()} === SESSION COMPLETE ===`);

    // Final diagnostic screenshots (no toHaveScreenshot — chat varies between runs).
    await Promise.all([harness.userAPage.reload(), harness.userBPage.reload()]);
    await Promise.all([
      harness.userAPage.waitForLoadState('networkidle'),
      harness.userBPage.waitForLoadState('networkidle'),
    ]);
    await handleMoodCheck(harness.userAPage);
    await handleMoodCheck(harness.userBPage);
    await harness.userAPage.screenshot({ path: 'test-results/live-ai-2b-final-A.png' });
    await harness.userBPage.screenshot({ path: 'test-results/live-ai-2b-final-B.png' });
  });
});
