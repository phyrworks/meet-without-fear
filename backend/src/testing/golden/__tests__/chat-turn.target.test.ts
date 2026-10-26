/**
 * TS-9 smoke: one streaming chat turn end to end on the TARGET shape, through
 * the real app (MOCK_LLM), on a clone of the FEEL_HEARD_B target fixture.
 * Not a golden (nothing recorded): it pins that the rewritten pipeline writes
 * the user's turn and the AI reply into the caller's OWN conversation, never
 * the partner's, and that the partner's reads do not change.
 *
 * Requires a built target fixture: npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */

import { createHarness, type Harness } from '../driver';
import { withClient } from '../db';
import { isTargetShape } from '../shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('chat turn on the target (smoke)', () => {
  let harness: Harness;
  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql, params)).rows, harness.fixture.database);
  const counts = () =>
    rows<{ email: string; n: number }>(
      `SELECT u.email, count(m.id)::int AS n FROM conversation c
       JOIN participant p ON p.id = c.participant_id JOIN "user" u ON u.id = p.user_id
       LEFT JOIN message m ON m.conversation_id = c.id GROUP BY u.email ORDER BY u.email`,
    );

  beforeAll(async () => {
    harness = await createHarness({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `chat_turn_${process.pid}` });
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it("streams a turn: the user's message and the AI reply land in Ada's conversation only", async () => {
    const before = await counts();
    const bobBefore = await harness.step({
      label: 'messages as bob (before)',
      actor: harness.actors.userB!,
      tables: [],
      call: agent => agent.get(`/api/v1/sessions/${harness.sessionId}/messages`),
    });

    const step = await harness.step({
      label: 'stream as ada',
      actor: harness.actors.userA,
      tables: ['message'],
      sse: true,
      asyncBoundary: true,
      call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/messages/stream`).send({ content: 'TS9_SMOKE_TURN' }),
    });
    expect(step.status).toBe(200);
    const events = (step.sse ?? []).map(e => e.event);
    expect(events).toContain('user_message');
    expect(events).toContain('complete');
    expect(events).not.toContain('error');

    const after = await counts();
    const delta = Object.fromEntries(after.map(a => [a.email, a.n - (before.find(b => b.email === a.email)?.n ?? 0)]));
    expect(delta).toEqual({ 'ada@e2e.test': 2, 'bob@e2e.test': 0 });

    const written = await rows<{ role: string; kind: string; sender: string | null; content: string }>(
      `SELECT m.role::text AS role, m.kind::text AS kind, u.email AS sender, m.content
       FROM message m LEFT JOIN participant p ON p.id = m.sender_participant_id LEFT JOIN "user" u ON u.id = p.user_id
       ORDER BY m.created_at DESC, m.id DESC LIMIT 2`,
    );
    expect(written.map(w => [w.role, w.kind, w.sender])).toEqual([
      ['AI', 'CHAT', null],
      ['USER', 'CHAT', 'ada@e2e.test'],
    ]);
    expect(written[1].content).toBe('TS9_SMOKE_TURN');

    // Bob's reads are unchanged by Ada's turn.
    const bobAfter = await harness.step({
      label: 'messages as bob (after)',
      actor: harness.actors.userB!,
      tables: [],
      call: agent => agent.get(`/api/v1/sessions/${harness.sessionId}/messages`),
    });
    expect(bobAfter.body).toEqual(bobBefore.body);
    expect(JSON.stringify(bobAfter.body)).not.toContain('TS9_SMOKE_TURN');
  });
});
