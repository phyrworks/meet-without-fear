/**
 * Golden harness — the SQL-statement trace oracle.
 *
 * The rest of this harness diffs HTTP responses and table rows. That is
 * structurally blind to *how* the database was used, and two mutations to real
 * code were measured escaping it completely (see `README.md`):
 *
 *   1. removing `take: limit + 1` in `controllers/messages.ts` — the controller
 *      re-slices, so the response is byte-identical and only the rows read from
 *      Postgres change;
 *   2. moving the reveal write out of its Serializable `$transaction` in
 *      `services/reconciler/state.ts` — identical rows, identical responses,
 *      only the transaction envelope changes.
 *
 * This module makes both visible, and does it from Postgres's own log so that it
 * needs **no code in the application under test**. That is not a stylistic
 * preference: the oracle has to keep working after Prisma is deleted, and
 * anything instrumented into Prisma would die with it.
 *
 * ## Why the log and not `pg_stat_statements`
 *
 * `shared_preload_libraries` is empty on this container and the setting is
 * postmaster-context, so enabling the extension needs a restart of an always-on
 * container. `LOAD` and `CREATE EXTENSION` both *succeed* and then every
 * function errors with "must be loaded via shared_preload_libraries" — a trap
 * that looks like it works. It is also structurally weaker: an aggregate keyed
 * by normalized query text has no ordering, no backend identity and no
 * transaction grouping, so it cannot answer "did these two statements run in one
 * transaction", which is half of what this oracle exists for.
 *
 * ## What is deliberately *not* recorded
 *
 * No SQL text. No bind parameter values. No durations. No costs. No pids and no
 * vxids.
 *
 * The privacy half of that is not theoretical. `log_parameter_max_length=0`
 * suppresses `DETAIL: parameters:`, and `auto_explain.log_parameter_max_length=0`
 * suppresses `Query Parameters:`, but Postgres still inlines bind values into
 * plan quals — a real capture of this project's own schema produced
 * `Filter: ("forUserId" = 'u1'::text)` with both settings at 0. So the rule here
 * is not "filter the text", it is "the artefact has no text-shaped field at all":
 * a statement reduces to kind, protocol, relations, row counts and plan node
 * types, and there is nowhere for a value to land.
 *
 * The stability half is the same argument the README makes about ids. A pid
 * changes every run; a vxid changes every transaction. Both are labelled
 * structurally instead.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Sentinel text that delimits one step's window. Never reaches a golden. */
export const MARK_PREFIX = 'mwf_trace_mark:';

/** `application_name` the app under test connects with — see `driver.ts`. */
export const APP_UNDER_TEST = 'mwf-app-under-test';
/** `application_name` for the harness's own (muted) connections — see `db.ts`. */
export const HARNESS_APP = 'mwf-golden-harness';
/** `application_name` for the unmuted connection that writes the sentinels. */
export const MARKER_APP = 'mwf-golden-marker';

// ============================================================================
// Layer 1 — the log line format
// ============================================================================

export interface LogRecord {
  /** `2026-08-17 22:20:20.860 UTC`, kept only for ordering and diagnostics. */
  timestamp: string;
  pid: string;
  database: string;
  application: string;
  /** Virtual transaction id, `%v`: `<backendId>/<localXid>`. */
  vxid: string;
  /** Real transaction id, `%x`. Stays 0 until a write assigns one. */
  xid: string;
  severity: string;
  /** The first line after `SEVERITY:  `. */
  message: string;
  /** Tab-continuation lines, in order, with the leading tab removed. */
  detail: string[];
}

/**
 * A line that starts a record. The `db=…` group is optional on purpose:
 * `log_line_prefix` is SIGHUP-scope and set once for the whole server, so a
 * container that has been up for days carries megabytes of `%m [%p] ` lines
 * above the window, and the checkpointer keeps emitting them with empty fields.
 * Failing to parse those would shove them into the previous record's detail.
 */
const PREFIX_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ \S+) \[(\d+)\](?: db=([^,]*),app=([^,]*),vxid=([^,]*),xid=(\S*))? (\w+):\s{2}([\s\S]*)$/;

