/**
 * TS-13: no raw writer stores an encrypted column in plaintext.
 *
 * The Prisma extension never sees `$executeRaw`/`$queryRaw`, so every raw
 * INSERT/UPDATE that binds a value into a column of SENSITIVE_FIELD_MAP must
 * bind `encryptColumnValue('<table>', '<column>', …)` (a jsonb column:
 * `JSON.stringify(encryptColumnValue(…))`). The SQL functions that receive
 * content take ciphertext too: `app.need_share(need, shared_text)` and
 * `app.empathy_set_status(attempt, status, content)`.
 *
 * This walks every raw statement under src/ (not tests, not the fixture
 * writers in src/testing, which write plaintext fixtures by design) and fails
 * on any encrypted-column value that is not routed through the helper — a
 * literal, a bare variable, a sub-select. `ON CONFLICT … DO UPDATE SET col =
 * EXCLUDED.col` re-binds the already-encrypted INSERT value and is allowed.
 * The real-role suite (services/__tests__/encryption-at-rest.target.test.ts)
 * proves the same thing at rest for each column.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SENSITIVE_FIELD_MAP, isEncryptedColumn } from '../prisma-encryption-middleware';

const SRC = path.resolve(__dirname, '../..');

interface RawStatement {
  file: string;
  line: number;
  /** SQL with each `${…}` replaced by `$Pn`. */
  sql: string;
  exprs: string[];
  /** The source just before the tag and just after the template (for the reader check). */
  before?: string;
  after?: string;
}

/** Read a `${ … }` expression starting after `${`; returns [expr, index after the closing brace]. */
function readExpr(s: string, i: number): [string, number] {
  let depth = 1;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) i += s[i] === '\\' ? 2 : 1;
    } else if (c === '`') {
      i = readTemplate(s, i + 1)[1];
      continue;
    } else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return [s.slice(start, i), i + 1];
    }
    i++;
  }
  throw new Error('unterminated ${');
}

/** Read a template body starting after the opening backtick; returns [{sql, exprs}, index after closing backtick]. */
function readTemplate(s: string, i: number): [{ sql: string; exprs: string[] }, number] {
  let sql = '';
  const exprs: string[] = [];
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      sql += s.slice(i, i + 2);
      i += 2;
    } else if (c === '`') {
      return [{ sql, exprs }, i + 1];
    } else if (c === '$' && s[i + 1] === '{') {
      const [expr, next] = readExpr(s, i + 2);
      sql += `$P${exprs.length}`;
      exprs.push(expr.trim());
      i = next;
    } else {
      sql += c;
      i++;
    }
  }
  throw new Error('unterminated template');
}

