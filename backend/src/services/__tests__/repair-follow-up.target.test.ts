/**
 * TS-11, real roles on a clone of the STAGE4_REDESIGN_PARTNER_INACTIVE target
 * fixture (mwf_app for the request path, mwf_job for the job's writers,
 * identity binding on): the repair stage and follow-up on the target tables.
 *
 *   - proposal_need refuses a need id that is not a need_share id;
 *   - a co-participant's proposal_choice is hidden before choices_shared and
 *     visible after (the RLS arm, applied by the read);
 *   - agreement creation (job) is refused at COMMIT by the deferred
 *     T-agreement-parties when a party is not WILLING or missing, and
 *     succeeds with every present human WILLING;
 *   - closure (job): session_closure, the session RESOLVED, `closed` for both;
 *     the three arrays come from v_session_closure_items and name only
 *     need_share ids;
 *   - follow-up: a check-in payload rejected by the shared zod contract and
 *     accepted when valid (one follow_up_checkin row); the open-due job (as
 *     mwf_job) opens only due SCHEDULED follow_up rows.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_PARTNER_INACTIVE
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('repair and follow-up on the target, as mwf_app and mwf_job with identity binding on', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let store: typeof import('../stage4-store');
  let closure: typeof import('../stage4-closure');
  let state: typeof import('../stage4-state');
  let tending: typeof import('../tending.service');
  let ctx: typeof import('../../lib/request-context');
  const proposal: Record<string, string> = {};
  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId }, async () => await fn());

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_PARTNER_INACTIVE', `repair_${process.pid}`);
    ids = await adaAndBob(run);
    store = await import('../stage4-store');
    closure = await import('../stage4-closure');
    state = await import('../stage4-state');
    tending = await import('../tending.service');
    ctx = await import('../../lib/request-context');
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
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('the fixture: every proposal_need names a need_share id; four shared needs', async () => {
    expect(await run.sql(`SELECT count(*)::int AS n FROM need_share`)).toEqual([{ n: 4 }]);
    expect(
      await run.sql(`SELECT count(*)::int AS n FROM proposal_need pn WHERE NOT EXISTS (SELECT 1 FROM need_share s WHERE s.need_id = pn.need_id)`),
    ).toEqual([{ n: 0 }]);
    expect((await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM proposal_need`))[0].n).toBeGreaterThan(0);
  });

  it('proposal_need refuses a need that was never shared (FK to need_share), as mwf_app', async () => {
    const [unshared] = await run.sql<{ id: string }>(
      `INSERT INTO need (participant_id, label, category, ai_confidence) VALUES ($1, 'PROBE_UNSHARED', 'SAFETY', 0.9) RETURNING id`,
      [ids.ada],
    );
    await expect(
      run.as('mwf_app', ids.adaUser, `INSERT INTO proposal_need (proposal_id, need_id) VALUES ($1, $2)`, [proposal.checkin, unshared.id]),
    ).rejects.toThrow(/proposal_need_need_id_fkey|foreign key/);
  });

  it("Bob's choice is hidden from Ada before his choices_shared and visible after", async () => {
    await asUser(ids.bobUser, () => store.upsertChoice({ proposalId: proposal.checkin, participantId: ids.bob, decision: 'WILLING' }));
    await asUser(ids.bobUser, () => store.upsertChoice({ proposalId: proposal.pause, participantId: ids.bob, decision: 'WILLING' }));
    const before = await asUser(ids.adaUser, () => store.loadVisibleChoices(ids.session, ids.ada));
    expect(before.filter(c => c.participantId === ids.bob)).toEqual([]);
    expect(before.filter(c => c.participantId === ids.ada).map(c => c.proposalId)).toEqual([proposal.checkin]);
    const dtoBefore = await asUser(ids.adaUser, () => state.getStage4State(ids.session, ids.adaUser));
    expect(dtoBefore.partnerSelections).toEqual([]);
    expect(JSON.stringify(dtoBefore)).not.toContain('"partnerDecisionVisible"');

    await asUser(ids.bobUser, () => store.shareChoices(ids.bob));
    const after = await asUser(ids.adaUser, () => store.loadVisibleChoices(ids.session, ids.ada));
    expect(after.filter(c => c.participantId === ids.bob).map(c => c.proposalId).sort()).toEqual([proposal.checkin, proposal.pause].sort());
    const dtoAfter = await asUser(ids.adaUser, () => state.getStage4State(ids.session, ids.adaUser));
    expect(dtoAfter.partnerSelectionStatus).toBe('SUBMITTED');
    expect(dtoAfter.partnerSelections).toHaveLength(2);
  });

  it('agreement creation (job) is refused at COMMIT when a party is not WILLING, and when a present human is left out', async () => {
    const make = (proposalId: string, parties: string[]) =>
      store.createAgreementsAsJob({
        sessionId: ids.session,
        actorParticipantId: ids.ada,
        partyParticipantIds: parties,
        agreements: [
          { proposalId, type: 'MICRO_EXPERIMENT', description: 'x', duration: null, measureOfSuccess: null, followUpAt: null, fromStatus: 'ACTIVE' },
        ],
      });
    // Ada is not WILLING on "pause" (Bob is).
    await expect(make(proposal.pause, [ids.ada, ids.bob])).rejects.toThrow(/every present participant, each WILLING/);
    // Both WILLING on "checkin", but Bob left out of the party set.
    await expect(make(proposal.checkin, [ids.ada])).rejects.toThrow(/every present participant, each WILLING/);
    expect(await run.sql(`SELECT * FROM agreement`)).toEqual([]);
    expect(await run.sql(`SELECT status::text AS status FROM proposal WHERE id = $1`, [proposal.pause])).toEqual([{ status: 'ACTIVE' }]);
  });

  it('closure (job): the agreement with both parties, session_closure, RESOLVED, closed for both; arrays from v_session_closure_items', async () => {
    // A shared need nobody addresses, and an unshared one (never in any array).
    const [open] = await run.sql<{ id: string }>(
      `INSERT INTO need (participant_id, label, category, ai_confidence, confirmed_at) VALUES ($1, 'PROBE_OPEN_LABEL', 'MEANING', 0.9, now()) RETURNING id`,
      [ids.bob],
    );
    await run.as('mwf_app', ids.bobUser, `INSERT INTO consent (participant_id, need_id, decision, decided_at) VALUES ($1, $2, 'GRANTED', now())`, [
      ids.bob,
      open.id,
    ]);
    await run.as('mwf_job', null, `SELECT app.need_share($1::uuid, 'An open shared need')`, [open.id]);
    // Ada keeps her individual commitment (she is WILLING on it).
    await asUser(ids.adaUser, () => store.upsertChoice({ proposalId: proposal.individual, participantId: ids.ada, decision: 'WILLING' }));
    // Ada set aside nothing; both have shared their choices (Ada in the fixture, Bob above).
    await asUser(ids.adaUser, () => store.upsertChoice({ proposalId: proposal.pause, participantId: ids.ada, decision: 'NOT_WILLING' }));

    const result = await asUser(ids.adaUser, () => closure.closeStage4({ sessionId: ids.session, participantId: ids.ada }));
    expect(result.kind).toBe('SHARED_AGREEMENT');
    expect(result.agreementIds).toHaveLength(1);

    const agreements = await run.sql<{ id: string; proposal_id: string; status: string }>(
      `SELECT id, proposal_id, status::text AS status FROM agreement`,
    );
    expect(agreements).toEqual([{ id: result.agreementIds[0], proposal_id: proposal.checkin, status: 'AGREED' }]);
    expect(
      (await run.sql<{ participant_id: string }>(`SELECT participant_id FROM agreement_party ORDER BY participant_id`)).map(r => r.participant_id),
    ).toEqual([ids.ada, ids.bob].sort());
    expect(await run.sql(`SELECT status::text AS status FROM proposal WHERE id = $1`, [proposal.checkin])).toEqual([
      { status: 'CONVERTED_TO_AGREEMENT' },
    ]);
    expect(await run.sql(`SELECT kind::text AS kind, reason::text AS reason FROM session_closure`)).toEqual([
      { kind: 'SHARED_AGREEMENT', reason: 'MUTUAL_SELECTION' },
    ]);
    expect(await run.sql(`SELECT status::text AS status FROM session`)).toEqual([{ status: 'RESOLVED' }]);
    expect(await run.sql(`SELECT count(*)::int AS n FROM participant_milestone WHERE milestone_key = 'closed'`)).toEqual([{ n: 2 }]);

    const [items] = await run.as<{ agreement_ids: string[]; individual_commitment_ids: string[]; open_need_ids: string[] }>(
      'mwf_app',
      ids.adaUser,
      `SELECT agreement_ids, individual_commitment_ids, open_need_ids FROM v_session_closure_items WHERE session_id = $1`,
      [ids.session],
    );
    expect(items.agreement_ids).toEqual(result.agreementIds);
    expect(items.individual_commitment_ids).toEqual([proposal.individual]);
    expect(items.open_need_ids).toContain(open.id);
    const shareIds = (await run.sql<{ need_id: string }>(`SELECT need_id FROM need_share`)).map(r => r.need_id);
    for (const id of items.open_need_ids) expect(shareIds).toContain(id);

    // The state's outcome is those arrays.
    const dto = await asUser(ids.adaUser, () => state.getStage4State(ids.session, ids.adaUser));
    expect(dto.outcome?.agreements.map(a => a.id)).toEqual(items.agreement_ids);
    expect(dto.outcome?.individualCommitments.map(p => p.id)).toEqual(items.individual_commitment_ids);
    expect(dto.outcome?.openNeeds.map(n => n.id).sort()).toEqual([...items.open_need_ids].sort());
    // Ada reads Bob's open need by its shared text, never its label.
    expect(JSON.stringify(dto)).not.toContain('PROBE_OPEN_LABEL');
    expect(JSON.stringify(dto)).toContain('An open shared need');

    // Follow-ups scheduled at closure (job): the shared agreement and Ada's commitment.
    expect(
      await run.sql(`SELECT type::text AS type, scope::text AS scope, status::text AS status FROM follow_up ORDER BY type`),
    ).toEqual([
      { type: 'SCHEDULED_INDIVIDUAL_COMMITMENT', scope: 'INDIVIDUAL', status: 'SCHEDULED' },
      { type: 'SCHEDULED_SHARED_AGREEMENT', scope: 'SHARED', status: 'SCHEDULED' },
    ]);
  });

  it('the open-due job (mwf_job) opens only due SCHEDULED follow-ups', async () => {
    const [{ due_at }] = await run.sql<{ due_at: Date }>(`SELECT max(scheduled_for) AS due_at FROM follow_up`);
    // One not yet due, one due but cancelled.
    await run.sql(
      `INSERT INTO follow_up (session_id, type, scope, status, scheduled_for, summary)
       VALUES ($1, 'SCHEDULED_SHARED_AGREEMENT', 'SHARED', 'SCHEDULED', $2::timestamptz + interval '30 days', 'later'),
              ($1, 'SCHEDULED_SHARED_AGREEMENT', 'SHARED', 'CANCELLED', $2::timestamptz - interval '1 day', 'cancelled')`,
      [ids.session, due_at],
    );
    const { getJobPrisma } = await import('../../lib/prisma');
    const [who] = await getJobPrisma().$queryRaw<Array<{ u: string }>>`SELECT session_user AS u`;
    expect(who.u).toBe('mwf_job');
    const result = await tending.openDueTendingEntries(new Date(due_at.getTime() + 1000));
    expect(result.opened).toBe(2);
    const rows = await run.sql<{ summary: string; status: string; deadline: boolean }>(
      `SELECT summary, status::text AS status, response_deadline_at IS NOT NULL AS deadline FROM follow_up ORDER BY summary`,
    );
    expect(rows.find(r => r.summary === 'later')?.status).toBe('SCHEDULED');
    expect(rows.find(r => r.summary === 'cancelled')?.status).toBe('CANCELLED');
    expect(rows.filter(r => r.status === 'OPEN')).toHaveLength(2);
    // The SHARED one got its coordination deadline.
    expect(rows.find(r => r.summary?.startsWith('Check in on the shared agreement'))?.deadline).toBe(true);
    expect((await tending.openDueTendingEntries(new Date(due_at.getTime() + 1000))).opened).toBe(0);
  });

  it('a check-in payload is rejected by the shared zod contract and accepted when valid (one follow_up_checkin row)', async () => {
    expect(() => tending.validateCheckinPayload({ entryOutcomes: [{ followUpId: 'nope' }] })).toThrow(/Invalid check-in payload/);
    expect(() =>
      tending.validateCheckinPayload({
        entryOutcomes: [],
        needOutcomes: [],
        adjustments: [],
        partialClosures: [],
        responses: [],
        carriedNotes: [],
        extra: true,
      }),
    ).toThrow(/Invalid check-in payload/);
    const [shared] = await run.sql<{ id: string }>(`SELECT id FROM follow_up WHERE type = 'SCHEDULED_SHARED_AGREEMENT' AND status = 'OPEN'`);
    // An invalid response status never reaches the table.
    await expect(
      asUser(ids.adaUser, () => tending.submitTendingResponse({ entryId: shared.id, userId: ids.adaUser, status: 'BOGUS' })),
    ).rejects.toThrow(/Invalid check-in payload/);
    expect(await run.sql(`SELECT * FROM follow_up_checkin`)).toEqual([]);

    const result = await asUser(ids.adaUser, () =>
      tending.submitTendingCheckin({
        sessionId: ids.session,
        userId: ids.adaUser,
        orientations: {
          whatWorked: { reflection: 'We planned Sunday' },
          whereMoreSupport: { reflection: '' },
          whatComesNext: { continueChoice: 'EXTEND' as never },
        },
        entryOutcomes: [{ tendingEntryId: shared.id, followThroughStatus: 'HAPPENED' as never }],
      }),
    );
    expect(result.checkin?.id).toEqual(expect.any(String));
    const rows = await run.sql<{ follow_up_id: string; participant_id: string; payload: Record<string, unknown[]> }>(
      `SELECT follow_up_id, participant_id, payload FROM follow_up_checkin WHERE follow_up_id = $1`,
      [shared.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].participant_id).toBe(ids.ada);
    expect(Object.keys(rows[0].payload).sort()).toEqual(
      ['adjustments', 'carriedNotes', 'entryOutcomes', 'needOutcomes', 'partialClosures', 'responses'],
    );
    expect(rows[0].payload.entryOutcomes).toHaveLength(1);
    // The shared follow-up waits for Bob (v_follow_up_cycle).
    expect(
      await run.as('mwf_app', ids.adaUser, `SELECT status FROM v_follow_up_cycle WHERE follow_up_id = $1`, [shared.id]),
    ).toEqual([{ status: 'WAITING_FOR_PARTNER' }]);
  });
});