/** journald rate limiting announces itself; see `extractWindow`. */
const SUPPRESSED_RE = /Suppressed \d+ messages/;

/**
 * Split a raw `podman logs` capture into records.
 *
 * Continuation lines start with a tab and belong to the record above them —
 * that is the whole reason a plan can be read at all, since auto_explain emits
 * one `LOG:` line and then the plan tree as tab-indented continuations.
 *
 * `DETAIL: parameters:` records are dropped here rather than filtered later.
 * The capture settings already suppress them; this is the second layer, so that
 * a future change to those settings cannot walk a bind value into a golden.
 */
export function parsePostgresLog(raw: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('\t')) {
      const last = records[records.length - 1];
      if (last) last.detail.push(line.slice(1));
      continue;
    }
    const m = PREFIX_RE.exec(line);
    if (!m) continue;
    const [, timestamp, pid, database, application, vxid, xid, severity, message] = m;
    if (severity === 'DETAIL' && /^parameters:/i.test(message)) continue;
    records.push({
      timestamp,
      pid,
      database: database ?? '',
      application: application ?? '',
      vxid: vxid ?? '',
      xid: xid ?? '',
      severity,
      message,
      detail: [],
    });
  }
  return records;
}

// ============================================================================
// Layer 2 — statements and their plans
// ============================================================================

export type StatementKind =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'MERGE'
  | 'BEGIN'
  | 'COMMIT'
  | 'ROLLBACK'
  | 'SET_TX'
  | 'SET'
  | 'DDL'
  | 'other';

export interface TracedStatement {
  pid: string;
  vxid: string;
  /** `'0'` until a write assigns a real transaction id. */
  xid: string;
  protocol: 'simple' | 'extended';
  kind: StatementKind;
  /** Isolation level, present only on `SET_TX`. */
  isolation: string | null;
  /** Tables the plan touched, sorted. Indexes and functions are not tables. */
  relations: string[];
  /** `Actual Rows` on the plan's root node — the dropped-LIMIT discriminator. */
  topRows: number | null;
  /**
   * Relation scanned by the plan's *root* node, when the root is a scan at all.
   * Internal: never emitted. It exists so an unasserted relation can suppress
   * `topRows` only when the root node is that scan itself, and not when a
   * `Limit` above it happens to report the same number.
   */
  rootRelation: string | null;
  /** Rows read per relation, weighted by `loops` so an N+1 shows its true cost. */
  rowsRead: Record<string, number>;
  /** Plan node types in printed order. A vanished `Limit` is visible here. */
  planNodes: string[];
}

/** `LOG:  statement: …` (simple protocol) or `LOG:  execute <name>: …` (extended). */
const STATEMENT_RE = /^statement:\s([\s\S]*)$/;
const EXECUTE_RE = /^execute (?:<unnamed>|[^:]*):\s([\s\S]*)$/;
const PLAN_RE = /^duration: [\d.]+ ms {2}plan:$/;

/**
 * A plan node line: optional `->  `, the node description, then `(cost=…)`.
 * Attribute lines (`Filter:`, `Sort Key:`, `Rows Removed by Filter:`) have no
 * `(cost=` and are therefore never read — which is also what keeps inlined bind
 * values out of the artefact.
 */
