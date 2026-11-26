/**
 * Owner decision 2026-11-25 (work-k5fk.37; refines work-k5fk.32 S1): everything a user writes is private until they
 * share it, and an individual commitment is shared by its OWN action — POST /stage4/commitments/:proposalId/share,
 * which calls app.proposal_share for that one commitment. Sharing one's Stage 4 stances shares none. Sharing releases
 * only the commitment's CURRENT text (description, duration, measure of success): its revision history — the earlier
 * wordings and the capturedQuote, the sentence of Ada's private chat it was captured from — stays hers, in the
 * database (proposal_revision app_select). Over HTTP as mwf_app.
 *
 * Ada's INDIVIDUAL_COMMITMENT in STAGE4_REDESIGN_INVENTORY: "I will name when I am overloaded before I disappear".
 *
 * One run (one fixture database) per file: the app's Prisma client is bound to the first run database it sees.
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const COMMITMENT = 'I will name when I am overloaded before I disappear';
const EARLIER_WORDING = 'PROBE_EARLIER_WORDING of the commitment';
const PRIVATE_SENTENCE = 'PROBE_PRIVATE_SENTENCE from Ada’s own chat';

type Card = {
  id: string;
  description: string;
  duration: string | null;
  measureOfSuccess: string | null;
  ownerLabel?: string;
  isShared?: boolean;
};

describeTarget('Stage 4: a commitment is shared by its own action, and only its current text (work-k5fk.37)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };
  let commitment: string;

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `b1b_share_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
    [{ id: commitment }] = await run.sql<{ id: string }>(
      `SELECT id::text FROM proposal WHERE session_id = $1 AND kind = 'INDIVIDUAL_COMMITMENT' AND created_by_user_id = $2`,
      [ids.session, ada.id],
    );
    // Its history, as capture writes it: a CREATED revision carrying the sentence it was captured from, and a
    // revision from an earlier wording to the current one. Keyless test database: plaintext envelopes.
    await run.sql(
      `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action, after)
       VALUES ($1, $2, $3, 'CREATED', $4::jsonb)`,
      [
        commitment,
        ids.session,
        ada.id,
        JSON.stringify({ description: EARLIER_WORDING, capturedQuote: PRIVATE_SENTENCE }),
      ],
    );
    await run.sql(
      `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action, before, after)
       VALUES ($1, $2, $3, 'REVISED', $4::jsonb, $5::jsonb)`,
      [
        commitment,
        ids.session,
        ada.id,
        JSON.stringify({ description: EARLIER_WORDING }),
        JSON.stringify({ description: COMMITMENT }),
      ],
    );
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const sharedAt = async (id = commitment) =>
    (await run.sql<{ shared_at: Date | null }>(`SELECT shared_at FROM proposal WHERE id = $1`, [id]))[0].shared_at;
  const stage4 = async (who: { id: string; email: string }) => {
    const res = await http(who, 'get', `/sessions/${ids.session}/stage4`);
    expect(res.status).toBe(200);
    return res.body.data;
  };
  const commitmentCards = async (who: { id: string; email: string }): Promise<Card[]> =>
    (await stage4(who)).inventory.individualCommitments;
  const share = (who: { id: string; email: string }, id: string) =>
    http(who, 'post', `/sessions/${ids.session}/stage4/commitments/${id}/share`);
  /** Everything Bob's Stage 4 and agreement reads return, as text. */
  const bobReads = async () =>
    JSON.stringify([await stage4(bob), (await http(bob, 'get', `/sessions/${ids.session}/agreements`)).body]);

  it('sharing her stances shares no commitment: Bob reads it through no route; Ada’s card says it is private', async () => {
    const proposals = await run.sql<{ id: string }>(
      `SELECT id::text FROM proposal WHERE session_id = $1 AND status = 'ACTIVE' AND kind = 'SHARED_PROPOSAL'`,
      [ids.session],
    );
    const chose = await http(ada, 'post', `/sessions/${ids.session}/stage4/selections`, {
      selections: proposals.map(p => ({ proposalId: p.id, decision: 'WILLING' })),
    });
    expect(chose.status).toBe(200);
    for (const need of (await stage4(ada)).coverageAudit.open as Array<{ id: string }>) {
      expect((await http(ada, 'post', `/sessions/${ids.session}/stage4/needs/${need.id}/decline`)).status).toBe(200);
    }
    expect((await http(ada, 'post', `/sessions/${ids.session}/stage4/share-selections`)).status).toBe(200);

    expect(await sharedAt()).toBeNull();
    expect((await commitmentCards(bob)).map(c => c.id)).not.toContain(commitment);
    expect(await bobReads()).not.toContain(COMMITMENT);
    expect((await commitmentCards(ada)).find(c => c.id === commitment)).toMatchObject({
      ownerLabel: 'You',
      isShared: false,
    });
  });

  it('only its creator shares it, and only a live individual commitment is shared this way', async () => {
    expect((await share(bob, commitment)).status).toBe(404); // not his, and not visible to him
    const [{ id: checkin }] = await run.sql<{ id: string }>(
      `SELECT id::text FROM proposal WHERE session_id = $1 AND description LIKE 'Try a Sunday%'`,
      [ids.session],
    );
    const sharedProposal = await share(ada, checkin);
    expect(sharedProposal.status).toBe(400);
    expect(sharedProposal.body.error.code).toBe('VALIDATION_ERROR');
    const [{ id: removed }] = await run.sql<{ id: string }>(
      `INSERT INTO proposal (session_id, created_by_user_id, kind, status, description, removed_at, removed_by_user_id)
       VALUES ($1, $2, 'INDIVIDUAL_COMMITMENT', 'REMOVED', 'PROBE_REMOVED_COMMITMENT', now(), $2) RETURNING id::text`,
      [ids.session, ada.id],
    );
    expect((await share(ada, removed)).status).toBe(400);
    expect(await sharedAt(removed)).toBeNull();
    expect((await share(ada, 'not-a-proposal')).status).toBe(404);
    expect(await sharedAt()).toBeNull();
  });

  it('Ada shares it with its own action: Bob reads its current text and nothing of its history', async () => {
    const res = await share(ada, commitment);
    expect(res.status).toBe(200);
    expect(
      (res.body.data.state.inventory.individualCommitments as Card[]).find(c => c.id === commitment),
    ).toMatchObject({ isShared: true });
    expect(await sharedAt()).not.toBeNull();

    const bobsCard = (await commitmentCards(bob)).find(c => c.id === commitment);
    expect(bobsCard).toMatchObject({
      description: COMMITMENT,
      duration: 'This week',
      measureOfSuccess: 'Stress is named before withdrawal',
      ownerLabel: 'Partner',
      isShared: true,
    });
    const raw = await bobReads();
    expect(raw).not.toContain('PROBE_EARLIER_WORDING');
    expect(raw).not.toContain('PROBE_PRIVATE_SENTENCE');
  });

  it('set once: sharing again changes nothing; pulling the stances back leaves it shared', async () => {
    const first = await sharedAt();
    expect((await share(ada, commitment)).status).toBe(200);
    expect(await sharedAt()).toEqual(first);
    expect((await http(ada, 'post', `/sessions/${ids.session}/stage4/unshare-selections`)).status).toBe(200);
    expect(await sharedAt()).toEqual(first);
    expect((await commitmentCards(bob)).map(c => c.id)).toContain(commitment);
  });

  it('an individual commitment is never proposed as an agreement, shared or not (Bob could not confirm it)', async () => {
    const propose = await http(ada, 'post', `/sessions/${ids.session}/agreements`, {
      strategyId: commitment,
      description: COMMITMENT,
      type: 'MICRO_EXPERIMENT',
    });
    expect(propose.status).toBe(400);
    expect(propose.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a shared proposal Ada makes her own commitment is hidden from Bob until she shares it with its own action', async () => {
    const [{ id: checkin }] = await run.sql<{ id: string }>(
      `SELECT id::text FROM proposal WHERE session_id = $1 AND description LIKE 'Try a Sunday%'`,
      [ids.session],
    );
    // What Stage 4 capture writes when Ada's edit makes it her own commitment (owner connection: the app's
    // creator move is t_proposal_app_moves' to allow, and rls-cross-user covers it).
    await run.sql(
      `UPDATE proposal SET kind = 'INDIVIDUAL_COMMITMENT', created_by_user_id = $2, description = 'PROBE_MINE_NOW'
       WHERE id = $1`,
      [checkin, ada.id],
    );
    expect((await commitmentCards(bob)).map(c => c.id)).not.toContain(checkin);
    expect((await stage4(bob)).inventory.sharedProposals.map((p: Card) => p.id)).not.toContain(checkin);
    expect((await commitmentCards(ada)).find(c => c.id === checkin)).toMatchObject({ isShared: false });

    expect((await share(ada, checkin)).status).toBe(200);
    expect((await commitmentCards(bob)).find(c => c.id === checkin)).toMatchObject({
      description: 'PROBE_MINE_NOW',
      isShared: true,
    });
  });
});
