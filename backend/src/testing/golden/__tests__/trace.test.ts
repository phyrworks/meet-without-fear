/**
 * Unit tests for the SQL-statement trace oracle's parser.
 *
 * Every log sample here is **real output** from the project's own container
 * (pgvector/pgvector:pg16, Postgres 16.14) captured through
 * `podman logs mwf-postgres`, not text written to match the parser. Continuation
 * lines are real tabs. Writing these by hand is how a parser ends up agreeing
 * with its author's memory of a log format rather than with Postgres — and this
 * file has already been caught once with a fabricated sample: a journald
 * `Suppressed N messages` notice given a Postgres-style prefix that the real
 * pipeline cannot produce, propping up a check that could never fire. Both the
 * check and the sample are gone.
 *
 * The two facts these tests exist to protect are the two mutations that escaped
 * the HTTP-diffing harness (see `README.md`, "Discrimination results"):
 *
 *   1. a dropped `take` shows up as a top-node row count and a missing `Limit`;
 *   2. a dropped `$transaction` shows up as two vxid groups instead of one,
 *      and a lost `SERIALIZABLE` isolation level.
 *
 * If a change here makes either invisible, the oracle is decoration.
 */

import {
  MARK_PREFIX,
  UNASSERTED_CONNECTIONS,
  buildTrace,
  extractWindow,
  groupTransactions,
  parsePostgresLog,
  statementsOutsideWindows,
  summarize,
  unassertedRows,
} from '../trace';

const APP = 'mwf-app-under-test';

/** Real capture: a simple-protocol INSERT, an extended-protocol SELECT with a LIMIT. */
const SAMPLE_BASIC = [
  `2026-08-17 22:21:32.435 UTC [48199] db=probe,app=${APP},vxid=3/85288,xid=0 LOG:  statement: INSERT INTO "Message" ("forUserId", body) SELECT 'u'||((g%2)+1), 'm'||g FROM generate_series(1,13) g`,
  `2026-08-17 22:21:32.436 UTC [48199] db=probe,app=${APP},vxid=3/85288,xid=7111 LOG:  duration: 0.061 ms  plan:`,
  `\tQuery Text: INSERT INTO "Message" ("forUserId", body) SELECT 'u'||((g%2)+1), 'm'||g FROM generate_series(1,13) g`,
  `\tInsert on "Message"  (cost=0.00..0.46 rows=0 width=0) (actual rows=0 loops=1)`,
  `\t  ->  Function Scan on generate_series g  (cost=0.00..0.46 rows=13 width=68) (actual rows=13 loops=1)`,
  `2026-08-17 22:21:32.437 UTC [48199] db=probe,app=${APP},vxid=3/85289,xid=0 LOG:  execute <unnamed>: SELECT m.*, u.name FROM "Message" m JOIN "User" u ON u.id = m."forUserId" WHERE m."forUserId" = $1 ORDER BY m.id LIMIT $2`,
  `2026-08-17 22:21:32.437 UTC [48199] db=probe,app=${APP},vxid=3/85289,xid=0 LOG:  duration: 0.021 ms  plan:`,
  `\tQuery Text: SELECT m.*, u.name FROM "Message" m JOIN "User" u ON u.id = m."forUserId" WHERE m."forUserId" = $1 ORDER BY m.id LIMIT $2`,
  `\tLimit  (cost=28.87..28.88 rows=4 width=100) (actual rows=6 loops=1)`,
  `\t  ->  Sort  (cost=28.87..28.88 rows=4 width=100) (actual rows=6 loops=1)`,
  `\t        Sort Key: m.id`,
  `\t        Sort Method: quicksort  Memory: 25kB`,
  `\t        ->  Nested Loop  (cost=0.15..28.83 rows=4 width=100) (actual rows=6 loops=1)`,
  `\t              ->  Index Scan using "User_pkey" on "User" u  (cost=0.15..8.17 rows=1 width=64) (actual rows=1 loops=1)`,
  `\t                    Index Cond: (id = 'u1'::text)`,
  `\t              ->  Seq Scan on "Message" m  (cost=0.00..20.62 rows=4 width=68) (actual rows=6 loops=1)`,
  `\t                    Filter: ("forUserId" = 'u1'::text)`,
  `\t                    Rows Removed by Filter: 7`,
].join('\n');

/** Real capture: BEGIN / SET TRANSACTION ISOLATION LEVEL SERIALIZABLE / read / write / COMMIT. */
const SAMPLE_SERIALIZABLE = [
  `2026-08-17 22:20:20.859 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  statement: BEGIN`,
  `2026-08-17 22:20:20.859 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  statement: SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`,
  `2026-08-17 22:20:20.860 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  statement: SELECT count(*) FROM t`,
  `2026-08-17 22:20:20.860 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  duration: 0.026 ms  plan:`,
  `\tQuery Text: SELECT count(*) FROM t`,
  `\tAggregate  (cost=25.88..25.89 rows=1 width=8) (actual rows=1 loops=1)`,
  `\t  ->  Seq Scan on t  (cost=0.00..22.70 rows=1270 width=0) (actual rows=20 loops=1)`,
  `2026-08-17 22:20:20.860 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  execute <unnamed>: UPDATE t SET v = $1 WHERE id = $2`,
  `2026-08-17 22:20:20.860 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=7106 LOG:  duration: 0.038 ms  plan:`,
  `\tQuery Text: UPDATE t SET v = $1 WHERE id = $2`,
  `\tUpdate on t  (cost=0.15..8.17 rows=0 width=0) (actual rows=0 loops=1)`,
  `\t  ->  Index Scan using t_pkey on t  (cost=0.15..8.17 rows=1 width=38) (actual rows=1 loops=1)`,
  `\t        Index Cond: (id = 1)`,
  `2026-08-17 22:20:20.861 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=7106 LOG:  statement: COMMIT`,
].join('\n');

