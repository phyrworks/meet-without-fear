/**
 * work-fdc1: Stage 2's hold-here note (POST /empathy/validate with
 * validated: true while the partner has not validated yours) is written once
 * per conversation, keyed by dedupe_key STAGE2_VALIDATED_WAIT — no digest of
 * its text. A repeated validate and two concurrent ones add no second note.
 *
 * FEEL_HEARD_B clone driven to the mutual reveal (as review-visibility.target.test.ts),
 * app as mwf_app with identity binding on, job as mwf_job.
 * Requires: npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { listTables, withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget("Stage 2 hold-here note: once per conversation, keyed, not hashed (work-fdc1)", () => {
  let harness: Harness;
  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql, params)).rows, harness.fixture.database);
  const post = (who: 'userA' | 'userB', path: string, body: object) =>
    harness.step({
      label: `${path} as ${who}`,
      actor: harness.actors[who]!,
      tables: [],
      call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}${path}`).send(body),
    });
  const notes = (email: string) =>
    rows<{ role: string; content: string }>(
      `SELECT m.role::text AS role, m.content FROM message m
         JOIN conversation c ON c.id = m.conversation_id AND c.kind = 'MAIN'
         JOIN participant p ON p.id = c.participant_id JOIN "user" u ON u.id = p.user_id
        WHERE u.email = $1 AND m.dedupe_key = 'STAGE2_VALIDATED_WAIT'`,
      [email],
    );

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'FEEL_HEARD_B',
      runId: `fdc1_wait_${process.pid}`,
    });
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const bob = harness.actors.userB!;
    for (const [label, path, body] of [
      ['draft as bob', 'draft', { content: 'I think you felt unseen when the plans changed.', readyToShare: true }],
      ['consent as bob', 'consent', { consent: true }],
    ] as const) {
      const res = await harness.step({
        label,
        actor: bob,
        tables: scope,
        asyncBoundary: true,
        call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/empathy/${path}`).send(body),
      });
      expect(res.status).toBe(200);
    }
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('setup: both rounds revealed, no note yet', async () => {
    expect(
      await rows(`SELECT status::text AS s FROM empathy_attempt ORDER BY round`).then(r => r.map(x => x.s)),
    ).toEqual(['REVEALED', 'REVEALED']);
    expect(await notes('ada@e2e.test')).toEqual([]);
  });

  it("Ada's validate writes the note once; a repeat and two concurrent validates add nothing", async () => {
    const first = await post('userA', '/empathy/validate', { validated: true });
    expect(first.status).toBe(200);
    expect((first.body as { data: { partnerValidated: boolean } }).data.partnerValidated).toBe(false);
    const once = await notes('ada@e2e.test');
    expect(once).toEqual([{ role: 'AI', content: expect.stringContaining("We'll hold here") }]);

    expect((await post('userA', '/empathy/validate', { validated: true })).status).toBe(200);
    const both = await Promise.all([
      post('userA', '/empathy/validate', { validated: true }),
      post('userA', '/empathy/validate', { validated: true }),
    ]);
    // Only the note is under test here. The two verdicts race on the reviewer's own
    // empathy_review row and the attempt's status move (not on the note), so the
    // losing call may answer non-200 (e.g. a unique or serialization conflict on
    // the review); what must hold is that at least one lands and the note stays one row.
    expect(both.some(r => r.status === 200)).toBe(true);
    expect(await notes('ada@e2e.test')).toEqual(once);
    expect(await notes('bob@e2e.test')).toEqual([]);
  });
});
