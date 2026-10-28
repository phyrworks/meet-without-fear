/**
 * TS-13, real roles with FIELD_ENCRYPTION_KEY set, on a clone of the
 * INNER_WORK_LINKED_A target fixture: the user-scope encrypted columns, each
 * written through its real writer (mwf_app with identity binding on for the
 * request path, mwf_job for the background jobs), are ciphertext at rest and
 * read back as plaintext.
 *
 *   - ai_memory.doc (jsonb, leaves — ruling R43): SUMMARY by the summarizer
 *     (raw INSERT, job), NOTABLE_FACTS by the partner-session classifier (raw
 *     INSERT, job), GLOBAL_FACTS by the consolidation (model API); the real
 *     CHECKs (SUMMARY keys, `facts` array) accept the sealed document;
 *   - reflection.title / summary_doc / context_snapshot / summary,
 *     reflection_message.content, takeaway.content (model API, app);
 *   - user_memory.content (POST /memories) and its duplicate probe (ruling R45:
 *     compares plaintext in the app);
 *   - feature_state.doc (jsonb, envelope — R43): the empty-row raw INSERT and the
 *     model-API update both sealed; the object CHECK accepts the envelope.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

import { COVERAGE, expectSealed } from './encryption-at-rest';

jest.mock('../embedding', () => ({
  ...jest.requireActual('../embedding'),
  embedSessionContent: jest.fn().mockResolvedValue(true),
  embedInnerWorkSessionContent: jest.fn().mockResolvedValue(true),
}));

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(240_000);

describeTarget('encryption at rest: user-scope columns (FIELD_ENCRYPTION_KEY set, real roles)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ctx: typeof import('../../lib/request-context');
  let bedrock: typeof import('../../lib/bedrock');
  let http: Awaited<ReturnType<typeof httpAs>>;
  let prisma: typeof import('../../lib/prisma').prisma;
  let ada: { id: string; email: string };
  const asAda = <T>(fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId: ids.adaUser }, async () => await fn());
  const proven = new Set<string>();

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts13_user_${process.pid}`);
    ids = await adaAndBob(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    ctx = await import('../../lib/request-context');
    bedrock = await import('../../lib/bedrock');
    http = await httpAs();
    ({ prisma } = await import('../../lib/prisma'));
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (run) await run.drop();
  });

  it('ai_memory SUMMARY (summarizer, raw INSERT as mwf_job): leaves sealed, the CHECK holds, the app reads the text', async () => {
    const [c] = await run.sql<{ id: string }>(`SELECT id FROM conversation WHERE participant_id = $1 AND kind = 'MAIN'`, [
      ids.ada,
    ]);
    for (let i = 0; i < 30; i++) {
      await run.sql(
        `INSERT INTO message (conversation_id, sender_participant_id, role, content, created_at)
         VALUES ($1, $2, $3::message_role, $4, now() - make_interval(mins => 90 - $5::int))`,
        [c.id, i % 2 === 0 ? ids.ada : null, i % 2 === 0 ? 'USER' : 'AI', `turn ${i} with enough content to count`, i],
      );
    }
    const spy = jest.spyOn(bedrock, 'getHaikuJson').mockResolvedValue({
      summary: 'PROBE_TS13_SUMMARY Ada feels unheard about chores',
      keyThemes: ['PROBE_TS13_THEME'],
      emotionalJourney: 'tired',
      unresolvedTopics: [],
    } as never);
    const summarizer = await import('../conversation-summarizer');
    await asAda(() => summarizer.updateSessionSummary(ids.session, ids.adaUser, 'turn-ts13'));
    spy.mockRestore();
    const [doc] = (await expectSealed(run, 'ai_memory', 'doc', `participant_id = $1 AND kind = 'SUMMARY'`, [
      ids.ada,
    ])) as Array<Record<string, unknown>>;
    expect(Object.keys(doc)).toEqual(expect.arrayContaining(['text', 'messageCount', 'generatedAt']));
    expect(JSON.stringify(doc)).not.toContain('PROBE_TS13');
    const read = await asAda(() => summarizer.getSessionSummary(ids.session, ids.adaUser));
    expect(read?.summary.text).toBe('PROBE_TS13_SUMMARY Ada feels unheard about chores');
    expect(read?.keyThemes).toEqual(['PROBE_TS13_THEME']);
    proven.add('ai_memory.doc');
  });

  it('ai_memory NOTABLE_FACTS (partner-session classifier, raw INSERT as mwf_job): the facts array survives the CHECK', async () => {
    const spy = jest.spyOn(bedrock, 'getHaikuJson').mockResolvedValue({
      topicContext: 'x',
      notableFacts: [{ category: 'People', fact: 'PROBE_TS13_FACT Ada has a sister' }],
    } as never);
    const { runPartnerSessionClassifier } = await import('../partner-session-classifier');
    await runPartnerSessionClassifier({
      userMessage: 'My sister visits',
      conversationHistory: [],
      sessionId: ids.session,
      userId: ids.adaUser,
      turnId: 'turn-ts13',
    });
    spy.mockRestore();
    const [doc] = (await expectSealed(run, 'ai_memory', 'doc', `participant_id = $1 AND kind = 'NOTABLE_FACTS'`, [
      ids.ada,
    ])) as Array<{ facts: unknown[] }>;
    expect(Array.isArray(doc.facts)).toBe(true);
    expect(JSON.stringify(doc)).not.toContain('PROBE_TS13');
    const { loadOwnNotableFacts } = await import('../participant-memory');
    const facts = (await asAda(() => loadOwnNotableFacts(ids.session, ids.adaUser))) as Array<{ fact: string }>;
    expect(facts.map(f => f.fact)).toEqual(['PROBE_TS13_FACT Ada has a sister']);
  });

  it('ai_memory GLOBAL_FACTS (consolidation, model API): sealed, read back as plaintext', async () => {
    const { consolidateGlobalFacts, loadGlobalFacts } = await import('../global-memory');
    await asAda(async () => {
      await consolidateGlobalFacts(ids.adaUser, ids.session, 'turn-ts13');
      expect((await loadGlobalFacts(ids.adaUser))?.map(f => f.fact)).toEqual(['PROBE_TS13_FACT Ada has a sister']);
    });
    const [doc] = (await expectSealed(run, 'ai_memory', 'doc', `user_id = $1 AND kind = 'GLOBAL_FACTS'`, [
      ids.adaUser,
    ])) as Array<unknown>;
    expect(JSON.stringify(doc)).not.toContain('PROBE_TS13');
  });

  it('reflection.title and reflection_message.content (POST /inner-thoughts as mwf_app): sealed, read back', async () => {
    const created = await http(ada, 'post', '/inner-thoughts', {
      title: 'PROBE_TS13_TITLE',
      initialMessage: 'PROBE_TS13_FIRST_MESSAGE I keep score',
    });
    expect({ status: created.status, body: created.body }).toMatchObject({ status: 201 });
    const id = created.body.data.session.id as string;
    await expectSealed(run, 'reflection', 'title', `id = $1`, [id]);
    await expectSealed(run, 'reflection_message', 'content', `reflection_id = $1`, [id]);
    const got = await http(ada, 'get', `/inner-thoughts/${id}`);
    expect(got.body.data.session.title).toBe('PROBE_TS13_TITLE');
    expect(got.body.data.session.messages.map((m: { content: string }) => m.content)).toContain(
      'PROBE_TS13_FIRST_MESSAGE I keep score',
    );
    proven.add('reflection.title');
    proven.add('reflection_message.content');
  });

  it('reflection.summary_doc (inner-thoughts summarizer, model API): an envelope the object CHECK accepts', async () => {
    const [r] = await run.sql<{ id: string }>(`SELECT id FROM reflection WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [
      ids.adaUser,
    ]);
    for (let i = 0; i < 40; i++) {
      await run.sql(
        `INSERT INTO reflection_message (reflection_id, role, content, created_at)
         VALUES ($1, $2::message_role, $3, now() - make_interval(mins => 100 - $4::int))`,
        [r.id, i % 2 === 0 ? 'USER' : 'AI', `reflection turn ${i}`, i],
      );
    }
    const spy = jest.spyOn(bedrock, 'getHaikuJson').mockResolvedValue({
      summary: 'PROBE_TS13_REFLECTION_SUMMARY',
      keyThemes: [],
      emotionalJourney: '',
      unresolvedTopics: [],
    } as never);
    const summarizer = await import('../conversation-summarizer');
    const stored = await asAda(() => summarizer.updateInnerThoughtsSummary(r.id, 'turn-ts13'));
    spy.mockRestore();
    expect(stored?.text).toBe('PROBE_TS13_REFLECTION_SUMMARY');
    await expectSealed(run, 'reflection', 'summary_doc', `id = $1`, [r.id]);
    const read = await asAda(() => summarizer.getInnerThoughtsSummary(r.id));
    expect(read?.summary.text).toBe('PROBE_TS13_REFLECTION_SUMMARY');
    proven.add('reflection.summary_doc');
  });

  it('reflection.summary / context_snapshot and takeaway.content (model API as mwf_app): sealed, read back', async () => {
    const [r] = await run.sql<{ id: string }>(`SELECT id FROM reflection WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [
      ids.adaUser,
    ]);
    await asAda(() =>
      prisma.reflection.update({
        where: { id: r.id },
        data: { summary: 'PROBE_TS13_REFLECTION_ONE_LINE', contextSnapshot: 'PROBE_TS13_SNAPSHOT' },
      }),
    );
    await expectSealed(run, 'reflection', 'summary', `id = $1`, [r.id]);
    await expectSealed(run, 'reflection', 'context_snapshot', `id = $1`, [r.id]);
    const [t] = await run.sql<{ id: string }>(
      `INSERT INTO takeaway (reflection_id, content, type, source, position) VALUES ($1, 'fixture', 'INSIGHT', 'AI', 0) RETURNING id`,
      [r.id],
    );
    const patched = await http(ada, 'patch', `/inner-thoughts/${r.id}/takeaways/${t.id}`, {
      content: 'PROBE_TS13_TAKEAWAY ask for help',
    });
    expect(patched.status).toBe(200);
    await expectSealed(run, 'takeaway', 'content', `id = $1`, [t.id]);
    const back = await asAda(() =>
      prisma.reflection.findUnique({
        where: { id: r.id },
        select: { summary: true, contextSnapshot: true, takeaways: { select: { id: true, content: true } } },
      }),
    );
    expect(back).toMatchObject({ summary: 'PROBE_TS13_REFLECTION_ONE_LINE', contextSnapshot: 'PROBE_TS13_SNAPSHOT' });
    // an included relation is decrypted too
    expect(back?.takeaways.find(x => x.id === t.id)?.content).toBe('PROBE_TS13_TAKEAWAY ask for help');
    proven.add('reflection.summary');
    proven.add('reflection.context_snapshot');
    proven.add('takeaway.content');
  });

  it('user_memory.content (POST /memories as mwf_app): sealed; the duplicate probe still refuses the same text (R45)', async () => {
    const spy = jest.spyOn(bedrock, 'getHaikuJson').mockResolvedValue({ valid: true } as never);
    const created = await http(ada, 'post', '/memories', { content: 'PROBE_TS13_MEMORY call me Ada', category: 'PERSONAL_INFO' });
    expect(created.status).toBe(201);
    await expectSealed(run, 'user_memory', 'content', `id = $1`, [created.body.data.memory.id]);
    const list = await http(ada, 'get', '/memories');
    expect(JSON.stringify(list.body)).toContain('PROBE_TS13_MEMORY call me Ada');
    // approving the same text again is a duplicate, found by comparing plaintext
    const dup = await http(ada, 'post', '/memories/approve', {
      suggestedContent: 'PROBE_TS13_MEMORY call me Ada',
      category: 'PERSONAL_INFO',
    });
    spy.mockRestore();
    expect(dup.status).toBe(400);
    expect(JSON.stringify(dup.body)).toContain('already exists');
    proven.add('user_memory.content');
  });

  it('feature_state.doc (updateFeature as mwf_app: empty-row raw INSERT, then the model update): an envelope; read back in full shape', async () => {
    const store = await import('../feature-state');
    await asAda(() =>
      store.updateFeature(ids.adaUser, 'gratitude', doc => {
        doc.entries.push({
          id: store.newEntryId(),
          content: 'PROBE_TS13_GRATITUDE the sun',
          voiceRecorded: false,
          createdAt: new Date().toISOString(),
        } as never);
      }),
    );
    await expectSealed(run, 'feature_state', 'doc', `user_id = $1 AND feature = 'gratitude'`, [ids.adaUser]);
    const doc = await asAda(() => store.readFeature(ids.adaUser, 'gratitude'));
    expect(doc.entries.map(e => e.content)).toContain('PROBE_TS13_GRATITUDE the sun');
    proven.add('feature_state.doc');
  });

  it('covers every user-scope column of the map', () => {
    expect([...proven].sort()).toEqual([...COVERAGE.user].sort());
  });
});
