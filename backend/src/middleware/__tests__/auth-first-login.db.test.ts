/**
 * First login of a Clerk identity (work-jv9y), against a real, migrated database.
 *
 * The slow path in middleware/auth.ts creates the User row for a Clerk id it has
 * not seen before. It must:
 *   - take the email only from the user's PRIMARY address, and only when Clerk
 *     reports that address verified (not emailAddresses[0]);
 *   - never bind an existing row to a different Clerk identity because the
 *     emails match: that re-bind was an account takeover;
 *   - keep resolving the concurrent-create race (same Clerk id) as before.
 *
 * Clerk itself is mocked; Prisma is the real client over DB_TEST_URL, so the
 * assertions are on database state. Runs when DB_TEST_URL is set (or in CI);
 * skipped elsewhere, like the other *.db tests.
 */
import { Request, Response } from 'express';
import { ErrorCode } from '@meet-without-fear/shared';
import { requireAuth } from '../auth';
import { AppError } from '../errors';
import { logger } from '../../lib/logger';
import type { PrismaClient } from '../../generated/prisma/client';

const url = process.env.DB_TEST_URL ?? (process.env.CI ? process.env.DATABASE_URL : undefined);
const describeDb = url ? describe : describe.skip;

// The middleware imports `prisma` from lib/prisma; point it at the test DB.
jest.mock('../../lib/prisma', () => {
  const dbUrl = process.env.DB_TEST_URL ?? (process.env.CI ? process.env.DATABASE_URL : undefined);
  if (!dbUrl) return { prisma: {} };
  const actual = jest.requireActual('../../lib/prisma');
  return { prisma: actual.createPrismaClient({ url: dbUrl }) };
});

const mockVerifyToken = jest.fn();
const mockGetUser = jest.fn();
jest.mock('@clerk/express', () => ({
  verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
  clerkClient: { users: { getUser: (...args: unknown[]) => mockGetUser(...args) } },
}));

type ClerkEmail = { id: string; emailAddress: string; verification: { status: string } | null };

function clerkUser(opts: {
  primaryEmailAddressId: string | null;
  emailAddresses: ClerkEmail[];
  firstName?: string | null;
  lastName?: string | null;
}) {
  return { firstName: null, lastName: null, ...opts };
}

const verified = (id: string, emailAddress: string): ClerkEmail => ({
  id,
  emailAddress,
  verification: { status: 'verified' },
});
const unverified = (id: string, emailAddress: string): ClerkEmail => ({
  id,
  emailAddress,
  verification: { status: 'unverified' },
});

/** Run requireAuth as clerkId; resolve with what it passed to next(). */
async function authenticate(clerkId: string): Promise<{ req: Request; err: unknown }> {
  mockVerifyToken.mockResolvedValue({ sub: clerkId });
  const req = { headers: { authorization: 'Bearer t' }, params: {} } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
  let err: unknown = 'next-not-called';
  await requireAuth(req, res, (e?: unknown) => {
    err = e;
  });
  return { req, err };
}

