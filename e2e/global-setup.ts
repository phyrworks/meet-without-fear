import { FullConfig } from '@playwright/test';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

async function globalSetup(_config: FullConfig) {
  console.log('\nE2E Global Setup Starting...');

  const backendDir = path.resolve(__dirname, '../backend');
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear_test';

  console.log('Using database:', databaseUrl.replace(/:[^:@]+@/, ':***@'));

  // Tables ordered for CASCADE truncation (child tables that may have FK constraints)
  const TABLES_TO_TRUNCATE = [
    // Stage 4 / Strategy
    'StrategyRanking',
    'StrategyProposal',
    // Reconciler
    'ReconcilerShareOffer',
    'ReconcilerResult',
    // Empathy / Stage 2-3
    'EmpathyValidation',
    'EmpathyAttempt',
    'EmpathyDraft',
    'ValidationFeedbackDraft',
    // Messages
    'PreSessionMessage',
    'Message',
    // Consent
    'ConsentRecord',
    'ConsentedContent',
    // Session artifacts
    'CommonGround',
    'Agreement',
    'SharedVessel',
    'UserDocument',
    'Boundary',
    'IdentifiedNeed',
    'EmotionalReading',
    'UserEvent',
    'UserVessel',
    'StageProgress',
    // Inner Work
    'InnerWorkMessage',
    'InnerWorkSession',
    // Session
    'Session',
    'Invitation',
    // Relationship
    'RelationshipMember',
    'Relationship',
    // Needs Assessment
    'NeedScore',
    'NeedsAssessmentState',
    'Need',
    // People / Insights
    'PersonMention',
    'Person',
    'Insight',
    // Memory
    'UserMemory',
    // Meditation
    'MeditationSession',
    'MeditationStats',
    'MeditationFavorite',
    'MeditationPreferences',
    'SavedMeditation',
    'BrainActivity',
    // Gratitude
    'GratitudeEntry',
    'GratitudePreferences',
    // Exercises
    'EmotionalExerciseCompletion',
    'GlobalLibraryItem',
    // User (last, as many tables reference it)
    'User',
  ];

  // Create a temporary script to truncate tables
  const truncateScriptPath = path.join(backendDir, '.temp-truncate.js');
  const truncateScript = `
// Prisma 7's client is generated TypeScript (backend/src/generated), which
// plain node cannot require; these scripts only run raw SQL, so give them a
// pg-backed stand-in with the same three methods.
const { Client } = require('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
const connected = db.connect();
const prisma = {
  $queryRawUnsafe: async function(sql, ...params) { await connected; return (await db.query(sql, params)).rows; },
  $executeRawUnsafe: async function(sql, ...params) { await connected; return (await db.query(sql, params)).rowCount; },
  $disconnect: async function() { await connected; await db.end(); },
};

const TABLES_TO_TRUNCATE = ${JSON.stringify(TABLES_TO_TRUNCATE)};

async function truncateTables() {
  const existingTables = await prisma.$queryRawUnsafe(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  const existingNames = new Set(existingTables.map(function(row) { return row.tablename; }));
  const tables = TABLES_TO_TRUNCATE.filter(function(table) { return existingNames.has(table); });

  if (tables.length > 0) {
    const quotedTables = tables.map(function(table) {
      return '"' + table.replace(/"/g, '""') + '"';
    });
    await prisma.$executeRawUnsafe('TRUNCATE TABLE ' + quotedTables.join(', ') + ' CASCADE');
    console.log('  ok Truncated ' + tables.length + ' tables in one transaction');
  } else {
    console.log('  skip No application tables exist yet');
  }
  await prisma.$disconnect();
}

truncateTables().catch(console.error);
`;

  // Truncate all tables
  console.log('Truncating all tables...');
  try {
    fs.writeFileSync(truncateScriptPath, truncateScript);
    execSync(`node ${truncateScriptPath}`, {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
  } catch (error) {
    console.error("Table truncation had issues (may be OK if tables don't exist yet)");
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(truncateScriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  // Fix vector-dependent migration for the test environment.
  //
  // The migration 20260217162645_add_refinement_attempt_counter includes:
  //   1. Vector columns for InnerWorkSession and UserVessel (requires pgvector extension)
  //   2. RefinementAttemptCounter table (works on any PostgreSQL)
  //
  // In the E2E test environment, pgvector may not be installed on the PostgreSQL server.
  // Vector columns are only used for AI embedding features which are mocked in E2E tests (MOCK_LLM=true).
  //
  // Solution: Apply the non-vector parts manually and mark the migration as applied so
  // Prisma doesn't attempt to re-run it.
  console.log('\nFixing vector-dependent migration for test environment...');
  const vectorMigrationName = '20260217162645_add_refinement_attempt_counter';
  const fixVectorScriptPath = path.join(backendDir, '.temp-fix-vector.js');
  // Build the fix script without using template literals to avoid escaping issues
  const fixVectorLines = [
    "// Prisma 7's client is generated TypeScript (backend/src/generated), which",
    "// plain node cannot require; these scripts only run raw SQL, so give them a",
    "// pg-backed stand-in with the same three methods.",
    "const { Client } = require('pg');",
    "const db = new Client({ connectionString: process.env.DATABASE_URL });",
    "const connected = db.connect();",
    "const prisma = {",
    "  $queryRawUnsafe: async function(sql, ...params) { await connected; return (await db.query(sql, params)).rows; },",
    "  $executeRawUnsafe: async function(sql, ...params) { await connected; return (await db.query(sql, params)).rowCount; },",
    "  $disconnect: async function() { await connected; await db.end(); },",
    "};",
    "",
    "async function fixVectorMigration() {",
    "  const migrationName = '" + vectorMigrationName + "';",
    "",
    "  // Check current migration state",
    "  const rows = await prisma.$queryRawUnsafe(",
    "    'SELECT migration_name, finished_at FROM \"_prisma_migrations\" WHERE migration_name = $1',",
    "    migrationName",
    "  );",
    "",
    "  const failedRows = rows.filter(function(r) { return r.finished_at === null; });",
    "  const appliedRows = rows.filter(function(r) { return r.finished_at !== null; });",
    "",
    "  // Remove any failed/pending entries from previous attempts",
    "  if (failedRows.length > 0) {",
    "    console.log('  Removing failed migration entries...');",
    "    await prisma.$executeRawUnsafe(",
    "      'DELETE FROM \"_prisma_migrations\" WHERE migration_name = $1 AND finished_at IS NULL',",
    "      migrationName",
    "    );",
    "  }",
    "",
    "  // Apply the migration if not already done",
    "  if (appliedRows.length === 0) {",
    "    console.log('  Applying RefinementAttemptCounter table...');",
    "    await prisma.$executeRawUnsafe(",
    "      'CREATE TABLE IF NOT EXISTS \"RefinementAttemptCounter\" (' +",
    "      '\"id\" TEXT NOT NULL,' +",
    "      '\"sessionId\" TEXT NOT NULL,' +",
    "      '\"direction\" TEXT NOT NULL,' +",
    "      '\"attempts\" INTEGER NOT NULL DEFAULT 0,' +",
    "      '\"createdAt\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,' +",
    "      '\"updatedAt\" TIMESTAMP(3) NOT NULL,' +",
    "      'CONSTRAINT \"RefinementAttemptCounter_pkey\" PRIMARY KEY (\"id\"))'",
    "    );",
    "    await prisma.$executeRawUnsafe(",
    "      'CREATE INDEX IF NOT EXISTS \"RefinementAttemptCounter_sessionId_idx\" ON \"RefinementAttemptCounter\"(\"sessionId\")'",
    "    );",
    "    await prisma.$executeRawUnsafe(",
    "      'CREATE UNIQUE INDEX IF NOT EXISTS \"RefinementAttemptCounter_sessionId_direction_key\" ON \"RefinementAttemptCounter\"(\"sessionId\", \"direction\")'",
    "    );",
    "",
    "    // Mark the migration as applied so prisma migrate deploy skips it.",
    "    // Note: contentEmbedding vector columns are NOT added (pgvector unavailable in this env).",
    "    // These columns are only used for AI embedding features, which are mocked in E2E tests.",
    "    const now = new Date();",
    "    await prisma.$executeRawUnsafe(",
    "      'INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) ' +",
    "      'VALUES ($1, $2, $3, $4, $5, NULL, $6, 0) ON CONFLICT DO NOTHING',",
    "      'e2e-vector-bypass-' + Date.now(),",
    "      'bypass-pgvector-for-e2e',",
    "      now,",
    "      migrationName,",
    "      'Applied without vector columns (pgvector not installed in E2E test environment)',",
    "      now",
    "    );",
    "    console.log('  ok Migration applied (RefinementAttemptCounter table created, vector columns skipped)');",
    "  } else {",
    "    console.log('  ok Migration already applied, skipping');",
    "  }",
    "",
    "  await prisma.$disconnect();",
    "}",
    "",
    "fixVectorMigration().catch(function(e) { console.error('Fix failed:', e); process.exit(1); });",
  ];
  const fixVectorScript = fixVectorLines.join('\n');

  try {
    fs.writeFileSync(fixVectorScriptPath, fixVectorScript);
    execSync(`node ${fixVectorScriptPath}`, {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
  } catch (error) {
    console.error('Warning: vector migration fix had issues. Will attempt full migration...');
  } finally {
    try {
      fs.unlinkSync(fixVectorScriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  // Run migrations to ensure schema is up to date
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
