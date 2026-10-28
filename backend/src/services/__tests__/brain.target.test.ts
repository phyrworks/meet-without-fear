/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture:
 * telemetry and the Neural Monitor dashboard.
 *
 *   - brain_activity is written by the JOB (mwf_job) with participant_id /
 *     reflection_id attribution at capture; `mwf_app` holds no grant on it
 *     here (revoked from the run's stand-in table grants, as spec §1.8 says);
 *   - a failed telemetry write never breaks the call (an unsaved record);
 *   - the dashboard reads through mwf_ops (OPS_DATABASE_URL), read-only.
 *
 * Replaces the Prisma-mock suite routes/__tests__/brain-auth.test.ts (the
 * dashboard auth gate is asserted here against the real routes).
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('brain_activity (job) and the dashboard (mwf_ops) on the target', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let reflectionId: string;

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_brain_${process.pid}`);
    ids = await adaAndBob(run);
    // spec §1.8: brain_activity has no mwf_app grant (the run's stand-in grants everything; take it back)
    await run.sql(`REVOKE ALL ON brain_activity FROM mwf_app`);
    const pw = encodeURIComponent(process.env.GOLDEN_OPS_PASSWORD ?? 'mwf_ops_dev');
    process.env.OPS_DATABASE_URL = `postgresql://mwf_ops:${pw}@${run.fx.target.host}:${run.fx.target.port}/${run.fx.database}`;
    [{ id: reflectionId }] = await run.sql<{ id: string }>(`SELECT id FROM reflection`);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('the app role cannot touch brain_activity at all', async () => {
    await expect(run.as('mwf_app', ids.adaUser, `SELECT count(*) FROM brain_activity`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('capture: the job writes the row — attributed to the request’s participant only when the call opts in (R40) — and completes it', async () => {
    const { brainService } = await import('../brain-service');
    const ctx = await import('../../lib/request-context');
    const activity = await ctx.runWithContext(
      {
        turnId: 't',
        requestId: 'r',
        startTime: Date.now(),
        userId: ids.bobUser,
        sessionId: ids.session,
        participantId: ids.bob,
      },
      () =>
        brainService.startActivity({
          sessionId: ids.session,
          turnId: 'ts12-turn',
          activityType: 'LLM_CALL',
          model: 'claude-sonnet',
          input: { prompt: 'PROBE_TS12' },
          attributeToCaller: true, // R40: the caller's own content
        }),
    );
    expect(activity.id).not.toBe('');
    await brainService.completeActivity(activity.id, {
      output: { text: 'done' },
      tokenCountInput: 10,
      tokenCountOutput: 5,
      cost: 0.0012,
      durationMs: 33,
    });
    expect(
      await run.sql(
        `SELECT participant_id, reflection_id, status::text AS status, token_count_input, cost::text AS cost FROM brain_activity WHERE id = $1`,
        [activity.id],
      ),
    ).toEqual([
      { participant_id: ids.bob, reflection_id: null, status: 'COMPLETED', token_count_input: 10, cost: '0.001200' },
    ]);

    // No participant on the request context: the job resolves the user's participant
    const viaLookup = await ctx.runWithContext(
      { turnId: 't', requestId: 'r', startTime: Date.now(), userId: ids.adaUser },
      () =>
        brainService.startActivity({
          sessionId: ids.session,
          activityType: 'RETRIEVAL',
          model: 'system-retrieval',
          input: {},
          attributeToCaller: true,
        }),
    );
    expect(await run.sql(`SELECT participant_id FROM brain_activity WHERE id = $1`, [viaLookup.id])).toEqual([
      { participant_id: ids.ada },
    ]);

    // R40 (fix round 1, I1): without the opt-in — every call that reads or produces another
    // participant's content — the row is unattributed (session only), so R17 removes it on either leave.
    const cross = await ctx.runWithContext(
      {
        turnId: 't',
        requestId: 'r',
        startTime: Date.now(),
        userId: ids.bobUser,
        sessionId: ids.session,
        participantId: ids.bob,
      },
      () =>
        brainService.startActivity({
          sessionId: ids.session,
          activityType: 'LLM_CALL',
          model: 'claude-sonnet',
          input: {},
          callType: 'RECONCILER_ANALYSIS' as never,
        }),
    );
    expect(await run.sql(`SELECT session_id, participant_id FROM brain_activity WHERE id = $1`, [cross.id])).toEqual([
      { session_id: ids.session, participant_id: null },
    ]);

    // A reflection turn: reflection_id, no session
    const inner = await brainService.startActivity({
      innerWorkSessionId: reflectionId,
      activityType: 'LLM_CALL',
      model: 'claude-haiku',
      input: {},
    });
    await brainService.failActivity(inner.id, new Error('boom'));
    expect(
      await run.sql(`SELECT session_id, reflection_id, status::text AS status FROM brain_activity WHERE id = $1`, [
        inner.id,
      ]),
    ).toEqual([{ session_id: null, reflection_id: reflectionId, status: 'FAILED' }]);
  });

  it('a telemetry failure never breaks the call: an unsaved record, and complete/fail are no-ops', async () => {
    const { brainService } = await import('../brain-service');
    const bad = await brainService.startActivity({
      sessionId: '00000000-0000-7000-8000-000000000000', // no such session: the FK refuses the row
      activityType: 'LLM_CALL',
      model: 'm',
      input: {},
    });
    expect(bad.id).toBe('');
    expect(await brainService.completeActivity(bad.id, { output: {} })).toBeNull();
  });

  it('the dashboard reads through mwf_ops: sessions list, session detail, activity, cost summary', async () => {
    const request = (await import('supertest')).default;
    const appModule = await import('../../app');
    const app = ((appModule as { default?: unknown }).default ?? appModule) as never;
    process.env.DASHBOARD_API_SECRET = '';

    const list = await request(app).get('/api/v1/brain/sessions');
    expect(list.status).toBe(200);
    const partner = list.body.data.sessions.find((s: { id: string }) => s.id === ids.session);
    expect(partner).toMatchObject({ type: 'PARTNER', participants: 'Ada Lovelace & Bob Ross' });
    expect(partner.stats.activityCount).toBeGreaterThanOrEqual(2);
    expect(
      list.body.data.sessions.some(
        (s: { id: string; type: string }) => s.id === reflectionId && s.type === 'INNER_WORK',
      ),
    ).toBe(true);

    // keyless (no FIELD_ENCRYPTION_KEY): the title search arm applies (TS-13, ruling R45)
    const [{ title }] = await run.sql<{ title: string | null }>(`SELECT title FROM reflection WHERE id = $1`, [
      reflectionId,
    ]);
    expect(title).toEqual(expect.any(String));
    const searched = await request(app).get(
      `/api/v1/brain/sessions?type=INNER_WORK&search=${encodeURIComponent(title!)}`,
    );
    expect(searched.body.data.titleSearch).toBe('applied');
    expect(searched.body.data.sessions.map((s: { id: string }) => s.id)).toContain(reflectionId);

    const detail = await request(app).get(`/api/v1/brain/sessions/${ids.session}`);
    expect(detail.status).toBe(200);
    expect(typeof detail.body.data.stats.totalCost).toBe('number');

    const activity = await request(app).get(`/api/v1/brain/activity/${ids.session}`);
    expect(activity.status).toBe(200);
    expect(activity.body.data.activities.every((a: { cost: unknown }) => typeof a.cost === 'number')).toBe(true);

    const costs = await request(app).get('/api/v1/brain/costs?period=7d');
    expect(costs.status).toBe(200);
    expect(typeof costs.body.data.summary.periodTotal).toBe('number');

    // mwf_ops is read-only
    await expect(
      (async () => {
        const { Client } = await import('pg');
        const c = new Client({ connectionString: process.env.OPS_DATABASE_URL });
        await c.connect();
        try {
          await c.query(`DELETE FROM brain_activity`);
        } finally {
          await c.end();
        }
      })(),
    ).rejects.toThrow(/permission denied/);
  });

  it('dashboard auth: a configured secret is required (header compared timing-safely)', async () => {
    const request = (await import('supertest')).default;
    const appModule = await import('../../app');
    const app = ((appModule as { default?: unknown }).default ?? appModule) as never;
    process.env.DASHBOARD_API_SECRET = 'ts12-secret';
    try {
      expect((await request(app).get('/api/v1/brain/sessions')).status).toBe(401);
      expect((await request(app).get('/api/v1/brain/sessions').set('x-dashboard-secret', 'wrong-secret')).status).toBe(
        401,
      );
      expect((await request(app).get('/api/v1/brain/sessions').set('x-dashboard-secret', 'ts12-secret')).status).toBe(
        200,
      );
    } finally {
      process.env.DASHBOARD_API_SECRET = '';
    }
  });
});
