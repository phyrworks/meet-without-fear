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
import { jobUrlFor } from '../../testing/golden/driver';
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
    const [ids] = await run.sql<{ session: string; adaConv: string }>(
      `SELECT c.session_id AS session, c.id AS "adaConv" FROM conversation c JOIN "user" u ON u.id = c.user_id
       WHERE u.email = 'ada@e2e.test' AND c.kind = 'MAIN'`,
    );
    // Both directions READY (the fixture has AWAITING_SHARING / HELD; the path there is not what this pins).
    await run.sql(`BEGIN; ALTER TABLE empathy_attempt DISABLE TRIGGER USER;
                   UPDATE empathy_attempt SET status = 'READY' WHERE session_id = '${ids.session}';
                   ALTER TABLE empathy_attempt ENABLE TRIGGER USER; COMMIT;`);

    const blocker = new Client({ connectionString: jobUrlFor(run.fx.target, run.fx.database) });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `INSERT INTO message (conversation_id, session_id, role, kind, content) VALUES ($1, $2, 'AI', 'CHAT', 'concurrent line')`,
        [ids.adaConv, ids.session],
      );
      const [{ pid }] = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;

      const state = await import('../reconciler/state');
      const reveal = state.checkAndRevealBothIfReady(ids.session);
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
      `SELECT count(*)::int AS n FROM message WHERE session_id = $1 AND kind = 'EMPATHY_STATEMENT' AND source_attempt_id IS NOT NULL
       GROUP BY conversation_id ORDER BY conversation_id`,
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
