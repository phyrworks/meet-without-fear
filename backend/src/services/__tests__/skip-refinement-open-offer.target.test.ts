/**
 * TS-10 fix round 1, I3: skip-refinement is the author's REFINING → READY,
 * made as the participant. Never VALIDATED; refused while the subject's offer
 * is open; a failed move is an error, not `{ success: true }`.
 *
 * This file: RECONCILER_SHOWN_B (Ada's round AWAITING_SHARING, Bob's offer
 * open), app as `mwf_app` with identity binding on. The REFINING path is
 * skip-refinement.target.test.ts.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const rowsOf =
  (harness: Harness) =>
  async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql)).rows, harness.fixture.database);
const adaRound = `SELECT a.status::text AS status, a.status_version AS version, a.revealed_at IS NOT NULL AS revealed
  FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id JOIN "user" u ON u.id = p.user_id
  WHERE u.email = 'ada@e2e.test' ORDER BY a.round DESC LIMIT 1`;
const skip = (harness: Harness) =>
  harness.step({
    label: 'skip refinement as ada',
    actor: harness.actors.userA,
    tables: [],
    call: agent =>
      agent.post(`/api/v1/sessions/${harness.sessionId}/empathy/skip-refinement`).send({ willingToAccept: true }),
  });

describeTarget('skip-refinement while the subject decides on an offer (RECONCILER_SHOWN_B)', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `ts10_skip_open_${process.pid}`,
      appLogin: 'mwf_app',
    });
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('is refused (409): the round stays AWAITING_SHARING and the offer stays open', async () => {
    const rows = rowsOf(harness);
    const [before] = await rows<{ status: string }>(adaRound);
    expect(before.status).toBe('AWAITING_SHARING');
    const offersBefore = await rows(`SELECT status::text AS status FROM context_share_offer`);
    const res = await skip(harness);
    expect(res.status).toBe(409);
    expect(await rows(adaRound)).toEqual([before]);
    expect(await rows(`SELECT status::text AS status FROM context_share_offer`)).toEqual(offersBefore);
  });
});
