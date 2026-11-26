/**
 * Final review B3 (work-k5fk.34), Stage 4 over HTTP as mwf_app on STAGE4_REDESIGN_INVENTORY:
 *   - services#1: "Suggest ideas" creates the AI's drafts as the caller's SHARED_PROPOSALs (the proposal app_insert
 *     policy creates a proposal for its caller only), labelled "AI" by their source;
 *   - services#5: "Leave for now" and the walkthrough's covered / skipped state are separate facts, so neither
 *     overwrites the other;
 *   - services#4/#5: the close is one transaction with every present human's `closed`, and two closes at once
 *     answer 200 and 409 — never 500.
 *
 * One run (one fixture database) per file: the app's Prisma client is bound to the first run database it sees.
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('Stage 4 review B3 (work-k5fk.34)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `b3_s4_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const stage4 = async (who: { id: string; email: string }) => {
    const res = await http(who, 'get', `/sessions/${ids.session}/stage4`);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  it('services#1: suggestions are the caller’s SHARED_PROPOSALs, seen by both and labelled AI', async () => {
    const [need] = (await stage4(ada)).walkthrough.ownNeeds as Array<{ id: string }>;
    const res = await http(ada, 'post', `/sessions/${ids.session}/stage4/proposals/suggest`, {
      needId: need.id,
      count: 2,
    });
    expect(res.status).toBe(200);
    const suggested = res.body.data.suggestions as Array<{ id: string }>;
    expect(suggested).toHaveLength(2);
    const rows = await run.sql<{ creator: string; source: string; kind: string; links: number }>(
      `SELECT created_by_user_id::text AS creator, source::text AS source, kind::text AS kind,
              (SELECT count(*)::int FROM proposal_need pn WHERE pn.proposal_id = p.id AND pn.need_id = $2) AS links
       FROM proposal p WHERE id = ANY($1::uuid[])`,
      [suggested.map(s => s.id), need.id],
    );
    expect(rows).toEqual(
      suggested.map(() => ({ creator: ada.id, source: 'AI_SUGGESTED', kind: 'SHARED_PROPOSAL', links: 1 })),
    );
    for (const who of [ada, bob]) {
      const cards = (await stage4(who)).inventory.sharedProposals as Array<{ id: string; sourceLabel: string }>;
      for (const s of suggested) expect(cards.find(c => c.id === s.id)).toMatchObject({ sourceLabel: 'AI' });
    }
  });

  it('services#5: leave-for-now and the walkthrough’s covered / skipped never overwrite each other', async () => {
    const view = await stage4(ada);
    const need = (view.walkthrough.partnerNeeds as Array<{ id: string }>)[0];
    const walk = (action: string) =>
      http(ada, 'post', `/sessions/${ids.session}/stage4/walkthrough/needs/${need.id}`, { action });
    const declinedIds = async () => {
      const audit = (await stage4(ada)).coverageAudit;
      return [...audit.covered, ...audit.partial, ...audit.open]
        .filter((n: { userDeclinedToAddress?: boolean }) => n.userDeclinedToAddress)
        .map((n: { id: string }) => n.id);
    };
    const skippedIds = async () =>
      (await run.sql<{ need_id: string }>(
        `SELECT need_id::text FROM need_disposition WHERE session_id = $1 AND user_id = $2 AND status = 'SKIPPED'`,
        [ids.session, ada.id],
      )).map(r => r.need_id);

    // Skip, then set aside: still skipped, and set aside
    expect((await walk('skip')).status).toBe(200);
    expect((await http(ada, 'post', `/sessions/${ids.session}/stage4/needs/${need.id}/decline`)).status).toBe(200);
    expect(await skippedIds()).toContain(need.id);
    expect(await declinedIds()).toContain(need.id);

    // Set aside, then "this need feels covered": still set aside
    expect((await walk('covered')).status).toBe(200);
    expect(await declinedIds()).toContain(need.id);
    expect(
      await run.sql(
        `SELECT status::text AS status FROM need_disposition WHERE session_id = $1 AND user_id = $2 AND need_id = $3`,
        [ids.session, ada.id, need.id],
      ),
    ).toEqual([{ status: 'COVERED' }]);

    // Bring it back after covering it: no longer set aside, still covered
    expect((await http(ada, 'delete', `/sessions/${ids.session}/stage4/needs/${need.id}/decline`)).status).toBe(200);
    expect(await declinedIds()).not.toContain(need.id);
    expect(
      await run.sql(
        `SELECT status::text AS status FROM need_disposition WHERE session_id = $1 AND user_id = $2 AND need_id = $3`,
        [ids.session, ada.id, need.id],
      ),
    ).toEqual([{ status: 'COVERED' }]);
  });

  it('services#4/#5: two closes at once answer 200 and 409; the closure and both `closed` are one write', async () => {
    const close = () => http(ada, 'post', `/sessions/${ids.session}/stage4/close`, {});
    const closeBob = () => http(bob, 'post', `/sessions/${ids.session}/stage4/close`, {});
    const results = await Promise.all([close(), closeBob()]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)!.body.error.code).toBe('CONFLICT');
    expect(await run.sql(`SELECT count(*)::int AS n FROM session_closure WHERE session_id = $1`, [ids.session])).toEqual(
      [{ n: 1 }],
    );
    expect(
      await run.sql(
        `SELECT user_id::text AS u FROM participant_milestone WHERE session_id = $1 AND milestone_key = 'closed' ORDER BY 1`,
        [ids.session],
      ),
    ).toEqual([ada.id, bob.id].sort().map(u => ({ u })));
    // A later close is the same answer, not a 400
    const again = await close();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });
});
