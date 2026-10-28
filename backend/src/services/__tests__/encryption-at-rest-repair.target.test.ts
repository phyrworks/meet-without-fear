/**
 * TS-13, real roles with FIELD_ENCRYPTION_KEY set, on a clone of the
 * STAGE4_REDESIGN_PARTNER_INACTIVE target fixture: the needs / repair /
 * follow-up encrypted columns, each written by its real writer (mwf_app with
 * identity binding on, mwf_job for the job's writers), are ciphertext at rest
 * and read back as plaintext — through the model API and through every raw
 * reader (v_need_shared, proposal_choice, the closure's proposal read).
 *
 * The share moments of the writer-principal rule call the W13 hook
 * (lib/share-moments.ts reencryptForSession): need share, choices shared,
 * a SHARED check-in.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_PARTNER_INACTIVE
 */

import { COVERAGE, expectSealed } from './encryption-at-rest';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(240_000);

describeTarget('encryption at rest: needs, repair and follow-up columns (FIELD_ENCRYPTION_KEY set, real roles)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let ctx: typeof import('../../lib/request-context');
  let moments: typeof import('../../lib/share-moments');
  let hook: jest.SpyInstance;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let store: typeof import('../stage4-store');
  let prisma: typeof import('../../lib/prisma').prisma;
  const proposal: Record<string, string> = {};
  const proven = new Set<string>();
  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId }, async () => await fn());
  const momentsCalled = (moment: string) =>
    hook.mock.calls.filter(([e]) => (e as { moment: string }).moment === moment).map(([e]) => e);

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_PARTNER_INACTIVE', `ts13_repair_${process.pid}`);
    ids = await adaAndBob(run);
    ctx = await import('../../lib/request-context');
    moments = await import('../../lib/share-moments');
    http = await httpAs();
    store = await import('../stage4-store');
    ({ prisma } = await import('../../lib/prisma'));
    for (const r of await run.sql<{ id: string; description: string }>(`SELECT id, description FROM proposal`)) {
      const key = r.description.startsWith('Try a Sunday')
        ? 'checkin'
        : r.description.startsWith('Use a pause')
          ? 'pause'
          : r.description.startsWith('I will name')
            ? 'individual'
            : 'spreadsheet';
      proposal[key] = r.id;
    }
  });
  // jest.config restoreMocks: spies are restored before every test, so the hook spy is per test
  beforeEach(() => {
    hook = jest.spyOn(moments, 'reencryptForSession');
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (run) await run.drop();
  });

  it('need.label / need.evidence (captureSingleNeedForUser, model API as mwf_app): sealed, read back', async () => {
    const needs = await import('../needs');
    const { need } = await asUser(ids.bobUser, () =>
      needs.captureSingleNeedForUser(ids.session, ids.bobUser, {
        need: 'Connection',
        category: 'CONNECTION' as never,
        description: 'PROBE_TS13_NEED_LABEL',
        evidence: ['PROBE_TS13_EVIDENCE quote'],
      }),
    );
    await expectSealed(run, 'need', 'label', `id = $1`, [need.id]);
    await expectSealed(run, 'need', 'evidence', `id = $1`, [need.id]);
    const own = await asUser(ids.bobUser, () => needs.listOwnNeeds(ids.bob));
    const back = own.find(n => n.id === need.id);
    expect(back).toMatchObject({ label: 'PROBE_TS13_NEED_LABEL', evidence: ['PROBE_TS13_EVIDENCE quote'] });
    proven.add('need.label');
    proven.add('need.evidence');
  });

  it('need_share.shared_text (shareNeeds → app.need_share as mwf_job): sealed; every raw reader of v_need_shared decrypts; the hook runs', async () => {
    const [need] = await run.sql<{ id: string }>(
      `INSERT INTO need (participant_id, label, category, ai_confidence, confirmed_at)
       VALUES ($1, 'PROBE_TS13_SHARE_LABEL', 'MEANING', 0.9, now()) RETURNING id`,
      [ids.bob],
    );
    hook.mockClear();
    const share = await import('../needs-share');
    await asUser(ids.bobUser, () =>
      share.shareNeeds({
        sessionId: ids.session,
        participantId: ids.bob,
        needs: [{ id: need.id, label: 'PROBE_TS13_SHARE_LABEL', category: 'MEANING' as never, evidence: [] }],
      }),
    );
    await expectSealed(run, 'need_share', 'shared_text', `need_id = $1`, [need.id]);
    const expected = share.fallbackSharedText('PROBE_TS13_SHARE_LABEL', 'MEANING' as never);
    // listSharedNeeds (needs-share.ts), loadStage4Needs (stage4-store.ts): raw reads of v_need_shared
    const listed = await asUser(ids.adaUser, () => share.listSharedNeeds(ids.session));
    expect(listed.find(n => n.needId === need.id)?.sharedText).toBe(expected);
    const s4 = await asUser(ids.adaUser, () => store.loadStage4Needs(ids.session, ids.ada));
    expect(s4.find(n => n.id === need.id)?.sharedText).toBe(expected);
    // context-assembler.ts: the third raw reader
    const assembler = await import('../context-assembler');
    const bundle = await asUser(ids.adaUser, () =>
      assembler.buildContextForParticipant(ids.ada, {
        intent: {
          intent: 'stage_enforcement',
          depth: 'full',
          reason: 'test',
          threshold: 0.6,
          maxCrossSession: 0,
          allowCrossSession: false,
          surfaceStyle: 'silent',
        } as never,
      }),
    );
    expect(JSON.stringify(bundle)).not.toContain('enc:v1:');
    expect(JSON.stringify(bundle)).toContain(expected);
    // W13 hook at the share moment
    expect(momentsCalled('need-share')).toEqual([
      { moment: 'need-share', sessionId: ids.session, rows: [{ table: 'need_share', id: need.id }] },
    ]);
    proven.add('need_share.shared_text');
  });

  it('need_disposition.note (model API as mwf_app; no app writer sets it today): sealed, read back', async () => {
    const [need] = await run.sql<{ id: string }>(
      `SELECT need_id AS id FROM need_share WHERE participant_id = $1 LIMIT 1`,
      [ids.ada],
    );
    await asUser(ids.adaUser, () =>
      prisma.needDisposition.upsert({
        where: { participantId_needId: { participantId: ids.ada, needId: need.id } },
        create: { participantId: ids.ada, needId: need.id, status: 'DECLINED', note: 'PROBE_TS13_DISPOSITION' },
        update: { note: 'PROBE_TS13_DISPOSITION' },
      }),
    );
    await expectSealed(run, 'need_disposition', 'note', `participant_id = $1 AND need_id = $2`, [ids.ada, need.id]);
    const rows = await asUser(ids.adaUser, () => store.loadDispositions(ids.ada));
    expect(rows.find(r => r.needId === need.id)?.note).toBe('PROBE_TS13_DISPOSITION');
    proven.add('need_disposition.note');
  });

  it('proposal.description (POST /strategies as mwf_app): sealed, read back by the model API', async () => {
    const res = await http({ id: ids.bobUser, email: 'bob@e2e.test' }, 'post', `/sessions/${ids.session}/strategies`, {
      description: 'PROBE_TS13_PROPOSAL take a walk on Sundays',
      needsAddressed: ['Partnership'],
    });
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 201 });
    const row = { id: res.body.data.strategy.id as string };
    await expectSealed(run, 'proposal', 'description', `id = $1`, [row.id]);
    const p = await asUser(ids.bobUser, () => store.loadProposal(row.id));
    expect(p?.description).toBe('PROBE_TS13_PROPOSAL take a walk on Sundays');
    proven.add('proposal.description');
  });

  it('proposal_choice.note (upsertChoice, raw INSERT as mwf_app): sealed; loadVisibleChoices (raw) decrypts; sharing calls the hook', async () => {
    await asUser(ids.bobUser, () =>
      store.upsertChoice({
        proposalId: proposal.checkin,
        participantId: ids.bob,
        decision: 'WILLING',
        note: 'PROBE_TS13_NOTE yes',
      }),
    );
    await asUser(ids.bobUser, () =>
      store.upsertChoice({ proposalId: proposal.pause, participantId: ids.bob, decision: 'WILLING' }),
    );
    await expectSealed(run, 'proposal_choice', 'note', `proposal_id = $1 AND participant_id = $2`, [
      proposal.checkin,
      ids.bob,
    ]);
    const own = await asUser(ids.bobUser, () => store.loadVisibleChoices(ids.session, ids.bob));
    expect(own.find(c => c.proposalId === proposal.checkin)?.note).toBe('PROBE_TS13_NOTE yes');
    hook.mockClear();
    await asUser(ids.bobUser, () => store.shareChoices(ids.bob));
    expect(momentsCalled('choices-shared')).toEqual([
      expect.objectContaining({ moment: 'choices-shared', sessionId: ids.session }),
    ]);
    const seenByAda = await asUser(ids.adaUser, () => store.loadVisibleChoices(ids.session, ids.ada));
    expect(seenByAda.find(c => c.participantId === ids.bob && c.proposalId === proposal.checkin)?.note).toBe(
      'PROBE_TS13_NOTE yes',
    );
    proven.add('proposal_choice.note');
  });

  it('agreement.description, session_closure.summary, follow_up.summary (closeStage4, raw INSERTs as mwf_job): sealed, plaintext on read', async () => {
    await asUser(ids.adaUser, () =>
      store.upsertChoice({ proposalId: proposal.individual, participantId: ids.ada, decision: 'WILLING' }),
    );
    await asUser(ids.adaUser, () =>
      store.upsertChoice({ proposalId: proposal.pause, participantId: ids.ada, decision: 'NOT_WILLING' }),
    );
    const closure = await import('../stage4-closure');
    const result = await asUser(ids.adaUser, () =>
      closure.closeStage4({ sessionId: ids.session, participantId: ids.ada }),
    );
    expect(result.agreementIds).toHaveLength(1);
    await expectSealed(run, 'agreement', 'description', `id = $1`, [result.agreementIds[0]]);
    await expectSealed(run, 'session_closure', 'summary', `session_id = $1`, [ids.session]);
    await expectSealed(run, 'follow_up', 'summary', `session_id = $1`, [ids.session]);
    // the closure read the proposals raw (stage4-closure.ts) and decrypted them:
    // the agreement and the summary hold the proposal's plaintext, not its ciphertext
    const [fixtureProposal] = await run.sql<{ description: string }>(`SELECT description FROM proposal WHERE id = $1`, [
      proposal.checkin,
    ]);
    const agreements = await asUser(ids.adaUser, () => store.loadAgreements(ids.session));
    expect(agreements.map(a => a.description)).toEqual([fixtureProposal.description]);
    const closed = await asUser(ids.adaUser, () => store.loadClosure(ids.session));
    expect(closed?.summary).toEqual(expect.any(String));
    expect(closed?.summary).not.toContain('enc:v1:');
    const tending = await import('../tending.service');
    const entries = await asUser(ids.adaUser, () => tending.listTendingEntries(ids.session, ids.adaUser));
    expect(JSON.stringify(entries)).not.toContain('enc:v1:');
    expect(JSON.stringify(entries)).toContain('Check in on the shared agreement');
    proven.add('agreement.description');
    proven.add('session_closure.summary');
    proven.add('follow_up.summary');
  });

  it('follow_up_note.content (createTendingBetweenPeriodNote, model API): sealed, read back', async () => {
    const tending = await import('../tending.service');
    const note = await asUser(ids.adaUser, () =>
      tending.createTendingBetweenPeriodNote({
        sessionId: ids.session,
        userId: ids.adaUser,
        content: 'PROBE_TS13_NOTE_BETWEEN',
      }),
    );
    await expectSealed(run, 'follow_up_note', 'content', `id = $1`, [note.id]);
    const notes = await asUser(ids.adaUser, () => tending.listTendingBetweenPeriodNotes(ids.session, ids.adaUser));
    expect(notes.find(n => n.id === note.id)?.content).toBe('PROBE_TS13_NOTE_BETWEEN');
    proven.add('follow_up_note.content');
  });

  it('follow_up_checkin.payload (envelope) / reflection_summary (submitTendingCheckin, model API): sealed; a SHARED check-in calls the hook', async () => {
    const tending = await import('../tending.service');
    const [{ due_at }] = await run.sql<{ due_at: Date }>(`SELECT max(scheduled_for) AS due_at FROM follow_up`);
    await tending.openDueTendingEntries(new Date(due_at.getTime() + 1000));
    const [shared] = await run.sql<{ id: string }>(
      `SELECT id FROM follow_up WHERE type = 'SCHEDULED_SHARED_AGREEMENT' AND status = 'OPEN'`,
    );
    hook.mockClear();
    const result = await asUser(ids.adaUser, () =>
      tending.submitTendingCheckin({
        sessionId: ids.session,
        userId: ids.adaUser,
        orientations: {
          whatWorked: { reflection: 'PROBE_TS13_REFLECTION we planned Sunday' },
          whereMoreSupport: { reflection: '' },
          whatComesNext: { continueChoice: 'EXTEND' as never },
        },
        entryOutcomes: [{ tendingEntryId: shared.id, followThroughStatus: 'HAPPENED' as never }],
      }),
    );
    expect(result.checkin?.id).toEqual(expect.any(String));
    await expectSealed(run, 'follow_up_checkin', 'payload', `follow_up_id = $1`, [shared.id]);
    await expectSealed(run, 'follow_up_checkin', 'reflection_summary', `follow_up_id = $1`, [shared.id]);
    const checkin = await asUser(ids.adaUser, () =>
      prisma.followUpCheckin.findFirst({
        where: { followUpId: shared.id },
        select: { payload: true, reflectionSummary: true },
      }),
    );
    expect(checkin?.reflectionSummary).toContain('PROBE_TS13_REFLECTION');
    expect(Object.keys(checkin?.payload as object).sort()).toEqual([
      'adjustments',
      'carriedNotes',
      'entryOutcomes',
      'needOutcomes',
      'partialClosures',
      'responses',
    ]);
    expect(momentsCalled('checkin-shared-submit')).toEqual([
      {
        moment: 'checkin-shared-submit',
        sessionId: ids.session,
        rows: [{ table: 'follow_up_checkin', id: expect.any(String) }],
      },
    ]);
    proven.add('follow_up_checkin.payload');
    proven.add('follow_up_checkin.reflection_summary');
  });

  it('covers every needs/repair/follow-up column of the map', () => {
    expect([...proven].sort()).toEqual([...COVERAGE.repair].sort());
  });
});