const NODE_RE = /^\s*(?:->\s+)?(.+?) {2}\(cost=/;
const ACTUAL_RE = /\(actual (?:time=[\d.]+\.\.[\d.]+ )?rows=(\d+) loops=(\d+)\)/;

/**
 * Node types whose `on <name>` names a table.
 *
 * Enumerated rather than inferred because the alternative — "the token after
 * `on`" — silently counts `Bitmap Index Scan on "Message_pkey"` as a table named
 * `Message_pkey` and `Function Scan on generate_series` as a table named
 * `generate_series`, which makes "rows read per relation" mean nothing.
 */
const RELATION_SCANS = new Set([
  'Seq Scan',
  'Parallel Seq Scan',
  'Index Scan',
  'Index Scan Backward',
  'Parallel Index Scan',
  'Index Only Scan',
  'Index Only Scan Backward',
  'Parallel Index Only Scan',
  'Bitmap Heap Scan',
  'Parallel Bitmap Heap Scan',
  'Tid Scan',
  'Tid Range Scan',
  'Sample Scan',
  'Foreign Scan',
]);

/** ModifyTable roots. Their target is a table, but they read no rows. */
const MODIFY_TARGETS = new Set(['Insert', 'Update', 'Delete', 'Merge']);

interface PlanNode {
  type: string;
  relation: string | null;
  rows: number;
  loops: number;
}

function parsePlanNode(line: string): PlanNode | null {
  const m = NODE_RE.exec(line);
  if (!m) return null;
  const description = m[1];

  // `Index Scan using "User_pkey" on "User" u` — the index is between the two.
  const usingOn = /^(.+?) using (?:"(?:[^"]|"")+"|\S+) on (.+)$/.exec(description);
  const plainOn = /^(.+?) on (.+)$/.exec(description);
  const [type, target] = usingOn ? [usingOn[1], usingOn[2]] : plainOn ? [plainOn[1], plainOn[2]] : [description, null];

  let relation: string | null = null;
  if (target && (RELATION_SCANS.has(type) || MODIFY_TARGETS.has(type))) {
    const name = /^("(?:[^"]|"")+"|[^\s]+)/.exec(target)?.[1] ?? '';
    // A schema qualification (`public."Message"`) is noise here; the harness
    // never leaves the `public` schema.
    const unqualified = name.split('.').pop() ?? name;
    relation = unqualified.replace(/^"|"$/g, '').replace(/""/g, '"');
  }

  const actual = ACTUAL_RE.exec(line);
  return {
    type,
    relation,
    // `(never executed)` has no counts at all; it read nothing.
    rows: actual ? Number(actual[1]) : 0,
    loops: actual ? Number(actual[2]) : 0,
  };
}

