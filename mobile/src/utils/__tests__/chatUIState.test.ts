/**
 * Tests for chatUIState.ts
 *
 * Tests the pure derivation function that computes complete chat UI state
 * from session data. This includes panel visibility, input hiding, and more.
 */

import { Stage } from '@meet-without-fear/shared';
import {
  computeChatUIState,
  ChatUIStateInputs,
  createDefaultChatUIStateInputs,
} from '../chatUIState';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates inputs with sensible defaults that can be overridden.
 */
function createInputs(overrides: Partial<ChatUIStateInputs> = {}): ChatUIStateInputs {
  return {
    ...createDefaultChatUIStateInputs(),
    isLoading: false,
    loadingCompact: false,
    ...overrides,
  };
}

// ============================================================================
// Onboarding State Tests
// ============================================================================

describe('Onboarding State (isInOnboardingUnsigned)', () => {
  it('returns true when compact not signed and stage is ONBOARDING', () => {
    const inputs = createInputs({
      myStage: Stage.ONBOARDING,
      compactMySigned: false,
      myProgress: { stage: Stage.ONBOARDING },
    });

    const result = computeChatUIState(inputs);
    expect(result.isInOnboardingUnsigned).toBe(true);
  });

  it('returns false when compact is signed', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
    });

    const result = computeChatUIState(inputs);
    expect(result.isInOnboardingUnsigned).toBe(false);
  });

  it('returns true when loading with no progress data (optimistic for invitees)', () => {
    const inputs = createInputs({
      isLoading: true,
      myProgress: undefined,
      compactMySigned: undefined,
    });

    const result = computeChatUIState(inputs);
    expect(result.isInOnboardingUnsigned).toBe(true);
  });
});

