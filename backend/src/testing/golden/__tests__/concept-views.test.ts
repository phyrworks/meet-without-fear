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
import * as path from 'path';
import {
  CONCEPT_NAMES,
  CONCEPT_VIEWS,
  CURRENT_SHAPE_SQL,
  TARGET_SHAPE_SQL,
  applyConceptViews,
  takeConceptSnapshot,
  viewName,
  viewsDefinedIn,
} from '../concept-views';
import { withClient } from '../db';
import { restoreFixture, RestoredFixture } from '../fixtures';
import { isTargetShape } from '../shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

jest.setTimeout(120_000);

describe('concept views — declaration', () => {
  it('current-shape.sql creates exactly the declared concept views (plus concept_check_* views)', () => {
    const defined = viewsDefinedIn(fs.readFileSync(CURRENT_SHAPE_SQL, 'utf8'));
    expect(defined.filter(v => !v.startsWith('concept_check_'))).toEqual(CONCEPT_NAMES.map(viewName).sort());
  });

  it('target-shape.sql creates exactly the same concept views (TS-9)', () => {
    const defined = viewsDefinedIn(fs.readFileSync(TARGET_SHAPE_SQL, 'utf8'));
    expect(defined.filter(v => !v.startsWith('concept_check_'))).toEqual(CONCEPT_NAMES.map(viewName).sort());
    // Every check it keeps is one current-shape.sql has too.
    const currentChecks = viewsDefinedIn(fs.readFileSync(CURRENT_SHAPE_SQL, 'utf8')).filter(v =>
      v.startsWith('concept_check_'),
    );
    for (const v of defined.filter(x => x.startsWith('concept_check_'))) expect(currentChecks).toContain(v);
  });
});

/**
 * TS-9: the column-set contract between the two files, checked on the target.
 * The column set of each current-shape view is read from what the recorded
 * normalised baselines hold (every row of `initial` and every changed row is
 * a full view row); the target view must have exactly those columns.
 */
(isTargetShape() ? describe : describe.skip)('concept views — target-shape.sql column sets (target)', () => {
  let fx: RestoredFixture;

  beforeAll(async () => {
    fx = await restoreFixture({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `concept_cols_${process.pid}` });
    await applyConceptViews(fx.target, fx.database);
  });
  afterAll(async () => {
    if (fx) await fx.drop();
  });

  it('every view has the column set the current-shape baselines recorded', async () => {
    const recorded = new Map<string, Set<string>>();
    const dir = path.join(__dirname, '..', '__golden__');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.concept.json'))) {
      const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as {
        initial: Record<string, Record<string, Record<string, unknown>>>;
        steps: Array<{
          changes?: Array<{ view: string; before?: Record<string, unknown>; after?: Record<string, unknown> }>;
        }>;
      };
      const add = (concept: string, row: Record<string, unknown> | undefined) => {
        if (!row) return;
        const cols = Object.keys(row).sort().join(',');
        const seen = recorded.get(concept) ?? new Set<string>();
        seen.add(cols);
        recorded.set(concept, seen);
      };
      for (const [concept, rows] of Object.entries(g.initial)) for (const r of Object.values(rows)) add(concept, r);
      for (const st of g.steps) for (const c of st.changes ?? []) add(c.view, c.after ?? c.before);
    }
    const cols = await withClient(
      fx.target,
      async c =>
        (
          await c.query<{ table_name: string; cols: string }>(
            `SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS cols
             FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'old_concept_%'
             GROUP BY table_name`,
          )
        ).rows,
      fx.database,
    );
    const target = new Map(cols.map(r => [r.table_name.replace(/^old_concept_/, ''), r.cols]));
    expect([...target.keys()].sort()).toEqual(Object.keys(CONCEPT_VIEWS).sort());
    let compared = 0;
    for (const [concept, sets] of recorded) {
      expect({ concept, sets: [...sets] }).toEqual({ concept, sets: [target.get(concept)] });
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
  });
});

