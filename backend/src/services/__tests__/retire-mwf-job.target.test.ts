/**
 * work-k5fk.10.5 (design note §6 Q13/Q16/Q20, §7 row 9b): mwf_job is retired.
 *
 *   - mwf_job and its interim capability job_access no longer exist; mwf_ai and mwf_worker are LOGIN
 *     (mwf_clinician stays reserved, NOLOGIN);
 *   - ai_access and worker_access hold exactly what their call sites use (column- and command-level),
 *     pinned below — a grant beyond these widens what an AI or worker bug, or an injection, can touch;
 *   - the request path's cross-partner writes are SECURITY DEFINER functions owned by mwf_definer, each
 *     executable by exactly the capability (or capabilities) that calls it;
 *   - app.session_scope is required: the AI writes only into the one session its transaction names
 *     (t_session_scope), and the definers' AI / worker arms refuse an unset or different scope;
 *   - no function or trigger body names mwf_job any more.
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
import { withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

/**
 * ai_access (mwf_ai): the AI's call sites — the reconciler (reconciler/*.ts, empathy-store's job moves),
 * the facilitator's AI / SYSTEM lines (message-store createFacilitatorMessage(Once)), the summarizer and the
 * classifier (ai_memory), the brain telemetry (brain-service.ts). `table:PRIV` is a table-level grant,
 * `table:PRIV(cols)` a column-level one.
 */
const AI_GRANTS = [
  'ai_memory:INSERT(doc,kind,session_id,user_id)',
  'ai_memory:SELECT(doc,id,kind,session_id,user_id)',
  'ai_memory:UPDATE(doc)',
  'brain_activity:INSERT(activity_type,call_type,input,metadata,model,participant_user_id,reflection_id,session_id,status,turn_id)',
  'brain_activity:SELECT(call_type,created_at,id,metadata,session_id,turn_id)',
  'brain_activity:UPDATE(completed_at,cost,duration_ms,metadata,output,status,token_count_input,token_count_output)',
  'context_share_offer:INSERT(attempt_id,iteration,offer_message,offered_at,result_id,session_id,status,subject_user_id,suggested_content,suggested_reason)',
  'context_share_offer:SELECT(attempt_id,delivery_status,id,iteration,result_id,session_id,status,subject_user_id,suggested_content)',
  'context_share_offer:UPDATE(delivered_at,delivery_status)',
  'conversation:SELECT(id,kind,session_id,user_id)',
  'empathy_attempt:SELECT',
  'empathy_attempt:UPDATE(updated_at)',
  'json_schema:SELECT',
  'message:INSERT(content,conversation_id,created_at,dedupe_key,kind,refining_need_id,role,sender_user_id,session_id,source_attempt_id)',
  'message:SELECT(content,conversation_id,created_at,kind,role,sender_user_id,seq,session_id,source_attempt_id)',
  'participant:SELECT(display_name,joined_at,kind,left_at,session_id,user_id)',
  'participant_milestone:SELECT(milestone_key,reached_at,session_id,user_id)',
  'reconciler_guidance:INSERT(area_hint,author_user_id,guidance_type,result_id,session_id,subject_user_id)',
  'reconciler_guidance:SELECT(area_hint,guidance_type,result_id)',
  'reconciler_result:INSERT(alignment_score,alignment_summary,attempt_id,author_user_id,circuit_breaker_tripped,correctly_identified,gap_severity,gap_summary,iteration,misattributions,missed_feelings,most_important_gap,rationale,recommended_action,session_id,sharing_would_help,subject_user_id,suggested_share_content,suggested_share_focus,suggested_share_reason)',
  'reconciler_result:SELECT(alignment_score,alignment_summary,attempt_id,correctly_identified,created_at,gap_severity,gap_summary,id,iteration,misattributions,missed_feelings,most_important_gap,rationale,recommended_action,session_id,sharing_would_help,subject_user_id,suggested_share_content,suggested_share_focus,suggested_share_reason,superseded_at)',
  'reconciler_result:UPDATE(superseded_at)',
  'session:SELECT(id)',
  'session:UPDATE(updated_at)',
  'user:SELECT(first_name,id,kind,name)',
];

