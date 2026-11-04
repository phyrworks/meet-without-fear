/**
 * work-99k2: the inviter's empathy draft before the partner joins, on a clone
 * of the CREATED target fixture, over HTTP as `mwf_app` with identity binding.
 *
 * Owner rule (2026-11-04): A's draft is captured when they write it, even
 * before the partner joins; it is never sent on the join; after the join A
 * reviews it (send as is / edit first / set aside); consent is only given
 * after the join.
 *
 *   - save before the join: the draft is about the pending invitation
 *     (invitation_id), GET reports awaitingPartner and no consent;
 *   - consent before the join is still refused (400);
 *   - accept re-points the draft to the new participant in the accept's own
 *     transaction (a failure after the re-point leaves it on the invitation),
 *     keeping its id, version and written-at (updated_at);
 *   - review detection: preJoinReview while the draft predates the join and
 *     nothing was sent; a write since the join or a submitted round ends it;
 *   - set aside: DELETE discards the draft.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

// First: sets FIELD_ENCRYPTION_KEY before lib/prisma loads, so the move is proven on ciphertext.
import { expectSealed } from './encryption-at-rest';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndInvitee, httpAs, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Http = Awaited<ReturnType<typeof httpAs>>;

interface DraftRowSql extends Record<string, unknown> {
  id: string;
  about_participant_id: string | null;
  invitation_id: string | null;
  version: number;
  updated_at: Date;
}

describeTarget('empathy draft before the partner joins (work-99k2)', () => {
  let run: TargetRun;
  let http: Http;
  let ada: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `w99k2_prejoin_${process.pid}`);
    const ids = await adaAndInvitee(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    if (run) await run.drop();
  });

  /** A new INVITED session of Ada's, acceptable, with Ada in Stage 2. */
  const soloStage2Session = async (inviteName: string) => {
    const created = await http(ada, 'post', '/sessions', { inviteName });
    expect(created.status).toBe(201);
    const sessionId: string = created.body.data.session.id;
    const invitationId: string = created.body.data.invitationId;
    await run.sql(`UPDATE session SET topic_frame = 'the chores', topic_frame_confirmed_at = now() WHERE id = $1`, [
      sessionId,
    ]);
    await run.sql(`UPDATE invitation SET message_confirmed_at = now() WHERE session_id = $1`, [sessionId]);
    await run.as('mwf_job', null, `SELECT app.session_set_status($1::uuid, 'INVITED')`, [sessionId]);
    const [me] = await run.sql<{ id: string }>(`SELECT id FROM participant WHERE session_id = $1`, [sessionId]);
    await run.sql(
      `INSERT INTO participant_milestone (participant_id, milestone_key)
       SELECT $1, k FROM unnest(ARRAY['invitation_sent', 'compact_signed', 'feel_heard']) k`,
      [me.id],
    );
    return { sessionId, invitationId, adaParticipant: me.id };
  };

  const draftsOf = (participantId: string) =>
    run.sql<DraftRowSql>(
      `SELECT id, about_participant_id, invitation_id, version, updated_at FROM draft
       WHERE participant_id = $1 AND kind = 'EMPATHY'`,
      [participantId],
    );

  it('saves before the join on the invitation; consent waits; accept re-points it atomically; A reviews it', async () => {
    const { sessionId, invitationId, adaParticipant } = await soloStage2Session('Carol');
    const carol = { id: randomUuidV7(), email: `carol-99k2-${process.pid}@e2e.test` };

    const saved = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, {
      content: 'Carol may feel unseen when the chores pile up.',
      readyToShare: true,
    });
    expect(saved.status).toBe(200);
    const [before] = await draftsOf(adaParticipant);
    expect(before).toMatchObject({ about_participant_id: null, invitation_id: invitationId, version: 1 });

    const solo = await http(ada, 'get', `/sessions/${sessionId}/empathy/draft`);
    expect(solo.status).toBe(200);
    expect(solo.body.data).toMatchObject({
      draft: { content: 'Carol may feel unseen when the chores pile up.', readyToShare: true },
      canConsent: false,
      alreadyConsented: false,
      awaitingPartner: true,
      preJoinReview: null,
    });

    // The partner-must-be-present rule for consent stays.
    const refused = await http(ada, 'post', `/sessions/${sessionId}/empathy/consent`, { consent: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/before your partner has joined/);
    expect(
      await run.sql(`SELECT count(*)::int AS n FROM empathy_attempt WHERE author_participant_id = $1`, [
        adaParticipant,
      ]),
    ).toEqual([{ n: 0 }]);

    // Transactional: a failure after the re-point rolls the whole accept back.
    const store = await import('../empathy-store');
    const real = store.repointInvitationDrafts;
    const spy = jest.spyOn(store, 'repointInvitationDrafts').mockImplementationOnce(async (tx, inv, p) => {
      await real(tx, inv, p);
      throw new Error('injected: failure after the re-point');
    });
    expect((await http(carol, 'post', `/invitations/${invitationId}/accept`)).status).toBe(500);
    spy.mockRestore();
    expect(await draftsOf(adaParticipant)).toEqual([before]);
    expect(await run.sql(`SELECT count(*)::int AS n FROM participant WHERE session_id = $1`, [sessionId])).toEqual([
      { n: 1 },
    ]);

    const accepted = await http(carol, 'post', `/invitations/${invitationId}/accept`);
    expect(accepted.status).toBe(200);
    const [carolP] = await run.sql<{ id: string; joined_at: Date }>(
      `SELECT p.id, p.joined_at FROM participant p WHERE p.session_id = $1 AND p.user_id = $2`,
      [sessionId, carol.id],
    );
    const [after] = await draftsOf(adaParticipant);
    // Same row, now about Carol; written-at and version untouched by the move.
    expect(after).toEqual({ ...before, about_participant_id: carolP.id, invitation_id: null });
    // Still sealed at rest after the move.
    const [atRest] = await expectSealed(run, 'draft', 'content', 'id = $1', [after.id]);
    expect(String(atRest)).not.toContain('unseen');
    // Never auto-sent on the join.
    expect(
      await run.sql(`SELECT count(*)::int AS n FROM empathy_attempt WHERE author_participant_id = $1`, [
        adaParticipant,
      ]),
    ).toEqual([{ n: 0 }]);

    const review = await http(ada, 'get', `/sessions/${sessionId}/empathy/draft`);
    expect(review.body.data).toMatchObject({
      canConsent: true,
      awaitingPartner: false,
      preJoinReview: {
        writtenAt: before.updated_at.toISOString(),
        partnerJoinedAt: carolP.joined_at.toISOString(),
      },
    });

    // "Send as is": consent after the join is accepted, and the review is over.
    const sent = await http(ada, 'post', `/sessions/${sessionId}/empathy/consent`, { consent: true });
    expect(sent.status).toBeLessThan(300);
    const done = await http(ada, 'get', `/sessions/${sessionId}/empathy/draft`);
    expect(done.body.data.preJoinReview).toBeNull();
  });

  it('a write since the join ends the review ("edit first"); DELETE sets the draft aside', async () => {
    const { sessionId, invitationId, adaParticipant } = await soloStage2Session('Dan');
    const dan = { id: randomUuidV7(), email: `dan-99k2-${process.pid}@e2e.test` };
    expect((await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'Dan is tired.' })).status).toBe(
      200,
    );
    expect((await http(dan, 'post', `/invitations/${invitationId}/accept`)).status).toBe(200);
    expect((await http(ada, 'get', `/sessions/${sessionId}/empathy/draft`)).body.data.preJoinReview).not.toBeNull();

    // Edit first: the draft is written again after the join.
    expect(
      (
        await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, {
          content: 'Dan is tired.',
          readyToShare: false,
        })
      ).status,
    ).toBe(200);
    const edited = await http(ada, 'get', `/sessions/${sessionId}/empathy/draft`);
    expect(edited.body.data).toMatchObject({ preJoinReview: null, draft: { content: 'Dan is tired.', version: 2 } });

    // Set aside.
    const aside = await http(ada, 'delete', `/sessions/${sessionId}/empathy/draft`);
    expect(aside.status).toBe(200);
    expect(aside.body.data).toEqual({ deleted: true });
    expect(await draftsOf(adaParticipant)).toEqual([]);
    expect((await http(ada, 'get', `/sessions/${sessionId}/empathy/draft`)).body.data).toMatchObject({
      draft: null,
      preJoinReview: null,
    });
  });

  it('a pre-join draft set aside before the join is discarded too', async () => {
    const { sessionId, adaParticipant } = await soloStage2Session('Erin');
    await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'Erin is busy.' });
    expect((await http(ada, 'delete', `/sessions/${sessionId}/empathy/draft`)).body.data).toEqual({ deleted: true });
    expect(await draftsOf(adaParticipant)).toEqual([]);
  });
});
