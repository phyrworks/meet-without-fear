/**
 * Review services#2 and #4 (work-k5fk.33), driven over HTTP on a FEEL_HEARD_B
 * clone taken to the mutual reveal (as message-once-stage2.target.test.ts).
 *
 *   - services#2: the reveal pre-check counts what the database gate counts
 *     (READY, REVEALED, VALIDATED). Bob sends feedback on Ada's round
 *     (REFINING), Ada skips refinement while Bob's round is still REVEALED:
 *     Ada's round is re-revealed at once — before the fix it stayed READY for
 *     good and Bob's validate answered 409.
 *   - services#4: validate + feedback is one transaction. A failed send
 *     writes nothing (no review text, no consent, no move, no note, no card);
 *     a second "not quite" on the re-revealed round (one card per source
 *     attempt, MWE01) is refused before any write.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { listTables, withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('Stage 2 after feedback: skip re-reveals beside a REVEALED round; a send is all or nothing', () => {
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
  /** The current round of the direction whose author has this email. */
  const roundBy = async (email: string) =>
    (
      await rows<{ id: string; status: string; version: number }>(
        `SELECT a.id, a.status::text AS status, a.status_version AS version
         FROM empathy_attempt a JOIN "user" u ON u.id = a.author_user_id
         WHERE u.email = $1 ORDER BY a.round DESC LIMIT 1`,
        [email],
      )
    )[0];
  /** What Bob's sends leave behind: his review of Ada's round, its consents, and Ada's chat. */
  const sendTrace = async () => ({
    review: await rows(
      `SELECT r.validated, r.feedback, r.feedback_sent_at IS NOT NULL AS sent FROM empathy_review r
       JOIN "user" u ON u.id = r.reviewer_user_id WHERE u.email = 'bob@e2e.test'`,
    ),
    consents: await rows<{ n: number }>(`SELECT count(*)::int AS n FROM consent WHERE review_id IS NOT NULL`),
    adaChat: await rows<{ role: string; kind: string; n: number }>(
      `SELECT m.role::text AS role, m.kind::text AS kind, count(*)::int AS n FROM message m
       JOIN conversation c ON c.id = m.conversation_id AND c.kind = 'MAIN'
       JOIN "user" u ON u.id = c.user_id WHERE u.email = 'ada@e2e.test' GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
  });
  const cards = (t: Awaited<ReturnType<typeof sendTrace>>) =>
    t.adaChat.find(r => r.kind === 'VALIDATION_FEEDBACK')?.n ?? 0;

  beforeAll(async () => {
    harness = await createHarness({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `k5fk33_skip_${process.pid}` });
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    for (const [label, path, body] of [
      ['draft as bob', 'draft', { content: 'I think you felt unseen when the plans changed.', readyToShare: true }],
      ['consent as bob', 'consent', { consent: true }],
    ] as const) {
      const res = await harness.step({
        label,
        actor: harness.actors.userB!,
        tables: scope,
        asyncBoundary: true,
        call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/empathy/${path}`).send(body),
      });
      expect(res.status).toBe(200);
    }
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (harness) await harness.teardown();
  });

  it('setup: both rounds revealed, no review yet', async () => {
    expect((await roundBy('ada@e2e.test')).status).toBe('REVEALED');
    expect((await roundBy('bob@e2e.test')).status).toBe('REVEALED');
    expect((await sendTrace()).review).toEqual([]);
  });

  it('a send that fails part-way writes nothing: no review text, consent, move, note or card', async () => {
    const before = await sendTrace();
    const adaBefore = await roundBy('ada@e2e.test');
    const store = await import('../empathy-store');
    jest.spyOn(store, 'markAttemptDelivery').mockRejectedValueOnce(new Error('injected: delivery stamp failed'));
    const res = await post('userB', '/empathy/validate', { validated: false, feedback: 'PROBE_FEEDBACK_ONE' });
    expect(res.status).toBe(500);
    expect(await roundBy('ada@e2e.test')).toEqual(adaBefore);
    expect(await sendTrace()).toEqual(before);
  });

  it("Bob's feedback moves Ada's round to REFINING with one framing note and one card", async () => {
    const before = await sendTrace();
    const res = await post('userB', '/empathy/validate', { validated: false, feedback: 'PROBE_FEEDBACK_ONE' });
    expect(res.status).toBe(200);
    expect((await roundBy('ada@e2e.test')).status).toBe('REFINING');
    const after = await sendTrace();
    expect(cards(after)).toBe(1);
    expect(after.consents).toEqual([{ n: 1 }]);
    const ai = (t: typeof after) => t.adaChat.find(r => r.role === 'AI' && r.kind === 'CHAT')?.n ?? 0;
    expect(ai(after)).toBe(ai(before) + 1);
  });

  it("Ada skips refinement while Bob's round is REVEALED: her round is revealed again at once (services#2)", async () => {
    expect((await roundBy('bob@e2e.test')).status).toBe('REVEALED');
    const res = await post('userA', '/empathy/skip-refinement', { willingToAccept: true });
    expect(res.status).toBe(200);
    expect((res.body as { data: { status: string } }).data.status).toBe('REVEALED');
    expect((await roundBy('ada@e2e.test')).status).toBe('REVEALED');
  });

  it('a second "not quite" on the re-revealed round is refused (409) before any write', async () => {
    const before = await sendTrace();
    const adaBefore = await roundBy('ada@e2e.test');
    const res = await post('userB', '/empathy/validate', { validated: false, feedback: 'PROBE_FEEDBACK_TWO' });
    expect(res.status).toBe(409);
    expect(await roundBy('ada@e2e.test')).toEqual(adaBefore);
    expect(await sendTrace()).toEqual(before);
  });

  it('both validate and Stage 2 completes (Bob no longer gets 409)', async () => {
    expect((await post('userA', '/empathy/validate', { validated: true })).status).toBe(200);
    expect((await post('userB', '/empathy/validate', { validated: true })).status).toBe(200);
    expect((await roundBy('ada@e2e.test')).status).toBe('VALIDATED');
    expect((await roundBy('bob@e2e.test')).status).toBe('VALIDATED');
    // The validation kept the feedback Ada was sent (fix1 m3).
    const [review] = (await sendTrace()).review as Array<{ validated: boolean; sent: boolean }>;
    expect(review).toMatchObject({ validated: true, sent: true });
  });
});
