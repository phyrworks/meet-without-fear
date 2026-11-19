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
import { aiUrlFor, appUrlFor, workerUrlFor } from '../../testing/golden/driver';
import { restoreFixture, type RestoredFixture } from '../../testing/golden/fixtures';
import { isTargetShape } from '../../testing/golden/shape';
import { actingAs } from './target-roles';

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
const ADA_PRIVATE = {
  reflection: 'PROBE_ADA_REFLECTION_TITLE',
  reflectionMessage: 'PROBE_ADA_REFLECTION_MSG',
  mood: 'PROBE_ADA_MOOD',
};

describeTarget('participant resolution and the single context entry point (target)', () => {
  let fx: RestoredFixture;
  type Seat = { sessionId: string; userId: string };
  let ids: { session: string; ada: Seat; bob: Seat; adaUser: string; bobUser: string; adaAttempt: string };
  // Loaded after DATABASE_URL points at the run database.
  let resolver: typeof import('../participant-resolver');
  let assembler: typeof import('../context-assembler');
  let prompts: typeof import('../stage-prompts');
  let ctx: typeof import('../../lib/request-context');
  /** Run as a request of `userId` (identity binding is on, as in production). */
  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId }, fn);

  const sql = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
    withClient(fx.target, async c => (await c.query<T>(text, params)).rows, fx.database);

  beforeAll(async () => {
    fx = await restoreFixture({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `ctx_${process.pid}` });
    process.env.DATABASE_URL = fx.url;
    // The app logs in as mwf_app, the AI as mwf_ai and the worker as mwf_worker, on this run
    // database (owned by mwf_migrator, work-k5fk.10.1); identity binding on.
    process.env.APP_DATABASE_URL = appUrlFor(fx.target, fx.database);
    process.env.AI_DATABASE_URL = aiUrlFor(fx.target, fx.database);
    process.env.WORKER_DATABASE_URL = workerUrlFor(fx.target, fx.database);
    process.env.DB_IDENTITY_BINDING = 'on';

    const [p] = await sql<{
      session: string;
      ada_user: string;
      bob_user: string;
      attempt: string;
    }>(
      `SELECT pa.session_id AS session, pa.user_id AS ada_user, pb.user_id AS bob_user,
              (SELECT id FROM empathy_attempt WHERE session_id = pa.session_id AND author_user_id = pa.user_id) AS attempt
       FROM participant pa JOIN "user" ua ON ua.id = pa.user_id AND ua.email = 'ada@e2e.test'
       JOIN participant pb ON pb.session_id = pa.session_id AND pb.user_id <> pa.user_id`,
    );
    ids = {
      session: p.session,
      ada: { sessionId: p.session, userId: p.ada_user },
      bob: { sessionId: p.session, userId: p.bob_user },
      adaUser: p.ada_user,
      bobUser: p.bob_user,
      adaAttempt: p.attempt,
    };

    // --- Bob's private rows -------------------------------------------------------------
    await sql(
      `INSERT INTO need (user_id, label, category, ai_confidence, session_id) VALUES ($1::uuid, $2, 'RECOGNITION', 0.9, $3::uuid)`,
      [ids.bobUser, BOB_PRIVATE.unsharedNeed, ids.session],
    );
    const [shared] = await sql<{ id: string }>(
      `INSERT INTO need (user_id, label, category, ai_confidence, confirmed_at, session_id) VALUES ($1::uuid, $2, 'CONNECTION', 0.9, now(), $3::uuid) RETURNING id`,
      [ids.bobUser, BOB_PRIVATE.sharedNeedLabel, ids.session],
    );
    await sql(
      `INSERT INTO consent (need_id, decision, decided_at, user_id, requested_by_user_id, session_id) VALUES ($2, 'GRANTED', now(), $1::uuid, $1::uuid, $3::uuid)`,
      [ids.bobUser, shared.id, ids.session],
    );
    await sql(
      `INSERT INTO need_share (need_id, user_id, session_id, category, shared_text) VALUES ($1, $2::uuid, $3, 'CONNECTION', $4)`,
      [shared.id, ids.bobUser, ids.session, SHARED.needText],
    );
    await sql(
      `INSERT INTO draft (user_id, kind, about_user_id, content, session_id) VALUES ($1::uuid, 'EMPATHY', $2::uuid, $3, $4::uuid)`,
      [ids.bobUser, ids.adaUser, BOB_PRIVATE.draft, ids.session],
    );
    const [refl] = await sql<{ id: string }>(
      `INSERT INTO reflection (user_id, title, summary, linked_session_id) VALUES ($1, $2, $2, $3) RETURNING id`,
      [ids.bobUser, BOB_PRIVATE.reflection, ids.session],
    );
    await sql(`INSERT INTO reflection_message (reflection_id, role, content) VALUES ($1, 'USER', $2)`, [
      refl.id,
      BOB_PRIVATE.reflectionMessage,
    ]);
    await sql(`INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES ($1, $2, 'NOTABLE_FACTS', $3)`, [
      ids.session,
      ids.bobUser,
      JSON.stringify({ facts: [{ category: 'Emotional', fact: BOB_PRIVATE.fact }] }),
    ]);
    await sql(`INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES ($1, $2, 'SUMMARY', $3)`, [
      ids.session,
      ids.bobUser,
      JSON.stringify({ text: BOB_PRIVATE.summary, messageCount: 20, generatedAt: new Date().toISOString() }),
    ]);
    await sql(`INSERT INTO mood_reading (user_id, intensity, context, session_id) VALUES ($1::uuid, 9, $2, $3::uuid)`, [
      ids.bobUser,
      BOB_PRIVATE.mood,
      ids.session,
    ]);
    // Ada's own readings: distinct from Bob's, so whose thread a bundle carries is visible.
    await sql(
      `INSERT INTO mood_reading (session_id, user_id, intensity, context, recorded_at)
       SELECT p.session_id, p.user_id, v.intensity, $3::text, now() - v.ago
       FROM participant p, (VALUES (3, interval '2 minutes'), (6, interval '1 minute')) v(intensity, ago)
       WHERE p.session_id = $1::uuid AND p.user_id = $2::uuid`,
      [ids.session, ids.adaUser, ADA_PRIVATE.mood],
    );
    await sql(
      `INSERT INTO empathy_attempt (author_user_id, subject_user_id, content, status, session_id) VALUES ($1::uuid, $2::uuid, $3, 'HELD', $4::uuid)`,
      [ids.bobUser, ids.adaUser, BOB_PRIVATE.unrevealedAttempt, ids.session],
    );

    // --- The subject's (Bob's) view of Ada's attempt: result and an open offer ---------------
    const [result] = await sql<{ id: string }>(
      `INSERT INTO reconciler_result (attempt_id, author_user_id, subject_user_id, alignment_score, alignment_summary, gap_summary, gap_severity, recommended_action, rationale, sharing_would_help, session_id)
       VALUES ($1, $2::uuid, $3::uuid, 40, 'summary', $4, 'SIGNIFICANT', 'OFFER_SHARING', 'rationale', true, $5::uuid) RETURNING id`,
      [ids.adaAttempt, ids.adaUser, ids.bobUser, SUBJECT_ONLY.gap, ids.session],
    );
    await sql(
      `INSERT INTO context_share_offer (attempt_id, result_id, subject_user_id, status, suggested_content, session_id)
       VALUES ($1, $2, $3::uuid, 'OFFERED', $4, $5::uuid)`,
      [ids.adaAttempt, result.id, ids.bobUser, SUBJECT_ONLY.offer, ids.session],
    );
    // ...and the abstract guidance its AUTHOR (Ada) may see.
    await sql(
      `INSERT INTO reconciler_guidance (result_id, author_user_id, subject_user_id, area_hint, session_id) VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid)`,
      [result.id, ids.adaUser, ids.bobUser, SHARED.guidance, ids.session],
    );

    // --- Ada's own reflection (R1: never in Bob's prompt) — NOT linked to the session ----------
    const [adaRefl] = await sql<{ id: string }>(
      `INSERT INTO reflection (user_id, title, summary) VALUES ($1, $2, $2) RETURNING id`,
      [ids.adaUser, ADA_PRIVATE.reflection],
    );
    await sql(`INSERT INTO reflection_message (reflection_id, role, content) VALUES ($1, 'USER', $2)`, [
      adaRefl.id,
      ADA_PRIVATE.reflectionMessage,
    ]);

    resolver = await import('../participant-resolver');
    assembler = await import('../context-assembler');
    prompts = await import('../stage-prompts');
    ctx = await import('../../lib/request-context');
  });

  afterAll(async () => {
    const { prisma, disconnectRolePrismas } = await import('../../lib/prisma');
    await prisma.$disconnect().catch(() => undefined);
    await disconnectRolePrismas().catch(() => undefined);
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

  it("resolves the caller's participant with its MAIN conversation", async () => {
    const p = await actingAs(ids.adaUser, () => resolver.resolveParticipant(ids.session, ids.adaUser));
    expect(p).toMatchObject({ sessionId: ids.session, userId: ids.adaUser, kind: 'human', leftAt: null });
    const [conv] = await sql<{ id: string }>(
      `SELECT id FROM conversation WHERE session_id = $1 AND user_id = $2 AND kind = 'MAIN'`,
      [ids.session, ids.adaUser],
    );
    expect(p?.mainConversationId).toBe(conv.id);
    expect(
      await actingAs(ids.adaUser, () =>
        resolver.resolveParticipant(ids.session, '00000000-0000-7000-8000-000000000000'),
      ),
    ).toBeNull();
  });

  it('finds co-participants through v_co_participant and the two-party partner', async () => {
    const co = await actingAs(ids.adaUser, () => resolver.getCoParticipants(ids.ada));
    expect(co.map(c => c.userId)).toEqual([ids.bobUser]);
    expect((await actingAs(ids.adaUser, () => resolver.getPartnerParticipant(ids.ada)))?.userId).toBe(ids.bobUser);
    expect(await actingAs(ids.bobUser, () => resolver.getPartnerUserIdFor(ids.session, ids.bobUser))).toBe(ids.adaUser);
  });

  it('is N-party safe: an AI participant is a co-participant but not "the partner"; a second human makes the partner ambiguous (null)', async () => {
    // An AI seat is always brought in by a human (work-k5fk.2: participant_check).
    await sql(
      `INSERT INTO participant (session_id, user_id, kind, added_by_user_id, display_name) VALUES ($1, app.ai_user_id(), 'ai', $2, 'Coach')`,
      [ids.session, ids.adaUser],
    );
    expect((await actingAs(ids.adaUser, () => resolver.getCoParticipants(ids.ada))).length).toBe(2);
    expect((await actingAs(ids.adaUser, () => resolver.getPartnerParticipant(ids.ada)))?.userId).toBe(ids.bobUser);

    const [carol] = await sql<{ id: string }>(
      `INSERT INTO "user" (email, first_name) VALUES ('carol@e2e.test', 'Carol') RETURNING id`,
    );
    await sql(
      `INSERT INTO participant (session_id, user_id, added_by_user_id, display_name) VALUES ($1, $2, $3, 'Carol')`,
      [ids.session, carol.id, ids.adaUser],
    );
    try {
      expect((await actingAs(ids.adaUser, () => resolver.getCoParticipants(ids.ada))).length).toBe(3);
      expect(await actingAs(ids.adaUser, () => resolver.getPartnerParticipant(ids.ada))).toBeNull();
    } finally {
      await sql(`DELETE FROM participant WHERE session_id = $1 AND user_id = $2`, [ids.session, carol.id]);
      await sql(`DELETE FROM participant WHERE session_id = $1 AND kind = 'ai'`, [ids.session]);
    }
  });

  it('requireSessionAccess resolves the participant once and puts it on the request and its context', async () => {
    const { requireSessionAccess } = await import('../../middleware/auth');
    const { runWithContext, getCurrentSeat } = await import('../../lib/request-context');
    const req = { user: { id: ids.adaUser }, params: { id: ids.session } } as unknown as import('express').Request;
    let before: unknown = 'unset';
    let seen: Seat | undefined;
    let err: unknown;
    // The user is on the context already (requireAuth's updateContext); the seat is requireSessionAccess's.
    await runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId: ids.adaUser }, async () => {
      before = getCurrentSeat();
      await requireSessionAccess(req, {} as import('express').Response, (e?: unknown) => {
        err = e;
        seen = getCurrentSeat();
      });
    });
    expect(err).toBeUndefined();
    expect(before).toBeUndefined();
    expect(req.participant).toMatchObject(ids.ada);
    expect(seen).toEqual(ids.ada);

    // A non-member is refused, and a missing session is a 404.
    const [stranger] = await sql<{ id: string }>(
      `INSERT INTO "user" (email) VALUES ('stranger@e2e.test') RETURNING id`,
    );
    const denied = { user: { id: stranger.id }, params: { id: ids.session } } as unknown as import('express').Request;
    let deniedErr: unknown;
    await requireSessionAccess(denied, {} as import('express').Response, (e?: unknown) => (deniedErr = e));
    expect((deniedErr as { statusCode?: number })?.statusCode).toBe(403);
    expect(denied.participant).toBeUndefined();
  });

  it('a participant who left is refused, even as the accepted invitee, and is not resolved', async () => {
    const { requireSessionAccess } = await import('../../middleware/auth');
    await sql(`UPDATE participant SET left_at = now() WHERE session_id = $1 AND user_id = $2`, [
      ids.session,
      ids.bobUser,
    ]);
    try {
      expect(await actingAs(ids.bobUser, () => resolver.resolveParticipant(ids.session, ids.bobUser))).toBeNull();
      expect(
        await actingAs(ids.bobUser, () => resolver.resolveParticipant(ids.session, ids.bobUser, { includeLeft: true })),
      ).toMatchObject(ids.bob);
      // Bob is the invitation's acceptor: the fallback would admit him; it must not be reached.
      const [inv] = await sql<{ accepted_by_user_id: string }>(`SELECT accepted_by_user_id FROM invitation`);
      expect(inv.accepted_by_user_id).toBe(ids.bobUser);
      const req = { user: { id: ids.bobUser }, params: { id: ids.session } } as unknown as import('express').Request;
      let err: unknown;
      await requireSessionAccess(req, {} as import('express').Response, (e?: unknown) => (err = e));
      expect((err as { statusCode?: number })?.statusCode).toBe(403);
      expect(req.participant).toBeUndefined();
    } finally {
      await sql(`UPDATE participant SET left_at = NULL WHERE session_id = $1 AND user_id = $2`, [
        ids.session,
        ids.bobUser,
      ]);
    }
  });

  // -------------------------------------------------------------------------------------------
  // buildContextForParticipant
  // -------------------------------------------------------------------------------------------

  /** Everything a model would see for this participant: the bundle, its rendering, the stage prompt. */
  const promptTextFor = async (seat: Seat) => {
    const userId = seat.userId;
    const bundle = await asUser(userId, () => assembler.buildContextForParticipant(seat, { intent: INTENT }));
    const formatted = assembler.formatContextForPrompt(bundle, {
      sharedContentHistory: bundle.sharedContentHistory,
      milestoneContext: bundle.milestoneContext,
    });
    const stagePrompt = prompts.buildStagePrompt(bundle.stageContext.stage, {
      userName: bundle.userName,
      currentUserId: userId,
      partnerName: bundle.partnerName,
      turnCount: 3,
      emotionalIntensity: bundle.emotionalThread.currentIntensity ?? 5,
      contextBundle: bundle,
      sharedContentHistory: bundle.sharedContentHistory,
      milestoneContext: bundle.milestoneContext,
    });
    return {
      bundle,
      formatted,
      text: [JSON.stringify(bundle), formatted, stagePrompt.staticBlock, stagePrompt.dynamicBlock].join('\n'),
    };
  };

  it("Ada's bundle, its rendering and her stage prompt carry none of Bob's private rows, nor what only the subject may read", async () => {
    const { text, formatted } = await promptTextFor(ids.ada);
    expect(formatted.length).toBeGreaterThan(0);
    for (const probe of [...Object.values(BOB_PRIVATE), ...Object.values(SUBJECT_ONLY)]) {
      expect({ probe, leaked: text.includes(probe) }).toEqual({ probe, leaked: false });
    }
  });

  it("Ada's emotional thread is HERS (3 → 6), never Bob's 9", async () => {
    const { bundle } = await promptTextFor(ids.ada);
    expect(bundle.emotionalThread).toMatchObject({ initialIntensity: 3, currentIntensity: 6 });
  });

  it("Ada's bundle carries the shared vessel: Bob's shared need text, her guidance, her own conversation", async () => {
    const { bundle, formatted } = await promptTextFor(ids.ada);
    expect({ sessionId: bundle.sessionId, userId: bundle.userId }).toEqual(ids.ada);
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
    expect(formatted).toContain(SHARED.needText);
  });

  it("R1: Ada has no linked reflection (false) and Bob's linked one is only acknowledged; neither crosses", async () => {
    const ada = await promptTextFor(ids.ada);
    expect(ada.bundle.innerThoughtsContext?.hasLinkedSession).toBe(false);
    const bob = await promptTextFor(ids.bob);
    expect(bob.bundle.innerThoughtsContext?.hasLinkedSession).toBe(true);
    for (const probe of Object.values(ADA_PRIVATE)) {
      expect({ probe, leaked: bob.text.includes(probe) }).toEqual({ probe, leaked: false });
    }
    // Bob's own private material IS his context.
    expect(bob.text).toContain(BOB_PRIVATE.fact);
    expect(bob.text).toContain(BOB_PRIVATE.summary);
    expect(bob.bundle.emotionalThread.currentIntensity).toBe(9);
    // Ada's attempt about Bob is unrevealed: absent from his prompt.
    expect(bob.text).not.toContain('I understand you might be feeling stressed from work.');
  });

  it('the compatibility wrapper resolves (session, user) to the same single entry point', async () => {
    const viaWrapper = await asUser(ids.adaUser, () =>
      assembler.assembleContextBundle(ids.session, ids.adaUser, 2, INTENT),
    );
    expect({ sessionId: viaWrapper.sessionId, userId: viaWrapper.userId }).toEqual(ids.ada);
    expect(JSON.stringify(viaWrapper)).not.toContain(BOB_PRIVATE.unrevealedAttempt);
  });
});