describe('Stage 4 Strategy Readiness', () => {
  it('hides input while the user is ready to rank and waiting for partner', () => {
    const inputs = createInputs({
      myStage: Stage.STRATEGIC_REPAIR,
      myProgress: { stage: Stage.STRATEGIC_REPAIR },
      strategyPhase: 'COLLECTING',
      strategyReadiness: { myReadyToRank: true, partnerReadyToRank: false },
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('strategy-readiness-pending');
    expect(result.shouldHideInput).toBe(true);
    expect(result.panels.showWaitingBanner).toBe(true);
  });
});

// ============================================================================
// Panel Priority Tests
// ============================================================================

describe('Above Input Panel Priority', () => {
  it('shows compact-agreement-bar during onboarding', () => {
    const inputs = createInputs({
      myStage: Stage.ONBOARDING,
      compactMySigned: false,
      myProgress: { stage: Stage.ONBOARDING },
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('compact-agreement-bar');
  });

  it('shows invitation panel for inviter once topic is confirmed but invitation is not', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      isInviter: true,
      hasTopicConfirmed: true,
      invitationConfirmed: false,
      invitationPanelDismissed: false,
      isConfirmingInvitation: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('invitation');
  });

  it('does not let a confirmed invitation block feel-heard', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      isInviter: true,
      hasTopicConfirmed: true,
      invitationConfirmed: true,
      invitationPanelDismissed: false,
      showFeelHeardConfirmation: true,
      feelHeardConfirmedAt: null,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('feel-heard');
  });

  it('does not show invitation panel for invitee', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      isInviter: false,
      hasTopicConfirmed: true,
      invitationPanelDismissed: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).not.toBe('invitation');
  });

  it('does not show invitation panel once the user dismisses it', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      isInviter: true,
      hasTopicConfirmed: true,
      invitationPanelDismissed: true,
      showFeelHeardConfirmation: true,
      feelHeardConfirmedAt: null,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('feel-heard');
  });

  it('shows feel-heard panel in Stage 1 when confirmation offered', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      showFeelHeardConfirmation: true,
      feelHeardConfirmedAt: null,
      isConfirmingFeelHeard: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('feel-heard');
  });

  it('does not show feel-heard panel in Stage 2', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      showFeelHeardConfirmation: true,
      feelHeardConfirmedAt: null,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).not.toBe('feel-heard');
  });

  it('shows share-suggestion panel before Subject has submitted their own empathy', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasShareSuggestion: true,
      shareOffer: { hasSuggestion: true },
      hasRespondedToShareOfferLocal: false,
      empathyAlreadyConsented: false,
      empathyDraft: { alreadyConsented: false },
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showShareSuggestionPanel).toBe(true);
    expect(result.aboveInputPanel).toBe('share-suggestion');
    expect(result.shouldHideInput).toBe(false);
  });

  it('shows share-suggestion panel when Subject has suggestion after submitting their own empathy', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasShareSuggestion: true,
      shareOffer: { hasSuggestion: true },
      hasRespondedToShareOfferLocal: false,
      empathyAlreadyConsented: true,
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('share-suggestion');
    expect(result.shouldHideInput).toBe(false);
  });

  it('prioritizes empathy revision review over optional share suggestion while refining', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasShareSuggestion: true,
      shareOffer: { hasSuggestion: true },
      hasRespondedToShareOfferLocal: false,
      empathyAlreadyConsented: true,
      empathyDraft: { alreadyConsented: true },
      isRefiningEmpathy: true,
      messageCountSinceSharedContext: 1,
      hasEmpathyContent: true,
      hasLiveProposedEmpathyStatement: true,
      hasDistinctRefinedEmpathyContent: true,
      empathyStatus: {
        hasNewSharedContext: true,
        myAttemptStatus: 'REFINING',
      },
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showShareSuggestionPanel).toBe(false);
    expect(result.panels.showEmpathyPanel).toBe(true);
    expect(result.aboveInputPanel).toBe('empathy-statement');
  });

  it('does not show share-suggestion panel after Stage 2', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      hasShareSuggestion: true,
      hasRespondedToShareOfferLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showShareSuggestionPanel).toBe(false);
  });

  it('shows empathy-statement panel when user has content to review', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasEmpathyContent: true,
      empathyAlreadyConsented: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('empathy-statement');
  });

  it('shows waiting-banner when waiting for partner', () => {
    // witness-pending only shows after user has consented to share empathy
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      partnerStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('waiting-banner');
  });

  it('invitation panel takes priority over feel-heard panel', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      isInviter: true,
      hasTopicConfirmed: true,
      invitationConfirmed: false,
      invitationPanelDismissed: false,
      showFeelHeardConfirmation: true,
      feelHeardConfirmedAt: null,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('invitation');
  });
});

// ============================================================================
// Input Hiding Tests
// ============================================================================

