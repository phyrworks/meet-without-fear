/**
 * TS-11 fix round 1 — the closure and re-entry privacy fixes, over HTTP on
 * real roles (split from repair-privacy.target.test.ts: lib/prisma binds its
 * URL once per module registry, so each fixture run needs its own file).
 *
 *   Important 3  closing before the partner has shared is no oracle on their
 *                unshared choices (no "Mutual willingness exists" refusal, no
 *                agreement).
 *   Critical 1   the passive re-entry is the participant's own: its summary
 *                never reaches the partner, and carries no private label.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_PARTNER_INACTIVE
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const ADA_LABELS = ['Appreciation', 'Partnership'];
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

describeTarget('repair privacy fixes (fix round 1) — closure oracle and the passive re-entry', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let proposal: Record<string, string>;
  const ada = () => ({ id: ids.adaUser, email: 'ada@e2e.test' });
  const bob = () => ({ id: ids.bobUser, email: 'bob@e2e.test' });

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_PARTNER_INACTIVE', `repair_priv2_${process.pid}`);
    ids = await adaAndBob(run);
    http = await httpAs();
    proposal = await proposalsOf(run);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('closing before the partner has shared reveals nothing of their unshared WILLING and creates no agreement', async () => {
    const sid = ids.session;
    // Bob is WILLING on "checkin" (Ada is too, and has shared) — but Bob has not shared.
    expect(
      (
        await http(bob(), 'post', `/sessions/${sid}/stage4/proposals/${proposal.checkin}/selection`, {
          decision: 'WILLING',
        })
      ).status,
    ).toBe(200);
    const closed = await http(ada(), 'post', `/sessions/${sid}/stage4/close`, {});
    // Old behaviour: 400 "Mutual willingness exists …" — an oracle on Bob's hidden choice.
    expect(closed.status).toBe(200);
    expect(JSON.stringify(closed.body)).not.toContain('Mutual willingness');
    expect(closed.body.data.outcome).toMatchObject({ kind: 'NO_SHARED_AGREEMENT', reason: 'USER_STOPPED' });
    expect(await run.sql(`SELECT * FROM agreement`)).toEqual([]);
  });

  it("the passive re-entry is Ada's own: never in Bob's Tending list, Stage 4 preview or prompt source; no private label in it", async () => {
    const sid = ids.session;
    const created = await http(ada(), 'post', `/sessions/${sid}/tending/reentry`, { intent: 'I want to revisit this' });
    expect(created.status).toBe(201);
    const entry = created.body.data.entry;
    expect(entry).toMatchObject({ type: 'USER_INITIATED_REENTRY', scope: 'INDIVIDUAL', ownerUserId: ids.adaUser });
    for (const l of [...ADA_LABELS, ...BOB_LABELS]) expect(entry.summary).not.toContain(l);

    const bobTending = await http(bob(), 'get', `/sessions/${sid}/tending`);
    expect(bobTending.status).toBe(200);
    expect(bobTending.body.data.entries.map((e: { id: string }) => e.id)).not.toContain(entry.id);
    const bobStage4 = await http(bob(), 'get', `/sessions/${sid}/stage4`);
    expect(JSON.stringify(bobStage4.body)).not.toContain(entry.id);
    for (const l of ADA_LABELS) expect(JSON.stringify(bobTending.body)).not.toContain(l);
    // The Tending prompt reads loadFollowUpsForParticipant: Bob's excludes it.
    const { loadFollowUpsForParticipant } = await import('../tending.service');
    expect((await loadFollowUpsForParticipant(sid, ids.bob)).map(f => f.id)).not.toContain(entry.id);
    expect((await loadFollowUpsForParticipant(sid, ids.ada)).map(f => f.id)).toContain(entry.id);
  });
});
