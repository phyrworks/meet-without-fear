/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture: the
 * reflection cluster (Inner Thoughts, takeaways, links, themes, distillation)
 * on `reflection` / `reflection_message` / `takeaway` / `takeaway_link` /
 * `v_reflection_theme`, over HTTP as `mwf_app` with identity binding on.
 *
 * Replaces the Prisma-mock suites routes/__tests__/inner-thoughts.test.ts,
 * services/__tests__/knowledge-base.test.ts and the distillSession half of
 * services/__tests__/distillation.test.ts (the pure halves stay there).
 *
 * What it pins:
 *   - everything is the caller's own (spec §1.6 RLS shape: reflection.user_id
 *     = me): Bob reads none of Ada's reflection, takeaways or links;
 *   - a link's id is its composite key `<source>.<target>`; only USER_MANUAL
 *     links delete; `resolved` is `resolved_at IS NOT NULL`;
 *   - themes come from v_reflection_theme with the 3-reflection threshold;
 *   - re-distillation replaces AI takeaways and keeps USER ones, and stamps
 *     distilled_at (the LLM boundary is stubbed; no Prisma mock anywhere);
 *   - semantic search answers an empty result (D8).
 *
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Http = Awaited<ReturnType<typeof httpAs>>;

describeTarget('reflection cluster on the target, as mwf_app with identity binding on', () => {
  let run: TargetRun;
  let http: Http;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };
  let reflectionId: string;
  const takeaway: Record<string, string> = {};

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_reflection_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
    [{ id: reflectionId }] = await run.sql<{ id: string }>(`SELECT id FROM reflection WHERE user_id = $1`, [ada.id]);
    for (const [key, content, type, source] of [
      ['insight', 'PROBE_TAKEAWAY_INSIGHT keeping score is how I stay safe', 'INSIGHT', 'AI'],
      ['action', 'PROBE_TAKEAWAY_ACTION ask Bob to split the Sunday chores', 'ACTION_ITEM', 'USER'],
    ] as const) {
      const [row] = await run.sql<{ id: string }>(
        `INSERT INTO takeaway (reflection_id, content, type, source, position) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [reflectionId, content, type, source, Object.keys(takeaway).length],
      );
      takeaway[key] = row.id;
    }
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (run) await run.drop();
  });

  it("Bob reads none of Ada's reflection; Ada reads hers", async () => {
    const bobList = await http(bob, 'get', '/inner-thoughts');
    expect(bobList.status).toBe(200);
    expect(bobList.body.data).toEqual({ sessions: [], total: 0, hasMore: false });
    const bobGet = await http(bob, 'get', `/inner-thoughts/${reflectionId}`);
    expect(bobGet.status).toBe(400);
    expect(JSON.stringify(bobGet.body)).not.toContain('Keeping score');
    expect((await http(bob, 'get', `/sessions/${ids.session}/inner-thoughts`)).body.data).toEqual({
      innerThoughtsSessionId: null,
    });

    const adaGet = await http(ada, 'get', `/inner-thoughts/${reflectionId}`);
    expect(adaGet.status).toBe(200);
    expect(adaGet.body.data.session).toMatchObject({
      id: reflectionId,
      linkedPartnerSessionId: ids.session,
      linkedAtMessageId: null,
      messageCount: 2,
    });
    expect(adaGet.body.data.session.messages.map((m: { role: string }) => m.role)).toEqual(['USER', 'AI']);
    expect((await http(ada, 'get', `/sessions/${ids.session}/inner-thoughts`)).body.data).toEqual({
      innerThoughtsSessionId: reflectionId,
    });
  });

  it("takeaways: Ada's own, with resolved derived from resolved_at; Bob gets 404", async () => {
    const got = await http(ada, 'get', `/inner-thoughts/${reflectionId}/takeaways`);
    expect(got.status).toBe(200);
    expect(got.body.data.takeaways.map((t: { id: string; resolved: boolean }) => [t.id, t.resolved])).toEqual([
      [takeaway.insight, false],
      [takeaway.action, false],
    ]);
    expect((await http(bob, 'get', `/inner-thoughts/${reflectionId}/takeaways`)).status).toBe(404);
    expect((await http(bob, 'get', `/knowledge-base/recent`)).body.data.takeaways).toEqual([]);
    expect(
      (await http(ada, 'get', `/knowledge-base/recent`)).body.data.takeaways.map((t: { id: string }) => t.id).sort(),
    ).toEqual([takeaway.insight, takeaway.action].sort());
  });

  it('links: composite id, both directions, owner only, USER_MANUAL only deletes', async () => {
    const created = await http(ada, 'post', `/knowledge-base/takeaways/${takeaway.insight}/links`, {
      targetId: takeaway.action,
    });
    expect(created.status).toBe(201);
    const linkId = `${takeaway.insight}.${takeaway.action}`;
    expect(created.body.data.link).toMatchObject({
      id: linkId,
      linkType: 'USER_MANUAL',
      linkedTakeaway: { id: takeaway.action },
    });
    expect(
      (await http(ada, 'post', `/knowledge-base/takeaways/${takeaway.insight}/links`, { targetId: takeaway.action }))
        .status,
    ).toBe(409);

    const fromTarget = await http(ada, 'get', `/knowledge-base/takeaways/${takeaway.action}/links`);
    expect(
      fromTarget.body.data.links.map((l: { id: string; linkedTakeaway: { id: string } }) => [
        l.id,
        l.linkedTakeaway.id,
      ]),
    ).toEqual([[linkId, takeaway.insight]]);
    const thread = await http(ada, 'get', `/knowledge-base/takeaways/${takeaway.insight}/thread`);
    expect(thread.body.data.thread.map((t: { id: string }) => t.id)).toEqual([takeaway.action]);

    expect((await http(bob, 'get', `/knowledge-base/takeaways/${takeaway.action}/links`)).status).toBe(404);
    expect(
      (await http(bob, 'post', `/knowledge-base/takeaways/${takeaway.insight}/links`, { targetId: takeaway.action }))
        .status,
    ).toBe(404);
    expect((await http(bob, 'delete', `/knowledge-base/takeaways/${takeaway.insight}/links/${linkId}`)).status).toBe(
      404,
    );

    // An AI link cannot be deleted by the user.
    await run.sql(
      `INSERT INTO takeaway_link (source_id, target_id, link_type, similarity) VALUES ($1, $2, 'AI_SEMANTIC', 0.8)`,
      [takeaway.action, takeaway.insight],
    );
    expect(
      (
        await http(
          ada,
          'delete',
          `/knowledge-base/takeaways/${takeaway.action}/links/${takeaway.action}.${takeaway.insight}`,
        )
      ).status,
    ).toBe(400);
    expect((await http(ada, 'delete', `/knowledge-base/takeaways/${takeaway.insight}/links/${linkId}`)).status).toBe(
      200,
    );
    expect(await run.sql(`SELECT link_type::text AS t FROM takeaway_link ORDER BY 1`)).toEqual([{ t: 'AI_SEMANTIC' }]);
  });

  it('resolve toggles resolved_at; the open/resolved action lists follow it', async () => {
    const r1 = await http(ada, 'patch', `/knowledge-base/takeaways/${takeaway.action}/resolve`);
    expect(r1.status).toBe(200);
    expect(r1.body.data.takeaway.resolved).toBe(true);
    expect(r1.body.data.takeaway.resolvedAt).not.toBeNull();
    expect(
      (await http(ada, 'get', `/knowledge-base/actions?status=resolved`)).body.data.actions.map(
        (a: { id: string }) => a.id,
      ),
    ).toEqual([takeaway.action]);
    expect((await http(ada, 'get', `/knowledge-base/actions?status=open`)).body.data.actions).toEqual([]);
    expect((await http(bob, 'patch', `/knowledge-base/takeaways/${takeaway.action}/resolve`)).status).toBe(404);
    const r2 = await http(ada, 'patch', `/knowledge-base/takeaways/${takeaway.action}/resolve`);
    expect(r2.body.data.takeaway).toMatchObject({ resolved: false, resolvedAt: null });
  });

  it('themes come from v_reflection_theme: a theme recurs on 3 reflections, and only for its owner', async () => {
    const theme = 'inherited resentment about rest';
    expect((await http(ada, 'get', `/knowledge-base/themes`)).body.data.themes).toEqual([]);
    for (const title of ['second', 'third']) {
      await run.sql(`INSERT INTO reflection (user_id, title, theme) VALUES ($1, $2, $3)`, [ada.id, title, theme]);
    }
    const themes = (await http(ada, 'get', `/knowledge-base/themes`)).body.data.themes;
    expect(themes).toEqual([expect.objectContaining({ tag: theme, sessionCount: 3, summary: '' })]);
    expect((await http(bob, 'get', `/knowledge-base/themes`)).body.data.themes).toEqual([]);
    const topics = (await http(ada, 'get', `/knowledge-base/topics`)).body.data.topics;
    expect(topics).toEqual([expect.objectContaining({ tag: theme, sessionCount: 3, takeawayCount: 2 })]);
  });

  it('re-distillation replaces AI takeaways, keeps USER ones, stamps distilled_at', async () => {
    const bedrock = await import('../../lib/bedrock');
    jest.spyOn(bedrock, 'getHaikuJson').mockResolvedValue({
      takeaways: [
        { content: 'PROBE_DISTILLED one', type: 'insight' },
        { content: 'PROBE_DISTILLED two', type: 'action_item' },
      ],
    } as never);
    await run.sql(
      `INSERT INTO reflection_message (reflection_id, role, content) VALUES ($1, 'USER', 'a second line of mine')`,
      [reflectionId],
    );
    expect((await http(bob, 'post', `/inner-thoughts/${reflectionId}/distill`)).status).toBe(404);
    const res = await http(ada, 'post', `/inner-thoughts/${reflectionId}/distill`);
    expect(res.status).toBe(200);
    const rows = await run.sql<{ content: string; source: string; type: string }>(
      `SELECT content, source::text AS source, type::text AS type FROM takeaway WHERE reflection_id = $1 ORDER BY source, content`,
      [reflectionId],
    );
    expect(rows).toEqual([
      { content: 'PROBE_DISTILLED one', source: 'AI', type: 'INSIGHT' },
      { content: 'PROBE_DISTILLED two', source: 'AI', type: 'ACTION_ITEM' },
      { content: 'PROBE_TAKEAWAY_ACTION ask Bob to split the Sunday chores', source: 'USER', type: 'ACTION_ITEM' },
    ]);
    expect(res.body.data.takeaways).toHaveLength(3);
    const [r] = await run.sql<{ distilled: boolean }>(
      `SELECT distilled_at IS NOT NULL AS distilled FROM reflection WHERE id = $1`,
      [reflectionId],
    );
    expect(r.distilled).toBe(true);
  });

  it('semantic search is disabled until D8: an empty result, never another user’s takeaway', async () => {
    const res = await http(ada, 'get', `/knowledge-base/search?q=keeping%20score`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ query: 'keeping score', results: [] });
  });

  it('insights are gone with their table: empty lists, dismiss answers not found', async () => {
    expect((await http(ada, 'get', `/inner-work/insights`)).body.data).toEqual({ insights: [], hasMore: false });
    expect((await http(ada, 'get', `/inner-work/overview`)).body.data.overview.recentInsights).toEqual([]);
    expect((await http(ada, 'post', `/inner-work/insights/${reflectionId}/dismiss`)).status).toBe(400);
  });
});
