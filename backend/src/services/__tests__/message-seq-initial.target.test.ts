/**
 * work-k5fk.4 (design note §5): getInitialMessage's idempotency probe is "does
 * seq 1 exist". Two concurrent POST /messages/initial on an empty conversation
 * queue on the conversation row (t_message_seq) and the Serializable loser
 * retries, so exactly one line is written, at seq 1, and both calls answer it.
 * Its own file: the app (lib/prisma) binds to the run database it is first
 * loaded against, so a second fixture needs a fresh module registry.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('getInitialMessage is idempotent on seq 1 (work-k5fk.4)', () => {
  let run: TargetRun;
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('two concurrent calls on an empty conversation write one line, seq 1, and both answer it', async () => {
    run = await openTargetRun('CREATED', `k5fk4_init_${process.pid}`);
    const [p] = await run.sql<{ session: string; user: string; conv: string; email: string }>(
      `SELECT c.session_id AS session, c.user_id AS user, c.id AS conv, u.email FROM conversation c JOIN "user" u ON u.id = c.user_id`,
    );
    const http = await httpAs();
    const me = { id: p.user, email: p.email };
    const [a, b] = await Promise.all([
      http(me, 'post', `/sessions/${p.session}/messages/initial`),
      http(me, 'post', `/sessions/${p.session}/messages/initial`),
    ]);
    const rows = await run.sql<{ seq: number }>(`SELECT seq FROM message WHERE conversation_id = $1`, [p.conv]);
    expect({ rows, statuses: [a.status, b.status] }).toEqual({ rows: [{ seq: 1 }], statuses: [200, 200] });
    for (const r of [a, b]) expect(r.body.data.message).toMatchObject({ id: `${p.conv}:1`, seq: 1 });
    // A later call refuses: the conversation is no longer empty.
    expect((await http(me, 'post', `/sessions/${p.session}/messages/initial`)).status).toBe(400);
  });
});
