/**
 * Static proof for work-a39h.11.40: the hand-written tables (tables.sql) build
 * the same 47 tables the baseline built before, when its tables came from
 * `prisma migrate diff --from-empty` plus ALTERs in the trailer.
 *
 *   npx tsx backend/scripts/target-shape/compare-baseline-ddl.ts
 *       [--rev <git rev> | --old <migration.sql>]   (default --rev 99abd51f)
 *       [--new <migration.sql>]                     (default: the committed baseline)
 *   npx tsx backend/scripts/target-shape/compare-baseline-ddl.ts --self-test
 *
 * No database. Each migration file is split into statements and the DDL is
 * *replayed* into a model — CREATE TYPE/DOMAIN/TABLE/INDEX, then every ALTER
 * TABLE (ADD CONSTRAINT, ALTER COLUMN … TYPE, DROP/ADD COLUMN) applied in file
 * order — so the old file's end state (FKs added at the end, CHECKs and the
 * intensity retype in the trailer, the generated columns dropped and re-added)
 * is compared with the new file's inline definitions. Per table it compares:
 *   columns, in order: name, type, default, NOT NULL, generated expression;
 *   constraints by name: kind and normalised definition (FK actions included);
 *   indexes by name: unique or not, and normalised definition.
 * Plus the enums and domains, and every other statement (functions, triggers,
 * views, grants, the seed) as normalised text, in order.
 *
 * Allowed differences, each listed in the output — anything else fails:
 *   A1  a column typed uuid becomes uuid7 (required: one still typed uuid fails);
 *   A2  a Prisma unique index <t>_<cols>_key becomes a UNIQUE constraint of the
 *       same name and columns (PostgreSQL backs it with an index of that name);
 *   A3  the new domain uuid7;
 *   A4  Prisma's `CREATE SCHEMA IF NOT EXISTS "public"` is gone (a no-op);
 *   A5  the step-20 assertion block (T8) gained exactly the two uuid7 assertions
 *       (no uuid typed plain uuid; 128 uuid7 columns) and a reworded jsonb
 *       comment, and nothing else;
 *   A6  in the views, exactly A6_CASTS array_agg results over uuid7 columns are
 *       cast back to uuid[] (`)::uuid[]` added; nothing else in those views);
 *   A7  the step-20 block also gained exactly the array-of-domain assertion.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BACKEND = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(BACKEND, '..');
const BASELINE_REL = 'backend/prisma/migrations/20261026120000_target_shape_baseline/migration.sql';

// ---------------------------------------------------------------------------
// Lexing: statements, with comments removed; quotes and dollar bodies intact.
// ---------------------------------------------------------------------------

export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end < 0 ? sql.length : end + m[0].length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split on top-level commas (outside parens, brackets and quotes). */
function splitTop(s: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length && !(s[j] === c && s[j + 1] !== c)) j += s[j] === c ? 2 : 1;
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * Normalise SQL text for comparison: identifiers unquoted, everything outside
 * string literals lower-cased, whitespace collapsed, no space around ( ) , [ ].
 */
export function norm(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1;
      while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '"') {
      const j = s.indexOf('"', i + 1);
      out += s.slice(i + 1, j);
      i = j;
    } else out += c.toLowerCase();
  }
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),[\]])\s*/g, '$1')
    .trim();
}

const ident = (s: string) => s.replace(/^"|"$/g, '');

// ---------------------------------------------------------------------------
// The model and the replay.
// ---------------------------------------------------------------------------

export interface Column {
  name: string;
  type: string;
  default: string | null;
  notNull: boolean;
  generated: string | null;
}
export interface Constraint {
  kind: 'p' | 'u' | 'f' | 'c';
  def: string;
}
export interface Index {
  table: string;
  unique: boolean;
  def: string;
}
export interface Table {
  columns: Column[];
  constraints: Map<string, Constraint>;
}
export interface Model {
  enums: Map<string, string>;
  domains: Map<string, string>;
  tables: Map<string, Table>;
  indexes: Map<string, Index>;
  other: string[];
}

const COL_KEYWORDS = /^(not\s+null|null|default|generated)\b/i;

