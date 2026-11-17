/**
 * work-2km7: EMPATHY_SHARED_A is seeded post-accept (the invitation ACCEPTED,
 * the session ACTIVE, Bob a participant), so accepting it again is refused as
 * already accepted — before work-2km7 the writer had pre-attached Bob to a
 * PENDING invitation and accept collided on participant (session_id, user_id)
 * with a 500.
 *
 * Its own file: one app harness per test file (lib/prisma caches its client on
 * globalThis, pointed at the first run database).
 *
 * Requires: npx tsx src/testing/golden/cli.ts build EMPATHY_SHARED_A
 */

import { withClient } from '../../golden/db';
import { isTargetShape } from '../../golden/shape';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('EMPATHY_SHARED_A is seeded post-accept (work-2km7)', () => {
  const BASE_URL =
    process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

  it('a second accept is refused as already accepted, not a 500, and changes nothing', async () => {
    const { createHarness } = await import('../../golden/driver');
    const harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'EMPATHY_SHARED_A',
      runId: `2km7_esa_${process.pid}`,
    });
    try {
      const step = await harness.step({
        label: 'accept as bob',
        actor: harness.actors.userB!,
        tables: [],
        call: agent => agent.post(`/api/invitations/${harness.fixture.manifest.seeded.invitationId}/accept`).send({}),
      });
      const rows = await withClient(
        harness.fixture.target,
        async c =>
          (
            await c.query(
              `SELECT s.status::text AS session, i.status::text AS invitation,
                      (SELECT count(*)::int FROM participant p WHERE p.session_id = s.id) AS participants
               FROM session s JOIN invitation i ON i.session_id = s.id`,
            )
          ).rows,
        harness.fixture.database,
      );
      expect({
        status: step.status,
        message: (step.body as { error?: { message?: string } } | undefined)?.error?.message,
        rows,
      }).toEqual({
        status: 400,
        message: 'Invitation has already been accepted',
        rows: [{ session: 'ACTIVE', invitation: 'ACCEPTED', participants: 2 }],
      });
    } finally {
      await harness.teardown();
    }
  });
});
