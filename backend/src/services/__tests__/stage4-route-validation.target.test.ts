/**
 * TS-12, real roles: the request-validation and ownership refusals of the
 * Stage 3 / Stage 4 / reconciler routes, over HTTP as mwf_app, each leaving the
 * tables unchanged. Ported from the Prisma-mock route suites
 * routes/__tests__/stage3.test.ts, stage4.test.ts and reconciler.test.ts
 * (deleted); their happy paths are the goldens' (NEED_MAPPING_COMPLETE,
 * NEEDS_CONFIRMED, STAGE4_REDESIGN_*, the reconciler stages) and the TS-10/TS-11
 * target suites'.
 *
 * One run (one fixture database) per file: the app's Prisma client is bound
 * to the first run database it sees in a jest worker.
 * This file: Stage 4 and the reconciler (STAGE4_REDESIGN_INVENTORY); stage3: stage3-route-validation.target.test.ts.
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const snapshot = (run: TargetRun, table: string) => run.sql(`SELECT * FROM ${table} ORDER BY id`);

describeTarget('Stage 4 and reconciler route refusals (STAGE4_REDESIGN_INVENTORY)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `ts12_s4val_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('stage4/close with an empty checkInDate is a 400 VALIDATION_ERROR; no closure is written', async () => {
    const res = await http(ada, 'post', `/sessions/${ids.session}/stage4/close`, { checkInDate: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await run.sql(`SELECT count(*)::int AS n FROM session_closure`)).toEqual([{ n: 0 }]);
  });

  it('strategies: a too-short description and an empty needsAddressed are 400s; no proposal is written', async () => {
    const before = await snapshot(run, 'proposal');
    for (const body of [
      { description: 'short', needsAddressed: ['connection'] },
      { description: 'A valid description here', needsAddressed: [] },
    ]) {
      const res = await http(ada, 'post', `/sessions/${ids.session}/strategies`, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await snapshot(run, 'proposal')).toEqual(before);
  });

  it('reconciler share-offer/respond with an invalid body is a 400', async () => {
    const res = await http(ada, 'post', `/sessions/${ids.session}/reconciler/share-offer/respond`, { invalid: true });
    expect(res.status).toBe(400);
  });
});
