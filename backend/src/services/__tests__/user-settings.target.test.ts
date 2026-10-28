/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture (built
 * from this branch's baseline, so the TS-12 job grants are in it): memory and
 * preferences on `user_preferences`, `user_device`, `user_memory`, `ai_memory`
 * and `mood_reading`, over HTTP as `mwf_app` with identity binding on; the
 * job's push-device reads as `mwf_job`.
 *
 * Replaces the Prisma-mock suites routes/__tests__/auth.test.ts (profile,
 * push token, preferences), services/__tests__/push.test.ts (token lookup and
 * invalid-token clearing) and routes/__tests__/emotions.test.ts.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Http = Awaited<ReturnType<typeof httpAs>>;
const TOKEN_A = 'ExponentPushToken[ts12-ada-phone-aaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[ts12-ada-tablet-bbbbbbbbbbb]';

describeTarget('memory and preferences on the target, as mwf_app (and the job as mwf_job)', () => {
  let run: TargetRun;
  let http: Http;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_settings_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('preferences: defaults on read (nothing written), a locked merge into user_preferences.doc with all three keys', async () => {
    expect((await http(ada, 'get', '/auth/me/privacy-preferences')).body.data.preferences).toEqual({
      showActivityStatus: true,
      allowSessionInvites: true,
      analyticsOptOut: false,
    });
    expect(await run.sql(`SELECT count(*)::int AS n FROM user_preferences WHERE user_id = $1`, [ada.id])).toEqual([
      { n: 0 },
    ]);

    // Two devices change different settings at once: both survive
    const [a, b] = await Promise.all([
      http(ada, 'patch', '/auth/me/privacy-preferences', { showActivityStatus: false }),
      http(ada, 'patch', '/auth/me/notification-preferences', { emailEnabled: true }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await http(ada, 'put', '/auth/me/memory-preferences', { patternInsights: false })).status).toBe(200);
    const [row] = await run.sql<{ doc: Record<string, Record<string, unknown>> }>(
      `SELECT doc FROM user_preferences WHERE user_id = $1`,
      [ada.id],
    );
    expect(Object.keys(row.doc).sort()).toEqual(['memory', 'notifications', 'privacy']);
    expect(row.doc.privacy.showActivityStatus).toBe(false);
    expect(row.doc.notifications.emailEnabled).toBe(true);
    expect(row.doc.memory.patternInsights).toBe(false);
    // Bob's are his own defaults
    expect((await http(bob, 'get', '/auth/me/privacy-preferences')).body.data.preferences.showActivityStatus).toBe(
      true,
    );
  });

  it('devices: one user_device row per push token, idempotent; biometric on the devices; GET /auth/me reflects them', async () => {
    for (const token of [TOKEN_A, TOKEN_A, TOKEN_B]) {
      expect((await http(ada, 'post', '/auth/push-token', { pushToken: token, platform: 'ios' })).status).toBe(200);
    }
    expect(
      await run.sql(
        `SELECT push_token, platform::text AS platform FROM user_device WHERE user_id = $1 ORDER BY push_token`,
        [ada.id],
      ),
    ).toEqual([
      { push_token: TOKEN_A, platform: 'ios' },
      { push_token: TOKEN_B, platform: 'ios' },
    ]);
    const bio = await http(ada, 'patch', '/auth/biometric', { enabled: true });
    expect(bio.body.data.biometricEnabled).toBe(true);
    const me = (await http(ada, 'get', '/auth/me')).body.data;
    expect(me).toMatchObject({ pushNotificationsEnabled: true, user: { biometricEnabled: true } });
    expect((await http(bob, 'get', '/auth/me')).body.data).toMatchObject({
      pushNotificationsEnabled: false,
      user: { biometricEnabled: false },
    });

    // Logging out one device clears its token only
    expect((await http(ada, 'delete', '/auth/push-token', { pushToken: TOKEN_A })).status).toBe(200);
    expect(
      await run.sql(`SELECT push_token FROM user_device WHERE user_id = $1 AND push_token IS NOT NULL`, [ada.id]),
    ).toEqual([{ push_token: TOKEN_B }]);
  });

  it("push: the JOB (mwf_job) reads another user's tokens and clears an unregistered one", async () => {
    const settings = await import('../user-settings');
    expect(await settings.pushTokensAsJob(ada.id)).toEqual([TOKEN_B]);
    await settings.clearPushTokenAsJob(ada.id, TOKEN_B);
    expect(await settings.pushTokensAsJob(ada.id)).toEqual([]);
    // …and the job still holds no read of anything else on user_device
    await expect(run.as('mwf_job', null, `SELECT biometric_enabled FROM user_device`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('mood: a reading on the live participant; lastMoodIntensity is the latest reading', async () => {
    const before = await run.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM mood_reading WHERE participant_id = $1`,
      [ids.ada],
    );
    expect((await http(ada, 'patch', '/auth/me/mood', { intensity: 7 })).body.data).toEqual({ lastMoodIntensity: 7 });
    expect(await run.sql(`SELECT count(*)::int AS n FROM mood_reading WHERE participant_id = $1`, [ids.ada])).toEqual([
      { n: before[0].n + 1 },
    ]);
    expect((await http(ada, 'get', '/auth/me')).body.data.user.lastMoodIntensity).toBe(7);
    // The latest reading wins, not the first
    await new Promise(r => setTimeout(r, 5));
    expect((await http(ada, 'patch', '/auth/me/mood', { intensity: 4 })).status).toBe(200);
    expect((await http(ada, 'get', '/auth/me')).body.data.user.lastMoodIntensity).toBe(4);

    // The session endpoint: own readings only, with a derived stage
    const recorded = await http(bob, 'post', `/sessions/${ids.session}/emotions`, {
      intensity: 3,
      context: 'PROBE_TS12_MOOD tired',
    });
    expect(recorded.status).toBe(200);
    const bobReadings = (await http(bob, 'get', `/sessions/${ids.session}/emotions`)).body.data.readings;
    expect(bobReadings[0]).toMatchObject({ intensity: 3, context: 'PROBE_TS12_MOOD tired' });
    expect(typeof bobReadings[0].stage).toBe('number');
    const adaReadings = (await http(ada, 'get', `/sessions/${ids.session}/emotions`)).body.data.readings;
    expect(JSON.stringify(adaReadings)).not.toContain('PROBE_TS12_MOOD');
    const exercise = await http(bob, 'post', `/sessions/${ids.session}/exercises/complete`, {
      type: 'GROUNDING',
      intensityBefore: 8,
      intensityAfter: 5,
    });
    expect(exercise.body.data.completion).toMatchObject({ type: 'GROUNDING', intensityDelta: 3 });
    expect(
      await run.sql(`SELECT type::text AS type FROM regulation_event WHERE participant_id = $1`, [ids.bob]),
    ).toEqual([{ type: 'GROUNDING' }]);
  });

  it('memories: user_memory rows are the owner’s; global facts are the user’s GLOBAL_FACTS ai_memory document', async () => {
    // The validator asks the model (fail-secure under MOCK_LLM): the LLM boundary is stubbed, not Prisma
    const bedrock = await import('../../lib/bedrock');
    const spy = jest.spyOn(bedrock, 'getHaikuJson').mockResolvedValue({ valid: true } as never);
    const created = await http(ada, 'post', '/memories', {
      content: 'Call me Ada, never Adeline',
      category: 'PERSONAL_INFO',
    });
    spy.mockRestore();
    expect(created.status).toBe(201);
    expect((await http(ada, 'get', '/memories')).status).toBe(200);
    expect((await http(bob, 'delete', `/memories/${created.body.data.memory.id}`)).status).toBeGreaterThanOrEqual(400);
    expect(await run.sql(`SELECT count(*)::int AS n FROM user_memory WHERE user_id = $1`, [ada.id])).toEqual([
      { n: 1 },
    ]);

    await run.sql(
      `INSERT INTO ai_memory (participant_id, kind, doc) VALUES ($1, 'NOTABLE_FACTS', $2)
       ON CONFLICT (participant_id, kind) DO UPDATE SET doc = EXCLUDED.doc`,
      [ids.ada, JSON.stringify({ facts: [{ category: 'People', fact: 'PROBE_TS12_FACT has a sister' }] })],
    );
    const { consolidateGlobalFacts, loadGlobalFacts } = await import('../global-memory');
    const ctx = await import('../../lib/request-context');
    await ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId: ada.id }, async () => {
      await consolidateGlobalFacts(ada.id, ids.session, 'turn-ts12');
      expect(await loadGlobalFacts(ada.id)).toEqual([{ category: 'People', fact: 'PROBE_TS12_FACT has a sister' }]);
    });
    expect(
      await run.sql(
        `SELECT kind::text AS kind, user_id IS NOT NULL AS user_scoped FROM ai_memory WHERE kind = 'GLOBAL_FACTS'`,
      ),
    ).toEqual([{ kind: 'GLOBAL_FACTS', user_scoped: true }]);
  });
});
