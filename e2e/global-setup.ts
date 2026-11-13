import { FullConfig } from '@playwright/test';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Global setup for the dev-server configs (playwright.config.ts,
 * playwright.two-browser.config.ts via prepare-database.ts, live-ai).
 *
 * Target shape (phoenix/target-shape): the database is the branch's test
 * database (docs/development/local-setup.md, "Working on phoenix/target-shape":
 * mwf_target_e2e, dedicated to this harness so backend jest suites sharing
 * mwf_target_test are never truncated) built by the single baseline migration. Setup empties every
 * application table — all of schema public except _prisma_migrations and the
 * baseline's seeded `milestone` reference table — then runs `prisma migrate
 * deploy` (a no-op once the baseline is applied). Never `db push`.
 *
 * The local production replica does NOT use this file; see
 * global-setup.local-deploy.ts.
 */
async function globalSetup(_config: FullConfig) {
  console.log('\nE2E Global Setup Starting...');

  const backendDir = path.resolve(__dirname, '../backend');
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://mwf_user:mwf_password@localhost:5432/mwf_target_e2e';

  console.log('Using database:', databaseUrl.replace(/:[^:@]+@/, ':***@'));

  // Hard guard: this script TRUNCATEs every application table, so it only ever
  // runs against a database whose name ends in _e2e. The dev API server gets this
  // same process.env (playwright webServer.env), and backend/src/lib/database-urls.ts
  // prefers the per-role URLs over DATABASE_URL, so every role URL that is set
  // must name an _e2e database too; otherwise the API would run against a
  // different database than the one truncated here. Empty/unset role URLs fall back
  // to DATABASE_URL (OPS stays unset, fail closed), which is what .env.test relies on.
  const dbName = (url: string): string => {
    try {
      return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    } catch {
      throw new Error('E2E global setup: a database URL is not parseable; refusing to run');
    }
  };
  const targetDb = dbName(databaseUrl);
  if (!targetDb.endsWith('_e2e')) {
    throw new Error(
      `E2E global setup refuses to truncate database "${targetDb}": the name must end in _e2e ` +
        '(use mwf_target_e2e; see docs/development/local-setup.md). Check DATABASE_URL in your shell and e2e/.env.test.',
    );
  }
  for (const v of ['APP_DATABASE_URL', 'JOB_DATABASE_URL', 'AUTH_DATABASE_URL', 'OPS_DATABASE_URL', 'MIGRATOR_DATABASE_URL']) {
    const val = process.env[v];
    if (val && dbName(val) !== targetDb) {
      throw new Error(
        `E2E global setup: ${v} points at "${dbName(val)}" but the e2e database is "${targetDb}"; ` +
          'the API would use a different database than the one reset. Unset it or point it at the e2e database.',
      );
    }
  }

  // Tables the baseline migration owns and seeds; they are never truncated.
  const KEEP = ['_prisma_migrations', 'milestone'];

  // A temporary script run from backend/ so `pg` resolves; plain node cannot
  // require Prisma 7's generated TypeScript client, and only raw SQL is needed.
  const truncateScriptPath = path.join(backendDir, '.temp-truncate.js');
  const truncateScript = `
const { Client } = require('pg');
const KEEP = ${JSON.stringify(KEEP)};
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename = ANY($1)) ORDER BY tablename",
      [KEEP]
    );
    if (rows.length === 0) {
      console.log('  skip No application tables exist yet');
      return;
    }
    const quoted = rows.map(function(r) { return 'public."' + r.tablename.replace(/"/g, '""') + '"'; });
    await db.query('TRUNCATE TABLE ' + quoted.join(', ') + ' CASCADE');
    console.log('  ok Truncated ' + rows.length + ' tables in one statement');
  } finally {
    await db.end();
  }
})().catch(function(e) { console.error(e); process.exit(1); });
`;

  console.log('Truncating all application tables...');
  try {
    fs.writeFileSync(truncateScriptPath, truncateScript);
    execSync(`node ${truncateScriptPath}`, {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
  } catch (error) {
    // An empty database is handled in the script itself, so a failure here is real
    // (connection refused, missing database, permissions): never run specs against it.
    console.error('Table truncation failed:', error);
    throw error;
  } finally {
    try {
      fs.unlinkSync(truncateScriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  // The deploy logs in as mwf_migrator (MIGRATOR_DATABASE_URL, .env.test): on a fresh database every
  // object it creates is the migrator's, never a runtime role's or the admin's (work-k5fk.10.1).
  console.log('\nRunning database migrations...');
  try {
    execSync('npx prisma migrate deploy', {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: process.env.MIGRATOR_DATABASE_URL || databaseUrl },
      stdio: 'inherit',
    });
    console.log('Migrations complete');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }

  console.log('\nE2E Global Setup Complete!\n');
}

export default globalSetup;
