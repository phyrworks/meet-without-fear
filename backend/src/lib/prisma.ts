import { PrismaClient } from '../generated/prisma/client';
import { withEncryption } from './prisma-encryption-middleware';
import { createPrismaPgAdapter } from './prisma-pg';
import type { DatabaseRole } from './database-urls';

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
  const base = new PrismaClient({
    // Prisma 7: connections come from a pg.Pool; pool size and timeouts are
    // mapped from the URL's connection_limit etc. in prisma-pg.ts.
    adapter: createPrismaPgAdapter(url, role),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
  // Cast back to PrismaClient so all existing $transaction call sites
  // continue to type-check correctly. The $extends middleware is still
  // active at runtime — this is a type-only cast.
  return withEncryption(base) as unknown as PrismaClient;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
