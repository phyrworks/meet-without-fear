/**
 * Step 7 review F2 (work-k5fk.4): every message INSERT now UPDATEs its
 * conversation's next_seq (t_message_seq), so the Serializable reveal
 * (reconciler/state.ts checkAndRevealBothIfReady → app.empathy_set_status →
 * the delivered copies) fails with 40001 when a line commits into either MAIN
 * conversation between its snapshot and its own insert there. The reveal is
 * retried (lib/serializable-retry.ts); the second attempt sees the committed
 * line and reveals both directions exactly once.
 *
 * Deterministic: a job connection holds an uncommitted line in Ada's
 * conversation (its row lock) before the reveal starts; the reveal's copy into
 * Ada's conversation blocks on that lock (observed in pg_locks); the line
 * commits; the reveal's UPDATE then meets a concurrent update.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build RECONCILER_SHOWN_B
 */

import { Client } from 'pg';
import { aiUrlFor } from '../../testing/golden/driver';
import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('the reveal survives a concurrent line in a MAIN conversation (review F2)', () => {
  let run: TargetRun;
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('one serialization failure is retried: both directions revealed, one copy per subject', async () => {
    run = await openTargetRun('RECONCILER_SHOWN_B', `k5fk4_reveal_${process.pid}`);
    process.env.E2E_AUTH_BYPASS = 'true'; // realtime: no Ably key in tests, the E2E path skips the publishes
    const [ids] = await run.sql<{ session: string; adaConv: string }>(
      `SELECT c.session_id AS session, c.id AS "adaConv" FROM conversation c JOIN "user" u ON u.id = c.user_id
       WHERE u.email = 'ada@e2e.test' AND c.kind = 'MAIN'`,
    );
    // Both directions READY (the fixture has AWAITING_SHARING / HELD; the path there is not what this pins).
    await run.sql(`BEGIN; ALTER TABLE empathy_attempt DISABLE TRIGGER USER;
                   UPDATE empathy_attempt SET status = 'READY' WHERE session_id = '${ids.session}';
                   ALTER TABLE empathy_attempt ENABLE TRIGGER USER; COMMIT;`);

    const blocker = new Client({ connectionString: aiUrlFor(run.fx.target, run.fx.database) });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      // The AI writes within its session (app.session_scope; work-k5fk.10.5).
      await blocker.query("SELECT set_config('app.session_scope', $1, true)", [ids.session]);
      await blocker.query(
        `INSERT INTO message (conversation_id, session_id, role, kind, content) VALUES ($1, $2, 'AI', 'CHAT', 'concurrent line')`,
        [ids.adaConv, ids.session],
      );
      const [{ pid }] = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;

      const state = await import('../reconciler/state');
      const { withSessionScope } = await import('../../lib/request-context');
      const reveal = withSessionScope(ids.session, () => state.checkAndRevealBothIfReady(ids.session));
      // Wait until some backend is blocked behind the blocker's row lock — the reveal's copy into Ada's conversation.
      for (let i = 0; ; i++) {
        const [{ n }] = await run.sql<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        );
        if (n > 0) break;
        if (i > 200) throw new Error('the reveal never waited on the conversation row');
        await new Promise(r => setTimeout(r, 25));
      }
      await blocker.query('COMMIT');
      await expect(reveal).resolves.toBe(true);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }

    const attempts = await run.sql<{ status: string }>(
      `SELECT status::text AS status FROM empathy_attempt WHERE session_id = $1 ORDER BY id`,
      [ids.session],
    );
    expect(attempts.map(a => a.status)).toEqual(['REVEALED', 'REVEALED']);
    const copies = await run.sql<{ n: number }>(
      // the delivered copies: a statement in the SUBJECT's conversation (an author's own copy is in theirs)
      `SELECT count(*)::int AS n FROM message m JOIN conversation c ON c.id = m.conversation_id
       WHERE m.session_id = $1 AND m.kind = 'EMPATHY_STATEMENT' AND m.sender_user_id <> c.user_id
       GROUP BY m.conversation_id ORDER BY m.conversation_id`,
      [ids.session],
    );
    expect(copies.map(c => c.n)).toEqual([1, 1]);
    const [{ lines }] = await run.sql<{ lines: number }>(
      `SELECT count(*)::int AS lines FROM message WHERE conversation_id = $1 AND content = 'concurrent line'`,
      [ids.adaConv],
    );
    expect(lines).toBe(1);
  });
});
