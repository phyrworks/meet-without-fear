/**
 * Golden harness — scoped database snapshots.
 *
 * A snapshot is the full contents of a declared set of tables, in a
 * deterministic order, with every value rendered in a form that survives a
 * round trip through JSON without losing or corrupting meaning.
 *
 * Two rules earn their place here:
 *
 * 1. **Timestamps are selected as text.** All 144 timestamp columns in this
 *    schema are `timestamp without time zone`, and `node-postgres` parses OID
 *    1114 into a `Date` using the process timezone while Prisma writes UTC.
 *    Letting JS parse them introduced an error exactly equal to the local UTC
 *    offset. Casting in SQL removes the ambiguity entirely.
 * 2. **Ordering is explicit.** Postgres gives no row order without ORDER BY, and
 *    heap order drifts after any UPDATE or autovacuum. Snapshots order by primary
 *    key so a diff reflects data, not physical layout.
 */

import { DbTarget, withClient } from './db';

export type SnapshotRow = Record<string, unknown>;
export type TableSnapshot = SnapshotRow[];
export interface Snapshot {
  tables: Record<string, TableSnapshot>;
  takenAt: string;
}

interface ColumnMeta {
  column: string;
  dataType: string;
  udtName: string;
}

/** Column metadata for the tables we intend to snapshot. */
async function columnsFor(
  target: DbTarget,
  database: string,
  tables: string[]
): Promise<Map<string, ColumnMeta[]>> {
  return withClient(
    target,
    async (c) => {
      const r = await c.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        udt_name: string;
      }>(
        `SELECT table_name, column_name, data_type, udt_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ANY($1)
         ORDER BY table_name, ordinal_position`,
        [tables]
      );
      const m = new Map<string, ColumnMeta[]>();
      for (const row of r.rows) {
        const list = m.get(row.table_name) ?? [];
        list.push({ column: row.column_name, dataType: row.data_type, udtName: row.udt_name });
        m.set(row.table_name, list);
      }
      return m;
    },
    database
  );
}

/** Primary key columns per table, for deterministic ordering. */
async function primaryKeysFor(
  target: DbTarget,
  database: string,
  tables: string[]
): Promise<Map<string, string[]>> {
  return withClient(
    target,
    async (c) => {
      const r = await c.query<{ table_name: string; column_name: string; ord: number }>(
        `SELECT t.relname AS table_name, a.attname AS column_name, k.ord
         FROM pg_constraint con
         JOIN pg_class t ON t.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         WHERE n.nspname = 'public' AND con.contype = 'p' AND t.relname = ANY($1)
         ORDER BY t.relname, k.ord`,
        [tables]
      );
      const m = new Map<string, string[]>();
      for (const row of r.rows) {
        m.set(row.table_name, [...(m.get(row.table_name) ?? []), row.column_name]);
      }
      return m;
    },
    database
  );
}

/**
 * Build the SELECT list for one table.
 *
 * - timestamps  -> `::text` (see the header note on OID 1114)
 * - pgvector    -> dimension count only; Prisma cannot select these at all, so a
 *                  hand-written `SELECT *` would otherwise introduce a phantom diff
 * - everything else passes through; `pg` already returns json/jsonb parsed
 */
function selectList(cols: ColumnMeta[]): string {
  return cols
    .map((c) => {
      const q = `"${c.column}"`;
      if (c.dataType.startsWith('timestamp')) return `${q}::text AS ${q}`;
      if (c.udtName === 'vector') return `(CASE WHEN ${q} IS NULL THEN NULL ELSE 'vector(' || array_length(${q}::real[], 1) || ')' END) AS ${q}`;
      if (c.dataType === 'ARRAY') return q;
      return q;
    })
    .join(', ');
}

export interface SnapshotOptions {
  target: DbTarget;
  database: string;
  /** Tables in scope. Declaring scope keeps unrelated background writes out of the diff. */
  tables: string[];
}

export async function takeSnapshot(opts: SnapshotOptions): Promise<Snapshot> {
  const { target, database, tables } = opts;
  const colMap = await columnsFor(target, database, tables);
  const pkMap = await primaryKeysFor(target, database, tables);

  const missing = tables.filter((t) => !colMap.has(t));
  if (missing.length) {
    throw new Error(`Snapshot requested unknown table(s): ${missing.join(', ')}`);
  }

  return withClient(
    target,
    async (c) => {
      const out: Record<string, TableSnapshot> = {};
      for (const table of tables) {
        const cols = colMap.get(table)!;
        const pk = pkMap.get(table) ?? [];
        // Fall back to every column when a table has no PK — still deterministic.
        const orderCols = pk.length ? pk : cols.map((x) => x.column);
        const orderBy = orderCols.map((x) => `"${x}"`).join(', ');
        const r = await c.query(
          `SELECT ${selectList(cols)} FROM "${table}" ORDER BY ${orderBy}`
        );
        out[table] = r.rows as SnapshotRow[];
      }
      return { tables: out, takenAt: new Date().toISOString() };
    },
    database
  );
}

export interface RowChange {
  table: string;
  kind: 'added' | 'removed' | 'changed';
  key: string;
  before?: SnapshotRow;
  after?: SnapshotRow;
  changedFields?: string[];
}

function rowKey(row: SnapshotRow): string {
  const id = row.id;
  if (id !== undefined && id !== null) return String(id);
  return JSON.stringify(row);
}

/**
 * Diff two snapshots into a row-level changelog.
 *
 * Deltas, not full state: a diff a human will actually read is a diff that
 * catches regressions.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): RowChange[] {
  const changes: RowChange[] = [];
  const tables = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);

  for (const table of [...tables].sort()) {
    const b = new Map((before.tables[table] ?? []).map((r) => [rowKey(r), r]));
    const a = new Map((after.tables[table] ?? []).map((r) => [rowKey(r), r]));

    for (const [key, row] of a) {
      if (!b.has(key)) {
        changes.push({ table, kind: 'added', key, after: row });
        continue;
      }
      const prev = b.get(key)!;
      const changedFields = Object.keys(row).filter(
        (f) => JSON.stringify(row[f]) !== JSON.stringify(prev[f])
      );
      if (changedFields.length) {
        changes.push({ table, kind: 'changed', key, before: prev, after: row, changedFields });
      }
    }
    for (const [key, row] of b) {
      if (!a.has(key)) changes.push({ table, kind: 'removed', key, before: row });
    }
  }
  return changes;
}
