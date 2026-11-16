/**
 * work-k5fk.2 review round 1 (F1, F3): the live_session_pair triggers under
 * concurrency and on every path that ends a live session, on a clone of the
 * CREATED target fixture, as the real roles on two connections.
 *
 *   F1 — app.t_live_session_pair takes the session row FOR NO KEY UPDATE:
 *     - a join racing an archive never leaves an ARCHIVED session holding a
 *       pair (archive first: the join pairs nothing; join first: the archive
 *       releases the pair);
 *     - two humans joining one session at once keep their mutual pair (both
 *       orders).
 *   F3 — the trigger arms a mutant could drop:
 *     - archive, abandon and account deletion each release the pair, and a new
 *       session for the same pair then pairs;
 *     - a human joining a RESOLVED session makes no pair;
 *     - a human joining after the AI or a persona is seated pairs with the
 *       humans only;
 *     - an AI adder is refused, and the added_by trigger's UPDATE arm refuses
 *       too, with the one generic message; an UPDATE of a seat's kind away from
 *       its user's kind is refused by the FK (user_id, kind) -> "user" (work-k5fk.3);
 *     - a participant who has left is never paired with, and a row inserted
 *       already left pairs nothing.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { Client } from 'pg';
import { isTargetShape } from '../../testing/golden/shape';
import { appUrlFor, adaAndInvitee, openTargetRun, randomUuidV7, type TargetRun } from './target-roles';
import { jobUrlFor } from '../../testing/golden/driver';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('live_session_pair under concurrency and on every release path (work-k5fk.2 review F1, F3)', () => {
  let run: TargetRun;
  let ada: string;
  let aiUser: string;
  const pid = process.pid;
  const open: Client[] = [];

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `k5fk2_races_${pid}`);
    ada = (await adaAndInvitee(run)).adaUser;
    [{ id: aiUser }] = await run.sql<{ id: string }>(`SELECT app.ai_user_id()::text AS id`);
  });
  afterEach(async () => {
    for (const c of open.splice(0)) await c.end().catch(() => undefined);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  /** A fresh human user (superuser setup). */
  let n = 0;
  const human = async (name: string): Promise<string> => {
    const id = randomUuidV7();
    await run.sql(`INSERT INTO "user" (id, email, first_name) VALUES ($1, $2, $3)`, [
      id,
      `${name.toLowerCase()}-${pid}-${++n}@e2e.test`,
      name,
    ]);
    return id;
  };
  /** A session started by `initiator`, moved to `status` (setup, superuser). */
  const session = async (initiator: string, status: 'CREATED' | 'INVITED' = 'INVITED'): Promise<string> => {
    const [s] = await run.sql<{ id: string }>(`INSERT INTO session (status) VALUES ('CREATED') RETURNING id::text`);
    await run.sql(`INSERT INTO participant (session_id, user_id, display_name) VALUES ($1, $2, 'I')`, [
      s.id,
      initiator,
    ]);
    if (status === 'INVITED') await run.sql(`UPDATE session SET status = 'INVITED' WHERE id = $1`, [s.id]);
    return s.id;
  };
  /** A connection as mwf_app (or mwf_job) with the identity bound, in an open transaction. */
  const conn = async (userId: string | null, role: 'mwf_app' | 'mwf_job' = 'mwf_app'): Promise<Client> => {
    const url =
      role === 'mwf_app' ? appUrlFor(run.fx.target, run.fx.database) : jobUrlFor(run.fx.target, run.fx.database);
    const c = new Client({ connectionString: url });
    await c.connect();
    open.push(c);
    await c.query('BEGIN');
    if (userId) await c.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    return c;
  };
  const JOIN = `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'human', $3)`;
  const join = async (sessionId: string, userId: string, addedBy: string) =>
    run.as('mwf_app', userId, JOIN, [sessionId, userId, addedBy]);
  const pairs = (sessionId: string) =>
    run.sql<{ a: string; b: string }>(
      `SELECT user_a::text AS a, user_b::text AS b FROM live_session_pair WHERE session_id = $1 ORDER BY 1, 2`,
      [sessionId],
    );
  const pair = (x: string, y: string) => (x < y ? { a: x, b: y } : { a: y, b: x });
  const sorted = (...ps: Array<{ a: string; b: string }>) =>
    [...ps].sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));
  /** Resolves true once the backend of `c` is waiting on a lock. */
  const waitsOnLock = async (c: Client): Promise<() => Promise<boolean>> => {
    const [{ pid: backend }] = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
    return async () => {
      for (let i = 0; i < 50; i++) {
        const [r] = await run.sql<{ w: string | null }>(
          `SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1`,
          [backend],
        );
        if (r?.w === 'Lock') return true;
        await new Promise(res => setTimeout(res, 100));
      }
      return false;
    };
  };
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { code: err.code, message: err.message };
    }
    throw new Error('expected the statement to fail');
  };

  describe('F1: a join racing an archive', () => {
    it('archive first: the waiting join re-reads ARCHIVED and pairs nothing; the pair can start again', async () => {
      const ken = await human('Ken');
      const s = await session(ada);
      const archiver = await conn(ada);
      await archiver.query('SELECT app.session_archive($1::uuid)', [s]);
      const joiner = await conn(ken);
      const probe = await waitsOnLock(joiner);
      const joined = joiner.query(JOIN, [s, ken, ada]);
      expect(await probe()).toBe(true); // the join waits on the session row the archive holds
      await archiver.query('COMMIT');
      await joined;
      await joiner.query('COMMIT');
      expect(await run.sql(`SELECT status::text AS status FROM session WHERE id = $1`, [s])).toEqual([
        { status: 'ARCHIVED' },
      ]);
      expect(await pairs(s)).toEqual([]);
      // Nothing blocks the pair: a new live session of theirs pairs.
      const s2 = await session(ada);
      await join(s2, ken, ada);
      expect(await pairs(s2)).toEqual([pair(ada, ken)]);
    });

    it('join first: the waiting archive sees the pair and releases it', async () => {
      const ken = await human('Ken');
      const s = await session(ada);
      const joiner = await conn(ken);
      await joiner.query(JOIN, [s, ken, ada]);
      const archiver = await conn(ada);
      const probe = await waitsOnLock(archiver);
      const archived = archiver.query('SELECT app.session_archive($1::uuid)', [s]);
      expect(await probe()).toBe(true); // the archive waits on the session row the join holds
      await joiner.query('COMMIT');
      await archived;
      await archiver.query('COMMIT');
      expect(await pairs(s)).toEqual([]);
      const s2 = await session(ada);
      await join(s2, ken, ada);
      expect(await pairs(s2)).toEqual([pair(ada, ken)]);
    });
  });

  describe('F1: two humans joining one session at once keep their mutual pair', () => {
    for (const order of ['ken first', 'lea first'] as const) {
      it(order, async () => {
        const ken = await human('Ken');
        const lea = await human('Lea');
        const s = await session(ada);
        const [first, second] = order === 'ken first' ? [ken, lea] : [lea, ken];
        const c1 = await conn(first);
        await c1.query(JOIN, [s, first, ada]);
        const c2 = await conn(second);
        const probe = await waitsOnLock(c2);
        const joined = c2.query(JOIN, [s, second, ada]);
        expect(await probe()).toBe(true);
        await c1.query('COMMIT');
        await joined;
        await c2.query('COMMIT');
        expect(await pairs(s)).toEqual(sorted(pair(ada, ken), pair(ada, lea), pair(ken, lea)));
      });
    }
  });

  describe('F3: every way a session stops being live releases its pairs', () => {
    it('archive (a current participant, app.session_archive)', async () => {
      const ken = await human('Ken');
      const s = await session(ada);
      await join(s, ken, ada);
      expect(await pairs(s)).toEqual([pair(ada, ken)]);
      await run.as('mwf_app', ada, `SELECT app.session_archive($1::uuid)`, [s]);
      expect(await pairs(s)).toEqual([]);
      const s2 = await session(ada);
      await join(s2, ken, ada);
      expect(await pairs(s2)).toEqual([pair(ada, ken)]);
    });

    it('abandon (app.session_set_status as the job)', async () => {
      const ken = await human('Ken');
      const s = await session(ada);
      await join(s, ken, ada);
      await run.as('mwf_job', null, `SELECT app.session_set_status($1::uuid, 'ABANDONED')`, [s]);
      expect(await pairs(s)).toEqual([]);
      const s2 = await session(ada);
      await join(s2, ken, ada);
      expect(await pairs(s2)).toEqual([pair(ada, ken)]);
    });

    it('resolve (ACTIVE → RESOLVED)', async () => {
      const ken = await human('Ken');
      const s = await session(ada);
      await join(s, ken, ada);
      await run.as('mwf_job', null, `SELECT app.session_set_status($1::uuid, 'ACTIVE')`, [s]);
      await run.as('mwf_job', null, `SELECT app.session_set_status($1::uuid, 'RESOLVED')`, [s]);
      expect(await pairs(s)).toEqual([]);
    });

    it('account deletion (app.anonymize_user_account abandons the live session)', async () => {
      const ken = await human('Ken');
      const lea = await human('Lea');
      const s = await session(lea);
      await join(s, ken, lea);
      expect(await pairs(s)).toEqual([pair(lea, ken)]);
      await run.as('mwf_job', null, `SELECT app.anonymize_user_account($1::uuid)`, [lea]);
      expect(await pairs(s)).toEqual([]);
      // Ken's pairs elsewhere are untouched, and he can start again with someone else.
      const s2 = await session(ada);
      await join(s2, ken, ada);
      expect(await pairs(s2)).toEqual([pair(ada, ken)]);
    });
  });

  describe('F3: the arms of the pair trigger', () => {
    it('a human joining a RESOLVED session makes no pair', async () => {
      const ken = await human('Ken');
      const s = await session(ada);
      // A conversation of Ada and the AI can go ACTIVE and RESOLVED with one human.
      await run.as(
        'mwf_app',
        ada,
        `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'ai', $3)`,
        [s, aiUser, ada],
      );
      await run.as('mwf_job', null, `SELECT app.session_set_status($1::uuid, 'ACTIVE')`, [s]);
      await run.as('mwf_job', null, `SELECT app.session_set_status($1::uuid, 'RESOLVED')`, [s]);
      await run.sql(JOIN, [s, ken, ada]);
      expect(await pairs(s)).toEqual([]);
    });

    it('a human joining after the AI and a persona are seated pairs with the humans only', async () => {
      const ken = await human('Ken');
      const [persona] = await run.sql<{ id: string }>(
        `WITH u AS (INSERT INTO "user" (kind, first_name) VALUES ('persona', 'P') RETURNING id)
         INSERT INTO persona (user_id, owner_user_id) SELECT id, $1 FROM u RETURNING user_id::text AS id`,
        [ada],
      );
      const s = await session(ada);
      for (const [u, kind] of [
        [aiUser, 'ai'],
        [persona.id, 'persona'],
      ])
        await run.as(
          'mwf_app',
          ada,
          `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, $3::user_kind, $4)`,
          [s, u, kind, ada],
        );
      await join(s, ken, ada);
      expect(await pairs(s)).toEqual([pair(ada, ken)]);
    });

    it('a participant who left is never paired with; a row inserted already left pairs nothing', async () => {
      const ken = await human('Ken');
      const lea = await human('Lea');
      const max = await human('Max');
      const s = await session(ada);
      await join(s, lea, ada);
      await run.sql(`UPDATE participant SET left_at = now() WHERE session_id = $1 AND user_id = $2`, [s, lea]);
      await join(s, ken, ada);
      // (ada, lea) stays — a later left_at releases nothing (work-k5fk.18) — but ken never pairs with lea.
      expect(await pairs(s)).toEqual(sorted(pair(ada, ken), pair(ada, lea)));
      await run.sql(
        `INSERT INTO participant (session_id, user_id, kind, added_by_user_id, left_at) VALUES ($1, $2, 'human', $3, now())`,
        [s, max, ada],
      );
      expect((await pairs(s)).some(p => p.a === max || p.b === max)).toBe(false);
    });
  });

  describe('F3: who may add whom, on INSERT and on UPDATE (one generic refusal)', () => {
    it('an AI adder is refused', async () => {
      const ken = await human('Ken');
      const s = await session(ada);
      await run.as(
        'mwf_app',
        ada,
        `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'ai', $3)`,
        [s, aiUser, ada],
      );
      expect(await failure(run.sql(JOIN, [s, ken, aiUser]))).toEqual({ code: '23514', message: 'participant refused' });
    });

    it('the kind FK refuses an UPDATE that would make the AI a human, or a human the AI', async () => {
      const ken = await human('Ken');
      const s = await session(ada);
      await run.as(
        'mwf_app',
        ada,
        `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, 'ai', $3)`,
        [s, aiUser, ada],
      );
      await join(s, ken, ada);
      expect(
        await failure(
          run.sql(`UPDATE participant SET kind = 'human' WHERE session_id = $1 AND user_id = $2`, [s, aiUser]),
        ),
      ).toEqual({ code: '23503', message: expect.stringContaining('"participant_user_id_kind_fkey"') });
      expect(
        await failure(run.sql(`UPDATE participant SET kind = 'ai' WHERE session_id = $1 AND user_id = $2`, [s, ken])),
      ).toEqual({ code: '23503', message: expect.stringContaining('"participant_user_id_kind_fkey"') });
    });

    it('the added_by trigger refuses an UPDATE to an AI adder or a persona’s non-owner', async () => {
      const ken = await human('Ken');
      const [persona] = await run.sql<{ id: string }>(
        `WITH u AS (INSERT INTO "user" (kind, first_name) VALUES ('persona', 'P') RETURNING id)
         INSERT INTO persona (user_id, owner_user_id) SELECT id, $1 FROM u RETURNING user_id::text AS id`,
        [ada],
      );
      const s = await session(ada);
      await join(s, ken, ada);
      for (const [u, kind] of [
        [aiUser, 'ai'],
        [persona.id, 'persona'],
      ])
        await run.as(
          'mwf_app',
          ada,
          `INSERT INTO participant (session_id, user_id, kind, added_by_user_id) VALUES ($1, $2, $3::user_kind, $4)`,
          [s, u, kind, ada],
        );
      expect(
        await failure(
          run.sql(`UPDATE participant SET added_by_user_id = $3 WHERE session_id = $1 AND user_id = $2`, [
            s,
            ken,
            aiUser,
          ]),
        ),
      ).toEqual({ code: '23514', message: 'participant refused' });
      expect(
        await failure(
          run.sql(`UPDATE participant SET added_by_user_id = $3 WHERE session_id = $1 AND user_id = $2`, [
            s,
            persona.id,
            ken,
          ]),
        ),
      ).toEqual({ code: '23514', message: 'participant refused' });
    });
  });
});
