/**
 * The Stage 4 walkthrough's default check-in date is today (UTC) + 10 days,
 * whatever the server's time zone — also across a DST change (TS-12: the
 * local-time arithmetic gave +11 days in Los Angeles on 2026-10-27, five days
 * before the US change on Nov 1).
 */

import { defaultCheckInDate } from '../stage4-state';

describe('defaultCheckInDate', () => {
  const tz = process.env.TZ;
  afterAll(() => {
    process.env.TZ = tz;
  });

  it('is UTC today + 10 days in a zone that changes DST inside the window', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(defaultCheckInDate(new Date('2026-10-27T23:56:00Z'))).toBe('2026-11-06');
    expect(defaultCheckInDate(new Date('2026-03-01T23:30:00Z'))).toBe('2026-03-11');
  });

  it('is UTC today + 10 days in UTC', () => {
    process.env.TZ = 'UTC';
    expect(defaultCheckInDate(new Date('2026-10-27T23:56:00Z'))).toBe('2026-11-06');
  });
});
