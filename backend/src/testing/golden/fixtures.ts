/**
 * Golden harness — fixture template databases.
 *
 * A fixture is a PostgreSQL database seeded to a known `TargetStage` and then
 * used as a `CREATE DATABASE ... TEMPLATE` source. Cloning is milliseconds and
 * byte-identical, which is what makes per-scenario isolation affordable.
 *
 * Two constraints drove this design:
 *
 * 1. `pg_dump --data-only` cannot be restored — `InnerWorkSession` and
 *    `InnerWorkMessage` reference each other, so no row-insert order satisfies
 *    both. Template cloning sidesteps ordering entirely.
 * 2. Fixtures age. `state-factory.ts` writes `Invitation.expiresAt = now + 7d`
 *    and `middleware/auth.ts` gates access on `expiresAt > now()`. A fixture cut
 *    eight days ago silently changes meaning. Every restore rebases timestamps
 *    so a fixture is always the same relative age.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  DbTarget,
  cloneDatabase,
  createDatabase,
  dropDatabase,
  enableStatementCapture,
  ensureLogLinePrefix,
  listTables,
  parseDbUrl,
  rebaseTimestamps,
  rebaseJsonTimestamps,
  tableCounts,
  toDbUrl,
  withClient,
} from './db';

export const FIXTURE_PREFIX = 'mwf_fx_';
export const RUN_PREFIX = 'mwf_run_';

const MANIFEST_DIR = path.join(__dirname, '__fixtures__');

export interface FixtureManifest {
  stage: string;
  database: string;
  /** Ids minted during seeding — the seed for structural id labelling. */
  seeded: {
    sessionId: string;
    relationshipId: string;
    invitationId: string;
    userA: { id: string; email: string; name: string };
    userB?: { id: string; email: string; name: string };
  };
  /** Non-empty table row counts, as a shape check on restore. */
  counts: Record<string, number>;
  /** Sorted table list at build time — detects schema drift against a fixture. */
  tables: string[];
  builtAt: string;
}

function manifestPath(stage: string): string {
  return path.join(MANIFEST_DIR, `${stage}.json`);
}

export function fixtureDbName(stage: string): string {
  return `${FIXTURE_PREFIX}${stage.toLowerCase()}`;
}

export function readManifest(stage: string): FixtureManifest {
  const p = manifestPath(stage);
  if (!fs.existsSync(p)) {
    throw new Error(
      `No fixture manifest for stage "${stage}" at ${p}. Build it first: npm run golden:build -- ${stage}`,
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as FixtureManifest;
}

/**
 * Build (or rebuild) a fixture template database for one TargetStage.
 *
 * Seeding imports `state-factory` **dynamically, after DATABASE_URL is
 * repointed**, because `lib/prisma.ts` binds its client at module load. Nothing
 * that transitively imports `lib/prisma` may be imported before this call.
 */
export async function buildFixture(opts: {
  baseUrl: string;
  stage: string;
  userA?: { email: string; name: string };
  userB?: { email: string; name: string } | null;
}): Promise<FixtureManifest> {
  const target = parseDbUrl(opts.baseUrl);
  const dbName = fixtureDbName(opts.stage);
  const fixtureUrl = toDbUrl({ ...target, database: dbName });

  await dropDatabase(target, dbName);
  await createDatabase(target, dbName);

  // Apply the real migration history — never `db push`, per project convention.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: fixtureUrl },
    stdio: 'pipe',
  });

  const seeded = await seedInto(fixtureUrl, opts);

  const counts = await tableCounts(target, dbName);
  const tables = await listTables(target, dbName);

  const manifest: FixtureManifest = {
    stage: opts.stage,
    database: dbName,
    seeded,
    counts,
    tables,
    builtAt: new Date().toISOString(),
  };

  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(manifestPath(opts.stage), JSON.stringify(manifest, null, 2) + '\n');

  return manifest;
}

/**
 * Seed one fixture database in a child process.
 *
 * A child process is not incidental: `lib/prisma.ts` caches its client on
 * `globalThis`, so a parent that has already touched Prisma cannot be repointed
 * at another database. Isolation here makes fixture building order-independent.
 */
