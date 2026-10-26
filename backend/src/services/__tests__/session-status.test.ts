/** The session-status shim (TS-9 fix round 1): PAUSED is ACTIVE + a `paused` milestone. */

import { displayStatus, parseStatusFilter } from '../session-status';

describe('session-status shim', () => {
  it('reads an ACTIVE session holding a paused milestone as PAUSED, nothing else', () => {
    expect(displayStatus('ACTIVE', true)).toBe('PAUSED');
    expect(displayStatus('ACTIVE', false)).toBe('ACTIVE');
    expect(displayStatus('RESOLVED', true)).toBe('RESOLVED');
    expect(displayStatus('INVITED', false)).toBe('INVITED');
  });

  it('maps the list filter onto the target, rejecting unknown values', () => {
    expect(parseStatusFilter(undefined)).toEqual({ kind: 'none' });
    expect(parseStatusFilter('PAUSED')).toEqual({ kind: 'status', status: 'ACTIVE', paused: true });
    expect(parseStatusFilter('ACTIVE')).toEqual({ kind: 'status', status: 'ACTIVE', paused: false });
    expect(parseStatusFilter('WAITING')).toEqual({ kind: 'status', status: 'ACTIVE', paused: false });
    expect(parseStatusFilter('RESOLVED')).toEqual({ kind: 'status', status: 'RESOLVED' });
    expect(parseStatusFilter('NOPE')).toEqual({ kind: 'invalid', value: 'NOPE' });
    expect(parseStatusFilter(['ACTIVE'])).toEqual({ kind: 'invalid', value: 'ACTIVE' });
  });
});
