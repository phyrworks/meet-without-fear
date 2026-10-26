/**
 * TS-9 fix round 1: the JOB path on the target, for real — the app's job
 * client logs in as `mwf_job` on the run database (driver: JOB_DATABASE_URL)
 * with identity binding on, so every job write runs under the job's actual
 * column grants (trailer T7) and every identity-bound read under the
 * caller's identity. Not a golden (nothing recorded).
 *
 *   - a streaming chat turn: the user's turn (app) and the AI reply (job) land
 *     in the caller's conversation only;
 *   - feel-heard: the self-assertable milestone (app), the transition message
 *     (job), and the partner's HELD direction read from
 *     v_empathy_direction_status (identity-bound) — the reconciler is triggered;
 *   - pause/resume: the `paused` system milestones (job INSERT / DELETE) and
 *     the PAUSED status shim on getSession, /state and the session list;
 *   - the identity-bound read the session list uses returns the direction
 *     under the caller's identity, and nothing without one.
 *
 * Requires a built target fixture: npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */

import { createHarness, type Harness } from '../driver';
import { withClient } from '../db';
import { isTargetShape } from '../shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('job path on the target, as mwf_job with identity binding on', () => {
  let harness: Harness;
  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql, params)).rows, harness.fixture.database);
  const counts = () =>
    rows<{ email: string; n: number }>(
      `SELECT u.email, count(m.id)::int AS n FROM conversation c
       JOIN participant p ON p.id = c.participant_id JOIN "user" u ON u.id = p.user_id
       LEFT JOIN message m ON m.conversation_id = c.id GROUP BY u.email ORDER BY u.email`,
    );
  const get = (actor: Harness['actors']['userA'], label: string, url: string) =>
    harness.step({ label, actor, tables: [], call: agent => agent.get(url) });
  const post = (actor: Harness['actors']['userA'], label: string, url: string, body: object = {}) =>
    harness.step({ label, actor, tables: [], asyncBoundary: true, call: agent => agent.post(url).send(body) });

  beforeAll(async () => {
    harness = await createHarness({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `job_path_${process.pid}` });
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('the job client is mwf_job on the run database, and identity binding is on', async () => {
    const { getJobPrisma } = await import('../../../lib/prisma');
    const [who] = await getJobPrisma().$queryRaw<Array<{ u: string; db: string }>>`SELECT session_user AS u, current_database() AS db`;
    expect(who).toEqual({ u: 'mwf_job', db: harness.fixture.database });
    expect(process.env.DB_IDENTITY_BINDING).toBe('on');
  });

  it("streams a turn: the user's turn and the AI reply (job) land in Ada's conversation only", async () => {
    const before = await counts();
    const bobBefore = await get(harness.actors.userB!, 'bob before', `/api/v1/sessions/${harness.sessionId}/messages`);
    const step = await harness.step({
      label: 'stream as ada',
      actor: harness.actors.userA,
      tables: ['message'],
      sse: true,
      asyncBoundary: true,
      call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/messages/stream`).send({ content: 'TS9_JOB_TURN' }),
    });
    expect(step.status).toBe(200);
    const events = (step.sse ?? []).map(e => e.event);
    expect(events).toEqual(expect.arrayContaining(['user_message', 'complete']));
    expect(events).not.toContain('error');

    const after = await counts();
    const delta = Object.fromEntries(after.map(a => [a.email, a.n - (before.find(b => b.email === a.email)?.n ?? 0)]));
    expect(delta).toEqual({ 'ada@e2e.test': 2, 'bob@e2e.test': 0 });
    const written = await rows<{ role: string; kind: string; sender: string | null; content: string; hash: string | null }>(
      `SELECT m.role::text AS role, m.kind::text AS kind, u.email AS sender, m.content, m.content_hash AS hash
       FROM message m LEFT JOIN participant p ON p.id = m.sender_participant_id LEFT JOIN "user" u ON u.id = p.user_id
       ORDER BY m.created_at DESC, m.id DESC LIMIT 2`,
    );
    expect(written.map(w => [w.role, w.kind, w.sender])).toEqual([
      ['AI', 'CHAT', null],
      ['USER', 'CHAT', 'ada@e2e.test'],
    ]);
    expect(written[0].hash).toMatch(/^[0-9a-f]{64}$/); // content_hash written by the job
    expect(written[1].content).toBe('TS9_JOB_TURN');
    const bobAfter = await get(harness.actors.userB!, 'bob after', `/api/v1/sessions/${harness.sessionId}/messages`);
    expect(bobAfter.body).toEqual(bobBefore.body);
  });

  it("feel-heard: Bob's milestone (app), the transition message (job), and Ada's HELD direction read identity-bound", async () => {
    // Put Bob back in stage 1 (before his feel_heard).
    await rows(
      `DELETE FROM participant_milestone pm USING participant p, "user" u
       WHERE pm.participant_id = p.id AND p.user_id = u.id AND u.email = 'bob@e2e.test' AND pm.milestone_key = 'feel_heard'`,
    );
    const before = await counts();
    const step = await post(harness.actors.userB!, 'feel-heard as bob', `/api/v1/sessions/${harness.sessionId}/feel-heard`, {
      confirmed: true,
    });
    expect(step.status).toBe(200);
    const data = (step.body as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ confirmed: true, advancedToStage: 2 });
    // messages.ts reads v_empathy_direction_status under Bob's identity: Ada's HELD attempt about him.
    expect(data.reconcilerTriggered).toBe(true);
    expect((data.transitionMessage as { id?: string } | null)?.id).toEqual(expect.any(String));
    const [m] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM participant_milestone pm JOIN participant p ON p.id = pm.participant_id
       JOIN "user" u ON u.id = p.user_id WHERE u.email = 'bob@e2e.test' AND pm.milestone_key = 'feel_heard'`,
    );
    expect(m.n).toBe(1);
    const after = await counts();
    expect(after.find(a => a.email === 'bob@e2e.test')!.n - before.find(b => b.email === 'bob@e2e.test')!.n).toBe(1);
  });

  it('the session list\'s identity-bound read returns the direction under the caller\'s identity, nothing without one', async () => {
    const { prisma } = await import('../../../lib/prisma');
    const { runWithContext } = await import('../../../lib/request-context');
    const [bob] = await rows<{ id: string }>(
      `SELECT p.id FROM participant p JOIN "user" u ON u.id = p.user_id WHERE u.email = 'bob@e2e.test'`,
    );
    const q = () =>
      prisma.$queryRaw<Array<{ status: string }>>`
        SELECT status::text AS status FROM v_empathy_direction_status WHERE subject_participant_id = ANY(${[bob.id]}::uuid[])`;
    // A PrismaPromise is lazy: it must be awaited INSIDE the context.
    const asBob = await runWithContext(
      { turnId: 't', requestId: 'r', startTime: Date.now(), userId: harness.actors.userB!.id },
      async () => await q(),
    );
    expect(asBob.map(r => r.status)).toEqual(['HELD']);
    expect(await q()).toEqual([]); // no identity → fail-closed
    const list = await get(harness.actors.userB!, 'list as bob', '/api/v1/sessions');
    expect(list.status).toBe(200);
  });

  it('pause/resume: `paused` milestones by the job; getSession, /state and the list read PAUSED; ?status=PAUSED filters', async () => {
    const sid = harness.sessionId;
    const ada = harness.actors.userA;
    const paused = await post(ada, 'pause', `/api/v1/sessions/${sid}/pause`);
    expect(paused.status).toBe(200);
    expect((paused.body as { data: { status: string } }).data.status).toBe('PAUSED');
    const [pm] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM participant_milestone WHERE milestone_key = 'paused'`);
    expect(pm.n).toBe(2);
    expect(await rows(`SELECT status::text AS status FROM session`)).toEqual([{ status: 'ACTIVE' }]);

    const status = (b: unknown, path: string[]) => path.reduce((o: unknown, k) => (o as Record<string, unknown>)?.[k], b);
    expect(status((await get(ada, 'get', `/api/v1/sessions/${sid}`)).body, ['data', 'session', 'status'])).toBe('PAUSED');
    expect(status((await get(ada, 'state', `/api/v1/sessions/${sid}/state`)).body, ['data', 'session', 'status'])).toBe('PAUSED');
    const list = (await get(ada, 'list', '/api/v1/sessions')).body as { data: { items: Array<{ id: string; status: string }> } };
    expect(list.data.items.find(i => i.id === sid)?.status).toBe('PAUSED');
    const onlyPaused = (await get(ada, 'list paused', '/api/v1/sessions?status=PAUSED')).body as { data: { items: Array<{ id: string }> } };
    expect(onlyPaused.data.items.map(i => i.id)).toEqual([sid]);
    const onlyActive = (await get(ada, 'list active', '/api/v1/sessions?status=ACTIVE')).body as { data: { items: unknown[] } };
    expect(onlyActive.data.items).toEqual([]);
    expect((await get(ada, 'list bad', '/api/v1/sessions?status=NOPE')).status).toBe(400);

    const resumed = await post(ada, 'resume', `/api/v1/sessions/${sid}/resume`);
    expect(resumed.status).toBe(200);
    expect((resumed.body as { data: { status: string } }).data.status).toBe('ACTIVE');
    expect(await rows(`SELECT count(*)::int AS n FROM participant_milestone WHERE milestone_key = 'paused'`)).toEqual([{ n: 0 }]);
    expect(status((await get(ada, 'get again', `/api/v1/sessions/${sid}`)).body, ['data', 'session', 'status'])).toBe('ACTIVE');
  });
});