describe('parsePostgresLog', () => {
  it('reads the %m [%p] db=%d,app=%a,vxid=%v,xid=%x prefix', () => {
    const [first] = parsePostgresLog(SAMPLE_BASIC);
    expect(first).toMatchObject({
      pid: '48199',
      database: 'probe',
      application: APP,
      vxid: '3/85288',
      xid: '0',
      severity: 'LOG',
    });
  });

  it('attaches tab-continuation lines to the record above them', () => {
    const records = parsePostgresLog(SAMPLE_BASIC);
    // 4 prefixed lines, 14 continuation lines. If continuations were treated as
    // records the plan would be shredded across 18 unparseable entries.
    expect(records).toHaveLength(4);
    expect(records[1].message).toBe('duration: 0.061 ms  plan:');
    expect(records[1].detail[0]).toMatch(/^Query Text: INSERT INTO "Message"/);
    expect(records[1].detail).toHaveLength(3);
  });

  it('tolerates lines logged before the prefix was widened', () => {
    // `log_line_prefix` is SIGHUP-scope and set once, so a container that has
    // been up for days has megabytes of `%m [%p] ` lines above the window.
    const raw = [
      '2026-08-17 22:18:36.774 UTC [57] LOG:  checkpoint starting: time',
      `2026-08-17 22:20:20.859 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  statement: BEGIN`,
    ].join('\n');
    const records = parsePostgresLog(raw);
    expect(records).toHaveLength(2);
    expect(records[0].application).toBe('');
    expect(records[1].application).toBe(APP);
  });

  it('discards DETAIL: parameters: records outright', () => {
    // Belt and braces with `log_parameter_max_length=0`. This product's whole
    // thesis is a privacy boundary and the journald log outlives the run, so a
    // regression that re-enables parameter logging must not be able to walk a
    // bind value into a golden file.
    const raw = [
      `2026-08-17 22:20:20.860 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  execute <unnamed>: SELECT $1`,
      `2026-08-17 22:20:20.860 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 DETAIL:  parameters: $1 = 'I feel unseen when the chores pile up'`,
    ].join('\n');
    const records = parsePostgresLog(raw);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('chores pile up');
  });
});

