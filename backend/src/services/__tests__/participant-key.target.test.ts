/**
 * work-k5fk.3 (design note §3, §7 rows 6a and 6b): a participant is keyed
 * (session_id, user_id), and every child of it names it by that pair —
 * FOREIGN KEY (session_id, x_user_id) REFERENCES participant (session_id,
 * user_id) — so "same session" is a key, not a trigger. On a clone of the
 * TOMBSTONE_READY target fixture (the fixture with the most tables populated),
 * as the superuser for the catalog and the mutations and as the real roles for
 * the writers' refusals.
 *
 *   - the catalog: participant's primary key is (session_id, user_id) and it
 *     has no id; no table has a *participant_id column; every key to
 *     participant is (session_id, x_user_id); a child of a child is pinned on
 *     (id, session_id); participant.kind is the user's kind, pinned by
 *     FOREIGN KEY (user_id, kind) REFERENCES "user" (id, kind); the four
 *     triggers the keys replace and the participant_kind enum are gone;
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
 *     trigger's 23514; a seat whose kind is not its user's (t_participant_kind):
 *     the AI and a persona sit as themselves, never as human, and a human never
 *     as either;
 *   - the delete actions are as they were: deleting a session cascades every
 *     child row; deleting a participant cascades its rows; a shared need, a
 *     user with a participant and an agreed proposal are RESTRICT; deleting an
 *     attempt a message cites nulls message.source_attempt_id and keeps the line.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build TOMBSTONE_READY
 */

import { Client } from 'pg';
import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

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

