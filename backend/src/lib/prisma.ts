import { PrismaClient, type Prisma } from '../generated/prisma/client';
import { withEncryption } from './prisma-encryption-middleware';
import { createPrismaPgAdapter } from './prisma-pg';
import type { DatabaseRole } from './database-urls';
import { bindIdentity, identityBindingEnabled, keepRequestContextAcrossBatching } from './prisma-identity';

/**
 * A client a writer may be handed: the root client, or the client of an
 * interactive transaction (`$transaction(async tx => …)`), which has every
 * model delegate but no `$transaction`/`$connect` of its own.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

export interface PrismaClientOptions {
  /** Connect with this URL instead of the role's environment variable. */
  url?: string;
  /** Which role's URL to read (APP_/JOB_/OPS_/AUTH_DATABASE_URL, else DATABASE_URL). Default `app`. */
  role?: DatabaseRole;
}

/**
 * A PrismaClient with the encryption extension, over its own pg.Pool.
 * `prisma` below is the `app` one; job/ops/auth clients for W4a/W10 are built
 * with this factory when their code paths move.
 */
export function createPrismaClient({ url, role = 'app' }: PrismaClientOptions = {}): PrismaClient {
  // DB_IDENTITY_BINDING=on binds the request's user id to every statement
  // (prisma-identity.ts). Off by default: nothing below is wrapped at all.
  const bindIdentityToStatements = identityBindingEnabled();
  const pgAdapter = createPrismaPgAdapter(url, role);
  const base = new PrismaClient({
    // Prisma 7: connections come from a pg.Pool; pool size and timeouts are
    // mapped from the URL's connection_limit etc. in prisma-pg.ts.
    adapter: bindIdentityToStatements ? bindIdentity(pgAdapter) : pgAdapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
  if (bindIdentityToStatements) keepRequestContextAcrossBatching(base);
  // Cast back to PrismaClient so all existing $transaction call sites
  // continue to type-check correctly. The $extends middleware is still
  // active at runtime — this is a type-only cast.
  return withEncryption(base) as PrismaClient;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * The job connection (`JOB_DATABASE_URL`, `mwf_job`; falls back to
 * DATABASE_URL when unset). Created on first use, never at import: a request
 * path that never writes as the job opens no second pool. AI/SYSTEM messages
 * and every delivered message kind are written through it (spec §1.1 message,
 * "Key per row"; TS-9).
 */
const globalForJob = globalThis as unknown as { jobPrisma: PrismaClient | undefined };

export function getJobPrisma(): PrismaClient {
  if (!globalForJob.jobPrisma) globalForJob.jobPrisma = createPrismaClient({ role: 'job' });
  return globalForJob.jobPrisma;
}

/**
 * The ops connection (`OPS_DATABASE_URL`, `mwf_ops`; REQUIRED — it fails
 * closed when unset, never the root DATABASE_URL): the read-only Neural Monitor dashboard
 * (routes/brain.ts; TS-12). mwf_ops holds SELECT on the tables the dashboard
 * reads and nothing else (trailer T7). Created on first use.
 */
const globalForOps = globalThis as unknown as { opsPrisma: PrismaClient | undefined };

export function getOpsPrisma(): PrismaClient {
  if (!globalForOps.opsPrisma) globalForOps.opsPrisma = createPrismaClient({ role: 'ops' });
  return globalForOps.opsPrisma;
}

/**
 * The E2E tooling connection (work-k5fk.10.1): `DATABASE_URL` — the admin /
 * migration URL — for the test-only paths behind `E2E_AUTH_BYPASS`
 * (routes/e2e.ts seeding and cleanup, the auth bypass's user upsert). Those
 * paths write what no production request writes (a user with a caller-chosen
 * id, whole-account hard deletes), so they must not borrow the app's
 * connection — mwf_app holds only what production requests do. Refused
 * outright unless E2E_AUTH_BYPASS=true and NODE_ENV is not production.
 */
const globalForTooling = globalThis as unknown as { e2eToolingPrisma: PrismaClient | undefined };

export function getE2EToolingPrisma(): PrismaClient {
  if (process.env.E2E_AUTH_BYPASS !== 'true' || process.env.NODE_ENV === 'production') {
    throw new Error('The E2E tooling connection exists only with E2E_AUTH_BYPASS=true outside production');
  }
  if (!globalForTooling.e2eToolingPrisma) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('The E2E tooling connection needs DATABASE_URL');
    globalForTooling.e2eToolingPrisma = createPrismaClient({ url });
  }
  return globalForTooling.e2eToolingPrisma;
}

/** Disconnect the job client if one was opened (tests, shutdown). */
export async function disconnectJobPrisma(): Promise<void> {
  const client = globalForJob.jobPrisma;
  globalForJob.jobPrisma = undefined;
  await client?.$disconnect();
  const ops = globalForOps.opsPrisma;
  globalForOps.opsPrisma = undefined;
  await ops?.$disconnect();
  const tooling = globalForTooling.e2eToolingPrisma;
  globalForTooling.e2eToolingPrisma = undefined;
  await tooling?.$disconnect();
}

export default prisma;
