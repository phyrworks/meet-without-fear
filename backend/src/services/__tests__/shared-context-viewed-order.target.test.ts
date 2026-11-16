/**
 * Step 7 round-2 review R2-1 (work-k5fk.4): the "Seen" watermark
 * (conversation_read_state.last_viewed_share_tab_at) is an INSTANT, and a frame
 * is unread when its created_at is after it. So the lookup of the next received
 * frame after the one viewed must be in time order, not seq order: with frame A
 * (seq n, 10 s ago) and frame B (seq n + 1, 20 s ago), viewing B must leave the
 * watermark before A. In seq order the lookup found no "next" frame, set the
 * watermark to now and marked A seen unviewed.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */

import { isTargetShape } from '../../testing/golden/shape';
import { httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('shared-context-viewed when seq and created_at disagree (review R2-1)', () => {
  let run: TargetRun;
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('viewing the later-seq, earlier-instant frame leaves the other received frame unread', async () => {
    run = await openTargetRun('FEEL_HEARD_B', `k5fk4_scv_${process.pid}`);
    const [ids] = await run.sql<{ session: string; ada: string; bob: string; adaConv: string }>(
      `SELECT ca.session_id AS session, ca.user_id AS ada, cb.user_id AS bob, ca.id AS "adaConv"
       FROM conversation ca JOIN "user" ua ON ua.id = ca.user_id AND ua.email = 'ada@e2e.test'
       JOIN conversation cb ON cb.session_id = ca.session_id AND cb.user_id <> ca.user_id
       WHERE ca.kind = 'MAIN' AND cb.kind = 'MAIN'`,
    );
    const frame = (secsAgo: number) =>
      run.sql<{ seq: number; created_at: Date }>(
        `INSERT INTO message (conversation_id, session_id, sender_user_id, role, kind, content, created_at)
         VALUES ($1, $2, $3, 'USER', 'SHARED_CONTEXT', 'x', now() - make_interval(secs => $4)) RETURNING seq, created_at`,
        [ids.adaConv, ids.session, ids.bob, secsAgo],
      );
    const [a] = await frame(10); // seq n, the later instant
    const [b] = await frame(20); // seq n + 1, the earlier instant
    expect(b.seq).toBe(a.seq + 1);

    const http = await httpAs();
    const r = await http({ id: ids.ada, email: 'ada@e2e.test' }, 'post', `/sessions/${ids.session}/shared-context-viewed`, {
      messageId: `${ids.adaConv}:${b.seq}`,
    });
    expect(r.status).toBe(200);
    const [rs] = await run.sql<{ t: Date }>(
      `SELECT last_viewed_share_tab_at AS t FROM conversation_read_state WHERE session_id = $1 AND user_id = $2`,
      [ids.session, ids.ada],
    );
    // A was never viewed: the watermark covers B but stays before A.
    expect(rs.t.getTime()).toBeGreaterThanOrEqual(new Date(b.created_at).getTime());
    expect(rs.t.getTime()).toBeLessThan(new Date(a.created_at).getTime());
  });
});
