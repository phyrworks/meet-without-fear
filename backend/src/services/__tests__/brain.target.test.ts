/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture:
 * telemetry and the Neural Monitor dashboard.
 *
 *   - brain_activity is written by the JOB (mwf_job) with participant_user_id /
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
import { actingAs, adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('brain_activity (job) and the dashboard (mwf_ops) on the target', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let reflectionId: string;
  let reflectionOwner: string;

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_brain_${process.pid}`);
    ids = await adaAndBob(run);
    // spec §1.8: brain_activity has no mwf_app grant (the run's stand-in grants everything; take it back)
    await run.sql(`REVOKE ALL ON brain_activity FROM app_access`);
    const pw = encodeURIComponent(process.env.GOLDEN_OPS_PASSWORD ?? 'mwf_ops_dev');
    process.env.OPS_DATABASE_URL = `postgresql://mwf_ops:${pw}@${run.fx.target.host}:${run.fx.target.port}/${run.fx.database}`;
    [{ id: reflectionId, user_id: reflectionOwner }] = await run.sql<{ id: string; user_id: string }>(
      `SELECT id, user_id::text FROM reflection`,
    );
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
        seated: true,
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
    await actingAs(ids.bobUser, () =>
      brainService.completeActivity(activity.id, {
        output: { text: 'done' },
        tokenCountInput: 10,
        tokenCountOutput: 5,
        cost: 0.0012,
        durationMs: 33,
      }),
    );
    expect(
      await run.sql(
        `SELECT participant_user_id, reflection_id, status::text AS status, token_count_input, cost::text AS cost FROM brain_activity WHERE id = $1`,
        [activity.id],
      ),
    ).toEqual([
      {
        participant_user_id: ids.bobUser,
        reflection_id: null,
        status: 'COMPLETED',
        token_count_input: 10,
        cost: '0.001200',
      },
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
    expect(
      await run.sql(`SELECT session_id, participant_user_id FROM brain_activity WHERE id = $1`, [viaLookup.id]),
    ).toEqual([{ session_id: ids.session, participant_user_id: ids.adaUser }]);

    // R40 (fix round 1, I1): without the opt-in — every call that reads or produces another
    // participant's content — the row is unattributed (session only), so R17 removes it on either leave.
    const cross = await ctx.runWithContext(
      {
        turnId: 't',
        requestId: 'r',
        startTime: Date.now(),
        userId: ids.bobUser,
        sessionId: ids.session,
        seated: true,
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
    expect(
      await run.sql(`SELECT session_id, participant_user_id FROM brain_activity WHERE id = $1`, [cross.id]),
    ).toEqual([{ session_id: ids.session, participant_user_id: null }]);

    // A reflection turn: reflection_id, no session — the reflection owner's request (work-k5fk.10.33: the AI reads
    // and writes the sessionless telemetry of the acting user's own reflection only)
    const inner = await actingAs(reflectionOwner, async () => {
      const a = await brainService.startActivity({
        innerWorkSessionId: reflectionId,
        activityType: 'LLM_CALL',
        model: 'claude-haiku',
        input: {},
      });
      await brainService.failActivity(a.id, new Error('boom'));
      return a;
    });
    expect(
      await run.sql(`SELECT session_id, reflection_id, status::text AS status FROM brain_activity WHERE id = $1`, [
        inner.id,
      ]),
    ).toEqual([{ session_id: null, reflection_id: reflectionId, status: 'FAILED' }]);
  });

  // Review r1 F1/F2 (work-k5fk.9): metadata is ops-readable, so the stored trace and error are telemetry only. The
  // trace here is what the orchestrator wrote before the fix — a crisis classification and a model's free dispatch
  // text — and the writer's guard keeps neither.
  it('ops reading a safety turn sees no crisis category, no dispatch text and no error message', async () => {
    const { brainService } = await import('../brain-service');
    const ctx = await import('../../lib/request-context');
    const turnId = `ts12-safety-${process.pid}`;
    const seated = {
      turnId,
      requestId: 'r',
      startTime: Date.now(),
      userId: ids.bobUser,
      sessionId: ids.session,
      seated: true,
    };
    const main = await ctx.runWithContext(seated, () =>
      brainService.startActivity({
        sessionId: ids.session,
        turnId,
        activityType: 'LLM_CALL',
        model: 'claude-sonnet',
        input: {},
        callType: 'ORCHESTRATED_RESPONSE' as never,
      }),
    );
    expect(main.id).not.toBe('');
    await ctx.runWithContext(seated, () =>
      brainService.mergeTurnTrace(ids.session, turnId, {
        totalDurationMs: 12,
        modelUsed: 'claude-sonnet',
        usedMock: false,
        steps: [
          {
            name: 'Crisis Detection',
            type: 'decision',
            startMs: 0,
            durationMs: 0,
            result: 'severity=emergency, categories=suicide',
            status: 'success',
          },
          {
            name: 'Response Parsing',
            type: 'parsing',
            startMs: 1,
            durationMs: 1,
            result: 'thinking=true, draft=false, dispatch=SAFETY_CONCERN: PROBE_SHE_SAID',
            status: 'success',
          },
          {
            name: 'Dispatch: SAFETY_CONCERN: PROBE_SHE_SAID',
            type: 'dispatch',
            startMs: 2,
            durationMs: 1,
            result: '40 chars',
            status: 'success',
          },
          {
            name: 'Response Parsing',
            type: 'parsing',
            startMs: 3,
            durationMs: 1,
            result: 'thinking=true, draft=false, dispatch=SAFETY_CONCERN',
            status: 'success',
          },
        ],
      }),
    );
    const failed = await ctx.runWithContext(seated, () =>
      brainService.startActivity({ sessionId: ids.session, activityType: 'LLM_CALL', model: 'm', input: {} }),
    );
    await ctx.runWithContext(seated, () =>
      brainService.failActivity(failed.id, new Error('Unexpected token in JSON: PROBE_PROMPT_FRAGMENT')),
    );

    const [row] = await run.as<{ metadata: unknown }>(
      'mwf_ops',
      null,
      `SELECT metadata FROM brain_activity WHERE id = $1`,
      [main.id],
    );
    const seen = JSON.stringify(row.metadata);
    expect(seen).not.toMatch(/suicide|emergency|severity|categories|PROBE_SHE_SAID/);
    const steps = (row.metadata as { turnTrace: { steps: Array<{ name: string; result: string }> } }).turnTrace.steps;
    expect(steps.map(s => [s.name, s.result])).toEqual([
      ['Crisis Detection', '[redacted]'],
      ['Response Parsing', '[redacted]'],
      ['Unknown step', '[redacted]'],
      ['Response Parsing', 'thinking=true, draft=false, dispatch=SAFETY_CONCERN'],
    ]);
    const [err] = await run.as<{ metadata: unknown }>(
      'mwf_ops',
      null,
      `SELECT metadata FROM brain_activity WHERE id = $1`,
      [failed.id],
    );
    expect(err.metadata).toEqual({ error: 'Error' });
  });

  it('the database holds the metadata whitelist too: a raw write of an unknown key is refused (activity_metadata_json_schema)', async () => {
    const insert = (metadata: unknown) =>
      run.as(
        'mwf_ai',
        reflectionOwner,
        `INSERT INTO brain_activity (reflection_id, activity_type, model, metadata) VALUES ($1, 'LLM_CALL', 'm', $2::jsonb)`,
        [reflectionId, JSON.stringify(metadata)],
      );
    await expect(insert({ maxTokens: 1024, toolInvocations: [{ name: 'other' }] })).resolves.toBeDefined();
    await expect(insert({ maxTokens: 1024, prompt: 'PROBE_PROMPT' })).rejects.toThrow(
      'value for domain activity_metadata_json_schema violates check constraint "activity_metadata_whitelist"',
    );
    await expect(insert({ maxTokens: '1024' })).rejects.toThrow(/activity_metadata_whitelist/);
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
    expect(await actingAs(ids.bobUser, () => brainService.completeActivity(bad.id, { output: {} }))).toBeNull();
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

    // work-k5fk.9 ("close all"): a reflection's title is user- or AI-written text — never returned, never searched
    const [{ title }] = await run.sql<{ title: string | null }>(`SELECT title FROM reflection WHERE id = $1`, [
      reflectionId,
    ]);
    expect(title).toEqual(expect.any(String));
    const searched = await request(app).get(
      `/api/v1/brain/sessions?type=INNER_WORK&search=${encodeURIComponent(title!)}`,
    );
    expect(searched.body.data.sessions.map((s: { id: string }) => s.id)).not.toContain(reflectionId);
    expect(list.body.data.sessions.find((s: { id: string }) => s.id === reflectionId)).toMatchObject({ title: null });

    // work-k5fk.5: user.email is stored canonical (lowercase); the email arm canonicalizes the
    // search term, so the search stays case-insensitive. Only the email arm can match 'ADA@E2E'.
    const byEmail = await request(app).get(`/api/v1/brain/sessions?search=${encodeURIComponent('ADA@E2E')}`);
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.sessions.map((s: { id: string }) => s.id)).toContain(ids.session);

    const detail = await request(app).get(`/api/v1/brain/sessions/${ids.session}`);
    expect(detail.status).toBe(200);
    expect(typeof detail.body.data.stats.totalCost).toBe('number');

    const activity = await request(app).get(`/api/v1/brain/activity/${ids.session}`);
    expect(activity.status).toBe(200);
    expect(activity.body.data.activities.every((a: { cost: unknown }) => typeof a.cost === 'number')).toBe(true);
    // work-k5fk.9 ("close all"): telemetry and structure only — no call's input or output, no transcript, no memory
    expect(activity.body.data.activities.filter((a: Record<string, unknown>) => 'input' in a || 'output' in a)).toEqual(
      [],
    );
    expect(Object.keys(activity.body.data).sort()).toEqual(['activities', 'summary']);

    const costs = await request(app).get('/api/v1/brain/costs?period=7d');
    expect(costs.status).toBe(200);
    expect(typeof costs.body.data.summary.periodTotal).toBe('number');

    // work-k5fk.9 (least privilege): mwf_ops reads exactly the columns these routes need — every route still answers
    const llm = (
      activity.body.data.activities as Array<{ id: string; activityType: string; turnId: string | null }>
    ).find(a => a.activityType === 'LLM_CALL')!;
    const routes = [
      '/api/v1/brain/dashboard?period=7d',
      `/api/v1/brain/activity/${llm.id}/prompt`,
      `/api/v1/brain/activity/${reflectionId}`,
      `/api/v1/brain/sessions/${reflectionId}`,
      `/api/v1/brain/sessions/${reflectionId}/context`,
      '/api/v1/brain/sessions?type=INNER_WORK',
      '/api/v1/brain/sessions?type=PARTNER&status=ACTIVE',
    ];
    const statuses: Record<string, number> = {};
    for (const r of routes) statuses[r] = (await request(app).get(r)).status;
    expect(statuses).toEqual(Object.fromEntries(routes.map(r => [r, 200])));
    // a turn with no trace answers 404, not a permission error
    expect((await request(app).get('/api/v1/brain/turn/no-such-turn/trace')).status).toBe(404);

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

  it('the dashboard’s stage reads run the stage shim as mwf_ops: cost by stage, cache heatmap, cost flow, session context (work-qmgc)', async () => {
    const request = (await import('supertest')).default;
    const appModule = await import('../../app');
    const app = ((appModule as { default?: unknown }).default ?? appModule) as never;
    process.env.DASHBOARD_API_SECRET = '';

    // A session-scoped activity inside the period, so the cost routes resolve this session's stages
    // (resolveStageIntervalsForSessions → loadStageStates → the shim's invitation probe).
    const { brainService } = await import('../brain-service');
    // (the AI acts for a participant of the session, as a request does: work-k5fk.10.7)
    const activity = await actingAs(ids.bobUser, () =>
      brainService.startActivity({
        sessionId: ids.session,
        activityType: 'LLM_CALL',
        model: 'claude-sonnet',
        input: {},
      }),
    );
    expect(activity.id).not.toBe('');
    await actingAs(ids.bobUser, () => brainService.completeActivity(activity.id, { output: {}, cost: 0.002 }));

    // The shim reads invitation.invited_by_user_id; mwf_ops holds that column only
    // (metadata, never the invitation's content).
    const [{ col, msg }] = await run.sql<{ col: boolean; msg: boolean }>(
      `SELECT has_column_privilege('mwf_ops', 'invitation', 'invited_by_user_id', 'SELECT') AS col,
              has_column_privilege('mwf_ops', 'invitation', 'invitee_name', 'SELECT') AS msg`,
    );
    expect({ col, msg }).toEqual({ col: true, msg: false });

    const byStage = await request(app).get('/api/v1/brain/costs/by-stage?period=7d');
    expect(byStage.status).toBe(200);
    expect(byStage.body.data.stages.length).toBeGreaterThan(0);

    expect((await request(app).get('/api/v1/brain/costs/cache-heatmap?period=7d')).status).toBe(200);
    expect((await request(app).get('/api/v1/brain/costs/flow?period=7d')).status).toBe(200);

    const context = await request(app).get(`/api/v1/brain/sessions/${ids.session}/context`);
    expect(context.status).toBe(200);
    expect(context.body.data).toMatchObject({ sessionId: ids.session, sessionType: 'partner' });
    // work-k5fk.9 (review r1 F3): the monitor's context is structure from ops-granted columns, one entry per human
    // participant, read on mwf_ops (before the fix it ran the app's client, found no identity and returned none)
    const users = context.body.data.users as Array<{ userName: string; context: Record<string, unknown> }>;
    expect(users.map(u => u.userName).sort()).toEqual(['Ada Lovelace', 'Bob Ross']);
    for (const u of users) {
      expect(Object.keys(u.context).sort()).toEqual([
        'assembledAt',
        'intent',
        'latestIntensity',
        'milestones',
        'stage',
        'turnCount',
      ]);
    }
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
