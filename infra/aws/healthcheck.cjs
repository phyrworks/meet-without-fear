// Process and real database readiness; do not expose connection details publicly.
const { PrismaClient } = require('/app/node_modules/@prisma/client');
const db = new PrismaClient({ log: [] });
(async () => {
  const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('HTTP health failed');
  await db.$queryRaw`SELECT 1`;
})().catch(() => { process.exitCode = 1; }).finally(() => db.$disconnect());