describe('Input Hiding (shouldHideInput)', () => {
  it('hides input during onboarding', () => {
    const inputs = createInputs({
      myStage: Stage.ONBOARDING,
      compactMySigned: false,
      myProgress: { stage: Stage.ONBOARDING },
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldHideInput).toBe(true);
  });

  it('hides input when waiting for partner in Stage 1', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      partnerStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldHideInput).toBe(true);
  });

  it('keeps input visible when awaiting-context-share panel is present', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      shareOffer: { hasSuggestion: true },
      hasShareSuggestion: true,
      empathyAlreadyConsented: true,
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('share-suggestion');
    expect(result.shouldHideInput).toBe(false);
  });

  it('keeps input visible while the empathy review panel is offered', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasEmpathyContent: true,
      empathyAlreadyConsented: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('empathy-statement');
    expect(result.shouldHideInput).toBe(false);
  });

  it('keeps input visible while the feel-heard panel is offered', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      showFeelHeardConfirmation: true,
      feelHeardConfirmedAt: null,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('feel-heard');
    expect(result.shouldHideInput).toBe(false);
  });

  it('hides input while empathy review is running', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      empathyStatus: { analyzing: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('reconciler-analyzing');
    expect(result.shouldHideInput).toBe(true);
  });

  it('hides input while revised empathy review is running', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      empathyStatus: { analyzing: true, myAttemptRevisionCount: 1 },
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('revision-analyzing');
    expect(result.shouldHideInput).toBe(true);
  });

  it('shows partner empathy validation panel while keeping chat available', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasPartnerEmpathy: true,
      myValidation: { validated: false },
      empathyStatus: { myAttemptStatus: 'REVEALED' },
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('partner-empathy-validation');
    expect(result.panels.showPartnerEmpathyValidationPanel).toBe(true);
    expect(result.shouldHideInput).toBe(false);
  });

  it('queues share suggestions behind partner empathy validation', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasPartnerEmpathy: true,
      myValidation: { validated: false },
      empathyStatus: { myAttemptStatus: 'REVEALED' },
      empathyDraft: { alreadyConsented: true },
      hasShareSuggestion: true,
      shareOffer: { hasSuggestion: true, action: 'OFFER_OPTIONAL' },
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('partner-empathy-validation');
    expect(result.panels.showShareSuggestionPanel).toBe(true);
    expect(result.shouldHideInput).toBe(false);
  });

  it('shows a waiting banner and hides input after I validate partner empathy but partner has not validated mine', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasPartnerEmpathy: true,
      myValidation: { validated: true },
      partnerValidated: false,
      empathyStatus: { myAttemptStatus: 'REVEALED' },
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('partner-validating-empathy');
    expect(result.aboveInputPanel).toBe('waiting-banner');
    expect(result.shouldHideInput).toBe(true);
  });

  it('shows a waiting banner and hides input after sending empathy revision feedback', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasPartnerEmpathy: false,
      myValidation: { validated: false, awaitingRevision: true },
      empathyStatus: {
        myAttemptStatus: 'REVEALED',
      },
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('partner-revising-empathy');
    expect(result.aboveInputPanel).toBe('waiting-banner');
    expect(result.shouldHideInput).toBe(true);
  });

  it('hides input while waiting for partner to share Stage 3 needs', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      allNeedsConfirmed: true,
      needs: { allConfirmed: true },
      needsRevealValidationCount: 0,
      needsRevealValidation: { count: 0 },
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('needs-pending');
    expect(result.shouldHideInput).toBe(true);
  });

  it('hides input after validating revealed needs while partner has not', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      allNeedsConfirmed: true,
      needs: { allConfirmed: true },
      needsRevealValidationCount: 2,
      needsRevealValidation: { count: 2, allConfirmedByMe: true, allConfirmedByBoth: false },
      needsRevealValidatedByMe: true,
      needsRevealValidatedByBoth: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('needs-validation-pending');
    expect(result.shouldHideInput).toBe(true);
  });

  it('hides input after validating no-overlap revealed needs while partner has not', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      allNeedsConfirmed: true,
      needsShared: true,
      needsRevealReady: true,
      needs: { allConfirmed: true, shared: true, revealReady: true },
      needsRevealAvailable: true,
      needsRevealValidationCount: 0,
      needsRevealValidation: {
        count: 0,
        allConfirmedByMe: true,
        allConfirmedByBoth: false,
      },
      needsRevealValidatedByMe: true,
      needsRevealValidatedByBoth: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('partner-validating-needs');
    expect(result.shouldHideInput).toBe(true);
  });

  it('hides input while the needs reveal validation panel is offered', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      allNeedsConfirmed: true,
      needsShared: true,
      needsRevealReady: true,
      needs: { allConfirmed: true, shared: true, revealReady: true },
      needsRevealAvailable: true,
      needsRevealValidationCount: 2,
      needsRevealValidation: { count: 2, allConfirmedByMe: false, allConfirmedByBoth: false },
      needsRevealValidatedByMe: false,
      needsRevealValidatedByBoth: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('needs-reveal-validation');
    expect(result.shouldHideInput).toBe(true);
  });

  it('hides input while Stage 4 agreement review owns the next action', () => {
    const inputs = createInputs({
      myStage: Stage.STRATEGIC_REPAIR,
      compactMySigned: true,
      myProgress: { stage: Stage.STRATEGIC_REPAIR },
      strategyPhase: 'NEGOTIATING',
      agreements: [{ agreedByMe: false, agreedByPartner: true }],
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldHideInput).toBe(true);
  });

  it('shows input during normal conversation', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      partnerStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldHideInput).toBe(false);
  });

  it('does NOT hide input when user has unviewed shared context (notification popup is sufficient)', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasUnviewedSharedContext: true,
      empathyStatus: { hasNewSharedContext: true },
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldHideInput).toBe(false);
  });

  it('shows input after user views Share tab (no unviewed context)', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasUnviewedSharedContext: false,
      empathyStatus: { hasNewSharedContext: true },
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldHideInput).toBe(false);
  });
});