/**
 * worker_access (mwf_worker): the scheduled jobs (session-retention.ts, data-retention.ts,
 * open-due-tending-entries.ts, tending coordination), notification delivery (push.ts through
 * user-settings pushTokensAsJob / clearPushTokenAsJob), and the session-scoped system decisions of
 * Stage 4 (stage4-closure.ts, stage4-store.ts createAgreementsAsJob / closeSessionAsJob, tending scheduling).
 */
const WORKER_GRANTS = [
  'agreement:INSERT(description,duration,follow_up_at,measure_of_success,proposal_id,session_id,status,type)',
  'agreement:SELECT(created_at,id,proposal_id,session_id,status)',
  'agreement:UPDATE(completed_at,status)',
  'agreement_party:INSERT(agreed_at,agreement_id,session_id,user_id)',
  'agreement_party:SELECT(agreement_id,session_id,user_id)',
  'brain_activity:DELETE',
  'brain_activity:SELECT(created_at,session_id)',
  'brain_activity:UPDATE(input,metadata,output)',
  'follow_up:INSERT(agreement_id,opted_in_shared,owner_user_id,proposal_id,response_deadline_at,scheduled_for,scope,session_id,status,summary,type)',
  'follow_up:SELECT(agreement_id,id,owner_user_id,response_deadline_at,scheduled_for,scope,session_id,status,type)',
  'follow_up:UPDATE(completed_at,opened_at,response_deadline_at,status)',
  'message:SELECT(created_at,session_id)',
  'participant:SELECT(kind,left_at,session_id,user_id)',
  'participant_milestone:SELECT(milestone_key,session_id,user_id)',
  'proposal:SELECT(created_by_user_id,description,duration,id,kind,measure_of_success,session_id,shared_at,status)',
  'proposal:UPDATE(status)',
  'proposal_choice:SELECT(decision,proposal_id,session_id,user_id)',
  'proposal_revision:INSERT(action,actor_user_id,after,before,proposal_id,reason,session_id)',
  'reminder:SELECT(cadence,follow_up_id,id,remind_at,scope,status,user_id)',
  'reminder:UPDATE(remind_at,status)',
  'session:DELETE',
  'session:SELECT(id,status,updated_at)',
  'session_closure:INSERT(check_in_at,closed_at,closed_by_user_id,kind,reason,session_id,summary)',
  'user_device:SELECT(last_seen_at,push_provider,push_token,user_id)',
  'user_device:UPDATE(push_provider,push_token)',
];

/** Schema USAGE and function EXECUTE of each, by name. */
const AI_ROUTINES = [
  // typed domains (2026-11-23): the CHECK of brain_activity.metadata's activity_metadata domain
  'activity_metadata_violation:EXECUTE',
  'deliver_message:EXECUTE',
  'empathy_mark_delivery:EXECUTE',
  'empathy_set_status:EXECUTE',
  // owner decision OD-1 (work-k5fk.9): brain_activity.output is a jsonb envelope the AI writes
  'jsonb_envelope_violation:EXECUTE',
  'jsonb_violation:EXECUTE',
  // work-k5fk.10.7: the AI policies' predicates (the acting user is a member of the scope; an inner-work row is
  // the acting user's reflection)
  'owns_reflection:EXECUTE',
  'schema app:USAGE',
  'schema public:USAGE',
  'scope_actor_is_member:EXECUTE',
  'session_scope:EXECUTE',
];
const WORKER_ROUTINES = [
  'activity_metadata_violation:EXECUTE',
  'jsonb_envelope_violation:EXECUTE',
  'schema app:USAGE',
  'schema public:USAGE',
  'session_scope:EXECUTE',
  'session_set_status:EXECUTE',
];

