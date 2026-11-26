/**
 * Review services#4 (work-k5fk.33): declining a share offer is one
 * transaction, as it was on the base — the offer DECLINED, the DENIED consent,
 * and the author's round AWAITING_SHARING → READY (now the subject's own move,
 * app.empathy_set_status's declined-offer arm). A failure of the move leaves
 * the offer open and nothing written, so the retry is a real decline (before:
 * DECLINED committed, the round stayed AWAITING_SHARING, and the retry said
 * "declined").
 *
 * RECONCILER_SHOWN_B clone (Ada's round AWAITING_SHARING, the offer OFFERED to
 * Bob), app as mwf_app with identity binding on. The move is made to fail in
 * the database (a throwaway trigger), so the test does not depend on which
 * connection makes it.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('declining a share offer is all or nothing (services#4)', () => {
  let harness: Harness;
  const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql)).rows, harness.fixture.database);
  const decline = () =>
    harness.step({
      label: 'decline as bob',
      actor: harness.actors.userB!,
      tables: [],
      call: agent =>
        agent.post(`/api/v1/sessions/${harness.sessionId}/reconciler/share-offer/respond`).send({ action: 'decline' }),
    });
  const state = async () => ({
    offers: await rows(`SELECT status::text AS status, declined_at IS NOT NULL AS declined FROM context_share_offer`),
    consents: await rows(`SELECT decision::text AS decision FROM consent WHERE share_offer_id IS NOT NULL`),
    ada: await rows(
      `SELECT a.status::text AS status FROM empathy_attempt a
       JOIN "user" u ON u.id = a.author_user_id WHERE u.email = 'ada@e2e.test' ORDER BY a.round`,
    ),
  });

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `k5fk33_decline_${process.pid}`,
    });
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('setup: the offer is OFFERED, Ada AWAITING_SHARING, no share-offer consent', async () => {
    expect(await state()).toEqual({
      offers: [{ status: 'OFFERED', declined: false }],
      consents: [],
      ada: [{ status: 'AWAITING_SHARING' }],
    });
  });

  it("a failed move of Ada's round rolls the whole decline back: the offer stays open", async () => {
    const before = await state();
    await rows(`CREATE FUNCTION public.k5fk33_fail_move() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected: the round move failed'; END $$`);
    await rows(`CREATE TRIGGER k5fk33_fail_move BEFORE UPDATE OF status ON empathy_attempt
      FOR EACH ROW EXECUTE FUNCTION public.k5fk33_fail_move()`);
    try {
      const res = await decline();
      expect(res.status).toBe(500);
    } finally {
      await rows(`DROP TRIGGER k5fk33_fail_move ON empathy_attempt`);
      await rows(`DROP FUNCTION public.k5fk33_fail_move()`);
    }
    expect(await state()).toEqual(before);
  });

  it("the retry declines: DECLINED, one DENIED consent, Ada's round READY", async () => {
    const res = await decline();
    expect(res.status).toBe(200);
    expect((res.body as { data: { status: string } }).data.status).toBe('declined');
    expect(await state()).toEqual({
      offers: [{ status: 'DECLINED', declined: true }],
      consents: [{ decision: 'DENIED' }],
      // Bob's own round is HELD, so the reveal gate keeps Ada's at READY.
      ada: [{ status: 'READY' }],
    });
  });

  it('a repeated decline answers "declined" and writes nothing more', async () => {
    const before = await state();
    const res = await decline();
    expect(res.status).toBe(200);
    expect((res.body as { data: { status: string } }).data.status).toBe('declined');
    expect(await state()).toEqual(before);
  });
});
