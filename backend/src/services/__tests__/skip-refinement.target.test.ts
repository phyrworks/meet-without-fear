/**
 * TS-10 fix round 1, I3: skip-refinement is the author's REFINING → READY,
 * made as the participant. Never VALIDATED; refused while the subject's offer
 * is open; a failed move is an error, not `{ success: true }`.
 *
 * CONTEXT_SHARED_B clone (Ada's round REFINING after Bob shared context), app
 * as `mwf_app` with identity binding on, job as `mwf_job`. The open-offer
 * refusal is skip-refinement-open-offer.target.test.ts (one clone per file:
 * the app binds its database at first import).
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

describeTarget('skip-refinement from REFINING (CONTEXT_SHARED_B)', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'CONTEXT_SHARED_B',
      runId: `ts10_skip_${process.pid}`,
      appLogin: 'mwf_app',
    });
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (harness) await harness.teardown();
  });

  it('a refused or failed move answers 500 and leaves the round where it was', async () => {
    const rows = rowsOf(harness);
    const [before] = await rows<{ status: string; version: number }>(adaRound);
    expect(before.status).toBe('REFINING');
    const store = await import('../empathy-store');
    jest.spyOn(store, 'setAttemptStatus').mockRejectedValueOnce(new Error('injected: empathy_set_status refused'));
    const res = await skip(harness);
    expect(res.status).toBe(500);
    expect(await rows(adaRound)).toEqual([before]);
  });

  it("the author's round moves REFINING → READY as the participant, never to VALIDATED", async () => {
    const rows = rowsOf(harness);
    const [before] = await rows<{ status: string; version: number }>(adaRound);
    const store = await import('../empathy-store');
    const spy = jest.spyOn(store, 'setAttemptStatus');
    const res = await skip(harness);
    expect(res.status).toBe(200);
    expect((res.body as { data: { success: boolean; status: string } }).data).toEqual({
      success: true,
      status: 'READY',
    });
    expect(spy.mock.calls.map(c => [c[1], c[2]])).toEqual([['READY', { actor: 'participant' }]]);
    // Bob has no round yet, so the reveal gate holds it at READY.
    expect(await rows(adaRound)).toEqual([{ status: 'READY', version: before.version + 1, revealed: false }]);
    expect(await rows(`SELECT count(*)::int AS n FROM empathy_review`)).toEqual([{ n: 0 }]);
    spy.mockRestore();
  });

  it('a second skip answers with the round as it is and moves nothing', async () => {
    const rows = rowsOf(harness);
    const [before] = await rows(adaRound);
    const res = await skip(harness);
    expect(res.status).toBe(200);
    expect((res.body as { data: { status: string } }).data.status).toBe('READY');
    expect(await rows(adaRound)).toEqual([before]);
  });
});
