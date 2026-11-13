/**
 * work-jv9y: User.email is unique case-insensitively and ignoring surrounding
 * whitespace (index on lower(btrim(email, E' \t\n\r\f'))).
 *
 * The migration that adds the index must refuse, loudly, to run over existing
 * rows that already collide case-insensitively, rather than fail on a bare
 * index error or merge accounts. This replays the migration's SQL inside a
 * rolled-back transaction with the index dropped and two colliding rows in
 * place, and checks the error it raises.
 *
 * Runs when DB_TEST_URL is set, or in CI (see app-helpers.test.ts).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const url = process.env.DB_TEST_URL ?? (process.env.CI ? process.env.DATABASE_URL : undefined);
const describeDb = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');
const MIGRATION_SUFFIX = '_user_email_case_insensitive_unique';
const INDEX = 'User_email_normalized_key';

function migrationSql(): string {
  const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith(MIGRATION_SUFFIX));
  if (!dir) throw new Error(`no migration *${MIGRATION_SUFFIX}`);
  return readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
}

describeDb('User.email case-insensitive uniqueness (database)', () => {
  let client: Client;
  const tag = `jv9y-mig-${Date.now()}`;

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  it('is enforced by the migrated database', async () => {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'User' AND indexname = $1`,
      [INDEX]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE INDEX .* \(lower\(btrim\(email, /);

    await client.query(`INSERT INTO "User" (email, "updatedAt") VALUES ($1, now())`, [`${tag}@example.test`]);
    for (const variant of [`${tag.toUpperCase()}@Example.Test`, ` ${tag}@example.test\t`, `\n${tag.toUpperCase()}@example.test `]) {
      await client.query('SAVEPOINT variant');
      await expect(
        client.query(`INSERT INTO "User" (email, "updatedAt") VALUES ($1, now())`, [variant])
      ).rejects.toThrow(new RegExp(INDEX));
      await client.query('ROLLBACK TO SAVEPOINT variant');
    }
  });

  it('migration counts padded duplicates as collisions', async () => {
    await client.query('BEGIN');
    await client.query(`DROP INDEX "${INDEX}"`);
    await client.query(`INSERT INTO "User" (email, "updatedAt") VALUES ($1, now()), ($2, now())`, [
      `${tag}-pad@example.test`,
      `  ${tag}-pad@example.test `,
    ]);

    await expect(client.query(migrationSql())).rejects.toThrow(/1 email address\(es\) are shared/);
  });

  it('migration refuses to run over rows that collide case-insensitively, naming no address', async () => {
    await client.query('BEGIN');
    await client.query(`DROP INDEX "${INDEX}"`);
    await client.query(`INSERT INTO "User" (email, "updatedAt") VALUES ($1, now()), ($2, now())`, [
      `${tag}-dup@example.test`,
      `${tag.toUpperCase()}-DUP@example.test`,
    ]);

    const err = await client.query(migrationSql()).then(
      () => undefined,
      (e: Error) => e
    );

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/user_email_case_insensitive_unique: 1 email address\(es\) are shared case-insensitively/);
    expect(err!.message).not.toContain(tag);
    expect(err!.message.toLowerCase()).not.toContain(`${tag}-dup`);
  });

  it('migration applies cleanly when no rows collide', async () => {
    await client.query('BEGIN');
    await client.query(`DROP INDEX "${INDEX}"`);
    await client.query(migrationSql());
    const { rows } = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [INDEX]);
    expect(rows).toHaveLength(1);
  });
});
