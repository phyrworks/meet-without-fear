/**
 * TS-11 fix round 1 — the repair-stage privacy fixes, over HTTP on real
 * roles (mwf_app request path, mwf_job writers, identity binding on):
 *
 *   Important 2  legacy agreements: a handle must be a proposal PROPOSED as an
 *                agreement; `agreedByPartner` never reveals an unshared
 *                WILLING; no agreement is created from a hidden choice; the
 *                partner's explicit confirm creates it (job, both parties).
 *   Important 4  a NEEDS_BRAINSTORM sub-chat persists its anchor at open: the
 *                reopen finds it, the turn carries it, the prompt names the
 *                need by the reader's naming, the resolve links it.
 *   (Important 3 and Critical 1: repair-closure-privacy.target.test.ts —
 *   lib/prisma binds its URL once per module registry, one fixture per file.)
 *
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const BOB_LABELS = ['Understanding', 'Support'];

async function proposalsOf(run: TargetRun): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await run.sql<{ id: string; description: string }>(`SELECT id, description FROM proposal`)) {
    const key = r.description.startsWith('Try a Sunday')
      ? 'checkin'
      : r.description.startsWith('Use a pause')
        ? 'pause'
        : r.description.startsWith('I will name')
          ? 'individual'
          : 'spreadsheet';
    out[key] = r.id;
  }
  return out;
}

describeTarget('repair privacy fixes (fix round 1) — legacy agreements and sub-chat anchors', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let proposal: Record<string, string>;
  const ada = () => ({ id: ids.adaUser, email: 'ada@e2e.test' });
  const bob = () => ({ id: ids.bobUser, email: 'bob@e2e.test' });

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `repair_priv_${process.pid}`);
    ids = await adaAndBob(run);
    http = await httpAs();
    proposal = await proposalsOf(run);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('legacy agreements: no handle without the PROPOSED mark; an unshared WILLING is neither revealed nor counted', async () => {
    const sid = ids.session;
    // Bob's redesigned-flow WILLING on both shared proposals, unshared.
    for (const key of ['checkin', 'pause']) {
      expect(
        (
          await http(bob(), 'post', `/sessions/${sid}/stage4/proposals/${proposal[key]}/selection`, {
            decision: 'WILLING',
          })
        ).status,
      ).toBe(200);
    }
    // A plain proposal id is not an agreement handle.
    expect(
      (await http(ada(), 'post', `/sessions/${sid}/agreements/${proposal.pause}/confirm`, { confirmed: true })).status,
    ).toBe(404);

    // Ada proposes "checkin" as an agreement: pending, Bob's hidden WILLING neither shown nor counted.
    const created = await http(ada(), 'post', `/sessions/${sid}/agreements`, {
      strategyId: proposal.checkin,
      description: 'Sunday check-in',
      type: 'MICRO_EXPERIMENT',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      awaitingPartnerConfirmation: true,
      agreement: {
        id: proposal.checkin,
        proposalId: proposal.checkin,
        status: 'PROPOSED',
        agreedByMe: true,
        agreedByPartner: false,
      },
    });
    expect(await run.sql(`SELECT id FROM agreement`)).toEqual([]);

    const adaList = await http(ada(), 'get', `/sessions/${sid}/agreements`);
    expect(adaList.body.data.agreements).toEqual([
      expect.objectContaining({ id: proposal.checkin, agreedByMe: true, agreedByPartner: false, status: 'PROPOSED' }),
    ]);
    // Bob sees Ada's explicit proposal (her act), not his own as agreed.
    const bobList = await http(bob(), 'get', `/sessions/${sid}/agreements`);
    expect(bobList.body.data.agreements).toEqual([
      expect.objectContaining({ id: proposal.checkin, agreedByMe: false, agreedByPartner: true }),
    ]);

    // Bob confirms: the job creates the agreement with both parties.
    const confirmed = await http(bob(), 'post', `/sessions/${sid}/agreements/${proposal.checkin}/confirm`, {
      confirmed: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.agreement).toMatchObject({
      status: 'AGREED',
      agreedByMe: true,
      agreedByPartner: true,
      proposalId: proposal.checkin,
    });
    const parties = await run.sql<{ participant_id: string }>(
      `SELECT participant_id FROM agreement_party ORDER BY participant_id`,
    );
    expect(parties.map(p => p.participant_id)).toEqual([ids.ada, ids.bob].sort());
    expect(await run.sql(`SELECT status::text AS status FROM proposal WHERE id = $1`, [proposal.checkin])).toEqual([
      { status: 'CONVERTED_TO_AGREEMENT' },
    ]);
  });

  it('a NEEDS_BRAINSTORM sub-chat persists its anchor at open; the turn, the prompt and the resolve use it', async () => {
    const sid = ids.session;
    const [understanding] = await run.sql<{ need_id: string; shared_text: string }>(
      `SELECT s.need_id, s.shared_text FROM need_share s JOIN need n ON n.id = s.need_id WHERE n.label = 'Understanding'`,
    );
    const opened = await http(ada(), 'post', `/sessions/${sid}/stage4/subchat`, {
      anchorKind: 'NEEDS_BRAINSTORM',
      anchorId: understanding.need_id,
    });
    expect(opened.status).toBe(200);
    const sub = opened.body.data.subChat;
    expect(sub.anchorId).toBe(understanding.need_id);
    // Persisted: the opening line carries the anchor, named by Ada's naming (Bob's shared text).
    expect(sub.messages).toHaveLength(1);
    expect(sub.messages[0].content).toContain(understanding.shared_text);
    for (const l of BOB_LABELS) expect(JSON.stringify(sub)).not.toContain(`: ${l}.`);
    // Reopen: the same sub-chat.
    const again = await http(ada(), 'post', `/sessions/${sid}/stage4/subchat`, {
      anchorKind: 'NEEDS_BRAINSTORM',
      anchorId: understanding.need_id,
    });
    expect(again.body.data.subChat.id).toBe(sub.id);
    expect((await http(ada(), 'get', `/sessions/${sid}/stage4/subchat/${sub.id}`)).body.data.subChat.anchorId).toBe(
      understanding.need_id,
    );
    // A turn: the user's message carries the anchor.
    const sent = await http(ada(), 'post', `/sessions/${sid}/stage4/subchat/${sub.id}/messages`, {
      content: 'Maybe ask first how his day went',
    });
    expect(sent.status).toBe(200);
    expect(
      await run.sql(
        `SELECT role::text AS role, refining_need_id FROM message WHERE conversation_id = $1 AND role = 'USER'`,
        [sub.id],
      ),
    ).toEqual([{ role: 'USER', refining_need_id: understanding.need_id }]);
    // The prompt names the anchor need by its shared text (Ada is not its owner).
    const { buildSystemPrompt, loadAnchorContext } = await import('../stage4-subchat.service');
    const { runWithContext } = await import('../../lib/request-context');
    const prompt = await runWithContext(
      { turnId: 't', requestId: 'r', startTime: Date.now(), userId: ids.adaUser },
      async () =>
        buildSystemPrompt({
          sessionId: sid,
          userId: ids.adaUser,
          anchorId: understanding.need_id,
          anchor: await loadAnchorContext(sid, 'NEEDS_BRAINSTORM' as never, understanding.need_id, ids.ada),
        }),
    );
    expect(prompt.systemPrompt).toContain(`Anchor — open need: ${understanding.shared_text}`);
    // Resolve with an accepted proposal: linked to the anchored shared need.
    const resolved = await http(ada(), 'post', `/sessions/${sid}/stage4/subchat/${sub.id}/resolve`, {
      acceptedProposals: [{ description: 'Ask about his day before raising chores' }],
    });
    expect(resolved.status).toBe(200);
    const [created] = resolved.body.data.createdProposalIds;
    expect(await run.sql(`SELECT need_id FROM proposal_need WHERE proposal_id = $1`, [created])).toEqual([
      { need_id: understanding.need_id },
    ]);
    // An anchor that is not a shared need of the session is refused.
    const [unshared] = await run.sql<{ id: string }>(
      `INSERT INTO need (participant_id, label, category, ai_confidence) VALUES ($1, 'PROBE_NOT_SHARED', 'SAFETY', 0.9) RETURNING id`,
      [ids.bob],
    );
    expect(
      (
        await http(ada(), 'post', `/sessions/${sid}/stage4/subchat`, {
          anchorKind: 'NEEDS_BRAINSTORM',
          anchorId: unshared.id,
        })
      ).status,
    ).toBe(404);
  });
});
