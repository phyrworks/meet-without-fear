/**
 * Review schema S2 + S3 (work-k5fk.33): the reconciler's writes are serialised
 * on the attempt.
 *
 *   - S3: persistAnalysis and insertOffer lock the attempt (after the session,
 *     the documented order) before they number the next iteration, so two
 *     concurrent analyses of one round take iterations in turn instead of one
 *     failing on (attempt_id, iteration). Shown by holding the attempt's lock
 *     elsewhere: the write waits for it (before: it ran straight through —
 *     an FK check takes only KEY SHARE).
 *   - S2: t_result_live_attempt reads the attempt FOR SHARE, so a result
 *     inserted while a resubmit holds the attempt waits and then sees it
 *     SUPERSEDED (before: it landed on the retired round).
 *
 * RECONCILER_SHOWN_B clone; the AI as mwf_ai scoped to the session.
 */

import { Client } from 'pg';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, appUrlFor, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

/** Resolves to 'pending' if `p` has not settled within `ms`. */
const settledWithin = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise(r => setTimeout(() => r('pending'), ms)),
  ]);

describeTarget('the reconciler writes are serialised on the attempt (review schema S2, S3)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ctx: typeof import('../../lib/request-context');
  let analysis: typeof import('../reconciler/analysis');
  let sharing: typeof import('../reconciler/sharing');
  let bobRound: string;
  const asAi = <T>(fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId: ids.adaUser }, () =>
      ctx.withSessionScope(ids.session, fn),
    );
  /** Another connection holding a lock on the attempt until `release()`. */
  const hold = async (url: string, sql: string, params: unknown[], userId?: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    await c.query('BEGIN');
    if (userId) await c.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    await c.query(sql, params);
    return {
      release: async () => {
        await c.query('COMMIT');
        await c.end();
      },
    };
  };
  const analyse = () =>
    asAi(() =>
      analysis.persistAnalysis({
        attemptId: bobRound,
        sessionId: ids.session,
        authorUserId: ids.bobUser,
        subjectUserId: ids.adaUser,
        result: analysis.getDefaultReconcilerResult(),
        guidance: { areaHint: null, guidanceType: null, promptSeed: null } as never,
      }),
    );

  beforeAll(async () => {
    run = await openTargetRun('RECONCILER_SHOWN_B', `k5fk33_locks_${process.pid}`);
    ids = await adaAndBob(run);
    ctx = await import('../../lib/request-context');
    analysis = await import('../reconciler/analysis');
    sharing = await import('../reconciler/sharing');
    [{ id: bobRound }] = await run.sql<{ id: string }>(
      `SELECT id FROM empathy_attempt WHERE author_user_id = $1 ORDER BY round DESC LIMIT 1`,
      [ids.bobUser],
    );
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('S3: persistAnalysis waits for the attempt lock; concurrent analyses take iterations in turn', async () => {
    const lock = await hold(run.fx.url, `SELECT 1 FROM empathy_attempt WHERE id = $1 FOR NO KEY UPDATE`, [bobRound]);
    const first = analyse();
    try {
      expect(await settledWithin(first, 1500)).toBe('pending');
    } finally {
      await lock.release();
    }
    expect(await first).toEqual(expect.any(String));

    const both = await Promise.all([analyse(), analyse()]);
    expect(both).toEqual([expect.any(String), expect.any(String)]);
    expect(
      await run.sql(
        `SELECT iteration, superseded_at IS NULL AS current FROM reconciler_result WHERE attempt_id = $1 ORDER BY iteration`,
        [bobRound],
      ),
    ).toEqual([
      { iteration: 1, current: false },
      { iteration: 2, current: false },
      { iteration: 3, current: true },
    ]);
  });

  it('S3: insertOffer waits for the attempt lock, then numbers; a round with an open offer gets no second one', async () => {
    const [{ id: resultId }] = await run.sql<{ id: string }>(
      `SELECT id FROM reconciler_result WHERE attempt_id = $1 AND superseded_at IS NULL`,
      [bobRound],
    );
    const offer = () =>
      asAi(() =>
        sharing.insertOffer({
          attemptId: bobRound,
          resultId,
          sessionId: ids.session,
          subjectUserId: ids.adaUser,
          status: 'PENDING',
          suggestedContent: 'PROBE_SUGGESTION',
          suggestedReason: null,
        }),
      );
    const lock = await hold(run.fx.url, `SELECT 1 FROM empathy_attempt WHERE id = $1 FOR NO KEY UPDATE`, [bobRound]);
    const first = offer();
    try {
      expect(await settledWithin(first, 1500)).toBe('pending');
    } finally {
      await lock.release();
    }
    expect(await first).toEqual(expect.any(String));
    expect(await offer()).toBeNull();
    expect(
      await run.sql(`SELECT iteration, status::text AS status FROM context_share_offer WHERE attempt_id = $1`, [
        bobRound,
      ]),
    ).toEqual([{ iteration: 1, status: 'PENDING' }]);
  });

  it('S2: a result inserted while Bob’s resubmit holds the round waits, then is refused on the SUPERSEDED round', async () => {
    const resubmit = await hold(
      appUrlFor(run.fx.target, run.fx.database),
      `SELECT app.empathy_set_status($1::uuid, 'SUPERSEDED'::empathy_status, 'PROBE_ROUND_TWO')`,
      [bobRound],
      ids.bobUser,
    );
    const insert = run.sql(
      `INSERT INTO reconciler_result (attempt_id, session_id, author_user_id, subject_user_id, iteration, alignment_score,
         alignment_summary, gap_summary, gap_severity, recommended_action, rationale, sharing_would_help)
       SELECT a.id, a.session_id, a.author_user_id, a.subject_user_id,
              (SELECT max(x.iteration) + 1 FROM reconciler_result x WHERE x.attempt_id = a.id),
              50, 'x', 'x', 'MINOR', 'PROCEED', 'x', false
       FROM empathy_attempt a WHERE a.id = $1`,
      [bobRound],
    );
    insert.catch(() => undefined);
    try {
      expect(await settledWithin(insert, 1500)).toBe('pending');
    } finally {
      await resubmit.release();
    }
    await expect(insert).rejects.toThrow(/needs a live attempt/);
    // The resubmit expired the round's open offer with it (review services, resubmit from AWAITING_SHARING).
    expect(
      await run.sql(`SELECT status::text AS status FROM context_share_offer WHERE attempt_id = $1`, [bobRound]),
    ).toEqual([{ status: 'EXPIRED' }]);
  });
});
