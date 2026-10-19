/**
 * The `old_concept_*` views over the current shape (`concept-views/current-shape.sql`).
 *
 * The recorded normalised baselines are the main test of these views; this file
 * pins the structural facts a baseline can only show indirectly — every message
 * has an audience, every participant has a user, the step-7 decoding is
 * complete — with targeted SQL against a fresh FEEL_HEARD_B clone.
 *
 * Requires a running local Postgres and a built fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */

import * as fs from 'fs';
import {
  CONCEPT_NAMES,
  CURRENT_SHAPE_SQL,
  applyConceptViews,
  takeConceptSnapshot,
  viewName,
  viewsDefinedIn,
} from '../concept-views';
import { withClient } from '../db';
import { restoreFixture, RestoredFixture } from '../fixtures';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

jest.setTimeout(120_000);

describe('concept views — declaration', () => {
  it('current-shape.sql creates exactly the declared concept views (plus concept_check_* views)', () => {
    const defined = viewsDefinedIn(fs.readFileSync(CURRENT_SHAPE_SQL, 'utf8'));
    expect(defined.filter(v => !v.startsWith('concept_check_'))).toEqual(CONCEPT_NAMES.map(viewName).sort());
  });
});

describe('concept views — FEEL_HEARD_B', () => {
  let fx: RestoredFixture;
  const q = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    withClient(fx.target, async c => (await c.query<T>(sql)).rows, fx.database);
  const one = async (sql: string): Promise<unknown> => Object.values((await q(sql))[0])[0];

  beforeAll(async () => {
    fx = await restoreFixture({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `concept_views_${process.pid}` });
    await applyConceptViews(fx.target, fx.database);
  });

  afterAll(async () => {
    if (fx) await fx.drop();
  });

  it('has one participant per (session, user): two in FEEL_HEARD_B', async () => {
    expect(Number(await one(`SELECT count(*) FROM old_concept_participant`))).toBe(2);
    expect(
      Number(await one(`SELECT count(*) FROM (SELECT DISTINCT session_id, user_id FROM old_concept_participant) x`)),
    ).toBe(2);
  });

  it('resolves every participant to a user', async () => {
    expect(
      await q(`SELECT p.id FROM old_concept_participant p LEFT JOIN old_concept_user u ON u.id = p.user_id WHERE u.id IS NULL`),
    ).toEqual([]);
  });

  it('gives every participant exactly one MAIN conversation', async () => {
    expect(
      await q(`SELECT p.id, count(c.id) AS n FROM old_concept_participant p
               LEFT JOIN old_concept_conversation c ON c.participant_id = p.id AND c.kind = 'MAIN'
               GROUP BY p.id HAVING count(c.id) <> 1`),
    ).toEqual([]);
  });

  it('resolves every message to a conversation, and so to a participant', async () => {
    expect(Number(await one(`SELECT count(*) FROM old_concept_message`))).toBe(23);
    expect(
      await q(`SELECT m.id FROM old_concept_message m
               LEFT JOIN old_concept_conversation c ON c.id = m.conversation_id
               LEFT JOIN old_concept_participant p ON p.id = c.participant_id
               WHERE p.id IS NULL`),
    ).toEqual([]);
  });

  it('satisfies the target message CHECKs: USER has a sender, AI/SYSTEM have none', async () => {
    expect(
      await q(`SELECT id, role FROM old_concept_message
               WHERE (role = 'USER' AND sender_participant_id IS NULL)
                  OR (role IN ('AI','SYSTEM') AND sender_participant_id IS NOT NULL)`),
    ).toEqual([]);
  });

  it('keeps the privacy split: the two conversations hold different messages (13 / 10)', async () => {
    const rows = await q<{ who: string; n: string }>(
      `SELECT u.email AS who, count(*) AS n FROM old_concept_message m
       JOIN old_concept_conversation c ON c.id = m.conversation_id
       JOIN old_concept_participant p ON p.id = c.participant_id
       JOIN old_concept_user u ON u.id = p.user_id GROUP BY u.email ORDER BY u.email`,
    );
    expect(rows.map(r => [r.who, Number(r.n)])).toEqual([
      ['ada@e2e.test', 13],
      ['bob@e2e.test', 10],
    ]);
  });

  it("links Ada's EMPATHY_STATEMENT to her attempt, about Bob", async () => {
    const rows = await q<{ author: string; subject: string; linked: boolean }>(
      `SELECT ua.email AS author, us.email AS subject, m.source_attempt_id = a.id AS linked
       FROM old_concept_message m
       JOIN old_concept_empathy_attempt a ON a.id = m.source_attempt_id
       JOIN old_concept_participant pa ON pa.id = a.author_participant_id
       JOIN old_concept_participant ps ON ps.id = a.subject_participant_id
       JOIN old_concept_user ua ON ua.id = pa.user_id
       JOIN old_concept_user us ON us.id = ps.user_id
       WHERE m.kind = 'EMPATHY_STATEMENT'`,
    );
    expect(rows).toEqual([{ author: 'ada@e2e.test', subject: 'bob@e2e.test', linked: true }]);
  });

  it('decodes the gates to milestones: both participants signed the compact and feel heard', async () => {
    const rows = await q<{ who: string; milestone_key: string }>(
      `SELECT u.email AS who, pm.milestone_key FROM old_concept_participant_milestone pm
       JOIN old_concept_participant p ON p.id = pm.participant_id
       JOIN old_concept_user u ON u.id = p.user_id ORDER BY 1, 2`,
    );
    expect(rows.map(r => `${r.who}:${r.milestone_key}`)).toEqual([
      'ada@e2e.test:compact_signed',
      'ada@e2e.test:feel_heard',
      'bob@e2e.test:compact_signed',
      'bob@e2e.test:feel_heard',
    ]);
    expect(await q(`SELECT * FROM concept_check_unmapped_gate_key`)).toEqual([]);
  });

  it('maps the EMPATHY_DRAFT consent onto the attempt arc (exactly one arc column set)', async () => {
    const rows = await q<{ target_kind: string; arcs: number; to_attempt: boolean }>(
      `SELECT c.target_kind,
              num_nonnulls(c.need_id, c.empathy_attempt_id, c.proposal_id, c.share_offer_id, c.review_id) AS arcs,
              c.empathy_attempt_id IN (SELECT id FROM old_concept_empathy_attempt) AS to_attempt
       FROM old_concept_consent c`,
    );
    expect(rows).toEqual([{ target_kind: 'EMPATHY_ATTEMPT', arcs: 1, to_attempt: true }]);
  });

  it('fails a snapshot when a gate key has no mapping (the step-7 precheck)', async () => {
    const before = await takeConceptSnapshot(fx.target, fx.database);
    expect(before.tables.old_concept_participant).toHaveLength(2);
    await q(`UPDATE "StageProgress" SET "gatesSatisfied" = '{"someNewGate": true}'::jsonb
             WHERE stage = 2 AND "userId" = (SELECT id FROM "User" WHERE email = 'ada@e2e.test')`);
    await expect(takeConceptSnapshot(fx.target, fx.database)).rejects.toThrow(/concept_check_unmapped_gate_key/);
    await q(`UPDATE "StageProgress" SET "gatesSatisfied" = '{}'::jsonb WHERE "gatesSatisfied" ? 'someNewGate'`);
  });
});
