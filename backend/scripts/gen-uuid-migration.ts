/**
 * Generator for the `cuid_to_uuidv7` migration.
 *
 *   cd backend
 *   DATABASE_URL=postgresql://…/<db at the pre-conversion schema> \
 *     npx tsx scripts/gen-uuid-migration.ts prisma/migrations/<ts>_cuid_to_uuidv7/migration.sql
 *
 * It reads the catalog of a database that is at the migration *before* this
 * one (an empty database is fine — only the catalog is read, never rows) and
 * emits a static, reviewable SQL file. Nothing in the emitted file inspects the
 * catalog at deploy time: what the owner reviewed is what runs.
 *
 * Catalog-derived (so nothing can drift from the real schema):
 *   - the converted tables: every public table whose primary key is `id text`
 *   - the column whose time becomes each new id's uuidv7 timestamp
 *   - every foreign key that references a converted table, with its exact
 *     definition from pg_get_constraintdef (name, columns, ON DELETE/UPDATE)
 *   - the row-count list (every public table except _prisma_migrations)
 *
 * Hand-declared below, because the catalog cannot know them:
 *   - ARRAY_COLUMNS: text[] columns holding ids, and which table they point at
 *   - SOFT_REFS: text columns holding ids with no foreign key
 *   - JSON_REWRITES: jsonb columns that embed ids, with the rewrite SQL
 *
 * The generator refuses to run against a database that is already converted.
 */

import * as fs from 'fs';
import { Client } from 'pg';

// ---------------------------------------------------------------------------
// Hand-declared id-bearing columns the catalog cannot see
// ---------------------------------------------------------------------------

interface ArrayColumn {
  table: string;
  column: string;
  references: string;
  writer: string;
}

/** text[] columns of ids. Converted to uuid[]; every element must resolve. */
const ARRAY_COLUMNS: ArrayColumn[] = [];

interface SoftRef {
  table: string;
  column: string;
  /** Target table, or `null` for polymorphic columns resolved by global id lookup. */
  references: string | null;
  writer: string;
}

/**
 * text columns that hold ids but have no foreign key. They stay `text` (the
 * schema change is scoped to relation fields and id arrays), but their values
 * are rewritten, or every one of them would dangle silently. A value with no
 * mapping is left unchanged and counted in a NOTICE: these columns have never
 * been constrained, so a dangling value may legitimately predate this migration.
 */
const SOFT_REFS: SoftRef[] = [];

interface JsonRewrite {
  table: string;
  column: string;
  /** What in the document is an id. */
  holds: string;
  /** Static SQL, emitted verbatim. May use "_uuid_for" / "_uuid_any_text". */
  sql: string;
}

const JSON_REWRITES: JsonRewrite[] = [];

