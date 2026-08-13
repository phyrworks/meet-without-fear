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

function clientConfig(t: DbTarget, database = t.database): ClientConfig {
  return { host: t.host, port: t.port, user: t.user, password: t.password, database };
}

/** Run a function against a connected client, always closing it. */
export async function withClient<T>(t: DbTarget, fn: (c: Client) => Promise<T>, database?: string): Promise<T> {
  const client = new Client(clientConfig(t, database));
  await client.connect();
  try {
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
