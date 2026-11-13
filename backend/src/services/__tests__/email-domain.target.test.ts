/**
 * work-k5fk.5, against a real target run database: "user".email is the `email`
 * domain — one canonical form (trimmed, NFC, lowercased: shared canonicalEmail())
 * compared exactly (owner decision, review round 2: no ICU collation). The
 * database refuses a value that is not canonical rather than rewriting it, so
 * case is the only equivalence and it never reaches the table. A plus-address,
 * an accent, ß, a fullwidth form, another script's digit and kana stay distinct.
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
import { canonicalEmail, foldEmail } from '@meet-without-fear/shared';
import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

/** Independent of tables.sql: the Unicode properties email_no_format and email_no_space_control encode. */
const FORMAT = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const SPACE_CONTROL = /[\p{White_Space}\p{Cc}]/u;

const cp = (n: number) => String.fromCodePoint(n);

describeTarget('the email domain (target)', () => {
  let run: TargetRun;

  beforeAll(async () => {
    run = await openTargetRun('FEEL_HEARD_B', `email_${process.pid}`);
  });
  afterAll(async () => {
    await run?.drop();
  });

  /** Insert a user with this email: 'ok' or the SQLSTATE it is refused with. */
  async function insertUser(email: string): Promise<string> {
    try {
      await run.sql(`INSERT INTO "user" (id, email) VALUES ($1, $2)`, [randomUuidV7(), email]);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  }

  /** Is the text a valid email (every domain CHECK passes)? */
  async function valid(text: string): Promise<boolean> {
    const [r] = await run.sql<{ ok: boolean }>(`SELECT pg_input_is_valid($1, 'email') AS ok`, [text]);
    return r.ok;
  }

  /** Are the two (valid) emails equal as stored? */
  async function same(a: string, b: string): Promise<boolean> {
    const [r] = await run.sql<{ eq: boolean }>(`SELECT $1::email = $2::email AS eq`, [a, b]);
    return r.eq;
  }

  it('user.email is typed email over text, with the deterministic default collation (no ICU collation)', async () => {
    const [r] = await run.sql<Record<string, unknown>>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS column_type, format_type(t.typbasetype, t.typtypmod) AS domain_base,
              t.typcollation = 'pg_catalog.default'::regcollation AS default_collation,
              (SELECT collisdeterministic FROM pg_collation WHERE oid = a.attcollation) AS deterministic,
              (SELECT count(*)::int FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
               WHERE n.nspname IN ('public', 'app')) AS own_collations
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
       WHERE a.attrelid = '"user"'::regclass AND a.attname = 'email'`,
    );
    expect(r).toEqual({ column_type: 'email', domain_base: 'text', default_collation: true, deterministic: true, own_collations: 0 });
  });

  it('the domain carries its eight named CHECKs', async () => {
    const rows = await run.sql<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE contypid = 'email'::regtype ORDER BY conname`,
    );
    expect(rows.map(r => r.conname)).toEqual([
      'email_assigned',
      'email_canonical',
      'email_length',
      'email_nfc',
      'email_no_final_sigma',
      'email_no_format',
      'email_no_space_control',
      'email_shape',
    ]);
  });

  it('only the canonical form is accepted: A@x.test is refused (23514), a@x.test accepted — the DB never rewrites', async () => {
    expect(await insertUser('A@x.test')).toBe('23514');
    expect(await insertUser('a@x.test')).toBe('ok');
    expect(await insertUser(' a2@x.test')).toBe('23514');
    // the writer canonicalizes, so a case variant is the same row
    expect(await insertUser(canonicalEmail('Case.Test@X.test'))).toBe('ok');
    expect(await insertUser(canonicalEmail('CASE.TEST@X.TEST'))).toBe('23505');
  });

  it('a plus-address is a different address', async () => {
    expect(await insertUser('plus@x.test')).toBe('ok');
    expect(await insertUser('plus+1@x.test')).toBe('ok');
  });

  it('the length CHECK stays: 254 characters pass, 255 are refused (23514)', async () => {
    const local = (n: number) => 'l'.repeat(n - '@x.test'.length) + '@x.test';
    expect(await insertUser(local(254))).toBe('ok');
    expect(await insertUser(local(255))).toBe('23514');
  });

  it.each([
    ['no @', 'ab'],
    ['two @', 'a@b@x.com'],
    ['empty local part', '@x.com'],
    ['empty domain', 'a@'],
  ])('refused by the shape CHECK: %s', async (_name, text) => {
    expect(await valid(text)).toBe(false);
  });

  it('nothing folds but case: other digits, kana, ß, fullwidth, ﬁ and ² are valid and distinct', async () => {
    const pairs: Array<[string, string]> = [
      ['a1@x.test', `a${cp(0x661)}@x.test`], // ARABIC-INDIC DIGIT ONE
      ['a1@x.test', `a${cp(0x967)}@x.test`], // DEVANAGARI DIGIT ONE
      [`${cp(0x3042)}@x.test`, `${cp(0x30a2)}@x.test`], // あ / ア
      ['ß@x.test', 'ss@x.test'],
      ['a@x.test', `${cp(0xff41)}@x.test`], // fullwidth a
      ['fi@x.test', `${cp(0xfb01)}@x.test`], // ligature fi (NFC keeps it; NFKC would not)
      ['a2@x.test', `a${cp(0xb2)}@x.test`], // superscript two
      ['ä@x.test', 'a@x.test'],
    ];
    for (const [a, b] of pairs) {
      expect([a, await valid(a)]).toEqual([a, true]);
      expect([b, await valid(b)]).toEqual([b, true]);
      expect([a, b, await same(a, b)]).toEqual([a, b, false]);
    }
  });

  it('internationalized addresses are accepted: Devanagari (combining vowel signs and virama), an NFC combining mark', async () => {
    const devanagari = 'नमस्ते@उदाहरण.भारत';
    expect(devanagari.normalize('NFC')).toBe(devanagari);
    expect(await valid(devanagari)).toBe(true);
    const combining = `a${cp(0x331)}@x.test`; // a + COMBINING MACRON BELOW: no precomposed form, so NFC keeps it
    expect(combining.normalize('NFC')).toBe(combining);
    expect(await valid(combining)).toBe(true);
    // a decomposed é is not NFC: refused; its canonical (composed) form is accepted
    expect(await valid('jose\u0301@x.test')).toBe(false);
    expect(await valid(canonicalEmail('jose\u0301@x.test'))).toBe(true);
  });

  it('İ: the CHECK lowers under pg_unicode_fast, which agrees with JavaScript (i + U+0307); the libc default would not', async () => {
    const [r] = await run.sql<Record<string, string>>(
      `SELECT encode(convert_to(lower('İ' COLLATE pg_unicode_fast), 'UTF8'), 'hex') AS unicode,
              encode(convert_to(lower('İ'), 'UTF8'), 'hex') AS db_default`,
    );
    expect(r.unicode).toBe(Buffer.from('İ'.toLowerCase()).toString('hex'));
    expect(r.unicode).toBe('69cc87');
    expect(r.db_default).toBe('69'); // en_US libc: why the CHECK names its collation
    expect(await valid('İ@x.test')).toBe(false);
    expect(await valid(canonicalEmail('İ@x.test'))).toBe(true);
    // final sigma: ς is refused, and the fold maps ΑΣ / ας / ασ to one address
    expect(await valid('ας@x.test')).toBe(false);
    expect(canonicalEmail('ΑΣ@x.test')).toBe('ασ@x.test');
    expect(canonicalEmail('ας@x.test')).toBe('ασ@x.test');
    expect(await valid(canonicalEmail('ΑΣ@x.test'))).toBe(true);
  });

  // canonicalEmail() (JS) and email_canonical (PG) must agree on every character the domain can
  // hold. PostgreSQL 18.6 carries Unicode 16 and Node 20 Unicode 17: the code points new in 17
  // (e.g. U+A7CE, U+16EA0…) lowercase in JS but are unassigned to PG, and email_assigned refuses
  // them — so the address fails closed instead of being stored in two forms. Compared over every
  // code point PostgreSQL considers assigned.
  it('exhaustive: lower() under pg_unicode_fast and JavaScript toLowerCase agree on every assigned code point', async () => {
    const rows = await run.sql<{ c: number; l: string }>(
      `SELECT c, lower(chr(c) COLLATE pg_unicode_fast) AS l FROM generate_series(1, 1114111) AS c
       WHERE c NOT BETWEEN 55296 AND 57343 AND unicode_assigned(chr(c))`,
    );
    const mismatches: string[] = [];
    for (const { c, l: pg } of rows) {
      const js = cp(c).toLowerCase();
      if (js !== pg) mismatches.push(c.toString(16));
    }
    expect(rows.length).toBeGreaterThan(290_000);
    expect(mismatches).toEqual([]);
  });

  it('regex, ILIKE and prefix searches work again on the (deterministic) column', async () => {
    const [r] = await run.sql<Record<string, unknown>>(
      `SELECT e ~ '^ada@' AS regex, e ILIKE 'ADA@%' AS ilike, starts_with(e, 'ada') AS starts, e ^@ 'ada' AS prefix,
              e SIMILAR TO 'ada%' AS similar, regexp_replace(e, '@.*', '') AS local
       FROM (SELECT email AS e FROM "user" WHERE email = 'ada@e2e.test') t`,
    );
    expect(r).toEqual({ regex: true, ilike: true, starts: true, prefix: true, similar: true, local: 'ada' });
  });

  it.each([
    ['U+200B zero-width space', `a${cp(0x200b)}@x.com`],
    ['U+00AD soft hyphen', `a${cp(0xad)}@x.com`],
    ['U+200D zero-width joiner', `a${cp(0x200d)}@x.com`],
    ['U+0001 control', `a${cp(0x1)}@x.com`],
    ['leading U+202E right-to-left override', `${cp(0x202e)}a@x.com`],
    ['trailing U+FE0F variation selector', `a@x.com${cp(0xfe0f)}`],
    ['trailing space', 'a@x.com '],
    ['Kelvin sign (not lowercase: lower() maps it to k)', `a${cp(0x212a)}@x.com`],
    ['U+03C2 final sigma (folded to σ)', `a${cp(0x3c2)}@x.com`],
  ])('refused: %s', async (_name, text) => {
    expect(await valid(text)).toBe(false);
  });

  // Review round 2: independent of the constraint's own list. Over every code point PostgreSQL
  // considers assigned (Node 20 knows Unicode 17, PG 18.6 Unicode 16; the others are refused by
  // email_assigned anyway), the format CHECK refuses exactly JavaScript's \p{Cf} ∪
  // \p{Default_Ignorable_Code_Point}, and the space/control CHECK exactly \p{White_Space} ∪ \p{Cc}.
  it('exhaustive: email_no_format = \\p{Cf} ∪ \\p{Default_Ignorable_Code_Point}, email_no_space_control = \\p{White_Space} ∪ \\p{Cc}', async () => {
    const [def] = await run.sql<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contypid = 'email'::regtype AND conname = 'email_no_format'`,
    );
    const cls = /'(\[.*\])'/.exec(def.def)![1];
    const rows = await run.sql<{ c: number; fmt: boolean; sc: boolean }>(
      `SELECT c, chr(c) COLLATE "C" ~ $1 AS fmt, chr(c) COLLATE pg_c_utf8 ~ '[[:space:][:cntrl:]]' AS sc
       FROM generate_series(1, 1114111) AS c
       WHERE c NOT BETWEEN 55296 AND 57343 AND unicode_assigned(chr(c))`,
      [cls],
    );
    expect(rows.length).toBeGreaterThan(290_000);
    const fmt: string[] = [];
    const sc: string[] = [];
    for (const r of rows) {
      if (r.fmt !== FORMAT.test(cp(r.c))) fmt.push(r.c.toString(16));
      if (r.sc !== SPACE_CONTROL.test(cp(r.c))) sc.push(r.c.toString(16));
    }
    expect({ fmt, sc }).toEqual({ fmt: [], sc: [] });
  });

  // Review round 2: lowercasing can un-normalize (J + U+030C → j + U+030C, NFC U+01F0), which
  // the single-code-point tests could not see. Every letter (\p{L}) PostgreSQL considers assigned,
  // followed by every combining mark (\p{Mn}) it considers assigned: canonicalEmail() is idempotent
  // and its output passes every domain CHECK. Letters that are neither cased nor the first code
  // point of some canonical decomposition are skipped: for them l + m is unchanged by the fold
  // (nothing to lowercase, nothing to compose with) and is a starter followed by one mark, already
  // NFC — so the pair cannot exercise the fold. That leaves every pair that can.
  it('exhaustive: every letter × every combining mark canonicalizes to a valid, stable value', async () => {
    const assigned = (await run.sql<{ c: number }>(
      `SELECT c FROM generate_series(1, 1114111) AS c WHERE c NOT BETWEEN 55296 AND 57343 AND unicode_assigned(chr(c))`,
    )).map(r => r.c);
    // Marks and letters the domain refuses on their own (variation selectors, CGJ, Hangul fillers:
    // default-ignorable) are left out: refusing them is email_no_format's job, tested above.
    const marks = assigned.filter(c => /\p{Mn}/u.test(cp(c)) && !FORMAT.test(cp(c)));
    const starters = new Set<number>();
    for (const c of assigned) {
      const d = cp(c).normalize('NFD');
      if (d !== cp(c)) starters.add(d.codePointAt(0)!);
    }
    const letters = assigned.filter(c => {
      if (!/\p{L}/u.test(cp(c)) || FORMAT.test(cp(c))) return false;
      const ch = cp(c);
      return starters.has(c) || ch.toLowerCase() !== ch || ch.toUpperCase() !== ch;
    });
    expect(marks.length).toBeGreaterThan(1700);
    expect(letters.length).toBeGreaterThan(2500);
    const unstable: string[] = [];
    const outs = new Set<string>();
    for (const l of letters)
      for (const m of marks) {
        const c1 = canonicalEmail(`${cp(l)}${cp(m)}@x.test`);
        if (canonicalEmail(c1) !== c1) unstable.push(`${l.toString(16)}+${m.toString(16)}`);
        outs.add(c1);
      }
    expect(unstable).toEqual([]);
    const all = [...outs];
    const refused: string[] = [];
    for (let i = 0; i < all.length; i += 100_000) {
      const bad = await run.sql<{ e: string }>(
        `SELECT e FROM unnest($1::text[]) AS e WHERE NOT pg_input_is_valid(e, 'email')`,
        [all.slice(i, i + 100_000)],
      );
      for (const r of bad) refused.push([...r.e].slice(0, 3).map(ch => ch.codePointAt(0)!.toString(16)).join('+'));
    }
    expect({ pairs: letters.length * marks.length > 4_000_000, refused: refused.slice(0, 20), n: refused.length }).toEqual({
      pairs: true,
      refused: [],
      n: 0,
    });
  }, 600_000);

  it('J + U+030C and İ + U+0316: the canonical form is NFC, accepted and stable', async () => {
    for (const raw of ['J\u030C@x.test', 'İ\u0316@x.test']) {
      const c = canonicalEmail(raw);
      expect(c.normalize('NFC')).toBe(c);
      expect(canonicalEmail(c)).toBe(c);
      expect([raw, await valid(c)]).toEqual([raw, true]);
    }
    expect(canonicalEmail('J\u030C@x.test')).toBe('\u01F0@x.test');
    expect(foldEmail('J\u030C')).toBe('\u01F0');
  });

  it('the tombstone CHECK accepts exactly deleted+<id>@invalid: not a case variant, not the old form, not a live address', async () => {
    const tombstone = async (email: string) => {
      const id = randomUuidV7();
      await run.sql(`INSERT INTO "user" (id, email, clerk_id) VALUES ($1, $2, $3)`, [id, `t-${id}@x.test`, `c-${id}`]);
      try {
        await run.sql(`UPDATE "user" SET clerk_id = NULL, deleted_at = now(), email = replace($2, '<id>', $1::text) WHERE id = $1`, [
          id,
          email,
        ]);
        return 'ok';
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
    };
    expect(await tombstone('deleted+<id>@invalid')).toBe('ok');
    expect(await tombstone('Deleted+<id>@invalid')).toBe('23514');
    expect(await tombstone('deleted+<id>@INVALID')).toBe('23514');
    expect(await tombstone('deleted+<id>')).toBe('23514');
    expect(await tombstone('<id>@x.test')).toBe('23514');
  });
});