describeDb('first login of a Clerk identity (database)', () => {
  let prisma: PrismaClient;
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = (tag: string) => `jv9y-${tag}-${run}@example.test`;
  const cid = (tag: string) => `user_jv9y_${tag}_${run}`;

  beforeAll(() => {
    process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_jv9y';
    prisma = jest.requireMock('../../lib/prisma').prisma;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: run, mode: 'insensitive' } } });
    await prisma.user.deleteMany({ where: { clerkId: { contains: run } } });
    await prisma.$disconnect();
  });

  it('uses the verified primary email even when it is not emailAddresses[0]', async () => {
    mockGetUser.mockResolvedValue(
      clerkUser({
        primaryEmailAddressId: 'idn_primary',
        emailAddresses: [unverified('idn_other', email('decoy')), verified('idn_primary', email('primary'))],
        firstName: 'Pri',
        lastName: 'Mary',
      })
    );

    const { req, err } = await authenticate(cid('primary'));

    expect(err).toBeUndefined();
    const row = await prisma.user.findUnique({ where: { clerkId: cid('primary') } });
    expect(row?.email).toBe(email('primary'));
    expect(row?.name).toBe('Pri Mary');
    expect(req.user?.id).toBe(row?.id);
    expect(await prisma.user.findUnique({ where: { email: email('decoy') } })).toBeNull();
  });

  it('refuses an unverified primary email and creates no row', async () => {
    mockGetUser.mockResolvedValue(
      clerkUser({
        primaryEmailAddressId: 'idn_primary',
        // a verified secondary does not stand in for the primary
        emailAddresses: [unverified('idn_primary', email('unverified')), verified('idn_2', email('secondary'))],
      })
    );

    const { req, err } = await authenticate(cid('unverified'));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
    expect((err as AppError).code).toBe(ErrorCode.EMAIL_NOT_VERIFIED);
    expect(req.user).toBeUndefined();
    expect(await prisma.user.findUnique({ where: { clerkId: cid('unverified') } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { email: email('unverified') } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { email: email('secondary') } })).toBeNull();
  });

  it('refuses a user with no primary email (no placeholder row)', async () => {
    mockGetUser.mockResolvedValue(clerkUser({ primaryEmailAddressId: null, emailAddresses: [] }));

    const { err } = await authenticate(cid('noemail'));

    expect((err as AppError).statusCode).toBe(403);
    expect((err as AppError).code).toBe(ErrorCode.EMAIL_NOT_VERIFIED);
    expect(await prisma.user.findUnique({ where: { clerkId: cid('noemail') } })).toBeNull();
  });

  it('still resolves the concurrent-create race for the same Clerk id', async () => {
    mockGetUser.mockResolvedValue(
      clerkUser({ primaryEmailAddressId: 'idn_r', emailAddresses: [verified('idn_r', email('race'))] })
    );

    const results = await Promise.all([
      authenticate(cid('race')),
      authenticate(cid('race')),
      authenticate(cid('race')),
    ]);

    for (const { err } of results) expect(err).toBeUndefined();
    const rows = await prisma.user.findMany({ where: { clerkId: cid('race') } });
    expect(rows).toHaveLength(1);
    for (const { req } of results) expect(req.user?.id).toBe(rows[0].id);
  });

  it('resolves the race when the other request wins between lookup and create', async () => {
    // Deterministic version of the race: the row for this Clerk id appears
    // after the fast-path lookup, so create() hits P2002.
    mockGetUser.mockImplementation(async () => {
      await prisma.user.create({ data: { clerkId: cid('race2'), email: email('race2') } });
      return clerkUser({ primaryEmailAddressId: 'idn_r2', emailAddresses: [verified('idn_r2', email('race2'))] });
    });

    const { req, err } = await authenticate(cid('race2'));

    expect(err).toBeUndefined();
    const row = await prisma.user.findUniqueOrThrow({ where: { clerkId: cid('race2') } });
    expect(req.user?.id).toBe(row.id);
  });

  it('stores the primary email trimmed and lowercased', async () => {
    const raw = `  ${email('Padded').toUpperCase()}\t`;
    mockGetUser.mockResolvedValue(
      clerkUser({ primaryEmailAddressId: 'idn_p', emailAddresses: [verified('idn_p', raw)] })
    );

    const { err } = await authenticate(cid('padded'));

    expect(err).toBeUndefined();
    const row = await prisma.user.findUniqueOrThrow({ where: { clerkId: cid('padded') } });
    expect(row.email).toBe(email('padded'));
  });

  describe.each([
    ['case, bound to a different Clerk id', (tag: string) => cid(`case_victim_${tag}`), 'cother', (e: string) => e.replace('@example.test', '@Example.Test')],
    ['case, with no Clerk id', () => null, 'cnull', (e: string) => e.replace('@example.test', '@Example.Test')],
    ['surrounding whitespace, with no Clerk id', () => null, 'pnull', (e: string) => ` ${e}\t`],
    ['whitespace and case, bound to a different Clerk id', (tag: string) => cid(`pad_victim_${tag}`), 'pother', (e: string) => `  ${e.toUpperCase()} `],
  ])('an existing row whose email differs only in %s', (_label, existingClerkId, tag, legacyForm) => {
    it('is refused with 409 and no second row is created', async () => {
      // A pre-fix row stored verbatim (original case and padding).
      const stored = legacyForm(email(`Case-${tag}`));
      const victim = await prisma.user.create({ data: { email: stored, clerkId: existingClerkId(tag) } });
      mockGetUser.mockResolvedValue(
        clerkUser({
          primaryEmailAddressId: 'idn_a',
          emailAddresses: [verified('idn_a', stored.trim().toLowerCase())],
        })
      );

      const { err } = await authenticate(cid(`case_attacker_${tag}`));

      expect((err as AppError).statusCode).toBe(409);
      expect((err as AppError).code).toBe(ErrorCode.ACCOUNT_LINK_CONFLICT);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).toEqual(victim);
      expect(await prisma.user.findUnique({ where: { clerkId: cid(`case_attacker_${tag}`) } })).toBeNull();
      const sameAddress = await prisma.user.findMany({
        where: { email: { contains: `case-${tag}-${run}`, mode: 'insensitive' } },
      });
      expect(sameAddress.map((u) => u.id)).toEqual([victim.id]);
    });
  });

  describe.each([
    ['bound to a different Clerk id', (tag: string) => cid(`victim_${tag}`)],
    ['with no Clerk id', () => null],
  ])('an existing row with the same email, %s', (_label, existingClerkId) => {
    it('is refused with 409, left unchanged, and logged without the email', async () => {
      const tag = existingClerkId('x') ? 'other' : 'null';
      const victim = await prisma.user.create({
        data: {
          email: email(`victim-${tag}`),
          clerkId: existingClerkId(tag),
          name: 'Victim Name',
          firstName: 'Victim',
          lastName: 'Name',
        },
      });
      mockGetUser.mockResolvedValue(
        clerkUser({
          primaryEmailAddressId: 'idn_a',
          emailAddresses: [verified('idn_a', email(`victim-${tag}`))],
          firstName: 'Attacker',
          lastName: 'Person',
        })
      );
      const warn = jest.spyOn(logger, 'warn');
      const error = jest.spyOn(logger, 'error');
      const info = jest.spyOn(logger, 'info');

      const { req, err } = await authenticate(cid(`attacker_${tag}`));

      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(409);
      expect((err as AppError).code).toBe(ErrorCode.ACCOUNT_LINK_CONFLICT);
      expect(JSON.stringify(err)).not.toContain(email(`victim-${tag}`));
      expect((err as Error).message).not.toContain(email(`victim-${tag}`));
      expect(req.user).toBeUndefined();

      const after = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
      expect(after).toEqual(victim);
      expect(await prisma.user.findUnique({ where: { clerkId: cid(`attacker_${tag}`) } })).toBeNull();

      const calls = [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls];
      const conflictLog = calls.find((c) => JSON.stringify(c).includes('auth.identity_conflict'));
      expect(conflictLog).toBeDefined();
      expect(JSON.stringify(conflictLog)).toContain(victim.id);
      expect(JSON.stringify(conflictLog)).toContain(cid(`attacker_${tag}`));
      for (const c of calls) {
        const text = JSON.stringify(c);
        expect(text).not.toContain(email(`victim-${tag}`));
        expect(text).not.toContain('Victim');
        expect(text).not.toContain('Attacker');
      }
    });
  });
});
