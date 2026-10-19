/**
 * Normalized whole-database dump, for comparing two seedings of a fixture
 * (see `fidelity.ts`).
 *
 * - every table in schema `public` except `_prisma_migrations`, rows in PK
 *   order (ids are `uuidv7()`, so PK order is insertion order)
 * - every uuid value → `<id:N>` by first appearance (tables alphabetical, rows
 *   in PK order, columns in ordinal order), so a row-order change shows up
 * - `User.clerkId` → `<clerkId>` (seeded as `e2e_<ms>_<random>`)
 * - every timestamp → `T<signed ms offset>` from `max(Session.createdAt)`, the
 *   anchor the fixture rebase uses; ISO strings inside json likewise
 *
 * Naive timestamps are selected as `::text` and parsed as UTC, never through
 * `pg`'s Date parsing (golden README, "node-postgres and naive timestamps").
 */

import { DbTarget, withClient } from '../db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export async function normalizedDump(t: DbTarget, database: string): Promise<string> {
  return withClient(
    t,
    async c => {
      const anchorRow = await c.query<{ a: string | null }>(`SELECT max("createdAt")::text AS a FROM "Session"`);
      const anchorText = anchorRow.rows[0]?.a;
      if (!anchorText) throw new Error(`${database}: no Session row to anchor timestamps on`);
      const toMs = (s: string) => Date.parse(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z'));
      const anchor = toMs(anchorText);
      const ts = (s: string) => {
        const ms = toMs(s) - anchor;
        return `T${ms >= 0 ? '+' : ''}${ms}`;
      };

      const ids = new Map<string, string>();
      const label = (v: string) => {
        if (!ids.has(v)) ids.set(v, `<id:${ids.size + 1}>`);
        return ids.get(v) as string;
      };
      const norm = (v: unknown, table: string, col: string): unknown => {
        if (v === null || v === undefined) return v;
        if (typeof v === 'string') {
          if (table === 'User' && col === 'clerkId') return '<clerkId>';
          if (UUID.test(v)) return label(v);
          if (ISO.test(v)) return ts(v);
          return v;
        }
        if (Array.isArray(v)) return v.map(x => norm(x, table, col));
        if (typeof v === 'object') {
          const o: Record<string, unknown> = {};
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = norm(x, table, col);
          return o;
        }
        return v;
      };

      const tables = (
        await c.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
           ORDER BY table_name`,
        )
      ).rows.map(r => r.table_name);

      const lines: string[] = [];
      for (const table of tables) {
        const cols = (
          await c.query<{ column_name: string; data_type: string }>(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
            [table],
          )
        ).rows;
        const pk = (
          await c.query<{ attname: string }>(
            `SELECT a.attname FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = $1::regclass AND i.indisprimary`,
            [`"${table}"`],
          )
        ).rows.map(r => `"${r.attname}"`);
        const isTs = (dataType: string) => dataType.startsWith('timestamp');
        const select = cols
          .map(col =>
            isTs(col.data_type) ? `"${col.column_name}"::text AS "${col.column_name}"` : `"${col.column_name}"`,
          )
          .join(', ');
        const rows = (await c.query(`SELECT ${select} FROM "${table}" ORDER BY ${pk.join(', ') || '1'}`)).rows;
        if (!rows.length) continue;
        lines.push(`## ${table} (${rows.length})`);
        for (const row of rows) {
          const o: Record<string, unknown> = {};
          for (const col of cols) {
            const v = row[col.column_name];
            o[col.column_name] = isTs(col.data_type) && v !== null ? ts(v as string) : norm(v, table, col.column_name);
          }
          lines.push(JSON.stringify(o));
        }
      }
      return lines.join('\n') + '\n';
    },
    database,
  );
}
