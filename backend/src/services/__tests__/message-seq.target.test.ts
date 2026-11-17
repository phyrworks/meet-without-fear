/**
 * work-k5fk.4 (design note §5, §7 row 7): a message is keyed (conversation_id,
 * seq). seq is a per-conversation counter: conversation.next_seq, advanced only
 * by the SECURITY DEFINER helper app.next_message_seq, which the BEFORE INSERT
 * trigger t_message_seq calls when an INSERT leaves seq NULL. Taking the next
 * number is an UPDATE of the conversation row, so two inserts into one
 * conversation queue on its row lock and a rolled-back insert returns its
 * number. On clones of the FEEL_HEARD_B and CREATED target fixtures, as the
 * superuser for the catalog and as the real roles for the writes.
 *
 *   - the catalog: message's primary key is (conversation_id, seq) and it has
 *     no id; conversation.next_seq; the helper, the trigger and their grants
 *     (no runtime role may call the helper or touch next_seq / seq);
 *   - the fixture's messages are numbered 1..n per conversation in insertion
 *     (= created_at) order, and next_seq is n + 1;
 *   - concurrent inserts into one conversation, from the app and the job
 *     connections at once, take consecutive numbers with no duplicate and no
 *     gap; a rolled-back insert burns none;
 *   - mwf_app cannot supply seq, change seq, or move next_seq; nobody can
 *     change a written row's seq;
 *   - conversation_read_state names the last seen message by
 *     (last_seen_conversation_id, last_seen_seq), pinned with its session to
 *     message (conversation_id, seq, session_id) ON DELETE SET NULL of the two
 *     columns only; a message of another session is refused;
 *   - the source attempt and refining need pins are one composite key each,
 *     ON DELETE SET NULL of the id column only (work-k5fk.21, .23);
 *   - the API: a MessageDTO's id is "<conversationId>:<seq>" and it carries
 *     seq; POST /viewed takes lastSeenSeq; POST /messages/initial is
 *     idempotent (message-seq-initial.target.test.ts) — two concurrent calls on an empty conversation write one
 *     line, seq 1, and both answer it.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B (and CREATED)
 */

import { Client } from 'pg';
import { isTargetShape } from '../../testing/golden/shape';
import { appUrlFor, httpAs, openTargetRun, type TargetRun } from './target-roles';
import { aiUrlFor } from '../../testing/golden/driver';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

async function failure(p: Promise<unknown>): Promise<{ code?: string; message?: string; detail?: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: err.code, message: err.message, detail: err.detail };
  }
  throw new Error('expected the statement to fail');
}

/** The columns of a constraint, in key order. */
const KEY_COLS = (side: 'conkey' | 'confkey', rel: 'conrelid' | 'confrelid') => `
  (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(c.${side}) WITH ORDINALITY k(attnum, n)
     JOIN pg_attribute a ON a.attrelid = c.${rel} AND a.attnum = k.attnum)`;

interface Fk {
  columns: string[];
  ref_table: string;
  ref_columns: string[];
  on_delete: string;
  set_cols: string[] | null;
}

