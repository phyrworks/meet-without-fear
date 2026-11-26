/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture: the
 * auth middleware against the target `user` / `user_identity` tables
 * (work-k5fk.1) and requireSessionAccess's participant rules. Clerk is mocked
 * at its SDK boundary; the database is real (mwf_app for the request,
 * mwf_auth for app.resolve_user / app.create_user, identity binding on).
 *
 * First login (work-bp5m, the work-jv9y fix ported onto user_identity): only a
 * VERIFIED PRIMARY email creates a row (403 EMAIL_NOT_VERIFIED otherwise, no
 * placeholder row); an email that belongs to another account is 409
 * ACCOUNT_LINK_CONFLICT and nothing is re-bound (warn auth.identity_conflict,
 * ids only); the concurrent-create race for the same subject still resolves.
 *
 * Replaces the Prisma-mock tests of middleware/__tests__/auth.test.ts.
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const mockVerifyToken = jest.fn();
const mockGetUser = jest.fn();
jest.mock('@clerk/express', () => ({
  verifyToken: (...a: unknown[]) => mockVerifyToken(...a),
  clerkClient: { users: { getUser: (...a: unknown[]) => mockGetUser(...a) } },
}));

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type ClerkEmail = { id: string; emailAddress: string; verification: { status: string } | null };
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
function clerkUser(opts: {
  primaryEmailAddressId: string | null;
  emailAddresses: ClerkEmail[];
  firstName?: string | null;
  lastName?: string | null;
}) {
  return { firstName: null, lastName: null, ...opts };
}

