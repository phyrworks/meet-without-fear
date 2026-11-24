/**
 * work-k5fk.10.31: a data migration after the baseline (docs/backend/data-model/data-migrations.md). The owner,
 * mwf_migrator, is held to FORCE ROW LEVEL SECURITY with no policy of its own, so a backfill run as it sees no row.
 * The documented pattern — a `migration_*` policy TO CURRENT_USER, created and dropped inside the one migration
 * file, then an assertion that none is left — is run here the way `prisma migrate deploy` runs a migration: as the
 * migrator, one multi-statement simple query (one implicit transaction), on a clone of NEEDS_CONFIRMED.
 *
 *   - without the pattern the migrator's UPDATE reaches no row;
 *   - with it the step reaches every row, and afterwards no policy is left and the migrator sees none again;
 *   - a failing step rolls the policy back with it;
 *   - a file that forgets the DROP is refused by its own closing assertion, and nothing of it stays.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build NEEDS_CONFIRMED
 */

import { Client } from 'pg';
import { isTargetShape } from '../../testing/golden/shape';
import { migratorUrlFor, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const OPEN = `CREATE POLICY migration_backfill_need ON need TO CURRENT_USER USING (true) WITH CHECK (true);`;
const STEP = `UPDATE need SET ai_confidence = ai_confidence;`;
const DROP = `DROP POLICY migration_backfill_need ON need;`;
const CLOSE = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname LIKE 'migration\\_%') THEN
    RAISE EXCEPTION 'a migration_ policy outlived its migration';
  END IF;
END
$$;`;

describeTarget('data migrations after the baseline: the migration-scoped policy (work-k5fk.10.31)', () => {
  let run: TargetRun;
  let needs: number;

  beforeAll(async () => {
    run = await openTargetRun('NEEDS_CONFIRMED', `k5fk1031_datamig_${process.pid}`);
    [{ n: needs }] = await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM need`);
    expect(needs).toBeGreaterThan(0);
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  /** A migration file's text as `prisma migrate deploy` sends it: one simple query, as the owner. */
  async function deploy(sql: string): Promise<Array<{ command: string; rowCount: number | null }>> {
    const c = new Client({ connectionString: migratorUrlFor(run.fx.target, run.fx.database) });
    await c.connect();
    try {
      const r = (await c.query(sql)) as unknown;
      const results = (Array.isArray(r) ? r : [r]) as Array<{ command: string; rowCount: number | null }>;
      return results.map(x => ({ command: x.command, rowCount: x.rowCount }));
    } finally {
      await c.end();
    }
  }
  const migrationPolicies = async () =>
    (await run.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policy WHERE polname LIKE 'migration\\_%'`))[0].n;

  it('the owner is held to RLS: without the pattern its backfill reaches no row', async () => {
    const [{ owner }] = await run.sql<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'need'::regclass`,
    );
    expect(owner).toBe('mwf_migrator');
    expect(await deploy(STEP)).toEqual([{ command: 'UPDATE', rowCount: 0 }]);
  });

  it('with the pattern the step reaches every row, and nothing of the policy stays', async () => {
    const results = await deploy([OPEN, STEP, DROP, CLOSE].join('\n'));
    expect(results.find(r => r.command === 'UPDATE')).toEqual({ command: 'UPDATE', rowCount: needs });
    expect(await migrationPolicies()).toBe(0);
    expect(await deploy(STEP)).toEqual([{ command: 'UPDATE', rowCount: 0 }]);
  });

  it('a failing step rolls the policy back with it (one implicit transaction)', async () => {
    await expect(deploy([OPEN, STEP, `SELECT 1 / 0;`, DROP, CLOSE].join('\n'))).rejects.toThrow(/division by zero/);
    expect(await migrationPolicies()).toBe(0);
  });

  it('a file that forgets the DROP is refused by its closing assertion, and nothing of it stays', async () => {
    await expect(deploy([OPEN, STEP, CLOSE].join('\n'))).rejects.toThrow(/outlived its migration/);
    expect(await migrationPolicies()).toBe(0);
  });
});
