/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture: the
 * auth middleware against the target `user` table (identity only; `name` is
 * generated) and requireSessionAccess's participant rules. Clerk is mocked at
 * its SDK boundary; the database is real (mwf_app, identity binding on).
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

describeTarget('auth middleware on the target user table', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let app: never;
  let request: (a: never) => import('supertest').SuperTest<import('supertest').Test>;

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_auth_${process.pid}`);
    ids = await adaAndBob(run);
    process.env.CLERK_SECRET_KEY = 'sk_test_ts12';
    process.env.E2E_AUTH_BYPASS = 'false';
    request = (await import('supertest')).default as never;
    const appModule = await import('../../app');
    app = ((appModule as { default?: unknown }).default ?? appModule) as never;
  });
  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    if (run) await run.drop();
  });
  beforeEach(() => {
    mockVerifyToken.mockReset();
    mockGetUser.mockReset();
    process.env.E2E_AUTH_BYPASS = 'false';
  });

  const me = (token = 't') => request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);

  it('an existing user is resolved by clerk_id from the database alone (no Clerk profile call)', async () => {
    const [ada] = await run.sql<{ clerk_id: string }>(`SELECT clerk_id FROM "user" WHERE id = $1`, [ids.adaUser]);
    mockVerifyToken.mockResolvedValue({ sub: ada.clerk_id });
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: ids.adaUser, email: 'ada@e2e.test' });
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('a new Clerk user gets a user row with first/last names (name generated from them)', async () => {
    mockVerifyToken.mockResolvedValue({ sub: 'clerk_ts12_new' });
    mockGetUser.mockResolvedValue({ emailAddresses: [{ emailAddress: 'newbie@example.test' }], firstName: 'New', lastName: 'Bie' });
    const res = await me();
    expect(res.status).toBe(200);
    expect(await run.sql(`SELECT first_name, last_name, name FROM "user" WHERE clerk_id = 'clerk_ts12_new'`)).toEqual([
      { first_name: 'New', last_name: 'Bie', name: 'New Bie' },
    ]);
    // …and the next request takes the fast path
    mockGetUser.mockReset();
    expect((await me()).status).toBe(200);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('a local account with the Clerk email is linked to the Clerk identity (unique-email race)', async () => {
    await run.sql(`INSERT INTO "user" (email, first_name) VALUES ('local@example.test', 'Local')`);
    mockVerifyToken.mockResolvedValue({ sub: 'clerk_ts12_linked' });
    mockGetUser.mockResolvedValue({ emailAddresses: [{ emailAddress: 'local@example.test' }], firstName: 'Lo', lastName: 'Cal' });
    expect((await me()).status).toBe(200);
    expect(await run.sql(`SELECT clerk_id, first_name FROM "user" WHERE email = 'local@example.test'`)).toEqual([
      { clerk_id: 'clerk_ts12_linked', first_name: 'Lo' },
    ]);
  });

  it('an unknown user whose Clerk profile lookup fails is refused; no row is written', async () => {
    mockVerifyToken.mockResolvedValue({ sub: 'clerk_ts12_unknown' });
    mockGetUser.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
    expect((await me()).status).toBeGreaterThanOrEqual(400);
    expect(await run.sql(`SELECT count(*)::int AS n FROM "user" WHERE clerk_id = 'clerk_ts12_unknown'`)).toEqual([{ n: 0 }]);
  });

  it('a bad token is 401', async () => {
    mockVerifyToken.mockRejectedValue(new Error('bad token'));
    expect((await me()).status).toBe(401);
  });

  it('the E2E bypass: a non-UUID id is refused before the database; a UUID id is upserted', async () => {
    process.env.E2E_AUTH_BYPASS = 'true';
    const bad = await request(app).get('/api/v1/auth/me').set('x-e2e-user-id', 'not-a-uuid').set('x-e2e-user-email', 'x@e2e.test');
    expect(bad.status).toBe(401);
    const id = '019a0000-0000-7000-8000-0000000000aa';
    const ok = await request(app).get('/api/v1/auth/me').set('x-e2e-user-id', id).set('x-e2e-user-email', 'bypass@e2e.test');
    expect(ok.status).toBe(200);
    expect(await run.sql(`SELECT clerk_id FROM "user" WHERE id = $1`, [id])).toEqual([{ clerk_id: `e2e_${id}` }]);
  });

  it('requireSessionAccess: a participant passes, a missing session is 404, a stranger 403', async () => {
    process.env.E2E_AUTH_BYPASS = 'true';
    const as = (userId: string, email: string, path: string) =>
      request(app).get(`/api/v1${path}`).set('x-e2e-user-id', userId).set('x-e2e-user-email', email);
    expect((await as(ids.adaUser, 'ada@e2e.test', `/sessions/${ids.session}/progress`)).status).toBe(200);
    expect((await as(ids.adaUser, 'ada@e2e.test', `/sessions/00000000-0000-7000-8000-000000000000/progress`)).status).toBe(404);
    // The fixture's invitation is ACCEPTED (by Bob): the W6 arm admits only its acceptor, never a stranger
    expect((await as('019a0000-0000-7000-8000-0000000000bb', 'stranger@e2e.test', `/sessions/${ids.session}/progress`)).status).toBe(403);
  });
});
