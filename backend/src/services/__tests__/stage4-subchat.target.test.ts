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
    run.sql(
      `SELECT participant_id, decision::text AS decision FROM proposal_choice WHERE proposal_id = $1 ORDER BY participant_id`,
      [proposalId],
    );

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
        `SELECT participant_id, kind::text AS kind, anchor_proposal_id FROM conversation WHERE kind = 'SUBCHAT'`,
      ),
    ).toEqual([{ participant_id: ids.ada, kind: 'SUBCHAT', anchor_proposal_id: proposalId }]);
  });

  it('the prompt carries Ada’s main-chat history and the anchored proposal', async () => {
    const [main] = await run.sql<{ id: string }>(
      `SELECT id FROM conversation WHERE participant_id = $1 AND kind = 'MAIN'`,
      [ids.ada],
    );
    await run.sql(
      `INSERT INTO message (conversation_id, sender_participant_id, role, content) VALUES ($1, $2, 'USER', 'PROBE_TS12_MAIN_HISTORY')`,
      [main.id, ids.ada],
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
        `SELECT actor_participant_id AS actor FROM proposal_revision WHERE proposal_id = $1 AND action = 'SUBCHAT_REFINED'`,
        [proposalId],
      ),
    ).toEqual([{ actor: ids.ada }]);
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
});
