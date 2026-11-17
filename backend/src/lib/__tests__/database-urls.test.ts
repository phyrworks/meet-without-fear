import { databaseUrlFor, DATABASE_URL_VARS, FAIL_CLOSED } from '../database-urls';

const ROOT = 'postgresql://root:pw@db:5432/mwf';

describe('databaseUrlFor', () => {
  it.each(Object.entries(DATABASE_URL_VARS))('%s uses %s when it is set', (role, variable) => {
    const own = `postgresql://mwf_${role}:pw@db:5432/mwf?connection_limit=4`;
    expect(databaseUrlFor(role as keyof typeof DATABASE_URL_VARS, { DATABASE_URL: ROOT, [variable]: own })).toBe(own);
  });

  it('has no job role any more, and an AI and a worker role (work-k5fk.10.5)', () => {
    expect(Object.keys(DATABASE_URL_VARS).sort()).toEqual(['ai', 'app', 'auth', 'ops', 'worker']);
    expect([...FAIL_CLOSED].sort()).toEqual(['ai', 'ops', 'worker']);
  });

  it.each(Object.keys(DATABASE_URL_VARS).filter(r => !FAIL_CLOSED.has(r as keyof typeof DATABASE_URL_VARS)))(
    '%s falls back to DATABASE_URL when its own variable is unset',
    role => {
      expect(databaseUrlFor(role as keyof typeof DATABASE_URL_VARS, { DATABASE_URL: ROOT })).toBe(ROOT);
    },
  );

  it('treats an empty role variable as unset (compose passes empty strings through)', () => {
    expect(databaseUrlFor('auth', { DATABASE_URL: ROOT, AUTH_DATABASE_URL: '' })).toBe(ROOT);
  });

  it('does not let one role pick up another role variable', () => {
    expect(databaseUrlFor('auth', { DATABASE_URL: ROOT, APP_DATABASE_URL: 'postgresql://a@h/db' })).toBe(ROOT);
  });

  // TS-12 fix round 1 (M13): the ops connection is the read-only dashboard role; falling back to
  // DATABASE_URL (the migration/root URL) would silently lose it. Fail closed.
  it('ops never falls back to DATABASE_URL (or another role variable): unset is undefined', () => {
    expect(databaseUrlFor('ops', { DATABASE_URL: ROOT })).toBeUndefined();
    expect(databaseUrlFor('ops', { DATABASE_URL: ROOT, OPS_DATABASE_URL: '' })).toBeUndefined();
    expect(databaseUrlFor('ops', { DATABASE_URL: ROOT, APP_DATABASE_URL: 'postgresql://a@h/db' })).toBeUndefined();
  });

  // work-k5fk.10.5: neither do the AI and the worker — their grants are narrow by design, and the root
  // URL would run their writes as the migration role (with the database owner's exemptions).
  it.each(['ai', 'worker'] as const)('%s never falls back to DATABASE_URL (or another role variable)', role => {
    expect(databaseUrlFor(role, { DATABASE_URL: ROOT })).toBeUndefined();
    expect(databaseUrlFor(role, { DATABASE_URL: ROOT, [DATABASE_URL_VARS[role]]: '' })).toBeUndefined();
    expect(databaseUrlFor(role, { DATABASE_URL: ROOT, APP_DATABASE_URL: 'postgresql://a@h/db' })).toBeUndefined();
  });

  it('is undefined when neither is set', () => {
    expect(databaseUrlFor('app', {})).toBeUndefined();
  });

  it('rejects a role variable that is not a URL, naming the variable', () => {
    expect(() => databaseUrlFor('auth', { DATABASE_URL: ROOT, AUTH_DATABASE_URL: 'not a url' })).toThrow(
      /AUTH_DATABASE_URL/,
    );
  });
});
