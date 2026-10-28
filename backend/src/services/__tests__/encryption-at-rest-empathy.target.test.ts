/**
 * TS-13, real roles with FIELD_ENCRYPTION_KEY set, on a clone of the
 * RECONCILER_SHOWN_B target fixture (Ada's round 1 about Bob is
 * AWAITING_SHARING with an offer to Bob; Bob's round 1 about Ada is HELD): the
 * session / chat / empathy / reconciler columns, each written by its real
 * writer (mwf_app with identity binding on; mwf_job for the job's writers),
 * are ciphertext at rest and read back as plaintext.
 *
 *   - message.content with content_hash = SHA-256 of the plaintext (the
 *     participant's turn, a facilitator row, a delivered SHARED_CONTEXT, the
 *     reveal's EMPATHY_STATEMENT copy written by app.empathy_set_status);
 *   - empathy_attempt.content: the resubmission through
 *     app.empathy_set_status(…, content) gets ciphertext;
 *   - the share moments call the W13 hook (reveal, share-offer delivery).
 *
 * Requires: npx tsx src/testing/golden/cli.ts build RECONCILER_SHOWN_B
 */

import { COVERAGE, expectSealed } from './encryption-at-rest';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';
import { contentHash } from '../../utils/content-hash';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(240_000);

describeTarget(
  'encryption at rest: session, chat, empathy and reconciler columns (FIELD_ENCRYPTION_KEY set, real roles)',
  () => {
    let run: TargetRun;
    let ids: Awaited<ReturnType<typeof adaAndBob>>;
    let ctx: typeof import('../../lib/request-context');
    let moments: typeof import('../../lib/share-moments');
    let hook: jest.SpyInstance;
    let http: Awaited<ReturnType<typeof httpAs>>;
    let store: typeof import('../empathy-store');
    let messages: typeof import('../message-store');
    let prisma: typeof import('../../lib/prisma').prisma;
    let ada: { id: string; email: string };
    let bob: { id: string; email: string };
    let conv: { ada: string; bob: string };
    let adaRound1: string;
    let bobRound1: string;
    const proven = new Set<string>();
    const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
      ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId }, async () => await fn());
    const momentsCalled = (moment: string) =>
      hook.mock.calls
        .filter(([e]) => (e as { moment: string }).moment === moment)
        .map(([e, client]) => {
          // fix round 1 (minor 6): every hook runs inside the share's transaction, which it is handed
          expect(client).toBeDefined();
          return e;
        });
    const REVISED = 'PROBE_TS13_ROUND_TWO I see you are running on empty';

    beforeAll(async () => {
      run = await openTargetRun('RECONCILER_SHOWN_B', `ts13_empathy_${process.pid}`);
      ids = await adaAndBob(run);
      ada = { id: ids.adaUser, email: 'ada@e2e.test' };
      bob = { id: ids.bobUser, email: 'bob@e2e.test' };
      ctx = await import('../../lib/request-context');
      moments = await import('../../lib/share-moments');
      http = await httpAs();
      store = await import('../empathy-store');
      messages = await import('../message-store');
      ({ prisma } = await import('../../lib/prisma'));
      const cs = await run.sql<{ participant_id: string; id: string }>(
        `SELECT participant_id, id FROM conversation WHERE kind = 'MAIN' AND participant_id = ANY($1::uuid[])`,
        [[ids.ada, ids.bob]],
      );
      conv = {
        ada: cs.find(c => c.participant_id === ids.ada)!.id,
        bob: cs.find(c => c.participant_id === ids.bob)!.id,
      };
      const attempts = await run.sql<{ id: string; author: string }>(
        `SELECT id, author_participant_id AS author FROM empathy_attempt WHERE round = 1`,
      );
      adaRound1 = attempts.find(a => a.author === ids.ada)!.id;
      bobRound1 = attempts.find(a => a.author === ids.bob)!.id;
    });
    // jest.config restoreMocks: spies are restored before every test, so the hook spy is per test
    beforeEach(() => {
      hook = jest.spyOn(moments, 'reencryptForSession');
    });
    afterAll(async () => {
      jest.restoreAllMocks();
      if (run) await run.drop();
    });

    it('message.content (participant turn as mwf_app, facilitator row as mwf_job): sealed, content_hash of the plaintext, read back', async () => {
      const own = await asUser(ids.adaUser, () =>
        messages.createParticipantMessage({
          conversationId: conv.ada,
          participantId: ids.ada,
          content: 'PROBE_TS13_TURN',
        }),
      );
      const ai = await messages.createFacilitatorMessage({ conversationId: conv.ada, content: 'PROBE_TS13_AI_REPLY' });
      await expectSealed(run, 'message', 'content', `id = ANY($1::uuid[])`, [[own.id, ai.id]]);
      const hashes = await run.sql<{ id: string; content_hash: string }>(
        `SELECT id, content_hash FROM message WHERE id = ANY($1::uuid[])`,
        [[own.id, ai.id]],
      );
      expect(Object.fromEntries(hashes.map(h => [h.id, h.content_hash]))).toEqual({
        [own.id]: contentHash('PROBE_TS13_TURN'),
        [ai.id]: contentHash('PROBE_TS13_AI_REPLY'),
      });
      const listed = await asUser(ids.adaUser, () =>
        messages.listConversationMessages({ conversationId: conv.ada, limit: 500, order: 'asc' }),
      );
      expect(listed.map(m => m.content)).toEqual(expect.arrayContaining(['PROBE_TS13_TURN', 'PROBE_TS13_AI_REPLY']));
      proven.add('message.content');
    });

    it('fix round 1 (I1): text the author types in the ciphertext format is stored encrypted and the partner still reads their conversation', async () => {
      const typed = 'enc:v1:a:b:c';
      const delivered = await messages.deliverMessage({
        toConversationId: conv.bob,
        fromParticipantId: ids.ada,
        kind: 'SHARED_CONTEXT',
        content: typed,
      });
      const [stored] = (await expectSealed(run, 'message', 'content', `id = $1`, [delivered.id])) as string[];
      expect(stored).not.toBe(typed);
      const bobs = await asUser(ids.bobUser, () =>
        messages.listConversationMessages({ conversationId: conv.bob, limit: 500, order: 'asc' }),
      );
      expect(bobs.find(m => m.id === delivered.id)?.content).toBe(typed);
    });

    it('mood_reading.context (POST /emotions as mwf_app): sealed, read back', async () => {
      const res = await http(bob, 'post', `/sessions/${ids.session}/emotions`, {
        intensity: 6,
        context: 'PROBE_TS13_MOOD tired',
      });
      expect(res.status).toBeLessThan(300);
      await expectSealed(run, 'mood_reading', 'context', `participant_id = $1 AND context IS NOT NULL`, [ids.bob]);
      const back = await asUser(ids.bobUser, () =>
        prisma.moodReading.findFirst({
          where: { participantId: ids.bob, context: { not: null } },
          select: { context: true },
        }),
      );
      expect(back?.context).toBe('PROBE_TS13_MOOD tired');
      proven.add('mood_reading.context');
    });

    it('draft.content (upsertDraft, raw INSERT … RETURNING as mwf_app): sealed; the RETURNING row and findDraft read plaintext', async () => {
      const written = await asUser(ids.adaUser, () =>
        store.upsertDraft({
          participantId: ids.ada,
          kind: 'EMPATHY',
          aboutParticipantId: ids.bob,
          content: 'PROBE_TS13_DRAFT',
        }),
      );
      expect(written.content).toBe('PROBE_TS13_DRAFT');
      await expectSealed(run, 'draft', 'content', `id = $1`, [written.id]);
      const found = await asUser(ids.adaUser, () =>
        store.findDraft({ participantId: ids.ada, kind: 'EMPATHY', aboutParticipantId: ids.bob }),
      );
      expect(found?.content).toBe('PROBE_TS13_DRAFT');
      proven.add('draft.content');
    });

    it('reconciler_result (persistAnalysis, raw INSERT as mwf_job): text and text[] sealed, read back', async () => {
      const analysis = await import('../reconciler/analysis');
      const result = analysis.getDefaultReconcilerResult();
      result.alignment.summary = 'PROBE_TS13_ALIGNMENT';
      result.alignment.correctlyIdentified = ['PROBE_TS13_RIGHT'];
      result.gaps.summary = 'PROBE_TS13_GAP';
      result.gaps.missedFeelings = ['PROBE_TS13_MISSED'];
      result.gaps.misattributions = ['PROBE_TS13_WRONG'];
      // R46 (fix round 1): the subject's private analysis and suggestion
      result.gaps.mostImportantGap = 'PROBE_TS13_MOST_IMPORTANT';
      result.recommendation.rationale = 'PROBE_TS13_RATIONALE';
      result.recommendation.suggestedShareFocus = 'PROBE_TS13_FOCUS';
      const id = await analysis.persistAnalysis({
        attemptId: bobRound1,
        authorParticipantId: ids.bob,
        subjectParticipantId: ids.ada,
        result,
        guidance: { areaHint: 'PROBE_TS13_AREA', guidanceType: 'challenge_assumptions', promptSeed: 'PROBE_TS13_SEED' },
        suggestion: { content: 'PROBE_TS13_SUGGESTION', reason: 'PROBE_TS13_SUGGESTION_REASON' },
      });
      expect(id).toEqual(expect.any(String));
      for (const column of [
        'most_important_gap',
        'rationale',
        'suggested_share_focus',
        'suggested_share_content',
        'suggested_share_reason',
        'alignment_summary',
        'gap_summary',
        'correctly_identified',
        'missed_feelings',
        'misattributions',
      ]) {
        await expectSealed(run, 'reconciler_result', column, `id = $1`, [id]);
        proven.add(`reconciler_result.${column}`);
      }
      const stored = await analysis.currentResultFor(bobRound1);
      expect(stored).toMatchObject({
        alignmentSummary: 'PROBE_TS13_ALIGNMENT',
        gapSummary: 'PROBE_TS13_GAP',
        correctlyIdentified: ['PROBE_TS13_RIGHT'],
        missedFeelings: ['PROBE_TS13_MISSED'],
        misattributions: ['PROBE_TS13_WRONG'],
        mostImportantGap: 'PROBE_TS13_MOST_IMPORTANT',
        rationale: 'PROBE_TS13_RATIONALE',
        suggestedShareFocus: 'PROBE_TS13_FOCUS',
        suggestedShareContent: 'PROBE_TS13_SUGGESTION',
        suggestedShareReason: 'PROBE_TS13_SUGGESTION_REASON',
      });
      for (const column of ['area_hint', 'prompt_seed']) {
        await expectSealed(run, 'reconciler_guidance', column, `result_id = $1`, [id]);
        proven.add(`reconciler_guidance.${column}`);
      }
      expect(await analysis.guidanceFor(id!)).toEqual({
        areaHint: 'PROBE_TS13_AREA',
        guidanceType: 'challenge_assumptions',
        promptSeed: 'PROBE_TS13_SEED',
      });
    });

    it('context_share_offer offer_message / suggested_* (generateShareOffer, raw INSERT as mwf_job): sealed, read back', async () => {
      const analysis = await import('../reconciler/analysis');
      const sonnet = jest
        .spyOn(analysis, 'getSonnetJson')
        .mockImplementation((async (o: { operation: string }) =>
          o.operation === 'reconciler-share-offer'
            ? { message: 'PROBE_TS13_OFFER_MESSAGE' }
            : { suggestedContent: 'PROBE_TS13_SUGGESTED', reason: 'PROBE_TS13_REASON' }) as never);
      const sharing = await import('../reconciler/sharing');
      const offer = await sharing.generateShareOffer(ids.session, ids.adaUser);
      sonnet.mockRestore();
      expect(offer).toMatchObject({
        offerMessage: 'PROBE_TS13_OFFER_MESSAGE',
        suggestedContent: 'PROBE_TS13_SUGGESTED',
      });
      for (const column of ['offer_message', 'suggested_content', 'suggested_reason']) {
        await expectSealed(run, 'context_share_offer', column, `subject_participant_id = $1`, [ids.ada]);
        proven.add(`context_share_offer.${column}`);
      }
      const back = await asUser(ids.adaUser, () =>
        prisma.contextShareOffer.findFirst({
          where: { subjectParticipantId: ids.ada },
          select: { offerMessage: true, suggestedContent: true, suggestedReason: true },
        }),
      );
      expect(back).toEqual({
        offerMessage: 'PROBE_TS13_OFFER_MESSAGE',
        suggestedContent: 'PROBE_TS13_SUGGESTED',
        suggestedReason: 'PROBE_TS13_REASON',
      });
    });

    it('context_share_offer.shared_content and the SHARED_CONTEXT copy (Bob accepts, app + job): sealed; the delivery calls the hook', async () => {
      hook.mockClear();
      const res = await http(bob, 'post', `/sessions/${ids.session}/reconciler/share-offer/respond`, {
        action: 'accept',
      });
      expect(res.status).toBe(200);
      await expectSealed(
        run,
        'context_share_offer',
        'shared_content',
        `subject_participant_id = $1 AND shared_content IS NOT NULL`,
        [ids.bob],
      );
      const [copy] = await expectSealed(run, 'message', 'content', `kind = 'SHARED_CONTEXT' AND conversation_id = $1`, [
        conv.ada,
      ]);
      void copy;
      const [offerRow] = await run.sql<{ id: string }>(
        `SELECT id FROM context_share_offer WHERE subject_participant_id = $1 AND shared_content IS NOT NULL`,
        [ids.bob],
      );
      const shared = await asUser(ids.bobUser, () =>
        prisma.contextShareOffer.findUnique({ where: { id: offerRow.id }, select: { sharedContent: true } }),
      );
      const adaMessages = await asUser(ids.adaUser, () =>
        messages.listConversationMessages({ conversationId: conv.ada, limit: 500, order: 'asc' }),
      );
      const delivered = adaMessages.find(m => m.kind === 'SHARED_CONTEXT');
      expect(delivered?.content).toBe(shared?.sharedContent);
      expect(delivered?.content).not.toContain('enc:v1:');
      const [{ content_hash }] = await run.sql<{ content_hash: string }>(
        `SELECT content_hash FROM message WHERE kind = 'SHARED_CONTEXT' AND conversation_id = $1`,
        [conv.ada],
      );
      expect(content_hash).toBe(contentHash(delivered!.content));
      expect(momentsCalled('share-offer-delivery')).toEqual([
        expect.objectContaining({
          moment: 'share-offer-delivery',
          sessionId: ids.session,
          rows: expect.arrayContaining([{ table: 'context_share_offer', id: offerRow.id }]),
        }),
      ]);
      proven.add('context_share_offer.shared_content');
    });

    it('empathy_attempt.content: the resubmission through app.empathy_set_status gets ciphertext; read back', async () => {
      const round2 = await asUser(ids.adaUser, () => store.resubmitAttempt(adaRound1, REVISED));
      await expectSealed(run, 'empathy_attempt', 'content', `id = $1`, [round2]);
      const back = await asUser(ids.adaUser, () => store.attemptById(round2));
      expect(back?.content).toBe(REVISED);
      proven.add('empathy_attempt.content');
    });

    it('the reveal (checkAndRevealBothIfReady as mwf_job): the EMPATHY_STATEMENT copies are ciphertext, the subject reads plaintext, the hook runs', async () => {
      await asUser(ids.bobUser, () => store.setAttemptStatus(bobRound1, 'READY', { actor: 'participant' }));
      const round2 = (await store.currentAttempt(ids.ada, ids.bob))!;
      await store.setAttemptStatus(round2.id, 'READY', { actor: 'job' });
      hook.mockClear();
      const state = await import('../reconciler/state');
      expect(await state.checkAndRevealBothIfReady(ids.session)).toBe(true);
      await expectSealed(
        run,
        'message',
        'content',
        `kind = 'EMPATHY_STATEMENT' AND conversation_id = $1 AND source_attempt_id = $2`,
        [conv.bob, round2.id],
      );
      const bobMessages = await asUser(ids.bobUser, () =>
        messages.listConversationMessages({ conversationId: conv.bob, limit: 500, order: 'asc' }),
      );
      expect(bobMessages.find(m => m.kind === 'EMPATHY_STATEMENT' && m.sourceAttemptId === round2.id)?.content).toBe(
        REVISED,
      );
      expect(momentsCalled('empathy-reveal')).toEqual([
        {
          moment: 'empathy-reveal',
          sessionId: ids.session,
          rows: expect.arrayContaining([
            { table: 'empathy_attempt', id: round2.id },
            { table: 'empathy_attempt', id: bobRound1 },
            // the subjects' EMPATHY_STATEMENT copies (fix round 1, minor 6)
            expect.objectContaining({ table: 'message', id: round2.id, by: 'source_attempt_id' }),
            expect.objectContaining({ table: 'message', id: bobRound1, by: 'source_attempt_id' }),
          ]),
        },
      ]);
    });

    it('empathy_review.feedback (recordReview as mwf_app): sealed; the author reads it once sent', async () => {
      await asUser(ids.adaUser, () =>
        store.recordReview({
          attemptId: bobRound1,
          reviewerParticipantId: ids.ada,
          validated: false,
          sentFeedback: 'PROBE_TS13_FEEDBACK the evenings',
          at: new Date(),
        }),
      );
      await expectSealed(run, 'empathy_review', 'feedback', `attempt_id = $1`, [bobRound1]);
      const seen = await asUser(ids.bobUser, () => store.reviewVisibleToAuthor(bobRound1, ids.ada));
      expect(seen?.feedback).toBe('PROBE_TS13_FEEDBACK the evenings');
      proven.add('empathy_review.feedback');
    });

    it('invitation.name (POST /sessions as mwf_app) and session.topic_frame (model API, as the chat turn writes it): sealed, read back', async () => {
      const created = await http(ada, 'post', '/sessions', { inviteName: 'PROBE_TS13_CAROL' });
      expect(created.status).toBe(201);
      const sessionId = created.body.data.session.id as string;
      const invitationId = created.body.data.invitationId as string;
      await expectSealed(run, 'invitation', 'name', `id = $1`, [invitationId]);
      const inv = await asUser(ids.adaUser, () =>
        prisma.invitation.findUnique({ where: { id: invitationId }, select: { name: true } }),
      );
      expect(inv?.name).toBe('PROBE_TS13_CAROL');
      // R46: the decliner's reason (POST /invitations/:id/decline as Bob)
      const declined = await http(bob, 'post', `/invitations/${invitationId}/decline`, {
        reason: 'PROBE_TS13_DECLINE',
      });
      expect(declined.status).toBeLessThan(300);
      await expectSealed(run, 'invitation', 'decline_reason', `id = $1`, [invitationId]);
      const back = await asUser(ids.adaUser, () =>
        prisma.invitation.findUnique({ where: { id: invitationId }, select: { declineReason: true } }),
      );
      expect(back?.declineReason).toBe('PROBE_TS13_DECLINE');
      proven.add('invitation.decline_reason');
      await asUser(ids.adaUser, () =>
        prisma.session.update({ where: { id: sessionId }, data: { topicFrame: 'PROBE_TS13_TOPIC chores' } }),
      );
      await expectSealed(run, 'session', 'topic_frame', `id = $1`, [sessionId]);
      const s = await asUser(ids.adaUser, () =>
        prisma.session.findUnique({ where: { id: sessionId }, select: { topicFrame: true } }),
      );
      expect(s?.topicFrame).toBe('PROBE_TS13_TOPIC chores');
      proven.add('invitation.name');
      proven.add('session.topic_frame');
    });

    it('covers every session/chat/empathy/reconciler column of the map', () => {
      expect([...proven].sort()).toEqual([...COVERAGE.empathy].sort());
    });
  },
);