/** Tables where the catalog rule below picks no column or the wrong one. */
const TIME_COLUMN_OVERRIDES: Record<string, { column: string; reason: string }> = {
  // Two NOT NULL DEFAULT CURRENT_TIMESTAMP columns; lastMentioned moves on every mention.
  Person: { column: 'firstMentioned', reason: 'set once at creation; lastMentioned moves' },
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface TableInfo {
  name: string;
  /** Column whose value becomes the uuidv7 timestamp, or null for plain uuidv7(). */
  timeColumn: string | null;
  timeReason: string;
}

interface ForeignKey {
  name: string;
  table: string;
  column: string;
  references: string;
  definition: string;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function readCatalog(client: Client) {
  const converted = await client.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
    FROM pg_constraint k
    JOIN pg_class c      ON c.oid = k.conrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
    WHERE n.nspname = 'public' AND k.contype = 'p'
      AND array_length(k.conkey, 1) = 1 AND a.attname = 'id'
      AND a.atttypid = 'text'::regtype
    ORDER BY c.relname`);

  const alreadyUuid = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'id' AND data_type = 'uuid'`);
  if (alreadyUuid.rowCount) {
    throw new Error('This database already has uuid id columns; point the generator at the pre-conversion schema.');
  }

  // Creation-time column per table. Preference: createdAt, then timestamp, then
  // the one NOT NULL timestamp column defaulting to CURRENT_TIMESTAMP (the
  // Prisma `@default(now())` that is that table's creation time under another
  // name: joinedAt, sharedAt, submittedAt, ...).
  const cols = await client.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(`
    SELECT table_name, column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
    ORDER BY table_name, ordinal_position`);

  const tables: TableInfo[] = converted.rows.map(({ table_name }) => {
    const tcols = cols.rows.filter((c) => c.table_name === table_name);
    const byName = (n: string) => tcols.find((c) => c.column_name === n);
    const override = TIME_COLUMN_OVERRIDES[table_name];
    if (override) {
      if (!byName(override.column)) throw new Error(`override column missing: ${table_name}.${override.column}`);
      return { name: table_name, timeColumn: override.column, timeReason: `"${override.column}" (${override.reason})` };
    }
    const created = byName('createdAt') ?? byName('timestamp');
    if (created) {
      return { name: table_name, timeColumn: created.column_name, timeReason: `"${created.column_name}"` };
    }
    const defaulted = tcols.filter(
      (c) => c.is_nullable === 'NO' && /CURRENT_TIMESTAMP|now\(\)/i.test(c.column_default ?? '') && c.column_name !== 'updatedAt',
    );
    if (defaulted.length === 1) {
      return {
        name: table_name,
        timeColumn: defaulted[0].column_name,
        timeReason: `"${defaulted[0].column_name}" (NOT NULL DEFAULT CURRENT_TIMESTAMP; no createdAt)`,
      };
    }
    return { name: table_name, timeColumn: null, timeReason: 'no creation-time column: plain uuidv7(), in old-id order' };
  });

  const fks = await client.query<ForeignKey>(`
    SELECT k.conname AS name, c.relname AS table, a.attname AS column,
           r.relname AS references, pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k
    JOIN pg_class c      ON c.oid = k.conrelid
    JOIN pg_class r      ON r.oid = k.confrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
    WHERE n.nspname = 'public' AND k.contype = 'f'
      AND r.relname = ANY($1::text[])
    ORDER BY c.relname, k.conname`, [tables.map((t) => t.name)]);
  for (const fk of fks.rows) {
    if (!/^FOREIGN KEY \("[^"]+"\) REFERENCES "[^"]+"\(id\)/.test(fk.definition)) {
      throw new Error(`Unexpected FK shape (expected single column -> id): ${fk.name}: ${fk.definition}`);
    }
  }

  const all = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
    ORDER BY table_name`);

  return { tables, fks: fks.rows, allTables: all.rows.map((r) => r.table_name) };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function section(title: string, body: string[]): string {
  const bar = '-- ' + '='.repeat(76);
  return [bar, `-- ${title}`, bar, '', ...body, ''].join('\n');
}

function emit(cat: Awaited<ReturnType<typeof readCatalog>>): string {
  const { tables, fks, allTables } = cat;
  const converted = new Set(tables.map((t) => t.name));
  for (const a of ARRAY_COLUMNS) if (!converted.has(a.references)) throw new Error(`array target not converted: ${a.references}`);
  for (const s of SOFT_REFS) if (s.references && !converted.has(s.references)) throw new Error(`soft-ref target not converted: ${s.references}`);

  const out: string[] = [];

  out.push(`-- cuid_to_uuidv7
--
-- Converts every cuid primary key to a database-minted UUIDv7 in a native uuid
-- column, and every reference to those keys with it: ${fks.length} foreign-key columns,
-- ${ARRAY_COLUMNS.length} id arrays, ${SOFT_REFS.length} unconstrained id columns and ${JSON_REWRITES.length} JSON columns.
--
-- GENERATED by backend/scripts/gen-uuid-migration.ts from the catalog of a
-- database at the previous migration. Do not hand-edit: change the generator,
-- regenerate, and review the diff. Verification: backend/scripts/verify-uuid-migration.sql.
--
-- How it works
--   1. _id_map(table_name, old_id, new_id) gets one row per existing row of
--      every converted table. new_id = uuidv7(<creation time> - clock_timestamp()),
--      so the uuid's embedded time is the row's original creation time and ids
--      sort in creation order.
--   2. Assertions, before anything is altered: every table fully mapped, no
--      old id duplicated across tables, every non-null foreign-key value and id
--      array element has a mapping in the table it points at.
--   3. Foreign keys referencing converted tables are dropped.
--   4. One ALTER TABLE per table changes id and reference columns to uuid
--      in place: ALTER COLUMN ... TYPE uuid USING "_uuid_for"(<table>, <col>).
--      An in-place type change keeps the column's position and lets Postgres
--      rebuild the primary key, unique constraints and indexes on it under
--      their existing names and definitions, so no index DDL is hand-copied.
--      "_uuid_for" raises on any non-null value with no mapping.
--   5. Unconstrained id columns and JSON documents are rewritten.
--   6. Foreign keys are re-added from their exact pg_get_constraintdef text
--      (same names, same ON DELETE / ON UPDATE). Adding them validates every row.
--   7. Assertions after: row counts unchanged, every id is a minted uuid.
--   8. Helpers and _id_map are dropped.
--
-- Prisma runs a migration file in one transaction: any RAISE aborts it and
-- leaves the database exactly as it was. There is no COMMIT in this file.
`);

  // --- 1. helpers -----------------------------------------------------------
  out.push(section('1. Mapping table and helpers (dropped at the end)', [
    `CREATE TABLE "_id_map" (
  table_name text NOT NULL,
  old_id     text NOT NULL,
  new_id     uuid NOT NULL UNIQUE,
  PRIMARY KEY (table_name, old_id)
);
CREATE INDEX "_id_map_old_id_idx" ON "_id_map" (old_id);

CREATE TABLE "_row_counts" (
  table_name text PRIMARY KEY,
  n          bigint NOT NULL
);

-- The new id of row p_old in table p_table. NULL in, NULL out (STRICT).
-- A non-null id that maps to nothing is an error, never a silent NULL.
CREATE FUNCTION "_uuid_for"(p_table text, p_old text) RETURNS uuid
LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE
  v uuid;
BEGIN
  SELECT new_id INTO v FROM "_id_map" WHERE table_name = p_table AND old_id = p_old;
  IF v IS NULL THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: no % row has id %', p_table, p_old;
  END IF;
  RETURN v;
END $$;

-- Element-wise "_uuid_for", preserving element order.
CREATE FUNCTION "_uuids_for"(p_table text, p_old text[]) RETURNS uuid[]
LANGUAGE sql STABLE STRICT AS $$
  SELECT coalesce(array_agg("_uuid_for"(p_table, e) ORDER BY ord), '{}'::uuid[])
  FROM unnest(p_old) WITH ORDINALITY AS u(e, ord)
$$;

-- For unconstrained text columns and JSON: the new id as text if p_old is an
-- old id of p_table (any converted table when p_table is NULL), else p_old
-- unchanged. Never raises: these values were never constrained.
CREATE FUNCTION "_uuid_text_or_keep"(p_table text, p_old text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT new_id::text FROM "_id_map"
      WHERE old_id = p_old AND (p_table IS NULL OR table_name = p_table)),
    p_old)
$$;

-- RAISE unless every non-null value of p_table.p_col is an id of p_ref.
CREATE FUNCTION "_assert_mapped"(p_table text, p_col text, p_ref text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  EXECUTE format(
    'SELECT count(*) FROM %I t WHERE t.%I IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "_id_map" m WHERE m.table_name = %L AND m.old_id = t.%I)',
    p_table, p_col, p_ref, p_col) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: %.% has % value(s) that are not % ids', p_table, p_col, n, p_ref;
  END IF;
END $$;

-- RAISE unless every non-null element of the array p_table.p_col is an id of p_ref.
CREATE FUNCTION "_assert_array_mapped"(p_table text, p_col text, p_ref text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  EXECUTE format(
    'SELECT count(*) FROM %I t, unnest(t.%I) AS e WHERE e IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "_id_map" m WHERE m.table_name = %L AND m.old_id = e)',
    p_table, p_col, p_ref) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: %.% has % element(s) that are not % ids', p_table, p_col, n, p_ref;
  END IF;
END $$;

-- RAISE unless p_table has exactly the row count recorded in _row_counts.
CREATE FUNCTION "_assert_row_count"(p_table text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  before bigint;
  after  bigint;
BEGIN
  SELECT n INTO before FROM "_row_counts" WHERE table_name = p_table;
  EXECUTE format('SELECT count(*) FROM %I', p_table) INTO after;
  IF before IS DISTINCT FROM after THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: % had % rows before, % after', p_table, before, after;
  END IF;
END $$;

-- RAISE unless every row of p_table has exactly one mapping, and vice versa.
CREATE FUNCTION "_assert_fully_mapped"(p_table text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n_rows bigint;
  n_map  bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I', p_table) INTO n_rows;
  SELECT count(*) INTO n_map FROM "_id_map" WHERE table_name = p_table;
  IF n_rows <> n_map THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: % has % rows but % mappings', p_table, n_rows, n_map;
  END IF;
END $$;`,
  ]));

  // --- 2. row counts ---------------------------------------------------------
  out.push(section('2. Row counts before (every public table, checked again in section 9)', [
    `INSERT INTO "_row_counts" (table_name, n) VALUES\n` +
      allTables.map((t) => `  (${lit(t)}, (SELECT count(*) FROM ${q(t)}))`).join(',\n') + ';',
  ]));

  // --- 3. mint ----------------------------------------------------------------
  const mint: string[] = [
    `-- One INSERT per table. uuidv7(interval) shifts the clock by the interval, so`,
    `-- uuidv7(t - clock_timestamp()) embeds time t. Prisma's timestamp(3) columns`,
    `-- hold UTC without a zone; AT TIME ZONE 'UTC' reads them as such regardless of`,
    `-- the session TimeZone. Rows are minted in creation order (ties by old id).`,
    '',
  ];
  for (const t of tables) {
    mint.push(`-- ${t.name}: time from ${t.timeReason}`);
    if (t.timeColumn) {
      mint.push(
        `INSERT INTO "_id_map" (table_name, old_id, new_id)`,
        `SELECT ${lit(t.name)}, id, uuidv7((${q(t.timeColumn)} AT TIME ZONE 'UTC') - clock_timestamp())`,
        `FROM ${q(t.name)} ORDER BY ${q(t.timeColumn)}, id;`,
      );
    } else {
      mint.push(
        `INSERT INTO "_id_map" (table_name, old_id, new_id)`,
        `SELECT ${lit(t.name)}, id, uuidv7()`,
        `FROM ${q(t.name)} ORDER BY id;`,
      );
    }
    mint.push('');
  }
  out.push(section(`3. Mint new ids (${tables.length} tables)`, mint));

  // --- 4. assertions before ----------------------------------------------------
  const pre: string[] = [
    '-- Every row of every converted table has exactly one mapping.',
    ...tables.map((t) => `SELECT "_assert_fully_mapped"(${lit(t.name)});`),
    '',
    '-- cuids are globally unique, which the global lookups for polymorphic',
    '-- columns and JSON (section 6) rely on. Prove it rather than assume it.',
    `DO $$
DECLARE
  dup text;
BEGIN
  SELECT old_id INTO dup FROM "_id_map" GROUP BY old_id HAVING count(*) > 1 LIMIT 1;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'cuid_to_uuidv7: old id % appears in more than one table', dup;
  END IF;
END $$;`,
    '',
    `-- Every non-null foreign-key value has a mapping in the referenced table (${fks.length}).`,
    ...fks.map((f) => `SELECT "_assert_mapped"(${lit(f.table)}, ${lit(f.column)}, ${lit(f.references)});`),
    '',
    `-- Every id array element has a mapping in the table it points at (${ARRAY_COLUMNS.length}).`,
    ...ARRAY_COLUMNS.map((a) => `SELECT "_assert_array_mapped"(${lit(a.table)}, ${lit(a.column)}, ${lit(a.references)});`),
  ];
  out.push(section('4. Assertions before any change', pre));

  // --- 5. drop FKs ------------------------------------------------------------
  out.push(section(`5. Drop the ${fks.length} foreign keys that reference converted tables (re-added in section 7)`,
    fks.map((f) => `ALTER TABLE ${q(f.table)} DROP CONSTRAINT ${q(f.name)};`)));

  // --- 6. convert -------------------------------------------------------------
  const conv: string[] = [];
  const fkByTable = new Map<string, ForeignKey[]>();
  for (const f of fks) fkByTable.set(f.table, [...(fkByTable.get(f.table) ?? []), f]);
  const arraysByTable = new Map<string, ArrayColumn[]>();
  for (const a of ARRAY_COLUMNS) arraysByTable.set(a.table, [...(arraysByTable.get(a.table) ?? []), a]);
  const touched = [...new Set([...tables.map((t) => t.name), ...fkByTable.keys(), ...arraysByTable.keys()])].sort();
  for (const name of touched) {
    const clauses: string[] = [];
    if (converted.has(name)) {
      clauses.push(`  ALTER COLUMN "id" TYPE uuid USING "_uuid_for"(${lit(name)}, "id")`);
      clauses.push(`  ALTER COLUMN "id" SET DEFAULT uuidv7()`);
    }
    for (const f of fkByTable.get(name) ?? []) {
      clauses.push(`  ALTER COLUMN ${q(f.column)} TYPE uuid USING "_uuid_for"(${lit(f.references)}, ${q(f.column)})`);
    }
    for (const a of arraysByTable.get(name) ?? []) {
      clauses.push(`  ALTER COLUMN ${q(a.column)} TYPE uuid[] USING "_uuids_for"(${lit(a.references)}, ${q(a.column)})`);
    }
    conv.push(`-- ${name}`, `ALTER TABLE ${q(name)}`, clauses.join(',\n') + ';', '');
  }
  out.push(section(`6. Convert id, foreign-key and id-array columns in place (${touched.length} tables)`, conv));

  // --- 6b. soft refs and JSON -------------------------------------------------
  const soft: string[] = [];
  for (const s of SOFT_REFS) {
    const target = s.references ? lit(s.references) : 'NULL';
    soft.push(
      `-- ${s.table}.${s.column} -> ${s.references ?? 'any converted table (polymorphic)'}. Writer: ${s.writer}`,
      `UPDATE ${q(s.table)} SET ${q(s.column)} = "_uuid_text_or_keep"(${target}, ${q(s.column)})`,
      `WHERE ${q(s.column)} IS NOT NULL;`,
      '',
    );
  }
  if (SOFT_REFS.length) {
    soft.push(`-- Report, without failing, any unconstrained value that matched no id.
DO $$
DECLARE
  r record;
  n bigint;
BEGIN
  FOR r IN SELECT * FROM (VALUES
${SOFT_REFS.map((s) => `    (${lit(s.table)}, ${lit(s.column)})`).join(',\n')}
  ) AS v(t, c) LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IS NOT NULL AND %I !~ ''^[0-9a-f]{8}-[0-9a-f]{4}-7''', r.t, r.c, r.c) INTO n;
    IF n > 0 THEN
      RAISE NOTICE 'cuid_to_uuidv7: %.% kept % value(s) that are not ids of any row', r.t, r.c, n;
    END IF;
  END LOOP;
END $$;`, '');
  }
  for (const j of JSON_REWRITES) {
    soft.push(`-- ${j.table}.${j.column}: ${j.holds}`, j.sql.trim(), '');
  }
  out.push(section('6b. Rewrite unconstrained id columns and JSON documents', soft.length ? soft : ['-- none']));

  // --- 7. re-add FKs ------------------------------------------------------------
  out.push(section(`7. Re-add the ${fks.length} foreign keys exactly as they were (validates every row)`,
    fks.map((f) => `ALTER TABLE ${q(f.table)} ADD CONSTRAINT ${q(f.name)} ${f.definition};`)));

  // --- 8. assertions after -----------------------------------------------------
  out.push(section('8. Assertions after', [
    '-- Row counts unchanged, every public table.',
    ...allTables.map((t) => `SELECT "_assert_row_count"(${lit(t)});`),
    '',
    '-- Every id is one this migration minted for that table.',
    `DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
${tables.map((t) => `    ${lit(t.name)}`).join(',\n')}
  ] LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I x WHERE NOT EXISTS (SELECT 1 FROM "_id_map" m WHERE m.table_name = %L AND m.new_id = x.id)',
      t, t) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'cuid_to_uuidv7: % has % id(s) this migration did not mint', t, n;
    END IF;
  END LOOP;
END $$;`,
  ]));

  // --- 9. cleanup ---------------------------------------------------------------
  out.push(section('9. Drop helpers and the mapping', [
    `DROP FUNCTION "_assert_fully_mapped"(text);
DROP FUNCTION "_assert_row_count"(text);
DROP FUNCTION "_assert_array_mapped"(text, text, text);
DROP FUNCTION "_assert_mapped"(text, text, text);
DROP FUNCTION "_uuid_text_or_keep"(text, text);
DROP FUNCTION "_uuids_for"(text, text[]);
DROP FUNCTION "_uuid_for"(text, text);
DROP TABLE "_row_counts";
DROP TABLE "_id_map";`,
  ]));

  return out.join('\n');
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) throw new Error('Usage: gen-uuid-migration.ts <output migration.sql>');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to a database at the pre-conversion schema.');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const cat = await readCatalog(client);
    fs.writeFileSync(outPath, emit(cat));
    process.stderr.write(
      `wrote ${outPath}: ${cat.tables.length} tables, ${cat.fks.length} FKs, ${ARRAY_COLUMNS.length} arrays, ` +
        `${SOFT_REFS.length} soft refs, ${JSON_REWRITES.length} JSON rewrites\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
