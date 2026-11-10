/**
 * work-gevt (commit f): the schema says which columns are encrypted, and it
 * says exactly what SENSITIVE_FIELD_MAP says.
 *
 *   - catalog ⇄ map, both directions: the text columns typed `ciphertext`,
 *     the text[] columns with CHECK (app.all_ciphertext(col)), and the jsonb
 *     columns whose COMMENT starts 'encrypted' are exactly the map's text,
 *     text[] and jsonb (envelope / leaves) columns;
 *   - every encrypted column's COMMENT starts 'encrypted (<its key class>)';
 *   - the `ciphertext` domain accepts real encrypt() output (empty, short,
 *     long, unicode plaintext) and plaintext (keyless mode), and refuses a
 *     malformed enc: envelope; app.all_ciphertext does the same per element.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { ENCRYPTED_COLUMNS } from './encryption-at-rest';
import { SENSITIVE_FIELD_MAP } from '../../lib/prisma-encryption-middleware';
import { encrypt } from '../../utils/field-encryption';
import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

const key = (t: string, c: string) => `${t}.${c}`;
const sorted = (xs: Iterable<string>) => [...xs].sort();

describeTarget('the schema marks exactly the SENSITIVE_FIELD_MAP columns as encrypted', () => {
  let run: TargetRun;

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `gevt_cipher_${process.pid}`);
  });
  afterAll(async () => {
    await run?.drop();
  });

  it('ciphertext columns, all_ciphertext CHECKs and encrypted jsonb comments equal the map', async () => {
    const typed = await run.sql<{ t: string; c: string }>(
      `SELECT c.relname AS t, a.attname AS c
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid = 'public.ciphertext'::regtype`,
    );
    const checked = await run.sql<{ t: string; c: string }>(
      `SELECT k.conrelid::regclass::text AS t,
              substring(pg_get_constraintdef(k.oid) FROM 'app\\.all_ciphertext\\(([a-z_]+)\\)') AS c
         FROM pg_constraint k
        WHERE k.contype = 'c' AND pg_get_constraintdef(k.oid) ~ 'app\\.all_ciphertext\\('`,
    );
    const jsonb = await run.sql<{ t: string; c: string }>(
      `SELECT c.relname AS t, a.attname AS c
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid = 'pg_catalog.jsonb'::regtype
          AND col_description(c.oid, a.attnum) LIKE 'encrypted%'`,
    );
    const want = (kinds: string[]) =>
      sorted(ENCRYPTED_COLUMNS.filter(e => kinds.includes(e.kind)).map(e => key(e.table, e.column)));
    expect(sorted(typed.map(r => key(r.t, r.c)))).toEqual(want(['text']));
    expect(sorted(checked.map(r => key(r.t, r.c)))).toEqual(want(['text[]']));
    expect(sorted(jsonb.map(r => key(r.t, r.c)))).toEqual(want(['jsonb-envelope', 'jsonb-leaves']));
  });

  it("every encrypted column's comment names its key class", async () => {
    const comments = await run.sql<{ t: string; c: string; d: string | null }>(
      `SELECT c.relname AS t, a.attname AS c, col_description(c.oid, a.attnum) AS d
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0`,
    );
    const byCol = new Map(comments.map(r => [key(r.t, r.c), r.d]));
    const bad: string[] = [];
    for (const cfg of Object.values(SENSITIVE_FIELD_MAP))
      for (const f of Object.values(cfg.fields)) {
        const d = byCol.get(key(cfg.table, f.column)) ?? '';
        if (!d.startsWith(`encrypted (${f.key}): `)) bad.push(`${key(cfg.table, f.column)}: ${d}`);
      }
    expect(bad).toEqual([]);
  });

  it('the ciphertext domain accepts real encrypt() output and plaintext, and refuses a malformed envelope', async () => {
    process.env.FIELD_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const plain = ['', 'a', 'ab', 'abc', 'x'.repeat(5000), 'Grüße, 日本語, emoji 🙂 and a newline\n'];
    for (const p of plain) {
      const sealed = encrypt(p);
      expect(sealed.startsWith('enc:v1:')).toBe(true);
      const [{ v }] = await run.sql<{ v: string }>(`SELECT $1::ciphertext AS v`, [sealed]);
      expect(v).toBe(sealed);
      const [{ ok }] = await run.sql<{ ok: boolean }>(`SELECT app.all_ciphertext($1::text[]) AS ok`, [[sealed, null]]);
      expect(ok).toBe(true);
    }
    // keyless dev/test stores plaintext; NULL passes
    for (const p of ['plain words', 'encrypted? no', null]) {
      await expect(run.sql(`SELECT $1::ciphertext AS v`, [p])).resolves.toBeDefined();
    }
    const good = encrypt('hello');
    const [iv, tag, ct] = good.slice('enc:v1:'.length).split(':');
    const malformed = [
      'enc:v1:not-an-envelope',
      `enc:v2:${iv}:${tag}:${ct}`,
      `enc:v1:${iv}x:${tag}:${ct}`,
      `enc:v1:${iv}:${tag.slice(0, -2)}:${ct}`,
      `enc:v1:${iv}:${tag}:${ct}=`,
      `enc:v1:${iv}:${tag}:${ct}:extra`,
    ];
    for (const m of malformed) {
      await expect(run.sql(`SELECT $1::ciphertext AS v`, [m])).rejects.toThrow(/ciphertext/);
      await expect(run.sql(`SELECT app.all_ciphertext($1::text[])`, [[good, m]])).rejects.toThrow(/ciphertext/);
    }
  });
});
