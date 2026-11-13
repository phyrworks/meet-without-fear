/**
 * The E2E auth bypass is an allow-list: it is on only when E2E_AUTH_BYPASS is
 * exactly 'true' AND NODE_ENV is exactly 'test' or 'development'. Anything
 * else (unset, misspelt, staging, production) is off.
 */
import { isE2EBypassEnabled, isE2EBypassMisconfigured } from '../e2e-bypass';

describe('isE2EBypassEnabled', () => {
  it.each([
    ['test', 'true'],
    ['development', 'true'],
  ])('is on for NODE_ENV=%s, E2E_AUTH_BYPASS=%s', (NODE_ENV, E2E_AUTH_BYPASS) => {
    expect(isE2EBypassEnabled({ NODE_ENV, E2E_AUTH_BYPASS })).toBe(true);
    expect(isE2EBypassMisconfigured({ NODE_ENV, E2E_AUTH_BYPASS })).toBe(false);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['production', 'production'],
    ['staging', 'staging'],
    ['misspelt dev', 'develop'],
    ['misspelt prod', 'prod'],
    ['wrong case', 'Test'],
    ['padded', ' test'],
  ])('is off, and misconfigured, for NODE_ENV %s', (_label, NODE_ENV) => {
    expect(isE2EBypassEnabled({ NODE_ENV, E2E_AUTH_BYPASS: 'true' })).toBe(false);
    expect(isE2EBypassMisconfigured({ NODE_ENV, E2E_AUTH_BYPASS: 'true' })).toBe(true);
  });

  it.each([undefined, '', 'false', 'TRUE', '1', 'yes'])('is off when E2E_AUTH_BYPASS=%p', (E2E_AUTH_BYPASS) => {
    expect(isE2EBypassEnabled({ NODE_ENV: 'test', E2E_AUTH_BYPASS })).toBe(false);
    expect(isE2EBypassMisconfigured({ NODE_ENV: 'production', E2E_AUTH_BYPASS })).toBe(false);
  });

  it('reads process.env by default', () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, E2E_AUTH_BYPASS: process.env.E2E_AUTH_BYPASS };
    try {
      process.env.E2E_AUTH_BYPASS = 'true';
      process.env.NODE_ENV = 'test';
      expect(isE2EBypassEnabled()).toBe(true);
      delete process.env.NODE_ENV;
      expect(isE2EBypassEnabled()).toBe(false);
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.E2E_AUTH_BYPASS === undefined) delete process.env.E2E_AUTH_BYPASS;
      else process.env.E2E_AUTH_BYPASS = saved.E2E_AUTH_BYPASS;
    }
  });
});
