/**
 * Step 7 review F1 (work-k5fk.4): getInitialMessage's idempotency probe must be
 * "the conversation holds no line", not "seq 1 exists". A failed first stream
 * turn writes the user's line (seq 1) and deletes it (stream-turn-persistence),
 * so the conversation is empty while seq 1 is a hole and next_seq is 2: a
 * "seq 1 exists" probe let three concurrent calls write three greetings (2, 3,
 * 4 — measured by the reviewer on bc3226b8). Its own file: the app binds to
 * the first run database it is loaded against.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('getInitialMessage on an empty conversation whose seq 1 is a hole (review F1)', () => {
  let run: TargetRun;
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('three concurrent calls write one line, and all answer it', async () => {
    run = await openTargetRun('CREATED', `k5fk4_hole_${process.pid}`);
    const [p] = await run.sql<{ session: string; user: string; conv: string; email: string }>(
      `SELECT c.session_id AS session, c.user_id AS user, c.id AS conv, u.email FROM conversation c JOIN "user" u ON u.id = c.user_id`,
    );
    // A failed first stream turn: the user's line is written (seq 1) and deleted.
    await run.as(
      'mwf_app',
      p.user,
      `INSERT INTO message (conversation_id, session_id, sender_user_id, role, kind, content) VALUES ($1, $2, $3, 'USER', 'CHAT', 'x')`,
      [p.conv, p.session, p.user],
    );
    await run.as('mwf_app', p.user, `DELETE FROM message WHERE conversation_id = $1`, [p.conv]);
    const http = await httpAs();
    const me = { id: p.user, email: p.email };
    const answers = await Promise.all([1, 2, 3].map(() => http(me, 'post', `/sessions/${p.session}/messages/initial`)));
    const rows = await run.sql<{ seq: number }>(`SELECT seq FROM message WHERE conversation_id = $1 ORDER BY seq`, [
      p.conv,
    ]);
    expect(rows).toEqual([{ seq: 2 }]);
    expect(answers.map(a => a.status)).toEqual([200, 200, 200]);
    for (const a of answers) expect(a.body.data.message).toMatchObject({ id: `${p.conv}:2`, seq: 2 });
  });
});
