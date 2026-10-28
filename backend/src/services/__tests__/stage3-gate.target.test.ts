/**
 * TS-12, real roles on a clone of the NEEDS_CONFIRMED target fixture (both in
 * Stage 3, needs confirmed, neither shared): the Stage 3 reveal gate. A "ready to
 * see the lists" turn is answered with canned gate text written by the job,
 * never the model, never partner prose; it advances with the caller's own needs
 * and milestones and the partner's S-class needs_shared milestone only.
 *
 * Replaces resolveStage3GateTurn / saveAiTurnMessage / cleanupFailedStreamTurn
 * in the Prisma-mock suite services/__tests__/stream-turn-persistence.test.ts
 * (the failure cleanup is chat-turn.target.test.ts's).
 * Requires: npx tsx src/testing/golden/cli.ts build NEEDS_CONFIRMED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';
import { parseStreamEvents, STREAM_EVENT_NAMES, type StreamEvent } from '../../../../shared/src/testing/sse-fixtures';
import { streamEventSchema } from '../../../../shared/src/contracts/stream';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Chunk = { type: 'text'; text: string } | { type: 'done' };

describeTarget('the Stage 3 reveal gate on the target (mwf_app, the gate reply by mwf_job)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let app: never;
  let request: (a: never) => import('supertest').SuperTest<import('supertest').Test>;
  let bedrock: typeof import('../../lib/bedrock');
  let toolSpy: jest.SpyInstance;
  let streamSpy: jest.SpyInstance;

  beforeAll(async () => {
    run = await openTargetRun('NEEDS_CONFIRMED', `ts12_gate_${process.pid}`);
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
    toolSpy = jest
      .spyOn(bedrock, 'getModelCompletionWithTools')
      .mockResolvedValue({ text: null, toolInvocations: [] } as never);
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
    events
      .filter((e): e is Extract<StreamEvent, { event: 'chunk' }> => e.event === 'chunk')
      .map(c => c.data.text)
      .join('');
  const ownMessages = async (participantId: string) =>
    run.sql<{ role: string; content: string }>(
      `SELECT m.role::text AS role, m.content FROM message m JOIN conversation c ON c.id = m.conversation_id
       WHERE c.participant_id = $1 ORDER BY m.created_at, m.id`,
      [participantId],
    );
  const milestones = async () =>
    (await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM participant_milestone`))[0].n;

  const READY = "I'm ready to see the needs lists";
  let bobLabels: string[] = [];
  const lastAi = async () => {
    const m = await ownMessages(ids.ada);
    return m[m.length - 1];
  };
  const gateTurn = async (expected: string) => {
    stub([{ type: 'text', text: 'PROBE_TS12_MODEL should never stream' }]);
    const t = await turn('ada', { content: READY });
    expect(t.status).toBe(200);
    expect(streamSpy).not.toHaveBeenCalled();
    expect(t.raw).not.toContain('PROBE_TS12_MODEL');
    const ai = await lastAi();
    expect(ai.role).toBe('AI');
    expect(ai.content).toContain(expected);
    for (const label of bobLabels) expect(t.raw + ai.content).not.toContain(label);
    expect(t.events.map(e => e.event)).toContain('complete');
  };

  beforeAll(async () => {
    bobLabels = (await run.sql<{ label: string }>(`SELECT label FROM need WHERE participant_id = $1`, [ids.bob])).map(
      r => r.label,
    );
    expect(bobLabels.length).toBeGreaterThan(0);
  });

  it('a non-reveal turn and a negated reveal both go to the model', async () => {
    for (const content of ['I keep thinking about the weekend.', "I'm not ready to see the lists"]) {
      stub([
        { type: 'text', text: '<thinking>t</thinking>\n' },
        { type: 'text', text: 'PROBE_TS12_MODEL_REPLY' },
      ]);
      const t = await turn('ada', { content });
      expect(streamSpy).toHaveBeenCalled();
      expect(t.raw).toContain('PROBE_TS12_MODEL_REPLY');
      streamSpy.mockClear();
    }
  });

  it('the gate advances through own needs, own confirmation, own share, then the partner\u2019s share', async () => {
    const ms = (pid: string, key: string) =>
      run.sql(
        `INSERT INTO participant_milestone (participant_id, milestone_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [pid, key],
      );

    await run.sql(`UPDATE need SET deleted_at = now() WHERE participant_id = $1`, [ids.ada]);
    await gateTurn("Let's first put words to what matters most");

    await run.sql(`UPDATE need SET deleted_at = NULL, confirmed_at = NULL WHERE participant_id = $1`, [ids.ada]);
    await run.sql(`DELETE FROM participant_milestone WHERE participant_id = $1 AND milestone_key = 'needs_confirmed'`, [
      ids.ada,
    ]);
    await gateTurn('Please review and confirm your needs');

    await run.sql(`UPDATE need SET confirmed_at = now() WHERE participant_id = $1`, [ids.ada]);
    await ms(ids.ada, 'needs_confirmed');
    await gateTurn('you can choose to share them');
  });

  it('PINNED (stage shim, work-yk0q): own needs_shared is Stage 3’s terminal milestone, so the caller is in Stage 4 and the gate no longer answers', async () => {
    // The "wait for your partner" / "both lists ready" branches of
    // getStage3GateResponse are unreachable on the target: the stage shim
    // (TERMINAL_MILESTONE) ends the caller's Stage 3 at their own needs_shared.
    // Filed as work-yk0q (stage shim): when the shim ends Stage 3 at both-shared, this pin must
    // flip to asserting the gate's "wait for your partner" answer.
    await run.sql(
      `INSERT INTO participant_milestone (participant_id, milestone_key) VALUES ($1, 'needs_shared') ON CONFLICT DO NOTHING`,
      [ids.ada],
    );
    stub([
      { type: 'text', text: '<thinking>t</thinking>\n' },
      { type: 'text', text: 'PROBE_TS12_MODEL_REPLY' },
    ]);
    const t = await turn('ada', { content: READY });
    expect(streamSpy).toHaveBeenCalled();
    expect(t.raw).toContain('PROBE_TS12_MODEL_REPLY');
    for (const label of bobLabels) expect(t.raw).not.toContain(label);
  });
});
