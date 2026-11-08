/**
 * work-2doq: the viewed instant recorded for a received shared frame.
 */

jest.mock('../../lib/prisma', () => ({ prisma: {} }));

import { sharedContextViewedInstant } from '../shared-context-view';

const t = (ms: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, 0, ms));

describe('sharedContextViewedInstant', () => {
  it('is now when the viewed frame is the newest delivered one', () => {
    expect(sharedContextViewedInstant({ now: t(900), viewedAt: t(100), nextAt: null })).toEqual(t(900));
  });

  it('stops 1 ms before a newer frame the recipient has not been shown', () => {
    expect(sharedContextViewedInstant({ now: t(900), viewedAt: t(100), nextAt: t(500) })).toEqual(t(499));
  });

  it('is now when a newer frame is still in the future of now', () => {
    expect(sharedContextViewedInstant({ now: t(300), viewedAt: t(100), nextAt: t(500) })).toEqual(t(300));
  });

  it('never falls before the viewed frame itself (clock skew)', () => {
    expect(sharedContextViewedInstant({ now: t(50), viewedAt: t(100), nextAt: null })).toEqual(t(100));
    expect(sharedContextViewedInstant({ now: t(900), viewedAt: t(100), nextAt: t(100) })).toEqual(t(100));
  });
});
