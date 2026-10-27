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
 * This file: Stage 3 (NEEDS_CONFIRMED); stage4-route-validation.target.test.ts: Stage 4 and the reconciler.
 * Requires: npx tsx src/testing/golden/cli.ts build NEEDS_CONFIRMED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const snapshot = (run: TargetRun, table: string) => run.sql(`SELECT * FROM ${table} ORDER BY id`);

describeTarget('Stage 3 route refusals (NEEDS_CONFIRMED)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('NEEDS_CONFIRMED', `ts12_s3val_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('needs/confirm without needIds is a 400 VALIDATION_ERROR', async () => {
    const before = await snapshot(run, 'need');
    const res = await http(ada, 'post', `/sessions/${ids.session}/needs/confirm`, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await snapshot(run, 'need')).toEqual(before);
  });

  it('needs/confirm with an adjustment of the partner’s need is refused; the partner’s need is untouched', async () => {
    const [own] = await run.sql<{ id: string }>(`SELECT id FROM need WHERE participant_id = $1 ORDER BY created_at LIMIT 1`, [ids.ada]);
    const [bobs] = await run.sql<{ id: string }>(`SELECT id FROM need WHERE participant_id = $1 ORDER BY created_at LIMIT 1`, [ids.bob]);
    const before = await snapshot(run, 'need');
    const res = await http(ada, 'post', `/sessions/${ids.session}/needs/confirm`, {
      needIds: [own.id],
      adjustments: [{ needId: bobs.id, confirmed: false, correction: 'PROBE_TS12_FOREIGN' }],
    });
    expect(res.status).toBe(400);
    expect(await snapshot(run, 'need')).toEqual(before);
  });
});