/** The tables that name a participant, each by (session_id, a user column). */
const CHILD_TABLES = [
  'agreement_party',
  'ai_memory',
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

describeTarget('participant composite keys (work-k5fk.3, 6a/6b)', () => {
  let run: TargetRun;
  let ids: { session: string; adaUser: string; bobUser: string };
  /** A second session with one participant, Cy, who is in no session of Ada and Bob. */
  let other: { session: string; cyUser: string };
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
    [ids] = await run.sql<{ session: string; adaUser: string; bobUser: string }>(
      `SELECT pa.session_id AS session, pa.user_id AS "adaUser", pb.user_id AS "bobUser"
       FROM participant pa JOIN "user" ua ON ua.id = pa.user_id AND ua.email = 'ada@e2e.test'
       JOIN participant pb ON pb.session_id = pa.session_id AND pb.user_id <> pa.user_id`,
    );
    const cyUser = randomUuidV7();
    await run.sql(`INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, 'Cy')`, [cyUser, `cy-${pid}@e2e.test`]);
    const [s] = await run.sql<{ id: string }>(`INSERT INTO session (status) VALUES ('CREATED') RETURNING id`);
    await run.sql(`INSERT INTO participant (session_id, user_id, kind, display_name) VALUES ($1, $2, 'human', 'Cy')`, [
      s.id,
      cyUser,
    ]);
    other = { session: s.id, cyUser };
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
    it('participant is keyed (session_id, user_id); it has no id and no table has a participant id', async () => {
      const [pk] = await run.sql<{ cols: string[] }>(`
        SELECT array_agg(a.attname::text ORDER BY k.n) AS cols
        FROM pg_constraint c, unnest(c.conkey) WITH ORDINALITY k(attnum, n)
        JOIN pg_attribute a ON a.attrelid = 'participant'::regclass AND a.attnum = k.attnum
        WHERE c.conrelid = 'participant'::regclass AND c.contype = 'p'`);
      expect(pk.cols).toEqual(['session_id', 'user_id']);
      const cols = await run.sql<{ col: string }>(`
        SELECT c.relname || '.' || a.attname AS col FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v') AND a.attnum > 0 AND NOT a.attisdropped
          AND (a.attname LIKE '%participant_id' OR (c.relname = 'participant' AND a.attname = 'id'))
        ORDER BY 1`);
      expect(cols.map(c => c.col)).toEqual([]);
    });

    it('every participant reference of a child table is (session_id, x_user_id) → participant (session_id, user_id)', async () => {
      const toParticipant = fks.filter(f => f.refTable === 'participant' && f.table !== 'participant');
      expect(toParticipant.filter(f => f.columns.length !== 2 || f.columns[0] !== 'session_id')).toEqual([]);
      expect(toParticipant.filter(f => f.refColumns.join(',') !== 'session_id,user_id')).toEqual([]);
      const tables = [...new Set(toParticipant.map(f => f.table))].filter(t => t !== 'live_session_pair').sort();
      expect(tables).toEqual(CHILD_TABLES);
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
      // 6a review F2: these pin the parent's PERSON too, not only its session — a key weakened to (id, session_id)
      // would still pass `keyed` above and be masked by the participant key in the loops below.
      const pinsUser: Array<[string, string, string[], string[]]> = [
        ['empathy_review', 'empathy_attempt', ['attempt_id', 'session_id', 'reviewer_user_id'], ['id', 'session_id', 'subject_user_id']],
        ['reconciler_result', 'empathy_attempt', ['attempt_id', 'session_id', 'subject_user_id'], ['id', 'session_id', 'subject_user_id']],
        ['context_share_offer', 'empathy_attempt', ['attempt_id', 'session_id', 'subject_user_id'], ['id', 'session_id', 'subject_user_id']],
        ['reconciler_guidance', 'reconciler_result', ['result_id', 'session_id', 'subject_user_id'], ['id', 'session_id', 'subject_user_id']],
        ['need_share', 'need', ['need_id', 'session_id', 'user_id'], ['id', 'session_id', 'user_id']],
      ];
      const missing = pinsUser.filter(
        ([t, r, cols, refCols]) =>
          !fks.some(
            f => f.table === t && f.refTable === r && f.columns.join() === cols.join() && f.refColumns.join() === refCols.join(),
          ),
      );
      expect(missing.map(([t, r]) => `${t} → ${r}`)).toEqual([]);
    });

    it('participant.kind is the user’s kind, pinned by FOREIGN KEY (user_id, kind) REFERENCES "user" (id, kind)', async () => {
      expect(
        fks.filter(f => f.table === 'participant' && f.refTable === '"user"').map(f => [f.columns, f.refColumns]),
      ).toEqual([[['user_id', 'kind'], ['id', 'kind']]]);
      const [t] = await run.sql<{ t: string }>(
        `SELECT format_type(atttypid, NULL) AS t FROM pg_attribute WHERE attrelid = 'participant'::regclass AND attname = 'kind'`,
      );
      expect(t.t).toBe('user_kind');
      const [n] = await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'participant_kind'`);
      expect(n.n).toBe(0);
    });

    it('the four triggers the keys replace are retired; t_result_live_attempt keeps its live-round half', async () => {
      const rows = await run.sql<{ name: string }>(`
        SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal
          AND tgname IN ('t_same_session', 't_review_subject', 't_need_share_owner', 't_participant_kind', 't_result_live_attempt')
        UNION ALL
        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('t_attempt_same_session', 't_review_subject', 't_need_share_owner', 't_participant_kind',
                            'is_co_participant', 'my_participant')
        ORDER BY 1`);
      expect(rows.map(r => r.name)).toEqual(['t_result_live_attempt']);
    });
  });

  describe('a generated loop over every composite key that carries session_id', () => {
    beforeAll(async () => {
      // A row for every key to try (TOMBSTONE_READY has most; the rest are written here, valid, as the superuser).
      const s = ids.session;
      const a = ids.adaUser;
      const b = ids.bobUser;
      const one = async (q: string, p: unknown[] = []) => (await run.sql<{ id: string }>(q, p))[0]?.id;
      const attB = await one(
        `SELECT id FROM empathy_attempt WHERE session_id = $1 AND author_user_id = $2 AND status <> 'SUPERSEDED'
         ORDER BY round DESC LIMIT 1`,
        [s, b],
      );
      const proposalA = await one(`SELECT id FROM proposal WHERE session_id = $1 AND created_by_user_id = $2 LIMIT 1`, [s, a]);
      const shared = await one(
        `SELECT ns.need_id AS id FROM need_share ns WHERE ns.session_id = $1
         AND NOT EXISTS (SELECT 1 FROM proposal_need pn WHERE pn.need_id = ns.need_id AND pn.proposal_id = $2) LIMIT 1`,
        [s, proposalA],
      );
      const invitation = await one(`SELECT id FROM invitation WHERE session_id = $1`, [s]);
      const [result] = await run.sql<{ id: string; author_user: string; subject_user: string }>(
        `SELECT r.id, a.author_user_id AS author_user, r.subject_user_id AS subject_user
         FROM reconciler_result r JOIN empathy_attempt a ON a.id = r.attempt_id WHERE r.session_id = $1 LIMIT 1`,
        [s],
      );
      const [offer] = await run.sql<{ id: string; subject_user: string }>(
        `SELECT id, subject_user_id AS subject_user FROM context_share_offer WHERE session_id = $1 LIMIT 1`,
        [s],
      );
      const seat = [s, a];
      await run.sql(`INSERT INTO mood_reading (session_id, user_id, intensity) VALUES ($1, $2, 5)`, seat);
      await run.sql(`INSERT INTO regulation_event (session_id, user_id, type) VALUES ($1, $2, 'GROUNDING')`, seat);
      await run.sql(`INSERT INTO participant_key (session_id, user_id, key_id, wrapped_dek) VALUES ($1, $2, 'k', '\\x00')`, seat);
      await run.sql(`INSERT INTO follow_up_note (session_id, user_id, content) VALUES ($1, $2, 'a note')`, seat);
      await run.sql(
        `INSERT INTO ai_memory (session_id, user_id, kind, doc)
         VALUES ($1, $2, 'NOTABLE_FACTS', '{"facts": []}') ON CONFLICT DO NOTHING`,
        seat,
      );
      const followUp = await one(
        `INSERT INTO follow_up (session_id, type, scope, owner_user_id, status)
         VALUES ($1, 'USER_INITIATED_REENTRY', 'INDIVIDUAL', $2, 'OPEN') RETURNING id`,
        seat,
      );
      await run.sql(`INSERT INTO follow_up_checkin (follow_up_id, session_id, user_id) VALUES ($3, $1, $2)`, [...seat, followUp]);
      await run.sql(`INSERT INTO proposal_need (proposal_id, need_id, session_id) VALUES ($1, $2, $3)`, [proposalA, shared, s]);
      await run.sql(`INSERT INTO need_disposition (session_id, user_id, need_id) VALUES ($1, $2, $3)`, [...seat, shared]);
      await run.sql(
        `INSERT INTO proposal_revision (proposal_id, session_id, actor_user_id, action) VALUES ($3, $1, $2, 'REVISED')`,
        [...seat, proposalA],
      );
      await run.sql(
        `INSERT INTO proposal (session_id, created_by_user_id, description, status, removed_at, removed_by_user_id)
         VALUES ($1, $2, 'removed', 'REMOVED', now(), $3)`,
        [...seat, b],
      );
      const review = await one(
        `INSERT INTO empathy_review (attempt_id, session_id, reviewer_user_id, validated) VALUES ($3, $1, $2, true)
         ON CONFLICT (attempt_id, session_id, reviewer_user_id) DO UPDATE SET validated = EXCLUDED.validated RETURNING id`,
        [...seat, attB],
      );
      await run.sql(
        `INSERT INTO consent (session_id, user_id, review_id, decision, decided_at) VALUES ($1, $2, $3, 'GRANTED', now())`,
        [...seat, review],
      );
      await run.sql(
        `INSERT INTO consent (session_id, user_id, requested_by_user_id, proposal_id) VALUES ($1, $2, $2, $3)`,
        [...seat, proposalA],
      );
      await run.sql(`INSERT INTO consent (session_id, user_id, share_offer_id) VALUES ($1, $2, $3)`, [
        s,
        offer.subject_user,
        offer.id,
      ]);
      await run.sql(
        `INSERT INTO draft (session_id, user_id, kind, attempt_id, content) VALUES ($1, $2, 'VALIDATION_FEEDBACK', $3, 'f')`,
        [...seat, attB],
      );
      await run.sql(
        `INSERT INTO draft (session_id, user_id, kind, share_offer_id, content) VALUES ($1, $2, 'SHARE_CONTEXT', $3, 's')`,
        [s, offer.subject_user, offer.id],
      );
      await run.sql(
        `INSERT INTO draft (session_id, user_id, kind, invitation_id, content) VALUES ($1, $2, 'EMPATHY', $3, 'i')`,
        [...seat, invitation],
      );
      await run.sql(
        `INSERT INTO reconciler_guidance (result_id, session_id, author_user_id, subject_user_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [result.id, s, result.author_user, result.subject_user],
      );
      await run.sql(
        `INSERT INTO session_closure (session_id, kind, reason, summary, closed_by_user_id)
         VALUES ($1, 'NO_SHARED_AGREEMENT', 'USER_STOPPED', 'closed', $2)`,
        seat,
      );
      await run.sql(
        `INSERT INTO brain_activity (session_id, participant_user_id, activity_type, model) VALUES ($1, $2, 'LLM_CALL', 'test-model')`,
        seat,
      );
      // work-k5fk.4: a refinement turn naming a need, and a read state naming the seen message by its key.
      const [line] = await run.sql<{ conversation_id: string; seq: number }>(
        `INSERT INTO message (conversation_id, session_id, sender_user_id, role, content, refining_need_id)
         SELECT c.id, $1::uuid, $2::uuid, 'USER', 'a refinement turn', $3::uuid FROM conversation c
         WHERE c.session_id = $1::uuid AND c.user_id = $2::uuid AND c.kind = 'MAIN' RETURNING conversation_id, seq`,
        [...seat, shared],
      );
      await run.sql(
        `UPDATE conversation_read_state SET last_seen_conversation_id = $3, last_seen_seq = $4 WHERE session_id = $1 AND user_id = $2`,
        [...seat, line.conversation_id, line.seq],
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

    // 6a review F2: a participant key and a child-of-child key on the same user column both refuse a stranger, so
    // the loop above cannot tell which one held. Naming ANOTHER participant of the same session passes every key to
    // participant: only the child-of-child key can refuse it, and the refusal must name that key.
    it('naming another participant of the session where a child-of-child key pins the user is refused by that key, by name', async () => {
      const outcomes: Record<string, string | undefined> = {};
      const childKeys = fks.filter(
        f =>
          f.refTable !== 'participant' &&
          f.table !== 'participant' &&
          f.columns.includes('session_id') &&
          f.columns.some(c => c.endsWith('user_id')),
      );
      for (const k of childKeys) {
        const col = k.columns.find(c => c.endsWith('user_id'))!;
        const notNull = k.columns.map(c => `${c} IS NOT NULL`).join(' AND ');
        outcomes[k.name] = await inRolledBackTx(async c => {
          await c.query(`ALTER TABLE ${k.table} DISABLE TRIGGER USER`);
          const [row] = (
            await c.query<{ ctid: string }>(
              `SELECT ctid::text AS ctid FROM ${k.table} WHERE ${notNull} AND session_id = $1 LIMIT 1`,
              [ids.session],
            )
          ).rows;
          // Rows that reference THIS row through the same column (guidance → result's subject) would refuse the
          // update first, by their key; take them out so only k can answer.
          for (const inbound of fks.filter(f => f.refTable === k.table && f.refColumns.includes(col))) {
            const match = inbound.columns.map((ic, n) => `r.${ic} = t.${inbound.refColumns[n]}`).join(' AND ');
            await c.query(`ALTER TABLE ${inbound.table} DISABLE TRIGGER USER`);
            await c.query(`DELETE FROM ${inbound.table} r USING ${k.table} t WHERE t.ctid = $1::tid AND ${match}`, [
              row.ctid,
            ]);
          }
          const f = await failure(
            c.query(
              `UPDATE ${k.table} SET ${col} = CASE WHEN ${col} = $2::uuid THEN $3::uuid ELSE $2::uuid END
               WHERE ctid = $1::tid`,
              [row.ctid, ids.adaUser, ids.bobUser],
            ),
          );
          return f.code === '23503' ? f.constraint : `${f.code} ${f.constraint ?? ''}`;
        });
      }
      // review → attempt (subject), result → attempt (subject), offer → attempt (subject), guidance → result (subject),
      // need_share → need (owner): each refused by its own key
      expect(childKeys.length).toBeGreaterThanOrEqual(5);
      expect(Object.entries(outcomes).filter(([name, got]) => got !== name)).toEqual([]);
    });

    // 6a review F1: a pair key (session_id, x_user_id) is skipped by MATCH SIMPLE when session_id is NULL, so where
    // session_id may be NULL a CHECK must refuse a user without a session. Generated from the catalog.
    it('where a participant key’s session_id may be NULL, a CHECK refuses a user with no session (23514)', async () => {
      const nullable = await run.sql<{ t: string }>(`
        SELECT c.relname AS t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'session_id' AND NOT a.attnotnull`);
      const keys = fks.filter(
        f =>
          f.refTable === 'participant' &&
          f.table !== 'participant' &&
          nullable.some(n => n.t === f.table),
      );
      expect([...new Set(keys.map(k => k.table))].sort()).toEqual(['ai_memory', 'brain_activity']);
      const outcomes: Record<string, string | undefined> = {};
      for (const k of keys) {
        const notNull = k.columns.map(c => `${c} IS NOT NULL`).join(' AND ');
        outcomes[k.name] = await inRolledBackTx(async c => {
          await c.query(`ALTER TABLE ${k.table} DISABLE TRIGGER USER`);
          const f = await failure(
            c.query(`UPDATE ${k.table} SET session_id = NULL WHERE ctid = (SELECT ctid FROM ${k.table} WHERE ${notNull} LIMIT 1)`),
          );
          return f.code;
        });
      }
      expect(Object.entries(outcomes).filter(([, code]) => code !== '23514')).toEqual([]);
    });
  });

  describe("the retired triggers' cases, refused by key", () => {
    it('an empathy attempt between participants of two sessions (t_attempt_same_session)', async () => {
      for (const [session, subjectUser] of [
        [ids.session, other.cyUser], // the subject is a participant of the other session only
        [other.session, other.cyUser], // the author is not a participant of the other session
      ]) {
        const f = await failure(
          run.sql(
            `INSERT INTO empathy_attempt (session_id, author_user_id, subject_user_id, round, content) VALUES ($1, $2, $3, 9, 'x')`,
            [session, ids.adaUser, subjectUser],
          ),
        );
        expect(f.code).toBe('23503');
      }
    });

    it('a review by anyone but the attempt’s subject, as mwf_app (t_review_subject)', async () => {
      const [att] = await run.sql<{ id: string }>(
        `SELECT id FROM empathy_attempt WHERE session_id = $1 AND author_user_id = $2 AND status <> 'SUPERSEDED' LIMIT 1`,
        [ids.session, ids.adaUser],
      );
      const f = await failure(
        run.as(
          'mwf_app',
          ids.adaUser,
          `INSERT INTO empathy_review (attempt_id, session_id, reviewer_user_id, validated) VALUES ($1, $2, $3, true)`,
          [att.id, ids.session, ids.adaUser],
        ),
      );
      expect(f.code).toBe('23503');
    });

    it('a share of someone else’s need, or into another session, as mwf_job (t_need_share_owner)', async () => {
      const [need] = await run.sql<{ id: string }>(
        `INSERT INTO need (session_id, user_id, label, category, ai_confidence) VALUES ($1, $2, 'rest', 'CONNECTION', 0.5) RETURNING id`,
        [ids.session, ids.adaUser],
      );
      for (const [s, u] of [
        [ids.session, ids.bobUser],
        [other.session, other.cyUser],
        [other.session, ids.adaUser],
      ]) {
        const f = await failure(
          run.as(
            'mwf_job',
            null,
            `INSERT INTO need_share (need_id, session_id, user_id, category, shared_text) VALUES ($1, $2, $3, 'CONNECTION', 'x')`,
            [need.id, s, u],
          ),
        );
        expect(f.code).toBe('23503');
      }
    });

    it('a reconciler result about another subject is a key violation; a SUPERSEDED round is still the trigger’s', async () => {
      const [att] = await run.sql<{ id: string; status: string }>(
        `SELECT id, status::text FROM empathy_attempt WHERE session_id = $1 AND author_user_id = $2 ORDER BY round DESC LIMIT 1`,
        [ids.session, ids.adaUser],
      );
      const insertResult = (subjectUser: string) =>
        run.as(
          'mwf_job',
          null,
          `INSERT INTO reconciler_result (attempt_id, session_id, subject_user_id, iteration, alignment_score, alignment_summary,
                                          gap_summary, gap_severity, recommended_action, rationale, sharing_would_help)
           VALUES ($1, $2, $3, 99, 50, 's', 'g', 'MINOR', 'PROCEED', 'r', false)`,
          [att.id, ids.session, subjectUser],
        );
      // The author as the subject: the attempt's subject is Bob.
      expect((await failure(insertResult(ids.adaUser))).code).toBe('23503');
      await run.sql(`UPDATE empathy_attempt SET status = 'SUPERSEDED' WHERE id = $1`, [att.id]);
      const f = await failure(insertResult(ids.bobUser));
      expect({ code: f.code, live: /live attempt/.test(f.message ?? '') }).toEqual({ code: '23514', live: true });
      await run.sql(`UPDATE empathy_attempt SET status = $2::empathy_status WHERE id = $1`, [att.id, att.status]);
    });

    it('a seat’s kind is its user’s (t_participant_kind): the AI and a persona never sit as human, a human never as either', async () => {
      const [{ ai }] = await run.sql<{ ai: string }>(`SELECT app.ai_user_id()::text AS ai`);
      const persona = randomUuidV7();
      await run.sql(`INSERT INTO "user" (id, kind, first_name) VALUES ($1, 'persona', 'Pat')`, [persona]);
      await run.sql(`INSERT INTO persona (user_id, owner_user_id) VALUES ($1, $2)`, [persona, ids.adaUser]);
      const seatAs = (userId: string, kind: string) =>
        run.as(
          'mwf_app',
          ids.adaUser,
          `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, $3::user_kind, $4)`,
          [ids.session, userId, kind, ids.adaUser],
        );
      const refused: Record<string, string | undefined> = {};
      for (const [who, userId, kind] of [
        ['ai as human', ai, 'human'],
        ['ai as persona', ai, 'persona'],
        ['persona as human', persona, 'human'],
        ['persona as ai', persona, 'ai'],
        ['human as ai', other.cyUser, 'ai'],
        ['human as persona', other.cyUser, 'persona'],
      ]) {
        refused[who] = (await failure(seatAs(userId, kind))).code;
      }
      expect(refused).toEqual({
        'ai as human': '23503',
        'ai as persona': '23503',
        'persona as human': '23503',
        'persona as ai': '23503',
        'human as ai': '23503',
        'human as persona': '23503',
      });
      // As themselves they sit (rolled back: the fixture's session is not this test's to change).
      await inRolledBackTx(async c => {
        await c.query(
          `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'ai', $4), ($1, $3, 'persona', $4)`,
          [ids.session, ai, persona, ids.adaUser],
        );
        const r = await c.query(
          `SELECT kind::text FROM participant WHERE session_id = $1 AND user_id IN ($2, $3) ORDER BY kind`,
          [ids.session, ai, persona],
        );
        expect(r.rows.map(x => x.kind)).toEqual(['ai', 'persona']);
      });
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
      const [m] = await run.sql<{ conversation_id: string; seq: number; source_attempt_id: string }>(
        `SELECT conversation_id, seq, source_attempt_id FROM message WHERE source_attempt_id IS NOT NULL AND session_id = $1 LIMIT 1`,
        [ids.session],
      );
      await inRolledBackTx(async c => {
        // the attempt's other dependants (agreement-free here) cascade; no trigger stands in the way of the FK actions
        await c.query(`DELETE FROM empathy_attempt WHERE id = $1`, [m.source_attempt_id]);
        const r = await c.query(`SELECT source_attempt_id, session_id FROM message WHERE conversation_id = $1 AND seq = $2`, [
          m.conversation_id,
          m.seq,
        ]);
        // work-k5fk.4 (k5fk.21): one key, SET NULL (source_attempt_id): the session stays.
        expect(r.rows).toEqual([{ source_attempt_id: null, session_id: ids.session }]);
      });
    });

    it('deleting a participant cascades its rows in every child table', async () => {
      await inRolledBackTx(async c => {
        // The agreement's parties and the deferred party/cardinality checks are not what this pins.
        await c.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        await c.query(`UPDATE session SET status = 'RESOLVED', resolved_at = now() WHERE id = $1`, [ids.session]);
        await c.query(`DELETE FROM agreement WHERE session_id = $1`, [ids.session]);
        await c.query(`ALTER TABLE agreement_party DISABLE TRIGGER USER`);
        await c.query(`DELETE FROM participant WHERE session_id = $1 AND user_id = $2`, [ids.session, ids.bobUser]);
        const left: string[] = [];
        const keys = fks.filter(
          f => f.refTable === 'participant' && f.columns.includes('session_id') && f.table !== 'participant',
        );
        expect(keys.length).toBeGreaterThanOrEqual(CHILD_TABLES.length);
        for (const k of keys) {
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

  // 6b review F2: ai_memory has two partial unique indexes, one per arm of its nullable session_id. Each is the
  // only thing refusing its duplicate, so each gets a direct case (dropping either survived the suite before).
  describe('ai_memory: one document per arm', () => {
    const insert = (c: Client, session: string | null, kind: string) =>
      c.query(`INSERT INTO ai_memory (session_id, user_id, kind, doc) VALUES ($1, $2, $3, '{"facts": []}')`, [
        session,
        ids.adaUser,
        kind,
      ]);

    it('a second GLOBAL_FACTS (session NULL) for a user is refused by sql_ai_memory_one_global', async () => {
      await inRolledBackTx(async c => {
        await c.query(`DELETE FROM ai_memory WHERE user_id = $1 AND session_id IS NULL AND kind = 'GLOBAL_FACTS'`, [
          ids.adaUser,
        ]);
        await insert(c, null, 'GLOBAL_FACTS');
        const f = await failure(insert(c, null, 'GLOBAL_FACTS'));
        expect({ code: f.code, constraint: f.constraint }).toEqual({
          code: '23505',
          constraint: 'sql_ai_memory_one_global',
        });
      });
    });

    it('a second per-participant document of a kind (with a session) is refused by sql_ai_memory_one_per_participant', async () => {
      await inRolledBackTx(async c => {
        await c.query(`DELETE FROM ai_memory WHERE user_id = $1 AND session_id = $2 AND kind = 'NOTABLE_FACTS'`, [
          ids.adaUser,
          ids.session,
        ]);
        await insert(c, ids.session, 'NOTABLE_FACTS');
        const f = await failure(insert(c, ids.session, 'NOTABLE_FACTS'));
        expect({ code: f.code, constraint: f.constraint }).toEqual({
          code: '23505',
          constraint: 'sql_ai_memory_one_per_participant',
        });
      });
    });
  });
});