(isTargetShape() ? describe.skip : describe)('concept views — FEEL_HEARD_B', () => {
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

  it('TS-5 views: the invitation names Ada as inviter and Bob as acceptor; one read state per participant; no closure, no captures', async () => {
    const inv = await q<{ inviter: string; acceptor: string; status: string; confirmed: boolean }>(
      `SELECT ui.email AS inviter, ua.email AS acceptor, i.status, i.message_confirmed_at IS NOT NULL AS confirmed
       FROM old_concept_invitation i
       JOIN old_concept_participant p ON p.id = i.invited_by_participant_id
       JOIN old_concept_user ui ON ui.id = p.user_id
       JOIN old_concept_user ua ON ua.id = i.accepted_by_user_id`,
    );
    expect(inv).toEqual([{ inviter: 'ada@e2e.test', acceptor: 'bob@e2e.test', status: 'ACCEPTED', confirmed: true }]);
    expect(
      Number(await one(`SELECT count(*) FROM old_concept_conversation_read_state WHERE participant_id IS NOT NULL`)),
    ).toBe(2);
    expect(Number(await one(`SELECT count(*) FROM old_concept_session_closure`))).toBe(0);
    expect(Number(await one(`SELECT count(*) FROM old_concept_brain_activity`))).toBe(0);
  });

  it('has one participant per (session, user): two in FEEL_HEARD_B', async () => {
    expect(Number(await one(`SELECT count(*) FROM old_concept_participant`))).toBe(2);
    expect(
      Number(await one(`SELECT count(*) FROM (SELECT DISTINCT session_id, user_id FROM old_concept_participant) x`)),
    ).toBe(2);
  });

  it('resolves every participant to a user', async () => {
    expect(
      await q(
        `SELECT p.id FROM old_concept_participant p LEFT JOIN old_concept_user u ON u.id = p.user_id WHERE u.id IS NULL`,
      ),
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

  it('decodes the gates to milestones: both participants signed the compact and feel heard; Ada sent the invitation', async () => {
    const rows = await q<{ who: string; milestone_key: string }>(
      `SELECT u.email AS who, pm.milestone_key FROM old_concept_participant_milestone pm
       JOIN old_concept_participant p ON p.id = pm.participant_id
       JOIN old_concept_user u ON u.id = p.user_id ORDER BY 1, 2`,
    );
    expect(rows.map(r => `${r.who}:${r.milestone_key}`)).toEqual([
      'ada@e2e.test:compact_signed',
      'ada@e2e.test:feel_heard',
      // R13: the stage-0 `invitationSent` gate, decoded @ StageProgress.startedAt.
      'ada@e2e.test:invitation_sent',
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

  /** Run setup statements and a query in one transaction, then roll back. */
  const inTx = async <T extends Record<string, unknown>>(setup: string[], sql: string): Promise<T[]> =>
    withClient(
      fx.target,
      async c => {
        await c.query('BEGIN');
        try {
          for (const s of setup) await c.query(s);
          return (await c.query<T>(sql)).rows;
        } finally {
          await c.query('ROLLBACK');
        }
      },
      fx.database,
    );
  const ADA = `(SELECT id FROM "User" WHERE email = 'ada@e2e.test')`;
  const BOB = `(SELECT id FROM "User" WHERE email = 'bob@e2e.test')`;
  const SESSION = `(SELECT id FROM "Session" LIMIT 1)`;
  const milestonesOf = `SELECT u.email || ':' || pm.milestone_key || '@' || pm.reached_at::text AS m
    FROM old_concept_participant_milestone pm
    JOIN old_concept_participant p ON p.id = pm.participant_id
    JOIN old_concept_user u ON u.id = p.user_id
    WHERE pm.milestone_key NOT IN ('compact_signed', 'feel_heard', 'invitation_sent') ORDER BY 1`;

  // Every step-7 branch FEEL_HEARD_B does not reach, pinned on a rolled-back
  // copy: the fixture-only spellings, COMPLETED stages 2-4, `phase`, `paused`.
  it('decodes the gate branches FEEL_HEARD_B does not reach (fixture-only keys, COMPLETED 2-4, phase, paused)', async () => {
    const rows = await inTx<{ m: string }>(
      [
        `UPDATE "StageProgress" SET status = 'COMPLETED', "completedAt" = '2030-01-01 00:00:02',
           "gatesSatisfied" = '{"empathyExchanged": true, "empathyExchangedAt": "2030-01-01T00:00:01.000Z"}'
         WHERE stage = 2 AND "userId" = ${ADA}`,
        `INSERT INTO "StageProgress" (id, "sessionId", "userId", stage, status, "startedAt", "completedAt", "gatesSatisfied", "isSynthesisDirty")
         VALUES (gen_random_uuid(), ${SESSION}, ${ADA}, 3, 'COMPLETED', '2030-01-01 00:00:02', '2030-01-01 00:00:04',
                 '{"needsIdentified": true, "needsIdentifiedAt": "2030-01-01T00:00:03.000Z"}', false),
                (gen_random_uuid(), ${SESSION}, ${ADA}, 4, 'COMPLETED', '2030-01-01 00:00:04', '2030-01-01 00:00:06',
                 '{"phase": "NEEDS_WALKTHROUGH"}', false)`,
        `UPDATE "Session" SET status = 'PAUSED', "updatedAt" = '2030-01-01 00:00:07'`,
      ],
      milestonesOf,
    );
    expect(rows.map(r => r.m)).toEqual([
      'ada@e2e.test:choices_shared@2030-01-01 00:00:06', // COMPLETED stage 4 (step 7)
      'ada@e2e.test:empathy_validated@2030-01-01 00:00:01', // empathyExchanged + its instant (earlier than completedAt)
      'ada@e2e.test:needs_confirmed@2030-01-01 00:00:03', // needsIdentified + its instant
      'ada@e2e.test:needs_shared@2030-01-01 00:00:04', // COMPLETED stage 3
      'ada@e2e.test:paused@2030-01-01 00:00:07', // Session PAUSED, every participant
      'ada@e2e.test:repair_walkthrough_started@2030-01-01 00:00:04', // phase <> INVENTORY @ startedAt
      'bob@e2e.test:paused@2030-01-01 00:00:07',
    ]);
  });

  it('fails an ACCEPTED invitation with no acceptor or no accepted instant (target CHECK, fix round 1)', async () => {
    expect(await q(`SELECT * FROM concept_check_invitation_accepted_without_acceptor`)).toEqual([]);
    expect(await q(`SELECT * FROM concept_check_read_state_without_participant`)).toEqual([]);
    const rows = await inTx<{ no_acceptor: boolean; no_accepted_at: boolean }>(
      [`UPDATE "Invitation" SET "acceptedAt" = NULL`],
      `SELECT no_acceptor, no_accepted_at FROM concept_check_invitation_accepted_without_acceptor`,
    );
    expect(rows).toEqual([{ no_acceptor: false, no_accepted_at: true }]);
  });

  it("does not start the walkthrough on phase 'INVENTORY'", async () => {
    const rows = await inTx<{ m: string }>(
      [`UPDATE "StageProgress" SET "gatesSatisfied" = '{"phase": "INVENTORY"}' WHERE stage = 2 AND "userId" = ${ADA}`],
      milestonesOf,
    );
    expect(rows).toEqual([]);
  });

  it('resolves VALIDATION_FEEDBACK to the attempt its recipient authored, and a feedback draft to the attempt its drafter is subject of', async () => {
    const rows = await inTx<{ kind: string; author: string }>(
      [
        `INSERT INTO "Message" (id, "sessionId", "senderId", "forUserId", role, content, stage, timestamp)
         VALUES (gen_random_uuid(), ${SESSION}, ${BOB}, ${ADA}::text, 'VALIDATION_FEEDBACK', 'feedback', 2, '2030-01-01 00:00:01')`,
        `INSERT INTO "ValidationFeedbackDraft" (id, "sessionId", "userId", content, "readyToShare", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), ${SESSION}, ${BOB}, 'draft feedback', false, '2030-01-01 00:00:01', '2030-01-01 00:00:01')`,
      ],
      `SELECT x.kind, u.email AS author FROM (
         SELECT 'message' AS kind, source_attempt_id AS attempt FROM old_concept_message WHERE kind = 'VALIDATION_FEEDBACK'
         UNION ALL SELECT 'draft', attempt_id FROM old_concept_draft WHERE kind = 'VALIDATION_FEEDBACK') x
       JOIN old_concept_empathy_attempt a ON a.id = x.attempt
       JOIN old_concept_participant p ON p.id = a.author_participant_id
       JOIN old_concept_user u ON u.id = p.user_id ORDER BY 1`,
    );
    expect(rows).toEqual([
      { kind: 'draft', author: 'ada@e2e.test' },
      { kind: 'message', author: 'ada@e2e.test' },
    ]);
  });

  it('fails a snapshot on a consent whose target does not resolve (plan §3 precheck)', async () => {
    await q(`INSERT INTO "ConsentRecord" (id, "userId", "sessionId", "targetType", "targetId", "requestedByUserId", "createdAt")
             VALUES ('00000000-0000-4000-8000-0000000000c1', ${ADA}, ${SESSION}, 'IDENTIFIED_NEED', gen_random_uuid()::text, ${ADA}, now())`);
    try {
      await expect(takeConceptSnapshot(fx.target, fx.database)).rejects.toThrow(/concept_check_consent_unresolved_arc/);
    } finally {
      await q(`DELETE FROM "ConsentRecord" WHERE id = '00000000-0000-4000-8000-0000000000c1'`);
    }
  });

  it('fails a snapshot on an attempt the view cannot direct', async () => {
    // No author: the subject lookup then sees both participants and the scalar
    // subquery raises (step 11's "RAISE if N≠2"); with N=1 the check view
    // catches the NULL subject instead. Either way the snapshot fails closed.
    await q(`INSERT INTO "EmpathyAttempt" (id, "sessionId", "sourceUserId", content, "sharedAt", "revisionCount", status, "deliveryStatus", "statusVersion")
             VALUES ('00000000-0000-4000-8000-0000000000a1', ${SESSION}, NULL, 'orphan', now(), 0, 'HELD', 'PENDING', 0)`);
    try {
      await expect(takeConceptSnapshot(fx.target, fx.database)).rejects.toThrow(
        /more than one row returned by a subquery|concept_check_attempt_without_direction/,
      );
    } finally {
      await q(`DELETE FROM "EmpathyAttempt" WHERE id = '00000000-0000-4000-8000-0000000000a1'`);
    }
    expect(await q(`SELECT * FROM concept_check_attempt_without_direction`)).toEqual([]);
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