// ============================================================================
// Inner Thoughts Button Tests
// ============================================================================

describe('Inner Thoughts Button (shouldShowInnerThoughts)', () => {
  it('shows inner thoughts in Stage 3', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldShowInnerThoughts).toBe(true);
  });

  it('shows inner thoughts in Stage 4', () => {
    const inputs = createInputs({
      myStage: Stage.STRATEGIC_REPAIR,
      compactMySigned: true,
      myProgress: { stage: Stage.STRATEGIC_REPAIR },
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldShowInnerThoughts).toBe(true);
  });

  it('shows inner thoughts when waiting for partner in Stage 2 (witness-pending)', () => {
    // witness-pending only shows after user has consented to share empathy
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      partnerStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldShowInnerThoughts).toBe(true);
  });

  it('shows inner thoughts when partner-considering-perspective', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      empathyStatus: { myAttemptStatus: 'REVEALED' },
      hasPartnerEmpathy: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldShowInnerThoughts).toBe(true);
  });

  it('does not show inner thoughts in Stage 1', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldShowInnerThoughts).toBe(false);
  });
});

// ============================================================================
// Empathy Panel Logic Tests
// ============================================================================

describe('Empathy Panel Visibility', () => {
  it('does not show in Stage 1', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      hasEmpathyContent: true,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(false);
  });

  it('shows in Stage 2 with content', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasEmpathyContent: true,
      empathyAlreadyConsented: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(true);
  });

  it('stays hidden after Edit first until the AI proposes (work-9309, owner decision 2026-11-09)', () => {
    const reopened = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasEmpathyContent: true, // the old draft is still there
      empathyAlreadyConsented: false,
      empathyAwaitingRevision: true,
    });
    expect(computeChatUIState(reopened).panels.showEmpathyPanel).toBe(false);

    // The AI's proposal ends the wait (server-derived; the stream's cache write too).
    const proposed = { ...reopened, empathyAwaitingRevision: false, hasLiveProposedEmpathyStatement: true };
    expect(computeChatUIState(proposed).panels.showEmpathyPanel).toBe(true);
  });

  it('does not show after user has already consented', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasEmpathyContent: true,
      empathyAlreadyConsented: true,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(false);
  });

  it('does not show when hasSharedEmpathyLocal is true (prevents flash)', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasEmpathyContent: true,
      hasSharedEmpathyLocal: true,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(false);
  });

  it('does not show when hasSharedEmpathyLocal is true even in refining mode', () => {
    // After user shares revised empathy from refining mode, panel should hide
    // The latch is reset when entering refining mode, but once user shares, it stays hidden
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      hasEmpathyContent: true,
      hasSharedEmpathyLocal: true,
      isRefiningEmpathy: true,
      messageCountSinceSharedContext: 1,
      empathyStatus: { hasNewSharedContext: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(false);
  });

  it('does not show in refining mode with only the prior empathy attempt', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      isRefiningEmpathy: true,
      empathyAlreadyConsented: true,
      messageCountSinceSharedContext: 1,
      myAttemptContent: true,
      empathyStatus: { hasNewSharedContext: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(false);
  });

  it('shows in refining mode after a distinct revised draft exists', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      isRefiningEmpathy: true,
      empathyAlreadyConsented: true,
      messageCountSinceSharedContext: 1,
      hasEmpathyContent: true,
      hasLiveProposedEmpathyStatement: true,
      hasDistinctRefinedEmpathyContent: true,
      myAttemptContent: true,
      empathyStatus: { hasNewSharedContext: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(true);
    expect(result.aboveInputPanel).toBe('empathy-statement');
  });

  it('does not show in refining mode before user reflects, even when an attempt is reviewable', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      isRefiningEmpathy: true,
      messageCountSinceSharedContext: 0,
      myAttemptContent: true,
      empathyStatus: { hasNewSharedContext: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(false);
    expect(result.aboveInputPanel).not.toBe('empathy-statement');
  });

  it('does not show in refining mode before user reflects when only prior draft content is reviewable', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      isRefiningEmpathy: true,
      messageCountSinceSharedContext: 0,
      hasEmpathyContent: true,
      empathyStatus: { hasNewSharedContext: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(false);
    expect(result.aboveInputPanel).not.toBe('empathy-statement');
  });

  it('shows in refining mode once the AI has produced a revised draft', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      isRefiningEmpathy: true,
      messageCountSinceSharedContext: 0,
      hasEmpathyContent: true,
      hasLiveProposedEmpathyStatement: true,
      hasDistinctRefinedEmpathyContent: true,
      empathyStatus: { hasNewSharedContext: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(true);
    expect(result.aboveInputPanel).toBe('empathy-statement');
  });

  it('does not show in refining mode before user sends another message when no content is reviewable', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      isRefiningEmpathy: true,
      messageCountSinceSharedContext: 0,
      hasEmpathyContent: false,
      myAttemptContent: false,
      empathyStatus: { hasNewSharedContext: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showEmpathyPanel).toBe(false);
  });
});