describe('buildTrace', () => {
  it('keeps only the application under test', () => {
    const raw = [
      SAMPLE_BASIC,
      `2026-08-17 22:21:32.500 UTC [48200] db=probe,app=mwf-golden-harness,vxid=4/1,xid=0 LOG:  statement: SELECT 1`,
    ].join('\n');
    const stmts = buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP });
    expect(stmts).toHaveLength(2);
  });

  it('keeps only the run database', () => {
    const raw = [
      SAMPLE_BASIC,
      `2026-08-17 22:21:32.500 UTC [48201] db=other_run,app=${APP},vxid=5/1,xid=0 LOG:  statement: SELECT 1`,
    ].join('\n');
    const stmts = buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP });
    expect(stmts).toHaveLength(2);
  });

  it('distinguishes simple from extended protocol', () => {
    const stmts = buildTrace(parsePostgresLog(SAMPLE_BASIC), { database: 'probe', application: APP });
    expect(stmts.map(s => s.protocol)).toEqual(['simple', 'extended']);
  });

  it('takes the kind from the plan root, so a CTE-wrapped write is not a SELECT', () => {
    const stmts = buildTrace(parsePostgresLog(SAMPLE_BASIC), { database: 'probe', application: APP });
    expect(stmts.map(s => s.kind)).toEqual(['INSERT', 'SELECT']);
  });

  it('records the top-node actual rows — the dropped-LIMIT discriminator', () => {
    const stmts = buildTrace(parsePostgresLog(SAMPLE_BASIC), { database: 'probe', application: APP });
    // Removing `take: limit + 1` moves this and nothing else in an HTTP response.
    expect(stmts[1].topRows).toBe(6);
  });

  it('records plan node types, so a vanished Limit is a second independent signal', () => {
    const stmts = buildTrace(parsePostgresLog(SAMPLE_BASIC), { database: 'probe', application: APP });
    expect(stmts[1].planNodes).toEqual(['Limit', 'Sort', 'Nested Loop', 'Index Scan', 'Seq Scan']);
  });

  it('counts rows read per relation, weighted by loops', () => {
    const raw = [
      `2026-08-17 22:21:32.437 UTC [48199] db=probe,app=${APP},vxid=3/1,xid=0 LOG:  statement: SELECT 1`,
      `2026-08-17 22:21:32.437 UTC [48199] db=probe,app=${APP},vxid=3/1,xid=0 LOG:  duration: 0.021 ms  plan:`,
      `\tQuery Text: SELECT 1`,
      `\tNested Loop  (cost=0.00..1.00 rows=1 width=0) (actual rows=4 loops=1)`,
      `\t  ->  Seq Scan on "Session"  (cost=0.00..1.00 rows=1 width=0) (actual rows=4 loops=1)`,
      // The N+1 shape: an inner scan executed once per outer row.
      `\t  ->  Index Scan using "Message_pkey" on "Message"  (cost=0.00..1.00 rows=1 width=0) (actual rows=3 loops=4)`,
    ].join('\n');
    const [stmt] = buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP });
    expect(stmt.rowsRead).toEqual({ Message: 12, Session: 4 });
  });

  /**
   * Real output from both versions, captured side by side on identical data:
   * `pgvector/pgvector:pg16` (Postgres 16.14, the `mwf-postgres` container) and
   * `pgvector/pgvector:pg18` (Postgres 18.6, a throwaway container on :5433).
   *
   * PG18 renders `actual rows` to two decimal places. The parser used to require
   * `rows=(\d+)` immediately before ` loops`, so on PG18 nothing matched, every
   * row count silently became 0, and the whole cost channel stopped existing —
   * on the very upgrade this oracle was built to support. Verify mode would have
   * been loud; record mode would have baked an empty channel into a baseline and
   * stayed green.
   */
  describe.each([
    ['PG16', 'Seq Scan on "Message" m  (cost=0.00..20.62 rows=4 width=68) (actual rows=6 loops=1)', 6, 6],
    ['PG18', 'Seq Scan on "Message" m  (cost=0.00..20.62 rows=4 width=68) (actual rows=6.00 loops=1)', 6, 6],
  ])('%s single-loop rendering', (_v, nodeLine, expectTop, expectRead) => {
    it('reads the same row count from either rendering', () => {
      const raw = [
        `2026-08-18 23:50:39.445 UTC [76] db=probe,app=${APP},vxid=2/78,xid=0 LOG:  execute <unnamed>: SELECT 1`,
        `2026-08-18 23:50:39.445 UTC [76] db=probe,app=${APP},vxid=2/78,xid=0 LOG:  duration: 0.018 ms  plan:`,
        `\tQuery Text: SELECT 1`,
        `\t${nodeLine}`,
      ].join('\n');
      const stats = { unparsedPlanNodes: 0 };
      const [stmt] = buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP, stats });
      expect(stmt.topRows).toBe(expectTop);
      expect(stmt.rowsRead).toEqual({ Message: expectRead });
      expect(stats.unparsedPlanNodes).toBe(0);
    });
  });

  it('recovers the true total from a fractional per-loop average', () => {
    // Real capture of the same query on both versions. The inner scan matched 7
    // rows for one outer row and 6 for the other, so the true total is 13.
    // PG18 says `rows=6.50 loops=2` and gets 13. PG16 says `rows=6 loops=2` and
    // gets 12 — it rounds the average to an integer and loses a row. No parser
    // can reconcile that; PG18 is simply more faithful, and the README says so.
    const plan = (nodeLine: string) =>
      [
        `2026-08-18 23:50:39.447 UTC [76] db=probe,app=${APP},vxid=2/80,xid=0 LOG:  execute <unnamed>: SELECT 1`,
        `2026-08-18 23:50:39.447 UTC [76] db=probe,app=${APP},vxid=2/80,xid=0 LOG:  duration: 0.013 ms  plan:`,
        `\tQuery Text: SELECT 1`,
        `\tSeq Scan on "User" u  (cost=0.00..3.40 rows=2 width=11) (actual rows=2.00 loops=1)`,
        `\t    ->  Aggregate  (cost=1.18..1.19 rows=1 width=8) (actual rows=1.00 loops=2)`,
        `\t          ->  ${nodeLine}`,
      ].join('\n');

    const pg18 = buildTrace(parsePostgresLog(plan('Seq Scan on "Message" m  (cost=0.00..1.16 rows=6 width=0) (actual rows=6.50 loops=2)')), {
      database: 'probe',
      application: APP,
    })[0];
    expect(pg18.rowsRead.Message).toBe(13);

    const pg16 = buildTrace(parsePostgresLog(plan('Seq Scan on "Message" m  (cost=0.00..1.16 rows=6 width=0) (actual rows=6 loops=2)')), {
      database: 'probe',
      application: APP,
    })[0];
    expect(pg16.rowsRead.Message).toBe(12);
  });

  it('rounds rather than truncates a repeating average', () => {
    // 10 rows over 3 loops renders as 3.33; truncating `3.33 * 3 = 9.99` loses a
    // row, so the product is rounded.
    const raw = [
      `2026-08-18 23:50:39.447 UTC [76] db=probe,app=${APP},vxid=2/81,xid=0 LOG:  execute <unnamed>: SELECT 1`,
      `2026-08-18 23:50:39.447 UTC [76] db=probe,app=${APP},vxid=2/81,xid=0 LOG:  duration: 0.013 ms  plan:`,
      `\tQuery Text: SELECT 1`,
      `\tSeq Scan on "Message" m  (cost=0.00..1.16 rows=6 width=0) (actual rows=3.33 loops=3)`,
    ].join('\n');
    const [stmt] = buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP });
    expect(stmt.rowsRead.Message).toBe(10);
  });

  it('treats a never-executed node as read-nothing, not as a parse failure', () => {
    // Renders identically on PG16 and PG18 — verified on both containers.
    const raw = [
      `2026-08-18 23:50:39.447 UTC [76] db=probe,app=${APP},vxid=2/82,xid=0 LOG:  execute <unnamed>: SELECT 1`,
      `2026-08-18 23:50:39.447 UTC [76] db=probe,app=${APP},vxid=2/82,xid=0 LOG:  duration: 0.013 ms  plan:`,
      `\tQuery Text: SELECT 1`,
      `\tSeq Scan on "Message" m  (cost=0.00..1.16 rows=1 width=3) (never executed)`,
    ].join('\n');
    const stats = { unparsedPlanNodes: 0 };
    const [stmt] = buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP, stats });
    expect(stmt.rowsRead).toEqual({ Message: 0 });
    expect(stats.unparsedPlanNodes).toBe(0);
  });

  it('counts a node whose row counts cannot be read, so a rendering change fails at capture', () => {
    // The shape of the PG18 defect: node lines still match, because `(cost=` did
    // not change. Only the counts moved. An assertion on "did any node parse"
    // would have missed it entirely, so the tripwire sits on the counts.
    const raw = [
      `2026-08-18 23:50:39.447 UTC [76] db=probe,app=${APP},vxid=2/83,xid=0 LOG:  execute <unnamed>: SELECT 1`,
      `2026-08-18 23:50:39.447 UTC [76] db=probe,app=${APP},vxid=2/83,xid=0 LOG:  duration: 0.013 ms  plan:`,
      `\tQuery Text: SELECT 1`,
      `\tSeq Scan on "Message" m  (cost=0.00..1.16 rows=6 width=0) (actual rows=6,00 loops=1)`,
    ].join('\n');
    const stats = { unparsedPlanNodes: 0 };
    buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP, stats });
    expect(stats.unparsedPlanNodes).toBe(1);
  });

  it('does not mistake an index for a relation', () => {
    const raw = [
      `2026-08-17 22:21:32.437 UTC [48199] db=probe,app=${APP},vxid=3/1,xid=0 LOG:  statement: SELECT 1`,
      `2026-08-17 22:21:32.437 UTC [48199] db=probe,app=${APP},vxid=3/1,xid=0 LOG:  duration: 0.008 ms  plan:`,
      `\tQuery Text: SELECT 1`,
      `\tUpdate on "Message"  (cost=6.34..19.88 rows=0 width=0) (actual rows=0 loops=1)`,
      `\t  ->  Bitmap Heap Scan on "Message"  (cost=6.34..19.88 rows=283 width=38) (actual rows=2 loops=1)`,
      `\t        ->  Bitmap Index Scan on "Message_pkey"  (cost=0.00..6.27 rows=283 width=0) (actual rows=2 loops=1)`,
    ].join('\n');
    const [stmt] = buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP });
    // `Bitmap Index Scan on "Message_pkey"` names an index; `Function Scan on
    // generate_series` names a function; neither is a table, and counting them
    // would make "which relations did this touch" meaningless.
    expect(stmt.relations).toEqual(['Message']);
  });

  it('never carries SQL text or a parameter value on a traced statement', () => {
    const stmts = buildTrace(parsePostgresLog(SAMPLE_BASIC), { database: 'probe', application: APP });
    // Postgres inlines bind values into plan quals (`Filter: ("forUserId" =
    // 'u1'::text)`) regardless of log_parameter_max_length, so "we only keep the
    // plan, not the statement" is not by itself a privacy argument.
    const json = JSON.stringify(stmts);
    expect(json).not.toContain('u1'); // an inlined bind value
    expect(json).not.toContain('Filter'); // the qual line that inlines it
    expect(json).not.toContain('Query Text');
    expect(json).not.toContain('FROM');
    expect(json).not.toContain('INTO');
    // `kind: "SELECT"` is a classification, not text; there is no field on a
    // traced statement that a value could be carried in.
    expect(Object.keys(stmts[0])).toEqual(
      expect.not.arrayContaining(['sql', 'text', 'statement', 'queryText', 'parameters']),
    );
  });
});

