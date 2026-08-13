/**
 * Golden harness CLI.
 *
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 *   npx tsx src/testing/golden/cli.ts restore FEEL_HEARD_B --keep
 *   npx tsx src/testing/golden/cli.ts list
 */

import 'dotenv/config';
import { buildFixture, readManifest, restoreFixture, fixtureDbName } from './fixtures';
import { parseDbUrl, databaseExists, tableCounts } from './db';

function baseUrl(): string {
  const url = process.env.GOLDEN_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (or GOLDEN_DATABASE_URL) first.');
  return url;
}

async function cmdBuild(stage: string): Promise<void> {
  if (!stage) throw new Error('Usage: cli.ts build <TargetStage>');
  process.stdout.write(`Building fixture for ${stage}...\n`);
  const m = await buildFixture({ baseUrl: baseUrl(), stage });
  process.stdout.write(`\n  database : ${m.database}\n`);
  process.stdout.write(`  session  : ${m.seeded.sessionId}\n`);
  process.stdout.write(`  userA    : ${m.seeded.userA.email} (${m.seeded.userA.id})\n`);
  if (m.seeded.userB) {
    process.stdout.write(`  userB    : ${m.seeded.userB.email} (${m.seeded.userB.id})\n`);
  }
  process.stdout.write(`  tables   : ${m.tables.length} in schema, ${Object.keys(m.counts).length} populated\n`);
  const top = Object.entries(m.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  for (const [t, n] of top) process.stdout.write(`             ${t}: ${n}\n`);
}

async function cmdRestore(stage: string, keep: boolean): Promise<void> {
  const runId = `cli_${Date.now().toString(36)}`;
  const r = await restoreFixture({ baseUrl: baseUrl(), stage, runId });
  const counts = await tableCounts(r.target, r.database);
  process.stdout.write(`Restored ${stage} -> ${r.database}\n`);
  process.stdout.write(`  populated tables: ${Object.keys(counts).length}\n`);
  process.stdout.write(`  url: ${r.url}\n`);
  if (keep) {
    process.stdout.write(`  (kept — drop with: DROP DATABASE "${r.database}")\n`);
  } else {
    await r.drop();
    process.stdout.write('  dropped\n');
  }
}

async function cmdList(): Promise<void> {
  const t = parseDbUrl(baseUrl());
  const stages = [
    'CREATED',
    'INVITATION_READY',
    'EMPATHY_SHARED_A',
    'FEEL_HEARD_B',
    'RECONCILER_SHOWN_B',
    'CONTEXT_SHARED_B',
    'EMPATHY_REVEALED',
    'NEED_MAPPING_COMPLETE',
    'STRATEGIC_REPAIR_COMPLETE',
    'STAGE4_REDESIGN_INVENTORY',
    'STAGE4_REDESIGN_SHARED_SELECTIONS',
    'STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS',
    'STAGE4_REDESIGN_PARTNER_INACTIVE',
  ];
  for (const s of stages) {
    const db = fixtureDbName(s);
    const exists = await databaseExists(t, db);
    let built = '';
    try {
      built = readManifest(s).builtAt.slice(0, 19).replace('T', ' ');
    } catch {
      built = '—';
    }
    process.stdout.write(`  ${exists ? '✓' : ' '} ${s.padEnd(38)} ${built}\n`);
  }
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const keep = process.argv.includes('--keep');
  switch (cmd) {
    case 'build':
      return cmdBuild(arg);
    case 'restore':
      return cmdRestore(arg, keep);
    case 'list':
      return cmdList();
    default:
      process.stdout.write('Commands: build <stage> | restore <stage> [--keep] | list\n');
      process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: Error) => {
    process.stderr.write(`\nFAILED: ${e.message}\n`);
    process.exit(1);
  });
