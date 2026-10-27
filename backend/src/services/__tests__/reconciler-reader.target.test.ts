/**
 * TS-10 fix round 1, I4 (Ruling R35): the reconciler runs as the job.
 *
 * The analysis reads the subject's NOTABLE_FACTS (ai_memory), the stored
 * analysis and its guidance (reconciler_result / reconciler_guidance), the
 * subject's chat and the author's attempt. Before the fix it read them on the
 * APP connection, under whichever participant's request triggered it. Here the
 * clone's app login loses SELECT on ai_memory, reconciler_result and
 * reconciler_guidance, which nothing else in this flow reads on the app
 * connection; the reconciler must still run end to end, because every one of
 * its reads goes through mwf_job's column grants (trailer T7, "reconciler
 * reader"). Message content cannot be revoked from the app (its own chat reads
 * need it), so that part is covered by review and the job-path grant test.
 *
 * FEEL_HEARD_B clone, app as `mwf_app` (identity binding on). Bob's consent
 * carries the `reconciler-offer-sharing` LLM fixture: both directions are
 * analysed, both analyses stored, each subject offered a share.
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { listTables, withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(240_000);

const BOB_EMPATHY = 'I think you felt unseen when the plans changed without a word from me.';

describeTarget('the reconciler reads through the job, not the triggering request (R35)', () => {
  let harness: Harness;
  const sql = async <T extends Record<string, unknown>>(text: string): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(text)).rows, harness.fixture.database);

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'FEEL_HEARD_B',
      runId: `ts10_reader_${process.pid}`,
      appLogin: 'mwf_app',
    });
    await sql(`REVOKE SELECT ON ai_memory, reconciler_result, reconciler_guidance FROM mwf_app`);
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  it('the app login cannot read the analysis inputs in this clone', async () => {
    const { prisma } = await import('../../lib/prisma');
    await expect(prisma.$queryRaw`SELECT doc FROM ai_memory LIMIT 1`).rejects.toThrow(/permission denied/);
    await expect(prisma.$queryRaw`SELECT gap_summary FROM reconciler_result LIMIT 1`).rejects.toThrow(/permission denied/);
  });

  it("Bob's submission runs both analyses, stores them and offers each subject a share", async () => {
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const bob = harness.actors.userB!;
    const sid = harness.sessionId;
    const draft = await harness.step({
      label: 'draft as bob',
      actor: bob,
      tables: scope,
      call: agent => agent.post(`/api/v1/sessions/${sid}/empathy/draft`).send({ content: BOB_EMPATHY, readyToShare: true }),
    });
    expect(draft.status).toBe(200);
    const consent = await harness.step({
      label: 'consent as bob',
      actor: bob,
      tables: scope,
      asyncBoundary: true,
      call: agent =>
        agent
          .post(`/api/v1/sessions/${sid}/empathy/consent`)
          .set('x-e2e-fixture-id', 'reconciler-offer-sharing')
          .send({ consent: true }),
    });
    expect(consent.status).toBe(200);

    const directions = await sql<{ author: string; status: string; results: number; offers: number }>(`
      SELECT u.email AS author, a.status::text AS status,
             (SELECT count(*)::int FROM reconciler_result r WHERE r.attempt_id = a.id AND r.superseded_at IS NULL) AS results,
             (SELECT count(*)::int FROM context_share_offer o WHERE o.attempt_id = a.id) AS offers
      FROM empathy_attempt a JOIN participant p ON p.id = a.author_participant_id JOIN "user" u ON u.id = p.user_id
      ORDER BY u.email`);
    expect(directions).toEqual([
      { author: 'ada@e2e.test', status: 'AWAITING_SHARING', results: 1, offers: 1 },
      { author: 'bob@e2e.test', status: 'AWAITING_SHARING', results: 1, offers: 1 },
    ]);
  });

  it('m6: POST /reconciler/run stores its fresh analyses and answers with the caller-visible direction only', async () => {
    // Retire the stored analyses so the run has to analyse afresh.
    await sql(`UPDATE reconciler_result SET superseded_at = now() WHERE superseded_at IS NULL`);
    const ada = harness.actors.userA;
    const run = await harness.step({
      label: 'run reconciler as ada',
      actor: ada,
      tables: [],
      call: agent =>
        agent
          .post(`/api/v1/sessions/${harness.sessionId}/reconciler/run`)
          .set('x-e2e-fixture-id', 'reconciler-offer-sharing')
          .send({}),
    });
    expect(run.status).toBe(200);
    const body = (run.body as {
      data: {
        aUnderstandingB: { guesserName: string; subjectId: string } | null;
        bUnderstandingA: { guesserName: string; subjectId: string } | null;
      };
    }).data;
    // Ada (the inviter, A) may see only the analysis of Bob's attempt about her (B→A).
    expect(body.aUnderstandingB).toBeNull();
    expect(body.bUnderstandingA).toMatchObject({ guesserName: 'Bob Ross', subjectId: ada.id });

    const stored = await sql<{ author: string; current: number; all: number }>(`
      SELECT u.email AS author,
             count(*) FILTER (WHERE r.superseded_at IS NULL)::int AS current, count(*)::int AS all
      FROM reconciler_result r JOIN empathy_attempt a ON a.id = r.attempt_id
      JOIN participant p ON p.id = a.author_participant_id JOIN "user" u ON u.id = p.user_id
      GROUP BY u.email ORDER BY u.email`);
    expect(stored).toEqual([
      { author: 'ada@e2e.test', current: 1, all: 2 },
      { author: 'bob@e2e.test', current: 1, all: 2 },
    ]);
  });
});