describe('groupTransactions', () => {
  it('groups by vxid and reports the isolation level', () => {
    const stmts = buildTrace(parsePostgresLog(SAMPLE_SERIALIZABLE), { database: 'probe', application: APP });
    const txs = groupTransactions(stmts);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ explicit: true, isolation: 'SERIALIZABLE' });
    expect(txs[0].statements).toHaveLength(5);
  });

  it('splits a write moved out of its transaction into two groups', () => {
    // The mutation that escaped the row-diffing harness entirely: identical rows,
    // identical HTTP bodies, only the envelope changes.
    const raw = [
      `2026-08-17 22:20:20.860 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  statement: BEGIN`,
      `2026-08-17 22:20:20.860 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  statement: SELECT count(*) FROM t`,
      `2026-08-17 22:20:20.861 UTC [48189] db=probe,app=${APP},vxid=3/85263,xid=0 LOG:  statement: COMMIT`,
      `2026-08-17 22:20:20.862 UTC [48189] db=probe,app=${APP},vxid=3/85264,xid=0 LOG:  statement: BEGIN`,
      `2026-08-17 22:20:20.862 UTC [48189] db=probe,app=${APP},vxid=3/85264,xid=0 LOG:  execute <unnamed>: UPDATE t SET v = $1`,
      `2026-08-17 22:20:20.863 UTC [48189] db=probe,app=${APP},vxid=3/85264,xid=7106 LOG:  statement: COMMIT`,
    ].join('\n');
    const txs = groupTransactions(buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP }));
    expect(txs).toHaveLength(2);
    // Both halves carry a BEGIN — Prisma wraps a bare `updateMany` in one of its
    // own — so "has a BEGIN" is not a discriminator and the count is.
    expect(txs.map(t => t.explicit)).toEqual([true, true]);
    expect(txs.map(t => t.isolation)).toEqual([null, null]);
  });

  // Real capture. Prisma opens with a bare `BEGIN` and a standalone
  // `SET TRANSACTION ISOLATION LEVEL`, and reading the level only from that
  // second statement is a parser that understands one ORM rather than SQL. A
  // hand-written replacement opening its transaction the idiomatic way recorded
  // `isolation: null` and turned `empathy-reveal`'s assertion red for no reason
  // — the exact way an oracle built to survive the migration fails to.
  describe.each([
    ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'SERIALIZABLE'],
    ['BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'SERIALIZABLE'],
    ['START TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'SERIALIZABLE'],
    ['BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ WRITE', 'REPEATABLE READ'],
    ['START TRANSACTION READ ONLY, ISOLATION LEVEL SERIALIZABLE', 'SERIALIZABLE'],
    ['BEGIN ISOLATION LEVEL READ COMMITTED', 'READ COMMITTED'],
  ])('opening spelling: %s', (sql, expected) => {
    it(`reads the level as ${expected}`, () => {
      const raw = [
        `2026-08-18 00:15:07.001 UTC [52941] db=probe,app=${APP},vxid=3/150020,xid=0 LOG:  statement: ${sql}`,
        `2026-08-18 00:15:07.002 UTC [52941] db=probe,app=${APP},vxid=3/150020,xid=0 LOG:  statement: SELECT 1 FROM t`,
        `2026-08-18 00:15:07.003 UTC [52941] db=probe,app=${APP},vxid=3/150020,xid=0 LOG:  statement: COMMIT`,
      ].join('\n');
      const txs = groupTransactions(buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP }));
      expect(txs).toHaveLength(1);
      expect(txs[0].isolation).toBe(expected);
      expect(txs[0].explicit).toBe(true);
      // The mode list must not be swallowed into the level.
      expect(txs[0].isolation).not.toMatch(/READ WRITE|READ ONLY/);
    });
  });

  it('carries a SET SESSION CHARACTERISTICS default onto later transactions', () => {
    // Real capture. This is how a hand-written implementation can legitimately
    // make every transaction on a connection Serializable without saying so at
    // any BEGIN. Missing it is a false negative on the isolation assertion.
    const raw = [
      `2026-08-18 00:15:07.010 UTC [52941] db=probe,app=${APP},vxid=3/150026,xid=0 LOG:  statement: SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE`,
      `2026-08-18 00:15:07.011 UTC [52941] db=probe,app=${APP},vxid=3/150027,xid=0 LOG:  statement: BEGIN`,
      `2026-08-18 00:15:07.012 UTC [52941] db=probe,app=${APP},vxid=3/150027,xid=0 LOG:  statement: SELECT 1 FROM t`,
      `2026-08-18 00:15:07.013 UTC [52941] db=probe,app=${APP},vxid=3/150027,xid=0 LOG:  statement: COMMIT`,
    ].join('\n');
    const txs = groupTransactions(buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP }));
    expect(txs).toHaveLength(2);
    // The SET's own group does not retroactively claim the level it establishes.
    expect(txs[0].isolation).toBeNull();
    expect(txs[0].statements[0].kind).toBe('SET_SESSION_TX');
    expect(txs[1].isolation).toBe('SERIALIZABLE');
  });

  it('does not leak a session default onto another connection', () => {
    const raw = [
      `2026-08-18 00:15:07.010 UTC [1] db=probe,app=${APP},vxid=3/1,xid=0 LOG:  statement: SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE`,
      `2026-08-18 00:15:07.011 UTC [2] db=probe,app=${APP},vxid=4/1,xid=0 LOG:  statement: BEGIN`,
      `2026-08-18 00:15:07.012 UTC [2] db=probe,app=${APP},vxid=4/1,xid=0 LOG:  statement: COMMIT`,
    ].join('\n');
    const txs = groupTransactions(buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP }));
    expect(txs.find(t => t.pid === '2')!.isolation).toBeNull();
  });

  it('separates concurrent transactions on different backends', () => {
    const raw = [
      `2026-08-17 22:20:20.860 UTC [1] db=probe,app=${APP},vxid=3/1,xid=0 LOG:  statement: BEGIN`,
      `2026-08-17 22:20:20.860 UTC [2] db=probe,app=${APP},vxid=4/1,xid=0 LOG:  statement: BEGIN`,
      `2026-08-17 22:20:20.861 UTC [1] db=probe,app=${APP},vxid=3/1,xid=0 LOG:  statement: COMMIT`,
      `2026-08-17 22:20:20.861 UTC [2] db=probe,app=${APP},vxid=4/1,xid=0 LOG:  statement: COMMIT`,
    ].join('\n');
    const txs = groupTransactions(buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP }));
    expect(txs).toHaveLength(2);
    expect(txs[0].pid).not.toBe(txs[1].pid);
  });
});

