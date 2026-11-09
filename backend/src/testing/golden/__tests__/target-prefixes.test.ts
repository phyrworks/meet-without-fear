/**
 * work-9309: MWF_TARGET_FIXTURE_PREFIX — a session's own target templates and
 * runs, never the shared mwf_tfx_* / another session's mwf_trun_*.
 */

import { targetPrefixes, TARGET_FIXTURE_PREFIX_ENV } from '../fixtures';

describe('targetPrefixes', () => {
  it('unset (or empty) is exactly the default: mwf_tfx_ / mwf_trun_, the committed manifests', () => {
    const def = { fixture: 'mwf_tfx_', run: 'mwf_trun_', manifestSubdir: null };
    expect(targetPrefixes({})).toEqual(def);
    expect(targetPrefixes({ [TARGET_FIXTURE_PREFIX_ENV]: '' })).toEqual(def);
  });

  it('accepts mwf_tfx_<tag>_ and derives its own run prefix and manifest directory', () => {
    expect(targetPrefixes({ [TARGET_FIXTURE_PREFIX_ENV]: 'mwf_tfx_f9309_' })).toEqual({
      fixture: 'mwf_tfx_f9309_',
      run: 'mwf_trun_f9309_',
      manifestSubdir: 'override-f9309',
    });
  });

  it.each([
    'mwf_tfx_', // the default itself, spelled out: not an override
    'mwf_tfx_f9309', // no trailing underscore
    'mwf_tfx_F9309_', // upper case
    'mwf_tfx_f_9309_', // a second segment: would overlap another tag's names
    'mwf_trun_f9309_',
    'mwf_target_test_',
    'mwf_tfx_f9309_; DROP DATABASE x; --',
    ' mwf_tfx_f9309_',
  ])('refuses %j', value => {
    expect(() => targetPrefixes({ [TARGET_FIXTURE_PREFIX_ENV]: value })).toThrow(/refused/);
  });
});