// ============================================================================
// Waiting Status Integration Tests
// ============================================================================

describe('Waiting Status Integration', () => {
  it('correctly computes waiting status from inputs', () => {
    // witness-pending only shows after user has consented to share empathy
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      partnerStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      empathyDraft: { alreadyConsented: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('witness-pending');
  });

  it('blocks input for reconciler-analyzing (no spinner)', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      empathyStatus: { analyzing: true },
    });

    const result = computeChatUIState(inputs);
    expect(result.waitingStatus).toBe('reconciler-analyzing');
    expect(result.waitingStatusConfig.showSpinner).toBe(false);
    expect(result.waitingStatusConfig.showKeepChattingAction).toBe(false);
    expect(result.waitingStatusConfig.hideInput).toBe(true);
  });
});

// ============================================================================
// Typewriter Animation Integration
// ============================================================================

describe('Typewriter Animation Integration', () => {
  it('shouldAnimatePanel is false when typewriter is animating', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      isTypewriterAnimating: true,
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldAnimatePanel).toBe(false);
  });

  it('shouldAnimatePanel is true when typewriter is not animating', () => {
    const inputs = createInputs({
      myStage: Stage.WITNESS,
      compactMySigned: true,
      myProgress: { stage: Stage.WITNESS },
      isTypewriterAnimating: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.shouldAnimatePanel).toBe(true);
  });
});

// ============================================================================
// Stage 3: Needs Review Panel Tests
// ============================================================================

describe('Needs Review Panel Visibility', () => {
  it('does not show a review panel just because needs are available in Stage 3', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsAvailable: true,
      allNeedsConfirmed: false,
      needsShared: false,
      hasConfirmedNeedsLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsSendPanel).toBe(false);
    expect(result.aboveInputPanel).toBeNull();
  });

  it('does not show when not in Stage 3', () => {
    const inputs = createInputs({
      myStage: Stage.PERSPECTIVE_STRETCH,
      compactMySigned: true,
      myProgress: { stage: Stage.PERSPECTIVE_STRETCH },
      needsAvailable: true,
      allNeedsConfirmed: false,
      needsShared: false,
      hasConfirmedNeedsLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsSendPanel).toBe(false);
  });

  it('shows needs-send after all live needs are locked so the user can share explicitly', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsAvailable: true,
      allNeedsConfirmed: true,
      needsShared: false,
      hasConfirmedNeedsLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsSendPanel).toBe(true);
    expect(result.aboveInputPanel).toBe('needs-send');
  });

  it('shows needs-send even when the local confirm latch is still set after server confirmation', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsAvailable: true,
      allNeedsConfirmed: true,
      needsShared: false,
      hasConfirmedNeedsLocal: true,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsSendPanel).toBe(true);
    expect(result.aboveInputPanel).toBe('needs-send');
  });

  it('does not show when needs are already shared', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsAvailable: true,
      allNeedsConfirmed: false,
      needsShared: true,
      hasConfirmedNeedsLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsSendPanel).toBe(false);
  });

  it('does not show when only the confirm latch is set and needs are not locked', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsAvailable: true,
      allNeedsConfirmed: false,
      needsShared: false,
      hasConfirmedNeedsLocal: true,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsSendPanel).toBe(false);
  });

  it('does not show when no needs available', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsAvailable: false,
      allNeedsConfirmed: false,
      needsShared: false,
      hasConfirmedNeedsLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsSendPanel).toBe(false);
  });
});