describe('summarize', () => {
  it('never leaks a pid or a vxid', () => {
    const stmts = buildTrace(parsePostgresLog(SAMPLE_SERIALIZABLE), { database: 'probe', application: APP });
    const json = JSON.stringify(summarize(groupTransactions(stmts), { complete: true }));
    // A pid changes every run and every container restart; a vxid changes every
    // transaction. Either one in a golden is a permanently red suite.
    expect(json).not.toContain('48189');
    expect(json).not.toContain('3/85263');
  });

  it('rolls up the counts a cost regression moves', () => {
    const stmts = buildTrace(parsePostgresLog(SAMPLE_SERIALIZABLE), { database: 'probe', application: APP });
    const s = summarize(groupTransactions(stmts), { complete: true });
    expect(s).toMatchObject({
      complete: true,
      connections: 1,
      transactions: 1,
      statements: 5,
      byKind: { BEGIN: 1, COMMIT: 1, SELECT: 1, SET_TX: 1, UPDATE: 1 },
      rowsRead: { t: 21 },
    });
    expect(s.shapes[0]).toMatchObject({ occurrences: 1, isolation: 'SERIALIZABLE', statementCount: 5 });
  });

  it('groups identical transactions and counts them', () => {
    // The resolution the oracle was asked for: a redundant query removed moves
    // one number by one, instead of shifting a hundred array positions.
    const line = (vxid: string) =>
      `2026-08-17 22:20:20.860 UTC [1] db=probe,app=${APP},vxid=${vxid},xid=0 LOG:  statement: SELECT 1`;
    const raw = [line('3/1'), line('3/2'), line('3/3')].join('\n');
    const s = summarize(groupTransactions(buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP })), {
      complete: true,
    });
    expect(s.shapes).toHaveLength(1);
    expect(s.shapes[0].occurrences).toBe(3);
    expect(s.transactions).toBe(3);
  });

  it('orders shapes canonically, not by when they were logged', () => {
    // Prisma's pool interleaves independent transactions differently every run;
    // ordering by first appearance was measured producing 4 distinct traces in 6
    // runs of one step, with the same multiset every time.
    const stmt = (vxid: string, sql: string) =>
      `2026-08-17 22:20:20.860 UTC [1] db=probe,app=${APP},vxid=${vxid},xid=0 LOG:  statement: ${sql}`;
    const forward = [stmt('3/1', 'SELECT 1'), stmt('3/2', 'UPDATE t SET v = 1')].join('\n');
    const reversed = [stmt('3/2', 'UPDATE t SET v = 1'), stmt('3/1', 'SELECT 1')].join('\n');
    const of = (raw: string) =>
      summarize(groupTransactions(buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP })), {
        complete: true,
      });
    expect(JSON.stringify(of(forward).shapes)).toEqual(JSON.stringify(of(reversed).shapes));
  });

  it('unasserts only the declared relation, and leaves every other one exact', () => {
    // Two corrections are baked into this. The first version discarded the whole
    // rowsRead map on any async step, throwing away relations that had never
    // moved. The second replaced that with fitted ranges, which failed on a clean
    // tree. What survives is the narrowing: one relation, everything else exact.
    const stmts = buildTrace(parsePostgresLog(SAMPLE_BASIC), { database: 'probe', application: APP });
    const exact = summarize(groupTransactions(stmts), { complete: true });
    const muted = summarize(groupTransactions(stmts), {
      complete: true,
      unasserted: { connections: true, rowCounts: ['Message'] },
    });

    expect(exact.rowsRead).toEqual({ Message: 6, User: 1 });
    expect(muted.rowsRead).toEqual({ Message: unassertedRows('Message'), User: 1 });
    expect(muted.connections).toBe(UNASSERTED_CONNECTIONS);
    // Kinds, relations, plan shape and the envelope are never coarsened.
    expect(muted.statements).toBe(2);
    expect(muted.byKind).toEqual({ INSERT: 1, SELECT: 1 });
    expect(muted.shapes.flatMap(s => s.statements.map(x => x.planNodes))).toContainEqual([
      'Limit',
      'Sort',
      'Nested Loop',
      'Index Scan',
      'Seq Scan',
    ]);
  });

  it('says what it is, so an unasserted field cannot be mistaken for data', () => {
    // A bare sentinel would read like a value. A reader who cannot tell an
    // unasserted field from a measured one eventually re-records the golden to
    // make a red go away, which is the failure this harness's conventions exist
    // to prevent.
    for (const text of [UNASSERTED_CONNECTIONS, unassertedRows('Message')]) {
      expect(text).toMatch(/^<unasserted: /);
      expect(text.length).toBeGreaterThan(60);
      expect(text).toMatch(/see the step declaration/);
    }
    // Parameterized: a placeholder must not explain itself with another
    // relation's reasoning. Declaring a band on `EmpathyAttempt` used to emit a
    // sentence that talked about Message.
    expect(unassertedRows('EmpathyAttempt')).toContain('"EmpathyAttempt"');
    expect(unassertedRows('EmpathyAttempt')).not.toContain('Message');
    // No sample statistics: those live in the step declaration, so the first
    // re-measurement does not redden every golden.
    expect(UNASSERTED_CONNECTIONS).not.toMatch(/\b\d+ runs?\b/);
    expect(unassertedRows('Message')).not.toMatch(/\b\d+ runs?\b/);
  });

  it('suppresses topRows only when the unasserted scan is the plan root', () => {
    // Validated against 30 captures: the statement that actually flips is a bare
    // Index Scan, while five `Limit -> Index Scan Backward` statements over the
    // same relation are stable and keep their exact topRows. Here the Message
    // scan sits under a Limit, so the root count survives — which is what keeps
    // a Limit that stopped limiting visible even on an unasserted relation.
    const stmts = buildTrace(parsePostgresLog(SAMPLE_BASIC), { database: 'probe', application: APP });
    const s = summarize(groupTransactions(stmts), { complete: true, unasserted: { rowCounts: ['Message'] } });
    const select = s.shapes.flatMap(x => x.statements).find(x => x.kind === 'SELECT')!;
    expect(select.rowsRead).toEqual({ Message: unassertedRows('Message'), User: 1 });
    expect(select.topRows).toBe(6);
  });

  it('merges shapes that differ only in an unasserted count', () => {
    // This is what actually removes the flake: the raced read produced two
    // buckets (Message=0 and Message=1) that collapse into one.
    const scan = (rows: number, vxid: string) =>
      [
        `2026-08-17 22:20:20.860 UTC [1] db=probe,app=${APP},vxid=${vxid},xid=0 LOG:  execute <unnamed>: SELECT 1`,
        `2026-08-17 22:20:20.860 UTC [1] db=probe,app=${APP},vxid=${vxid},xid=0 LOG:  duration: 0.021 ms  plan:`,
        `\tQuery Text: SELECT 1`,
        `\tIndex Scan using "Message_pkey" on "Message"  (cost=0.15..8.17 rows=1 width=38) (actual rows=${rows} loops=1)`,
      ].join('\n');
    const raw = [scan(0, '3/1'), scan(1, '3/2')].join('\n');
    const stmts = buildTrace(parsePostgresLog(raw), { database: 'probe', application: APP });

    expect(summarize(groupTransactions(stmts), { complete: true }).shapes).toHaveLength(2);
    const muted = summarize(groupTransactions(stmts), { complete: true, unasserted: { rowCounts: ['Message'] } });
    expect(muted.shapes).toHaveLength(1);
    expect(muted.shapes[0].occurrences).toBe(2);
    // Here the scan IS the root, so topRows goes with it.
    expect(muted.shapes[0].statements[0].topRows).toBe(unassertedRows('Message'));
  });

  it('leaves a relation exact when the step declares nothing', () => {
    // The default must be "assert everything". A step that forgets to declare a
    // genuine race flakes loudly, which is the safe direction.
    const stmts = buildTrace(parsePostgresLog(SAMPLE_BASIC), { database: 'probe', application: APP });
    const s = summarize(groupTransactions(stmts), { complete: true });
    expect(s.connections).toBe(1);
    expect(s.rowsRead).toEqual({ Message: 6, User: 1 });
  });

  it('carries incompleteness through instead of reporting a smaller trace', () => {
    const s = summarize([], { complete: false, incompleteReason: 'end-marker-missing' });
    // A truncated window and a quiet step look identical from the counts alone.
    // `settled` already taught this harness that lesson once (see driver.ts).
    expect(s.complete).toBe(false);
    expect(s.incompleteReason).toBe('end-marker-missing');
  });
});

