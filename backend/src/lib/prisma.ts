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

/** Disconnect the job client if one was opened (tests, shutdown). */
export async function disconnectJobPrisma(): Promise<void> {
  const client = globalForJob.jobPrisma;
  globalForJob.jobPrisma = undefined;
  await client?.$disconnect();
}

export default prisma;