function kindFromText(sql: string): { kind: StatementKind; isolation: string | null } {
  const s = sql.trim().replace(/^\(+/, '');
  if (/^BEGIN\b|^START TRANSACTION\b/i.test(s)) return { kind: 'BEGIN', isolation: null };
  if (/^COMMIT\b|^END\b/i.test(s)) return { kind: 'COMMIT', isolation: null };
  if (/^ROLLBACK\b/i.test(s)) return { kind: 'ROLLBACK', isolation: null };
  const iso = /^SET\s+TRANSACTION\s+ISOLATION\s+LEVEL\s+([A-Z ]+?)\s*;?\s*$/i.exec(s);
  if (iso) return { kind: 'SET_TX', isolation: iso[1].toUpperCase().replace(/\s+/g, ' ') };
  if (/^SET\b|^RESET\b/i.test(s)) return { kind: 'SET', isolation: null };
  if (/^SELECT\b|^WITH\b|^TABLE\b|^VALUES\b|^SHOW\b/i.test(s)) return { kind: 'SELECT', isolation: null };
  if (/^INSERT\b/i.test(s)) return { kind: 'INSERT', isolation: null };
  if (/^UPDATE\b/i.test(s)) return { kind: 'UPDATE', isolation: null };
  if (/^DELETE\b/i.test(s)) return { kind: 'DELETE', isolation: null };
  if (/^MERGE\b/i.test(s)) return { kind: 'MERGE', isolation: null };
  if (/^(CREATE|ALTER|DROP|TRUNCATE|COMMENT|GRANT|REVOKE)\b/i.test(s)) return { kind: 'DDL', isolation: null };
  return { kind: 'other', isolation: null };
}

export interface BuildTraceOptions {
  /** Only this database's records are kept — a run must not see its neighbours. */
  database: string;
  /** Only this `application_name` is kept. Defaults to the app under test. */
  application?: string;
}

/**
 * Turn records into statements, folding each auto_explain plan into the
 * statement it belongs to.
 *
 * A plan is matched to the statement above it **on the same backend pid**, not
 * by comparing `Query Text`. Text matching would work and would also mean
 * holding SQL text long enough to compare it; pid adjacency is exactly as
 * reliable, because a backend runs one statement at a time.
 *
 * `log_nested_statements=on` can produce more than one plan per statement (a
 * function body). `topRows` then comes from the first plan — the statement's own
 * root — while nodes and rows-read merge across all of them, because the nested
 * work is real cost the statement caused.
 */
export function buildTrace(records: LogRecord[], opts: BuildTraceOptions): TracedStatement[] {
  const application = opts.application ?? APP_UNDER_TEST;
  const statements: TracedStatement[] = [];
  const lastByPid = new Map<string, TracedStatement>();

  for (const r of records) {
    if (r.database !== opts.database || r.application !== application) continue;
    if (r.severity !== 'LOG') continue;

    const simple = STATEMENT_RE.exec(r.message);
    const extended = simple ? null : EXECUTE_RE.exec(r.message);
    if (simple || extended) {
      const sql = (simple ?? extended)![1];
      const { kind, isolation } = kindFromText(sql);
      const stmt: TracedStatement = {
        pid: r.pid,
        vxid: r.vxid,
        xid: r.xid,
        protocol: simple ? 'simple' : 'extended',
        kind,
        isolation,
        relations: [],
        topRows: null,
        rootRelation: null,
        rowsRead: {},
        planNodes: [],
      };
      statements.push(stmt);
      lastByPid.set(r.pid, stmt);
      continue;
    }

    if (!PLAN_RE.test(r.message)) continue;
    const stmt = lastByPid.get(r.pid);
    // A plan with no statement above it means the window opened mid-statement.
    // Dropping it is right: the alternative is attributing cost to whatever
    // statement happens to precede it in an unrelated transaction.
    if (!stmt) continue;

    const firstPlan = stmt.planNodes.length === 0;
    const relations = new Set(stmt.relations);
    for (const line of r.detail) {
      const node = parsePlanNode(line);
      if (!node) continue;
      if (firstPlan && stmt.topRows === null) {
        stmt.topRows = node.rows;
        stmt.rootRelation = node.relation;
      }
      stmt.planNodes.push(node.type);
      if (!node.relation) continue;
      relations.add(node.relation);
      if (RELATION_SCANS.has(node.type)) {
        stmt.rowsRead[node.relation] = (stmt.rowsRead[node.relation] ?? 0) + node.rows * node.loops;
      }
    }
    stmt.relations = [...relations].sort();

    // A `WITH … INSERT` reads as SELECT from its text but is a write. The plan
    // root is the implementation-independent answer, so it wins.
    const root = stmt.planNodes[0];
    if (root && MODIFY_TARGETS.has(root)) {
      stmt.kind = root.toUpperCase() as StatementKind;
    }
  }

  return statements;
}

// ============================================================================
// Layer 3 — transactions
// ============================================================================

export interface TracedTransaction {
  pid: string;
  vxid: string;
  /**
   * True when the client sent a `BEGIN`.
   *
   * Recorded, but **not** a discriminator: Prisma wraps even a bare `updateMany`
   * in its own implicit BEGIN/COMMIT, so a write moved out of an explicit
   * `$transaction` still arrives with a BEGIN. What moves is the *number* of
   * vxid groups and the isolation level.
   */
  explicit: boolean;
  isolation: string | null;
  statements: TracedStatement[];
}

/**
 * Group statements into transactions by virtual transaction id.
 *
 * `%v` is constant for every statement of one transaction and differs between
 * transactions, including between two autocommit statements on the same
 * connection — which is precisely the grouping the escaped `$transaction`
 * mutation changes. Keyed with the pid as well, because a backend slot number is
 * reused after a connection closes.
 */
export function groupTransactions(statements: TracedStatement[]): TracedTransaction[] {
  const byKey = new Map<string, TracedTransaction>();
  const order: TracedTransaction[] = [];

  for (const s of statements) {
    const key = `${s.pid}|${s.vxid}`;
    let tx = byKey.get(key);
    if (!tx) {
      tx = { pid: s.pid, vxid: s.vxid, explicit: false, isolation: null, statements: [] };
      byKey.set(key, tx);
      order.push(tx);
    }
    if (s.kind === 'BEGIN') tx.explicit = true;
    if (s.kind === 'SET_TX' && s.isolation) tx.isolation = s.isolation;
    tx.statements.push(s);
  }

  return order;
}

// ============================================================================
// Layer 4 — the comparable artefact
// ============================================================================

/**
 * What a step's trace must NOT assert, because a concurrent writer makes the
 * value a sample of a race rather than a property of the work.
 *
 * This is deliberately a refusal and not a numeric range. An earlier version
 * declared measured ranges — `connections: [3, 4]` from 18 runs — and it failed
 * on a clean, unmutated tree: a run produced `5`, and the same field also moved
 * under two unrelated mutations. A fitted range on a quantity with no derivable
 * ceiling is worse than no assertion at all, because it fails for reasons a
 * reader cannot distinguish from a regression, and a reader who cannot tell
 * those apart eventually re-records the golden to make the red go away. That is
 * the one failure mode this harness's conventions exist to prevent.
 *
 * So the rule is: if a bound can be *derived*, assert exactly; if it can only be
 * *fitted to a sample*, assert nothing and say why. Nothing in between.
 *
 * Declare the narrowest thing that is genuinely unassertable — a single
 * relation, not a whole step. Every other relation on the same step stays exact.
 * See `empathy-reveal.golden.test.ts` for the only declaration that exists and
 * the measurements behind it.
 */
export interface UnassertedTrace {
  /** Do not assert the count of distinct backend connections. */
  connections?: boolean;
  /** Relations whose read counts must not be asserted on this step. */
  rowCounts?: string[];
}

/**
 * Placeholders. Self-describing on purpose: an unasserted field sitting in a
 * golden must not read as data, and a reader hitting one should learn why
 * without leaving the file.
 */
export const UNASSERTED_CONNECTIONS =
  '<unasserted: pool high-water mark under concurrent background work — 48 runs measured 3-4, ' +
  'then a clean tree produced 5; no ceiling is derivable, so nothing is claimed>';
export const UNASSERTED_ROWS =
  '<unasserted: this step INSERTs into this relation from background work, so every read of it ' +
  'races those inserts and no row count is a property of the work>';

export interface TraceStatementSummary {
  kind: StatementKind;
  protocol: 'simple' | 'extended';
  relations: string[];
  /** A placeholder only where the step declared it unassertable. */
  topRows?: number | string | null;
  /** Per-relation; a placeholder only where the step declared it unassertable. */
  rowsRead?: Record<string, number | string>;
  planNodes: string[];
}

/**
 * One transaction *shape*, with how many times it occurred.
 *
 * Grouped rather than listed because a list is both unstable and unreadable at
 * this size: the `consent as bob` step runs 129 transactions, and a redundant
 * query added or removed would shift a hundred array positions instead of
 * moving one number. Grouped, "a redundant session-membership query was removed"
 * reads as `occurrences: 13 -> 12`, which is exactly the resolution this oracle
 * was asked for.
 */
export interface TraceTransactionShape {
  occurrences: number;
  explicit: boolean;
  isolation: string | null;
  statementCount: number;
  kinds: Record<string, number>;
  statements: TraceStatementSummary[];
}

export interface TraceSummary {
  /** False means the window was empty, truncated or rate-limited. Never a pass. */
  complete: boolean;
  incompleteReason?: string;
  /** Distinct backends the app used, or the placeholder where unassertable. */
  connections: number | string;
  transactions: number;
  statements: number;
  byKind: Record<string, number>;
  /** Rows read per relation, summed. Placeholder per relation where unassertable. */
  rowsRead: Record<string, number | string>;
  /** Transaction shapes, grouped and canonically ordered. */
  shapes: TraceTransactionShape[];
}

function tally(target: Record<string, number>, key: string, n = 1): void {
  target[key] = (target[key] ?? 0) + n;
}

function sortKeys(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Produce the artefact that goes in the golden.
 *
 * Two shaping decisions, both forced by measuring 18 consecutive runs of both
 * scenarios rather than by taste. The raw numbers are in the commit message and
 * the README; the reasoning is here.
 *
 * **No pid, no vxid, and no per-transaction connection label.** The first two
 * are as unstable as a cuid and were never going to be recorded. The third was
 * the plan — `<conn:1>` by order of first appearance — and measurement killed
 * it: any form that attributes a transaction to a connection was unstable on
 * every step where Prisma's pool opened more than one connection (4 distinct
 * results in 6 runs on `session state`, 6 in 6 on `consent as bob`), while the
 * same data with the connection label removed was stable 6/6 everywhere. Which
 * pool slot served a transaction is scheduling, not behaviour. What the oracle
 * actually needs from backend identity — "did these statements run in one
 * transaction" — is the vxid grouping, and that is kept in full. The count of
 * distinct connections is still recorded, because a migration that stops
 * pooling would move it.
 *
 * This is also why there are no `<tx:N>` ordinals. Once shapes are grouped and
 * canonically ordered, an ordinal is just an array index. The README's argument
 * against ordinal ids does not apply here for the reason it applies there: a row
 * id labels an *identity* that must survive reordering, whereas a transaction
 * has no identity beyond the statements in it, which is precisely what is
 * recorded.
 *
 * **What a step refuses to assert is narrowed to one relation, not one step.**
 * The first version discarded the whole `rowsRead` map on any step declaring
 * `asyncBoundary`, which threw away `EmpathyAttempt`, `Session`, `User` and
 * eight other relations that never moved, on the only step in either scenario
 * carrying a write path. The second version replaced that with fitted numeric
 * ranges, and those failed on a clean tree. What survives both corrections is
 * the narrowing, not the fitting.
 *
 * 48 recorded runs (18 + 30) of both scenarios say what moves. On
 * `consent as bob`, and nowhere else:
 *
 *   connections                     4 x45, 3 x3      (and 5 once, off-sample)
 *   rowsRead.Message (rollup)       34 x46, 35 x2
 *   one Message-only Index Scan      0 x46,  1 x2
 *
 * Everything else was identical 48/48: statement count (139), transaction count
 * (129), kinds, isolation, every plan node type, and every other relation —
 * `EmpathyAttempt` 23, `RelationshipMember` 35, `Relationship` 21, `Session` 21,
 * `User` 19, `StageProgress` 8, `UserVessel` 6, `EmpathyDraft` 2, and three
 * zeroes. All 6 steps of `session-read` and the other 7 of `empathy-reveal` were
 * stable 48/48 with nothing declared at all.
 *
 * Both moving quantities are refused rather than ranged, because neither has a
 * ceiling that can be derived:
 *
 *   - `connections` is a pool high-water mark. 48 runs said 3-4 and a clean tree
 *     then produced 5. It also moves under unrelated mutations, so it cannot
 *     separate "the pool scheduled differently" from "a regression added a
 *     query". It is refused on this step and stays exact on every synchronous
 *     step, where it has never moved (48/48).
 *   - `rowsRead.Message` looked tighter — 46/48 at one value, moving by one row
 *     — but the raced statement is a `findMany` with no `LIMIT`, so nothing
 *     syntactically bounds it at one row, and the reveal inserts *two* Message
 *     rows in separate autocommit transactions. 34-35 was a property of the
 *     sample, exactly as 3-4 was. Refused.
 *
 * `EmpathyAttempt` is the control that shows this is not superstition: the
 * reveal writes it too, but only with UPDATE, so its read counts are
 * timing-invariant and stayed at 23 across all 48 runs. The line is INSERT/
 * DELETE (row counts move) versus UPDATE (they cannot).
 *
 * `topRows` is refused only when the unasserted scan *is* the plan root.
 * Validated against all 30 captures in the second sample: the statement that
 * flips is the bare `Index Scan`, while five `Limit -> Index Scan Backward`
 * statements over the same relation are stable at 0 and keep their exact
 * `topRows`. So a `Limit` that stopped limiting is still visible even on the
 * relation this step cannot count.
 */
export function summarize(
  transactions: TracedTransaction[],
  opts: {
    complete: boolean;
    incompleteReason?: string;
    /** What this step cannot assert, and why. */
    unasserted?: UnassertedTrace;
  },
): TraceSummary {
  const unasserted = opts.unasserted ?? {};
  const mutedRelations = new Set(unasserted.rowCounts ?? []);
  const byKind: Record<string, number> = {};
  const rowsRead: Record<string, number> = {};
  const connections = new Set<string>();
  let statements = 0;

  const shaped = transactions.map(tx => {
    connections.add(tx.pid);
    const kinds: Record<string, number> = {};
    for (const s of tx.statements) {
      statements += 1;
      tally(kinds, s.kind);
      tally(byKind, s.kind);
      for (const [rel, n] of Object.entries(s.rowsRead)) tally(rowsRead, rel, n);
    }
    return {
      occurrences: 1,
      explicit: tx.explicit,
      isolation: tx.isolation,
      statementCount: tx.statements.length,
      kinds: sortKeys(kinds),
      statements: tx.statements.map(s => {
        const counts: Record<string, number | string> = {};
        let topRows: number | string | null = s.topRows;
        for (const [rel, n] of Object.entries(s.rowsRead).sort(([a], [b]) => a.localeCompare(b))) {
          const muted = mutedRelations.has(rel);
          counts[rel] = muted ? UNASSERTED_ROWS : n;
          // Only when the unasserted scan *is* the plan root. A `Limit` above it
          // reports the same number and keeps it exact, so a `Limit` that
          // stopped limiting stays visible even here.
          if (muted && s.rootRelation === rel && topRows === n) topRows = UNASSERTED_ROWS;
        }
        return {
          kind: s.kind,
          protocol: s.protocol,
          relations: s.relations,
          topRows,
          rowsRead: counts,
          planNodes: s.planNodes,
        };
      }),
    };
  });

  // Group identical shapes. The key is the shape's own serialization, which is
  // canonical because every field is emitted in a fixed order and every map is
  // key-sorted above.
  const grouped = new Map<string, TraceTransactionShape>();
  for (const shape of shaped) {
    const key = JSON.stringify({ ...shape, occurrences: 0 });
    const seen = grouped.get(key);
    if (seen) seen.occurrences += 1;
    else grouped.set(key, shape);
  }
  const shapes = [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);

  return {
    complete: opts.complete,
    ...(opts.incompleteReason ? { incompleteReason: opts.incompleteReason } : {}),
    connections: unasserted.connections ? UNASSERTED_CONNECTIONS : connections.size,
    transactions: transactions.length,
    statements,
    byKind: sortKeys(byKind),
    rowsRead: Object.fromEntries(
      Object.entries(sortKeys(rowsRead)).map(([rel, n]) => [rel, mutedRelations.has(rel) ? UNASSERTED_ROWS : n]),
    ),
    shapes,
  };
}

// ============================================================================
// Layer 5 — windowing and reading
// ============================================================================

export interface WindowResult {
  records: LogRecord[];
  complete: boolean;
  incompleteReason?: string;
}

/**
 * Slice the records between this step's two sentinels.
 *
 * Wall-clock `--since` alone is not safe: the container's clock is the podman
 * VM's, not the host's, and the two drift. Sentinels are exact — a statement is
 * inside the window if and only if it was logged between the two marks.
 *
 * Every failure mode returns `complete: false` rather than a shorter trace. A
 * truncated window and a cheaper query produce the same smaller numbers, and
 * this harness has already been burned once by a timeout that looked identical
 * to success (see `settled` in `driver.ts`).
 */
export function extractWindow(records: LogRecord[], opts: { beginToken: string; endToken: string }): WindowResult {
  const indexOfMark = (token: string): number[] => {
    const at: number[] = [];
    records.forEach((r, i) => {
      if (r.message.includes(`${MARK_PREFIX}${token}`)) at.push(i);
    });
    return at;
  };

  const begins = indexOfMark(opts.beginToken);
  const ends = indexOfMark(opts.endToken);

  if (begins.length === 0) {
    return { records: [], complete: false, incompleteReason: 'begin marker not found in the log read' };
  }
  if (ends.length === 0) {
    return { records: [], complete: false, incompleteReason: 'end marker not found in the log read' };
  }
  if (begins.length > 1 || ends.length > 1) {
    return {
      records: [],
      complete: false,
      incompleteReason: `sentinel appeared twice (begin x${begins.length}, end x${ends.length}) — the window is ambiguous`,
    };
  }
  if (ends[0] < begins[0]) {
    return { records: [], complete: false, incompleteReason: 'end marker precedes the begin marker' };
  }

  const window = records.slice(begins[0] + 1, ends[0]);
  const suppressed = window.find(r => SUPPRESSED_RE.test(r.message));
  if (suppressed) {
    return {
      records: window,
      complete: false,
      incompleteReason: `journald rate-limited inside the window: ${suppressed.message}`,
    };
  }
  return { records: window, complete: true };
}

/**
 * Source of raw Postgres log text.
 *
 * An interface because CI will not be reading a podman container. Any
 * implementation MUST return stdout **and** stderr: Postgres logs to stderr and
 * `podman logs` passes that through to its own stderr, so a stdout-only reader
 * yields an empty trace and a silently passing suite. That cost the capture
 * spike an entire run.
 */
export interface LogReader {
  read(sinceSeconds: number): Promise<string>;
  describe(): string;
}

export function podmanLogReader(container: string, bin = 'podman'): LogReader {
  return {
    describe: () => `${bin} logs ${container}`,
    async read(sinceSeconds: number): Promise<string> {
      const { stdout, stderr } = await execFileAsync(
        bin,
        ['logs', '--since', `${Math.max(1, Math.ceil(sinceSeconds))}s`, container],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      // Concatenated, not interleaved. Postgres writes only to stderr, so in
      // practice stdout is empty; if a future image splits the streams this
      // ordering assumption is the first thing to revisit.
      return stdout + stderr;
    },
  };
}

export interface CaptureOptions {
  reader: LogReader;
  database: string;
  application?: string;
  beginToken: string;
  endToken: string;
  /** Seconds of history to ask for on the first attempt. */
  sinceSeconds: number;
  /** What this step cannot assert, and why; see `UnassertedTrace`. */
  unasserted?: UnassertedTrace;
  /** Bounded — never poll without a ceiling. Defaults match the capture spike. */
  attempts?: number;
  intervalMs?: number;
}

/**
 * Read, window and summarize one step's trace.
 *
 * The end marker is written by the caller before this runs, but `podman logs`
 * can lag the write by a few hundred milliseconds. Polling is bounded at
 * `attempts` (10 x 400ms by default, the figure the spike settled on) and each
 * retry also widens the history window, because the other way to miss the begin
 * marker is host/VM clock skew making `--since` too tight.
 */
export async function captureWindow(opts: CaptureOptions): Promise<TraceSummary> {
  const attempts = opts.attempts ?? 10;
  const intervalMs = opts.intervalMs ?? 400;
  let last: WindowResult = { records: [], complete: false, incompleteReason: 'never read' };

  for (let i = 0; i < attempts; i++) {
    // Widen on every retry: a too-tight `--since` and a lagging write are
    // indistinguishable from here, and widening fixes both.
    const raw = await opts.reader.read(opts.sinceSeconds + 10 + i * 10);
    last = extractWindow(parsePostgresLog(raw), opts);
    if (last.complete) break;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }

  if (!last.complete) {
    return summarize([], {
      complete: false,
      incompleteReason: `${last.incompleteReason} (after ${attempts} reads of ${opts.reader.describe()})`,
    });
  }

  const statements = buildTrace(last.records, { database: opts.database, application: opts.application });
  // An empty window is a hard failure, not a quiet step. Every step here drives
  // an HTTP endpoint that reaches Postgres; zero statements means the capture
  // settings did not apply to the app's connections, which is the exact shape of
  // a false pass this oracle exists to prevent.
  if (statements.length === 0) {
    return summarize([], {
      complete: false,
      incompleteReason:
        'window contained no statements from the application under test — capture is not reaching the app connections',
    });
  }
  return summarize(groupTransactions(statements), { complete: true, unasserted: opts.unasserted });
}
