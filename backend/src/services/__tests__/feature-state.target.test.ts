/**
 * TS-12, real roles on a clone of the CREATED target fixture: the wellbeing
 * features as `feature_state` documents (spec §1.7, A-Q4) over HTTP as
 * `mwf_app` with identity binding on.
 *
 * What it pins:
 *   - two devices writing at once lose nothing: concurrent writes to one
 *     document serialise under the row lock (read-modify-write), both through
 *     the store with a forced overlap and through the gratitude endpoint;
 *   - one row per (user, feature), each document valid against its shared zod
 *     contract; a read writes nothing;
 *   - every document is its owner's: Bob reads none of Ada's entries;
 *   - the DISTINCT ON reads are reductions over the document (needs state:
 *     latest score + trend per need; gratitude prompt from the averages);
 *   - the Need taxonomy is the shared constant (19 needs, ids 1–19).
 *
 * Replaces no mock suite (the wellbeing controllers had none); see the report.
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Http = Awaited<ReturnType<typeof httpAs>>;

describeTarget('wellbeing feature documents on the target, as mwf_app with identity binding on', () => {
  let run: TargetRun;
  let http: Http;
  let ada: { id: string; email: string };
  let bob: { id: string; email: string };
  let store: typeof import('../feature-state');
  let ctx: typeof import('../../lib/request-context');
  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId }, async () => await fn());

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `ts12_feature_${process.pid}`);
    const ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    bob = { id: ids.bobUser, email: 'bob@e2e.test' };
    http = await httpAs();
    store = await import('../feature-state');
    ctx = await import('../../lib/request-context');
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const docOf = async (userId: string, feature: string) =>
    (
      await run.sql<{ doc: Record<string, unknown> }>(
        `SELECT doc FROM feature_state WHERE user_id = $1 AND feature = $2`,
        [userId, feature],
      )
    )[0]?.doc;

  it('a read writes nothing: the defaults come from the contract', async () => {
    const prefs = await http(ada, 'get', '/gratitude/preferences');
    expect(prefs.status).toBe(200);
    expect(prefs.body.data.preferences).toEqual({
      enabled: true,
      frequency: 1,
      preferredTimes: ['20:00'],
      weekdayOnly: false,
      quietHoursStart: null,
      quietHoursEnd: null,
    });
    expect((await http(ada, 'get', '/meditation/stats')).body.data.stats.totalSessions).toBe(0);
    expect(await run.sql(`SELECT count(*)::int AS n FROM feature_state`)).toEqual([{ n: 0 }]);
  });

  it('two writers overlapping on one document both land (row lock, read-modify-write)', async () => {
    // Writer A reads the document, then waits; writer B starts meanwhile. With
    // the lock, B waits for A's commit and reads A's entry; without it, the
    // later write would overwrite the earlier. The row exists first, so the
    // only thing that can serialise the writers is the lock (a first write's
    // uncommitted INSERT would also make the second wait).
    await asUser(ada.id, () => store.updateFeature(ada.id, 'gratitude', doc => void (doc.preferences.frequency = 2)));
    let releaseA!: () => void;
    const aHolding = new Promise<void>(r => (releaseA = r));
    let aRead!: () => void;
    const aHasRead = new Promise<void>(r => (aRead = r));
    const writerA = asUser(ada.id, () =>
      store.updateFeature(ada.id, 'gratitude', async doc => {
        aRead();
        await aHolding;
        doc.entries.push({ ...entry('PROBE_DEVICE_A'), id: 'a' });
      }),
    );
    await aHasRead;
    const writerB = asUser(ada.id, () =>
      store.updateFeature(ada.id, 'gratitude', doc => {
        doc.entries.push({ ...entry('PROBE_DEVICE_B'), id: 'b' });
      }),
    );
    await new Promise(r => setTimeout(r, 300));
    releaseA();
    await Promise.all([writerA, writerB]);
    const doc = await docOf(ada.id, 'gratitude');
    expect((doc!.entries as Array<{ content: string }>).map(e => e.content).sort()).toEqual([
      'PROBE_DEVICE_A',
      'PROBE_DEVICE_B',
    ]);
  });

  it('five concurrent gratitude POSTs from two devices: five entries, one row', async () => {
    const posts = await Promise.all(
      [1, 2, 3, 4, 5].map(i =>
        http(ada, 'post', '/gratitude', { content: `PROBE_CONCURRENT ${i}: the morning light` }),
      ),
    );
    expect(posts.map(p => p.status)).toEqual([201, 201, 201, 201, 201]);
    const list = await http(ada, 'get', '/gratitude?limit=100');
    expect(list.body.data.total).toBe(7);
    expect(
      list.body.data.entries.filter((e: { content: string }) => e.content.startsWith('PROBE_CONCURRENT')),
    ).toHaveLength(5);
    expect(
      await run.sql(`SELECT count(*)::int AS n FROM feature_state WHERE user_id = $1 AND feature = 'gratitude'`, [
        ada.id,
      ]),
    ).toEqual([{ n: 1 }]);
  });

  it("Bob reads none of Ada's documents", async () => {
    const [first] = (await http(ada, 'get', '/gratitude')).body.data.entries;
    expect((await http(bob, 'get', `/gratitude/${first.id}`)).status).toBe(404);
    expect((await http(bob, 'get', '/gratitude')).body.data).toMatchObject({ entries: [], total: 0 });
    expect((await http(bob, 'delete', `/gratitude/${first.id}`)).status).toBe(404);
    expect((await http(ada, 'get', `/gratitude/${first.id}`)).status).toBe(200);
  });

  it('needs: the taxonomy is the shared constant; state is a reduction over the scores', async () => {
    const ref = await http(ada, 'get', '/needs/reference');
    expect(ref.body.data.needs).toHaveLength(19);
    expect(ref.body.data.needs[0]).toMatchObject({ id: 1, slug: 'physical-safety', category: 'FOUNDATION' });

    const baseline = await http(ada, 'post', '/needs/baseline', {
      scores: Array.from({ length: 19 }, (_, i) => ({ needId: i + 1, score: i === 2 ? 0 : 2 })),
    });
    expect(baseline.status).toBe(201);
    expect(baseline.body.data.summary.overall).toEqual({ notMet: 1, somewhatMet: 0, fullyMet: 18 });

    const checkIn = await http(ada, 'post', '/needs/3/check-in', { score: 1, clarification: 'a little better' });
    expect(checkIn.body.data).toMatchObject({
      previousScore: 0,
      newScore: 1,
      trend: 'up',
      needName: 'Rest & Restoration',
    });

    const state = (await http(ada, 'get', '/needs/state')).body.data;
    expect(state.state.baselineCompleted).toBe(true);
    const rest = state.currentScores.find((n: { id: number }) => n.id === 3);
    expect(rest).toMatchObject({ currentScore: 1, trend: 'up' });
    expect(state.currentScores.find((n: { id: number }) => n.id === 1)).toMatchObject({
      currentScore: 2,
      trend: 'stable',
    });

    const history = (await http(ada, 'get', '/needs/3/history')).body.data.history;
    expect(history.map((h: { score: number }) => h.score)).toEqual([1, 0]);
    expect((await http(bob, 'get', '/needs/state')).body.data.state.baselineCompleted).toBe(false);
  });

  it('meditation: sessions, stats, favorites, scripts and preferences live in one document', async () => {
    const created = await http(ada, 'post', '/meditation/sessions', {
      type: 'UNGUIDED',
      durationMinutes: 10,
      focusArea: 'grounding',
    });
    expect(created.status).toBe(201);
    const id = created.body.data.session.id;
    const done = await http(ada, 'patch', `/meditation/sessions/${id}`, {
      completed: true,
      savedAsFavorite: true,
      favoriteType: 'THEME',
    });
    expect(done.body.data.session.completed).toBe(true);
    const stats = (await http(ada, 'get', '/meditation/stats')).body.data.stats;
    expect(stats).toMatchObject({ totalSessions: 1, unguidedCount: 1, totalMinutes: 10, currentStreak: 1 });
    expect(stats.favoriteFocusAreas).toEqual([{ focusArea: 'grounding', count: 1 }]);
    expect((await http(ada, 'get', '/meditation/favorites')).body.data.favorites).toHaveLength(1);
    const saved = await http(ada, 'post', '/meditation/saved', {
      title: 'Mine',
      script: '[BELL] breathe [PAUSE:30s] [BELL]',
    });
    expect(saved.status).toBe(201);
    expect((await http(ada, 'get', '/meditation/saved')).body.data.total).toBe(1);
    expect((await http(bob, 'get', `/meditation/saved/${saved.body.data.meditation.id}`)).status).toBe(404);
    const prefs = await http(ada, 'patch', '/meditation/preferences', { defaultDuration: 20 });
    expect(prefs.body.data.preferences).toMatchObject({ defaultDuration: 20, preferredVoice: 'default' });
    expect(await run.sql(`SELECT feature FROM feature_state WHERE user_id = $1 ORDER BY feature`, [ada.id])).toEqual([
      { feature: 'gratitude' },
      { feature: 'meditation' },
      { feature: 'needs_assessment' },
    ]);
  });

  it('people: extraction creates, matches by name and alias, counts by source; merge and delete are one document write', async () => {
    const extractor = await import('../people-extractor');
    const bedrock = await import('../../lib/bedrock');
    const spy = jest.spyOn(bedrock, 'getHaikuJson');
    const extract = (names: string[], content: string, sourceType: 'GRATITUDE' | 'INNER_THOUGHTS') => {
      spy.mockResolvedValueOnce({
        names,
        matchedToExisting: {},
        newPeople: [],
        relationships: { Sarah: 'friend' },
        sentiment: { Sarah: 0.5 },
      } as never);
      return asUser(ada.id, () =>
        extractor.extractAndTrackPeople({ userId: ada.id, content, sourceType, sourceId: 'src-1' }),
      );
    };
    expect(
      await asUser(ada.id, () =>
        extractor.extractAndTrackPeople({ userId: ada.id, content: 'short', sourceType: 'GRATITUDE', sourceId: 'x' }),
      ),
    ).toEqual({
      people: [],
      newPeople: [],
    });
    expect(await extract(['Sarah', 'Tom'], 'Grateful for Sarah and Tom today at the lake.', 'GRATITUDE')).toEqual({
      people: ['Sarah', 'Tom'],
      newPeople: ['Sarah', 'Tom'],
    });
    expect(await extract(['sarah'], 'Talked to sarah about the move, it helped a lot.', 'INNER_THOUGHTS')).toEqual({
      people: ['Sarah'],
      newPeople: [],
    });
    const doc = await docOf(ada.id, 'people');
    const persons = doc!.persons as Array<{
      id: string;
      name: string;
      relationship: string | null;
      mentionCountGratitude: number;
      mentionCountInnerThoughts: number;
      mentions: unknown[];
    }>;
    const sarah = persons.find(p => p.name === 'Sarah')!;
    const tom = persons.find(p => p.name === 'Tom')!;
    expect(sarah).toMatchObject({ relationship: 'friend', mentionCountGratitude: 1, mentionCountInnerThoughts: 1 });
    expect(sarah.mentions).toHaveLength(2);

    const detail = await http(ada, 'get', `/people/${sarah.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.person.patterns.topContexts).toEqual(
      expect.arrayContaining([
        { sourceType: 'GRATITUDE', count: 1 },
        { sourceType: 'INNER_THOUGHTS', count: 1 },
      ]),
    );
    expect((await http(bob, 'get', `/people/${sarah.id}`)).status).toBe(404);

    const merged = await http(ada, 'post', `/people/${sarah.id}/merge`, { mergeIntoId: tom.id });
    expect(merged.status).toBe(200);
    expect(merged.body.data).toMatchObject({
      mergedCount: 1,
      person: { name: 'Sarah', aliases: ['Tom'], mentionCounts: { gratitude: 2, innerThoughts: 1 } },
    });
    expect((await http(ada, 'post', `/people/${sarah.id}/merge`, { mergeIntoId: tom.id })).status).toBe(404);
    expect((await http(ada, 'delete', `/people/${sarah.id}`)).status).toBe(200);
    expect((await docOf(ada.id, 'people'))!.persons).toEqual([]);
    spy.mockRestore();
  });

  it('every stored document is valid against its shared contract', async () => {
    const { parseFeatureDoc } = await import('@meet-without-fear/shared');
    for (const r of await run.sql<{ feature: string; doc: unknown }>(`SELECT feature, doc FROM feature_state`)) {
      expect(() => parseFeatureDoc(r.feature as never, r.doc)).not.toThrow();
    }
    // A malformed write never reaches the database.
    await expect(
      asUser(ada.id, () =>
        store.updateFeature(ada.id, 'needs_assessment', doc => {
          doc.scores.push({ id: 'x', needId: 99, score: 7, clarification: null, createdAt: new Date().toISOString() });
        }),
      ),
    ).rejects.toThrow();
    const doc = await docOf(ada.id, 'needs_assessment');
    expect((doc!.scores as Array<{ needId: number }>).some(s => s.needId === 99)).toBe(false);
  });
});

function entry(content: string) {
  return {
    content,
    voiceRecorded: false,
    createdAt: new Date().toISOString(),
    extractedPeople: [],
    extractedPlaces: [],
    extractedActivities: [],
    extractedEmotions: [],
    extractedThemes: [],
    linkedNeedIds: [],
    linkedConflictId: null,
    sentimentScore: null,
    aiResponse: null,
  };
}