async function seedInto(
  fixtureUrl: string,
  opts: { stage: string; userA?: { email: string; name: string }; userB?: { email: string; name: string } | null },
): Promise<FixtureManifest['seeded']> {
  const userA = opts.userA ?? { email: 'ada@e2e.test', name: 'Ada Lovelace' };
  const userB = opts.userB === null ? null : (opts.userB ?? { email: 'bob@e2e.test', name: 'Bob Ross' });

  const script = `
    const { stateFactory, TargetStage } = require('./src/testing/state-factory');
    const { prisma } = require('./src/lib/prisma');
    (async () => {
      const result = await stateFactory.createSessionAtStage({
        userA: ${JSON.stringify(userA)},
        ${userB ? `userB: ${JSON.stringify(userB)},` : ''}
        targetStage: TargetStage.${opts.stage},
      });
      await prisma.$disconnect();
      process.stdout.write('__SEEDED__' + JSON.stringify(result));
    })().catch((e) => { console.error(e); process.exit(1); });
  `;

  const out = execFileSync('npx', ['tsx', '-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: fixtureUrl, NODE_ENV: 'test' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const marker = out.indexOf('__SEEDED__');
  if (marker === -1) throw new Error(`Seeding produced no result. Output:\n${out}`);
  const result = JSON.parse(out.slice(marker + '__SEEDED__'.length));

  return {
    sessionId: result.session.id,
    relationshipId: result.session.relationshipId,
    invitationId: result.invitation.id,
    userA: result.userA,
    userB: result.userB,
  };
}

export interface RestoredFixture {
  manifest: FixtureManifest;
  database: string;
  url: string;
  target: DbTarget;
  drop: () => Promise<void>;
}

/**
 * Clone a fixture template into a disposable per-run database and rebase its
 * timestamps so the fixture's age is constant regardless of when it was built.
 */
export async function restoreFixture(opts: {
  baseUrl: string;
  stage: string;
  runId: string;
  /** Age the fixture should present as. Default 1 hour old. */
  ageInterval?: string;
  /**
   * Turn on Postgres statement + plan capture for this run database.
   *
   * Opt-in, because it is a superuser operation and one server-wide setting, and
   * a scenario that does not record a trace should not require either.
   */
  captureStatements?: boolean;
}): Promise<RestoredFixture> {
  const manifest = readManifest(opts.stage);
  const target = parseDbUrl(opts.baseUrl);
  const runDb = `${RUN_PREFIX}${opts.runId}`.toLowerCase();

  await cloneDatabase(target, manifest.database, runDb);

  // Detect schema drift: a fixture built against an older migration head is a
  // silent false pass waiting to happen.
  const tables = await listTables(target, runDb);
  const missing = manifest.tables.filter(t => !tables.includes(t));
  const added = tables.filter(t => !manifest.tables.includes(t));
  if (missing.length || added.length) {
    await dropDatabase(target, runDb);
    throw new Error(
      `Fixture "${opts.stage}" is stale — schema drift since it was built.\n` +
        (missing.length ? `  tables now missing: ${missing.join(', ')}\n` : '') +
        (added.length ? `  tables added: ${added.join(', ')}\n` : '') +
        `Rebuild it: npm run golden:build -- ${opts.stage}`,
    );
  }

  await rebaseTimestampsToAge(target, runDb, manifest, opts.ageInterval ?? '1 hour');

  // Capture is enabled *after* the clone and *after* the rebase, deliberately.
  // The rebase issues one whole-table UPDATE per table with a timestamp column —
  // 30-odd statements whose plans are large and whose row counts are the
  // fixture's, not the run's. None of that is behaviour under test, and all of
  // it would be spending the journald budget the trace needs.
  if (opts.captureStatements) {
    try {
      await ensureLogLinePrefix(target);
      await enableStatementCapture(target, runDb);
    } catch (e) {
      // The clone already exists by this point, and a throw here skips the
      // harness's `teardown`. Two `mwf_run_*` databases were left behind that
      // way while this was being built; the drift check above avoids it the
      // same way.
      await dropDatabase(target, runDb);
      throw e;
    }
  }

  return {
    manifest,
    database: runDb,
    url: toDbUrl({ ...target, database: runDb }),
    target,
    drop: () => dropDatabase(target, runDb),
  };
}

/**
 * Shift every timestamp so the newest row in the fixture sits `age` before now.
 * Preserves all relative offsets — `state-factory` builds its timestamps as a
 * fixed lattice from a single anchor, and that lattice is what scenarios depend on.
 *
 * The shift is computed **entirely in SQL**. Naive `timestamp` columns must never
 * round-trip through JavaScript: `node-postgres` parses OID 1114 into a `Date`
 * using the *process* timezone, while Prisma writes UTC. Doing this arithmetic in
 * JS produced an error exactly equal to the local UTC offset — 7 hours on a
 * PDT machine — which is silent, environment-dependent, and invisible in CI if CI
 * runs in UTC. All 144 timestamp columns in this schema are naive, so this is a
 * whole-schema hazard, not a corner case.
 *
 * `now() AT TIME ZONE 'UTC'` yields a naive timestamp on the same basis Prisma
 * writes, making the subtraction meaningful.
 */
async function rebaseTimestampsToAge(
  target: DbTarget,
  database: string,
  manifest: FixtureManifest,
  age: string,
): Promise<void> {
  const shift = await withClient(
    target,
    async c => {
      const r = await c.query<{ shift: string | null }>(
        `SELECT EXTRACT(EPOCH FROM (
           (now() AT TIME ZONE 'UTC') - max("createdAt") - $1::interval
         ))::bigint::text AS shift
         FROM "Session"`,
        [age],
      );
      return r.rows[0]?.shift ?? null;
    },
    database,
  );
  if (shift === null) {
    throw new Error(
      `Fixture "${manifest.stage}" has no Session row, so its age cannot be anchored. ` +
        `Skipping the rebase silently would let the fixture age without bound.`,
    );
  }

  await rebaseTimestamps(target, database, `${shift} seconds`);
  // Json columns hold ISO timestamps that the column rebase cannot reach.
  await rebaseJsonTimestamps(target, database, Number(shift));
}
