/**
 * TS-12, real roles on a clone of the STAGE4_REDESIGN_SHARED_SELECTIONS target
 * fixture (live proposals with both parties' choices): a PROPOSAL_REFINEMENT
 * sub-chat over HTTP as mwf_app — a SUBCHAT conversation of the caller with
 * anchor_proposal_id.
 *   - open is idempotent per anchor (no duplicate sub-chat);
 *   - the prompt carries the caller's main-chat history and the anchor;
 *   - resolve updates the proposal IN PLACE (same id, choices preserved) with a
 *     SUBCHAT_REFINED revision by the caller, and is idempotent once resolved;
 *   - the partner can neither read nor resolve it.
 *
 * Replaces the Prisma-mock suite services/__tests__/stage4-subchat.service.test.ts
 * together with repair-privacy.target.test.ts (the NEEDS_BRAINSTORM sub-chat:
 * anchor at open, turn, prompt, resolve creating linked proposals).
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_SHARED_SELECTIONS
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('a PROPOSAL_REFINEMENT sub-chat on the target (mwf_app)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };
  let proposalId = '';
  let subId = '';

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_SHARED_SELECTIONS', `ts12_subchat_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
    [{ id: proposalId }] = await run.sql<{ id: string }>(
      `SELECT id FROM proposal WHERE description LIKE 'Use a pause phrase%'`,
    );
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const choices = () =>
    run.sql(`SELECT user_id, decision::text AS decision FROM proposal_choice WHERE proposal_id = $1 ORDER BY user_id`, [
      proposalId,
    ]);

  it('open is idempotent per anchor; the conversation is Ada’s SUBCHAT anchored to the proposal', async () => {
    const open = () =>
      http(ada, 'post', `/sessions/${ids.session}/stage4/subchat`, {
        anchorKind: 'PROPOSAL_REFINEMENT',
        anchorId: proposalId,
      });
    const first = await open();
    expect(first.status).toBe(200);
    subId = first.body.data.subChat.id;
    expect(first.body.data.subChat.anchorId).toBe(proposalId);
    expect((await open()).body.data.subChat.id).toBe(subId);
    expect(
      await run.sql(
        `SELECT session_id, user_id, kind::text AS kind, anchor_proposal_id FROM conversation WHERE kind = 'SUBCHAT'`,
      ),
    ).toEqual([{ session_id: ids.session, user_id: ids.adaUser, kind: 'SUBCHAT', anchor_proposal_id: proposalId }]);
  });

  it('the prompt carries Ada’s main-chat history and the anchored proposal', async () => {
    const [main] = await run.sql<{ id: string }>(
      `SELECT id FROM conversation WHERE session_id = $1 AND user_id = $2 AND kind = 'MAIN'`,
      [ids.session, ids.adaUser],
    );
    await run.sql(
      `INSERT INTO message (conversation_id, session_id, sender_user_id, role, content) VALUES ($1::uuid, $2::uuid, $3::uuid, 'USER', 'PROBE_TS12_MAIN_HISTORY')`,
      [main.id, ids.session, ids.adaUser],
    );
    const { buildSystemPrompt, loadAnchorContext } = await import('../stage4-subchat.service');
    const { runWithContext } = await import('../../lib/request-context');
    const prompt = await runWithContext(
      { turnId: 't', requestId: 'r', startTime: Date.now(), userId: ids.adaUser },
      async () =>
        buildSystemPrompt({
          sessionId: ids.session,
          userId: ids.adaUser,
          anchorId: proposalId,
          anchor: await loadAnchorContext(ids.session, 'PROPOSAL_REFINEMENT' as never, proposalId, ids.ada),
        }),
    );
    expect(prompt.systemPrompt).toContain('PROBE_TS12_MAIN_HISTORY');
    expect(prompt.systemPrompt).toContain('Use a pause phrase when either person starts to shut down');
  });

  it('the partner can neither read nor resolve Ada’s sub-chat', async () => {
    expect((await http(bob, 'get', `/sessions/${ids.session}/stage4/subchat/${subId}`)).status).toBeGreaterThanOrEqual(
      403,
    );
    const resolve = await http(bob, 'post', `/sessions/${ids.session}/stage4/subchat/${subId}/resolve`, {
      updatedProposals: [{ proposalId, description: 'PROBE_TS12_BOB_REWRITE' }],
    });
    expect(resolve.status).toBeGreaterThanOrEqual(403);
    expect(await run.sql(`SELECT description FROM proposal WHERE id = $1`, [proposalId])).toEqual([
      { description: 'Use a pause phrase when either person starts to shut down' },
    ]);
  });

  it('resolve refines in place: same id, choices preserved, a SUBCHAT_REFINED revision by Ada; idempotent after', async () => {
    const before = await choices();
    expect(before).toHaveLength(2);
    const res = await http(ada, 'post', `/sessions/${ids.session}/stage4/subchat/${subId}/resolve`, {
      updatedProposals: [
        { proposalId, description: 'Use a pause phrase, then come back within ten minutes', duration: 'two weeks' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ createdProposalIds: [], updatedProposalIds: [proposalId] });
    expect(await run.sql(`SELECT description, duration FROM proposal WHERE id = $1`, [proposalId])).toEqual([
      { description: 'Use a pause phrase, then come back within ten minutes', duration: 'two weeks' },
    ]);
    expect(await choices()).toEqual(before);
    expect(
      await run.sql(
        `SELECT actor_user_id AS actor FROM proposal_revision WHERE proposal_id = $1 AND action = 'SUBCHAT_REFINED'`,
        [proposalId],
      ),
    ).toEqual([{ actor: ids.adaUser }]);
    expect(await run.sql(`SELECT status::text AS status FROM conversation WHERE id = $1`, [subId])).toEqual([
      { status: 'RESOLVED' },
    ]);

    const again = await http(ada, 'post', `/sessions/${ids.session}/stage4/subchat/${subId}/resolve`, {
      updatedProposals: [{ proposalId, description: 'PROBE_TS12_SECOND_RESOLVE' }],
    });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ createdProposalIds: [], updatedProposalIds: [] });
    expect(
      (await run.sql<{ description: string }>(`SELECT description FROM proposal WHERE id = $1`, [proposalId]))[0]
        .description,
    ).not.toBe('PROBE_TS12_SECOND_RESOLVE');
  });

  // work-k5fk.10.10 / 10.11 (owner decision 2026-11-23): creator-only until shared. A SHARED_PROPOSAL is shared with
  // every member from birth, so either edits it; the partner's INDIVIDUAL_COMMITMENT is its creator's alone, even once
  // shared_at shows it to them. The request path only touches what the caller may change.
  describe('creator-only until shared', () => {
    let checkin = '';
    let individual = '';
    beforeAll(async () => {
      [{ id: checkin }] = await run.sql<{ id: string }>(
        `SELECT id FROM proposal WHERE description LIKE 'Try a Sunday%'`,
      );
      [{ id: individual }] = await run.sql<{ id: string }>(
        `SELECT id FROM proposal WHERE description LIKE 'I will name when I am overloaded%'`,
      );
    });
    const description = (id: string) =>
      run
        .sql<{ description: string }>(`SELECT description FROM proposal WHERE id = $1`, [id])
        .then(r => r[0].description);

    it('sub-chat resolve: Bob refines Ada’s shared proposal, never her shared commitment (skipped, not a DB error)', async () => {
      await run.sql(`UPDATE proposal SET shared_at = now() WHERE id = $1`, [individual]); // visible to Bob now
      const opened = await http(bob, 'post', `/sessions/${ids.session}/stage4/subchat`, {
        anchorKind: 'PROPOSAL_REFINEMENT',
        anchorId: checkin,
      });
      expect(opened.status).toBe(200);
      const before = await description(individual);
      const res = await http(
        bob,
        'post',
        `/sessions/${ids.session}/stage4/subchat/${opened.body.data.subChat.id}/resolve`,
        {
          updatedProposals: [
            { proposalId: individual, description: 'PROBE_BOB_REWRITES_ADA_COMMITMENT' },
            { proposalId: checkin, description: 'Try a Sunday evening check-in, twenty minutes, for two weeks' },
          ],
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.data.updatedProposalIds).toEqual([checkin]);
      expect(await description(individual)).toBe(before);
      expect(await description(checkin)).toBe('Try a Sunday evening check-in, twenty minutes, for two weeks');
      expect(
        await run.sql(
          `SELECT count(*)::int AS n FROM proposal_revision WHERE proposal_id = $1 AND actor_user_id = $2`,
          [individual, ids.bobUser],
        ),
      ).toEqual([{ n: 0 }]);
    });

    it('createAgreement with strategyId: 404 for an unseen commitment, 403 for a seen one, 400 for its creator', async () => {
      const agree = (user: { id: string; email: string }, strategyId: string) =>
        http(user, 'post', `/sessions/${ids.session}/agreements`, {
          strategyId,
          description: 'probe',
          type: 'MICRO_EXPERIMENT',
        });
      await run.sql(`UPDATE proposal SET shared_at = NULL WHERE id = $1`, [individual]);
      expect((await agree(bob, individual)).status).toBe(404); // not shared: Bob does not see it
      await run.sql(`UPDATE proposal SET shared_at = now() WHERE id = $1`, [individual]);
      expect((await agree(bob, individual)).status).toBe(403); // shared: seen, still Ada's alone
      expect(
        await run.sql(
          `SELECT count(*)::int AS n FROM proposal_revision WHERE proposal_id = $1 AND actor_user_id = $2`,
          [individual, ids.bobUser],
        ),
      ).toEqual([{ n: 0 }]);
      // nor its creator: an individual commitment is never proposed as an agreement — Bob could not confirm it, since
      // a co-participant's commitment's revisions (the agreement's LEGACY_PROPOSED mark) are never his (work-k5fk.37)
      expect((await agree(ada, individual)).status).toBe(400);
    });
  });
});