// ============================================================================
// Stage 3: Needs Reveal Validation Panel Tests
// ============================================================================

describe('Needs Reveal Validation Panel Visibility', () => {
  it('shows when the side-by-side needs reveal is available in Stage 3', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsRevealAvailable: true,
      needsRevealValidatedByMe: false,
      needsRevealValidatedByBoth: false,
      hasValidatedNeedsRevealLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsRevealValidationPanel).toBe(true);
    expect(result.aboveInputPanel).toBe('needs-reveal-validation');
  });

  it('does not show when not in Stage 3', () => {
    const inputs = createInputs({
      myStage: Stage.STRATEGIC_REPAIR,
      compactMySigned: true,
      myProgress: { stage: Stage.STRATEGIC_REPAIR },
      needsRevealAvailable: true,
      needsRevealValidatedByMe: false,
      needsRevealValidatedByBoth: false,
      hasValidatedNeedsRevealLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsRevealValidationPanel).toBe(false);
  });

  it('does not show when already confirmed by me', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsRevealAvailable: true,
      needsRevealValidatedByMe: true,
      needsRevealValidatedByBoth: false,
      hasValidatedNeedsRevealLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsRevealValidationPanel).toBe(false);
  });

  it('does not show when already confirmed by both', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsRevealAvailable: true,
      needsRevealValidatedByMe: false,
      needsRevealValidatedByBoth: true,
      hasValidatedNeedsRevealLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsRevealValidationPanel).toBe(false);
  });

  it('does not show when local latch is set (prevents flash)', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsRevealAvailable: true,
      needsRevealValidatedByMe: false,
      needsRevealValidatedByBoth: false,
      hasValidatedNeedsRevealLocal: true,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsRevealValidationPanel).toBe(false);
  });

  it('does not show when the needs reveal is unavailable', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsRevealAvailable: false,
      needsRevealValidatedByMe: false,
      needsRevealValidatedByBoth: false,
      hasValidatedNeedsRevealLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsRevealValidationPanel).toBe(false);
  });

  it('shows for the legacy noOverlap compatibility state', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsRevealAvailable: false,
      needsRevealNoOverlap: true,
      needsRevealValidatedByMe: false,
      needsRevealValidatedByBoth: false,
      hasValidatedNeedsRevealLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.panels.showNeedsRevealValidationPanel).toBe(true);
    expect(result.aboveInputPanel).toBe('needs-reveal-validation');
  });

  it('needs-send takes priority over needs-reveal-validation', () => {
    const inputs = createInputs({
      myStage: Stage.NEED_MAPPING,
      compactMySigned: true,
      myProgress: { stage: Stage.NEED_MAPPING },
      needsAvailable: true,
      allNeedsConfirmed: true,
      needsShared: false,
      hasConfirmedNeedsLocal: false,
      needsRevealAvailable: true,
      needsRevealValidatedByMe: false,
      needsRevealValidatedByBoth: false,
      hasValidatedNeedsRevealLocal: false,
    });

    const result = computeChatUIState(inputs);
    expect(result.aboveInputPanel).toBe('needs-send');
  });
});
