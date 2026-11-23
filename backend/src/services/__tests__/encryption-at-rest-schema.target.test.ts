/**
 * work-gevt (commit f): the schema says which columns are encrypted, and it
 * says exactly what SENSITIVE_FIELD_MAP says.
 *
 *   - catalog ⇄ map, both directions: the text columns typed `ciphertext`,
 *     the text[] columns typed `ciphertext_list`, and the jsonb-domain
 *     columns whose COMMENT starts 'encrypted' are exactly the map's text,
 *     text[] and jsonb (envelope / leaves) columns; the envelope columns are
 *     exactly those typed by an envelope domain (typed domains, 2026-11-23);
 *   - every encrypted column's COMMENT starts 'encrypted (<its key class>)';
 *   - the `ciphertext` domain accepts real encrypt() output (empty, short,
 *     long, unicode plaintext) and plaintext (keyless mode), and refuses a
 *     malformed enc: envelope; app.all_ciphertext does the same per element;
 *   - a ciphertext_list column refuses a malformed element and takes a
 *     plaintext one (keyless mode), and node-postgres reads it as string[].
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

  it('ciphertext columns, ciphertext_list columns and encrypted jsonb comments equal the map', async () => {
    const typed = await run.sql<{ t: string; c: string }>(
      `SELECT c.relname AS t, a.attname AS c
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid = 'public.ciphertext'::regtype`,
    );
    const lists = await run.sql<{ t: string; c: string }>(
      `SELECT c.relname AS t, a.attname AS c
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid = 'public.ciphertext_list'::regtype`,
    );
    const jsonb = await run.sql<{ t: string; c: string }>(
      `SELECT c.relname AS t, a.attname AS c
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND (SELECT t.typbasetype FROM pg_type t WHERE t.oid = a.atttypid) = 'pg_catalog.jsonb'::regtype
          AND col_description(c.oid, a.attnum) LIKE 'encrypted%'`,
    );
    const want = (kinds: string[]) =>
      sorted(ENCRYPTED_COLUMNS.filter(e => kinds.includes(e.kind)).map(e => key(e.table, e.column)));
    expect(sorted(typed.map(r => key(r.t, r.c)))).toEqual(want(['text']));
    expect(sorted(lists.map(r => key(r.t, r.c)))).toEqual(want(['text[]']));
    expect(sorted(jsonb.map(r => key(r.t, r.c)))).toEqual(want(['jsonb-envelope', 'jsonb-leaves']));
  });

  it('an envelope domain types exactly the jsonb-envelope columns; the leaves column has the structural trigger (work-k5fk.8)', async () => {
    const enveloped = await run.sql<{ t: string; c: string }>(
      `SELECT c.relname AS t, a.attname AS c
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
          AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contypid = a.atttypid AND k.conname = 'jsonb_envelope')`,
    );
    const want = (kind: string) =>
      sorted(ENCRYPTED_COLUMNS.filter(e => e.kind === kind).map(e => key(e.table, e.column)));
    expect(sorted(enveloped.map(r => key(r.t, r.c)))).toEqual(want('jsonb-envelope'));
    expect(want('jsonb-envelope')).toHaveLength(7); // brain_activity.input and output since work-k5fk.9 (OD-1)
    const triggered = await run.sql<{ t: string }>(
      `SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = 't_doc_schema'`,
    );
    expect(want('jsonb-leaves').map(k => k.split('.')[0])).toEqual(['ai_memory']);
    expect(sorted(triggered.map(r => r.t))).toEqual(['ai_memory', 'user_preferences']);
  });

  it('an envelope holds a real encrypt() output; plaintext in the envelope is refused', async () => {
    process.env.FIELD_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const sealed = { $enc: encrypt(JSON.stringify({ entries: [] })) };
    const why = async (doc: unknown) =>
      (
        await run.sql<{ v: string | null }>(`SELECT app.jsonb_envelope_violation($1::jsonb) AS v`, [
          JSON.stringify(doc),
        ])
      )[0].v;
    expect(await why(sealed)).toBeNull();
    expect(await why({ entries: [] })).toBeNull(); // keyless: the plain document
    expect(await why({ $enc: 'my journal' })).toMatch(/plaintext in an envelope/);
    expect(await why({ ...sealed, entries: [] })).toMatch(/only key/);
    expect(await why({ $enc: 'enc:v1:not-an-envelope' })).toMatch(/malformed ciphertext/);
  });

  it('a refused envelope never reaches the client error: no DETAIL, no value in the message (review L1)', async () => {
    const [{ id }] = await run.sql<{ id: string }>(`SELECT id FROM "user" WHERE kind = 'human' ORDER BY id LIMIT 1`);
    const secret = 'MY SECRET JOURNAL';
    type PgError = { message?: string; detail?: string; hint?: string; code?: string };
    const err = await run
      .sql(`INSERT INTO feature_state (user_id, feature, doc) VALUES ($1, 'gratitude', $2::jsonb)`, [
        id,
        JSON.stringify({ $enc: secret }),
      ])
      .then(
        () => null,
        (e: unknown) => e as PgError,
      );
    expect(err?.code).toBe('23514');
    // the domain CHECK names the contract's domain and the rule, never the value (typed domains, 2026-11-23)
    expect(err?.message).toBe('value for domain feature_state_json_schema violates check constraint "jsonb_envelope"');
    expect(err?.detail).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain(secret);
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

  it('a ciphertext_list column refuses a malformed element, takes plaintext, and reads back as string[]', async () => {
    process.env.FIELD_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const [p] = await run.sql<{ session_id: string; user_id: string }>(
      `SELECT session_id, user_id FROM participant ORDER BY session_id, user_id LIMIT 1`,
    );
    const insert = (labels: (string | null)[]) =>
      run.sql<{ labels: string[] }>(
        `INSERT INTO proposal (session_id, created_by_user_id, description, unresolved_need_labels)
         VALUES ($1, $2, 'plain description', $3) RETURNING unresolved_need_labels AS labels`,
        [p.session_id, p.user_id, labels],
      );
    const sealed = encrypt('a need label');
    // keyless dev/test stores plaintext; a real envelope and a NULL element pass too
    const [{ labels }] = await insert(['plain label', sealed, null]);
    expect(labels).toEqual(['plain label', sealed, null]);
    await expect(insert(['plain label', 'enc:v1:not-an-envelope'])).rejects.toThrow(/ciphertext/);
  });
});
