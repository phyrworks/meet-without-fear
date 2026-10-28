/**
 * TS-12, real roles on a clone of the NEEDS_CONFIRMED target fixture (Stage 3,
 * needs confirmed, none shared): the Stage 3 need-edit services against the
 * target `need` table as mwf_app with identity binding on. The LLM is stubbed at
 * lib/bedrock; no Prisma mock.
 *   - the interpreter previews a model edit plan and writes nothing;
 *   - update / add / remove apply in one transaction (soft delete, confirmed);
 *   - refine creates a new need and supersedes the old; delete and lock keep rows;
 *   - once a need_share row of the caller's exists, edits are forbidden;
 *   - another participant's need is never a target.
 *
 * Replaces the Prisma-mock suite services/__tests__/needs-edit.service.test.ts
 * (its pure validateNeedIsUniversal case stays there).
 * Requires: npx tsx src/testing/golden/cli.ts build NEEDS_CONFIRMED
 */

import { NeedCategory } from '@meet-without-fear/shared';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('Stage 3 need edits on the target (mwf_app, identity-bound)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ctx: typeof import('../../lib/request-context');
  let applier: typeof import('../needs-edit-applier.service');
  let interpreter: typeof import('../needs-edit-interpreter.service');
  let bedrock: typeof import('../../lib/bedrock');
  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId }, async () => await fn());

  beforeAll(async () => {
    run = await openTargetRun('NEEDS_CONFIRMED', `ts12_needs_edit_${process.pid}`);
    ids = await adaAndBob(run);
    ctx = await import('../../lib/request-context');
    applier = await import('../needs-edit-applier.service');
    interpreter = await import('../needs-edit-interpreter.service');
    bedrock = await import('../../lib/bedrock');
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (run) await run.drop();
  });

  type Row = {
    id: string;
    label: string;
    category: string;
    confirmed: boolean;
    deleted: boolean;
    locked: boolean;
    superseded_by: string | null;
  };
  const needsOf = (participantId: string) =>
    run.sql<Row>(
      `SELECT id, label, category::text AS category, confirmed_at IS NOT NULL AS confirmed, deleted_at IS NOT NULL AS deleted,
              locked_at IS NOT NULL AS locked, superseded_by_need_id AS superseded_by
       FROM need WHERE participant_id = $1 ORDER BY created_at, id`,
      [participantId],
    );

  it('the interpreter previews the model plan and writes nothing', async () => {
    const [first] = await needsOf(ids.ada);
    jest.spyOn(bedrock, 'getModelCompletion').mockResolvedValue(
      JSON.stringify({
        summary: 'I made this less about what they must do.',
        operations: [
          {
            type: 'updateNeedText',
            needId: first.id,
            newText: 'I need more care around our shared space.',
            newCategory: NeedCategory.FAIRNESS,
          },
        ],
      }) as never,
    );
    const before = await run.sql(`SELECT * FROM need ORDER BY id`);
    const result = await asUser(ids.adaUser, () =>
      interpreter.interpretNeedEditRequest(ids.session, ids.adaUser, { request: 'Make the first one less about him.' }),
    );
    expect(result.plan?.summary).toContain('less about');
    expect(result.plan?.affectedNeeds[0]).toMatchObject({
      needId: first.id,
      before: { text: first.label },
      after: { text: 'I need more care around our shared space.' },
    });
    expect(await run.sql(`SELECT * FROM need ORDER BY id`)).toEqual(before);
  });

  it('update, add and remove apply together; a remove is a soft delete; a foreign need is no target', async () => {
    const [a1, a2] = await needsOf(ids.ada);
    const [b1] = await needsOf(ids.bob);
    const result = await asUser(ids.adaUser, () =>
      applier.applyNeedEdits(ids.session, ids.adaUser, [
        {
          type: 'updateNeedText',
          needId: a1.id,
          newText: 'I need more care around our shared space.',
          newCategory: NeedCategory.FAIRNESS,
        },
        { type: 'addNeed', text: 'I need a calmer start to the day.', category: NeedCategory.SAFETY },
        { type: 'removeNeed', needId: a2.id },
      ]),
    );
    expect(result.applied).toHaveLength(3);
    const after = await needsOf(ids.ada);
    expect(after.find(n => n.id === a1.id)).toMatchObject({
      label: 'I need more care around our shared space.',
      category: 'FAIRNESS',
      confirmed: true,
      deleted: false,
    });
    expect(after.find(n => n.id === a2.id)).toMatchObject({ deleted: true });
    expect(after.find(n => n.label === 'I need a calmer start to the day.')).toMatchObject({
      category: 'SAFETY',
      confirmed: true,
    });

    // Bob's need as the target of Ada's edit: refused, Bob's row untouched
    await expect(
      asUser(ids.adaUser, () =>
        applier.applyNeedEdits(ids.session, ids.adaUser, [{ type: 'removeNeed', needId: b1.id }]),
      ),
    ).rejects.toThrow(applier.NeedEditValidationError);
    expect((await needsOf(ids.bob)).find(n => n.id === b1.id)).toMatchObject({ deleted: false });
  });

  it('refine supersedes with a new need; delete and lock keep the rows', async () => {
    const live = (await needsOf(ids.ada)).filter(n => !n.deleted);
    const refined = await asUser(ids.adaUser, () =>
      applier.applyNeedAction(ids.session, ids.adaUser, {
        type: 'refine',
        supersedes: live[0].id,
        need: 'PROBE_TS12_REFINED',
        description: 'PROBE_TS12_REFINED',
      } as never),
    );
    const rows = await needsOf(ids.ada);
    expect(rows.find(n => n.id === live[0].id)?.superseded_by).toBe(refined.need!.id);
    expect(rows.find(n => n.id === refined.need!.id)).toMatchObject({ label: 'PROBE_TS12_REFINED' });

    await asUser(ids.adaUser, () =>
      applier.applyNeedAction(ids.session, ids.adaUser, { type: 'lock', needId: live[1].id } as never),
    );
    await asUser(ids.adaUser, () =>
      applier.applyNeedAction(ids.session, ids.adaUser, { type: 'delete', needId: refined.need!.id } as never),
    );
    const final = await needsOf(ids.ada);
    expect(final.find(n => n.id === live[1].id)).toMatchObject({ locked: true, confirmed: true, deleted: false });
    expect(final.find(n => n.id === refined.need!.id)).toMatchObject({ deleted: true });
    expect(final.length).toBe(rows.length); // nothing hard-deleted
  });

  it('once the caller has shared, every edit is forbidden and nothing changes', async () => {
    const live = (await needsOf(ids.ada)).filter(n => !n.deleted);
    await run.sql(
      `INSERT INTO need_share (participant_id, need_id, session_id, category, shared_text) SELECT $1, n.id, $3, n.category, n.label FROM need n WHERE n.id = $2`,
      [ids.ada, live[0].id, ids.session],
    );
    const before = await needsOf(ids.ada);
    await expect(
      asUser(ids.adaUser, () =>
        applier.applyNeedEdits(ids.session, ids.adaUser, [
          { type: 'addNeed', text: 'I need rest.', category: NeedCategory.SAFETY },
        ]),
      ),
    ).rejects.toThrow(applier.NeedEditForbiddenError);
    await expect(
      asUser(ids.adaUser, () =>
        applier.applyNeedAction(ids.session, ids.adaUser, { type: 'delete', needId: live[0].id } as never),
      ),
    ).rejects.toThrow(applier.NeedEditForbiddenError);
    expect(await needsOf(ids.ada)).toEqual(before);
  });
});
