/**
 * Golden harness — database administration.
 *
 * Deliberately uses `pg` directly, never Prisma. The oracle must not depend on
 * the implementation it is testing: if snapshots went through Prisma, a Prisma
 * bug would be invisible because both the recording and the replay would share
 * it.
 *
 * Everything here is schema-derived. No table lists are hand-maintained —
 * `backend/snapshots/create-snapshot.ts` enumerates 41 tables against a 68-model
 * schema, and that drift is exactly the kind of silent gap this harness exists
 * to catch.
 */

import { Client, ClientConfig } from 'pg';
import { HARNESS_APP, MARKER_APP, MARK_PREFIX } from './trace';

export interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Parse a postgres:// URL into connection parts. */
export function parseDbUrl(url: string): DbTarget {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1).split('?')[0],
  };
}

export function toDbUrl(t: DbTarget): string {
  const auth = `${encodeURIComponent(t.user)}:${encodeURIComponent(t.password)}`;
  return `postgresql://${auth}@${t.host}:${t.port}/${t.database}`;
}

function clientConfig(t: DbTarget, database = t.database, application = HARNESS_APP): ClientConfig {
  // Tagging the harness's own connections is what lets the statement trace keep
  // only the application under test. Without it the oracle would be reading
  // mostly its own snapshots back.
  return { host: t.host, port: t.port, user: t.user, password: t.password, database, application_name: application };
}

/**
 * Silence this connection in the Postgres log, immediately after connecting.
 *
 * This is not an optimisation. `empathy-reveal` snapshots the whole database —
 * ~68 SELECTs per snapshot — and `settle()` takes up to 50 of them per step, so
 * an unmuted harness emits thousands of statements per step. Measured with
 * capture on and no muting: journald rate-limited (`Suppressed 35097 messages`),
 * 3000 statements arrived as 1562, and the end marker was lost. Filtering by
 * `application_name` afterwards does not help, because the journald budget is
 * spent before anything is filtered.
 *
 * Both settings are session-scope overrides of the per-database values.
 * `auto_explain.log_min_duration` is settable even on a database where
 * auto_explain was never loaded — Postgres accepts a dotted name as a
 * placeholder GUC — so this needs no knowledge of whether capture is on.
 *
 * Sent as one simple-protocol query: `withClient` is called several times per
 * snapshot and per settle poll, and a round trip each would be felt.
 */
async function muteConnection(client: Client): Promise<void> {
  await client
    .query(`SET log_statement = 'none'; SET auto_explain.log_min_duration = -1;`)
    // A non-superuser cannot set `log_statement` (PGC_SUSET). That is only a
    // problem when capture is on, and `enableStatementCapture` refuses to turn
    // capture on without superuser, so failing quietly here cannot hide a
    // rate-limited trace.
    .catch(() => undefined);
}

