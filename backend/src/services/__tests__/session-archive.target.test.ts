/**
 * work-k5fk.10.12, real roles on a clone of the CREATED target fixture:
 * archiving a session goes through app.session_archive(session) only.
 *
 *   - only a CURRENT participant of the session archives it (not an
 *     invitee who never joined — the one with a live PENDING
 *     invitation, whom requireSessionAccess admits — nor a participant who
 *     left, nor an outsider);
 *   - only from an archivable state (CREATED, INVITED, RESOLVED, ABANDONED);
 *   - the archiver and the instant are recorded on the session
 *     (archived_by_user_id, archived_at);
 *   - mwf_app cannot write session.status (or the archive columns) directly,
 *     and app.session_set_status no longer archives for it; a job login
 *     cannot call session_archive;
 *   - each refusal has its own SQLSTATE (MWA00 no identity, MWA01 not found,
 *     MWA02 left, MWA03 state); two concurrent archives serialize on the row.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { Client } from 'pg';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndInvitee, appUrlFor, httpAs, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Http = Awaited<ReturnType<typeof httpAs>>;

describeTarget('session archive on the target, as mwf_app', () => {
  let run: TargetRun;
  let http: Http;
  let ids: Awaited<ReturnType<typeof adaAndInvitee>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };
  const carol = { id: randomUuidV7(), email: `carol-arch-${process.pid}@e2e.test` };
  const dan = { id: randomUuidV7(), email: `dan-arch-${process.pid}@e2e.test` };
  const outsider = { id: randomUuidV7(), email: `out-arch-${process.pid}@e2e.test` };
  const erin = { id: randomUuidV7(), email: `erin-arch-${process.pid}@e2e.test` };
  /** Ada and Carol; ABANDONED; Carol left. */
  const left = randomUuidV7();
  /** Ada and Dan; ACTIVE. */
  const active = randomUuidV7();
  /** Ada and Erin; ABANDONED; both current (the concurrent archive). */
  const both = randomUuidV7();

  /** The SQLSTATE a statement as mwf_app fails with, or 'ok'. */
  async function asApp(userId: string, text: string, params: unknown[] = []): Promise<string> {
    try {
      await run.as('mwf_app', userId, text, params);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  }
  /** As asApp, but `<SQLSTATE> <message>`, for a refusal whose code alone is not specific (42501). */
  async function asAppMessage(userId: string | null, text: string, params: unknown[] = []): Promise<string> {
    try {
      await run.as('mwf_app', userId, text, params);
      return 'ok';
    } catch (e) {
      const { code, message } = e as { code?: string; message?: string };
      return `${code} ${message}`;
    }
  }
  const status = async (session: string) =>
    (await run.sql<{ status: string }>(`SELECT status::text AS status FROM session WHERE id = $1`, [session]))[0]
      .status;

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `arch_${process.pid}`);
    ids = await adaAndInvitee(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    await run.sql(
      `INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, 'Carol'), ($3, $4, 'Dan'), ($5, $6, 'Out'), ($7, $8, 'Erin')`,
      [carol.id, carol.email, dan.id, dan.email, outsider.id, outsider.email, erin.id, erin.email],
    );
    // Three more sessions of Ada's, each with another person (one live session per pair: live_session_pair).
    for (const [session, other] of [
      [left, carol.id],
      [active, dan.id],
      [both, erin.id],
    ]) {
      await run.sql(`INSERT INTO session (id, status) VALUES ($1, 'INVITED')`, [session]);
      await run.sql(`INSERT INTO participant (session_id, user_id, display_name) VALUES ($1, $2, 'Ada')`, [
        session,
        ada.id,
      ]);
      await run.sql(
        `INSERT INTO participant (session_id, user_id, added_by_user_id, display_name) VALUES ($1, $2, $3, 'Other')`,
        [session, other, ada.id],
      );
      await run.sql(`UPDATE session SET status = 'ACTIVE' WHERE id = $1::uuid`, [session]);
    }
    await run.as('mwf_worker', null, `SELECT app.session_set_status($1::uuid, 'ABANDONED')`, [left], left);
    await run.as('mwf_worker', null, `SELECT app.session_set_status($1::uuid, 'ABANDONED')`, [both], both);
    await run.sql(`UPDATE participant SET left_at = now() WHERE session_id = $1 AND user_id = $2`, [left, carol.id]);
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('setup: Bob is the invitee of the CREATED session with a live invitation, not a participant', async () => {
    expect(await status(ids.session)).toBe('CREATED');
    expect(
      await run.sql(
        `SELECT (SELECT count(*)::int FROM participant WHERE session_id = $1 AND user_id = $2) AS participant,
                (SELECT count(*)::int FROM invitation WHERE session_id = $1 AND status = 'PENDING' AND expires_at > now()) AS live`,
        [ids.session, bob.id],
      ),
    ).toEqual([{ participant: 0, live: 1 }]);
  });

  it('an invitee who never joined cannot archive (404); the session stays CREATED', async () => {
    const r = await http(bob, 'post', `/sessions/${ids.session}/archive`);
    expect(r.status).toBe(404);
    expect(await status(ids.session)).toBe('CREATED');
    expect(await asApp(bob.id, `SELECT app.session_archive($1::uuid)`, [ids.session])).toBe('MWA01');
  });

  it('an outsider cannot archive (MWA01); no identity is its own code (MWA00)', async () => {
    expect(await asApp(outsider.id, `SELECT app.session_archive($1::uuid)`, [ids.session])).toBe('MWA01');
    expect(await asAppMessage(null, `SELECT app.session_archive($1::uuid)`, [ids.session])).toBe(
      'MWA00 session_archive: no identity bound',
    );
    expect(await status(ids.session)).toBe('CREATED');
  });

  it('a worker or AI login cannot archive for a user, even a current participant (EXECUTE is app_access only)', async () => {
    let got = 'ok';
    try {
      await run.as('mwf_worker', ada.id, `SELECT app.session_archive($1::uuid)`, [ids.session], ids.session);
    } catch (e) {
      const { code, message } = e as { code?: string; message?: string };
      got = `${code} ${message}`;
    }
    // work-k5fk.10.5: mwf_job is retired; neither its successors holds EXECUTE (the function's own
    // app_access refusal stays as a second wall, for mwf_migrator).
    expect(got).toBe('42501 permission denied for function session_archive');
    expect(await status(ids.session)).toBe('CREATED');
  });

  it('a participant who left cannot archive (MWA02 from the function; 403 over HTTP)', async () => {
    // HTTP: requireSessionAccess answers the leaver first (403), so the function-level
    // assertion below is the one that tests session_archive's own leaver arm.
    expect((await http(carol, 'post', `/sessions/${left}/archive`)).status).toBe(403);
    expect(await asAppMessage(carol.id, `SELECT app.session_archive($1::uuid)`, [left])).toBe(
      'MWA02 a participant who left cannot archive the session',
    );
    // nor through the general status writer: a leaver is no member there (not found)
    expect(await asAppMessage(carol.id, `SELECT app.session_set_status($1::uuid, 'ARCHIVED')`, [left])).toBe(
      'P0002 session not found',
    );
    expect(await status(left)).toBe('ABANDONED');
  });

  it('an ACTIVE session is not archivable (400; MWA03 from the function)', async () => {
    const r = await http(ada, 'post', `/sessions/${active}/archive`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(await asApp(ada.id, `SELECT app.session_archive($1::uuid)`, [active])).toBe('MWA03');
    expect(await status(active)).toBe('ACTIVE');
  });

  it('mwf_app cannot write session.status or the archive columns directly, nor archive through session_set_status', async () => {
    expect(await asApp(ada.id, `UPDATE session SET status = 'ARCHIVED' WHERE id = $1`, [left])).toBe('42501');
    expect(await asApp(ada.id, `UPDATE session SET archived_at = now() WHERE id = $1`, [left])).toBe('42501');
    expect(await asApp(ada.id, `UPDATE session SET archived_by_user_id = NULL WHERE id = $1`, [left])).toBe('42501');
    expect(await asAppMessage(ada.id, `SELECT app.session_set_status($1::uuid, 'ARCHIVED')`, [left])).toBe(
      '42501 only a worker archives through session_set_status; a participant uses app.session_archive',
    );
    expect(await status(left)).toBe('ABANDONED');
  });

  it('a current participant archives (200): ARCHIVED, the archiver and the instant recorded', async () => {
    const r = await http(ada, 'post', `/sessions/${ids.session}/archive`);
    expect(r.status).toBe(200);
    expect(r.body.data.archived).toBe(true);
    const [row] = await run.sql<{ status: string; archived_by: string; archived_at: Date }>(
      `SELECT status::text AS status, archived_by_user_id AS archived_by, archived_at FROM session WHERE id = $1`,
      [ids.session],
    );
    expect(row.status).toBe('ARCHIVED');
    expect(row.archived_by).toBe(ada.id);
    expect(new Date(r.body.data.archivedAt).toISOString()).toBe(row.archived_at.toISOString());

    // work-k5fk.10.15: archiving the CREATED session withdrew its PENDING invitation (EXPIRED), so Bob's link
    // no longer claims or accepts: the accept answers as expired (410), not with a database error.
    expect(
      await run.sql(`SELECT status::text AS status FROM invitation WHERE session_id = $1`, [ids.session]),
    ).toEqual([{ status: 'EXPIRED' }]);
    const accept = await http(bob, 'post', `/invitations/${ids.invitation}/accept`);
    expect(accept.status).toBe(410);
    expect(accept.body.error.code).toBe('EXPIRED');

    // the ABANDONED session by its remaining participant, through the function as mwf_app
    const [{ at }] = await run.as<{ at: Date }>('mwf_app', ada.id, `SELECT app.session_archive($1::uuid) AS at`, [
      left,
    ]);
    expect(
      await run.sql(
        `SELECT s.status::text AS status, s.archived_by_user_id AS by, s.archived_at = $2::timestamptz AS same
         FROM session s WHERE s.id = $1`,
        [left, at],
      ),
    ).toEqual([{ status: 'ARCHIVED', by: ada.id, same: true }]);
  });

  it('an archived session is not archived again (400)', async () => {
    const r = await http(ada, 'post', `/sessions/${ids.session}/archive`);
    expect(r.status).toBe(400);
    expect(await asApp(ada.id, `SELECT app.session_archive($1::uuid)`, [ids.session])).toBe('MWA03');
  });

  it('two concurrent archives: the second waits on the row lock, then is refused (MWA03); the first archiver is kept', async () => {
    const url = appUrlFor(run.fx.target, run.fx.database);
    const first = new Client({ connectionString: url });
    const second = new Client({ connectionString: url });
    await first.connect();
    await second.connect();
    try {
      await first.query('BEGIN');
      await first.query("SELECT set_config('app.current_user_id', $1, true)", [erin.id]);
      await first.query('SELECT app.session_archive($1::uuid)', [both]);
      await second.query('BEGIN');
      await second.query("SELECT set_config('app.current_user_id', $1, true)", [ada.id]);
      const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const blocked = second.query('SELECT app.session_archive($1::uuid)', [both]).then(
        () => 'ok',
        (e: { code?: string }) => e.code ?? String(e),
      );
      // the second archive is waiting on the first one's row lock
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [r] = await run.sql<{ w: string | null }>(
          `SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1`,
          [pid],
        );
        waiting = r?.w === 'Lock';
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      await first.query('COMMIT');
      expect(await blocked).toBe('MWA03');
      await second.query('ROLLBACK');
    } finally {
      await first.end();
      await second.end();
    }
    expect(
      await run.sql(`SELECT status::text AS status, archived_by_user_id AS by FROM session WHERE id = $1`, [both]),
    ).toEqual([{ status: 'ARCHIVED', by: erin.id }]);
  });
});
