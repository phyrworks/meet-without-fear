/**
 * Review schema S5 and S6 (work-k5fk.33), on a CREATED clone, as the owner
 * (every writer is bound by both).
 *
 *   - S5: only a REMOVED proposal names who removed it —
 *     CHECK (removed_by_user_id IS NULL OR status = 'REMOVED'); before, the
 *     trigger let a non-REMOVED move carry a remover.
 *   - S6: the referential ON DELETE SET NULL of session.previous_session_id and
 *     reflection.linked_session_id no longer re-stamps updated_at (the
 *     follow-on session's retention clock, the reflection's order); any
 *     other update still stamps it.
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndInvitee, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('review schema S5 (remover CHECK) and S6 (SET NULL keeps updated_at)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndInvitee>>;
  const OLD = '2026-01-01T00:00:00.000Z';

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `k5fk33_s5s6_${process.pid}`);
    ids = await adaAndInvitee(run);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('S5: a proposal that is not REMOVED cannot name a remover', async () => {
    const insert = (status: string, removed: boolean) =>
      run.sql(
        `INSERT INTO proposal (session_id, created_by_user_id, status, description, removed_at, removed_by_user_id)
         VALUES ($1::uuid, $2::uuid, $3::text::proposal_status, 'PROBE', CASE WHEN $3::text = 'REMOVED' THEN now() END,
                 CASE WHEN $4::boolean THEN $2::uuid END) RETURNING id`,
        [ids.session, ids.adaUser, status, removed],
      );
    await expect(insert('ACTIVE', true)).rejects.toThrow(/violates check constraint/);
    const [{ id }] = await insert('REMOVED', true);
    // A restore that keeps the remover is refused the same way.
    await expect(
      run.sql(`UPDATE proposal SET status = 'ACTIVE', removed_at = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow(/violates check constraint/);
    await run.sql(`UPDATE proposal SET status = 'ACTIVE', removed_at = NULL, removed_by_user_id = NULL WHERE id = $1`, [
      id,
    ]);
  });

  it('S6: purging the earlier session nulls the links but leaves updated_at; any other update stamps it', async () => {
    const [{ id: earlier }] = await run.sql<{ id: string }>(
      `INSERT INTO session (status, archived_at) VALUES ('ARCHIVED', now()) RETURNING id`,
    );
    await run.sql(`INSERT INTO participant (session_id, user_id, kind) VALUES ($1, $2, 'human')`, [
      earlier,
      ids.adaUser,
    ]);
    const [{ id: later }] = await run.sql<{ id: string }>(
      `INSERT INTO session (status, previous_session_id) VALUES ('CREATED', $1) RETURNING id`,
      [earlier],
    );
    const [{ id: reflection }] = await run.sql<{ id: string }>(
      `INSERT INTO reflection (user_id, linked_session_id, linked_at) VALUES ($1, $2, now()) RETURNING id`,
      [ids.adaUser, earlier],
    );
    // updated_at is stamped by the trigger on any UPDATE: set the old instant with the trigger off.
    await run.sql(`ALTER TABLE session DISABLE TRIGGER touch_updated_at`);
    await run.sql(`UPDATE session SET updated_at = $2 WHERE id = $1`, [later, OLD]);
    await run.sql(`ALTER TABLE session ENABLE TRIGGER touch_updated_at`);
    await run.sql(`ALTER TABLE reflection DISABLE TRIGGER touch_updated_at`);
    await run.sql(`UPDATE reflection SET updated_at = $2 WHERE id = $1`, [reflection, OLD]);
    await run.sql(`ALTER TABLE reflection ENABLE TRIGGER touch_updated_at`);

    await run.sql(`DELETE FROM session WHERE id = $1`, [earlier]);
    const [s] = await run.sql<{ prev: string | null; updated_at: Date }>(
      `SELECT previous_session_id AS prev, updated_at FROM session WHERE id = $1`,
      [later],
    );
    expect(s).toEqual({ prev: null, updated_at: new Date(OLD) });
    const [r] = await run.sql<{ linked: string | null; linked_at: Date | null; updated_at: Date }>(
      `SELECT linked_session_id AS linked, linked_at, updated_at FROM reflection WHERE id = $1`,
      [reflection],
    );
    expect(r).toEqual({ linked: null, linked_at: null, updated_at: new Date(OLD) });

    // Any other update still stamps it.
    await run.sql(`UPDATE session SET topic_frame = 'PROBE' WHERE id = $1`, [later]);
    const [after] = await run.sql<{ updated_at: Date }>(`SELECT updated_at FROM session WHERE id = $1`, [later]);
    expect(after.updated_at.getTime()).toBeGreaterThan(new Date(OLD).getTime());
  });
});
