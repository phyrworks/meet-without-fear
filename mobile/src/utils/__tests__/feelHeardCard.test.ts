/**
 * work-k5fk.34 (owner decision 2026-11-25, review clients C5): the "Do you feel heard?" card is
 * derived from the persisted offer on the cached progress, so it survives a reload or another
 * device — not only from this view's stream trigger.
 */
import { shouldShowFeelHeardCard } from '../feelHeardCard';

const base = {
  isWitnessStage: true,
  offeredPersisted: false,
  offeredByStream: false,
  feelHeardReached: false,
  dismissed: false,
  confirmedHere: false,
};

describe('shouldShowFeelHeardCard', () => {
  it('shows after a reload from the persisted offer alone (no stream trigger in this view)', () => {
    expect(shouldShowFeelHeardCard({ ...base, offeredPersisted: true })).toBe(true);
  });

  it('shows from the stream trigger before the cache has the offer', () => {
    expect(shouldShowFeelHeardCard({ ...base, offeredByStream: true })).toBe(true);
  });

  it('does not show without an offer', () => {
    expect(shouldShowFeelHeardCard(base)).toBe(false);
  });

  it('hides once answered (feel_heard reached, or confirmed here), dismissed, or outside Stage 1', () => {
    const offered = { ...base, offeredPersisted: true };
    expect(shouldShowFeelHeardCard({ ...offered, feelHeardReached: true })).toBe(false);
    expect(shouldShowFeelHeardCard({ ...offered, confirmedHere: true })).toBe(false);
    expect(shouldShowFeelHeardCard({ ...offered, dismissed: true })).toBe(false);
    expect(shouldShowFeelHeardCard({ ...offered, isWitnessStage: false })).toBe(false);
  });
});
