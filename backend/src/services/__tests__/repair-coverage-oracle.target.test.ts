/**
 * TS-11 fix round 2 — no coverage side channel, over HTTP on real roles
 * (mwf_app request path, identity binding on).
 *
 * `v_need_coverage` spans every choice on the app connection (no RLS until
 * TS-16). The Stage 4 share gate and the AI prompt's open-needs list must
 * compute coverage from the choices the participant may see (their own, and
 * the partner's once the partner has reached choices_shared). Otherwise a
 * partner's UNSHARED WILLING changes the gate's outcome or the prompt's list,
 * and the participant can infer the hidden choice (the closure-oracle class,
 * review I3).
 *
 * Fixture STAGE4_REDESIGN_INVENTORY (no choices yet). Bob's "Understanding"
 * is covered only by "pause". Ada takes NOT_WILLING on both shared proposals
 * and sets aside every other shared need, so "Understanding" alone decides
 * the gate. Then Bob records an unshared WILLING on "pause". The gate result
 * and the prompt's open needs must be the same before and after.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget(
  'Stage 4 coverage side channel (fix round 2): gate and prompt ignore an unshared partner WILLING',
  () => {
    let run: TargetRun;
    let ids: Awaited<ReturnType<typeof adaAndBob>>;
    let http: Awaited<ReturnType<typeof httpAs>>;
    const ada = () => ({ id: ids.adaUser, email: 'ada@e2e.test' });
    const bob = () => ({ id: ids.bobUser, email: 'bob@e2e.test' });

    beforeAll(async () => {
      run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `repair_cov_${process.pid}`);
      ids = await adaAndBob(run);
      http = await httpAs();
    });
    afterAll(async () => {
      if (run) await run.drop();
    });

    it('the share gate and the open-needs prompt list are unchanged by Bob’s unshared WILLING', async () => {
      const sid = ids.session;
      const proposals = await run.sql<{ id: string; description: string }>(
        `SELECT id, description FROM proposal WHERE kind = 'SHARED_PROPOSAL' AND status = 'ACTIVE'`,
      );
      const pause = proposals.find(p => p.description.startsWith('Use a pause'))!;
      const needs = await run.sql<{ id: string; label: string; shared_text: string }>(
        `SELECT n.id, n.label, s.shared_text FROM need n JOIN need_share s ON s.need_id = n.id`,
      );
      const understanding = needs.find(n => n.label === 'Understanding')!;

      // Ada: a stance on every shared proposal (none WILLING), every other shared need set aside.
      for (const p of proposals) {
        expect(
          (
            await http(ada(), 'post', `/sessions/${sid}/stage4/proposals/${p.id}/selection`, {
              decision: 'NOT_WILLING',
            })
          ).status,
        ).toBe(200);
      }
      for (const n of needs.filter(x => x.id !== understanding.id)) {
        expect((await http(ada(), 'post', `/sessions/${sid}/stage4/needs/${n.id}/decline`, {})).status).toBe(200);
      }

      const { getStage4OpenNeedsForPrompt } = await import('../stream-turn-context');
      const observe = async () => {
        const gate = await http(ada(), 'post', `/sessions/${sid}/stage4/share-selections`, {});
        return {
          status: gate.status,
          error: gate.body?.error?.message ?? null,
          prompt: await getStage4OpenNeedsForPrompt(sid, ids.adaUser),
        };
      };

      const before = await observe();
      // "Understanding" is open for Ada: the gate refuses, the prompt lists it (by Bob's shared text).
      expect(before.status).toBe(400);
      expect(before.error).toBe('Address or set aside every open need before sharing');
      expect(before.prompt).toEqual([{ needLabel: understanding.shared_text }]);
      // Nothing shared: the refusal wrote no choices_shared.
      expect(await run.sql(`SELECT 1 FROM participant_milestone WHERE milestone_key = 'choices_shared'`)).toEqual([]);

      // Bob records WILLING on "pause" — unshared (no choices_shared for Bob).
      expect(
        (await http(bob(), 'post', `/sessions/${sid}/stage4/proposals/${pause.id}/selection`, { decision: 'WILLING' }))
          .status,
      ).toBe(200);
      expect(await run.sql(`SELECT 1 FROM participant_milestone WHERE milestone_key = 'choices_shared'`)).toEqual([]);

      const after = await observe();
      expect(after).toEqual(before);
    });
  },
);
