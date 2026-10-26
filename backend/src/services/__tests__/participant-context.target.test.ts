/**
 * TS-9, against a real target database (a clone of the FEEL_HEARD_B target
 * fixture, `mwf_trun_*`):
 *
 *   - participant resolution: once per request, co-participants through
 *     v_co_participant (N-party safe), the two-party partner only when
 *     there is exactly one present human;
 *   - `buildContextForParticipant`: the single cross-participant reader. A
 *     fixture is given the partner's PRIVATE rows of every kind, each carrying
 *     a probe string, plus the S-class rows the participant may see; the
 *     bundle must contain the second and none of the first (spec §7 D2; R1 for
 *     reflections).
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */

import { withClient } from '../../testing/golden/db';
import { restoreFixture, type RestoredFixture } from '../../testing/golden/fixtures';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

/** Private material of the partner (Bob) and of Ada, one probe per P-class kind. */
const BOB_PRIVATE = {
  unsharedNeed: 'PROBE_BOB_UNSHARED_NEED',
  sharedNeedLabel: 'PROBE_BOB_SHARED_NEED_LABEL',
  draft: 'PROBE_BOB_DRAFT',
  reflection: 'PROBE_BOB_REFLECTION_TITLE',
  reflectionMessage: 'PROBE_BOB_REFLECTION_MSG',
  fact: 'PROBE_BOB_FACT',
  summary: 'PROBE_BOB_SUMMARY',
  mood: 'PROBE_BOB_MOOD',
  unrevealedAttempt: 'PROBE_BOB_UNREVEALED_ATTEMPT',
  // Bob's own story in his conversation (the fixture's text).
  chat: "I work so hard and come home exhausted, but there's always more to do.",
};
/** What is private to the SUBJECT of Ada's attempt (Bob), never to its author (P3 D8a). */
const SUBJECT_ONLY = { gap: 'PROBE_RESULT_GAP_SUMMARY', offer: 'PROBE_OFFER_SUGGESTED' };
/** S-class rows Ada may see. */
const SHARED = { needText: 'SHARED_BOB_NEED_TEXT', guidance: 'GUIDANCE_FOR_ADA' };
const ADA_PRIVATE = { reflection: 'PROBE_ADA_REFLECTION_TITLE', reflectionMessage: 'PROBE_ADA_REFLECTION_MSG' };

