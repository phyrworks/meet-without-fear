/**
 * Tests for OFFER_OPTIONAL handling in the reconciler service.
 *
 * These tests verify the behavior described in the OFFER_OPTIONAL spec:
 * - OFFER_OPTIONAL with suggestedShareFocus should trigger the share flow
 * - OFFER_OPTIONAL without suggestedShareFocus should be treated as PROCEED (US-8)
 * - PROCEED always marks direction as ready
 * - OFFER_SHARING always triggers the share flow
 */

import { ReconcilerResult } from '@meet-without-fear/shared';

// Helper function to test - mirrors the logic in reconciler.ts
function isDirectionReady(result: ReconcilerResult | null): boolean {
  if (!result) return true;
  const { action, suggestedShareFocus } = result.recommendation;
  if (action === 'PROCEED') return true;
  if (action === 'OFFER_OPTIONAL' && !suggestedShareFocus) return true;
  return false;
}

// Helper function to test - mirrors the logic in reconciler.ts
function shouldOfferSharing(action: string, suggestedShareFocus: string | null): boolean {
  return action === 'OFFER_SHARING' || (action === 'OFFER_OPTIONAL' && !!suggestedShareFocus);
}

describe('OFFER_OPTIONAL Handling', () => {
  describe('isDirectionReady', () => {
    it('returns true when result is null (skipped)', () => {
      expect(isDirectionReady(null)).toBe(true);
    });

    it('returns true when action is PROCEED', () => {
      const result = createMockResult('PROCEED', null);
      expect(isDirectionReady(result)).toBe(true);
    });

    it('returns true when action is OFFER_OPTIONAL but no suggestedShareFocus (US-8)', () => {
      const result = createMockResult('OFFER_OPTIONAL', null);
      expect(isDirectionReady(result)).toBe(true);
    });

    it('returns false when action is OFFER_OPTIONAL with suggestedShareFocus', () => {
      const result = createMockResult('OFFER_OPTIONAL', 'Some topic to share about');
      expect(isDirectionReady(result)).toBe(false);
    });

    it('returns false when action is OFFER_SHARING (regardless of suggestedShareFocus)', () => {
      const resultWithFocus = createMockResult('OFFER_SHARING', 'Some topic');
      const resultWithoutFocus = createMockResult('OFFER_SHARING', null);

      expect(isDirectionReady(resultWithFocus)).toBe(false);
      expect(isDirectionReady(resultWithoutFocus)).toBe(false);
    });
  });

  describe('shouldOfferSharing', () => {
    it('returns false for PROCEED action', () => {
      expect(shouldOfferSharing('PROCEED', null)).toBe(false);
      expect(shouldOfferSharing('PROCEED', 'Some focus')).toBe(false);
    });

    it('returns true for OFFER_SHARING action (always)', () => {
      expect(shouldOfferSharing('OFFER_SHARING', null)).toBe(true);
      expect(shouldOfferSharing('OFFER_SHARING', 'Some focus')).toBe(true);
    });

    it('returns false for OFFER_OPTIONAL without suggestedShareFocus (US-8)', () => {
      expect(shouldOfferSharing('OFFER_OPTIONAL', null)).toBe(false);
    });

    it('returns true for OFFER_OPTIONAL with suggestedShareFocus', () => {
      expect(shouldOfferSharing('OFFER_OPTIONAL', 'Fear of disconnection')).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('treats empty string suggestedShareFocus as falsy (US-8)', () => {
      // Empty string should be treated like null
      expect(shouldOfferSharing('OFFER_OPTIONAL', '')).toBe(false);

      const result = createMockResult('OFFER_OPTIONAL', '');
      expect(isDirectionReady(result)).toBe(true);
    });
  });
});

// Helper to create mock ReconcilerResult
function createMockResult(
  action: 'PROCEED' | 'OFFER_OPTIONAL' | 'OFFER_SHARING',
  suggestedShareFocus: string | null,
): ReconcilerResult {
  return {
    alignment: {
      score: 75,
      summary: 'Test alignment',
      correctlyIdentified: ['emotion1'],
    },
    gaps: {
      severity: action === 'PROCEED' ? 'minor' : 'moderate',
      summary: 'Test gap summary',
      missedFeelings: action === 'PROCEED' ? [] : ['missed1'],
      misattributions: [],
      mostImportantGap: action === 'PROCEED' ? null : 'Test gap',
    },
    recommendation: {
      action,
      rationale: 'Test rationale',
      sharingWouldHelp: action !== 'PROCEED',
      suggestedShareFocus,
    },
    abstractGuidance: {
      areaHint: 'Test area',
      guidanceType: 'explore_deeper_feelings',
      promptSeed: 'Test prompt seed',
    },
  };
}
