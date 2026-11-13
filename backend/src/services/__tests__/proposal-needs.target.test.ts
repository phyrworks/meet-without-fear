/**
 * work-k5fk.10.2 review round 1, L4: setProposalNeeds upserts proposal_need
 * with `update: {}` while mwf_app holds INSERT and DELETE on it but no UPDATE.
 * Called twice with the same need — the second call meets the existing row —
 * as mwf_app (identity bound), it must succeed and leave exactly one link:
 * Prisma must not compile the empty update to INSERT … ON CONFLICT DO UPDATE
 * (which needs UPDATE privilege even when nothing conflicts).
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */
import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('setProposalNeeds as mwf_app (proposal_need upsert with no UPDATE grant)', () => {
  let run: TargetRun;

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `pneeds_${process.pid}`);
  });
  afterAll(async () => {
    await run?.drop();
  });

  it('links a shared need twice without error and keeps one row', async () => {
    const [p] = await run.sql<{ proposal: string; need: string; user_id: string }>(
      `SELECT pr.id AS proposal, ns.need_id AS need, pa.user_id
       FROM proposal pr
       JOIN participant pa ON pa.id = pr.created_by_participant_id
       JOIN need_share ns ON ns.session_id = pr.session_id AND ns.revoked_at IS NULL
       ORDER BY pr.created_at, ns.need_id LIMIT 1`,
    );
    expect(p).toBeDefined();
    const { prisma } = await import('../../lib/prisma');
    const { runWithContext } = await import('../../lib/request-context');
    const { setProposalNeeds } = await import('../stage4-store');
    const asOwner = (fn: () => Promise<void>) =>
      runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId: p.user_id }, fn);

    await asOwner(() => setProposalNeeds(prisma, p.proposal, [p.need]));
    await asOwner(() => setProposalNeeds(prisma, p.proposal, [p.need]));

    const links = await run.sql<{ need_id: string }>(`SELECT need_id FROM proposal_need WHERE proposal_id = $1`, [
      p.proposal,
    ]);
    expect(links).toEqual([{ need_id: p.need }]);
    const [priv] = await run.sql<{ upd: boolean }>(
      `SELECT has_any_column_privilege('mwf_app', 'proposal_need', 'UPDATE') AS upd`,
    );
    expect(priv.upd).toBe(false);
  });
});
