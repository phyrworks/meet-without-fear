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

  /** content + written-at of Ada's EMPATHY draft(s), decrypted through the app. */
  const draftOf = async (sessionId: string) =>
    (await http(ada, 'get', `/sessions/${sessionId}/empathy/draft`)).body.data;

  it('after the join only the author ends the review: an autosave is skipped, "edit first" resolves it', async () => {
    const { sessionId, invitationId, adaParticipant } = await soloStage2Session('Dan');
    const dan = { id: randomUuidV7(), email: `dan-99k2-${process.pid}@e2e.test` };
    expect((await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'Dan is tired.' })).status).toBe(
      200,
    );
    expect((await http(dan, 'post', `/invitations/${invitationId}/accept`)).status).toBe(200);
    const [kept] = await draftsOf(adaParticipant);
    expect((await draftOf(sessionId)).preJoinReview).not.toBeNull();

    // An autosave (the client's, or the chat turn's: the same saveEmpathyDraft)
    // of the AI's newest proposal must not replace the pre-join draft.
    const auto = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, {
      content: 'A newer AI proposal.',
      readyToShare: false,
    });
    expect(auto.status).toBe(200);
    expect(auto.body.data.preJoinReviewPending).toBe(true);
    const { saveEmpathyDraft } = await import('../empathy-draft-save');
    expect((await saveEmpathyDraft({ participantId: adaParticipant, content: 'From the chat turn.' })).status).toBe(
      'review_pending',
    );
    expect(await draftsOf(adaParticipant)).toEqual([kept]);
    expect(await draftOf(sessionId)).toMatchObject({
      draft: { content: 'Dan is tired.' },
      preJoinReview: { writtenAt: kept.updated_at.toISOString() },
    });

    // Edit first: the author's explicit choice writes and ends the review.
    const edit = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, {
      content: 'Dan is tired.',
      readyToShare: false,
      resolvePreJoinReview: true,
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data.preJoinReviewPending).toBeUndefined();
    expect(await draftOf(sessionId)).toMatchObject({
      preJoinReview: null,
      draft: { content: 'Dan is tired.', version: 2 },
    });
    // From now on ordinary saves write again.
    await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'Dan is exhausted.' });
    expect((await draftOf(sessionId)).draft.content).toBe('Dan is exhausted.');

    // Set aside.
    const aside = await http(ada, 'delete', `/sessions/${sessionId}/empathy/draft`);
    expect(aside.status).toBe(200);
    expect(aside.body.data).toEqual({ deleted: true });
    expect(await draftsOf(adaParticipant)).toEqual([]);
    expect(await draftOf(sessionId)).toMatchObject({ draft: null, preJoinReview: null });
  });

  it('a pre-join draft set aside before the join is discarded too', async () => {
    const { sessionId, adaParticipant } = await soloStage2Session('Erin');
    await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'Erin is busy.' });
    expect((await http(ada, 'delete', `/sessions/${sessionId}/empathy/draft`)).body.data).toEqual({ deleted: true });
    expect(await draftsOf(adaParticipant)).toEqual([]);
  });

  it('DELETE is gated like save: stage 2 only, and never once the statement was shared', async () => {
    const { sessionId, invitationId, adaParticipant } = await soloStage2Session('Fay');
    const fay = { id: randomUuidV7(), email: `fay-99k2-${process.pid}@e2e.test` };
    await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'Fay is worried.', readyToShare: true });

    // Out of stage 2: refused, the draft kept.
    const feelHeard = [adaParticipant];
    await run.sql(
      `DELETE FROM participant_milestone WHERE participant_id = $1 AND milestone_key = 'feel_heard'`,
      feelHeard,
    );
    const early = await http(ada, 'delete', `/sessions/${sessionId}/empathy/draft`);
    expect(early.status).toBe(400);
    expect(early.body.error.message).toMatch(/stage 2 is required/);
    await run.sql(
      `INSERT INTO participant_milestone (participant_id, milestone_key) VALUES ($1, 'feel_heard')`,
      feelHeard,
    );
    expect(await draftsOf(adaParticipant)).toHaveLength(1);

    // Shared (a submitted round): refused, the draft kept.
    expect((await http(fay, 'post', `/invitations/${invitationId}/accept`)).status).toBe(200);
    expect((await http(ada, 'post', `/sessions/${sessionId}/empathy/consent`, { consent: true })).status).toBeLessThan(
      300,
    );
    const refused = await http(ada, 'delete', `/sessions/${sessionId}/empathy/draft`);
    expect(refused.status).toBe(409);
    expect(await draftsOf(adaParticipant)).toHaveLength(1);
  });

  it('an expired invitation keeps the draft readable and writable (no re-issue path exists)', async () => {
    const { sessionId, invitationId, adaParticipant } = await soloStage2Session('Gus');
    await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'Gus is far away.' });
    await run.sql(`UPDATE invitation SET status = 'EXPIRED', expires_at = now() - interval '1 minute' WHERE id = $1`, [
      invitationId,
    ]);
    expect(await draftOf(sessionId)).toMatchObject({ draft: { content: 'Gus is far away.' }, awaitingPartner: true });
    expect((await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'Gus is far.' })).status).toBe(
      200,
    );
    expect(await draftsOf(adaParticipant)).toMatchObject([{ invitation_id: invitationId, version: 2 }]);
  });

  describe('save vs accept, interleaved on two connections', () => {
    /** A promise and its resolver: the test holds one side mid-transaction until it is released. */
    // Every gate is opened after each test, so a failing assertion never leaves a
    // transaction holding its lock (the run database could not be dropped).
    const gates: Array<() => void> = [];
    afterEach(() => gates.splice(0).forEach(open => open()));
    const gate = () => {
      let open!: () => void;
      const p = new Promise<void>(r => (open = r));
      gates.push(open);
      return { p, open };
    };
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 25));
      expect(cond()).toBe(true);
    };
    let settled = false;
    const track = <T>(p: Promise<T>) => p.finally(() => (settled = true));

    it('(a) a save holding the invitation commits before the accept moves the drafts: the newest text is carried', async () => {
      const { sessionId, invitationId, adaParticipant } = await soloStage2Session('Hal');
      const hal = { id: randomUuidV7(), email: `hal-99k2-${process.pid}@e2e.test` };
      await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'v1' });

      const store = await import('../empathy-store');
      const real = store.upsertDraft;
      const held = gate();
      let inside = false;
      // The save has its invitation FOR SHARE when it reaches the upsert; hold it there.
      jest.spyOn(store, 'upsertDraft').mockImplementationOnce(async (o, c) => {
        inside = true;
        await held.p;
        return real(o, c);
      });
      const save = http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'v2' });
      await until(() => inside);
      settled = false;
      const accept = track(http(hal, 'post', `/invitations/${invitationId}/accept`));
      await new Promise(r => setTimeout(r, 300));
      expect(settled).toBe(false); // the accept waits on the invitation lock
      held.open();
      expect((await save).status).toBe(200);
      expect((await accept).status).toBe(200);

      const [d] = await draftsOf(adaParticipant);
      expect(d.invitation_id).toBeNull();
      expect(d.about_participant_id).not.toBeNull();
      expect((await draftOf(sessionId)).draft).toMatchObject({ content: 'v2', version: 2 });
    });

    it('(b) a save arriving during the accept waits, sees ACCEPTED, and leaves no orphan on the invitation', async () => {
      const { sessionId, invitationId, adaParticipant } = await soloStage2Session('Ivy');
      const ivy = { id: randomUuidV7(), email: `ivy-99k2-${process.pid}@e2e.test` };
      await http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'before the join' });

      const store = await import('../empathy-store');
      const real = store.repointInvitationDrafts;
      const held = gate();
      let inside = false;
      // The accept holds the invitation FOR UPDATE from its first statement; hold it at the move.
      jest.spyOn(store, 'repointInvitationDrafts').mockImplementationOnce(async (tx, inv, p) => {
        inside = true;
        await held.p;
        return real(tx, inv, p);
      });
      const accept = http(ivy, 'post', `/invitations/${invitationId}/accept`);
      await until(() => inside);
      settled = false;
      const save = track(http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'raced autosave' }));
      await new Promise(r => setTimeout(r, 300));
      expect(settled).toBe(false); // the save waits on the invitation lock
      held.open();
      expect((await accept).status).toBe(200);
      const saved = await save;
      expect(saved.status).toBe(200);
      // After the join the moved pre-join draft awaits review: the autosave is skipped.
      expect(saved.body.data.preJoinReviewPending).toBe(true);

      const rows = await draftsOf(adaParticipant);
      expect(rows).toHaveLength(1);
      expect(rows[0].invitation_id).toBeNull();
      expect(await run.sql(`SELECT count(*)::int AS n FROM draft WHERE invitation_id = $1`, [invitationId])).toEqual([
        { n: 0 },
      ]);
      expect((await draftOf(sessionId)).draft.content).toBe('before the join');
    });

    it('(b) with no draft before the join, the raced save writes against the new participant', async () => {
      const { sessionId, invitationId, adaParticipant } = await soloStage2Session('Jo');
      const jo = { id: randomUuidV7(), email: `jo-99k2-${process.pid}@e2e.test` };
      const store = await import('../empathy-store');
      const real = store.repointInvitationDrafts;
      const held = gate();
      let inside = false;
      jest.spyOn(store, 'repointInvitationDrafts').mockImplementationOnce(async (tx, inv, p) => {
        inside = true;
        await held.p;
        return real(tx, inv, p);
      });
      const accept = http(jo, 'post', `/invitations/${invitationId}/accept`);
      await until(() => inside);
      const save = http(ada, 'post', `/sessions/${sessionId}/empathy/draft`, { content: 'first words' });
      await new Promise(r => setTimeout(r, 300));
      held.open();
      expect((await accept).status).toBe(200);
      expect((await save).status).toBe(200);
      const rows = await draftsOf(adaParticipant);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ invitation_id: null });
      expect(rows[0].about_participant_id).not.toBeNull();
      expect((await draftOf(sessionId)).draft.content).toBe('first words');
    });
  });
});