describeTarget('participant resolution and the single context entry point (target)', () => {
  let fx: RestoredFixture;
  let ids: { session: string; ada: string; bob: string; adaUser: string; bobUser: string; adaAttempt: string };
  // Loaded after DATABASE_URL points at the run database.
  let resolver: typeof import('../participant-resolver');
  let assembler: typeof import('../context-assembler');

  const sql = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
    withClient(fx.target, async c => (await c.query<T>(text, params)).rows, fx.database);

  beforeAll(async () => {
    fx = await restoreFixture({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `ctx_${process.pid}` });
    process.env.DATABASE_URL = fx.url;
    delete process.env.APP_DATABASE_URL;
    delete process.env.JOB_DATABASE_URL;

    const [p] = await sql<{ session: string; ada: string; bob: string; ada_user: string; bob_user: string; attempt: string }>(
      `SELECT pa.session_id AS session, pa.id AS ada, pb.id AS bob, pa.user_id AS ada_user, pb.user_id AS bob_user,
              (SELECT id FROM empathy_attempt WHERE author_participant_id = pa.id) AS attempt
       FROM participant pa JOIN "user" ua ON ua.id = pa.user_id AND ua.email = 'ada@e2e.test'
       JOIN participant pb ON pb.session_id = pa.session_id AND pb.id <> pa.id`,
    );
    ids = { session: p.session, ada: p.ada, bob: p.bob, adaUser: p.ada_user, bobUser: p.bob_user, adaAttempt: p.attempt };

    // --- Bob's private rows -------------------------------------------------------------
    await sql(`INSERT INTO need (participant_id, label, category, ai_confidence) VALUES ($1, $2, 'RECOGNITION', 0.9)`, [
      ids.bob,
      BOB_PRIVATE.unsharedNeed,
    ]);
    const [shared] = await sql<{ id: string }>(
      `INSERT INTO need (participant_id, label, category, ai_confidence, confirmed_at) VALUES ($1, $2, 'CONNECTION', 0.9, now()) RETURNING id`,
      [ids.bob, BOB_PRIVATE.sharedNeedLabel],
    );
    await sql(
      `INSERT INTO consent (participant_id, requested_by_participant_id, need_id, decision, decided_at) VALUES ($1, $1, $2, 'GRANTED', now())`,
      [ids.bob, shared.id],
    );
    await sql(
      `INSERT INTO need_share (need_id, participant_id, session_id, category, shared_text) VALUES ($1, $2, $3, 'CONNECTION', $4)`,
      [shared.id, ids.bob, ids.session, SHARED.needText],
    );
    await sql(
      `INSERT INTO draft (participant_id, kind, about_participant_id, content) VALUES ($1, 'EMPATHY', $2, $3)`,
      [ids.bob, ids.ada, BOB_PRIVATE.draft],
    );
    const [refl] = await sql<{ id: string }>(
      `INSERT INTO reflection (user_id, title, summary, linked_session_id) VALUES ($1, $2, $2, $3) RETURNING id`,
      [ids.bobUser, BOB_PRIVATE.reflection, ids.session],
    );
    await sql(`INSERT INTO reflection_message (reflection_id, role, content) VALUES ($1, 'USER', $2)`, [
      refl.id,
      BOB_PRIVATE.reflectionMessage,
    ]);
    await sql(`INSERT INTO ai_memory (participant_id, kind, doc) VALUES ($1, 'NOTABLE_FACTS', $2)`, [
      ids.bob,
      JSON.stringify({ facts: [{ category: 'Emotional', fact: BOB_PRIVATE.fact }] }),
    ]);
    await sql(`INSERT INTO ai_memory (participant_id, kind, doc) VALUES ($1, 'SUMMARY', $2)`, [
      ids.bob,
      JSON.stringify({ text: BOB_PRIVATE.summary, messageCount: 20, generatedAt: new Date().toISOString() }),
    ]);
    await sql(`INSERT INTO mood_reading (participant_id, intensity, context) VALUES ($1, 9, $2)`, [ids.bob, BOB_PRIVATE.mood]);
    await sql(
      `INSERT INTO empathy_attempt (author_participant_id, subject_participant_id, content, status) VALUES ($1, $2, $3, 'HELD')`,
      [ids.bob, ids.ada, BOB_PRIVATE.unrevealedAttempt],
    );

    // --- The subject's (Bob's) view of Ada's attempt: result and an open offer ---------------
    const [result] = await sql<{ id: string }>(
      `INSERT INTO reconciler_result (attempt_id, subject_participant_id, alignment_score, alignment_summary, gap_summary,
         gap_severity, recommended_action, rationale, sharing_would_help)
       VALUES ($1, $2, 40, 'summary', $3, 'SIGNIFICANT', 'OFFER_SHARING', 'rationale', true) RETURNING id`,
      [ids.adaAttempt, ids.bob, SUBJECT_ONLY.gap],
    );
    await sql(
      `INSERT INTO context_share_offer (attempt_id, result_id, subject_participant_id, status, suggested_content)
       VALUES ($1, $2, $3, 'OFFERED', $4)`,
      [ids.adaAttempt, result.id, ids.bob, SUBJECT_ONLY.offer],
    );
    // ...and the abstract guidance its AUTHOR (Ada) may see.
    await sql(
      `INSERT INTO reconciler_guidance (result_id, author_participant_id, subject_participant_id, area_hint) VALUES ($1, $2, $3, $4)`,
      [result.id, ids.ada, ids.bob, SHARED.guidance],
    );

    // --- Ada's own reflection (R1: never in Bob's prompt) --------------------------------------
    const [adaRefl] = await sql<{ id: string }>(
      `INSERT INTO reflection (user_id, title, summary, linked_session_id) VALUES ($1, $2, $2, $3) RETURNING id`,
      [ids.adaUser, ADA_PRIVATE.reflection, ids.session],
    );
    await sql(`INSERT INTO reflection_message (reflection_id, role, content) VALUES ($1, 'USER', $2)`, [
      adaRefl.id,
      ADA_PRIVATE.reflectionMessage,
    ]);

    resolver = await import('../participant-resolver');
    assembler = await import('../context-assembler');
  });

  afterAll(async () => {
    const { prisma, disconnectJobPrisma } = await import('../../lib/prisma');
    await prisma.$disconnect().catch(() => undefined);
    await disconnectJobPrisma().catch(() => undefined);
    if (fx) await fx.drop();
  });

  const INTENT = {
    intent: 'stage_enforcement',
    depth: 'full',
    reason: 'test',
    threshold: 0.6,
    maxCrossSession: 0,
    allowCrossSession: false,
    surfaceStyle: 'silent',
  } as const;

  // -------------------------------------------------------------------------------------------
  // Participant resolution
  // -------------------------------------------------------------------------------------------

  it('resolves the caller\'s participant with its MAIN conversation', async () => {
    const p = await resolver.resolveParticipant(ids.session, ids.adaUser);
    expect(p).toMatchObject({ id: ids.ada, sessionId: ids.session, userId: ids.adaUser, kind: 'human', leftAt: null });
    const [conv] = await sql<{ id: string }>(`SELECT id FROM conversation WHERE participant_id = $1 AND kind = 'MAIN'`, [ids.ada]);
    expect(p?.mainConversationId).toBe(conv.id);
    expect(await resolver.resolveParticipant(ids.session, '00000000-0000-7000-8000-000000000000')).toBeNull();
  });

  it('finds co-participants through v_co_participant and the two-party partner', async () => {
    const co = await resolver.getCoParticipants(ids.ada);
    expect(co.map(c => c.participantId)).toEqual([ids.bob]);
    expect((await resolver.getPartnerParticipant(ids.ada))?.userId).toBe(ids.bobUser);
    expect(await resolver.getPartnerUserIdFor(ids.session, ids.bobUser)).toBe(ids.adaUser);
  });

  it('is N-party safe: a modeled participant is a co-participant but not "the partner"; a second human makes the partner ambiguous (null)', async () => {
    await sql(`INSERT INTO participant (session_id, kind, display_name) VALUES ($1, 'modeled', 'Coach')`, [ids.session]);
    expect((await resolver.getCoParticipants(ids.ada)).length).toBe(2);
    expect((await resolver.getPartnerParticipant(ids.ada))?.participantId).toBe(ids.bob);

    const [carol] = await sql<{ id: string }>(`INSERT INTO "user" (email, first_name) VALUES ('carol@e2e.test', 'Carol') RETURNING id`);
    const [carolP] = await sql<{ id: string }>(
      `INSERT INTO participant (session_id, user_id, display_name) VALUES ($1, $2, 'Carol') RETURNING id`,
      [ids.session, carol.id],
    );
    try {
      expect((await resolver.getCoParticipants(ids.ada)).length).toBe(3);
      expect(await resolver.getPartnerParticipant(ids.ada)).toBeNull();
    } finally {
      await sql(`DELETE FROM participant WHERE id = $1`, [carolP.id]);
      await sql(`DELETE FROM participant WHERE session_id = $1 AND kind = 'modeled'`, [ids.session]);
    }
  });

  it('requireSessionAccess resolves the participant once and puts it on the request and its context', async () => {
    const { requireSessionAccess } = await import('../../middleware/auth');
    const { runWithContext, getCurrentParticipantId } = await import('../../lib/request-context');
    const req = { user: { id: ids.adaUser }, params: { id: ids.session } } as unknown as import('express').Request;
    let seen: string | undefined;
    let err: unknown;
    await runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now() }, async () => {
      await requireSessionAccess(req, {} as import('express').Response, (e?: unknown) => {
        err = e;
        seen = getCurrentParticipantId();
      });
    });
    expect(err).toBeUndefined();
    expect(req.participant?.id).toBe(ids.ada);
    expect(seen).toBe(ids.ada);

    // A non-member is refused, and a missing session is a 404.
    const [stranger] = await sql<{ id: string }>(`INSERT INTO "user" (email) VALUES ('stranger@e2e.test') RETURNING id`);
    const denied = { user: { id: stranger.id }, params: { id: ids.session } } as unknown as import('express').Request;
    let deniedErr: unknown;
    await requireSessionAccess(denied, {} as import('express').Response, (e?: unknown) => (deniedErr = e));
    expect((deniedErr as { statusCode?: number })?.statusCode).toBe(403);
    expect(denied.participant).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // buildContextForParticipant
  // -------------------------------------------------------------------------------------------

  it("Ada's bundle carries none of Bob's private rows, and none of what only the subject may read", async () => {
    const bundle = await assembler.buildContextForParticipant(ids.ada, { intent: INTENT });
    const text = JSON.stringify(bundle);
    for (const probe of [...Object.values(BOB_PRIVATE), ...Object.values(SUBJECT_ONLY)]) {
      expect({ probe, leaked: text.includes(probe) }).toEqual({ probe, leaked: false });
    }
  });

  it("Ada's bundle carries the shared vessel: Bob's shared need text, her guidance, her own conversation", async () => {
    const bundle = await assembler.buildContextForParticipant(ids.ada, { intent: INTENT });
    expect(bundle.participantId).toBe(ids.ada);
    expect(bundle.stageContext.stage).toBe(2);
    expect(bundle.sharedVessel.sharedNeeds).toEqual([
      expect.objectContaining({ direction: 'partner_to_user', sharedText: SHARED.needText }),
    ]);
    expect(bundle.sharedContentHistory).toContain(SHARED.needText);
    expect(bundle.sharedVessel.guidance).toEqual([expect.objectContaining({ areaHint: SHARED.guidance })]);
    expect(bundle.sharedVessel.empathyAttempts.map(a => a.direction)).toEqual(['user_to_partner']);
    expect(JSON.stringify(bundle.conversationContext)).toContain("I think they're stressed from work too.");
    expect(JSON.stringify(bundle.priorStageSummaries)).toContain('Yes, I feel heard now.');
    expect(bundle.partnerName).toBe('Bob Ross');
  });

  it("R1: Bob's bundle never carries Ada's reflection; his own linked reflection is only acknowledged", async () => {
    const bundle = await assembler.buildContextForParticipant(ids.bob, { intent: INTENT });
    const text = JSON.stringify(bundle);
    for (const probe of Object.values(ADA_PRIVATE)) {
      expect({ probe, leaked: text.includes(probe) }).toEqual({ probe, leaked: false });
    }
    expect(bundle.innerThoughtsContext?.hasLinkedSession).toBe(true);
    // Bob's own private material IS his context.
    expect(text).toContain(BOB_PRIVATE.fact);
    expect(text).toContain(BOB_PRIVATE.summary);
    // Ada's attempt about Bob is unrevealed: absent; the subject-only result is not a prompt input either.
    expect(text).not.toContain('I understand you might be feeling stressed from work.');
  });

  it('the compatibility wrapper resolves (session, user) to the same single entry point', async () => {
    const viaWrapper = await assembler.assembleContextBundle(ids.session, ids.adaUser, 2, INTENT);
    expect(viaWrapper.participantId).toBe(ids.ada);
    expect(JSON.stringify(viaWrapper)).not.toContain(BOB_PRIVATE.unrevealedAttempt);
  });
});
