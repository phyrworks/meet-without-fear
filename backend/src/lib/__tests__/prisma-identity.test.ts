import { identityBindingEnabled, keepRequestContextAcrossBatching } from '../prisma-identity';
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

describe('keepRequestContextAcrossBatching', () => {
  it('finds the dataloader internals on this Prisma version (no database needed)', () => {
    const client = new PrismaClient({ adapter: createPrismaPgAdapter('postgresql://u:p@localhost:1/none') });
    expect(() => keepRequestContextAcrossBatching(client)).not.toThrow();
  });

  it('fails loudly when the internals are not there', () => {
    expect(() => keepRequestContextAcrossBatching({})).toThrow(/internals/);
  });
});