function parseColumn(item: string): Column {
  const m = /^("[^"]+"|[a-z_][a-z0-9_]*)\s+([\s\S]*)$/i.exec(item);
  if (!m) throw new Error(`cannot parse column: ${item}`);
  const name = ident(m[1]);
  const rest = m[2];
  // Walk top-level tokens; the type is everything before the first keyword.
  let i = 0;
  let depth = 0;
  let typeEnd = -1;
  const clauses: { kw: string; at: number }[] = [];
  while (i < rest.length) {
    const c = rest[i];
    if (c === "'") {
      let j = i + 1;
      while (j < rest.length && !(rest[j] === "'" && rest[j + 1] !== "'")) j += rest[j] === "'" ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && (i === 0 || /\s/.test(rest[i - 1]))) {
      const k = COL_KEYWORDS.exec(rest.slice(i));
      if (k) {
        if (typeEnd < 0) typeEnd = i;
        clauses.push({ kw: k[1].toLowerCase().replace(/\s+/g, ' '), at: i });
        i += k[0].length;
        continue;
      }
    }
    i++;
  }
  const type = norm(typeEnd < 0 ? rest : rest.slice(0, typeEnd));
  const col: Column = { name, type, default: null, notNull: false, generated: null };
  clauses.forEach((cl, n) => {
    const end = n + 1 < clauses.length ? clauses[n + 1].at : rest.length;
    const body = rest.slice(cl.at, end);
    if (cl.kw === 'not null') col.notNull = true;
    else if (cl.kw === 'default') col.default = norm(body.replace(/^default\s+/i, ''));
    else if (cl.kw === 'generated') {
      const g = /^generated\s+always\s+as\s*\(([\s\S]*)\)\s*stored\s*$/i.exec(body.trim());
      if (!g) throw new Error(`cannot parse generated column ${name}: ${body}`);
      col.generated = norm(g[1]);
    } else if (cl.kw !== 'null') throw new Error(`unexpected clause ${cl.kw} on ${name}`);
  });
  return col;
}

function parseConstraint(item: string): [string, Constraint] {
  const m = /^constraint\s+("[^"]+"|[a-z_][a-z0-9_]*)\s+([\s\S]*)$/i.exec(item);
  if (!m) throw new Error(`cannot parse constraint: ${item}`);
  const def = norm(m[2]);
  const kind = def.startsWith('primary key')
    ? 'p'
    : def.startsWith('unique')
      ? 'u'
      : def.startsWith('foreign key')
        ? 'f'
        : def.startsWith('check')
          ? 'c'
          : null;
  if (!kind) throw new Error(`unknown constraint kind: ${item}`);
  return [ident(m[1]), { kind, def }];
}

function table(model: Model, name: string): Table {
  const t = model.tables.get(name);
  if (!t) throw new Error(`ALTER of unknown table ${name}`);
  return t;
}