/** The new definers (and the re-homed old ones): who may EXECUTE each, besides its owner mwf_definer. */
const DEFINER_EXECUTE: Record<string, string[]> = {
  'app.deliver_message(uuid,uuid,message_kind,text,uuid,timestamp with time zone)': ['ai_access', 'app_access'],
  'app.reach_milestone(uuid,uuid,text,timestamp with time zone)': ['app_access'],
  'app.session_resume(uuid)': ['app_access'],
  'app.choices_unshare(uuid)': ['app_access'],
  'app.share_offers_expire(uuid,uuid[])': ['app_access'],
  'app.share_offers_mark_notified(uuid[],boolean)': ['app_access'],
  'app.session_abandon_declined(uuid)': ['app_access'],
  'app.empathy_mark_delivery(uuid,delivery_status,timestamp with time zone)': ['ai_access', 'app_access'],
  'app.identity_subject(identity_provider)': ['app_access'],
  'app.session_set_status(uuid,session_status)': ['app_access', 'worker_access'],
  'app.empathy_set_status(uuid,empathy_status,text)': ['ai_access', 'app_access'],
  'app.need_share(uuid,text)': ['app_access'],
  'app.need_revoke_share(uuid)': ['app_access'],
  'app.anonymize_user_in_session(uuid,uuid)': ['app_access'],
  'app.anonymize_user_account(uuid)': ['app_access'],
  'app.is_member(uuid)': ['app_access'],
  'app.partner_user_id(uuid)': ['app_access'],
  'app.empathy_direction_status()': ['app_access'],
};

/** Table and column grants of `role` in public/app, as `table:PRIV` / `table:PRIV(cols)`. */
const TABLE_GRANTS = `
  WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
  SELECT x.rel || ':' || x.priv || coalesce('(' || string_agg(x.col, ',' ORDER BY x.col) || ')', '') AS g
  FROM (
    SELECT c.relname::text AS rel, a.privilege_type AS priv, NULL::text AS col
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a, r
    WHERE n.nspname IN ('public', 'app') AND a.grantee = r.oid
    UNION ALL
    SELECT c.relname::text, a.privilege_type, att.attname::text
    FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(att.attacl) a, r
    WHERE n.nspname IN ('public', 'app') AND a.grantee = r.oid
  ) x
  GROUP BY x.rel, x.priv, x.col IS NULL
  ORDER BY 1`;

const ROUTINE_GRANTS = `
  WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
  SELECT g FROM (
    SELECT p.proname || ':' || a.privilege_type AS g
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a, r
    WHERE n.nspname IN ('public', 'app') AND a.grantee = r.oid
    UNION ALL
    SELECT 'schema ' || s.nspname || ':' || a.privilege_type
    FROM pg_namespace s, aclexplode(s.nspacl) a, r WHERE s.nspname IN ('public', 'app') AND a.grantee = r.oid
  ) x ORDER BY 1`;

