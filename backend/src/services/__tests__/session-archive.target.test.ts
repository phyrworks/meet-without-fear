/**
 * work-k5fk.10.12, real roles on a clone of the CREATED target fixture:
 * archiving a session goes through app.session_archive(session) only.
 *
 *   - only a CURRENT participant of the session archives it (not a
 *     relationship member who never joined — the invitee with a live PENDING
 *     invitation, whom requireSessionAccess admits — nor a participant who
 *     left, nor an outsider);
 *   - only from an archivable state (CREATED, INVITED, RESOLVED, ABANDONED);
 *   - the archiver and the instant are recorded on the session
 *     (archived_by_participant_id, archived_at);
 *   - mwf_app cannot write session.status (or the archive columns) directly,
 *     and app.session_set_status no longer archives for it.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndInvitee, httpAs, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

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
  /** Ada and Carol; ABANDONED; Carol left. */
  const left = randomUuidV7();
  /** Ada and Dan; ACTIVE. */
  const active = randomUuidV7();

  /** The SQLSTATE a statement as mwf_app fails with, or 'ok'. */
  async function asApp(userId: string, text: string, params: unknown[] = []): Promise<string> {
    try {
      await run.as('mwf_app', userId, text, params);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
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
      `INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, 'Carol'), ($3, $4, 'Dan'), ($5, $6, 'Out')`,
      [carol.id, carol.email, dan.id, dan.email, outsider.id, outsider.email],
    );
    // Two more sessions of Ada's, each on its own relationship (one live session per relationship).
    for (const [session, other] of [
      [left, carol.id],
      [active, dan.id],
    ]) {
      const rel = randomUuidV7();
      await run.sql(`INSERT INTO relationship (id) VALUES ($1)`, [rel]);
      await run.sql(`INSERT INTO relationship_member (relationship_id, user_id) VALUES ($1, $2), ($1, $3)`, [
        rel,
        ada.id,
        other,
      ]);
      await run.sql(`INSERT INTO session (id, relationship_id, status) VALUES ($1, $2, 'INVITED')`, [session, rel]);
      await run.sql(`INSERT INTO participant (session_id, user_id, display_name) VALUES ($1, $2, 'Ada'), ($1, $3, 'Other')`, [
        session,
        ada.id,
        other,
      ]);
      await run.as('mwf_job', null, `SELECT app.session_set_status($1::uuid, 'ACTIVE')`, [session]);
    }
    await run.as('mwf_job', null, `SELECT app.session_set_status($1::uuid, 'ABANDONED')`, [left]);
    await run.sql(`UPDATE participant SET left_at = now() WHERE session_id = $1 AND user_id = $2`, [left, carol.id]);
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('setup: Bob is a relationship member of the CREATED session with a live invitation, not a participant', async () => {
    expect(await status(ids.session)).toBe('CREATED');
    expect(
      await run.sql(
        `SELECT (SELECT count(*)::int FROM relationship_member m JOIN session s ON s.relationship_id = m.relationship_id
                 WHERE s.id = $1 AND m.user_id = $2) AS member,
                (SELECT count(*)::int FROM participant WHERE session_id = $1 AND user_id = $2) AS participant,
                (SELECT count(*)::int FROM invitation WHERE session_id = $1 AND status = 'PENDING' AND expires_at > now()) AS live`,
        [ids.session, bob.id],
      ),
    ).toEqual([{ member: 1, participant: 0, live: 1 }]);
  });

  it('a relationship member who never joined cannot archive (404); the session stays CREATED', async () => {
    const r = await http(bob, 'post', `/sessions/${ids.session}/archive`);
    expect(r.status).toBe(404);
    expect(await status(ids.session)).toBe('CREATED');
    expect(await asApp(bob.id, `SELECT app.session_archive($1::uuid)`, [ids.session])).toBe('P0002');
  });

  it('an outsider cannot archive (refused by the function: not found)', async () => {
    expect(await asApp(outsider.id, `SELECT app.session_archive($1::uuid)`, [ids.session])).toBe('P0002');
    expect(await status(ids.session)).toBe('CREATED');
  });

  it('a participant who left cannot archive (403 over HTTP; insufficient_privilege from the function)', async () => {
    expect((await http(carol, 'post', `/sessions/${left}/archive`)).status).toBe(403);
    expect(await asApp(carol.id, `SELECT app.session_archive($1::uuid)`, [left])).toBe('42501');
    // nor through the general status writer
    expect(await asApp(carol.id, `SELECT app.session_set_status($1::uuid, 'ARCHIVED')`, [left])).not.toBe('ok');
    expect(await status(left)).toBe('ABANDONED');
  });

  it('an ACTIVE session is not archivable (400; check_violation from the function)', async () => {
    const r = await http(ada, 'post', `/sessions/${active}/archive`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(await asApp(ada.id, `SELECT app.session_archive($1::uuid)`, [active])).toBe('23514');
    expect(await status(active)).toBe('ACTIVE');
  });

  it('mwf_app cannot write session.status or the archive columns directly, nor archive through session_set_status', async () => {
    expect(await asApp(ada.id, `UPDATE session SET status = 'ARCHIVED' WHERE id = $1`, [left])).toBe('42501');
    expect(await asApp(ada.id, `UPDATE session SET archived_at = now() WHERE id = $1`, [left])).toBe('42501');
    expect(
      await asApp(ada.id, `UPDATE session SET archived_by_participant_id = NULL WHERE id = $1`, [left]),
    ).toBe('42501');
    expect(await asApp(ada.id, `SELECT app.session_set_status($1::uuid, 'ARCHIVED')`, [left])).toBe('42501');
    expect(await status(left)).toBe('ABANDONED');
  });

  it('a current participant archives (200): ARCHIVED, the archiver and the instant recorded', async () => {
    const r = await http(ada, 'post', `/sessions/${ids.session}/archive`);
    expect(r.status).toBe(200);
    expect(r.body.data.archived).toBe(true);
    const [row] = await run.sql<{ status: string; archived_by: string; archived_at: Date }>(
      `SELECT status::text AS status, archived_by_participant_id AS archived_by, archived_at FROM session WHERE id = $1`,
      [ids.session],
    );
    expect(row.status).toBe('ARCHIVED');
    expect(row.archived_by).toBe(ids.ada);
    expect(new Date(r.body.data.archivedAt).toISOString()).toBe(row.archived_at.toISOString());

    // the ABANDONED session by its remaining participant, through the function as mwf_app
    const [{ at }] = await run.as<{ at: Date }>('mwf_app', ada.id, `SELECT app.session_archive($1::uuid) AS at`, [left]);
    expect(
      await run.sql(
        `SELECT s.status::text AS status, p.user_id AS by, s.archived_at = $2::timestamptz AS same
         FROM session s JOIN participant p ON p.id = s.archived_by_participant_id WHERE s.id = $1`,
        [left, at],
      ),
    ).toEqual([{ status: 'ARCHIVED', by: ada.id, same: true }]);
  });

  it('an archived session is not archived again (400)', async () => {
    const r = await http(ada, 'post', `/sessions/${ids.session}/archive`);
    expect(r.status).toBe(400);
    expect(await asApp(ada.id, `SELECT app.session_archive($1::uuid)`, [ids.session])).toBe('23514');
  });
});
