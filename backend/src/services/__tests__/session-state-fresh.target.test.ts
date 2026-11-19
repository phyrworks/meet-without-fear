/**
 * The first reads of a session created through the API (as the e2e journeys start): a fresh inviter creates a
 * session, then reads its state and messages as mwf_app with RLS and identity binding on. The goldens and the other
 * target suites start from fixtures; this one starts from createSession itself, so a read path that only fails on
 * an API-made session (the e2e break of 2026-11-19) fails here.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */
import { isTargetShape } from '../../testing/golden/shape';
import { httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('a session made through the API: its first state and messages reads (e2e start)', () => {
  let run: TargetRun;

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `session_state_fresh_${process.pid}`);
    await httpAs(); // the e2e bypass, as the journeys run
  });
  afterAll(async () => {
    await run?.drop();
  });

  it('a seeded, named inviter creates a session and reads its state and messages', async () => {
    const request = (await import('supertest')).default;
    const app = ((await import('../../app')) as { default?: unknown }).default;
    const seeded = await request(app as never)
      .post('/api/v1/e2e/seed')
      .send({ email: `fresh-${process.pid}@e2e.test`, name: 'Alice' });
    expect(seeded.status).toBe(201);
    const inviter = { id: seeded.body.id as string, email: seeded.body.email as string };
    const as = (method: 'get' | 'post', path: string, body?: object) => {
      let r = request(app as never)
        [method](`/api/v1${path}`)
        .set('x-e2e-user-id', inviter.id)
        .set('x-e2e-user-email', inviter.email)
        .set('x-e2e-fixture-id', 'user-a-full-journey');
      if (body) r = r.send(body);
      return r;
    };
    const created = await as('post', '/sessions', { inviteName: 'Bob' });
    expect(created.status).toBe(201);
    const sessionId: string = created.body.data.session.id;

    const state = await as('get', `/sessions/${sessionId}/state`);
    expect({ status: state.status, error: state.body?.error }).toEqual({ status: 200, error: undefined });
    const messages = await as('get', `/sessions/${sessionId}/messages`);
    expect(messages.status).toBe(200);
  });
});
