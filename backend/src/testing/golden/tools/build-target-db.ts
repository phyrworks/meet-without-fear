/**
 * Build a target-shape database from the baseline (`../target-baseline.ts`).
 *
 *   npx tsx src/testing/golden/tools/build-target-db.ts mwf_trun_scratch [--replace]
 *
 * Only mwf_tfx_* and mwf_trun_* are accepted. The dev databases
 * (mwf_target_dev/test/shadow) are built by TS-7c's
 * `backend/scripts/target-shape/run-baseline.sh --dev`, never by this tool.
 * An existing database is left alone unless --replace is given.
 */
import { buildTargetDatabase } from '../target-baseline';
import { databaseExists, parseDbUrl } from '../db';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const names = args.filter(a => !a.startsWith('--'));
  const base = parseDbUrl(
    process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/postgres',
  );
  for (const name of names) {
    if (!replace && (await databaseExists(base, name))) {
      console.log(`${name}: exists, left alone (pass --replace to rebuild)`);
      continue;
    }
    const { source } = await buildTargetDatabase(base, name);
    console.log(`${name}: built from ${source}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
