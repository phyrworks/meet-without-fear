/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture: the
 * session summary on the target — read from the participant's MAIN
 * conversation as mwf_app (identity-bound), stored as the participant's
 * ai_memory SUMMARY document by mwf_job. Haiku is stubbed at lib/bedrock.
 *   - lastUnresolvedThread persisted; forced to null when the stage just
 *     advanced; null when the model omits it;
 *   - the structural hints (partner not joined, milestone) reach the prompt,
 *     and are absent when none are given;
 *   - the long-idle resumption refresh: no activity / not idle / fresh / refreshed.
 *
 * Replaces the Prisma-mock suite services/__tests__/conversation-summarizer.test.ts.
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('the session summary on the target (read by mwf_app, written by mwf_job)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ctx: typeof import('../../lib/request-context');
  let summarizer: typeof import('../conversation-summarizer');
  let bedrock: typeof import('../../lib/bedrock');
  let haiku: jest.SpyInstance;
  const asAda = <T>(fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId: ids.adaUser }, async () => await fn());
  const modelSays = (extra: Record<string, unknown> = {}) =>
    haiku.mockResolvedValue({ summary: 'PROBE_TS12_SUMMARY', keyThemes: ['t'], emotionalJourney: 'j', unresolvedTopics: [], ...extra } as never);
  const stored = async () =>
    (await run.sql<{ doc: Record<string, unknown> }>(`SELECT doc FROM ai_memory WHERE participant_id = $1 AND kind = 'SUMMARY'`, [ids.ada]))[0]?.doc ?? null;
  const prompt = () => (haiku.mock.calls[0][0] as { systemPrompt: string }).systemPrompt;

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_summary_${process.pid}`);
    ids = await adaAndBob(run);
    ctx = await import('../../lib/request-context');
    summarizer = await import('../conversation-summarizer');
    bedrock = await import('../../lib/bedrock');
    // 30 more turns in Ada's MAIN conversation, an hour ago and older
    const [c] = await run.sql<{ id: string }>(`SELECT id FROM conversation WHERE participant_id = $1 AND kind = 'MAIN'`, [ids.ada]);
    for (let i = 0; i < 30; i++) {
      const user = i % 2 === 0;
      await run.sql(
        `INSERT INTO message (conversation_id, sender_participant_id, role, content, created_at)
         VALUES ($1, $2, $3::message_role, $4, now() - make_interval(mins => 60 + 30 - $5::int))`,
        [c.id, user ? ids.ada : null, user ? 'USER' : 'AI', `turn ${i} with enough content to make token estimation meaningful`, i],
      );
    }
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (run) await run.drop();
  });
  beforeEach(async () => {
    haiku = jest.spyOn(bedrock, 'getHaikuJson');
    await run.sql(`DELETE FROM ai_memory WHERE participant_id = $1 AND kind = 'SUMMARY'`, [ids.ada]);
  });
  afterEach(() => haiku.mockRestore());

  it('persists lastUnresolvedThread into ai_memory SUMMARY; no structural hints without hints', async () => {
    modelSays({ lastUnresolvedThread: 'Ada was still sitting with the feeling that trust had been eroding.' });
    const summary = await asAda(() => summarizer.updateSessionSummary(ids.session, ids.adaUser, 'turn-1'));
    expect(summary).not.toBeNull();
    const doc = await stored();
    expect(doc).toMatchObject({ text: 'PROBE_TS12_SUMMARY', lastUnresolvedThread: expect.stringContaining('trust had been eroding') });
    expect(prompt()).not.toContain('STRUCTURAL CONTEXT');
  });

  it('stageJustAdvanced forces lastUnresolvedThread to null and puts the milestone instruction in the prompt', async () => {
    modelSays({ lastUnresolvedThread: 'Phantom unresolved tension the model invented' });
    await asAda(() => summarizer.updateSessionSummary(ids.session, ids.adaUser, 'turn-2', { stageJustAdvanced: true }));
    expect((await stored())?.lastUnresolvedThread).toBeNull();
    expect(prompt()).toContain('milestone reached');
    expect(prompt()).toContain('MUST be null');
  });

  it('an omitted lastUnresolvedThread is stored as null; partner-not-joined framing reaches the prompt', async () => {
    modelSays();
    await asAda(() => summarizer.updateSessionSummary(ids.session, ids.adaUser, 'turn-3', { partnerStatus: 'not_joined' }));
    expect(await stored()).toMatchObject({ lastUnresolvedThread: null });
    expect(prompt()).toContain('has not yet joined this session');
    expect(prompt()).toContain('do NOT anticipate a direct partner response');
  });

  it('long-idle resumption: no activity, not idle, fresh summary, and a refresh when stale or missing', async () => {
    const now = new Date();
    const idle = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const call = (lastUserTurnAt: Date | null) =>
      asAda(() => summarizer.maybeRefreshSummaryForResumption({ sessionId: ids.session, userId: ids.adaUser, turnId: 't', lastUserTurnAt, now }));
    modelSays();
    expect(await call(null)).toBe('no_user_activity');
    expect(await call(new Date(now.getTime() - 10 * 60 * 1000))).toBe('not_idle');
    expect(haiku).not.toHaveBeenCalled();

    expect(await call(idle)).toBe('refreshed'); // no summary at all
    expect(haiku).toHaveBeenCalledTimes(1);
    expect(await stored()).not.toBeNull();
    expect(await call(idle)).toBe('summary_fresh'); // generatedAt is after the last user turn
    expect(haiku).toHaveBeenCalledTimes(1);

    await run.sql(`UPDATE ai_memory SET doc = jsonb_set(doc, '{generatedAt}', to_jsonb($2::text)) WHERE participant_id = $1 AND kind = 'SUMMARY'`, [
      ids.ada,
      new Date(idle.getTime() - 60_000).toISOString(),
    ]);
    expect(await call(idle)).toBe('refreshed');
  });

  it('LONG_IDLE_RESUMPTION_THRESHOLD_MS is 24 hours', () => {
    expect(summarizer.LONG_IDLE_RESUMPTION_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
  });
});
