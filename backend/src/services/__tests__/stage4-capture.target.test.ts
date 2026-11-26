/**
 * TS-12, real roles on a clone of the STAGE4_REDESIGN_INVENTORY target fixture
 * (three live proposals, one removed; both parties' needs shared): the Stage 4
 * inventory capture on the target `proposal` / `proposal_revision` /
 * `proposal_need` tables as mwf_app, identity-bound. No Prisma mock, no LLM.
 *   - first-person commitments become INDIVIDUAL_COMMITMENT proposals owned by
 *     the caller's participant, with a CREATED revision; observations, caveats
 *     and topic-frame restatements write nothing;
 *   - a typed <stage4_proposals> block wins over text inference (and an empty
 *     one suppresses the fallbacks);
 *   - removing a referenced proposal is a soft remove with a REMOVED revision;
 *   - a captured proposal links to the caller's shared need by label;
 *   - "complete enough to start" is not a closure signal.
 *
 * Replaces the Prisma-mock suite services/__tests__/stage4-capture.service.test.ts.
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('Stage 4 capture on the target (mwf_app, identity-bound)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ctx: typeof import('../../lib/request-context');
  let capture: typeof import('../stage4-capture.service');
  const asAda = <T>(fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext(
      { turnId: 't', requestId: 'r', startTime: Date.now(), userId: ids.adaUser },
      async () => await fn(),
    );
  const turn = (over: Partial<Parameters<typeof capture.captureStage4Turn>[0]>) =>
    asAda(() =>
      capture.captureStage4Turn({
        sessionId: ids.session,
        userId: ids.adaUser,
        messageId: '019a0000-0000-7000-8000-0000000000ee',
        userMessage: 'I can send a Sunday planning text each week for a month.',
        aiResponse: 'That is concrete enough to hold as an option.',
        ...over,
      }),
    );
  type P = {
    id: string;
    description: string;
    kind: string;
    status: string;
    owner: string | null;
    duration: string | null;
  };
  const proposals = () =>
    run.sql<P>(
      `SELECT id, description, kind::text AS kind, status::text AS status, created_by_user_id AS owner, duration
       FROM proposal WHERE session_id = $1 ORDER BY created_at, id`,
      [ids.session],
    );
  const revisions = (proposalId: string) =>
    run.sql<{ action: string; actor: string }>(
      `SELECT action::text AS action, actor_user_id AS actor FROM proposal_revision WHERE proposal_id = $1 ORDER BY created_at, id`,
      [proposalId],
    );

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `ts12_s4cap_${process.pid}`);
    ids = await adaAndBob(run);
    ctx = await import('../../lib/request-context');
    capture = await import('../stage4-capture.service');
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('a first-person commitment becomes Ada’s INDIVIDUAL_COMMITMENT with a CREATED revision', async () => {
    const before = await proposals();
    const result = await turn({});
    expect(result.appliedOperationCount).toBe(1);
    const added = (await proposals()).filter(p => !before.some(b => b.id === p.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      description: 'send a Sunday planning text each week for a month',
      kind: 'INDIVIDUAL_COMMITMENT',
      status: 'ACTIVE',
      owner: ids.adaUser,
    });
    expect(await revisions(added[0].id)).toEqual([{ action: 'CREATED', actor: ids.adaUser }]);
  });

  // work-k5fk.37 (owner decision 2026-11-25): the sentence of the participant's chat a proposal was captured from
  // (capturedQuote) is kept only on an individual commitment, whose revisions are its creator's alone; a shared
  // proposal's revisions are every member's, so its CREATED revision carries none. And a commitment stays one: no
  // edit reclassifies it as shared (that would release its history).
  const createdQuote = async (proposalId: string) =>
    (
      await run.sql<{ quote: string | null }>(
        `SELECT after->>'capturedQuote' AS quote FROM proposal_revision WHERE proposal_id = $1 AND action = 'CREATED'`,
        [proposalId],
      )
    )[0].quote;

  it('a captured quote is kept on Ada’s commitment only, never on a shared proposal (work-k5fk.37)', async () => {
    const before = await proposals();
    const result = await turn({
      userMessage: 'We could cook dinner together every Thursday this month. I will text before I leave work each day.',
    });
    expect(result.appliedOperationCount).toBeGreaterThanOrEqual(2);
    const added = (await proposals()).filter(p => !before.some(b => b.id === p.id));
    const shared = added.find(p => p.kind === 'SHARED_PROPOSAL')!;
    const mine = added.find(p => p.kind === 'INDIVIDUAL_COMMITMENT')!;
    expect(shared).toBeDefined();
    expect(mine).toBeDefined();
    expect(await createdQuote(shared.id)).toBeNull();
    expect(await createdQuote(mine.id)).toMatch(/I will text before I leave work/i);
  });

  it('a typed REVISE of Ada’s commitment as a shared proposal keeps it her commitment (work-k5fk.37)', async () => {
    const target = (await proposals()).find(p => p.description.startsWith('I will name when I am overloaded'))!;
    const result = await turn({
      userMessage: 'Let us both name it when we are overloaded, before either of us disappears.',
      structuredProposals: [
        {
          action: 'REVISE',
          targetProposalId: target.id,
          classification: 'PROPOSAL',
          description: 'name when we are overloaded before either of us disappears',
          kind: 'SHARED_PROPOSAL',
          needsAddressed: [],
        },
      ] as never,
    });
    expect(result.appliedOperationCount).toBe(1);
    expect((await proposals()).find(p => p.id === target.id)).toMatchObject({
      kind: 'INDIVIDUAL_COMMITMENT',
      owner: ids.adaUser,
      description: 'name when we are overloaded before either of us disappears',
    });
  });

  it('observations, caveats, topic-frame restatements and an empty typed block write nothing', async () => {
    const before = await proposals();
    for (const over of [
      { userMessage: 'I can see the trip and curiosity pieces matter for Bob.' },
      { userMessage: 'If even that becomes too much, then I would worry this is still only theoretical.' },
      {
        userMessage: 'ok sure',
        topicFrame: "Ada's son leaves his bike on Bob's lawn",
        structuredProposals: [
          {
            action: 'ADD',
            classification: 'PROPOSAL',
            description: "When her son leaves his bike on Bob's lawn, Ada moves it immediately",
            kind: 'INDIVIDUAL_COMMITMENT',
            needsAddressed: [],
          },
        ],
      },
      {
        userMessage: 'I can water the plants each week for a month.',
        structuredProposals: [],
        compatibilityProposedStrategies: ['water the plants each week for a month'],
      },
    ]) {
      const result = await turn(over as never);
      expect(result.appliedOperationCount).toBe(0);
    }
    expect(await proposals()).toEqual(before);
  });

  it('a typed block wins over text inference: one SHARED proposal with its duration, linked to Ada’s shared need by label', async () => {
    const before = await proposals();
    const result = await turn({
      userMessage:
        'I can own that I got sharp sometimes. What I would actually try is one quiet conversation this Friday without the kids in the room.',
      structuredProposals: [
        { action: 'IGNORE', classification: 'REFLECTION', description: 'I can own that I got sharp sometimes' },
        {
          action: 'ADD',
          classification: 'PROPOSAL',
          description: 'one quiet conversation this Friday without the kids in the room',
          kind: 'SHARED_PROPOSAL',
          duration: 'this Friday',
          measureOfSuccess: 'leave with an actual answer',
          needsAddressed: ['Appreciation'],
        },
      ] as never,
    });
    expect(result.appliedOperationCount).toBe(1);
    const added = (await proposals()).filter(p => !before.some(b => b.id === p.id));
    expect(added).toEqual([
      expect.objectContaining({
        description: 'one quiet conversation this Friday without the kids in the room',
        kind: 'SHARED_PROPOSAL',
        duration: 'this Friday',
      }),
    ]);
    const links = await run.sql<{ label: string }>(
      `SELECT n.label FROM proposal_need pn JOIN need n ON n.id = pn.need_id WHERE pn.proposal_id = $1`,
      [added[0].id],
    );
    expect(links).toEqual([{ label: 'Appreciation' }]);
  });

  it('removing a referenced proposal is a soft remove by Ada with a REMOVED revision', async () => {
    const target = (await proposals()).find(p => p.description.startsWith('Use a pause phrase'))!;
    const result = await turn({
      userMessage: 'Please remove the proposal "Use a pause phrase when either person starts to shut down".',
    });
    expect(result.appliedOperationCount).toBe(1);
    const [row] = await run.sql<{ status: string; by: string; reason: string }>(
      `SELECT status::text AS status, removed_by_user_id AS by, removal_reason AS reason FROM proposal WHERE id = $1`,
      [target.id],
    );
    expect(row).toEqual({
      status: 'REMOVED',
      by: ids.adaUser,
      // work-k5fk.32 sweep: the chat turn is not copied into the (shared) removal_reason
      reason: null,
    });
    expect((await revisions(target.id)).map(r => r.action)).toContain('REMOVED');
  });

  it('“complete enough to start” is not a closure signal', async () => {
    const result = await turn({
      userMessage:
        'That feels complete enough to start. I am nervous, but this list feels small enough that I could actually try it.',
    });
    expect(result.closureSignal).toBeUndefined();
  });
});
