/**
 * work-k5fk.32 S1 (owner decision 2026-11-25: everything a user writes is private until they share it), over HTTP
 * as mwf_app. Ada's INDIVIDUAL_COMMITMENT in STAGE4_REDESIGN_INVENTORY ("I will name when I am overloaded before I
 * disappear") is hers until she shares her Stage 4 stances: then app.proposal_share stamps its shared_at, once.
 * Before that Bob reads it through no route — not GET /stage4, and not GET /agreements, which listed a pending
 * (legacy-proposed) agreement's text without a visibility check.
 *
 * One run (one fixture database) per file: the app's Prisma client is bound to the first run database it sees.
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const COMMITMENT = 'I will name when I am overloaded before I disappear';

describeTarget('Stage 4: an individual commitment is private until its creator shares it (work-k5fk.32 S1)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };
  let commitment: string;

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `b1_share_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
    [{ id: commitment }] = await run.sql<{ id: string }>(
      `SELECT id::text FROM proposal WHERE session_id = $1 AND kind = 'INDIVIDUAL_COMMITMENT' AND created_by_user_id = $2`,
      [ids.session, ada.id],
    );
    // A legacy "proposed as an agreement" mark on it, as POST /agreements wrote before it refused an unshared
    // commitment: what GET /agreements lists as a pending agreement.
    await run.sql(
      `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action, after, reason)
       VALUES ($1, $2, $3, 'REVISED', '{"legacyAgreement": true}', 'LEGACY_PROPOSED')`,
      [commitment, ids.session, ada.id],
    );
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const sharedAt = async () =>
    (await run.sql<{ shared_at: Date | null }>(`SELECT shared_at FROM proposal WHERE id = $1`, [commitment]))[0]
      .shared_at;
  const agreementIds = async (who: { id: string; email: string }) => {
    const res = await http(who, 'get', `/sessions/${ids.session}/agreements`);
    expect(res.status).toBe(200);
    return (res.body.data.agreements as Array<{ id: string; description: string }>).map(a => a.id);
  };
  const commitmentIds = async (who: { id: string; email: string }) => {
    const res = await http(who, 'get', `/sessions/${ids.session}/stage4`);
    expect(res.status).toBe(200);
    return (res.body.data.inventory.individualCommitments as Array<{ id: string }>).map(p => p.id);
  };

  it('before the share: Bob reads it through no route; Ada cannot propose it as an agreement', async () => {
    expect(await sharedAt()).toBeNull();
    expect(await agreementIds(ada)).toContain(commitment);
    expect(await agreementIds(bob)).not.toContain(commitment);
    const bobRaw = JSON.stringify((await http(bob, 'get', `/sessions/${ids.session}/agreements`)).body);
    expect(bobRaw).not.toContain(COMMITMENT);
    expect(await commitmentIds(ada)).toContain(commitment);
    expect(await commitmentIds(bob)).not.toContain(commitment);
    // Bob cannot confirm what he cannot see
    const confirm = await http(bob, 'post', `/sessions/${ids.session}/agreements/${commitment}/confirm`, {
      confirmed: true,
    });
    expect(confirm.status).toBe(404);
    // Proposing it as an agreement asks Bob to confirm what he cannot read: refused until shared
    const propose = await http(ada, 'post', `/sessions/${ids.session}/agreements`, {
      strategyId: commitment,
      description: COMMITMENT,
      type: 'MICRO_EXPERIMENT',
    });
    expect(propose.status).toBe(400);
    expect(propose.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('sharing her stances shares it, once: Bob reads it after; pulling the stances back leaves it shared', async () => {
    const proposals = await run.sql<{ id: string }>(
      `SELECT id::text FROM proposal WHERE session_id = $1 AND status = 'ACTIVE'`,
      [ids.session],
    );
    const chose = await http(ada, 'post', `/sessions/${ids.session}/stage4/selections`, {
      selections: proposals.map(p => ({ proposalId: p.id, decision: 'WILLING' })),
    });
    expect(chose.status).toBe(200);
    expect(await sharedAt()).toBeNull(); // a stance alone shares nothing

    const share = await http(ada, 'post', `/sessions/${ids.session}/stage4/share-selections`);
    expect(share.status).toBe(200);
    const first = await sharedAt();
    expect(first).not.toBeNull();
    expect(await agreementIds(bob)).toContain(commitment);
    expect(await commitmentIds(bob)).toContain(commitment);

    // Set once: unsharing the stances (to revise) and sharing again leave the first instant
    expect((await http(ada, 'post', `/sessions/${ids.session}/stage4/unshare-selections`)).status).toBe(200);
    expect(await sharedAt()).toEqual(first);
    expect(await commitmentIds(bob)).toContain(commitment);
    expect((await http(ada, 'post', `/sessions/${ids.session}/stage4/share-selections`)).status).toBe(200);
    expect(await sharedAt()).toEqual(first);
  });
});
