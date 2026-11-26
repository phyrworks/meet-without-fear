/**
 * Review B1 leftover (work-k5fk.34): in the legacy agreement flow the agreement forms once every party has proposed
 * or confirmed it (public acts, proposal_revision) AND is WILLING on it. A party who proposed it and then privately
 * moved off WILLING (a Stage 4 selection, unshared) made the partner's confirm end in an agreement that never forms —
 * with both shown as agreed — telling the partner the unshared stance. A stance made public as a legacy agreement is
 * therefore not withdrawn privately: the selection is refused (409) and the agreement forms on the partner's confirm.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('a legacy-agreed stance is not withdrawn privately (work-k5fk.34)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  const ada = { id: '', email: 'ada@e2e.test' };
  const bob = { id: '', email: 'bob@e2e.test' };

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `b3_legacy_${process.pid}`);
    ids = await adaAndBob(run);
    ada.id = ids.adaUser;
    bob.id = ids.bobUser;
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('Bob proposes it as an agreement; his private NOT_WILLING is refused; Ada’s confirm forms the agreement', async () => {
    const [p] = await run.sql<{ id: string; description: string }>(
      `SELECT id::text, description FROM proposal WHERE session_id = $1 AND kind = 'SHARED_PROPOSAL' AND status = 'ACTIVE'
       ORDER BY created_at, id LIMIT 1`,
      [ids.session],
    );
    const proposed = await http(bob, 'post', `/sessions/${ids.session}/agreements`, {
      strategyId: p.id,
      description: p.description,
      type: 'MICRO_EXPERIMENT',
    });
    expect(proposed.status).toBe(201);

    const flip = await http(bob, 'post', `/sessions/${ids.session}/stage4/selections`, {
      selections: [{ proposalId: p.id, decision: 'NOT_WILLING' }],
    });
    expect(flip.status).toBe(409);
    expect(flip.body.error.code).toBe('CONFLICT');
    expect(
      await run.sql(`SELECT decision::text AS decision FROM proposal_choice WHERE proposal_id = $1 AND user_id = $2`, [
        p.id,
        bob.id,
      ]),
    ).toEqual([{ decision: 'WILLING' }]);

    const confirmed = await http(ada, 'post', `/sessions/${ids.session}/agreements/${p.id}/confirm`, { confirmed: true });
    expect(confirmed.status).toBe(200);
    expect(await run.sql(`SELECT count(*)::int AS n FROM agreement WHERE proposal_id = $1`, [p.id])).toEqual([{ n: 1 }]);
  });
});
