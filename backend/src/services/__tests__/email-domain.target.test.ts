/**
 * work-k5fk.5, against a real target run database: "user".email is the `email`
 * domain, whose collation `email_ci` (ICU, und-u-ks-level2, nondeterministic)
 * compares case-insensitively — so a case variant of an existing address
 * collides on the UNIQUE — while a plus-address stays a different address.
 * The tombstone CHECK compares under "C", so only the exact deleted+<id>@invalid
 * form the anonymise walk writes passes.
 *
 * Review round 1 (owner decision): the domain refuses every character email_ci
 * would fold away, so case is the only equivalence an inserted character can
 * introduce — proved below for every code point.
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, randomUuidV7, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

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

  it('user.email is typed email, and the domain carries the nondeterministic ICU collation email_ci', async () => {
    const [r] = await run.sql<{
      column_type: string;
      column_collation: string;
      domain_base: string;
      provider: string;
      locale: string;
      deterministic: boolean;
    }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS column_type, a.attcollation::regcollation::text AS column_collation,
              format_type(t.typbasetype, t.typtypmod) AS domain_base, c.collprovider::text AS provider,
              c.colllocale AS locale, c.collisdeterministic AS deterministic
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid JOIN pg_collation c ON c.oid = t.typcollation
       WHERE a.attrelid = '"user"'::regclass AND a.attname = 'email'`,
    );
    expect(r).toEqual({
      column_type: 'email',
      column_collation: 'email_ci',
      domain_base: 'text',
      provider: 'i',
      locale: 'und-u-ks-level2',
      deterministic: false,
    });
  });

  it('a case variant of an existing address collides on the UNIQUE (23505)', async () => {
    expect(await insertUser('case.test@x.test')).toBe('ok');
    expect(await insertUser('Case.Test@X.test')).toBe('23505');
    expect(await insertUser('CASE.TEST@X.TEST')).toBe('23505');
  });

  it('a plus-address is a different address: both rows are accepted', async () => {
    expect(await insertUser('plus@x.test')).toBe('ok');
    expect(await insertUser('plus+1@x.test')).toBe('ok');
    expect(await insertUser('Plus+1@x.test')).toBe('23505');
  });

  it('equality and lookups under the domain ignore case only', async () => {
    const [r] = await run.sql<Record<string, boolean>>(
      `SELECT 'User@X.com'::email = 'user@x.com'::email AS case_equal,
              'a+b@x.com'::email = 'ab@x.com'::email AS plus_equal,
              'a@x.com'::email = 'ä@x.com'::email AS accent_equal,
              (SELECT count(*) FROM "user" WHERE email = 'ADA@E2E.TEST') = 1 AS lookup_by_case_variant`,
    );
    expect(r).toEqual({ case_equal: true, plus_equal: false, accent_equal: false, lookup_by_case_variant: true });
  });

  it('the length CHECK stays: 254 characters pass, 255 are refused (23514)', async () => {
    const local = (n: number) => 'l'.repeat(n - '@x.test'.length) + '@x.test';
    expect(await insertUser(local(254))).toBe('ok');
    expect(await insertUser(local(255))).toBe('23514');
  });

  it('LIKE works under the nondeterministic collation (PG18) and is case-insensitive there', async () => {
    const [r] = await run.sql<Record<string, boolean>>(
      `SELECT 'DELETED+x@invalid'::email LIKE 'deleted+%' AS like_ci, 'DELETED+x@invalid'::email COLLATE "C" LIKE 'deleted+%' AS like_c`,
    );
    expect(r).toEqual({ like_ci: true, like_c: false });
  });

  it.each([
    ['~', `email ~ 'a'`, 'regular expressions'],
    ['~*', `email ~* 'a'`, 'regular expressions'],
    ['SIMILAR TO', `email SIMILAR TO 'a%'`, 'regular expressions'],
    ['substring from a regex', `substring(email from 'a') IS NULL`, 'regular expressions'],
    ['regexp_replace', `regexp_replace(email, 'a', 'b') = ''`, 'regular expressions'],
    ['ILIKE', `email ILIKE 'a%'`, 'ILIKE'],
    ['starts_with', `starts_with(email, 'a')`, 'substring searches'],
    ['^@', `email ^@ 'a'`, 'substring searches'],
  ])('%s on an email is refused under email_ci', async (_name, predicate, what) => {
    await expect(run.sql(`SELECT 1 FROM "user" WHERE ${predicate}`)).rejects.toThrow(
      new RegExp(`nondeterministic collations are not supported for ${what}`),
    );
  });

  it('position / strpos / replace / split_part work on an email (PG18) and match case-insensitively; COLLATE "C" makes a regex legal', async () => {
    const [r] = await run.sql<Record<string, unknown>>(
      `SELECT position('x' in e) AS pos, strpos(e, 'x') AS strpos, replace(e, 'x', 'y') AS replaced,
              split_part(e, '@', 2) AS domain, e COLLATE "C" ~ '^A@' AS regex_c
       FROM (SELECT 'A@X.COM'::email AS e) t`,
    );
    expect(r).toEqual({ pos: 3, strpos: 3, replaced: 'A@y.COM', domain: 'X.COM', regex_c: true });
  });

  it('the collation is ICU-versioned (REFRESH VERSION after an ICU change, infra/aws/README.md)', async () => {
    const [r] = await run.sql<{ recorded: string | null; actual: string | null }>(
      `SELECT collversion AS recorded, pg_collation_actual_version(oid) AS actual FROM pg_collation WHERE collname = 'email_ci'`,
    );
    expect(r.recorded).toMatch(/^\d+(\.\d+)*$/);
    expect(r.actual).toBe(r.recorded);
  });

  it('the tombstone CHECK accepts exactly deleted+<id>@invalid (compared under "C"): not a case variant, not the old form, not a live address', async () => {
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

  /** Is the text a valid email (every domain CHECK passes)? */
  async function valid(text: string): Promise<boolean> {
    const [r] = await run.sql<{ ok: boolean }>(`SELECT pg_input_is_valid($1, 'email') AS ok`, [text]);
    return r.ok;
  }

  const cp = (n: number) => String.fromCodePoint(n);
  // The reviewer's rows (review round 1): each one is equal under email_ci to the plain address
  // beside it (except the trailing space, which is simply refused), so the domain refuses it.
  it.each([
    ['U+200B zero-width space', `a${cp(0x200b)}@x.com`, 'a@x.com'],
    ['U+00AD soft hyphen', `a${cp(0xad)}@x.com`, 'a@x.com'],
    ['U+200D zero-width joiner', `a${cp(0x200d)}@x.com`, 'a@x.com'],
    ['U+0001 control', `a${cp(0x1)}@x.com`, 'a@x.com'],
    ['leading U+202E right-to-left override', `${cp(0x202e)}a@x.com`, 'a@x.com'],
    ['trailing U+FE0F variation selector (Mn)', `a@x.com${cp(0xfe0f)}`, 'a@x.com'],
    ['fullwidth a', `${cp(0xff41)}@x.com`, 'a@x.com'],
    ['fullwidth @', `a${cp(0xff20)}x.com`, 'a@x.com'],
    ['fullwidth .', `a@x${cp(0xff0e)}com`, 'a@x.com'],
    ['circled a', `${cp(0x24d0)}@x.com`, 'a@x.com'],
    ['Kelvin sign', `a${cp(0x212a)}@x.com`, 'ak@x.com'],
    ['superscript two', `a${cp(0xb2)}@x.com`, 'a2@x.com'],
    ['ligature fi', `${cp(0xfb01)}@x.com`, 'fi@x.com'],
    ['U+0640 Arabic tatweel (ignorable, not Cf)', `a${cp(0x640)}@x.com`, 'a@x.com'],
    ['U+0591 Hebrew accent (ignorable combining mark)', `a${cp(0x591)}@x.com`, 'a@x.com'],
    ['trailing space', 'a@x.com ', null],
  ])('refused: %s', async (_name, text, foldsTo) => {
    if (foldsTo) {
      const [r] = await run.sql<{ folds: boolean }>(`SELECT $1 COLLATE email_ci = $2 AS folds`, [text, foldsTo]);
      expect(r.folds).toBe(true);
      expect(await valid(foldsTo)).toBe(true);
    }
    expect(await valid(text)).toBe(false);
  });

  it.each([
    ['no @', 'ab'],
    ['two @', 'a@b@x.com'],
    ['empty local part', '@x.com'],
    ['empty domain', 'a@'],
  ])('refused by the shape CHECK: %s', async (_name, text) => {
    expect(await valid(text)).toBe(false);
  });

  it('accepted and still distinct: plus-address, accents, ß / ss, İ / i, a non-ASCII address', async () => {
    for (const t of ['a+1@x.com', 'ä@x.com', 'ß@x.com', 'ss@x.com', 'İ@x.com', 'i@x.com', 'josé@exämple.test'])
      expect(await valid(t)).toBe(true);
    const [r] = await run.sql<Record<string, boolean>>(
      `SELECT 'a+1@x.com'::email = 'a@x.com' AS plus, 'ä@x.com'::email = 'a@x.com' AS accent,
              'ß@x.com'::email = 'ss@x.com' AS sharp_s, 'İ@x.com'::email = 'i@x.com' AS dotted_i`,
    );
    expect(r).toEqual({ plus: false, accent: false, sharp_s: false, dotted_i: false });
  });

  it('the domain carries its named CHECKs', async () => {
    const rows = await run.sql<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE contypid = 'email'::regtype ORDER BY conname`,
    );
    expect(rows.map(r => r.conname)).toEqual([
      'email_assigned',
      'email_length',
      'email_nfkc',
      'email_no_format',
      'email_no_ignorable',
      'email_no_space_control',
      'email_shape',
    ]);
  });

  // The property (review round 1): for EVERY code point c (1..0x10FFFF, no surrogates), placed
  // before the local part, before the @, inside the domain or at its end, the address is either
  // refused by the domain, case-equal to 'a@x.test', or different from it under email_ci. Measured
  // ~3 s for the 4 × 1,112,063 strings on the dev container.
  it('exhaustive: no accepted code point folds into a@x.test beyond case, in any of four positions', async () => {
    const rows = await run.sql<{ pos: string; cp: string }>(
      `SELECT t.pos, to_hex(c) AS cp
       FROM generate_series(1, 1114111) AS c,
            LATERAL (VALUES ('lead', chr(c) || 'a@x.test'), ('before_at', 'a' || chr(c) || '@x.test'),
                            ('in_domain', 'a@x' || chr(c) || '.test'), ('end', 'a@x.test' || chr(c))) AS t(pos, s)
       WHERE c NOT BETWEEN 55296 AND 57343
         AND t.s COLLATE email_ci = 'a@x.test'
         AND lower(t.s COLLATE "C") <> 'a@x.test'
         AND pg_input_is_valid(t.s, 'email')`,
    );
    expect(rows).toEqual([]);
  });

  // FINDING (owner decision pending): two DIFFERENT accepted characters can still be equal at
  // level 2 without being case variants — every script's digit one, hiragana and katakana, some
  // combining marks. Pinned so a change (an ICU upgrade, a tighter CHECK) shows up here.
  it('FINDING, pinned: accepted single characters that are equal under email_ci but not case variants', async () => {
    const [r] = await run.sql<{ classes: number; one: boolean; kana: boolean }>(
      `WITH acc AS (
         SELECT chr(c) AS ch FROM generate_series(1, 1114111) AS c
         WHERE c NOT BETWEEN 55296 AND 57343 AND pg_input_is_valid('a' || chr(c) || '@x.test', 'email'))
       SELECT (SELECT count(*)::int FROM (
                 SELECT 1 FROM acc GROUP BY ch COLLATE email_ci
                 HAVING count(DISTINCT casefold(ch COLLATE pg_unicode_fast) COLLATE "C") > 1) x) AS classes,
              'a1@x.test'::email = ('a' || chr(1633) || '@x.test')::email AS one,
              (chr(12354) || '@x.test')::email = (chr(12450) || '@x.test')::email AS kana`,
    );
    expect(r).toEqual({ classes: 417, one: true, kana: true });
  });
});
