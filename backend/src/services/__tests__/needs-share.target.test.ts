/**
 * TS-11, real roles on a clone of the NEEDS_CONFIRMED target fixture: the
 * Stage 3 share path (spec §1.4 need_share, §7).
 *
 *   - the owner's GRANTED consent (app, mwf_app) then `app.need_share` (job,
 *     mwf_job) — mwf_app cannot call the writer, and the writer refuses a
 *     need without its owner's GRANTED consent;
 *   - the partner's read of v_need_shared (mwf_app, identity bound) carries
 *     the shared text and category, never the need's label or evidence;
 *   - once both have shared, needs_shared is reached for the whole session;
 *   - revocation: the share's revoked_at and the consent's REVOKED in one
 *     transaction, and the partner's read is empty afterwards.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build NEEDS_CONFIRMED
 */

import { NEEDS_CONFIRMED_TEXT } from '../../testing/fixture-scenarios/scenarios';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('the Stage 3 share path, as mwf_app and mwf_job with identity binding on', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let share: typeof import('../needs-share');
  let ctx: typeof import('../../lib/request-context');
  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId }, async () => await fn());
  const needsOf = (participant: string) =>
    run.sql<{ id: string; label: string; category: string; evidence: string[] }>(
      `SELECT id, label, category::text AS category, evidence FROM need WHERE participant_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
      [participant],
    );
  const privateTextOf = (who: 'ada' | 'bob') => NEEDS_CONFIRMED_TEXT[who].flatMap(n => [n.need, ...(n.evidence ?? [])]);

  beforeAll(async () => {
    run = await openTargetRun('NEEDS_CONFIRMED', `needs_share_${process.pid}`);
    ids = await adaAndBob(run);
    share = await import('../needs-share');
    ctx = await import('../../lib/request-context');
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  // Fix round 1 (Important 6): a deleted need's label and evidence go to its
  // owner only — never on the session channel the partner's device listens to.
  it('deleting a need publishes nothing on the session channel; the owner gets a content-free nudge', async () => {
    const realtime = await import('../realtime');
    const sessionSpy = jest.spyOn(realtime, 'publishSessionEvent');
    const userSpy = jest.spyOn(realtime, 'publishUserEvent');
    const http = await httpAs();
    const [extra] = await run.sql<{ id: string }>(
      `INSERT INTO need (participant_id, label, category, ai_confidence, evidence) VALUES ($1, 'PROBE_DELETED_LABEL', 'SAFETY', 0.9, ARRAY['PROBE_DELETED_EVIDENCE']) RETURNING id`,
      [ids.ada],
    );
    const res = await http(
      { id: ids.adaUser, email: 'ada@e2e.test' },
      'delete',
      `/sessions/${ids.session}/needs/${extra.id}`,
    );
    expect(res.status).toBe(200);
    expect(sessionSpy.mock.calls.filter(c => c[1] === 'need.deleted')).toEqual([]);
    const toOwner = userSpy.mock.calls.filter(c => (c[2] as { kind?: string }).kind === 'need.deleted');
    expect(toOwner.map(c => c[0])).toEqual([ids.adaUser]);
    expect(JSON.stringify(toOwner)).not.toContain('PROBE_DELETED');
    sessionSpy.mockRestore();
    userSpy.mockRestore();
  });

  it('mwf_app cannot call the need_share writer at all', async () => {
    const [need] = await needsOf(ids.bob);
    await expect(run.as('mwf_app', ids.bobUser, `SELECT app.need_share($1::uuid, 'x')`, [need.id])).rejects.toThrow(
      /permission denied for function need_share/,
    );
  });

  it('app.need_share (as mwf_job) refuses a need without its owner’s GRANTED consent', async () => {
    const [need] = await needsOf(ids.ada);
    await expect(run.as('mwf_job', null, `SELECT app.need_share($1::uuid, 'x')`, [need.id])).rejects.toThrow(
      /need has no GRANTED consent by its owner/,
    );
    expect(await run.sql(`SELECT * FROM need_share WHERE need_id = $1`, [need.id])).toEqual([]);
  });

  it('Bob shares: GRANTED consents (app) then need_share rows (job) with transformed text, never the label', async () => {
    const needs = await needsOf(ids.bob);
    const result = await asUser(ids.bobUser, () =>
      share.shareNeeds({
        sessionId: ids.session,
        participantId: ids.bob,
        needs: needs.map(n => ({ id: n.id, label: n.label, category: n.category as never, evidence: n.evidence })),
      }),
    );
    expect(result).toMatchObject({ allShared: false, completedNow: false });

    const consents = await run.sql<{ need_id: string; decision: string; decided: boolean; target_kind: string }>(
      `SELECT need_id, decision::text AS decision, decided_at IS NOT NULL AS decided, target_kind::text AS target_kind
       FROM consent WHERE participant_id = $1 ORDER BY need_id`,
      [ids.bob],
    );
    expect(consents).toEqual(
      needs
        .map(n => ({ need_id: n.id, decision: 'GRANTED', decided: true, target_kind: 'NEED' }))
        .sort((a, b) => (a.need_id < b.need_id ? -1 : 1)),
    );
    const shares = await run.sql<{
      need_id: string;
      participant_id: string;
      session_id: string;
      shared_text: string;
      category: string;
    }>(
      `SELECT need_id, participant_id, session_id, shared_text, category::text AS category FROM need_share ORDER BY need_id`,
    );
    expect(shares.map(s => s.need_id).sort()).toEqual(needs.map(n => n.id).sort());
    for (const s of shares) {
      const need = needs.find(n => n.id === s.need_id)!;
      expect(s).toMatchObject({ participant_id: ids.bob, session_id: ids.session, category: need.category });
      expect(s.shared_text.length).toBeGreaterThan(0);
      for (const probe of privateTextOf('bob')) expect(s.shared_text.toLowerCase()).not.toContain(probe.toLowerCase());
    }
    // Bob's own milestone is not written yet: needs_shared is session-scoped.
    expect(await run.sql(`SELECT 1 FROM participant_milestone WHERE milestone_key = 'needs_shared'`)).toEqual([]);
  });

  it("Ada's read of v_need_shared (mwf_app, her identity) carries the shared text and category only", async () => {
    const rows = await run.as<Record<string, unknown>>(
      'mwf_app',
      ids.adaUser,
      `SELECT * FROM v_need_shared WHERE participant_id = $1 ORDER BY need_id`,
      [ids.bob],
    );
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['category', 'need_id', 'participant_id', 'session_id', 'shared_at', 'shared_text'].sort(),
    );
    const text = JSON.stringify(rows);
    for (const probe of privateTextOf('bob')) expect(text).not.toContain(probe);
    // The service read is the same view.
    const viaService = await asUser(ids.adaUser, () => share.listSharedNeeds(ids.session));
    expect(viaService.map(n => n.sharedText).sort()).toEqual(rows.map(r => String(r.shared_text)).sort());
  });

  it('when Ada shares too, needs_shared (and needs_validated) is reached by both — the session is ready', async () => {
    const needs = await needsOf(ids.ada);
    const result = await asUser(ids.adaUser, () =>
      share.shareNeeds({
        sessionId: ids.session,
        participantId: ids.ada,
        needs: needs.map(n => ({ id: n.id, label: n.label, category: n.category as never, evidence: n.evidence })),
      }),
    );
    expect(result).toMatchObject({ allShared: true, completedNow: true });
    const reached = await run.sql<{ participant_id: string; milestone_key: string }>(
      `SELECT participant_id, milestone_key FROM participant_milestone
       WHERE milestone_key IN ('needs_shared', 'needs_validated') ORDER BY participant_id, milestone_key`,
    );
    expect(reached).toHaveLength(4);
    expect(await run.sql(`SELECT all_reached FROM v_session_readiness WHERE milestone_key = 'needs_shared'`)).toEqual([
      { all_reached: true },
    ]);
  });

  it('revocation: need_share.revoked_at and the consent REVOKED in one transaction; the partner read is empty after', async () => {
    const [need] = await needsOf(ids.bob);
    await asUser(ids.bobUser, () => share.revokeNeedShare(need.id));
    const [s] = await run.sql<{ revoked_at: Date }>(`SELECT revoked_at FROM need_share WHERE need_id = $1`, [need.id]);
    const [c] = await run.sql<{ decision: string; revoked_at: Date }>(
      `SELECT decision::text AS decision, revoked_at FROM consent WHERE need_id = $1`,
      [need.id],
    );
    expect(s.revoked_at).toBeInstanceOf(Date);
    expect(c.decision).toBe('REVOKED');
    // now() is the transaction's instant: equal stamps = one transaction.
    expect(c.revoked_at.getTime()).toBe(s.revoked_at.getTime());
    const adaRead = await run.as('mwf_app', ids.adaUser, `SELECT need_id FROM v_need_shared WHERE need_id = $1`, [
      need.id,
    ]);
    expect(adaRead).toEqual([]);
  });

  it('a need of someone else cannot be revoked by the caller (identity-bound owner check)', async () => {
    const [need] = await needsOf(ids.ada);
    await expect(run.as('mwf_app', ids.bobUser, `SELECT app.need_revoke_share($1::uuid)`, [need.id])).rejects.toThrow(
      /need not found/,
    );
  });
});
