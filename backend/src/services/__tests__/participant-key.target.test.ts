/**
 * work-k5fk.3 (design note §3, §7 row 6a): every child of `participant` carries
 * `session_id` and the user id of each participant it names, and the database
 * pins them with composite foreign keys, so "same session" is a key, not a
 * trigger. On a clone of the TOMBSTONE_READY target fixture (the fixture with
 * the most tables populated), as the superuser for the catalog and the
 * mutations and as the real roles for the writers' refusals.
 *
 *   - the catalog: every table with a foreign key to participant pins it with
 *     a key that includes session_id (6a: next to each participant id FK, the
 *     seat pin (x_participant_id, session_id, x_user_id) → participant (id,
 *     session_id, user_id)); the three triggers the keys replace are gone;
 *   - a generated loop over every composite foreign key that carries
 *     session_id: moving one real row of the referencing table to another
 *     session, or naming a user who is not a participant of the row's session,
 *     is refused with foreign_key_violation (23503) — one case per key, every
 *     child table covered (the loop fails if a key has no row to try);
 *   - the retired triggers' cases are still refused, by key: a cross-session
 *     empathy attempt (t_attempt_same_session), a review by a non-subject
 *     (t_review_subject), a share of someone else's need (t_need_share_owner),
 *     a reconciler result about another subject (the subject half of
 *     t_result_live_attempt), while a result on a SUPERSEDED round is still the
 *     trigger's 23514;
 *   - the delete actions are as they were: deleting a session cascades every
 *     child row; deleting a participant cascades its rows; a shared need, a
 *     user with a participant and an agreed proposal are RESTRICT; deleting an
 *     attempt a message cites nulls message.source_attempt_id and keeps the line.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build TOMBSTONE_READY
 */

import { Client } from 'pg';
import { isTargetShape } from '../../testing/golden/shape';
import { adaAndBob, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

/** The SQLSTATE and constraint of a failing statement. */
async function failure(p: Promise<unknown>): Promise<{ code?: string; constraint?: string; message?: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string };
    return { code: err.code, constraint: err.constraint, message: err.message };
  }
  throw new Error('expected the statement to fail');
}

interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

/** The tables that name a participant and must pin it to their session (6a: all but ai_memory, which 6b reshapes). */
const CHILD_TABLES = [
  'agreement_party',
  'brain_activity',
  'consent',
  'context_share_offer',
  'conversation',
  'conversation_read_state',
  'draft',
  'empathy_attempt',
  'empathy_review',
  'follow_up',
  'follow_up_checkin',
  'follow_up_note',
  'invitation',
  'message',
  'mood_reading',
  'need',
  'need_disposition',
  'need_share',
  'participant_key',
  'participant_milestone',
  'proposal',
  'proposal_choice',
  'proposal_revision',
  'reconciler_guidance',
  'reconciler_result',
  'regulation_event',
  'session_closure',
];

