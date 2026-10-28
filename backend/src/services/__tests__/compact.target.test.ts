/**
 * TS-12, real roles on a clone of the INVITATION_READY target fixture: the
 * Stage 0 compact on participant_milestone (`compact_signed`, self-assertable,
 * written by the app), and the session going ACTIVE through the status writer
 * once both have signed. Replaces the Prisma-mock tests of
 * routes/__tests__/stage0.test.ts.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build INVITATION_READY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('the compact on the target, as mwf_app', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('INVITATION_READY', `ts12_compact_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
    // Start from no signatures (the fixture's milestones other than compact_signed stay)
    await run.sql(`DELETE FROM participant_milestone WHERE milestone_key = 'compact_signed'`);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const signed = async () =>
    (
      await run.sql<{ participant_id: string }>(
        `SELECT participant_id FROM participant_milestone WHERE milestone_key = 'compact_signed' ORDER BY reached_at`,
      )
    ).map(r => r.participant_id);

  it('sign, refuse a second signature, report status; ACTIVE once both signed', async () => {
    const first = await http(ada, 'post', `/sessions/${ids.session}/compact/sign`, { agreed: true });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ signed: true, partnerSigned: false, canAdvance: false });
    expect(await signed()).toEqual([ids.ada]);
    expect((await http(ada, 'post', `/sessions/${ids.session}/compact/sign`, { agreed: true })).status).toBe(409);

    // Bob sees only that Ada signed once he has signed himself
    const bobStatusBefore = (await http(bob, 'get', `/sessions/${ids.session}/compact/status`)).body.data;
    expect(bobStatusBefore).toMatchObject({ mySigned: false });
    expect(bobStatusBefore.partnerSignedAt ?? null).toBeNull();

    const second = await http(bob, 'post', `/sessions/${ids.session}/compact/sign`, { agreed: true });
    expect(second.body.data).toMatchObject({ signed: true, partnerSigned: true, canAdvance: true });
    expect(await signed()).toEqual([ids.ada, ids.bob]);
    const bobStatus = (await http(bob, 'get', `/sessions/${ids.session}/compact/status`)).body.data;
    expect(bobStatus).toMatchObject({ mySigned: true, partnerSigned: true });

    // The status write is the job's, fire-and-forget after the response
    for (let i = 0; i < 50; i++) {
      const [s] = await run.sql<{ status: string }>(`SELECT status::text AS status FROM session WHERE id = $1`, [
        ids.session,
      ]);
      if (s.status === 'ACTIVE') break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(await run.sql(`SELECT status::text AS status FROM session WHERE id = $1`, [ids.session])).toEqual([
      { status: 'ACTIVE' },
    ]);
  });

  it('a non-participant signs nothing (the live PENDING arm lets them reach the handler, which has no participant: 404); a missing session 404', async () => {
    const stranger = { id: '00000000-0000-7000-8000-00000000abcd', email: 'stranger@e2e.test' };
    expect((await http(stranger, 'post', `/sessions/${ids.session}/compact/sign`, { agreed: true })).status).toBe(404);
    expect(await signed()).toEqual([ids.ada, ids.bob]);
    expect((await http(ada, 'get', `/sessions/00000000-0000-7000-8000-000000000000/compact/status`)).status).toBe(404);
  });
});
