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
 * mwf_target_test) built by the single baseline migration. Setup empties every
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
    'postgresql://mwf_user:mwf_password@localhost:5432/mwf_target_test';

  console.log('Using database:', databaseUrl.replace(/:[^:@]+@/, ':***@'));

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
    console.error("Table truncation had issues (may be OK if the database is empty)");
  } finally {
    try {
      fs.unlinkSync(truncateScriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  console.log('\nRunning database migrations...');
  try {
    execSync('npx prisma migrate deploy', {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
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