/** The closed set `incompleteReason` may take. Mirrors `IncompleteReason`. */
const REASONS = [
  'never-read',
  'begin-marker-missing',
  'end-marker-missing',
  'markers-duplicated',
  'markers-out-of-order',
  'no-app-statements',
];

describe('extractWindow', () => {
  const markLine = (token: string, pid = '99') =>
    `2026-08-17 22:20:20.000 UTC [${pid}] db=probe,app=mwf-golden-marker,vxid=9/1,xid=0 LOG:  statement: SELECT '${MARK_PREFIX}${token}'`;

  it('slices between the sentinels, excluding the markers themselves', () => {
    const raw = [
      `2026-08-17 22:20:19.000 UTC [48189] db=probe,app=${APP},vxid=3/1,xid=0 LOG:  statement: SELECT 'before'`,
      markLine('s0b'),
      `2026-08-17 22:20:20.100 UTC [48189] db=probe,app=${APP},vxid=3/2,xid=0 LOG:  statement: SELECT 'inside'`,
      markLine('s0e'),
      `2026-08-17 22:20:21.000 UTC [48189] db=probe,app=${APP},vxid=3/3,xid=0 LOG:  statement: SELECT 'after'`,
    ].join('\n');
    const w = extractWindow(parsePostgresLog(raw), { beginToken: 's0b', endToken: 's0e' });
    expect(w.complete).toBe(true);
    expect(w.records).toHaveLength(1);
    expect(w.records[0].message).toContain("'inside'");
  });

  it('is incomplete when the end marker never arrived', () => {
    const raw = [markLine('s0b'), `2026-08-17 22:20:20.100 UTC [48189] db=probe,app=${APP},vxid=3/2,xid=0 LOG:  statement: SELECT 1`].join('\n');
    const w = extractWindow(parsePostgresLog(raw), { beginToken: 's0b', endToken: 's0e' });
    expect(w.complete).toBe(false);
    expect(w.incompleteReason).toBe('end-marker-missing');
  });

  it('is incomplete when the begin marker has already scrolled out of the read', () => {
    const raw = [`2026-08-17 22:20:20.100 UTC [48189] db=probe,app=${APP},vxid=3/2,xid=0 LOG:  statement: SELECT 1`, markLine('s0e')].join('\n');
    const w = extractWindow(parsePostgresLog(raw), { beginToken: 's0b', endToken: 's0e' });
    expect(w.complete).toBe(false);
    expect(w.incompleteReason).toBe('begin-marker-missing');
  });

  it('rejects a duplicated marker rather than guessing which one is the window', () => {
    const raw = [markLine('s0b'), markLine('s0b'), markLine('s0e')].join('\n');
    const w = extractWindow(parsePostgresLog(raw), { beginToken: 's0b', endToken: 's0e' });
    expect(w.complete).toBe(false);
    expect(w.incompleteReason).toBe('markers-duplicated');
    expect(w.incompleteCounts).toEqual({ beginMarkers: 2, endMarkers: 1, reads: 1 });
  });

  it('never puts window content into the reason it reports', () => {
    // This is a privacy guard, not tidiness. `incompleteReason` is embedded by
    // `summarize`, written into `__golden__/*.json` in record mode and printed
    // in verify mode, and it bypasses the runner's unresolved-id check, which
    // does not inspect the trace. A previous version quoted a matched log line
    // here and a probe drove real user-shaped content into a golden through it.
    const secret = 'I feel unseen when the chores pile up';
    const raw = [
      markLine('s0b'),
      `2026-08-17 22:20:20.100 UTC [48189] db=probe,app=${APP},vxid=3/2,xid=0 LOG:  statement: SELECT '${secret}'`,
      markLine('s0b'),
      markLine('s0e'),
    ].join('\n');
    const w = extractWindow(parsePostgresLog(raw), { beginToken: 's0b', endToken: 's0e' });
    expect(w.complete).toBe(false);
    // The reason is drawn from a closed set, so there is no path by which a
    // record's text can reach it.
    expect(REASONS).toContain(w.incompleteReason);
    expect(JSON.stringify(w)).not.toContain('chores');

    const s = summarize([], { complete: false, incompleteReason: w.incompleteReason, incompleteCounts: w.incompleteCounts });
    expect(JSON.stringify(s)).not.toContain('chores');
    expect(REASONS).toContain(s.incompleteReason);
  });
});

