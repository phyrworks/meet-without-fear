/**
 * TS-10 fix round 1, m1: the subject's validation-feedback draft answers a
 * REVEALED round only. Before the reveal there is nothing to answer: the
 * endpoint 404s and writes no draft. (The old fallback read the author's
 * unrevealed round as its subject, for its id, and pointed the draft at it.)
 *
 * RECONCILER_SHOWN_B clone (Ada's round AWAITING_SHARING, unrevealed; Bob its
 * subject), app as `mwf_app` with identity binding on.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('validation-feedback draft before the reveal (m1)', () => {
  let harness: Harness;
  const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql)).rows, harness.fixture.database);

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `ts10_fbdraft_${process.pid}`,
      appLogin: 'mwf_app',
    });
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it("404s and writes no draft while the author's round is unrevealed", async () => {
    expect(await rows(`SELECT count(*)::int AS n FROM empathy_attempt WHERE revealed_at IS NOT NULL`)).toEqual([
      { n: 0 },
    ]);
    const res = await harness.step({
      label: 'feedback draft as bob',
      actor: harness.actors.userB!,
      tables: [],
      call: agent =>
        agent
          .post(`/api/v1/sessions/${harness.sessionId}/empathy/validation-feedback/draft`)
          .send({ content: 'Not quite — it was about being asked.', readyToShare: false }),
    });
    expect(res.status).toBe(404);
    expect(await rows(`SELECT count(*)::int AS n FROM draft WHERE kind = 'VALIDATION_FEEDBACK'`)).toEqual([{ n: 0 }]);
  });
});
