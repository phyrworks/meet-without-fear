/**
 * TS-12, real roles on clones of the TOMBSTONE_READY target fixture (built
 * from this branch's baseline): deletion and retention on the target.
 *
 *   - leaving one session (DELETE /sessions/:id) runs
 *     app.anonymize_user_in_session as the job, plus the two explicit deletes
 *     the function does not cover (session-scoped user_memory, the leaver's
 *     reminders for the session's follow-ups); delivered content survives; the
 *     leaver is refused afterwards;
 *   - account deletion (DELETE /auth/me) is the account walk as the job: the
 *     user row is a tombstone, never deleted; private rows gone; survivors kept;
 *     keys shredded;
 *   - the retention sweeps run as the job: a stale ACTIVE session goes
 *     ABANDONED → ARCHIVED, a long-ARCHIVED one is hard-deleted with its whole
 *     tree (users untouched); brain_activity blobs are purged in their windows
 *     and old rows deleted.
 *
 * Replaces the Prisma-mock suite services/__tests__/session-retention.test.ts.
 * Requires: npx tsx src/testing/golden/cli.ts build TOMBSTONE_READY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(240_000);

type Http = Awaited<ReturnType<typeof httpAs>>;
const DAY = 24 * 60 * 60 * 1000;

describeTarget('deletion and retention on the target (the job as mwf_job, the app as mwf_app)', () => {
  let run: TargetRun;
  let http: Http;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = '';
    run = await openTargetRun('TOMBSTONE_READY', `ts12_deletion_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const count = async (sql: string, params: unknown[] = []) => (await run.sql<{ n: number }>(sql, params))[0].n;

  it('leaving a session: the per-session walk as the job, the two explicit deletes, survivors kept, the leaver refused', async () => {
    // Session-scoped and global memories, and a reminder about a follow-up of this session, for Ada
    await run.sql(
      `INSERT INTO user_memory (user_id, session_id, content, category) VALUES ($1, $2, 'PROBE_TS12_SESSION_MEMORY', 'COMMUNICATION'),
                                                                     ($1, NULL, 'PROBE_TS12_GLOBAL_MEMORY', 'LANGUAGE')`,
      [ada.id, ids.session],
    );
    const [agreement] = await run.sql<{ id: string }>(`SELECT id FROM agreement`);
    const [followUp] = await run.sql<{ id: string }>(
      `INSERT INTO follow_up (session_id, agreement_id, type, scope, status, scheduled_for)
       VALUES ($1, $2, 'SCHEDULED_SHARED_AGREEMENT', 'SHARED', 'SCHEDULED', now() + interval '3 days') RETURNING id`,
      [ids.session, agreement.id],
    );
    await run.sql(`INSERT INTO reminder (user_id, follow_up_id, remind_at) VALUES ($1, $2, now() + interval '1 day'), ($3, $2, now() + interval '1 day')`, [
      ada.id,
      followUp.id,
      bob.id,
    ]);
    // Fix round 1 (M5): Ada's choices UNSHARED (no choices_shared): the walk deletes them (spec §4 step 3);
    // Bob's shared choice stays.
    await run.sql(`DELETE FROM participant_milestone WHERE participant_id = $1 AND milestone_key = 'choices_shared'`, [ids.ada]);
    expect(await count(`SELECT count(*)::int AS n FROM proposal_choice WHERE participant_id = $1`, [ids.ada])).toBeGreaterThan(0);
    const bobChoices = await count(`SELECT count(*)::int AS n FROM proposal_choice WHERE participant_id = $1`, [ids.bob]);
    const bobMessagesBefore = await count(`SELECT count(*)::int AS n FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE c.participant_id = $1`, [ids.bob]);

    const res = await http(ada, 'delete', `/sessions/${ids.session}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.sessionAbandoned).toBe(true);

    const [p] = await run.sql<{ display_name: string | null; left: boolean }>(`SELECT display_name, left_at IS NOT NULL AS left FROM participant WHERE id = $1`, [ids.ada]);
    expect(p).toEqual({ display_name: null, left: true });
    expect(await run.sql(`SELECT status::text AS status FROM session WHERE id = $1`, [ids.session])).toEqual([{ status: 'ABANDONED' }]);
    expect(await count(`SELECT count(*)::int AS n FROM conversation WHERE participant_id = $1`, [ids.ada])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM draft WHERE participant_id = $1`, [ids.ada])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM proposal_choice WHERE participant_id = $1`, [ids.ada])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM proposal_choice WHERE participant_id = $1`, [ids.bob])).toBe(bobChoices);
    // The explicit deletes: Ada's session-scoped memory and her reminder go; her global memory and Bob's reminder stay
    expect(await run.sql(`SELECT content FROM user_memory WHERE user_id = $1 ORDER BY content`, [ada.id])).toEqual([
      { content: 'PROBE_TS12_GLOBAL_MEMORY' },
    ]);
    expect(await run.sql(`SELECT user_id FROM reminder`)).toEqual([{ user_id: bob.id }]);
    // Delivered content survives in Bob's conversation; shared needs and the agreement survive
    expect(await count(`SELECT count(*)::int AS n FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE c.participant_id = $1`, [ids.bob])).toBe(
      bobMessagesBefore,
    );
    expect(await count(`SELECT count(*)::int AS n FROM need_share WHERE participant_id = $1`, [ids.ada])).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM agreement`)).toBe(1);
    // R17: the session's unattributed telemetry is gone
    expect(await count(`SELECT count(*)::int AS n FROM brain_activity WHERE session_id = $1`, [ids.session])).toBe(0);
    // The leaver is refused from now on (TS-9 leaver rule); her user row is untouched
    expect((await http(ada, 'get', `/sessions/${ids.session}/messages`)).status).toBe(403);
    expect(await run.sql(`SELECT deleted_at IS NULL AS live FROM "user" WHERE id = $1`, [ada.id])).toEqual([{ live: true }]);
  });

  it('account deletion: the walk as the job — a tombstone, private rows gone, keys shredded, survivors kept', async () => {
    // Bob's U-class rows and a key, so the walk has every class to sort
    await run.sql(`INSERT INTO user_device (user_id, push_token) VALUES ($1, 'ExponentPushToken[ts12-bob]')`, [bob.id]);
    await run.sql(`INSERT INTO feature_state (user_id, feature, doc) VALUES ($1, 'gratitude', '{"entries": []}')`, [bob.id]);
    await run.sql(`INSERT INTO user_key (user_id, key_id, wrapped_dek) VALUES ($1, 'k-bob', '\\x00')`, [bob.id]);
    await run.sql(`INSERT INTO participant_key (participant_id, key_id, wrapped_dek) VALUES ($1, 'pk-bob', '\\x00')`, [ids.bob]);

    // R40 (fix round 1, I1): telemetry written inside ADA's request. The reconciler call reads Bob's
    // round (cross-participant: not attributed, its call site passes no ownContent); Ada's own chat
    // turn is attributed to her. Both rows carry Bob's private line in output.
    const { brainService, BrainActivityCallType } = await import('../brain-service');
    const { runWithContext } = await import('../../lib/request-context');
    const asAdaRequest = <T>(fn: () => Promise<T>) =>
      runWithContext(
        { turnId: 't', requestId: 'r', startTime: Date.now(), userId: ada.id, sessionId: ids.session, participantId: ids.ada },
        fn,
      );
    const reconcilerRow = await asAdaRequest(() =>
      brainService.startActivity({
        sessionId: ids.session,
        turnId: 'ts12-r40-reconciler',
        activityType: 'LLM_CALL' as never,
        model: 'claude-sonnet',
        input: { operation: 'reconciler-analysis' },
        callType: BrainActivityCallType.RECONCILER_ANALYSIS,
      }),
    );
    const ownRow = await asAdaRequest(() =>
      brainService.startActivity({
        sessionId: ids.session,
        turnId: 'ts12-r40-own-turn',
        activityType: 'LLM_CALL' as never,
        model: 'claude-sonnet',
        input: { operation: 'orchestrator-response' },
        callType: BrainActivityCallType.ORCHESTRATED_RESPONSE,
        attributeToCaller: true,
      }),
    );
    for (const row of [reconcilerRow, ownRow]) {
      await brainService.completeActivity(row.id, { output: { text: 'PROBE_TS12_BOB_PRIVATE_LINE' } });
    }
    expect(
      await run.sql(`SELECT turn_id, participant_id FROM brain_activity WHERE turn_id LIKE 'ts12-r40-%' ORDER BY turn_id`),
    ).toEqual([
      { turn_id: 'ts12-r40-own-turn', participant_id: ids.ada },
      { turn_id: 'ts12-r40-reconciler', participant_id: null },
    ]);

    const res = await http(bob, 'delete', '/auth/me');
    expect(res.status).toBe(200);
    // The cross-participant row is gone with Bob's leave (R17: the session's unattributed rows);
    // no row of the session carries Bob's line in output or structured_output any more except the
    // one attributed to Ada's own turn (a fixture probe, not his content in production).
    expect(await count(`SELECT count(*)::int AS n FROM brain_activity WHERE turn_id = 'ts12-r40-reconciler'`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM brain_activity WHERE turn_id = 'ts12-r40-own-turn'`)).toBe(1);

    const [u] = await run.sql<{ email: string; clerk_id: string | null; first_name: string | null; deleted: boolean }>(
      `SELECT email, clerk_id, first_name, deleted_at IS NOT NULL AS deleted FROM "user" WHERE id = $1`,
      [bob.id],
    );
    expect(u).toEqual({ email: `deleted+${bob.id}`, clerk_id: null, first_name: null, deleted: true });
    expect(await count(`SELECT count(*)::int AS n FROM user_device WHERE user_id = $1`, [bob.id])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM feature_state WHERE user_id = $1`, [bob.id])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM conversation WHERE participant_id = $1`, [ids.bob])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM user_key WHERE user_id = $1 AND destroyed_at IS NULL`, [bob.id])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM participant_key WHERE participant_id = $1 AND destroyed_at IS NULL`, [ids.bob])).toBe(0);
    // Survivors: the participant row (tombstoned), shared needs, the revealed attempt, the agreement parties
    expect(await run.sql(`SELECT display_name FROM participant WHERE id = $1`, [ids.bob])).toEqual([{ display_name: null }]);
    expect(await count(`SELECT count(*)::int AS n FROM need_share WHERE participant_id = $1`, [ids.bob])).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM empathy_attempt WHERE author_participant_id = $1 AND revealed_at IS NOT NULL`, [ids.bob])).toBeGreaterThan(0);
    expect(await count(`SELECT count(*)::int AS n FROM agreement_party WHERE participant_id = $1`, [ids.bob])).toBe(1);
  });

  it('session retention as the job: stale ACTIVE → ABANDONED → ARCHIVED; a long-ARCHIVED session is hard-deleted with its tree, users kept', async () => {
    const { enforceSessionRetention, ACTIVE_SESSION_RETENTION_MS, ARCHIVED_SESSION_PURGE_MS } = await import('../session-retention');
    // A fresh stale ACTIVE session of the same relationship (the fixture's is ABANDONED by now)
    const [rel] = await run.sql<{ relationship_id: string }>(`SELECT relationship_id FROM session WHERE id = $1`, [ids.session]);
    const old = new Date(Date.now() - ACTIVE_SESSION_RETENTION_MS - DAY);
    const [s] = await run.sql<{ id: string }>(`INSERT INTO session (relationship_id, status) VALUES ($1, 'CREATED') RETURNING id`, [rel.relationship_id]);
    const users = await run.sql<{ id: string }>(`INSERT INTO "user" (email, first_name) VALUES ('ts12-r1@e2e.test', 'R1'), ('ts12-r2@e2e.test', 'R2') RETURNING id`);
    for (const u of users) {
      const [p] = await run.sql<{ id: string }>(`INSERT INTO participant (session_id, user_id) VALUES ($1, $2) RETURNING id`, [s.id, u.id]);
      const [c] = await run.sql<{ id: string }>(`INSERT INTO conversation (participant_id) VALUES ($1) RETURNING id`, [p.id]);
      await run.sql(`INSERT INTO message (conversation_id, sender_participant_id, role, content, created_at) VALUES ($1, $2, 'USER', 'old', $3)`, [c.id, p.id, old]);
    }
    await run.sql(`UPDATE session SET status = 'INVITED' WHERE id = $1`, [s.id]);
    await run.sql(`UPDATE session SET status = 'ACTIVE' WHERE id = $1`, [s.id]);
    await run.sql(`ALTER TABLE session DISABLE TRIGGER USER`);
    await run.sql(`UPDATE session SET updated_at = $2 WHERE id = $1`, [s.id, old]);
    await run.sql(`ALTER TABLE session ENABLE TRIGGER USER`);

    const first = await enforceSessionRetention();
    expect(first).toMatchObject({ archived: 1, deleted: 0 });
    expect(await run.sql(`SELECT status::text AS status FROM session WHERE id = $1`, [s.id])).toEqual([{ status: 'ARCHIVED' }]);

    // Past the purge window: the whole session tree goes, the users stay
    const later = new Date(Date.now() + ARCHIVED_SESSION_PURGE_MS + DAY);
    const second = await enforceSessionRetention(later);
    expect(second.deleted).toBeGreaterThanOrEqual(1);
    expect(await count(`SELECT count(*)::int AS n FROM session WHERE id = $1`, [s.id])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM participant WHERE session_id = $1`, [s.id])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM "user" WHERE email LIKE 'ts12-r%'`)).toBe(2);
  });

  it('session retention reads activity from messages, falling back to updated_at: a recent message keeps a stale-updated session', async () => {
    const { enforceSessionRetention, ACTIVE_SESSION_RETENTION_MS } = await import('../session-retention');
    const old = new Date(Date.now() - ACTIVE_SESSION_RETENTION_MS - DAY);
    const staleActive = async (email: string, messageAt: Date | null) => {
      const [r] = await run.sql<{ id: string }>(`INSERT INTO relationship DEFAULT VALUES RETURNING id`);
      const [s] = await run.sql<{ id: string }>(`INSERT INTO session (relationship_id, status) VALUES ($1, 'CREATED') RETURNING id`, [r.id]);
      const [u, u2] = await run.sql<{ id: string }>(`INSERT INTO "user" (email, first_name) VALUES ($1, 'R'), ('x' || $1, 'R2') RETURNING id`, [email]);
      await run.sql(`INSERT INTO participant (session_id, user_id) VALUES ($1, $2)`, [s.id, u2.id]);
      const [p] = await run.sql<{ id: string }>(`INSERT INTO participant (session_id, user_id) VALUES ($1, $2) RETURNING id`, [s.id, u.id]);
      const [c] = await run.sql<{ id: string }>(`INSERT INTO conversation (participant_id) VALUES ($1) RETURNING id`, [p.id]);
      if (messageAt)
        await run.sql(`INSERT INTO message (conversation_id, sender_participant_id, role, content, created_at) VALUES ($1, $2, 'USER', 'recent', $3)`, [c.id, p.id, messageAt]);
      await run.sql(`UPDATE session SET status = 'INVITED' WHERE id = $1`, [s.id]);
      await run.sql(`UPDATE session SET status = 'ACTIVE' WHERE id = $1`, [s.id]);
      await run.sql(`ALTER TABLE session DISABLE TRIGGER USER`);
      await run.sql(`UPDATE session SET updated_at = $2 WHERE id = $1`, [s.id, old]);
      await run.sql(`ALTER TABLE session ENABLE TRIGGER USER`);
      return s.id;
    };
    const talking = await staleActive('ts12-talking@e2e.test', new Date());
    const silent = await staleActive('ts12-silent@e2e.test', null);

    const result = await enforceSessionRetention();
    expect(result).toMatchObject({ inspected: 2, archived: 1 });
    const status = async (id: string) => (await run.sql<{ status: string }>(`SELECT status::text AS status FROM session WHERE id = $1`, [id]))[0].status;
    expect(await status(talking)).toBe('ACTIVE');
    expect(await status(silent)).toBe('ARCHIVED');
  });

  it('brain_activity retention as the job: sessionless blobs purged within days, session blobs at 30, rows at 90', async () => {
    const { enforceDataRetention } = await import('../data-retention');
    const at = (days: number) => new Date(Date.now() - days * DAY);
    await run.sql(`DELETE FROM brain_activity`);
    for (const [label, sessionId, days] of [
      ['sessionless-fresh', null, 1],
      ['sessionless-week', null, 8],
      ['session-week', ids.session, 8],
      ['session-month', ids.session, 31],
      ['ancient', ids.session, 91],
    ] as const) {
      await run.sql(
        `INSERT INTO brain_activity (session_id, turn_id, activity_type, model, input, output, created_at)
         VALUES ($1, $2, 'LLM_CALL', 'm', '{"prompt": "PROBE"}', '{"text": "PROBE"}', $3)`,
        [sessionId, label, at(days)],
      );
    }
    const result = await enforceDataRetention();
    expect(result.recordsDeleted).toBe(1);
    const left = await run.sql<{ turn_id: string; has_blob: boolean }>(`SELECT turn_id, input IS NOT NULL AS has_blob FROM brain_activity`);
    expect(left.sort((a, b) => (a.turn_id < b.turn_id ? -1 : 1))).toEqual([
      { turn_id: 'session-month', has_blob: false },
      { turn_id: 'session-week', has_blob: true },
      { turn_id: 'sessionless-fresh', has_blob: true },
      { turn_id: 'sessionless-week', has_blob: false },
    ]);
  });
});