/** Run a function against a connected client, always closing it. */
export async function withClient<T>(t: DbTarget, fn: (c: Client) => Promise<T>, database?: string): Promise<T> {
  const client = new Client(clientConfig(t, database));
  await client.connect();
  try {
    await muteConnection(client);
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Administrative operations connect to `postgres`, not the target database —
 * you cannot DROP or use as TEMPLATE a database you are connected to.
 */
async function withAdmin<T>(t: DbTarget, fn: (c: Client) => Promise<T>): Promise<T> {
  return withClient(t, fn, 'postgres');
}

/** Terminate other sessions on a database so it can be dropped or cloned. */
export async function disconnectAll(t: DbTarget, database: string): Promise<void> {
  await withAdmin(t, async c => {
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
  });
}

export async function databaseExists(t: DbTarget, database: string): Promise<boolean> {
  return withAdmin(t, async c => {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    return r.rowCount === 1;
  });
}

export async function dropDatabase(t: DbTarget, database: string): Promise<void> {
  await disconnectAll(t, database);
  await withAdmin(t, async c => {
    // Templates cannot be dropped until the flag is cleared.
    await c.query(`ALTER DATABASE "${database}" WITH is_template = false`).catch(() => undefined);
    await c.query(`DROP DATABASE IF EXISTS "${database}"`);
  });
}

export async function createDatabase(t: DbTarget, database: string): Promise<void> {
  await withAdmin(t, async c => {
    await c.query(`CREATE DATABASE "${database}"`);
  });
}

/**
 * Clone a database from a template. Requires no open connections to the
 * template, which is why callers must not hold one.
 */
export async function cloneDatabase(t: DbTarget, template: string, target: string): Promise<void> {
  await dropDatabase(t, target);
  await disconnectAll(t, template);
  await withAdmin(t, async c => {
    await c.query(`CREATE DATABASE "${target}" TEMPLATE "${template}"`);
  });
}

// ============================================================================
// Statement capture — see `trace.ts` for what is done with the log
// ============================================================================

/**
 * The prefix the trace parser needs: database, application, virtual xid, xid.
 *
 * `%v` is the load-bearing one. It is constant across every statement of one
 * transaction and differs between transactions, which is the only way to answer
 * "did these two statements run together" — and answering that is half of why
 * this oracle exists.
 */
export const REQUIRED_LOG_LINE_PREFIX = '%m [%p] db=%d,app=%a,vxid=%v,xid=%x ';

/**
 * auto_explain, loaded per-database with no server restart.
 *
 * `session_preload_libraries` is the only per-database way in:
 * `shared_preload_libraries` is postmaster-context and empty on this container,
 * and changing it means restarting an always-on service.
 *
 * FOOTGUN, verified: this setting takes ONE library. `ALTER DATABASE … SET
 * session_preload_libraries = 'auto_explain,pg_stat_statements'` is *accepted*,
 * and then every new connection to that database dies with
 * `FATAL: could not access file` — you cannot even connect to undo it. Hence the
 * assertion below rather than a comment.
 */
const PRELOAD_LIBRARY = 'auto_explain';

/**
 * Per-database capture settings.
 *
 * All are `ALTER DATABASE`, so they apply only to connections opened afterwards,
 * never leak to another database, and disappear with `DROP DATABASE` — which
 * matters because every run database is disposable and nothing here needs
 * cleaning up.
 *
 * The two parameter-length settings are the privacy boundary. `0` means "log the
 * parameter list as empty", not "truncate to 0 characters of a value we
 * assembled anyway". There are two of them because they are different subsystems:
 * `log_parameter_max_length` governs `DETAIL: parameters:` on the statement log
 * and `auto_explain.log_parameter_max_length` governs `Query Parameters:` inside
 * the plan. Setting only the first leaves the second wide open — verified: with
 * `log_parameter_max_length=0` alone, a capture of this container emitted
 * `Query Parameters: $1 = 'nope', $2 = '5'`.
 */
const CAPTURE_SETTINGS: Array<[string, string]> = [
  // Plan shape must not depend on how many times a pooled connection happens to
  // have run a statement. Measured: Prisma issues NAMED prepared statements
  // (`execute s16: …`), and Postgres switches a named statement from a custom
  // plan to a generic plan on its sixth execution. Prisma's `findMany` emits
  // `… WHERE "id" IN ($1) OFFSET $2` with `$2 = 0`; a custom plan knows the
  // offset is zero and elides the `Limit` node, a generic plan cannot and keeps
  // it. Which pooled connection serves a request decides which side of the
  // sixth execution it lands on, so the same query recorded `["Limit","Index
  // Scan"]` in one run and `["Index Scan"]` in the next — 6 runs produced 4
  // distinct traces for one step, with identical rows read either way.
  //
  // Verified in isolation: executions 1-5 of `SELECT … OFFSET $2` have no Limit
  // node, execution 6 onwards has one.
  //
  // Forcing custom plans removes the coin flip rather than banding the artefact
  // away, which keeps `planNodes` exact and therefore keeps "the Limit node
  // disappeared" as a real second signal for a dropped `take`. It is applied to
  // recording and replay alike, so it cannot bias a differential comparison.
  ['plan_cache_mode', `'force_custom_plan'`],
  ['log_statement', `'all'`],
  ['log_parameter_max_length', '0'],
  ['log_parameter_max_length_on_error', '0'],
  ['session_preload_libraries', `'${PRELOAD_LIBRARY}'`],
  // Plans for everything. `Actual Rows` per node is the only
  // implementation-independent way to see a dropped LIMIT.
  ['auto_explain.log_min_duration', '0'],
  ['auto_explain.log_analyze', 'on'],
  // Timings are noise in a golden and cost real overhead to collect.
  ['auto_explain.log_timing', 'off'],
  // Text, not JSON: measured at 7 journal entries per statement against 24 for
  // JSON, and journald's budget is the binding constraint on this whole design.
  ['auto_explain.log_format', `'text'`],
  ['auto_explain.log_nested_statements', 'on'],
  ['auto_explain.log_parameter_max_length', '0'],
];

async function isSuperuser(t: DbTarget, database?: string): Promise<boolean> {
  return withClient(
    t,
    async c => {
      const r = await c.query<{ super: string }>(`SELECT current_setting('is_superuser') AS super`);
      return r.rows[0]?.super === 'on';
    },
    database,
  );
}

/**
 * Set `log_line_prefix` once, server-wide, and leave it.
 *
 * It is `PGC_SIGHUP`, so `ALTER DATABASE … SET log_line_prefix` fails outright
 * with `ERROR: parameter "log_line_prefix" cannot be changed now`. Server-wide
 * or nothing.
 *
 * It is deliberately **not restored** afterwards. Set-and-restore-per-run races:
 * one worker's restore lands while another still needs the prefix, and the
 * second worker's trace silently loses its `db=`/`vxid=` fields — which reads as
 * an empty window, not as an error. It is a formatting-only change to a
 * development container, so the cost of leaving it is a differently-shaped log
 * line and a line in `postgresql.auto.conf`. Both are documented in
 * `docs/development/local-setup.md`.
 */
export async function ensureLogLinePrefix(t: DbTarget): Promise<{ changed: boolean }> {
  const current = await withClient(
    t,
    async c => (await c.query<{ p: string }>(`SELECT current_setting('log_line_prefix') AS p`)).rows[0]?.p ?? '',
    'postgres',
  );
  if (current === REQUIRED_LOG_LINE_PREFIX) return { changed: false };

  if (!(await isSuperuser(t, 'postgres'))) {
    throw new Error(
      `SQL trace capture needs log_line_prefix = ${JSON.stringify(REQUIRED_LOG_LINE_PREFIX)} but it is ` +
        `${JSON.stringify(current)}, and role "${t.user}" is not a superuser so it cannot be changed.\n` +
        `Either grant superuser locally, or set it in postgresql.conf and reload:\n` +
        `    log_line_prefix = '${REQUIRED_LOG_LINE_PREFIX}'`,
    );
  }

  await withClient(
    t,
    async c => {
      // ALTER SYSTEM takes no bind parameters. The value is a module constant,
      // never caller input.
      await c.query(`ALTER SYSTEM SET log_line_prefix = '${REQUIRED_LOG_LINE_PREFIX.replace(/'/g, "''")}'`);
      await c.query(`SELECT pg_reload_conf()`);
    },
    'postgres',
  );

  // A reload is asynchronous. Bounded, because an unbounded wait on a config
  // that will never arrive is the failure mode that looks like a hang.
  for (let i = 0; i < 20; i++) {
    const now = await withClient(
      t,
      async c => (await c.query<{ p: string }>(`SELECT current_setting('log_line_prefix') AS p`)).rows[0]?.p ?? '',
      'postgres',
    );
    if (now === REQUIRED_LOG_LINE_PREFIX) return { changed: true };
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(
    `log_line_prefix did not take effect within 2s after ALTER SYSTEM + pg_reload_conf(). ` +
      `Something else may be managing postgresql.auto.conf.`,
  );
}

/**
 * Turn on statement + plan capture for one run database. Idempotent.
 *
 * Applies only to connections opened after it returns, which is the ordering
 * constraint the driver has to respect: capture before `import('../../app')`,
 * for the same reason `DATABASE_URL` has to be set before it.
 */
export async function enableStatementCapture(t: DbTarget, database: string): Promise<void> {
  if (PRELOAD_LIBRARY.includes(',')) {
    throw new Error(
      `session_preload_libraries takes exactly one library. A comma-separated list is accepted by ` +
        `ALTER DATABASE and then makes the database unreachable: every new connection dies with ` +
        `FATAL: could not access file.`,
    );
  }

  if (!(await isSuperuser(t, 'postgres'))) {
    throw new Error(
      `SQL trace capture needs a superuser: log_statement and session_preload_libraries are both ` +
        `restricted settings, and role "${t.user}" is not one.\n` +
        `Locally: ALTER ROLE "${t.user}" SUPERUSER;  — or run the scenario without a trace.`,
    );
  }

  await withClient(
    t,
    async c => {
      for (const [param, value] of CAPTURE_SETTINGS) {
        // Values are literals from the constant above, never caller input;
        // ALTER DATABASE … SET does not accept bind parameters.
        await c.query(`ALTER DATABASE "${database}" SET ${param} = ${value}`);
      }
    },
    'postgres',
  );
}

/**
 * A connection that is *not* muted, used only to write window sentinels.
 *
 * auto_explain is still turned off on it: a marker needs to appear in the log as
 * one statement, and a plan for `SELECT 'literal'` is three more journal entries
 * of nothing.
 */
export async function openMarkerClient(t: DbTarget, database: string): Promise<Client> {
  const client = new Client(clientConfig(t, database, MARKER_APP));
  await client.connect();
  await client.query(`SET auto_explain.log_min_duration = -1`).catch(() => undefined);
  return client;
}

/**
 * Write one sentinel into the log.
 *
 * A trivial statement, because the point is the *position* of the line, not what
 * it does. Wall-clock `--since` cannot delimit a window on its own: the
 * container's clock is the podman VM's and drifts against the host's.
 */
export async function mark(client: Client, token: string): Promise<void> {
  // Inlined rather than bound, because a bound parameter turns the marker into
  // an extended-protocol `execute <unnamed>: SELECT $1` whose token is only in
  // the (suppressed) parameter list — the marker would be unfindable in the log.
  // Restricted to a token alphabet so that inlining cannot become injection.
  if (!/^[a-z0-9_]+$/i.test(token)) throw new Error(`Trace marker token must be [A-Za-z0-9_]+, got: ${token}`);
  await client.query(`SELECT '${MARK_PREFIX}${token}' AS mark`);
}

// ============================================================================
// Schema introspection — every list is derived, never hand-maintained
// ============================================================================

/** All base tables in `public`, excluding Prisma's own migration bookkeeping. */
export async function listTables(t: DbTarget, database?: string): Promise<string[]> {
  return withClient(
    t,
    async c => {
      const r = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           AND table_name <> '_prisma_migrations'
         ORDER BY table_name`,
      );
      return r.rows.map(x => x.table_name);
    },
    database,
  );
}

/** Column names per table, ordered — used to build stable SELECT lists. */
export async function listColumns(t: DbTarget, database?: string): Promise<Map<string, string[]>> {
  return withClient(
    t,
    async c => {
      const r = await c.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'
         ORDER BY table_name, ordinal_position`,
      );
      const m = new Map<string, string[]>();
      for (const row of r.rows) {
        const cols = m.get(row.table_name) ?? [];
        cols.push(row.column_name);
        m.set(row.table_name, cols);
      }
      return m;
    },
    database,
  );
}

/**
 * Every timestamp column in the schema, for fixture rebasing.
 *
 * Fixtures age: `state-factory.ts` writes `Invitation.expiresAt = now + 7d`, and
 * `middleware/auth.ts` gates session access on `expiresAt > now()`. Eight days
 * after a fixture is cut that predicate flips and the scenario silently changes
 * meaning. Shifting every timestamp on restore keeps a fixture the same relative
 * age forever.
 */
export async function listTimestampColumns(
  t: DbTarget,
  database?: string,
): Promise<Array<{ table: string; column: string; nullable: boolean }>> {
  return withClient(
    t,
    async c => {
      const r = await c.query<{ table_name: string; column_name: string; is_nullable: string }>(
        `SELECT c.table_name, c.column_name, c.is_nullable
         FROM information_schema.columns c
         JOIN information_schema.tables tb
           ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
         WHERE c.table_schema = 'public'
           AND tb.table_type = 'BASE TABLE'
           AND c.table_name <> '_prisma_migrations'
           AND c.data_type LIKE 'timestamp%'
         ORDER BY c.table_name, c.column_name`,
      );
      return r.rows.map(x => ({
        table: x.table_name,
        column: x.column_name,
        nullable: x.is_nullable === 'YES',
      }));
    },
    database,
  );
}

/**
 * Shift every timestamp in the database by `intervalSql` (e.g. `'3 days'`).
 * Generated from `information_schema`, so new columns are picked up automatically.
 */
export async function rebaseTimestamps(
  t: DbTarget,
  database: string,
  intervalSql: string,
): Promise<{ statements: number }> {
  const cols = await listTimestampColumns(t, database);
  const byTable = new Map<string, string[]>();
  for (const { table, column } of cols) {
    byTable.set(table, [...(byTable.get(table) ?? []), column]);
  }

  return withClient(
    t,
    async c => {
      let statements = 0;
      for (const [table, columns] of byTable) {
        const sets = columns.map(col => `"${col}" = "${col}" + $1::interval`).join(', ');
        await c.query(`UPDATE "${table}" SET ${sets}`, [intervalSql]);
        statements += 1;
      }
      return { statements };
    },
    database,
  );
}

/**
 * Shift ISO-8601 timestamps embedded inside `json`/`jsonb` columns.
 *
 * `rebaseTimestamps` only moves the 144 timestamp *columns*. Timestamps
 * serialized into the 17 Json columns stayed at their seed-time values, so their
 * offset from every rebased column grew by an hour every hour. This is not
 * hypothetical: `StageProgress.gatesSatisfied->>'feelHeardConfirmedAt'` drifted
 * to 16 hours old against 1-hour-old columns and broke the scenario — the exact
 * silent-aging failure the rebase exists to prevent, reintroduced through jsonb.
 *
 * Parsing these in JavaScript is safe *here specifically*, unlike the naive
 * `timestamp` columns: JSON values are written as ISO-8601 with an explicit `Z`,
 * so there is no timezone ambiguity to get wrong.
 */
export async function rebaseJsonTimestamps(
  t: DbTarget,
  database: string,
  shiftSeconds: number,
): Promise<{ rowsUpdated: number }> {
  const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

  const shiftValue = (v: unknown): unknown => {
    if (typeof v === 'string' && ISO_Z.test(v)) {
      return new Date(new Date(v).getTime() + shiftSeconds * 1000).toISOString();
    }
    if (Array.isArray(v)) return v.map(shiftValue);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = shiftValue(val);
      return out;
    }
    return v;
  };

  return withClient(
    t,
    async c => {
      const cols = await c.query<{ table_name: string; column_name: string }>(
        `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables tb
           ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
         WHERE c.table_schema = 'public'
           AND tb.table_type = 'BASE TABLE'
           AND c.table_name <> '_prisma_migrations'
           AND c.data_type IN ('json', 'jsonb')`,
      );

      let rowsUpdated = 0;
      for (const { table_name: table, column_name: col } of cols.rows) {
        // ctid addresses a row without needing to know the primary key, which
        // keeps this generic across composite-PK and PK-less tables alike.
        const rows = await c.query<{ ctid: string; v: unknown }>(
          `SELECT ctid::text AS ctid, "${col}" AS v FROM "${table}" WHERE "${col}" IS NOT NULL`,
        );
        for (const row of rows.rows) {
          const shifted = shiftValue(row.v);
          if (JSON.stringify(shifted) === JSON.stringify(row.v)) continue;
          await c.query(`UPDATE "${table}" SET "${col}" = $1::jsonb WHERE ctid = $2::tid`, [
            JSON.stringify(shifted),
            row.ctid,
          ]);
          rowsUpdated += 1;
        }
      }
      return { rowsUpdated };
    },
    database,
  );
}

/** Row counts for every table — a cheap shape check on a restored fixture. */
export async function tableCounts(t: DbTarget, database?: string): Promise<Record<string, number>> {
  const tables = await listTables(t, database);
  return withClient(
    t,
    async c => {
      const out: Record<string, number> = {};
      for (const table of tables) {
        const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
        const n = Number(r.rows[0].n);
        if (n > 0) out[table] = n;
      }
      return out;
    },
    database,
  );
}
