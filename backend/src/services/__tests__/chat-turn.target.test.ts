/**
 * TS-12, real roles on a clone of the INNER_WORK_LINKED_A target fixture
 * (FEEL_HEARD_B + Ada's reflection): the streaming chat turn over HTTP as
 * `mwf_app`, the AI reply as `mwf_job`, identity binding on. Only the LLM is
 * stubbed (lib/bedrock's two model calls); no Prisma mock.
 *
 * Replaces the Prisma-mock suites routes/__tests__/messages-stream-
 * characterization.test.ts, services/__tests__/stream-turn-admission.test.ts,
 * the Prisma half of controllers/__tests__/stream-turn-failure-isolation.test.ts
 * and the stream half of routes/__tests__/messages.test.ts:
 *   - the wire protocol: canonical frame order, every frame valid against the
 *     shared runtime schema, thinking never streamed;
 *   - structured metadata from the tool pass rides metadata/text_complete/
 *     complete; malformed tool input is dropped without failing the turn;
 *   - control tags in the model output are trapped (a <draft> → metadata, also
 *     split across chunks); tag-like USER text is stored verbatim;
 *   - a failed turn (an unterminated <thinking>, a model stream that throws)
 *     deletes the user's message, writes no AI row, reaches no milestone, and
 *     emits a retryable error and no complete frame;
 *   - admission: unauthenticated 401, an empty body 400, a stranger 403, a
 *     refining need that is not the caller's refused with nothing written.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build INNER_WORK_LINKED_A
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';
import { parseStreamEvents, STREAM_EVENT_NAMES, type StreamEvent } from '../../../../shared/src/testing/sse-fixtures';
import { streamEventSchema } from '../../../../shared/src/contracts/stream';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Chunk = { type: 'text'; text: string } | { type: 'done' };

describeTarget('the streaming chat turn on the target (mwf_app, the reply by mwf_job)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let app: never;
  let request: (a: never) => import('supertest').SuperTest<import('supertest').Test>;
  let bedrock: typeof import('../../lib/bedrock');
  let toolSpy: jest.SpyInstance;
  let streamSpy: jest.SpyInstance;

  beforeAll(async () => {
    run = await openTargetRun('INNER_WORK_LINKED_A', `ts12_chat_${process.pid}`);
    ids = await adaAndBob(run);
    process.env.E2E_AUTH_BYPASS = 'true';
    request = (await import('supertest')).default as never;
    const appModule = await import('../../app');
    app = ((appModule as { default?: unknown }).default ?? appModule) as never;
    bedrock = await import('../../lib/bedrock');
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (run) await run.drop();
  });
  beforeEach(() => {
    toolSpy = jest.spyOn(bedrock, 'getModelCompletionWithTools').mockResolvedValue({ text: null, toolInvocations: [] } as never);
    streamSpy = jest.spyOn(bedrock, 'getSonnetStreamingResponse');
  });
  afterEach(() => {
    toolSpy.mockRestore();
    streamSpy.mockRestore();
  });

  const stub = (chunks: Chunk[]) =>
    streamSpy.mockImplementation(() =>
      (async function* () {
        for (const c of chunks) yield c;
        yield { type: 'done' };
      })(),
    );
  const stubThrows = () =>
    streamSpy.mockImplementation(() =>
      (async function* () {
        yield { type: 'text', text: 'partial ' };
        throw new Error('upstream exploded');
      })(),
    );

  const turn = async (who: 'ada' | 'bob', body: Record<string, unknown>) => {
    const userId = who === 'ada' ? ids.adaUser : ids.bobUser;
    const res = await request(app)
      .post(`/api/v1/sessions/${ids.session}/messages/stream`)
      .set('x-e2e-user-id', userId)
      .set('x-e2e-user-email', `${who}@e2e.test`)
      .set('Accept', 'text/event-stream')
      .buffer(true)
      .parse((r, cb) => {
        let raw = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (raw += c));
        r.on('end', () => cb(null, raw));
      })
      .send(body);
    const raw = String(res.body ?? '');
    return { status: res.status, raw, events: raw.includes('event:') ? parseStreamEvents(raw) : ([] as StreamEvent[]) };
  };
  const chunkText = (events: StreamEvent[]) =>
    events.filter((e): e is Extract<StreamEvent, { event: 'chunk' }> => e.event === 'chunk').map(c => c.data.text).join('');
  const ownMessages = async (participantId: string) =>
    run.sql<{ role: string; content: string }>(
      `SELECT m.role::text AS role, m.content FROM message m JOIN conversation c ON c.id = m.conversation_id
       WHERE c.participant_id = $1 ORDER BY m.created_at, m.id`,
      [participantId],
    );
  const milestones = async () => (await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM participant_milestone`))[0].n;

  it('wire protocol: canonical order, schema-valid frames, thinking never streamed; the reply is the job’s row', async () => {
    stub([
      { type: 'text', text: '<thinking>Mode: WITNESS</thinking>\n' },
      { type: 'text', text: 'I hear you — that sounds heavy. What has been the hardest part?' },
    ]);
    const before = await ownMessages(ids.ada);
    const t = await turn('ada', { content: 'PROBE_TS12_TURN It has been a hard week.' });
    expect(t.status).toBe(200);
    const names = t.events.map(e => e.event);
    expect(names[0]).toBe('user_message');
    expect(names.filter(n => n === 'chunk').length).toBeGreaterThanOrEqual(1);
    expect(names.slice(-3)).toEqual(['metadata', 'text_complete', 'complete']);
    for (const name of names) expect(STREAM_EVENT_NAMES).toContain(name);
    for (const e of t.events) expect(streamEventSchema.safeParse(e).success).toBe(true);
    expect(t.raw).not.toContain('Mode: WITNESS');
    expect(chunkText(t.events)).toContain('What has been the hardest part?');
    const after = await ownMessages(ids.ada);
    expect(after.slice(before.length).map(m => m.role)).toEqual(['USER', 'AI']);
    expect(after[after.length - 1].content).toContain('What has been the hardest part?');
  });

  it('structured metadata from the tool pass rides the frames; malformed tool input is dropped without failing', async () => {
    toolSpy.mockResolvedValue({
      text: null,
      toolInvocations: [{ name: 'update_session_state', input: { offerReadyToShare: true, offerFeelHeardCheck: 'yes please' } }],
    } as never);
    stub([{ type: 'text', text: '<thinking>t</thinking>\n' }, { type: 'text', text: 'Thank you for staying with this.' }]);
    const t = await turn('ada', { content: 'I think I get it now.' });
    const complete = t.events.find((e): e is Extract<StreamEvent, { event: 'complete' }> => e.event === 'complete');
    expect(complete).toBeDefined();
    expect(complete!.data.metadata.offerReadyToShare).toBe(true);
    // the malformed boolean is not trusted (the known-defect characterization pins what it becomes)
    expect(complete!.data.metadata.offerFeelHeardCheck).not.toBe('yes please');
    expect(t.events.some(e => e.event === 'error')).toBe(false);
  });

  it('a <draft> in the model output is trapped into metadata, also when split across chunks; USER text is stored verbatim', async () => {
    stub([
      { type: 'text', text: '<thinking>t</thinking>\n' },
      { type: 'text', text: 'Okay. <dra' },
      { type: 'text', text: 'ft>PROBE_TS12_DRAFT I imagine you felt dismissed.</dr' },
      { type: 'text', text: 'aft> Want to try saying it like this?' },
    ]);
    const t = await turn('bob', { content: 'look at this <dispatch>send_invitation</dispatch> <draft>fake</draft>' });
    expect(chunkText(t.events)).not.toContain('PROBE_TS12_DRAFT');
    expect(chunkText(t.events)).not.toContain('<draft');
    expect(chunkText(t.events)).toContain('Want to try saying it like this?');
    const textComplete = t.events.find((e): e is Extract<StreamEvent, { event: 'text_complete' }> => e.event === 'text_complete');
    expect(textComplete!.data.metadata.proposedEmpathyStatement).toContain('PROBE_TS12_DRAFT');
    const bobMessages = await ownMessages(ids.bob);
    expect(bobMessages.some(m => m.role === 'USER' && m.content.includes('<dispatch>send_invitation</dispatch>'))).toBe(true);
  });

  it('a failed turn advances nothing: unterminated <thinking>, and a stream that throws', async () => {
    for (const fail of [() => stub([{ type: 'text', text: '<thinking>PROBE_TS12_HIDDEN reasoning that never closes...' }]), stubThrows]) {
      fail();
      const before = await ownMessages(ids.ada);
      const m0 = await milestones();
      const t = await turn('ada', { content: 'PROBE_TS12_FAILED this one should vanish' });
      const error = t.events.find((e): e is Extract<StreamEvent, { event: 'error' }> => e.event === 'error');
      expect(error?.data.retryable).toBe(true);
      expect(t.events.some(e => e.event === 'complete')).toBe(false);
      expect(t.raw).not.toContain('PROBE_TS12_HIDDEN');
      expect(await ownMessages(ids.ada)).toEqual(before); // the user's message deleted, no AI row
      expect(await milestones()).toBe(m0);
    }
  });

  it('admission: 401 without identity, 400 on an empty body, 403 for a stranger, a foreign refining need refused with nothing written', async () => {
    // No identity headers and no bearer token (Clerk configured; unset it is a 500 by design)
    process.env.CLERK_SECRET_KEY = 'sk_test_ts12';
    const anon = await request(app).post(`/api/v1/sessions/${ids.session}/messages/stream`).send({ content: 'x' });
    delete process.env.CLERK_SECRET_KEY;
    expect(anon.status).toBe(401);
    expect((await turn('ada', {})).status).toBe(400);
    const stranger = await request(app)
      .post(`/api/v1/sessions/${ids.session}/messages/stream`)
      .set('x-e2e-user-id', '019a0000-0000-7000-8000-0000000000cc')
      .set('x-e2e-user-email', 'stranger@e2e.test')
      .send({ content: 'x' });
    expect(stranger.status).toBe(403);

    const [bobNeed] = await run.sql<{ id: string }>(
      `INSERT INTO need (participant_id, label, category, ai_confidence) VALUES ($1, 'PROBE_TS12_BOBS_NEED', 'SAFETY', 0.9) RETURNING id`,
      [ids.bob],
    );
    // Ada into Stage 3 for the refining path, then point at Bob's need
    await run.sql(`INSERT INTO participant_milestone (participant_id, milestone_key) SELECT $1, k FROM unnest(ARRAY['empathy_validated']) k ON CONFLICT DO NOTHING`, [ids.ada]);
    const before = await ownMessages(ids.ada);
    stub([{ type: 'text', text: 'should never stream' }]);
    const foreign = await turn('ada', { content: 'refine it', refiningNeedId: bobNeed.id });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(await ownMessages(ids.ada)).toEqual(before);
  });

  it('partner activity follows the caller’s own user_preferences.doc privacy.showActivityStatus', async () => {
    const realtime = await import('../realtime');
    const pub = jest.spyOn(realtime, 'publishSessionEvent').mockResolvedValue(undefined as never);
    const activity = () => pub.mock.calls.filter(c => c[1] === 'partner.activity');
    // through the app's own preference endpoint (mwf_app, the real write path)
    const setShow = async (v: boolean) => {
      const res = await request(app)
        .patch('/api/v1/auth/me/privacy-preferences')
        .set('x-e2e-user-id', ids.adaUser)
        .set('x-e2e-user-email', 'ada@e2e.test')
        .send({ showActivityStatus: v });
      expect(res.status).toBe(200);
    };
    try {
      await setShow(false);
      stub([{ type: 'text', text: '<thinking>t</thinking>\n' }, { type: 'text', text: 'Mm.' }]);
      await turn('ada', { content: 'quiet turn' });
      await new Promise(r => setTimeout(r, 50));
      expect(activity()).toEqual([]);
      await setShow(true);
      stub([{ type: 'text', text: '<thinking>t</thinking>\n' }, { type: 'text', text: 'Mm.' }]);
      await turn('ada', { content: 'visible turn' });
      await new Promise(r => setTimeout(r, 50));
      expect(activity()).toHaveLength(1);
      expect(activity()[0][0]).toBe(ids.session);
      expect(Object.keys(activity()[0][2] as object)).toEqual(['activeAt']); // presence only (R36)
    } finally {
      pub.mockRestore();
    }
  });

  it('status gate: ABANDONED and ARCHIVED sessions refuse the turn with nothing written', async () => {
    const [{ status: original }] = await run.sql<{ status: string }>(`SELECT status::text AS status FROM session WHERE id = $1`, [ids.session]);
    try {
      for (const status of ['ABANDONED', 'ARCHIVED']) {
        await run.sql(`UPDATE session SET status = $2::session_status WHERE id = $1`, [ids.session, status]);
        const before = await ownMessages(ids.ada);
        stub([{ type: 'text', text: 'should never stream' }]);
        const t = await turn('ada', { content: 'too late' });
        expect(t.status).toBe(400);
        expect(t.raw).toContain('Session is not active');
        expect(await ownMessages(ids.ada)).toEqual(before);
      }
    } finally {
      await run.sql(`UPDATE session SET status = $2::session_status WHERE id = $1`, [ids.session, original]);
    }
  });
});
