/**
 * Review services (work-k5fk.33): resubmitting from AWAITING_SHARING retires
 * the round AND its open share offer, in the same transaction
 * (app.empathy_set_status → SUPERSEDED expires the round's PENDING / OFFERED
 * offers). Before, the offer stayed OFFERED on a superseded round: the
 * subject's decline answered 500, and an accept delivered context to a round
 * nobody reads.
 *
 * RECONCILER_SHOWN_B clone (Ada's round AWAITING_SHARING, the offer OFFERED to
 * Bob), app as mwf_app with identity binding on, MOCK_LLM.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { listTables, withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('a resubmit from AWAITING_SHARING expires the round’s open share offer', () => {
  let harness: Harness;
  const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql)).rows, harness.fixture.database);
  const offers = () =>
    rows<{ round: number; status: string }>(
      `SELECT a.round, o.status::text AS status FROM context_share_offer o
       JOIN empathy_attempt a ON a.id = o.attempt_id ORDER BY a.round, o.iteration`,
    );

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `k5fk33_resubmit_${process.pid}`,
    });
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('setup: round 1 AWAITING_SHARING with its offer OFFERED', async () => {
    expect(await offers()).toEqual([{ round: 1, status: 'OFFERED' }]);
  });

  it('Ada resubmits: round 1 SUPERSEDED and its offer EXPIRED; Bob’s decline finds none open (404, not 500)', async () => {
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const res = await harness.step({
      label: 'resubmit as ada',
      actor: harness.actors.userA,
      tables: scope,
      // the round-2 analysis runs in the background; wait for it
      asyncBoundary: true,
      call: agent =>
        agent
          .post(`/api/v1/sessions/${harness.sessionId}/empathy/resubmit`)
          .send({ content: 'PROBE_ROUND_TWO I hear that you have been carrying all of it on your own lately.' }),
    });
    expect(res.status).toBe(200);
    const statuses = await rows<{ round: number; status: string }>(
      `SELECT a.round, a.status::text AS status FROM empathy_attempt a
       JOIN "user" u ON u.id = a.author_user_id WHERE u.email = 'ada@e2e.test' ORDER BY a.round`,
    );
    expect(statuses[0]).toEqual({ round: 1, status: 'SUPERSEDED' });
    const round1 = (await offers()).filter(o => o.round === 1);
    expect(round1).toEqual([{ round: 1, status: 'EXPIRED' }]);

    // Only round 1's offer is in question: round 2's own analysis may have opened one of its own.
    const open = (await offers()).filter(o => o.status === 'OFFERED' || o.status === 'PENDING');
    const decline = await harness.step({
      label: 'decline as bob',
      actor: harness.actors.userB!,
      tables: [],
      call: agent =>
        agent.post(`/api/v1/sessions/${harness.sessionId}/reconciler/share-offer/respond`).send({ action: 'decline' }),
    });
    expect(decline.status).not.toBe(500);
    if (open.length === 0) expect(decline.status).toBe(404);
    expect((await offers()).filter(o => o.round === 1)).toEqual([{ round: 1, status: 'EXPIRED' }]);
  });
});