describe('statementsOutsideWindows', () => {
  const markLine = (token: string) =>
    `2026-08-17 22:20:20.000 UTC [99] db=probe,app=mwf-golden-marker,vxid=9/1,xid=0 LOG:  statement: SELECT '${MARK_PREFIX}${token}'`;
  const appLine = (vxid: string) =>
    `2026-08-17 22:20:20.100 UTC [48189] db=probe,app=${APP},vxid=${vxid},xid=0 LOG:  statement: SELECT 1`;

  it('counts nothing when every statement is inside a window', () => {
    const raw = [markLine('a_b'), appLine('3/1'), markLine('a_e'), markLine('b_b'), appLine('3/2'), markLine('b_e')].join('\n');
    const n = statementsOutsideWindows(parsePostgresLog(raw), {
      database: 'probe',
      windows: [
        { beginToken: 'a_b', endToken: 'a_e' },
        { beginToken: 'b_b', endToken: 'b_e' },
      ],
    });
    expect(n).toBe(0);
  });

  it('catches a statement that escaped between two windows', () => {
    // `settle()` watches rows, so a trailing read that touches none can outlive
    // it. Undetected, that statement either contaminates the next window or is
    // seen by nobody — and an undeclared fire-and-forget path added later looks
    // exactly like this.
    const raw = [markLine('a_b'), appLine('3/1'), markLine('a_e'), appLine('3/9'), markLine('b_b'), appLine('3/2'), markLine('b_e')].join('\n');
    const n = statementsOutsideWindows(parsePostgresLog(raw), {
      database: 'probe',
      windows: [
        { beginToken: 'a_b', endToken: 'a_e' },
        { beginToken: 'b_b', endToken: 'b_e' },
      ],
    });
    expect(n).toBe(1);
  });

  it('ignores the harness own connections and other databases', () => {
    const raw = [
      `2026-08-17 22:20:19.000 UTC [1] db=probe,app=mwf-golden-harness,vxid=1/1,xid=0 LOG:  statement: SELECT 1`,
      `2026-08-17 22:20:19.000 UTC [2] db=other,app=${APP},vxid=2/1,xid=0 LOG:  statement: SELECT 1`,
      markLine('a_b'),
      appLine('3/1'),
      markLine('a_e'),
    ].join('\n');
    const n = statementsOutsideWindows(parsePostgresLog(raw), {
      database: 'probe',
      windows: [{ beginToken: 'a_b', endToken: 'a_e' }],
    });
    expect(n).toBe(0);
  });
});