function rawStatements(): RawStatement[] {
  const out: RawStatement[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['__tests__', '__mocks__', 'generated', 'testing'].includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        const s = fs.readFileSync(p, 'utf8');
        const tag = /\$(?:queryRaw|executeRaw)\s*(?:<[\s\S]*?>)?\s*`/g;
        let m: RegExpExecArray | null;
        while ((m = tag.exec(s))) {
          const [t, end] = readTemplate(s, m.index + m[0].length);
          out.push({
            file: path.relative(SRC, p),
            line: s.slice(0, m.index).split('\n').length,
            ...t,
            before: s.slice(Math.max(0, m.index - 240), m.index),
            after: s.slice(end, end + 160),
          });
        }
      }
    }
  };
  walk(SRC);
  return out;
}

/** Split on commas at paren depth 0. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** The balanced (...) group starting at `open`; returns [inner, index after ')']. */
function group(s: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    if (s[i] === ')' && --depth === 0) return [s.slice(open + 1, i), i + 1];
  }
  throw new Error('unbalanced');
}

const helperCall = (table: string, column: string) =>
  new RegExp(`^(JSON\\.stringify\\(\\s*)?encryptColumnValue\\(\\s*'${table}'\\s*,\\s*'${column}'\\s*,`);

/** Is this SQL value expression an encrypted bind of table.column? */
function encryptedBind(value: string, exprs: string[], table: string, column: string): boolean {
  const m = /^\$P(\d+)(::[a-z_[\]]+)?$/.exec(value.trim());
  return !!m && helperCall(table, column).test(exprs[Number(m[1])]);
}

interface Violation {
  where: string;
  column: string;
  value: string;
}

/** Every encrypted-column value of one statement that does not go through the helper. */
function violationsOf(st: RawStatement): Violation[] {
  const v: Violation[] = [];
  const at = `${st.file}:${st.line}`;
  const flat = st.sql.replace(/\s+/g, ' ');
  const expr = (val: string) => val.replace(/\$P(\d+)/g, (_, n) => `\${${st.exprs[Number(n)]}}`);

  const ins = /INSERT INTO "?([a-z_]+)"? ?\(/i.exec(flat);
  if (ins) {
    const table = ins[1];
    const [colList, after] = group(flat, ins.index + ins[0].length - 1);
    const cols = splitTop(colList);
    const rest = flat.slice(after).trim();
    if (/^VALUES/i.test(rest)) {
      let i = flat.indexOf('(', after);
      // every VALUES tuple
      for (;;) {
        const [tuple, next] = group(flat, i);
        splitTop(tuple).forEach((val, k) => {
          const column = cols[k];
          if (isEncryptedColumn(table, column) && !encryptedBind(val, st.exprs, table, column)) {
            v.push({ where: at, column: `${table}.${column}`, value: expr(val) });
          }
        });
        const more = /^\s*,\s*\(/.exec(flat.slice(next));
        if (!more) break;
        i = next + more[0].length - 1;
      }
    } else {
      for (const column of cols) {
        if (isEncryptedColumn(table, column))
          v.push({ where: at, column: `${table}.${column}`, value: 'INSERT … SELECT' });
      }
    }
  }

  // UPDATE t SET a = …, b = … [WHERE …] and ON CONFLICT … DO UPDATE SET …
  const sets: Array<{ table: string; body: string; conflict: boolean }> = [];
  const upd = /\bUPDATE "?([a-z_]+)"? SET (.*?)(?: WHERE | RETURNING |$)/i.exec(flat);
  if (upd && !/DO UPDATE/i.test(flat.slice(0, upd.index + 9)))
    sets.push({ table: upd[1], body: upd[2], conflict: false });
  const doUpd = /DO UPDATE SET (.*?)(?: WHERE | RETURNING |$)/i.exec(flat);
  if (doUpd && ins) sets.push({ table: ins[1], body: doUpd[1], conflict: true });
  for (const { table, body, conflict } of sets) {
    for (const assignment of splitTop(body)) {
      const eq = assignment.indexOf('=');
      const column = assignment.slice(0, eq).trim().replace(/"/g, '');
      const val = assignment.slice(eq + 1).trim();
      if (!isEncryptedColumn(table, column)) continue;
      if (conflict && new RegExp(`^EXCLUDED\\.${column}$`, 'i').test(val)) continue;
      if (!encryptedBind(val, st.exprs, table, column))
        v.push({ where: at, column: `${table}.${column}`, value: expr(val) });
    }
  }

  // The SQL functions that take content.
  const fnArgs = (name: string): string[][] => {
    const out: string[][] = [];
    const re = new RegExp(`app\\.${name}\\s*\\(`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(flat))) out.push(splitTop(group(flat, m.index + m[0].length - 1)[0]));
    return out;
  };
  for (const args of fnArgs('need_share')) {
    if (!encryptedBind(args[1] ?? '', st.exprs, 'need_share', 'shared_text')) {
      v.push({ where: at, column: 'app.need_share(…, shared_text)', value: expr(args[1] ?? '') });
    }
  }
  for (const args of fnArgs('empathy_set_status')) {
    const content = args[2];
    if (content === undefined || /^NULL(::text)?$/i.test(content)) continue;
    if (!encryptedBind(content, st.exprs, 'empathy_attempt', 'content')) {
      v.push({ where: at, column: 'app.empathy_set_status(…, content)', value: expr(content) });
    }
  }
  return v;
}

/** Views that expose an encrypted column, by the table that holds it. */
const VIEW_TABLE: Record<string, string> = { v_need_shared: 'need_share' };

/**
 * The encrypted columns a raw statement reads back (its SELECT list, or its
 * RETURNING list), as `table.column`. Select items that are expressions
 * (a function, a sub-select) are not resolved — none on the branch wraps an
 * encrypted column.
 */
function encryptedReadsOf(st: RawStatement): string[] {
  const flat = st.sql.replace(/\s+/g, ' ');
  const aliases = new Map<string, string>();
  const tables: string[] = [];
  const KEYWORDS = new Set([
    'on',
    'where',
    'join',
    'left',
    'inner',
    'order',
    'group',
    'limit',
    'for',
    'using',
    'cross',
    'and',
  ]);
  for (const m of flat.matchAll(/\b(?:FROM|JOIN|INSERT INTO|UPDATE)\s+"?([a-z_]+)"?(?:\s+(?:AS\s+)?([a-z_]+))?/gi)) {
    const table = VIEW_TABLE[m[1]] ?? m[1];
    tables.push(table);
    if (m[2] && !KEYWORDS.has(m[2].toLowerCase())) aliases.set(m[2], table);
  }
  const lists: string[] = [];
  const sel = /^\s*(?:WITH\b.*?\)\s*)?SELECT\s+(?:DISTINCT\s+(?:ON\s*\([^)]*\)\s*)?)?(.*?)\s+FROM\s/i.exec(flat);
  if (sel) lists.push(sel[1]);
  const ret = /\bRETURNING\s+(.*)$/i.exec(flat);
  if (ret) lists.push(ret[1]);
  const out: string[] = [];
  for (const list of lists) {
    for (const item of splitTop(list)) {
      if (item.includes('(')) continue;
      const ref = item
        .replace(/\s+AS\s+.*$/i, '')
        .replace(/::[a-z_[\]]+$/i, '')
        .trim();
      const [q, c] = ref.includes('.') ? ref.split('.') : [null, ref];
      const candidates = q ? [aliases.get(q) ?? VIEW_TABLE[q] ?? q] : tables;
      for (const t of candidates) if (isEncryptedColumn(t, c)) out.push(`${t}.${c}`);
    }
  }
  return [...new Set(out)];
}

/** Is the statement's result passed through decryptRawRows (around the call, or in a `.then`)? */
const decrypted = (st: RawStatement) =>
  // decryptRawRows(await client.$queryRaw<…>`…`, { … })
  (/decryptRawRows\(\s*await\s+[\w.()]+\.\s*$/.test((st.before ?? '').replace(/\s+/g, ' ').replace(/\$?\s*$/, '')) &&
    /^\s*,\s*\{[^}]*\}\s*,?\s*\)/.test(st.after ?? '')) ||
  // client.$queryRaw<…>`…`.then(rows => decryptRawRows(rows, { … }))
  /^\s*\.then\(\s*rows\s*=>\s*decryptRawRows\(/.test(st.after ?? '');

describe('raw SQL writers route every encrypted column through encryptColumnValue', () => {
  const statements = rawStatements();

  it('finds the raw statements (the scan is alive)', () => {
    expect(statements.length).toBeGreaterThan(80);
    // the known writers of encrypted columns are among them
    const files = new Set(statements.map(s => s.file));
    for (const f of [
      'services/feature-state.ts',
      'services/conversation-summarizer.ts',
      'services/partner-session-classifier.ts',
      'services/reconciler/sharing.ts',
      'services/reconciler/analysis.ts',
      'services/stage4-store.ts',
      'services/tending.service.ts',
      'services/stream-turn-actions.ts',
      'services/empathy-store.ts',
      'services/needs-share.ts',
      'controllers/consent.ts',
    ]) {
      expect(files).toContain(path.normalize(f));
    }
  });

  it('no raw statement binds an encrypted column, or content into a content-taking SQL function, in plaintext', () => {
    const violations = statements.flatMap(violationsOf);
    expect(violations).toEqual([]);
  });

  it('every raw read of an encrypted column (SELECT list, RETURNING, v_need_shared) goes through decryptRawRows', () => {
    const reads = statements
      .map(st => ({ where: `${st.file}:${st.line}`, columns: encryptedReadsOf(st), decrypted: decrypted(st) }))
      .filter(r => r.columns.length > 0);
    // the known readers are found (the scan is alive)
    expect(reads.map(r => r.where).sort()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^services\/needs-share\.ts:/),
        expect.stringMatching(/^services\/stage4-store\.ts:/),
        expect.stringMatching(/^services\/context-assembler\.ts:/),
        expect.stringMatching(/^services\/stage4-closure\.ts:/),
        expect.stringMatching(/^controllers\/stage4\.ts:/),
        expect.stringMatching(/^services\/empathy-store\.ts:/),
      ]),
    );
    expect(reads.filter(r => !r.decrypted)).toEqual([]);
  });

  it('no $executeRawUnsafe/$queryRawUnsafe statement touches an encrypted table', () => {
    const tables = Object.values(SENSITIVE_FIELD_MAP).map(c => c.table);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (['__tests__', '__mocks__', 'generated', 'testing'].includes(e.name)) continue;
          walk(p);
        } else if (e.name.endsWith('.ts')) {
          const s = fs.readFileSync(p, 'utf8');
          const re = /\$(?:executeRaw|queryRaw)Unsafe\s*\(\s*`([^`]*)`/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(s))) {
            const sql = m[1];
            const write = /\b(INSERT INTO|UPDATE)\s+"?([a-z_]+)"?/i.exec(sql);
            if (!write || !tables.includes(write[2])) continue;
            // the follow-up status move names its columns literally; none is encrypted
            const cols = [...sql.matchAll(/([a-z_]+)\s*=\s*\$/g)].map(c => c[1]);
            if (cols.some(c => isEncryptedColumn(write[2], c))) hits.push(`${path.relative(SRC, p)}: ${sql}`);
          }
        }
      }
    };
    walk(SRC);
    expect(hits).toEqual([]);
  });

  describe('the guard itself', () => {
    const st = (sql: string, exprs: string[]): RawStatement => ({ file: 'x.ts', line: 1, sql, exprs });

    it('flags a plaintext bind, a literal and a sub-select; passes the helper and EXCLUDED', () => {
      expect(
        violationsOf(st('INSERT INTO draft (participant_id, content) VALUES ($P0::uuid, $P1)', ['p', 'text'])),
      ).toEqual([{ where: 'x.ts:1', column: 'draft.content', value: '${text}' }]);
      expect(
        violationsOf(
          st(
            'INSERT INTO draft (participant_id, content) VALUES ($P0::uuid, $P1) ON CONFLICT (x) DO UPDATE SET content = EXCLUDED.content',
            ['p', "encryptColumnValue('draft', 'content', text)"],
          ),
        ),
      ).toEqual([]);
      expect(
        violationsOf(st(`INSERT INTO feature_state (user_id, doc) VALUES ($P0, '{}'::jsonb)`, ['u'])),
      ).toHaveLength(1);
      expect(
        violationsOf(
          st('INSERT INTO feature_state (user_id, doc) VALUES ($P0, $P1::jsonb)', [
            'u',
            "JSON.stringify(encryptColumnValue('feature_state', 'doc', {}))",
          ]),
        ),
      ).toEqual([]);
      expect(violationsOf(st('UPDATE proposal SET description = $P0 WHERE id = $P1', ['d', 'id']))).toHaveLength(1);
      expect(violationsOf(st('SELECT app.need_share($P0::uuid, $P1)', ['id', 'text']))).toHaveLength(1);
      expect(
        violationsOf(st("SELECT app.empathy_set_status($P0::uuid, 'REVEALED'::empathy_status, NULL::text)", ['id'])),
      ).toEqual([]);
      expect(
        violationsOf(
          st('SELECT app.empathy_set_status($P0::uuid, $P1::empathy_status, $P2::text)', ['id', 's', 'content']),
        ),
      ).toHaveLength(1);
      // a helper call for the wrong column does not count
      expect(
        violationsOf(
          st('INSERT INTO draft (participant_id, content) VALUES ($P0, $P1)', [
            'p',
            "encryptColumnValue('need', 'label', t)",
          ]),
        ),
      ).toHaveLength(1);
    });
  });
});