export function replay(sql: string): Model {
  const model: Model = { enums: new Map(), domains: new Map(), tables: new Map(), indexes: new Map(), other: [] };
  for (const st of splitStatements(sql)) {
    let m: RegExpExecArray | null;
    if ((m = /^create\s+type\s+("[^"]+"|\S+)\s+as\s+enum\s*\(([\s\S]*)\)$/i.exec(st))) {
      model.enums.set(ident(m[1]), norm(m[2]));
    } else if ((m = /^create\s+domain\s+("[^"]+"|\S+)\s+as\s+([\s\S]*)$/i.exec(st))) {
      model.domains.set(ident(m[1]), norm(m[2]));
    } else if ((m = /^create\s+table\s+("[^"]+"|[a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)$/i.exec(st))) {
      const t: Table = { columns: [], constraints: new Map() };
      for (const item of splitTop(m[2])) {
        if (/^constraint\s/i.test(item)) {
          const [n, c] = parseConstraint(item);
          if (t.constraints.has(n)) throw new Error(`duplicate constraint ${n}`);
          t.constraints.set(n, c);
        } else t.columns.push(parseColumn(item));
      }
      model.tables.set(ident(m[1]), t);
    } else if (
      (m = /^create\s+(unique\s+)?index\s+("[^"]+"|\S+)\s+on\s+("[^"]+"|[a-z_][a-z0-9_]*)\s*([\s\S]*)$/i.exec(st))
    ) {
      model.indexes.set(ident(m[2]), { table: ident(m[3]), unique: !!m[1], def: norm(m[4]) });
    } else if ((m = /^alter\s+table\s+("[^"]+"|[a-z_][a-z0-9_]*)\s+([\s\S]*)$/i.exec(st))) {
      const t = table(model, ident(m[1]));
      for (const sub of splitTop(m[2])) {
        let s: RegExpExecArray | null;
        if ((s = /^add\s+(constraint\s[\s\S]*)$/i.exec(sub))) {
          const [n, c] = parseConstraint(s[1]);
          if (t.constraints.has(n)) throw new Error(`duplicate constraint ${n}`);
          t.constraints.set(n, c);
        } else if ((s = /^alter\s+column\s+("[^"]+"|\S+)\s+type\s+([\s\S]*)$/i.exec(sub))) {
          const col = t.columns.find(c => c.name === ident(s![1]));
          if (!col) throw new Error(`ALTER COLUMN of unknown column ${s[1]}`);
          col.type = norm(s[2]);
        } else if ((s = /^drop\s+column\s+("[^"]+"|\S+)$/i.exec(sub))) {
          const at = t.columns.findIndex(c => c.name === ident(s![1]));
          if (at < 0) throw new Error(`DROP COLUMN of unknown column ${s[1]}`);
          t.columns.splice(at, 1);
        } else if ((s = /^add\s+column\s+([\s\S]*)$/i.exec(sub))) {
          t.columns.push(parseColumn(s[1]));
        } else throw new Error(`unsupported ALTER TABLE clause: ${sub}`);
      }
    } else {
      model.other.push(norm(st));
    }
  }
  return model;
}

// ---------------------------------------------------------------------------
// Comparison.
// ---------------------------------------------------------------------------

export interface Result {
  failures: string[];
  allowed: Map<string, string[]>;
  summary: string[];
}

export function compare(oldM: Model, newM: Model): Result {
  const failures: string[] = [];
  const allowed = new Map<string, string[]>([
    ['A1 uuid → uuid7', []],
    ['A2 unique index → UNIQUE constraint', []],
    ['A3 new domain uuid7', []],
    ['A4 CREATE SCHEMA IF NOT EXISTS public dropped', []],
    ['A5 step-20 assertion block gained the uuid7 check', []],
    ['A6 view array_agg cast back to uuid[]', []],
    ['A7 step-20 block gained the array-of-domain assertion', []],
  ]);
  const allow = (k: string, v: string) => allowed.get(k)!.push(v);

  // enums
  for (const [n, v] of oldM.enums) if (newM.enums.get(n) !== v) failures.push(`enum ${n}: ${v} → ${newM.enums.get(n)}`);
  for (const n of newM.enums.keys()) if (!oldM.enums.has(n)) failures.push(`enum ${n}: new`);
  // domains
  for (const [n, v] of oldM.domains)
    if (newM.domains.get(n) !== v) failures.push(`domain ${n}: ${v} → ${newM.domains.get(n)}`);
  for (const [n, v] of newM.domains) {
    if (oldM.domains.has(n)) continue;
    if (n === 'uuid7') allow('A3 new domain uuid7', v);
    else failures.push(`domain ${n}: new`);
  }

  // Unique indexes of the old model that became UNIQUE constraints: pair them.
  const oldIdx = new Map(oldM.indexes);
  const newIdx = new Map(newM.indexes);
  const uniqueAsConstraint = new Set<string>();
  for (const [n, ix] of oldM.indexes) {
    const nt = newM.tables.get(ix.table);
    const c = nt?.constraints.get(n);
    if (ix.unique && c?.kind === 'u' && !newIdx.has(n)) {
      if (c.def === `unique${ix.def}`) {
        allow('A2 unique index → UNIQUE constraint', `${ix.table}.${n} ${ix.def}`);
        uniqueAsConstraint.add(n);
        oldIdx.delete(n);
      } else failures.push(`${ix.table}.${n}: unique index ${ix.def} → constraint ${c.def}`);
    }
  }

  const names = new Set([...oldM.tables.keys(), ...newM.tables.keys()]);
  let nCols = 0;
  let nCons = 0;
  for (const tn of [...names].sort()) {
    const o = oldM.tables.get(tn);
    const n = newM.tables.get(tn);
    if (!o || !n) {
      failures.push(`table ${tn}: ${o ? 'missing from new' : 'new'}`);
      continue;
    }
    const on = o.columns.map(c => c.name).join(',');
    const nn = n.columns.map(c => c.name).join(',');
    if (on !== nn) failures.push(`${tn}: column order/set differs\n    old ${on}\n    new ${nn}`);
    for (const oc of o.columns) {
      const nc = n.columns.find(c => c.name === oc.name);
      if (!nc) continue;
      nCols++;
      for (const k of ['default', 'notNull', 'generated'] as const) {
        if (oc[k] !== nc[k])
          failures.push(`${tn}.${oc.name}: ${k} ${JSON.stringify(oc[k])} → ${JSON.stringify(nc[k])}`);
      }
      if (oc.type !== nc.type) {
        if (oc.type === 'uuid' && nc.type === 'uuid7') allow('A1 uuid → uuid7', `${tn}.${oc.name}`);
        else failures.push(`${tn}.${oc.name}: type ${oc.type} → ${nc.type}`);
      } else if (nc.type === 'uuid') failures.push(`${tn}.${oc.name}: still uuid, must be uuid7 (owner decision)`);
    }
    for (const [cn, oc] of o.constraints) {
      const nc = n.constraints.get(cn);
      nCons++;
      if (!nc) failures.push(`${tn}: constraint ${cn} (${oc.kind}) missing from new`);
      else if (nc.kind !== oc.kind || nc.def !== oc.def)
        failures.push(`${tn}.${cn}: ${oc.kind} ${oc.def}\n    → ${nc.kind} ${nc.def}`);
    }
    for (const cn of n.constraints.keys()) {
      if (!o.constraints.has(cn) && !uniqueAsConstraint.has(cn)) failures.push(`${tn}: constraint ${cn} is new`);
    }
  }

  for (const [n, ix] of oldIdx) {
    const nx = newIdx.get(n);
    if (!nx) failures.push(`index ${n} on ${ix.table}: missing from new`);
    else if (nx.table !== ix.table || nx.unique !== ix.unique || nx.def !== ix.def)
      failures.push(`index ${n}: ${JSON.stringify(ix)} → ${JSON.stringify(nx)}`);
  }
  for (const n of newIdx.keys()) if (!oldM.indexes.has(n)) failures.push(`index ${n}: new`);

  // Everything that is not table DDL: same statements, same order, except A4/A5.
  const isSchemaPublic = (s: string) => s === 'create schema if not exists public';
  const isStep20 = (s: string) => s.startsWith('do $$') && s.includes("raise exception 'step 20:");
  const oo = oldM.other.filter(s => !isSchemaPublic(s));
  if (oo.length !== oldM.other.length)
    allow('A4 CREATE SCHEMA IF NOT EXISTS public dropped', 'CREATE SCHEMA IF NOT EXISTS "public"');
  const no = newM.other;
  if (oo.length !== no.length) failures.push(`other statements: ${oo.length} → ${no.length}`);
  let casts = 0;
  for (let i = 0; i < Math.min(oo.length, no.length); i++) {
    if (oo[i] === no[i]) continue;
    const a6 = viewCastDelta(oo[i], no[i]);
    if (a6) {
      casts += a6.casts;
      allow('A6 view array_agg cast back to uuid[]', `${a6.view} ×${a6.casts}`);
      continue;
    }
    if (isStep20(oo[i]) && isStep20(no[i]) && step20Delta(oo[i], no[i]) === null) {
      allow('A5 step-20 assertion block gained the uuid7 check', `statement #${i + 1}`);
      allow('A7 step-20 block gained the array-of-domain assertion', `statement #${i + 1}`);
    } else if (isStep20(oo[i]) && isStep20(no[i]))
      failures.push(`step-20 block differs beyond the uuid7 check (statement #${i + 1}): ${step20Delta(oo[i], no[i])}`);
    else
      failures.push(
        `other statement #${i + 1} differs:\n    old ${oo[i].slice(0, 160)}\n    new ${no[i].slice(0, 160)}`,
      );
  }

  if (casts !== A6_CASTS) failures.push(`views: ${casts} array_agg ::uuid[] cast(s), expected ${A6_CASTS}`);

  const count = (m: Model, k: Constraint['kind']) =>
    [...m.tables.values()].reduce((a, t) => a + [...t.constraints.values()].filter(c => c.kind === k).length, 0);
  const summary = [
    `tables: old ${oldM.tables.size}, new ${newM.tables.size}`,
    `columns compared: ${nCols}; constraints compared: ${nCons}`,
    `constraints old p/u/f/c: ${count(oldM, 'p')}/${count(oldM, 'u')}/${count(oldM, 'f')}/${count(oldM, 'c')}; new: ${count(newM, 'p')}/${count(newM, 'u')}/${count(newM, 'f')}/${count(newM, 'c')}`,
    `indexes old ${oldM.indexes.size} (unique ${[...oldM.indexes.values()].filter(i => i.unique).length}), new ${newM.indexes.size} (unique ${[...newM.indexes.values()].filter(i => i.unique).length})`,
    `enums: ${oldM.enums.size}/${newM.enums.size}; domains: ${[...oldM.domains.keys()].join(',')} / ${[...newM.domains.keys()].join(',')}`,
    `other statements: ${oldM.other.length}/${newM.other.length}`,
  ];
  return { failures, allowed, summary };
}

// ---------------------------------------------------------------------------
// CLI and self-test.
// ---------------------------------------------------------------------------

function readOld(args: string[]): string {
  const o = args.indexOf('--old');
  if (o >= 0) return fs.readFileSync(args[o + 1], 'utf8');
  const r = args.indexOf('--rev');
  const rev = r >= 0 ? args[r + 1] : '99abd51f';
  return execFileSync('git', ['show', `${rev}:${BASELINE_REL}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
}

function readNew(args: string[]): string {
  const n = args.indexOf('--new');
  return fs.readFileSync(n >= 0 ? args[n + 1] : path.join(REPO, BASELINE_REL), 'utf8');
}

/**
 * A5, exactly: the new step-20 block is the old one plus the two uuid7
 * assertions (normalised) plus one comment reworded; any other change fails.
 * Returns null when that holds, else a description of the first difference.
 */
const A5_OLD_COMMENT = norm('-- Every jsonb column has a jsonb_typeof CHECK.');
const A5_NEW_COMMENT = norm(`-- Every jsonb column has a jsonb_typeof CHECK (inline in its CREATE TABLE in
  -- tables.sql; the catalog, not the source, is what this reads).`);
const A5_ADDED = norm(`
  -- Every uuid column of a table is a uuid7 (tables.sql): 33 primary keys
  -- defaulting to uuidv7() and the 95 columns that reference them.
  SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname) INTO bad
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'pg_catalog.uuid'::regtype;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: uuid column(s) not typed uuid7: %', bad; END IF;
  SELECT count(*) INTO n
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'public.uuid7'::regtype;
  IF n <> 128 THEN RAISE EXCEPTION 'step 20: % uuid7 columns, expected 128', n; END IF;
`);

const A7_ADDED = norm(`
  -- No column (table, view, composite) and no function argument or result has
  -- an array-of-domain type: array_agg over a uuid7 column is uuid7[], which
  -- node-postgres cannot parse (the app would read the string '{…}'). Cast it
  -- back with ::uuid[] (the uuid7 domain in tables.sql explains).
  SELECT string_agg(s.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, NULL), ', '
                    ORDER BY s.nspname, c.relname, a.attname) INTO bad
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid JOIN pg_type e ON e.oid = t.typelem
  WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname !~ '^pg_'
    AND a.attnum > 0 AND NOT a.attisdropped AND t.typcategory = 'A' AND e.typtype = 'd';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: column(s) of an array-of-domain type (cast to the base array, e.g. ::uuid[]): %', bad; END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO bad
  FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
  WHERE s.nspname NOT IN ('pg_catalog', 'information_schema') AND s.nspname !~ '^pg_'
    AND EXISTS (SELECT 1 FROM unnest(p.prorettype || coalesce(p.proallargtypes, p.proargtypes::oid[])) AS x(typ)
                JOIN pg_type t ON t.oid = x.typ JOIN pg_type e ON e.oid = t.typelem
                WHERE t.typcategory = 'A' AND e.typtype = 'd');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'step 20: function(s) with an array-of-domain argument or result (use the base array, e.g. uuid[]): %', bad; END IF;
`);

/**
 * A6, exactly: a CREATE VIEW whose only change is `)::uuid[]` after aggregate
 * calls (array_agg over a uuid7 column is uuid7[] otherwise; tables.sql, the
 * uuid7 domain). Returns the view and the number of casts, else null.
 */
export const A6_CASTS = 9;
export function viewCastDelta(oldStmt: string, newStmt: string): { view: string; casts: number } | null {
  const m = /^create view (\S+) /.exec(newStmt);
  if (!m || !oldStmt.startsWith(`create view ${m[1]} `)) return null;
  if (!newStmt.includes('array_agg(')) return null;
  const casts = (newStmt.match(/\)::uuid\[\]/g) ?? []).length;
  if (!casts || newStmt.replace(/\)::uuid\[\]/g, ')') !== oldStmt) return null;
  return { view: m[1], casts };
}

export function step20Delta(oldStmt: string, newStmt: string): string | null {
  if (oldStmt === newStmt) return null;
  if (!newStmt.includes(A5_NEW_COMMENT)) return 'the jsonb comment change is missing or altered';
  newStmt = newStmt.replace(A5_NEW_COMMENT, A5_OLD_COMMENT);
  const at7 = newStmt.indexOf(A7_ADDED);
  if (at7 < 0) return 'the array-of-domain assertion is missing or altered';
  if (newStmt.indexOf(A7_ADDED, at7 + 1) >= 0) return 'the array-of-domain assertion appears twice';
  newStmt = `${newStmt.slice(0, at7).trimEnd()} ${newStmt.slice(at7 + A7_ADDED.length).trimStart()}`;
  const at = newStmt.indexOf(A5_ADDED);
  if (at < 0) return 'the uuid7 assertions are missing or altered';
  if (newStmt.indexOf(A5_ADDED, at + 1) >= 0) return 'the uuid7 assertions appear twice';
  const rest = `${newStmt.slice(0, at).trimEnd()} ${newStmt.slice(at + A5_ADDED.length).trimStart()}`;
  if (rest === oldStmt) return null;
  let k = 0;
  while (k < rest.length && rest[k] === oldStmt[k]) k++;
  return `near …${rest.slice(Math.max(0, k - 40), k + 80)}…`;
}

/** Each mutation of the new file must make the comparison fail. */
function selfTest(oldSql: string, newSql: string): void {
  const base = compare(replay(oldSql), replay(newSql));
  if (base.failures.length) throw new Error(`self-test needs a passing baseline:\n${base.failures.join('\n')}`);
  const mutations: [string, (s: string) => string][] = [
    [
      'FK action',
      s =>
        s.replace(
          '"session_previous_session_id_fkey" FOREIGN KEY ("previous_session_id") REFERENCES "session"("id") ON DELETE SET NULL',
          '"session_previous_session_id_fkey" FOREIGN KEY ("previous_session_id") REFERENCES "session"("id") ON DELETE CASCADE',
        ),
    ],
    ['FK target', s => s.replace('REFERENCES "need_share"("need_id")', 'REFERENCES "need"("id")')],
    ['FK dropped', s => s.replace(/,\n {4}CONSTRAINT "user_key_user_id_fkey"[^\n]*/, '')],
    ['default', s => s.replace('"version" INTEGER NOT NULL DEFAULT 1', '"version" INTEGER NOT NULL DEFAULT 2')],
    ['NOT NULL', s => s.replace('"expires_at" TIMESTAMPTZ(3) NOT NULL', '"expires_at" TIMESTAMPTZ(3)')],
    ['type', s => s.replace('"cost" DECIMAL(10,6)', '"cost" DECIMAL(12,6)')],
    ['intensity', s => s.replace('"intensity_after" intensity', '"intensity_after" INTEGER')],
    ['uuid7 → uuid', s => s.replace('"session_id" uuid7 NOT NULL', '"session_id" UUID NOT NULL')],
    [
      'CHECK text',
      s => s.replace('CHECK (alignment_score BETWEEN 0 AND 100)', 'CHECK (alignment_score BETWEEN 0 AND 99)'),
    ],
    ['CHECK name', s => s.replace('chk_need_confidence', 'chk_need_confidenc')],
    [
      'generated expr',
      s => s.replace("WHEN review_id IS NOT NULL THEN 'REVIEW'", "WHEN review_id IS NOT NULL THEN 'NEED'"),
    ],
    [
      'unique cols',
      s =>
        s.replace(
          'CONSTRAINT "user_email_key" UNIQUE ("email")',
          'CONSTRAINT "user_email_key" UNIQUE ("email", "clerk_id")',
        ),
    ],
    ['index name', s => s.replace('"brain_activity_turn_id_idx"', '"brain_activity_turn_idx"')],
    [
      'index cols',
      s => s.replace('ON "takeaway"("reflection_id", "position")', 'ON "takeaway"("position", "reflection_id")'),
    ],
    ['sql_ index predicate', s => s.replace("WHERE kind = 'MAIN'", "WHERE kind = 'SUBCHAT'")],
    [
      'column order',
      s => s.replace('    "first_name" TEXT,\n    "last_name" TEXT,', '    "last_name" TEXT,\n    "first_name" TEXT,'),
    ],
    [
      'trailer function',
      s =>
        s.replace(
          'ORDER BY a.author_participant_id, a.subject_participant_id, a.round DESC',
          'ORDER BY a.author_participant_id, a.subject_participant_id, a.round',
        ),
    ],
    ['enum value', s => s.replace("'MAIN', 'SUBCHAT'", "'MAIN', 'SUB'")],
    [
      'step-20 block: other assertion changed',
      s =>
        s.replace(
          "'step 20: jsonb column(s) without a jsonb_typeof CHECK: %'",
          "'step 20: jsonb column(s) lacking CHECK: %'",
        ),
    ],
    ['step-20 block: uuid7 count changed', s => s.replace('IF n <> 128 THEN', 'IF n <> 127 THEN')],
    [
      'view cast: another type',
      s => s.replace('p.joined_at, p.id)::uuid[] AS waiting_on', 'p.joined_at, p.id)::text[] AS waiting_on'),
    ],
    [
      'view cast: one dropped',
      s => s.replace('p.joined_at, p.id)::uuid[] AS waiting_on', 'p.joined_at, p.id) AS waiting_on'),
    ],
    [
      'view cast: other change in the same view',
      s =>
        s.replace(
          'array_agg(DISTINCT c.participant_id)::uuid[] AS willing',
          'array_agg(c.participant_id)::uuid[] AS willing',
        ),
    ],
    [
      'step-20 block: array-of-domain assertion altered',
      s => s.replace("AND t.typcategory = 'A' AND e.typtype = 'd';", "AND t.typcategory = 'A' AND e.typtype = 'b';"),
    ],
    [
      'uuid7 domain allowed but intensity changed',
      s => s.replace('CHECK (VALUE BETWEEN 1 AND 10)', 'CHECK (VALUE BETWEEN 0 AND 10)'),
    ],
  ];
  let bad = 0;
  for (const [label, f] of mutations) {
    const mutated = f(newSql);
    if (mutated === newSql) {
      console.log(`  SELF-TEST BROKEN: mutation "${label}" did not apply`);
      bad++;
      continue;
    }
    const r = compare(replay(oldSql), replay(mutated));
    console.log(
      `  ${r.failures.length ? 'caught' : 'MISSED'}: ${label}${r.failures.length ? ` — ${r.failures[0].split('\n')[0]}` : ''}`,
    );
    if (!r.failures.length) bad++;
  }
  if (bad) throw new Error(`self-test: ${bad} mutation(s) not caught`);
  console.log(`ok: all ${mutations.length} mutations caught`);
}

function main(): void {
  const args = process.argv.slice(2);
  const oldSql = readOld(args);
  const newSql = readNew(args);
  if (args.includes('--self-test')) return selfTest(oldSql, newSql);
  const r = compare(replay(oldSql), replay(newSql));
  for (const s of r.summary) console.log(s);
  for (const [k, v] of r.allowed)
    console.log(`allowed ${k}: ${v.length}${v.length && v.length <= 12 ? ` (${v.join('; ')})` : ''}`);
  if (r.failures.length) {
    console.log(`\nFAIL: ${r.failures.length} difference(s) beyond the allowed ones:`);
    for (const f of r.failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nok: the 47 tables are identical except the allowed differences above');
}

if (require.main === module) main();
