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
  /** Primary key columns per table, so the diff can identify rows correctly. */
  primaryKeys: Record<string, string[]>;
  takenAt: string;
}

interface ColumnMeta {
  column: string;
  dataType: string;
  udtName: string;
}

/** Column metadata for the tables we intend to snapshot. */
async function columnsFor(target: DbTarget, database: string, tables: string[]): Promise<Map<string, ColumnMeta[]>> {
  return withClient(
    target,
    async c => {
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
        [tables],
      );
      const m = new Map<string, ColumnMeta[]>();
      for (const row of r.rows) {
        const list = m.get(row.table_name) ?? [];
        list.push({ column: row.column_name, dataType: row.data_type, udtName: row.udt_name });
        m.set(row.table_name, list);
      }
      return m;
    },
    database,
  );
}

/** Primary key columns per table, for deterministic ordering. */
async function primaryKeysFor(target: DbTarget, database: string, tables: string[]): Promise<Map<string, string[]>> {
  return withClient(
    target,
    async c => {
      const r = await c.query<{ table_name: string; column_name: string; ord: number }>(
        `SELECT t.relname AS table_name, a.attname AS column_name, k.ord
         FROM pg_constraint con
         JOIN pg_class t ON t.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         WHERE n.nspname = 'public' AND con.contype = 'p' AND t.relname = ANY($1)
         ORDER BY t.relname, k.ord`,
        [tables],
      );
      const m = new Map<string, string[]>();
      for (const row of r.rows) {
        m.set(row.table_name, [...(m.get(row.table_name) ?? []), row.column_name]);
      }
      return m;
    },
    database,
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
    .map(c => {
      const q = `"${c.column}"`;
      // The target shape is timestamptz throughout (TS-9). Its `::text`
      // carries the session's offset (`…+00`), which no stamp pattern here
      // expects; rendered at UTC it is the same naive text the current shape's
      // `timestamp` columns produce, so both shapes rank on one basis.
      if (c.dataType === 'timestamp with time zone') return `(${q} AT TIME ZONE 'UTC')::text AS ${q}`;
      if (c.dataType.startsWith('timestamp')) return `${q}::text AS ${q}`;
      if (c.udtName === 'vector')
        return `(CASE WHEN ${q} IS NULL THEN NULL ELSE 'vector(' || array_length(${q}::real[], 1) || ')' END) AS ${q}`;
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
  /**
   * Explicit row identity and ordering, per relation — required for views,
   * which have no primary key to introspect (the `old_concept_*` views,
   * `concept-views/index.ts`). `identity` becomes the diff key and must be
   * unique: a duplicate fails the snapshot rather than letting two rows share a
   * key and one of them vanish from every diff. Rows are ordered by
   * `orderBy` then `identity`, so the order is total.
   */
  keys?: Record<string, { identity: string[]; orderBy: string[] }>;
  /**
   * SQL run on the reading connection before the snapshot's queries — e.g.
   * `SET jit = off` for the concept views, whose nested plans cost enough to
   * trigger JIT compilation: measured at ~950 ms per view per snapshot with JIT
   * on, 2 ms with it off, for the same rows.
   */
  prelude?: string;
}

export async function takeSnapshot(opts: SnapshotOptions): Promise<Snapshot> {
  const { target, database, tables, keys = {}, prelude } = opts;
  const colMap = await columnsFor(target, database, tables);
  const pkMap = await primaryKeysFor(target, database, tables);
  for (const [table, k] of Object.entries(keys)) pkMap.set(table, [...k.identity]);

  const missing = tables.filter(t => !colMap.has(t));
  if (missing.length) {
    throw new Error(`Snapshot requested unknown table(s): ${missing.join(', ')}`);
  }

  return withClient(
    target,
    async c => {
      if (prelude) await c.query(prelude);
      const out: Record<string, TableSnapshot> = {};
      for (const table of tables) {
        const cols = colMap.get(table)!;
        const pk = pkMap.get(table) ?? [];
        // Fall back to every column when a table has no PK — still deterministic.
        const declared = keys[table];
        const orderCols = declared
          ? [...declared.orderBy, ...declared.identity.filter(x => !declared.orderBy.includes(x))]
          : pk.length
            ? pk
            : cols.map(x => x.column);
        const orderBy = orderCols.map(x => `"${x}"`).join(', ');
        const r = await c.query(`SELECT ${selectList(cols)} FROM "${table}" ORDER BY ${orderBy}`);
        out[table] = r.rows as SnapshotRow[];
        if (declared) {
          const seen = new Set<string>();
          for (const row of out[table]) {
            const k = rowKey(row, declared.identity);
            if (seen.has(k)) {
              throw new Error(
                `Snapshot of ${table}: identity (${declared.identity.join(', ')}) is not unique — ` +
                  `two rows share ${k.split('\u0000').join(', ')}. A duplicate key would hide one row from every diff.`,
              );
            }
            seen.add(k);
          }
        }
      }
      const primaryKeys: Record<string, string[]> = {};
      for (const table of tables) primaryKeys[table] = pkMap.get(table) ?? [];
      return { tables: out, primaryKeys, takenAt: new Date().toISOString() };
    },
    database,
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

/**
 * Identify a row by its real primary key.
 *
 * Hardcoding `id` meant composite-PK tables — `StrategyProposalNeed` is
 * `@@id([proposalId, needId])` — fell back to hashing the whole row, so every
 * UPDATE diffed as remove + add. `changedFields` was then never produced for
 * them, which silently disabled `timestampFacts` on exactly those tables: the
 * one check that catches a hand-written UPDATE forgetting `updatedAt`.
 */
function rowKey(row: SnapshotRow, pk: string[]): string {
  if (pk.length) return pk.map(c => JSON.stringify(row[c])).join('\u0000');
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
    const pk = after.primaryKeys?.[table] ?? before.primaryKeys?.[table] ?? [];
    const b = new Map((before.tables[table] ?? []).map(r => [rowKey(r, pk), r]));
    const a = new Map((after.tables[table] ?? []).map(r => [rowKey(r, pk), r]));

    for (const [key, row] of a) {
      if (!b.has(key)) {
        changes.push({ table, kind: 'added', key, after: row });
        continue;
      }
      const prev = b.get(key)!;
      const changedFields = Object.keys(row).filter(f => JSON.stringify(row[f]) !== JSON.stringify(prev[f]));
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
