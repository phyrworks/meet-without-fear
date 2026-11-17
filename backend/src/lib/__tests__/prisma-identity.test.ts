import { assertIdentityBindingOn, identityBindingEnabled, keepRequestContextAcrossBatching } from '../prisma-identity';
import { PrismaClient } from '../../generated/prisma/client';
import { createPrismaPgAdapter } from '../prisma-pg';

describe('identityBindingEnabled', () => {
  it('is off by default and for "off" or empty', () => {
    expect(identityBindingEnabled({})).toBe(false);
    expect(identityBindingEnabled({ DB_IDENTITY_BINDING: 'off' })).toBe(false);
    expect(identityBindingEnabled({ DB_IDENTITY_BINDING: '' })).toBe(false);
  });

  it('is on for "on"', () => {
    expect(identityBindingEnabled({ DB_IDENTITY_BINDING: 'on' })).toBe(true);
  });

  it('rejects anything else rather than guessing', () => {
    expect(() => identityBindingEnabled({ DB_IDENTITY_BINDING: 'true' })).toThrow(/DB_IDENTITY_BINDING/);
  });
});

// work-k5fk.10.5 review F7 (decided): the definers' app arms and every identity-bound read need the request's
// identity in the database, so the API refuses to start without it — fail closed, never a silently unbound app.
describe('assertIdentityBindingOn (startup)', () => {
  it('refuses to start with identity binding off or unset', () => {
    expect(() => assertIdentityBindingOn({})).toThrow(/DB_IDENTITY_BINDING=on is required/);
    expect(() => assertIdentityBindingOn({ DB_IDENTITY_BINDING: 'off' })).toThrow(/DB_IDENTITY_BINDING=on is required/);
  });

  it('starts with it on', () => {
    expect(() => assertIdentityBindingOn({ DB_IDENTITY_BINDING: 'on' })).not.toThrow();
  });
});

describe('keepRequestContextAcrossBatching', () => {
  it('finds the dataloader internals on this Prisma version (no database needed)', () => {
    const client = new PrismaClient({ adapter: createPrismaPgAdapter('postgresql://u:p@localhost:1/none') });
    expect(() => keepRequestContextAcrossBatching(client)).not.toThrow();
  });

  it('fails loudly when the internals are not there', () => {
    expect(() => keepRequestContextAcrossBatching({})).toThrow(/internals/);
  });
});
