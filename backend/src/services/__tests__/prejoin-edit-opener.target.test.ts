/**
 * work-9309: "Edit first" on a pre-join empathy draft — the AI speaks first.
 * On a clone of the CREATED target fixture, over HTTP as `mwf_app` (MOCK_LLM).
 *
 * Owner decision 2026-11-07: after the partner joins, the inviter's Edit first
 * ends the review and the AI opens the revision: "Here's what you wrote <day>.
 * Reading it now, what feels different?"
 *
 *   - the durable reopen marker (draft.reopened_at) set with the review,
 *     cleared by the next draft write, kept by the accept's move; an ordinary
 *     proposal turn is never a reopen (HIGH-1);
 *   - one opener, in the author's own conversation only (nothing in the
 *     partner's), generated in the background by the Stage 2 prompt path with
 *     the draft and its written-at day in context; never a proposed statement;
 *     the template on a throw or a timeout, and for a lost (stale) generation;
 *   - at most once: a retry, a second tap, a concurrent call or a recovery
 *     never writes a second opener;
 *   - none without a pending pre-join review (before the join, a draft
 *     written after the join, a review already ended by Send as is).
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndInvitee, httpAs, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

type Http = Awaited<ReturnType<typeof httpAs>>;

describeTarget('Edit first on a pre-join draft: the AI opens the revision (work-9309)', () => {
  let run: TargetRun;
  let http: Http;
  let ada: { id: string; email: string };

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `w9309_editfirst_${process.pid}`);
    const ids = await adaAndInvitee(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    http = await httpAs();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (run) await run.drop();
  });

  /** A new INVITED session of Ada's with Ada in Stage 2 (as empathy-prejoin-draft). */
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

  /** Messages in a participant's MAIN conversation, by role. */
  const messageCounts = async (participantId: string) =>
    (
      await run.sql<{ ai: number; total: number }>(
        `SELECT count(*) FILTER (WHERE m.role = 'AI')::int AS ai, count(*)::int AS total
         FROM message m JOIN conversation c ON c.id = m.conversation_id
         WHERE c.participant_id = $1 AND c.kind = 'MAIN'`,
        [participantId],
      )
    )[0];

  const participantOf = async (sessionId: string, userId: string) =>
    (
      await run.sql<{ id: string }>(`SELECT id FROM participant WHERE session_id = $1 AND user_id = $2`, [
        sessionId,
        userId,
      ])
    )[0].id;

  const draftOf = async (sessionId: string) =>
    (await http(ada, 'get', `/sessions/${sessionId}/empathy/draft`)).body.data;

  /** Ada drafts before the join; the partner accepts. */
  const draftThenJoin = async (inviteName: string, content: string) => {
    const s = await soloStage2Session(inviteName);
    const partner = { id: randomUuidV7(), email: `${inviteName.toLowerCase()}-9309-${process.pid}@e2e.test` };
    expect(
      (await http(ada, 'post', `/sessions/${s.sessionId}/empathy/draft`, { content, readyToShare: true })).status,
    ).toBe(200);
    expect((await http(partner, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    const partnerParticipant = await participantOf(s.sessionId, partner.id);
    return { ...s, partner, partnerParticipant };
  };

  /** Wait (bounded) for the background opener: the participant's AI count reaches `n`. */
  const untilAiCount = async (participantId: string, n: number) => {
    for (let i = 0; i < 200 && (await messageCounts(participantId)).ai < n; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect((await messageCounts(participantId)).ai).toBe(n);
  };

  /** Ada's messages, and her AI messages at or after `reopenedAt`, through the app (decrypted). */
  const openerSince = async (sessionId: string, reopenedAt: string) => {
    const page = await http(ada, 'get', `/sessions/${sessionId}/messages`);
    const messages: Array<{ id: string; role: string; content: string; timestamp: string }> = page.body.data.messages;
    return {
      messages,
      since: messages.filter(m => m.role === 'AI' && new Date(m.timestamp) >= new Date(reopenedAt)),
    };
  };

  const reopenedAtOf = async (sessionId: string, participantId: string) =>
    (
      await run.sql<{ reopened_at: Date | null }>(
        `SELECT d.reopened_at FROM draft d JOIN participant p ON p.id = d.participant_id
         WHERE p.session_id = $1 AND d.participant_id = $2 AND d.kind = 'EMPATHY'`,
        [sessionId, participantId],
      )
    )[0]?.reopened_at ?? null;

  const template = (draft: string, when = 'earlier today') =>
    `Here's what you wrote ${when}:\n\n"${draft}"\n\nNothing has been sent. Reading it now, what feels different?`;

  it('sets the reopen marker with the review, returns at once (202), and writes one opener in the author’s conversation only', async () => {
    const draft = 'Dan might feel unseen when the chores pile up.';
    const { sessionId, adaParticipant, partnerParticipant } = await draftThenJoin('Dan', draft);
    const review = await draftOf(sessionId);
    expect(review.preJoinReview).not.toBeNull();
    expect(review.awaitingRevision).toBe(false);
    const adaBefore = await messageCounts(adaParticipant);
    const partnerBefore = await messageCounts(partnerParticipant);

    const ai = await import('../ai');
    const prompts = await import('../stage-prompts');
    const orchestrated = jest.spyOn(ai, 'getOrchestratedResponse');
    const built = jest.spyOn(prompts, 'buildStagePrompt');

    const res = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, { timeZone: 'UTC' });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ resolved: true, opener: null });
    const reopenedAt: string = res.body.data.reopenedAt;
    // The marker is durable from the response on — before any opener exists.
    expect((await reopenedAtOf(sessionId, adaParticipant))?.toISOString()).toBe(reopenedAt);
    expect((await draftOf(sessionId)).awaitingRevision).toBe(true);

    await untilAiCount(adaParticipant, adaBefore.ai + 1);
    const { messages, since } = await openerSince(sessionId, reopenedAt);
    // MOCK_LLM without a fixture: the template — the day, the draft, the question.
    expect(since).toEqual([expect.objectContaining({ role: 'AI', content: template(draft) })]);
    expect(messages.some(m => /Edit first/.test(m.content))).toBe(false); // the trigger line is not stored

    // The Stage 2 prompt path, with the draft and its written-at day in context — once.
    expect(orchestrated).toHaveBeenCalledTimes(1);
    const [history, ctx] = orchestrated.mock.calls[0];
    expect(ctx).toMatchObject({
      stage: 2,
      userId: ada.id,
      partnerName: 'Dan',
      reopenedPreJoinDraft: { content: draft, writtenAtPhrase: 'earlier today' },
    });
    expect(ctx.currentEmpathyDraft).toBeUndefined();
    expect(ctx.reopenedPreJoinDraft?.writtenAtDate).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}$/);
    expect(history[history.length - 1].content).toMatch(/Edit first/);
    const stage2Prompt = built.mock.calls.find(([stage]) => stage === 2);
    expect(stage2Prompt?.[1].reopenedPreJoinDraft?.content).toBe(draft);
    const result = await orchestrated.mock.results[0].value;
    expect(result.offerReadyToShare).toBe(false);
    expect(result.proposedEmpathyStatement).toBeNull();

    // Exactly one AI row more in Ada's conversation; nothing in the partner's.
    expect(await messageCounts(adaParticipant)).toEqual({ ai: adaBefore.ai + 1, total: adaBefore.total + 1 });
    expect(await messageCounts(partnerParticipant)).toEqual(partnerBefore);

    expect(await draftOf(sessionId)).toMatchObject({
      preJoinReview: null,
      awaitingRevision: true,
      draft: { content: draft, readyToShare: false, version: 2 },
    });
    expect(
      await run.sql(`SELECT count(*)::int AS n FROM empathy_attempt WHERE author_participant_id = $1`, [
        adaParticipant,
      ]),
    ).toEqual([{ n: 0 }]);

    // A retry (second tap, reload's re-tap, another device): the existing opener, nothing new.
    const again = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, { timeZone: 'UTC' });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ resolved: true, reopenedAt, opener: { id: since[0].id } });
    expect(await messageCounts(adaParticipant)).toEqual({ ai: adaBefore.ai + 1, total: adaBefore.total + 1 });
    expect(orchestrated).toHaveBeenCalledTimes(1);

    // The next draft write — the chat turn's autosave of the AI's proposal (the
    // original as is, here) — clears the marker; a later Edit first finds nothing.
    const { saveEmpathyDraft } = await import('../empathy-draft-save');
    expect((await saveEmpathyDraft({ participantId: adaParticipant, content: draft })).status).toBe('saved');
    expect(await reopenedAtOf(sessionId, adaParticipant)).toBeNull();
    expect((await draftOf(sessionId)).awaitingRevision).toBe(false);
    const late = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, {});
    expect(late.body.data).toEqual({ resolved: false, opener: null, reopenedAt: null });
  });

  it('HIGH-1 regression: an ordinary proposal turn whose AI row lands at the draft write’s instant is not a reopen', async () => {
    const s = await soloStage2Session('Ola');
    const ola = { id: randomUuidV7(), email: `ola-9309-${process.pid}@e2e.test` };
    expect((await http(ola, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    // After the join, no Edit first: the chat turn's autosave of the AI's proposal…
    const { saveEmpathyDraft } = await import('../empathy-draft-save');
    const saved = await saveEmpathyDraft({ participantId: s.adaParticipant, content: 'Ola may be worn out.' });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    // …and that turn's AI row in the same millisecond (as a local DB often does).
    const [conv] = await run.sql<{ id: string }>(
      `SELECT id FROM conversation WHERE participant_id = $1 AND kind = 'MAIN'`,
      [s.adaParticipant],
    );
    const { createFacilitatorMessage } = await import('../message-store');
    await createFacilitatorMessage({
      conversationId: conv.id,
      content: 'That is a real shift.',
      createdAt: saved.draft.updatedAt,
    });
    expect(await reopenedAtOf(s.sessionId, s.adaParticipant)).toBeNull();
    expect((await draftOf(s.sessionId)).awaitingRevision).toBe(false);
  });

  it('a retry while the opener is still being generated: resolved, no opener yet, the marker — nothing written', async () => {
    const draft = 'Pia may feel she cannot win.';
    const { sessionId, adaParticipant } = await draftThenJoin('Pia', draft);
    const before = await messageCounts(adaParticipant);
    const ai = await import('../ai');
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const real = ai.getOrchestratedResponse;
    jest.spyOn(ai, 'getOrchestratedResponse').mockImplementationOnce(async (m, c) => {
      await gate;
      return real(m, c);
    });
    try {
      const first = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, {});
      expect(first.status).toBe(202);
      const retry = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, {});
      expect(retry.status).toBe(200);
      expect(retry.body.data).toEqual({ resolved: true, opener: null, reopenedAt: first.body.data.reopenedAt });
      expect((await draftOf(sessionId)).awaitingRevision).toBe(true);
      expect(await messageCounts(adaParticipant)).toEqual(before);
    } finally {
      release();
    }
    await untilAiCount(adaParticipant, before.ai + 1);
  });

  it('MED-2: a lost generation (marker set, no opener, stale) is recovered with the template once', async () => {
    const draft = 'Quin may be bracing for blame.';
    const s = await soloStage2Session('Quin');
    const quin = { id: randomUuidV7(), email: `quin-9309-${process.pid}@e2e.test` };
    expect((await http(quin, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    await http(ada, 'post', `/sessions/${s.sessionId}/empathy/draft`, { content: draft });
    const before = await messageCounts(s.adaParticipant);

    // A fresh marker with no opener: the generation may still be running — nothing is written.
    await run.sql(`UPDATE draft SET reopened_at = now() WHERE participant_id = $1 AND kind = 'EMPATHY'`, [
      s.adaParticipant,
    ]);
    expect((await draftOf(s.sessionId)).awaitingRevision).toBe(true);
    const fresh = await http(ada, 'post', `/sessions/${s.sessionId}/empathy/draft/edit-first`, {});
    expect(fresh.body.data).toMatchObject({ resolved: true, opener: null });
    expect(await messageCounts(s.adaParticipant)).toEqual(before);

    // Older than the generation could take (the process died): the next read
    // writes the template, and only once — concurrent reads and Edit first included.
    await run.sql(
      `UPDATE draft SET reopened_at = now() - interval '10 minutes' WHERE participant_id = $1 AND kind = 'EMPATHY'`,
      [s.adaParticipant],
    );
    const [r1, r2, e1] = await Promise.all([
      http(ada, 'get', `/sessions/${s.sessionId}/empathy/draft`),
      http(ada, 'get', `/sessions/${s.sessionId}/empathy/draft`),
      http(ada, 'post', `/sessions/${s.sessionId}/empathy/draft/edit-first`, {}),
    ]);
    expect([r1.status, r2.status, e1.status]).toEqual([200, 200, 200]);
    expect(await messageCounts(s.adaParticipant)).toEqual({ ai: before.ai + 1, total: before.total + 1 });
    const reopenedAt = (await reopenedAtOf(s.sessionId, s.adaParticipant))!.toISOString();
    const { since } = await openerSince(s.sessionId, reopenedAt);
    expect(since.map(m => m.content)).toEqual([template(draft, 'before Quin joined')]);
    // Still awaiting the AI's proposal; later reads write nothing more.
    expect((await draftOf(s.sessionId)).awaitingRevision).toBe(true);
    expect(await messageCounts(s.adaParticipant)).toEqual({ ai: before.ai + 1, total: before.total + 1 });
  });

  it('the accept’s move keeps the marker (the row is recreated with every fact)', async () => {
    const s = await soloStage2Session('Rae');
    const rae = { id: randomUuidV7(), email: `rae-9309-${process.pid}@e2e.test` };
    await http(ada, 'post', `/sessions/${s.sessionId}/empathy/draft`, { content: 'Rae is tired.' });
    await run.sql(
      `UPDATE draft SET reopened_at = '2026-11-01T10:00:00Z' WHERE participant_id = $1 AND kind = 'EMPATHY'`,
      [s.adaParticipant],
    );
    expect((await http(rae, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    expect((await reopenedAtOf(s.sessionId, s.adaParticipant))?.toISOString()).toBe('2026-11-01T10:00:00.000Z');
  });

  it('two concurrent Edit first calls write one opener', async () => {
    const { sessionId, adaParticipant } = await draftThenJoin('Eve', 'Eve may be tired of asking.');
    const before = await messageCounts(adaParticipant);
    const [a, b] = await Promise.all([
      http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, {}),
      http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, {}),
    ]);
    // Exactly one call ended the review (202); the other answered 200 without writing.
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    await untilAiCount(adaParticipant, before.ai + 1);
    await new Promise(r => setTimeout(r, 300));
    expect((await messageCounts(adaParticipant)).ai).toBe(before.ai + 1);
  });

  it('writes the template when the opener call throws', async () => {
    const draft = 'Kim may feel she carries it alone.';
    const { sessionId, adaParticipant } = await draftThenJoin('Kim', draft);
    const before = await messageCounts(adaParticipant);
    const ai = await import('../ai');
    jest.spyOn(ai, 'getOrchestratedResponse').mockRejectedValueOnce(new Error('injected: Bedrock down'));
    const res = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, { timeZone: 'UTC' });
    expect(res.status).toBe(202);
    await untilAiCount(adaParticipant, before.ai + 1);
    const { since } = await openerSince(sessionId, res.body.data.reopenedAt);
    expect(since.map(m => m.content)).toEqual([template(draft)]);
    expect((await draftOf(sessionId)).awaitingRevision).toBe(true);
  });

  it('writes the template when the model call throws inside the orchestrator', async () => {
    const draft = 'Lou may be scared of the argument.';
    const { sessionId, adaParticipant } = await draftThenJoin('Lou', draft);
    const before = await messageCounts(adaParticipant);
    const bedrock = await import('../../lib/bedrock');
    jest.spyOn(bedrock, 'getModelCompletionWithTools').mockRejectedValue(new Error('injected: the model throws'));
    const res = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, { timeZone: 'UTC' });
    expect(res.status).toBe(202);
    await untilAiCount(adaParticipant, before.ai + 1);
    const { since } = await openerSince(sessionId, res.body.data.reopenedAt);
    expect(since.map(m => m.content)).toEqual([template(draft)]);
  });

  it('writes the template when the opener call times out', async () => {
    const draft = 'Max might feel cornered.';
    const { sessionId, adaParticipant } = await draftThenJoin('Max', draft);
    const before = await messageCounts(adaParticipant);
    const ai = await import('../ai');
    jest.spyOn(ai, 'getOrchestratedResponse').mockImplementationOnce(() => new Promise(() => undefined));
    process.env.PREJOIN_OPENER_TIMEOUT_MS = '200';
    try {
      const res = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, { timeZone: 'UTC' });
      expect(res.status).toBe(202);
      await untilAiCount(adaParticipant, before.ai + 1);
      const { since } = await openerSince(sessionId, res.body.data.reopenedAt);
      expect(since.map(m => m.content)).toEqual([template(draft)]);
    } finally {
      delete process.env.PREJOIN_OPENER_TIMEOUT_MS;
    }
  });

  it('writes nothing without a pending pre-join review', async () => {
    // Before the join: no partner, nothing to review.
    const solo = await soloStage2Session('Fin');
    await http(ada, 'post', `/sessions/${solo.sessionId}/empathy/draft`, { content: 'Fin is busy.' });
    const soloBefore = await messageCounts(solo.adaParticipant);
    const early = await http(ada, 'post', `/sessions/${solo.sessionId}/empathy/draft/edit-first`, {});
    expect(early.status).toBe(200);
    expect(early.body.data).toEqual({ resolved: false, opener: null, reopenedAt: null });
    expect(await messageCounts(solo.adaParticipant)).toEqual(soloBefore);
    expect((await draftOf(solo.sessionId)).draft).toMatchObject({ content: 'Fin is busy.', version: 1 });

    // A draft written after the join is not a pre-join draft.
    const s = await soloStage2Session('Gil');
    const gil = { id: randomUuidV7(), email: `gil-9309-${process.pid}@e2e.test` };
    expect((await http(gil, 'post', `/invitations/${s.invitationId}/accept`)).status).toBe(200);
    await http(ada, 'post', `/sessions/${s.sessionId}/empathy/draft`, { content: 'Gil is far away.' });
    expect((await draftOf(s.sessionId)).preJoinReview).toBeNull();
    const before = await messageCounts(s.adaParticipant);
    const after = await http(ada, 'post', `/sessions/${s.sessionId}/empathy/draft/edit-first`, {});
    expect(after.body.data).toEqual({ resolved: false, opener: null, reopenedAt: null });
    expect(await messageCounts(s.adaParticipant)).toEqual(before);

    // A review already ended by Send as is.
    const sent = await draftThenJoin('Hal', 'Hal may feel overlooked.');
    expect(
      (await http(ada, 'post', `/sessions/${sent.sessionId}/empathy/consent`, { consent: true })).status,
    ).toBeLessThan(300);
    const sentBefore = await messageCounts(sent.adaParticipant);
    const late = await http(ada, 'post', `/sessions/${sent.sessionId}/empathy/draft/edit-first`, {});
    expect(late.body.data).toEqual({ resolved: false, opener: null, reopenedAt: null });
    expect(await messageCounts(sent.adaParticipant)).toEqual(sentBefore);
  });

  it('refuses an invalid body and stays gated to stage 2', async () => {
    const { sessionId, adaParticipant } = await draftThenJoin('Ivo', 'Ivo might feel judged.');
    const bad = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, {
      timeZone: 'UTC"; DROP',
    });
    expect(bad.status).toBe(400);
    await run.sql(`DELETE FROM participant_milestone WHERE participant_id = $1 AND milestone_key = 'feel_heard'`, [
      adaParticipant,
    ]);
    const early = await http(ada, 'post', `/sessions/${sessionId}/empathy/draft/edit-first`, {});
    expect(early.status).toBe(400);
    expect(early.body.error.message).toMatch(/stage 2 is required/);
    // The review is still pending: nothing changed.
    await run.sql(`INSERT INTO participant_milestone (participant_id, milestone_key) VALUES ($1, 'feel_heard')`, [
      adaParticipant,
    ]);
    expect((await draftOf(sessionId)).preJoinReview).not.toBeNull();
  });
});
