// Process and real database readiness; do not expose connection details publicly.
// Exit 0 only if GET /health is OK and `SELECT 1` succeeds; exit 1 otherwise.
// Uses `pg` (Prisma 7 era). If `pg` is not installed (Prisma 6 releases), falls
// back to the Prisma client so the same script works on both.
const HEALTH_URL = process.env.HEALTHCHECK_URL || 'http://127.0.0.1:3000/health';
const DB_TIMEOUT_MS = 3000;

function resolveModule(name) {
  for (const base of ['/app/node_modules', '/app/backend/node_modules']) {
    try { return require(require.resolve(name, { paths: [base] })); } catch (_) { /* next */ }
  }
  try { return require(name); } catch (_) { return null; }
}

// App role URL, falling back to DATABASE_URL (mirrors backend/src/lib/database-urls.ts).
const connectionString = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;

async function checkWithPg(pg) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: DB_TIMEOUT_MS,
    statement_timeout: DB_TIMEOUT_MS,
    query_timeout: DB_TIMEOUT_MS,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkWithPrisma(prismaModule) {
  const db = new prismaModule.PrismaClient({ log: [] });
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), DB_TIMEOUT_MS * 2).unref()),
    ]);
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

(async () => {
  const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('HTTP health failed');
  const pg = resolveModule('pg');
  if (pg) {
    if (!connectionString) throw new Error('no database url');
    await checkWithPg(pg);
  } else {
    const prismaModule = resolveModule('@prisma/client');
    if (!prismaModule) throw new Error('no database driver');
    await checkWithPrisma(prismaModule);
  }
})().then(() => process.exit(0), () => process.exit(1));