describeTarget('participant composite keys (work-k5fk.3, 6a)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  /** A second session with one participant, Cy, who is in no session of Ada and Bob. */
  let other: { session: string; cy: string; cyUser: string };
  let fks: ForeignKey[];
  const pid = process.pid;

  /** One client for a transaction the test rolls back (ALTER TABLE … DISABLE TRIGGER USER is transactional). */
  async function inRolledBackTx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: run.fx.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  beforeAll(async () => {
    run = await openTargetRun('TOMBSTONE_READY', `k5fk3_key_${pid}`);
    ids = await adaAndBob(run);
    const cyUser = randomUuidV7();
    await run.sql(`INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, 'Cy')`, [cyUser, `cy-${pid}@e2e.test`]);
    const [s] = await run.sql<{ id: string }>(`INSERT INTO session (status) VALUES ('CREATED') RETURNING id`);
    const [p] = await run.sql<{ id: string }>(
      `INSERT INTO participant (session_id, user_id, kind, display_name) VALUES ($1, $2, 'human', 'Cy') RETURNING id`,
      [s.id, cyUser],
    );
    other = { session: s.id, cy: p.id, cyUser };
    fks = await run.sql<ForeignKey & Record<string, unknown>>(`
      SELECT c.conname AS name, c.conrelid::regclass::text AS table, c.confrelid::regclass::text AS "refTable",
             (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
             (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, n)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS "refColumns"
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
      ORDER BY 2, 1`);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  describe('the catalog', () => {
    it('every participant reference of a child table is pinned by a key that carries session_id', async () => {
      const toParticipant = fks.filter(f => f.refTable === 'participant' && f.table !== 'participant');
      const pinned = toParticipant.filter(f => f.columns.includes('session_id'));
      const legacy = toParticipant.filter(f => !f.columns.includes('session_id'));
      // 6a keeps the participant id FKs; each one has a pin over the same column.
      const unpinned = legacy.filter(
        f => !pinned.some(p => p.table === f.table && p.columns[0] === f.columns[0] && p.columns.length === 3),
      );
      expect(unpinned.map(f => `${f.table}.${f.columns.join(',')}`)).toEqual(
        // ai_memory.participant_id is reshaped in 6b (session_id nullable, user_id NOT NULL)
        ['ai_memory.participant_id'],
      );
      const pinnedTables = [...new Set(pinned.map(f => f.table))].filter(t => t !== 'live_session_pair').sort();
      expect(pinnedTables).toEqual(CHILD_TABLES);
      for (const p of pinned) {
        expect({ fk: p.name, ref: p.refColumns }).toEqual({
          fk: p.name,
          ref: p.columns.length === 3 ? ['id', 'session_id', 'user_id'] : ['session_id', 'user_id'],
        });
      }
    });

    it('a child of a child pins it on (id, session_id): the two paths name one session', async () => {
      const keyed = (table: string, ref: string) =>
        fks.some(f => f.table === table && f.refTable === ref && f.columns.includes('session_id'));
      const expected: Array<[string, string]> = [
        ['message', 'conversation'],
        ['message', 'empathy_attempt'],
        ['empathy_review', 'empathy_attempt'],
        ['reconciler_result', 'empathy_attempt'],
        ['reconciler_guidance', 'reconciler_result'],
        ['context_share_offer', 'empathy_attempt'],
        ['context_share_offer', 'reconciler_result'],
        ['need_share', 'need'],
        ['consent', 'need'],
        ['consent', 'empathy_attempt'],
        ['consent', 'proposal'],
        ['consent', 'context_share_offer'],
        ['consent', 'empathy_review'],
        ['draft', 'empathy_attempt'],
        ['draft', 'context_share_offer'],
        ['draft', 'invitation'],
        ['proposal_choice', 'proposal'],
        ['proposal_need', 'proposal'],
        ['proposal_need', 'need_share'],
        ['proposal_revision', 'proposal'],
        ['need_disposition', 'need_share'],
        ['agreement', 'proposal'],
        ['agreement_party', 'agreement'],
        ['follow_up_checkin', 'follow_up'],
      ];
      expect(expected.filter(([t, r]) => !keyed(t, r))).toEqual([]);
    });

    it('the three same-session triggers are retired; t_result_live_attempt keeps its live-round half', async () => {
      const rows = await run.sql<{ name: string }>(`
        SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal
          AND tgname IN ('t_same_session', 't_review_subject', 't_need_share_owner', 't_result_live_attempt')
        UNION ALL
        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname IN ('t_attempt_same_session', 't_review_subject', 't_need_share_owner')
        ORDER BY 1`);
      expect(rows.map(r => r.name)).toEqual(['t_result_live_attempt']);
    });
  });

  describe('a generated loop over every composite key that carries session_id', () => {
    beforeAll(async () => {
      // A row for every key to try (TOMBSTONE_READY has most; the rest are written here, valid, as the superuser).
      const a = { pid: ids.ada, user: ids.adaUser };
      const b = { pid: ids.bob, user: ids.bobUser };
      const s = ids.session;
      const one = async (q: string, p: unknown[] = []) => (await run.sql<{ id: string }>(q, p))[0]?.id;
      const attB = await one(
        `SELECT id FROM empathy_attempt WHERE author_participant_id = $1 AND status <> 'SUPERSEDED' ORDER BY round DESC LIMIT 1`,
        [b.pid],
      );
      const proposalA = await one(`SELECT id FROM proposal WHERE created_by_participant_id = $1 LIMIT 1`, [a.pid]);
      const shared = await one(
        `SELECT ns.need_id AS id FROM need_share ns WHERE ns.session_id = $1
         AND NOT EXISTS (SELECT 1 FROM proposal_need pn WHERE pn.need_id = ns.need_id AND pn.proposal_id = $2) LIMIT 1`,
        [s, proposalA],
      );
      const invitation = await one(`SELECT id FROM invitation WHERE session_id = $1`, [s]);
      const result = await run.sql<{
        id: string;
        author: string;
        author_user: string;
        subject: string;
        subject_user: string;
      }>(
        `SELECT r.id, a.author_participant_id AS author, a.author_user_id AS author_user,
                r.subject_participant_id AS subject, r.subject_user_id AS subject_user
         FROM reconciler_result r JOIN empathy_attempt a ON a.id = r.attempt_id WHERE r.session_id = $1 LIMIT 1`,
        [s],
      );
      const offer = await run.sql<{ id: string; subject: string; subject_user: string }>(
        `SELECT id, subject_participant_id AS subject, subject_user_id AS subject_user FROM context_share_offer WHERE session_id = $1 LIMIT 1`,
        [s],
      );
      const seat = [a.pid, s, a.user];
      await run.sql(
        `INSERT INTO mood_reading (participant_id, session_id, user_id, intensity) VALUES ($1, $2, $3, 5)`,
        seat,
      );
      await run.sql(
        `INSERT INTO regulation_event (participant_id, session_id, user_id, type) VALUES ($1, $2, $3, 'GROUNDING')`,
        seat,
      );
      await run.sql(
        `INSERT INTO participant_key (participant_id, session_id, user_id, key_id, wrapped_dek) VALUES ($1, $2, $3, 'k', '\\x00')`,
        seat,
      );
      await run.sql(
        `INSERT INTO follow_up_note (participant_id, session_id, user_id, content) VALUES ($1, $2, $3, 'a note')`,
        seat,
      );
      const followUp = await one(
        `INSERT INTO follow_up (session_id, type, scope, owner_participant_id, owner_user_id, status)
         VALUES ($2, 'USER_INITIATED_REENTRY', 'INDIVIDUAL', $1, $3, 'OPEN') RETURNING id`,
        seat,
      );
      await run.sql(
        `INSERT INTO follow_up_checkin (follow_up_id, participant_id, session_id, user_id) VALUES ($4, $1, $2, $3)`,
        [...seat, followUp],
      );
      await run.sql(`INSERT INTO proposal_need (proposal_id, need_id, session_id) VALUES ($1, $2, $3)`, [
        proposalA,
        shared,
        s,
      ]);
      await run.sql(
        `INSERT INTO need_disposition (participant_id, session_id, user_id, need_id) VALUES ($1, $2, $3, $4)`,
        [...seat, shared],
      );
      await run.sql(
        `INSERT INTO proposal_revision (proposal_id, actor_participant_id, session_id, actor_user_id, action)
         VALUES ($4, $1, $2, $3, 'REVISED')`,
        [...seat, proposalA],
      );
      await run.sql(
        `INSERT INTO proposal (session_id, created_by_participant_id, created_by_user_id, description, status, removed_at,
                               removed_by_participant_id, removed_by_user_id)
         VALUES ($2, $1, $3, 'removed', 'REMOVED', now(), $4, $5)`,
        [...seat, b.pid, b.user],
      );
      const review = await one(
        `INSERT INTO empathy_review (attempt_id, reviewer_participant_id, session_id, reviewer_user_id, validated)
         VALUES ($4, $1, $2, $3, true)
         ON CONFLICT (attempt_id, reviewer_participant_id) DO UPDATE SET validated = EXCLUDED.validated RETURNING id`,
        [...seat, attB],
      );
      await run.sql(
        `INSERT INTO consent (participant_id, session_id, user_id, review_id, decision, decided_at) VALUES ($1, $2, $3, $4, 'GRANTED', now())`,
        [...seat, review],
      );
      await run.sql(
        `INSERT INTO consent (participant_id, requested_by_participant_id, session_id, user_id, requested_by_user_id, proposal_id)
         VALUES ($1, $1, $2, $3, $3, $4)`,
        [...seat, proposalA],
      );
      await run.sql(
        `INSERT INTO consent (participant_id, session_id, user_id, share_offer_id) VALUES ($1, $2, $3, $4)`,
        [offer[0].subject, s, offer[0].subject_user, offer[0].id],
      );
      await run.sql(
        `INSERT INTO draft (participant_id, session_id, user_id, kind, attempt_id, content) VALUES ($1, $2, $3, 'VALIDATION_FEEDBACK', $4, 'f')`,
        [...seat, attB],
      );
      await run.sql(
        `INSERT INTO draft (participant_id, session_id, user_id, kind, share_offer_id, content) VALUES ($1, $2, $3, 'SHARE_CONTEXT', $4, 's')`,
        [offer[0].subject, s, offer[0].subject_user, offer[0].id],
      );
      await run.sql(
        `INSERT INTO draft (participant_id, session_id, user_id, kind, invitation_id, content) VALUES ($1, $2, $3, 'EMPATHY', $4, 'i')`,
        [...seat, invitation],
      );
      await run.sql(
        `INSERT INTO reconciler_guidance (result_id, author_participant_id, subject_participant_id, session_id, author_user_id, subject_user_id)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [result[0].id, result[0].author, result[0].subject, s, result[0].author_user, result[0].subject_user],
      );
      await run.sql(
        `INSERT INTO session_closure (session_id, kind, reason, summary, closed_by_participant_id, closed_by_user_id)
         VALUES ($2, 'NO_SHARED_AGREEMENT', 'USER_STOPPED', 'closed', $1, $3)`,
        seat,
      );
      await run.sql(
        `INSERT INTO brain_activity (session_id, participant_id, participant_user_id, activity_type, model)
         VALUES ($2, $1, $3, 'LLM_CALL', 'test-model')`,
        seat,
      );
    });

    /** The composite keys that carry session_id, apart from those to session itself and the participant self-reference. */
    const sessionKeys = () =>
      fks.filter(f => f.columns.includes('session_id') && f.columns.length > 1 && f.table !== 'participant');

    it('covers every child table, each key with a real row to move', async () => {
      const keys = sessionKeys();
      expect(keys.length).toBeGreaterThanOrEqual(50);
      const tables = new Set(keys.map(k => k.table));
      for (const t of CHILD_TABLES) expect(tables.has(t)).toBe(true);
      const empty: string[] = [];
      for (const k of keys) {
        const notNull = k.columns.map(c => `${c} IS NOT NULL`).join(' AND ');
        const [{ n }] = await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${k.table} WHERE ${notNull}`);
        if (n === 0) empty.push(k.name);
      }
      expect(empty).toEqual([]);
    });

    it('moving a row to another session is refused by every key (23503)', async () => {
      const outcomes: Record<string, string | undefined> = {};
      for (const k of sessionKeys()) {
        const notNull = k.columns.map(c => `${c} IS NOT NULL`).join(' AND ');
        outcomes[k.name] = await inRolledBackTx(async c => {
          await c.query(`ALTER TABLE ${k.table} DISABLE TRIGGER USER`);
          const f = await failure(
            c.query(
              `UPDATE ${k.table} SET session_id = $1 WHERE ctid = (SELECT ctid FROM ${k.table} WHERE ${notNull} LIMIT 1)`,
              [other.session],
            ),
          );
          return f.code;
        });
      }
      expect(Object.entries(outcomes).filter(([, code]) => code !== '23503')).toEqual([]);
    });

    it('naming a user who is not a participant of the row’s session is refused by every user column of a key (23503)', async () => {
      const outcomes: Record<string, string | undefined> = {};
      for (const k of sessionKeys()) {
        for (const col of k.columns.filter(c => c.endsWith('user_id'))) {
          const notNull = k.columns.map(c => `${c} IS NOT NULL`).join(' AND ');
          outcomes[`${k.name}.${col}`] = await inRolledBackTx(async c => {
            await c.query(`ALTER TABLE ${k.table} DISABLE TRIGGER USER`);
            const f = await failure(
              c.query(
                `UPDATE ${k.table} SET ${col} = $1 WHERE ctid = (SELECT ctid FROM ${k.table} WHERE ${notNull} LIMIT 1)`,
                [other.cyUser],
              ),
            );
            return f.code;
          });
        }
      }
      expect(Object.keys(outcomes).length).toBeGreaterThanOrEqual(30);
      expect(Object.entries(outcomes).filter(([, code]) => code !== '23503')).toEqual([]);
    });
  });

  describe("the retired triggers' cases, refused by key", () => {
    it('an empathy attempt between participants of two sessions (t_attempt_same_session)', async () => {
      for (const subject of [
        // the subject's real seat in the other session
        { pid: other.cy, user: other.cyUser, session: ids.session },
        { pid: other.cy, user: other.cyUser, session: other.session },
        // a participant id of the other session under a user of this one
        { pid: other.cy, user: ids.bobUser, session: ids.session },
      ]) {
        const f = await failure(
          run.sql(
            `INSERT INTO empathy_attempt (author_participant_id, subject_participant_id, session_id, author_user_id, subject_user_id,
                                          round, content)
             VALUES ($1, $2, $3, $4, $5, 9, 'x')`,
            [ids.ada, subject.pid, subject.session, ids.adaUser, subject.user],
          ),
        );
        expect(f.code).toBe('23503');
      }
    });

    it('a review by anyone but the attempt’s subject, as mwf_app (t_review_subject)', async () => {
      const [att] = await run.sql<{ id: string }>(
        `SELECT id FROM empathy_attempt WHERE author_participant_id = $1 AND status <> 'SUPERSEDED' LIMIT 1`,
        [ids.ada],
      );
      const f = await failure(
        run.as(
          'mwf_app',
          ids.adaUser,
          `INSERT INTO empathy_review (attempt_id, reviewer_participant_id, session_id, reviewer_user_id, validated)
           VALUES ($1, $2, $3, $4, true)`,
          [att.id, ids.ada, ids.session, ids.adaUser],
        ),
      );
      expect(f.code).toBe('23503');
    });

    it('a share of someone else’s need, or into another session, as mwf_job (t_need_share_owner)', async () => {
      const [need] = await run.sql<{ id: string }>(
        `INSERT INTO need (participant_id, session_id, user_id, label, category, ai_confidence)
         VALUES ($1, $2, $3, 'rest', 'CONNECTION', 0.5) RETURNING id`,
        [ids.ada, ids.session, ids.adaUser],
      );
      for (const [p, s, u] of [
        [ids.bob, ids.session, ids.bobUser],
        [other.cy, other.session, other.cyUser],
        [ids.ada, other.session, ids.adaUser],
      ]) {
        const f = await failure(
          run.as(
            'mwf_job',
            null,
            `INSERT INTO need_share (need_id, participant_id, session_id, user_id, category, shared_text) VALUES ($1, $2, $3, $4, 'CONNECTION', 'x')`,
            [need.id, p, s, u],
          ),
        );
        expect(f.code).toBe('23503');
      }
    });

    it('a reconciler result about another subject is a key violation; a SUPERSEDED round is still the trigger’s', async () => {
      const [att] = await run.sql<{ id: string; status: string }>(
        `SELECT id, status::text FROM empathy_attempt WHERE author_participant_id = $1 ORDER BY round DESC LIMIT 1`,
        [ids.ada],
      );
      const insertResult = (subject: string, subjectUser: string) =>
        run.as(
          'mwf_job',
          null,
          `INSERT INTO reconciler_result (attempt_id, subject_participant_id, session_id, subject_user_id, iteration, alignment_score,
                                          alignment_summary, gap_summary, gap_severity, recommended_action, rationale, sharing_would_help)
           VALUES ($1, $2, $3, $4, 99, 50, 's', 'g', 'MINOR', 'PROCEED', 'r', false)`,
          [att.id, subject, ids.session, subjectUser],
        );
      // The author as the subject: the attempt's subject is Bob.
      expect((await failure(insertResult(ids.ada, ids.adaUser))).code).toBe('23503');
      await run.sql(`UPDATE empathy_attempt SET status = 'SUPERSEDED' WHERE id = $1`, [att.id]);
      const f = await failure(insertResult(ids.bob, ids.bobUser));
      expect({ code: f.code, live: /live attempt/.test(f.message ?? '') }).toEqual({ code: '23514', live: true });
      await run.sql(`UPDATE empathy_attempt SET status = $2::empathy_status WHERE id = $1`, [att.id, att.status]);
    });
  });

  describe('delete actions', () => {
    it('RESTRICT: a shared need, a user with a participant, an agreed proposal', async () => {
      const [ns] = await run.sql<{ need_id: string }>(`SELECT need_id FROM need_share WHERE session_id = $1 LIMIT 1`, [
        ids.session,
      ]);
      // ON DELETE RESTRICT raises restrict_violation (23001)
      expect((await failure(run.sql(`DELETE FROM need WHERE id = $1`, [ns.need_id]))).code).toBe('23001');
      expect((await failure(run.sql(`DELETE FROM "user" WHERE id = $1`, [ids.adaUser]))).code).toBe('23001');
      const [ag] = await run.sql<{ proposal_id: string }>(`SELECT proposal_id FROM agreement WHERE session_id = $1`, [
        ids.session,
      ]);
      expect((await failure(run.sql(`DELETE FROM proposal WHERE id = $1`, [ag.proposal_id]))).code).toBe('23001');
    });

    it('deleting an attempt a message cites nulls message.source_attempt_id and keeps the line', async () => {
      const [m] = await run.sql<{ id: string; source_attempt_id: string }>(
        `SELECT id, source_attempt_id FROM message WHERE source_attempt_id IS NOT NULL AND session_id = $1 LIMIT 1`,
        [ids.session],
      );
      await inRolledBackTx(async c => {
        // the attempt's other dependants (agreement-free here) cascade; no trigger stands in the way of the FK actions
        await c.query(`DELETE FROM empathy_attempt WHERE id = $1`, [m.source_attempt_id]);
        const r = await c.query(`SELECT source_attempt_id FROM message WHERE id = $1`, [m.id]);
        expect(r.rows).toEqual([{ source_attempt_id: null }]);
      });
    });

    it('deleting a participant cascades its rows in every child table', async () => {
      await inRolledBackTx(async c => {
        // The agreement's parties and the deferred party/cardinality checks are not what this pins.
        await c.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        await c.query(`UPDATE session SET status = 'RESOLVED', resolved_at = now() WHERE id = $1`, [ids.session]);
        await c.query(`DELETE FROM agreement WHERE session_id = $1`, [ids.session]);
        await c.query(`ALTER TABLE agreement_party DISABLE TRIGGER USER`);
        await c.query(`DELETE FROM participant WHERE id = $1`, [ids.bob]);
        const left: string[] = [];
        for (const k of fks.filter(
          f => f.refTable === 'participant' && f.columns.includes('session_id') && f.table !== 'participant',
        )) {
          const userCol = k.columns[k.columns.length - 1];
          const r = await c.query(
            `SELECT count(*)::int AS n FROM ${k.table} WHERE session_id = $1 AND ${userCol} = $2`,
            [ids.session, ids.bobUser],
          );
          if (r.rows[0].n > 0) left.push(`${k.table}.${userCol}`);
        }
        expect(left).toEqual([]);
      });
    });

    it('deleting a session cascades every row that carries its session_id', async () => {
      await inRolledBackTx(async c => {
        await c.query(`DELETE FROM session WHERE id = $1`, [ids.session]);
        const tables = await c.query<{ t: string }>(
          `SELECT c.relname AS t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'session_id' AND NOT a.attisdropped ORDER BY 1`,
        );
        const left: string[] = [];
        for (const { t } of tables.rows) {
          const r = await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE session_id = $1`, [ids.session]);
          if (r.rows[0].n > 0) left.push(t);
        }
        expect(left).toEqual([]);
        expect(tables.rows.length).toBeGreaterThanOrEqual(CHILD_TABLES.length);
      });
    });
  });
});