describeTarget('mwf_job retired: mwf_ai, mwf_worker and the definers (target)', () => {
  let run: TargetRun;

  beforeAll(async () => {
    run = await openTargetRun('FEEL_HEARD_B', `b9b_${process.pid}`);
  });
  afterAll(async () => {
    await run?.drop();
  });

  it('mwf_job and job_access no longer exist; mwf_ai and mwf_worker log in, mwf_clinician does not', async () => {
    const rows = await run.sql<{ rolname: string; rolcanlogin: boolean }>(
      `SELECT rolname::text, rolcanlogin FROM pg_roles
       WHERE rolname IN ('mwf_job', 'job_access', 'mwf_ai', 'mwf_worker', 'mwf_clinician') ORDER BY rolname`,
    );
    expect(rows).toEqual([
      { rolname: 'mwf_ai', rolcanlogin: true },
      { rolname: 'mwf_clinician', rolcanlogin: false },
      { rolname: 'mwf_worker', rolcanlogin: true },
    ]);
  });

  it('ai_access holds exactly the AI call sites’ grants', async () => {
    const tables = (await run.sql<{ g: string }>(TABLE_GRANTS, ['ai_access'])).map(r => r.g);
    expect(tables).toEqual(AI_GRANTS);
    const routines = (await run.sql<{ g: string }>(ROUTINE_GRANTS, ['ai_access'])).map(r => r.g);
    expect(routines).toEqual(AI_ROUTINES);
  });

  it('worker_access holds exactly the worker call sites’ grants', async () => {
    const tables = (await run.sql<{ g: string }>(TABLE_GRANTS, ['worker_access'])).map(r => r.g);
    expect(tables).toEqual(WORKER_GRANTS);
    const routines = (await run.sql<{ g: string }>(ROUTINE_GRANTS, ['worker_access'])).map(r => r.g);
    expect(routines).toEqual(WORKER_ROUTINES);
  });

  it('each request-path definer is owned by mwf_definer and executable by exactly its callers’ capabilities', async () => {
    const rows = await run.sql<{ fn: string; owner: string; definer: boolean; grantees: string[] | null }>(
      `SELECT replace(p.oid::regprocedure::text, ', ', ',') AS fn, pg_get_userbyid(p.proowner)::text AS owner,
              p.prosecdef AS definer,
              (SELECT array_agg(pg_get_userbyid(a.grantee)::text ORDER BY pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a
               WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'`,
    );
    const got = Object.fromEntries(rows.map(r => [r.fn, r]));
    for (const [fn, grantees] of Object.entries(DEFINER_EXECUTE)) {
      expect({ fn, owner: got[fn]?.owner, definer: got[fn]?.definer, grantees: got[fn]?.grantees }).toEqual({
        fn,
        owner: 'mwf_definer',
        definer: true,
        grantees,
      });
    }
  });

  it('app.session_scope is required: the AI writes only into the session its transaction names', async () => {
    const { session, adaUser } = await adaAndBob(run);
    const [{ conv }] = await run.sql<{ conv: string }>(
      `SELECT id AS conv FROM conversation WHERE session_id = $1 AND user_id = $2 AND kind = 'MAIN'`,
      [session, adaUser],
    );
    const insert = `INSERT INTO message (conversation_id, session_id, role, kind, content)
                    VALUES ($1, $2, 'AI', 'CHAT', 'scoped line') RETURNING seq`;
    // No scope, and another session's scope: refused in the database (insufficient_privilege).
    await expect(run.as('mwf_ai', null, insert, [conv, session])).rejects.toMatchObject({ code: '42501' });
    await expect(
      run.as('mwf_ai', null, insert, [conv, session], '01a1e6a2-0000-7000-8000-000000000000'),
    ).rejects.toMatchObject({ code: '42501' });
    // The session's own scope: written.
    // The session's own scope, acting for a participant of it (work-k5fk.10.7): written.
    const rows = await run.as<{ seq: number }>('mwf_ai', adaUser, insert, [conv, session], session);
    expect(rows).toHaveLength(1);
    // An AI write never carries a participant's line, even in scope.
    await expect(
      run.as(
        'mwf_ai',
        null,
        `INSERT INTO message (conversation_id, session_id, sender_user_id, role, kind, content)
         VALUES ($1, $2, $3, 'USER', 'CHAT', 'not mine') RETURNING seq`,
        [conv, session, adaUser],
        session,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the definers’ AI and worker arms refuse an unset or different app.session_scope', async () => {
    const { session } = await adaAndBob(run);
    const [{ attempt }] = await run.sql<{ attempt: string }>(
      `SELECT id AS attempt FROM empathy_attempt WHERE session_id = $1 ORDER BY id LIMIT 1`,
      [session],
    );
    // mwf_ai without a scope cannot move an attempt (it is "not found" to it).
    await expect(
      run.as('mwf_ai', null, `SELECT app.empathy_set_status($1, 'READY', NULL)`, [attempt]),
    ).rejects.toMatchObject({ code: 'P0002' });
    // mwf_worker without a scope cannot move the session.
    await expect(
      run.as('mwf_worker', null, `SELECT app.session_set_status($1, 'ABANDONED')`, [session]),
    ).rejects.toMatchObject({ code: 'P0002' });
  });

  it('no function or trigger body names mwf_job', async () => {
    const rows = await run.sql<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.prosrc ~ 'mwf_job'`,
    );
    expect(rows).toEqual([]);
  });

  // work-k5fk.10.6 (§7 row 9c): row-level security, ENABLED and FORCED on every table.
  describe('row-level security (9c)', () => {
    const OTHER = '01a1e6a2-0000-7000-8000-00000000c9c9';

    it('the worker in the Stage 4 closure reads and changes only its scoped session’s proposals', async () => {
      const { session } = await adaAndBob(run);
      const [{ id }] = await run.sql<{ id: string }>(
        `INSERT INTO proposal (session_id, description) VALUES ($1, 'rls probe') RETURNING id::text`,
        [session],
      );
      const read = `SELECT id::text FROM proposal WHERE id = $1`;
      expect(await run.as('mwf_worker', null, read, [id], session)).toEqual([{ id }]);
      expect(await run.as('mwf_worker', null, read, [id], OTHER)).toEqual([]);
      expect(await run.as('mwf_worker', null, read, [id])).toEqual([]);
      // Outside its scope the row is not there to update: nothing changes (no error, as for a missing row).
      const convert = `UPDATE proposal SET status = 'CONVERTED_TO_AGREEMENT' WHERE id = $1 RETURNING id`;
      expect(await run.as('mwf_worker', null, convert, [id], OTHER)).toEqual([]);
      expect(await run.sql(`SELECT status::text FROM proposal WHERE id = $1`, [id])).toEqual([{ status: 'ACTIVE' }]);
      expect(await run.as('mwf_worker', null, convert, [id], session)).toEqual([{ id }]);
    });

    it('the AI cannot read or lock a session other than its scope', async () => {
      const { session, adaUser } = await adaAndBob(run);
      const read = `SELECT id::text FROM session WHERE id = $1`;
      // The AI acts for a participant of its scope (work-k5fk.10.7: app.scope_actor_is_member)…
      expect(await run.as('mwf_ai', adaUser, read, [session], session)).toEqual([{ id: session }]);
      expect(await run.as('mwf_ai', adaUser, read, [session], OTHER)).toEqual([]);
      expect(await run.as('mwf_ai', adaUser, `SELECT count(*)::int AS n FROM participant`, [], OTHER)).toEqual([
        { n: 0 },
      ]);
      // …and with no acting user, or one who is not a participant, it reads nothing even in its scope.
      expect(await run.as('mwf_ai', null, read, [session], session)).toEqual([]);
      expect(await run.as('mwf_ai', OTHER, read, [session], session)).toEqual([]);
    });

    it('the owner mwf_migrator reads and writes no row by default (FORCE; pgaudit, not RLS, is what holds it)', async () => {
      const [{ n }] = await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM message`);
      expect(n).toBeGreaterThan(0);
      expect(await run.as('mwf_migrator', null, `SELECT count(*)::int AS n FROM message`)).toEqual([{ n: 0 }]);
      expect(await run.as('mwf_migrator', null, `SELECT count(*)::int AS n FROM "user"`)).toEqual([{ n: 0 }]);
      expect(await run.as('mwf_migrator', null, `UPDATE session SET topic_frame = NULL RETURNING id`)).toEqual([]);
    });

    // work-k5fk.10.30 (owner decision: diagnostics, no content). The bot's login is NOLOGIN on a development
    // cluster, so the superuser takes its role for the statement.
    it('the operations bot reads statuses and counts of every session, and no content, name, email or key', async () => {
      const asBot = (text: string) =>
        withClient(
          run.fx.target,
          async c => {
            await c.query('SET ROLE slam_bot_readonly');
            return (await c.query(text)).rows;
          },
          run.fx.database,
        );
      const [all] = await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM message`);
      expect(await asBot(`SELECT count(*)::int AS n FROM message`)).toEqual([all]);
      expect((await asBot(`SELECT status::text, created_at FROM session`)).length).toBeGreaterThan(0);
      for (const denied of [
        `SELECT content FROM message`,
        `SELECT email FROM "user"`,
        `SELECT first_name FROM "user"`,
        `SELECT topic_frame FROM session`,
        `SELECT doc FROM ai_memory`,
        `SELECT push_token FROM user_device`,
        `SELECT subject FROM user_identity`,
        `SELECT wrapped_dek FROM user_key`,
        // Review 9c r2: no private state even as an enum, no relationship graph.
        `SELECT category FROM need`,
        `SELECT decision FROM proposal_choice`,
        `SELECT contact_user_id FROM user_contact`,
      ]) {
        await expect(asBot(denied)).rejects.toMatchObject({ code: '42501' });
      }
      await expect(asBot(`UPDATE session SET status = status`)).rejects.toMatchObject({ code: '42501' });
    });

    it('the ops dashboard reads every session (SELECT only)', async () => {
      const [all] = await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM session`);
      expect(await run.as('mwf_ops', null, `SELECT count(*)::int AS n FROM session`)).toEqual([all]);
      await expect(run.as('mwf_ops', null, `DELETE FROM brain_activity`)).rejects.toMatchObject({ code: '42501' });
    });
  });
});