describeTarget('message key (conversation_id, seq) (work-k5fk.4)', () => {
  let run: TargetRun;
  let ids: { session: string; ada: string; bob: string; adaConv: string; bobConv: string };

  const fksOf = (table: string, refTable: string) =>
    run.sql<Fk & Record<string, unknown>>(
      `SELECT ${KEY_COLS('conkey', 'conrelid')} AS columns, c.confrelid::regclass::text AS ref_table,
              ${KEY_COLS('confkey', 'confrelid')} AS ref_columns, c.confdeltype::text AS on_delete,
              (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(c.confdelsetcols) s(attnum)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = s.attnum) AS set_cols
       FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = $1::regclass AND c.confrelid = $2::regclass
       ORDER BY 1`,
      [table, refTable],
    );

  /** One client per role, so statements can overlap (the default `as` opens and closes one per call). */
  async function clientAs(role: 'mwf_app' | 'mwf_ai', userId: string | null): Promise<Client> {
    const url = role === 'mwf_app' ? appUrlFor(run.fx.target, run.fx.database) : aiUrlFor(run.fx.target, run.fx.database);
    const c = new Client({ connectionString: url });
    await c.connect();
    if (userId) await c.query("SELECT set_config('app.current_user_id', $1, false)", [userId]);
    // work-k5fk.10.5: the AI writes only within its session (app.session_scope; session-wide on this test client).
    if (role === 'mwf_ai') await c.query("SELECT set_config('app.session_scope', $1, false)", [ids.session]);
    return c;
  }

  const seqsOf = async (conv: string) =>
    (await run.sql<{ seq: number }>(`SELECT seq FROM message WHERE conversation_id = $1 ORDER BY seq`, [conv])).map(
      r => r.seq,
    );
  const nextSeqOf = async (conv: string) =>
    (await run.sql<{ n: number }>(`SELECT next_seq AS n FROM conversation WHERE id = $1`, [conv]))[0].n;

  const ownTurn = (c: Client, conv: string, user: string, text: string) =>
    c.query<{ seq: number }>(
      `INSERT INTO message (conversation_id, session_id, sender_user_id, role, kind, content)
       VALUES ($1, $2, $3, 'USER', 'CHAT', $4) RETURNING seq`,
      [conv, ids.session, user, text],
    );
  const aiLine = (c: Client, conv: string, text: string) =>
    c.query<{ seq: number }>(
      `INSERT INTO message (conversation_id, session_id, role, kind, content)
       VALUES ($1, $2, 'AI', 'CHAT', $3) RETURNING seq`,
      [conv, ids.session, text],
    );

  beforeAll(async () => {
    run = await openTargetRun('FEEL_HEARD_B', `k5fk4_seq_${process.pid}`);
    [ids] = await run.sql<typeof ids & Record<string, unknown>>(
      `SELECT ca.session_id AS session, ca.user_id AS ada, cb.user_id AS bob, ca.id AS "adaConv", cb.id AS "bobConv"
       FROM conversation ca JOIN "user" ua ON ua.id = ca.user_id AND ua.email = 'ada@e2e.test'
       JOIN conversation cb ON cb.session_id = ca.session_id AND cb.user_id <> ca.user_id
       WHERE ca.kind = 'MAIN' AND cb.kind = 'MAIN'`,
    );
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  describe('catalog', () => {
    it("message's primary key is (conversation_id, seq); it has no id column", async () => {
      const [pk] = await run.sql<{ cols: string[] }>(
        `SELECT ${KEY_COLS('conkey', 'conrelid')} AS cols FROM pg_constraint c
         WHERE c.conrelid = 'message'::regclass AND c.contype = 'p'`,
      );
      expect(pk.cols).toEqual(['conversation_id', 'seq']);
      const cols = await run.sql<{ attname: string; typ: string; notnull: boolean; hasdef: boolean }>(
        `SELECT attname, format_type(atttypid, atttypmod) AS typ, attnotnull AS notnull, atthasdef AS hasdef
         FROM pg_attribute WHERE attrelid = 'message'::regclass AND attnum > 0 AND NOT attisdropped`,
      );
      expect(cols.map(c => c.attname)).not.toContain('id');
      expect(cols.find(c => c.attname === 'seq')).toEqual({ attname: 'seq', typ: 'integer', notnull: true, hasdef: false });
    });

    it('conversation.next_seq is an integer NOT NULL DEFAULT 1, CHECK >= 1', async () => {
      const [c] = await run.sql<{ typ: string; notnull: boolean; def: string }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = 'conversation'::regclass AND a.attname = 'next_seq'`,
      );
      expect(c).toEqual({ typ: 'integer', notnull: true, def: '1' });
      expect(
        (
          await failure(
            run.sql(`UPDATE conversation SET next_seq = 0 WHERE id = $1`, [ids.adaConv]),
          )
        ).code,
      ).toBe('23514');
    });

    it('the helper is SECURITY DEFINER, owned by the NOLOGIN mwf_definer, and no runtime role may EXECUTE it', async () => {
      const [f] = await run.sql<{ definer: boolean; owner: string; acl: string | null }>(
        `SELECT p.prosecdef AS definer, p.proowner::regrole::text AS owner, p.proacl::text AS acl
         FROM pg_proc p WHERE p.oid = 'app.next_message_seq(uuid)'::regprocedure`,
      );
      expect(f.definer).toBe(true);
      expect(f.owner).toBe('mwf_definer');
      for (const role of ['mwf_app', 'mwf_auth', 'mwf_ops', 'mwf_ai', 'mwf_worker', 'mwf_clinician']) {
        const [{ ok }] = await run.sql<{ ok: boolean }>(
          `SELECT has_function_privilege($1, 'app.next_message_seq(uuid)', 'EXECUTE') AS ok`,
          [role],
        );
        expect({ role, ok }).toEqual({ role, ok: false });
      }
      expect(
        (await failure(run.as('mwf_app', ids.ada, `SELECT app.next_message_seq($1)`, [ids.adaConv]))).code,
      ).toBe('42501');
    });

    it('t_message_seq fires BEFORE INSERT on message, per row, when seq is NULL', async () => {
      const [t] = await run.sql<{ def: string }>(
        `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
         WHERE t.tgrelid = 'message'::regclass AND t.tgname = 't_message_seq'`,
      );
      expect(t.def).toMatch(/BEFORE INSERT ON public\.message FOR EACH ROW WHEN \(\(new\.seq IS NULL\)\) EXECUTE FUNCTION app\.t_message_seq\(\)/);
    });

    it('no runtime role may UPDATE next_seq or seq, nor INSERT a seq', async () => {
      const priv = (role: string, table: string, col: string, p: string) =>
        run
          .sql<{ ok: boolean }>(`SELECT has_column_privilege($1, $2, $3, $4) AS ok`, [role, table, col, p])
          .then(r => r[0].ok);
      // work-k5fk.10.4: mwf_job held UPDATE (next_seq) only as the definers' owner; it moved with them to mwf_definer.
      for (const role of ['mwf_app', 'mwf_auth', 'mwf_ops', 'mwf_ai', 'mwf_worker', 'mwf_clinician']) {
        expect({ role, next_seq: await priv(role, 'conversation', 'next_seq', 'UPDATE') }).toEqual({ role, next_seq: false });
      }
      expect(await priv('mwf_definer', 'conversation', 'next_seq', 'UPDATE')).toBe(true);
      for (const role of ['mwf_app', 'mwf_ai', 'mwf_worker', 'mwf_auth', 'mwf_ops']) {
        expect({ role, ins: await priv(role, 'message', 'seq', 'INSERT'), upd: await priv(role, 'message', 'seq', 'UPDATE') })
          .toEqual({ role, ins: false, upd: false });
      }
      // The AI reads the key and the instant (RETURNING seq, created_at; the initial-message probe).
      expect(await priv('mwf_ai', 'message', 'seq', 'SELECT')).toBe(true);
      expect(await priv('mwf_ai', 'message', 'conversation_id', 'SELECT')).toBe(true);
    });
  });

  describe('numbering', () => {
    it("the fixture's messages are 1..n per conversation in created_at order, and next_seq is n + 1", async () => {
      for (const conv of [ids.adaConv, ids.bobConv]) {
        const rows = await run.sql<{ seq: number; rank: string }>(
          `SELECT seq, row_number() OVER (ORDER BY created_at, seq)::text AS rank FROM message
           WHERE conversation_id = $1 ORDER BY seq`,
          [conv],
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.map(r => r.seq)).toEqual(rows.map((_, i) => i + 1));
        expect(rows.map(r => Number(r.rank))).toEqual(rows.map(r => r.seq));
        expect(await nextSeqOf(conv)).toBe(rows.length + 1);
      }
    });

    it('concurrent inserts into one conversation, app and AI at once, take consecutive numbers', async () => {
      const before = await seqsOf(ids.adaConv);
      const start = await nextSeqOf(ids.adaConv);
      const clients = await Promise.all([
        clientAs('mwf_app', ids.ada),
        clientAs('mwf_ai', null),
        clientAs('mwf_app', ids.ada),
        clientAs('mwf_ai', null),
      ]);
      try {
        // Hold the conversation's lock in one transaction so the others queue behind it.
        await clients[0].query('BEGIN');
        const first = await ownTurn(clients[0], ids.adaConv, ids.ada, 'held');
        const pending: Array<Promise<{ rows: Array<{ seq: number }> }>> = [];
        for (let i = 0; i < 5; i++) {
          for (const [j, c] of clients.slice(1).entries()) {
            pending.push(j % 2 === 0 ? aiLine(c, ids.adaConv, `ai ${i}`) : ownTurn(c, ids.adaConv, ids.ada, `own ${i}`));
          }
        }
        await new Promise(r => setTimeout(r, 200));
        await clients[0].query('COMMIT');
        const got = [first.rows[0].seq, ...(await Promise.all(pending)).map(r => r.rows[0].seq)].sort((a, b) => a - b);
        expect(got).toEqual(Array.from({ length: 16 }, (_, i) => start + i));
      } finally {
        await Promise.all(clients.map(c => c.end()));
      }
      expect(await seqsOf(ids.adaConv)).toEqual([...before, ...Array.from({ length: 16 }, (_, i) => start + i)]);
      expect(await nextSeqOf(ids.adaConv)).toBe(start + 16);
    });

    it('a rolled-back insert burns no number', async () => {
      const start = await nextSeqOf(ids.bobConv);
      const c = await clientAs('mwf_ai', null);
      try {
        await c.query('BEGIN');
        expect((await aiLine(c, ids.bobConv, 'rolled back')).rows[0].seq).toBe(start);
        await c.query('ROLLBACK');
        expect((await aiLine(c, ids.bobConv, 'kept')).rows[0].seq).toBe(start);
      } finally {
        await c.end();
      }
      expect(await nextSeqOf(ids.bobConv)).toBe(start + 1);
    });

    it('each conversation counts on its own', async () => {
      const a = await nextSeqOf(ids.adaConv);
      const b = await nextSeqOf(ids.bobConv);
      await run.as(
        'mwf_ai',
        null,
        `INSERT INTO message (conversation_id, session_id, role, content) VALUES ($1, $2, 'AI', 'x')`,
        [ids.bobConv, ids.session],
        ids.session,
      );
      expect(await nextSeqOf(ids.adaConv)).toBe(a);
      expect(await nextSeqOf(ids.bobConv)).toBe(b + 1);
    });
  });

  describe('the roles cannot move the numbering', () => {
    it('mwf_app cannot supply seq, change seq, or move next_seq', async () => {
      expect(
        (
          await failure(
            run.as(
              'mwf_app',
              ids.ada,
              `INSERT INTO message (conversation_id, seq, session_id, sender_user_id, role, content) VALUES ($1, 999, $2, $3, 'USER', 'x')`,
              [ids.adaConv, ids.session, ids.ada],
            ),
          )
        ).code,
      ).toBe('42501');
      expect(
        (await failure(run.as('mwf_app', ids.ada, `UPDATE message SET seq = seq + 1000 WHERE conversation_id = $1`, [ids.adaConv])))
          .code,
      ).toBe('42501');
      expect(
        (await failure(run.as('mwf_app', ids.ada, `UPDATE conversation SET next_seq = 1 WHERE id = $1`, [ids.adaConv]))).code,
      ).toBe('42501');
      // work-k5fk.10.4: no runtime login holds UPDATE (next_seq) — the NOLOGIN mwf_definer owns app.next_message_seq
      // and holds it alone — so none can move the counter directly (mwf_job's call sites went to mwf_ai, 10.5).
      const [{ ai }] = await run.sql<{ ai: boolean }>(
        `SELECT has_column_privilege('mwf_ai', 'conversation', 'next_seq', 'UPDATE') AS ai`,
      );
      expect(ai).toBe(false);
      expect(
        (
          await failure(
            run.as('mwf_ai', null, `UPDATE conversation SET next_seq = 1 WHERE id = $1`, [ids.adaConv], ids.session),
          )
        ).code,
      ).toBe('42501');
    });

    // review F4: t_conversation_seq_start is the rule, not the grant (mwf_app may INSERT next_seq: a Prisma create
    // sends its @default).
    it('a new conversation counts from 1 whatever its INSERT sends (t_conversation_seq_start)', async () => {
      const [c] = await run.as<{ next_seq: number }>(
        'mwf_app',
        ids.ada,
        `INSERT INTO conversation (session_id, user_id, kind, anchor_kind, next_seq) VALUES ($1, $2, 'SUBCHAT', 'NO_OVERLAP', 500)
         RETURNING next_seq`,
        [ids.session, ids.ada],
      );
      expect(c.next_seq).toBe(1);
    });

    // review F5: a line naming a conversation that does not exist (or vanished while it waited) is refused as the
    // foreign key violation it is, with no DETAIL — never a NOT NULL error that prints the failing row (house rule,
    // functions-caller-tests 28b).
    it('a line for a missing conversation is refused with foreign_key_violation and no DETAIL', async () => {
      const missing = '01900000-0000-7000-8000-00000000abcd';
      const f = await failure(
        run.as(
          'mwf_ai',
          null,
          `INSERT INTO message (conversation_id, session_id, role, kind, content) VALUES ($1, $2, 'AI', 'CHAT', 'PROBE_F5_ROW')`,
          [missing, ids.session],
          ids.session,
        ),
      );
      expect({ code: f.code, detail: f.detail }).toEqual({ code: '23503', detail: undefined });
      expect(f.message ?? '').not.toContain('PROBE_F5_ROW');
    });

    it("nobody changes a written row's seq (t_message_immutable)", async () => {
      const f = await failure(run.sql(`UPDATE message SET seq = seq + 1000 WHERE conversation_id = $1 AND seq = 1`, [ids.adaConv]));
      expect({ code: f.code, routing: /immutable/.test(f.message ?? '') }).toEqual({ code: '23514', routing: true });
    });
  });

  describe('foreign keys', () => {
    it('conversation_read_state names the seen message by (conversation, seq) with its session; SET NULL of the two', async () => {
      const cols = (
        await run.sql<{ attname: string }>(
          `SELECT attname FROM pg_attribute WHERE attrelid = 'conversation_read_state'::regclass AND attnum > 0 AND NOT attisdropped`,
        )
      ).map(c => c.attname);
      expect(cols).not.toContain('last_seen_message_id');
      expect(cols).toEqual(expect.arrayContaining(['last_seen_conversation_id', 'last_seen_seq']));
      expect(await fksOf('conversation_read_state', 'message')).toEqual([
        {
          columns: ['last_seen_conversation_id', 'last_seen_seq', 'session_id'],
          ref_table: 'message',
          ref_columns: ['conversation_id', 'seq', 'session_id'],
          on_delete: 'n',
          set_cols: ['last_seen_conversation_id', 'last_seen_seq'],
        },
      ]);
    });

    it('the read state accepts its own message, refuses one of another session, and is nulled when it goes', async () => {
      const set = (conv: string | null, seq: number | null) =>
        run.as(
          'mwf_app',
          ids.ada,
          `UPDATE conversation_read_state SET last_seen_conversation_id = $1, last_seen_seq = $2 WHERE session_id = $3 AND user_id = $4`,
          [conv, seq, ids.session, ids.ada],
        );
      const [{ seq }] = await run.as<{ seq: number }>(
        'mwf_app',
        ids.ada,
        `INSERT INTO message (conversation_id, session_id, sender_user_id, role, kind, content) VALUES ($1, $2, $3, 'USER', 'CHAT', 'seen') RETURNING seq`,
        [ids.adaConv, ids.session, ids.ada],
      );
      await set(ids.adaConv, seq);
      // Half a pointer is refused.
      expect((await failure(set(ids.adaConv, null))).code).toBe('23514');
      // A conversation of another session (with a seq that exists there) is refused by the key.
      const [s2] = await run.sql<{ id: string }>(`INSERT INTO session (status) VALUES ('CREATED') RETURNING id`);
      await run.sql(`INSERT INTO participant (session_id, user_id, kind, display_name) VALUES ($1, $2, 'human', 'Ada')`, [s2.id, ids.ada]);
      const [c2] = await run.sql<{ id: string }>(
        `INSERT INTO conversation (session_id, user_id) VALUES ($1, $2) RETURNING id`,
        [s2.id, ids.ada],
      );
      await run.sql(`INSERT INTO message (conversation_id, session_id, role, content) VALUES ($1, $2, 'AI', 'elsewhere')`, [
        c2.id,
        s2.id,
      ]);
      expect((await failure(set(c2.id, 1))).code).toBe('23503');
      // Deleting the seen message nulls both columns and keeps the row.
      await run.sql(`DELETE FROM message WHERE conversation_id = $1 AND seq = $2`, [ids.adaConv, seq]);
      const [r] = await run.sql<{ c: string | null; s: number | null; viewed: Date | null }>(
        `SELECT last_seen_conversation_id AS c, last_seen_seq AS s, last_viewed_at AS viewed FROM conversation_read_state
         WHERE session_id = $1 AND user_id = $2`,
        [ids.session, ids.ada],
      );
      expect({ c: r.c, s: r.s }).toEqual({ c: null, s: null });
    });

    it('message → empathy_attempt and → need are one composite key each, SET NULL of the id column only', async () => {
      expect(await fksOf('message', 'empathy_attempt')).toEqual([
        {
          columns: ['source_attempt_id', 'session_id'],
          ref_table: 'empathy_attempt',
          ref_columns: ['id', 'session_id'],
          on_delete: 'n',
          set_cols: ['source_attempt_id'],
        },
      ]);
      expect(await fksOf('message', 'need')).toEqual([
        {
          columns: ['refining_need_id', 'session_id'],
          ref_table: 'need',
          ref_columns: ['id', 'session_id'],
          on_delete: 'n',
          set_cols: ['refining_need_id'],
        },
      ]);
    });
  });

  describe('API', () => {
    let http: Awaited<ReturnType<typeof httpAs>>;
    let ada: { id: string; email: string };
    beforeAll(async () => {
      http = await httpAs();
      ada = { id: ids.ada, email: 'ada@e2e.test' };
    });

    it('a MessageDTO is "<conversationId>:<seq>" and carries seq', async () => {
      const r = await http(ada, 'get', `/sessions/${ids.session}/messages?limit=100&order=asc`);
      expect(r.status).toBe(200);
      const messages = r.body.data.messages as Array<{ id: string; seq: number }>;
      expect(messages.length).toBeGreaterThan(0);
      for (const m of messages) expect(m.id).toBe(`${ids.adaConv}:${m.seq}`);
      const seqs = messages.map(m => m.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    });

    it('POST /viewed takes lastSeenSeq: its own message is kept, anything else reads as null', async () => {
      const [{ seq }] = await run.sql<{ seq: number }>(
        `SELECT max(seq) AS seq FROM message WHERE conversation_id = $1`,
        [ids.adaConv],
      );
      const ok = await http(ada, 'post', `/sessions/${ids.session}/viewed`, { lastSeenSeq: seq });
      expect(ok.status).toBe(200);
      expect(ok.body.data.lastSeenChatItemId).toBe(`${ids.adaConv}:${seq}`);
      const [r] = await run.sql<{ c: string | null; s: number | null }>(
        `SELECT last_seen_conversation_id AS c, last_seen_seq AS s FROM conversation_read_state WHERE session_id = $1 AND user_id = $2`,
        [ids.session, ids.ada],
      );
      expect(r).toEqual({ c: ids.adaConv, s: seq });
      const none = await http(ada, 'post', `/sessions/${ids.session}/viewed`, { lastSeenSeq: seq + 10_000 });
      expect(none.status).toBe(200);
      expect(none.body.data.lastSeenChatItemId).toBeNull();
      const state = await http(ada, 'get', `/sessions/${ids.session}/state`);
      expect(state.status).toBe(200);
      expect(state.body.data.session.lastSeenChatItemId).toBeNull();
    });

    // review F3: the page order is seq, so the cursor is a seq. A line whose created_at is earlier than lines
    // numbered before it (clocks of two writers, an explicit instant) must not fall between two pages.
    it('paging back with beforeSeq visits every line once, even when seq and created_at disagree', async () => {
      await run.sql(
        `INSERT INTO message (conversation_id, session_id, role, kind, content, created_at)
         VALUES ($1::uuid, $2::uuid, 'AI', 'CHAT', 'PROBE_F3_EARLY', (SELECT min(created_at) FROM message WHERE conversation_id = $1::uuid) - interval '1 hour')`,
        [ids.adaConv, ids.session],
      );
      const all = (await seqsOf(ids.adaConv)).reverse();
      const seen: number[] = [];
      let cursor: number | undefined;
      for (let page = 0; page < 100; page++) {
        const q = `limit=5&order=desc${cursor ? `&beforeSeq=${cursor}` : ''}`;
        const r = await http(ada, 'get', `/sessions/${ids.session}/messages?${q}`);
        expect(r.status).toBe(200);
        const msgs = r.body.data.messages as Array<{ seq: number }>;
        seen.push(...msgs.map(m => m.seq).reverse());
        if (!r.body.data.hasMore) break;
        cursor = msgs[0].seq;
      }
      expect(seen).toEqual(all);
    });
  });
});
