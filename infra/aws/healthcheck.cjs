// Process and real database readiness; do not expose connection details publicly.
// Exit 0 only if GET /health is OK and `SELECT 1` succeeds; exit 1 otherwise.
// Uses `pg`; if it cannot be resolved the image is broken, so the check fails (exit 1).
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

(async () => {
  const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('HTTP health failed');
  const pg = resolveModule('pg');
  if (!pg) throw new Error('pg not installed');
  if (!connectionString) throw new Error('no database url');
  await checkWithPg(pg);
})().then(() => process.exit(0), () => process.exit(1));
