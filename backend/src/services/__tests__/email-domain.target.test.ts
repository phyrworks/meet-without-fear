/**
 * work-k5fk.5, against a real target run database: "user".email is the `email`
 * domain, whose collation `email_ci` (ICU, und-u-ks-level2, nondeterministic)
 * compares case-insensitively — so a case variant of an existing address
 * collides on the UNIQUE — while a plus-address stays a different address.
 * The tombstone CHECK compares under "C", so only the exact deleted+<id> form
 * the anonymise walk writes passes.
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
      `SELECT 'DELETED+x'::email LIKE 'deleted+%' AS like_ci, 'DELETED+x'::email COLLATE "C" LIKE 'deleted+%' AS like_c`,
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

  it('the tombstone CHECK accepts exactly deleted+<id> (compared under "C"): not a case variant, not a live address', async () => {
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
    expect(await tombstone('deleted+<id>')).toBe('ok');
    expect(await tombstone('Deleted+<id>')).toBe('23514');
    expect(await tombstone('<id>@x.test')).toBe('23514');
  });
});
