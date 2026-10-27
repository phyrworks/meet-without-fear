/**
 * TS-12, on a clone of the INNER_WORK_LINKED_A target fixture: the E2E tooling
 * routes on the target (seed a user; seed an Inner Thoughts reflection; clean
 * up every @e2e.test user with their sessions and U-class rows). Tooling only,
 * behind E2E_AUTH_BYPASS. Replaces the Prisma-mock tests of
 * routes/__tests__/e2e.test.ts.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('E2E tooling routes on the target', () => {
  let run: TargetRun;
  let request: typeof import('supertest');
  let app: never;

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_e2e_${process.pid}`);
    process.env.E2E_AUTH_BYPASS = 'true';
    request = (await import('supertest')).default as never;
    const appModule = await import('../../app');
    app = ((appModule as { default?: unknown }).default ?? appModule) as never;
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('seed: the whole name goes in first_name (name is generated)', async () => {
    const res = await (request as never as (a: never) => import('supertest').SuperTest<import('supertest').Test>)(app)
      .post('/api/v1/e2e/seed')
      .send({ email: 'seeded@e2e.test', name: 'Sea Ded' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'seeded@e2e.test', name: 'Sea Ded' });
    expect(await run.sql(`SELECT first_name, last_name, name FROM "user" WHERE email = 'seeded@e2e.test'`)).toEqual([
      { first_name: 'Sea Ded', last_name: null, name: 'Sea Ded' },
    ]);
  });

  it('seed-inner-thoughts: a reflection with messages and takeaways', async () => {
    const res = await (request as never as (a: never) => import('supertest').SuperTest<import('supertest').Test>)(app)
      .post('/api/v1/e2e/seed-inner-thoughts')
      .send({ user: { email: 'thinker@e2e.test', name: 'Thinker' } });
    expect(res.status).toBeLessThan(300);
    const [r] = await run.sql<{ messages: number; takeaways: number }>(
      `SELECT (SELECT count(*)::int FROM reflection_message m WHERE m.reflection_id = x.id) AS messages,
              (SELECT count(*)::int FROM takeaway t WHERE t.reflection_id = x.id) AS takeaways
       FROM reflection x JOIN "user" u ON u.id = x.user_id WHERE u.email = 'thinker@e2e.test'`,
    );
    expect(r).toEqual({ messages: 2, takeaways: 3 });
  });

  it('cleanup: every @e2e.test user goes, with their sessions and their own rows', async () => {
    await run.sql(`INSERT INTO user_device (user_id, push_token) SELECT id, 'ExponentPushToken[e2e]' FROM "user" WHERE email = 'ada@e2e.test'`);
    await run.sql(`INSERT INTO feature_state (user_id, feature, doc) SELECT id, 'people', '{}' FROM "user" WHERE email = 'bob@e2e.test'`);
    const res = await (request as never as (a: never) => import('supertest').SuperTest<import('supertest').Test>)(app).post('/api/v1/e2e/cleanup').send({});
    expect(res.status).toBe(200);
    expect(res.body.deletedUsers).toBe(4);
    expect(res.body.deletedSessions).toBe(1);
    expect(await run.sql(`SELECT count(*)::int AS n FROM "user"`)).toEqual([{ n: 0 }]);
    expect(await run.sql(`SELECT count(*)::int AS n FROM session`)).toEqual([{ n: 0 }]);
    expect(await run.sql(`SELECT count(*)::int AS n FROM reflection`)).toEqual([{ n: 0 }]);
  });
});