describeTarget('auth middleware on the target user / user_identity tables', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let app: never;
  let request: (a: never) => import('supertest').SuperTest<import('supertest').Test>;
  let logger: typeof import('../../lib/logger').logger;

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_auth_${process.pid}`);
    ids = await adaAndBob(run);
    process.env.CLERK_SECRET_KEY = 'sk_test_ts12';
    process.env.E2E_AUTH_BYPASS = 'false';
    request = (await import('supertest')).default as never;
    const appModule = await import('../../app');
    app = ((appModule as { default?: unknown }).default ?? appModule) as never;
    logger = (await import('../../lib/logger')).logger;
  });
  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    if (run) await run.drop();
  });
  beforeEach(() => {
    mockVerifyToken.mockReset();
    mockGetUser.mockReset();
    process.env.E2E_AUTH_BYPASS = 'false';
    jest.restoreAllMocks();
  });

  const me = (token = 't') => request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);
  const identityOf = (subject: string) =>
    run.sql<{ user_id: string }>(`SELECT user_id FROM user_identity WHERE provider = 'clerk' AND subject = $1`, [
      subject,
    ]);
  const userByEmail = (email: string) =>
    run.sql<{ id: string; email: string; first_name: string | null; last_name: string | null; updated_at: Date }>(
      `SELECT id, email, first_name, last_name, updated_at FROM "user" WHERE email = $1`,
      [email],
    );

  it('an existing user is resolved through app.resolve_user from the database alone (no Clerk profile call)', async () => {
    await run.sql(`INSERT INTO user_identity (provider, subject, user_id) VALUES ('clerk', 'user_ts12Ada', $1)`, [
      ids.adaUser,
    ]);
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Ada' });
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: ids.adaUser, email: 'ada@e2e.test' });
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('a new Clerk user gets a user row and an identity (verified primary, not emailAddresses[0])', async () => {
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12New' });
    mockGetUser.mockResolvedValue(
      clerkUser({
        primaryEmailAddressId: 'idn_p',
        emailAddresses: [verified('idn_d', 'decoy@example.test'), verified('idn_p', '  NewBie@Example.TEST ')],
        firstName: 'New',
        lastName: 'Bie',
      }),
    );
    const res = await me();
    expect(res.status).toBe(200);
    const [row] = await userByEmail('newbie@example.test');
    expect(row).toMatchObject({ first_name: 'New', last_name: 'Bie' });
    expect(await identityOf('user_ts12New')).toEqual([{ user_id: row.id }]);
    expect(res.body.data.user).toMatchObject({ id: row.id, email: 'newbie@example.test' });
    expect(await userByEmail('decoy@example.test')).toEqual([]);
    // …and the next request takes the fast path
    mockGetUser.mockReset();
    expect((await me()).status).toBe(200);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  // review r2 R2-4 (work-k5fk.9): the person_name domain and utils/person-name.ts agree on one blank set, Unicode
  // White_Space, so a Clerk name made only of it clamps to NULL and never fails the first sign-in (OD-4).
  it('a Clerk name of only White_Space (NEL, NBSP, ideographic space) signs in with NULL names; both sides agree', async () => {
    const cps = Array.from({ length: 0x3001 }, (_, i) => i).filter(cp => cp > 0 && (cp < 0xd800 || cp > 0xdfff));
    const jsBlank = cps.filter(cp => /^\p{White_Space}$/u.test(String.fromCodePoint(cp)));
    const [{ pg }] = await run.sql<{ pg: number[] }>(
      `SELECT array_agg(cp ORDER BY cp) AS pg FROM unnest($1::int[]) cp WHERE chr(cp) COLLATE pg_c_utf8 ~ '^[[:space:]]$'`,
      [cps],
    );
    expect(pg).toEqual(jsBlank);

    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Blank' });
    mockGetUser.mockResolvedValue(
      clerkUser({
        primaryEmailAddressId: 'idn_b',
        emailAddresses: [verified('idn_b', 'blank-name@example.test')],
        firstName: '\u0085\u00a0',
        lastName: '\u3000',
      }),
    );
    expect((await me()).status).toBe(200);
    expect(await userByEmail('blank-name@example.test')).toEqual([
      expect.objectContaining({ first_name: null, last_name: null }),
    ]);
  });

  it.each([
    [
      'an unverified primary',
      clerkUser({
        primaryEmailAddressId: 'idn_u',
        emailAddresses: [unverified('idn_u', 'unverified@example.test'), verified('idn_s', 'second@example.test')],
      }),
    ],
    [
      'no primary (no placeholder <id>@pending.clerk row)',
      clerkUser({ primaryEmailAddressId: null, emailAddresses: [] }),
    ],
  ])('%s is 403 EMAIL_NOT_VERIFIED and writes nothing', async (_label, profile) => {
    const before = await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM "user"`);
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Unverified' });
    mockGetUser.mockResolvedValue(profile);
    const res = await me();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(await identityOf('user_ts12Unverified')).toEqual([]);
    expect(await run.sql(`SELECT count(*)::int AS n FROM "user"`)).toEqual(before);
    expect(await run.sql(`SELECT 1 FROM "user" WHERE email LIKE '%pending.clerk'`)).toEqual([]);
  });

  it.each([
    ['the same email', 'ada@e2e.test'],
    ['a case and whitespace variant of it', '  ADA@E2E.Test\t'],
  ])(
    'a new Clerk identity presenting %s of an existing account is 409, never re-bound, logged with ids only',
    async (_label, presented) => {
      // Ada already signs in through her own identity; an attacker's Clerk account claims her address.
      await run.sql(
        `INSERT INTO user_identity (provider, subject, user_id) VALUES ('clerk', 'user_ts12Ada', $1) ON CONFLICT DO NOTHING`,
        [ids.adaUser],
      );
      const [victim] = await userByEmail('ada@e2e.test');
      const warn = jest.spyOn(logger, 'warn');
      const error = jest.spyOn(logger, 'error');
      const info = jest.spyOn(logger, 'info');
      mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Intruder' });
      mockGetUser.mockResolvedValue(
        clerkUser({
          primaryEmailAddressId: 'idn_a',
          emailAddresses: [verified('idn_a', presented)],
          firstName: 'Attacker',
          lastName: 'Person',
        }),
      );

      const res = await me();

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ACCOUNT_LINK_CONFLICT');
      expect(JSON.stringify(res.body)).not.toContain('ada@e2e.test');
      expect(await userByEmail('ada@e2e.test')).toEqual([victim]);
      expect(await identityOf('user_ts12Intruder')).toEqual([]);
      expect(await identityOf('user_ts12Ada')).toEqual([{ user_id: ids.adaUser }]);

      const calls = [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls];
      const conflict = calls.filter(c => JSON.stringify(c).includes('auth.identity_conflict'));
      expect(conflict).toHaveLength(1);
      expect(warn.mock.calls.some(c => JSON.stringify(c).includes('auth.identity_conflict'))).toBe(true);
      expect(JSON.stringify(conflict[0])).toContain(ids.adaUser);
      expect(JSON.stringify(conflict[0])).toContain('user_ts12Intruder');
      for (const c of calls) {
        const text = JSON.stringify(c);
        expect(text.toLowerCase()).not.toContain('ada@e2e.test');
        expect(text).not.toContain('Attacker');
        expect(text).not.toContain('Lovelace');
      }
    },
  );

  it('an existing account with no identity at all is not claimed by its email either (409)', async () => {
    await run.sql(`INSERT INTO "user" (email, first_name) VALUES ('local@example.test', 'Local')`);
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Linker' });
    mockGetUser.mockResolvedValue(
      clerkUser({ primaryEmailAddressId: 'idn_l', emailAddresses: [verified('idn_l', 'local@example.test')] }),
    );
    expect((await me()).status).toBe(409);
    expect(await identityOf('user_ts12Linker')).toEqual([]);
    expect(await run.sql(`SELECT first_name FROM "user" WHERE email = 'local@example.test'`)).toEqual([
      { first_name: 'Local' },
    ]);
  });

  it('the concurrent-create race for the same Clerk id resolves to one user', async () => {
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Race' });
    mockGetUser.mockResolvedValue(
      clerkUser({ primaryEmailAddressId: 'idn_r', emailAddresses: [verified('idn_r', 'race@example.test')] }),
    );
    const results = await Promise.all([me(), me(), me()]);
    for (const r of results) expect(r.status).toBe(200);
    const rows = await userByEmail('race@example.test');
    expect(rows).toHaveLength(1);
    expect(await identityOf('user_ts12Race')).toEqual([{ user_id: rows[0].id }]);
    for (const r of results) expect(r.body.data.user.id).toBe(rows[0].id);
  });

  it('the race where the other request wins between the lookup and the create', async () => {
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Race2' });
    mockGetUser.mockImplementation(async () => {
      // the winner, through the same definer function the middleware calls
      await run.as('mwf_auth', null, `SELECT app.create_user('clerk', 'user_ts12Race2', 'race2@example.test')`);
      return clerkUser({ primaryEmailAddressId: 'idn_r2', emailAddresses: [verified('idn_r2', 'race2@example.test')] });
    });
    const res = await me();
    expect(res.status).toBe(200);
    const [row] = await userByEmail('race2@example.test');
    expect(res.body.data.user.id).toBe(row.id);
  });

  it('a deleted account (tombstone: identity gone) no longer resolves; its subject is a new first login', async () => {
    const [u] = await run.sql<{ id: string }>(
      `INSERT INTO "user" (email, first_name) VALUES ('leaver@example.test', 'Leaver') RETURNING id`,
    );
    await run.sql(`INSERT INTO user_identity (provider, subject, user_id) VALUES ('clerk', 'user_ts12Leaver', $1)`, [
      u.id,
    ]);
    await run.as('mwf_app', u.id, `SELECT app.anonymize_user_account($1::uuid)`, [u.id]);
    expect(await identityOf('user_ts12Leaver')).toEqual([]);
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Leaver' });
    mockGetUser.mockResolvedValue(
      clerkUser({ primaryEmailAddressId: 'idn_v', emailAddresses: [verified('idn_v', 'leaver@example.test')] }),
    );
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).not.toBe(u.id);
  });

  it('a tombstone whose identity was kept (no walk): its subject collides on user_identity_pkey, rethrown as CONFLICT, not ACCOUNT_LINK_CONFLICT (work-k5fk.13)', async () => {
    // Scrubbed by hand, not by app.anonymize_user_account: the identity row survives,
    // so resolve_user finds no live user and create_user's identity insert collides
    // on (provider, subject) with no email holder — a 23505 that is not MWF01.
    const [u] = await run.sql<{ id: string }>(
      `INSERT INTO "user" (email, first_name) VALUES ('kept@example.test', 'Kept') RETURNING id`,
    );
    await run.sql(`INSERT INTO user_identity (provider, subject, user_id) VALUES ('clerk', 'user_ts12Kept', $1)`, [
      u.id,
    ]);
    await run.sql(
      `UPDATE "user" SET email = 'deleted+' || id::text || '@invalid', first_name = NULL, deleted_at = now() WHERE id = $1`,
      [u.id],
    );
    const warn = jest.spyOn(logger, 'warn');
    const error = jest.spyOn(logger, 'error');
    const info = jest.spyOn(logger, 'info');
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Kept' });
    mockGetUser.mockResolvedValue(
      clerkUser({ primaryEmailAddressId: 'idn_k', emailAddresses: [verified('idn_k', 'kept-again@example.test')] }),
    );

    const res = await me();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details).toEqual({ constraint: 'user_identity_pkey' });
    const calls = [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls];
    expect(calls.filter(c => JSON.stringify(c).includes('auth.identity_conflict'))).toEqual([]);
    expect(await userByEmail('kept-again@example.test')).toEqual([]);
    expect(await identityOf('user_ts12Kept')).toEqual([{ user_id: u.id }]);
  });

  it('a verified email the email domain refuses (too long) is 403 EMAIL_NOT_ACCEPTED, logged with its constraint, no row (platform L3, work-k5fk.34)', async () => {
    const long = `${'a'.repeat(250)}@example.test`;
    const warn = jest.spyOn(logger, 'warn');
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12TooLong' });
    mockGetUser.mockResolvedValue(
      clerkUser({ primaryEmailAddressId: 'idn_l', emailAddresses: [verified('idn_l', long)] }),
    );

    const res = await me();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_ACCEPTED');
    const logged = warn.mock.calls.find(c => JSON.stringify(c).includes('auth.email_not_accepted')) as unknown[];
    const fields = logged?.[1] as { event?: string; sqlState?: string; constraint?: string | null } | undefined;
    expect(fields).toMatchObject({ event: 'auth.email_not_accepted', sqlState: '23514' });
    expect(fields?.constraint).toBeTruthy();
    expect(JSON.stringify(logged)).not.toContain(long);
    expect(await identityOf('user_ts12TooLong')).toEqual([]);
  });

  it('an unknown user whose Clerk profile lookup fails is refused; no row is written', async () => {
    mockVerifyToken.mockResolvedValue({ sub: 'user_ts12Unknown' });
    mockGetUser.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
    expect((await me()).status).toBeGreaterThanOrEqual(400);
    expect(await identityOf('user_ts12Unknown')).toEqual([]);
  });

  it('a bad token is 401', async () => {
    mockVerifyToken.mockRejectedValue(new Error('bad token'));
    expect((await me()).status).toBe(401);
  });

  it('mwf_app cannot read or write user_identity, nor write user.email (work-bp5m)', async () => {
    await expect(run.as('mwf_app', ids.adaUser, `SELECT 1 FROM user_identity`)).rejects.toThrow(/permission denied/);
    await expect(
      run.as(
        'mwf_app',
        ids.adaUser,
        `INSERT INTO user_identity (provider, subject, user_id) VALUES ('clerk', 'user_x', $1)`,
        [ids.adaUser],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      run.as('mwf_app', ids.adaUser, `UPDATE "user" SET email = 'x@example.test' WHERE id = $1`, [ids.adaUser]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      run.as('mwf_app', ids.adaUser, `INSERT INTO "user" (email) VALUES ('x@example.test')`),
    ).rejects.toThrow(/permission denied/);
    const [g] = await run.sql<{ upd: boolean; ins: boolean }>(
      `SELECT has_column_privilege('mwf_app', 'public."user"', 'email', 'UPDATE') AS upd,
              has_table_privilege('mwf_app', 'public."user"', 'INSERT') AS ins`,
    );
    expect(g).toEqual({ upd: false, ins: false });
  });

  it('the E2E bypass: a non-UUID id is refused before the database; a UUID id gets an e2e identity', async () => {
    process.env.E2E_AUTH_BYPASS = 'true';
    const bad = await request(app)
      .get('/api/v1/auth/me')
      .set('x-e2e-user-id', 'not-a-uuid')
      .set('x-e2e-user-email', 'x@e2e.test');
    expect(bad.status).toBe(401);
    const id = '019a0000-0000-7000-8000-0000000000aa';
    const ok = await request(app)
      .get('/api/v1/auth/me')
      .set('x-e2e-user-id', id)
      .set('x-e2e-user-email', 'bypass@e2e.test');
    expect(ok.status).toBe(200);
    expect(await run.sql(`SELECT provider::text, subject FROM user_identity WHERE user_id = $1`, [id])).toEqual([
      { provider: 'e2e', subject: `e2e_${id}` },
    ]);
    // idempotent: a second request reuses the row and the identity
    expect(
      (await request(app).get('/api/v1/auth/me').set('x-e2e-user-id', id).set('x-e2e-user-email', 'bypass@e2e.test'))
        .status,
    ).toBe(200);
  });

  it('requireSessionAccess: a participant passes, a missing session is 404, a stranger 403', async () => {
    process.env.E2E_AUTH_BYPASS = 'true';
    const as = (userId: string, email: string, path: string) =>
      request(app).get(`/api/v1${path}`).set('x-e2e-user-id', userId).set('x-e2e-user-email', email);
    expect((await as(ids.adaUser, 'ada@e2e.test', `/sessions/${ids.session}/progress`)).status).toBe(200);
    expect(
      (await as(ids.adaUser, 'ada@e2e.test', `/sessions/00000000-0000-7000-8000-000000000000/progress`)).status,
    ).toBe(404);
    // The fixture's invitation is ACCEPTED (by Bob): the W6 arm admits only its acceptor, never a stranger
    expect(
      (await as('019a0000-0000-7000-8000-0000000000bb', 'stranger@e2e.test', `/sessions/${ids.session}/progress`))
        .status,
    ).toBe(403);
  });
});
