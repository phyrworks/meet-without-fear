/**
 * reminder.cadence is the reminder_cadence enum (work-gevt): the route maps a
 * client's text onto a member, aliases included, and refuses anything else.
 */

jest.mock('../../lib/prisma', () => ({ prisma: {} }));

import { REMINDER_CADENCES, parseReminderCadence } from '../tending.service';

describe('parseReminderCadence', () => {
  it('accepts every member as is', () => {
    for (const c of REMINDER_CADENCES) expect(parseReminderCadence(c)).toBe(c);
  });

  it('ignores case, spaces and hyphens, and maps the two-month aliases', () => {
    expect(parseReminderCadence(' weekly ')).toBe('WEEKLY');
    expect(parseReminderCadence('every couple-months')).toBe('EVERY_COUPLE_MONTHS');
    expect(parseReminderCadence('every two months')).toBe('EVERY_COUPLE_MONTHS');
    expect(parseReminderCadence('bimonthly')).toBe('EVERY_COUPLE_MONTHS');
  });

  it('refuses anything else (the route answers 400)', () => {
    expect(parseReminderCadence('fortnightly')).toBeNull();
    expect(parseReminderCadence('')).toBeNull();
  });
});
