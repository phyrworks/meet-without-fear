/**
 * Review B1 leftover (work-k5fk.34): the request path writes a self-assertable milestone (compact_signed, feel_heard,
 * needs_confirmed, choices_shared) by its own INSERT; the database now clamps its reached_at as app.reach_milestone
 * clamps a system key's (schema S7) — at most ten minutes back, never ahead — so the app cannot choose when a
 * participant reached it (t_milestone_instant). As mwf_app, identity-bound.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build EMPATHY_SHARED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('a self-assertable milestone’s instant is clamped (t_milestone_instant)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;

  beforeAll(async () => {
    run = await openTargetRun('EMPATHY_SHARED_A', `b3_msi_${process.pid}`);
    ids = await adaAndBob(run);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const insertAs = (key: string, at: string) =>
    run.as<{ reached_at: Date; now: Date }>(
      'mwf_app',
      ids.bobUser,
      `INSERT INTO participant_milestone (session_id, user_id, milestone_key, reached_at) VALUES ($1, $2, $3, $4::timestamptz)
       RETURNING reached_at, CURRENT_TIMESTAMP AS now`,
      [ids.session, ids.bobUser, key, at],
    );

  it('an instant years back is clamped to ten minutes ago; one ahead to now; a recent one stands', async () => {
    const [back] = await insertAs('compact_signed', '2020-01-01T00:00:00Z');
    // reached_at is ts_ms (millisecond precision): within a millisecond of the bound
    expect(Math.abs(back.now.getTime() - back.reached_at.getTime() - 10 * 60 * 1000)).toBeLessThanOrEqual(1);
    const [ahead] = await insertAs('feel_heard', '2099-01-01T00:00:00Z');
    expect(Math.abs(ahead.reached_at.getTime() - ahead.now.getTime())).toBeLessThanOrEqual(1);
    const recent = new Date(Date.now() - 60_000).toISOString();
    const [kept] = await insertAs('needs_confirmed', recent);
    expect(kept.reached_at.toISOString()).toBe(recent);
  });
});
