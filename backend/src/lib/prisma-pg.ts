/**
 * pg.Pool + @prisma/adapter-pg construction for Prisma 7.
 *
 * Prisma 7 no longer opens its own connections: every PrismaClient takes a
 * driver adapter, and the pool belongs to `pg`. Prisma 6 read its pool
 * settings from Prisma-specific query parameters on DATABASE_URL
 * (production sets `connection_limit=12`). `pg` does not understand those,
 * so this module strips them from the URL and maps them onto the pool,
 * keeping the 6.x defaults where the URL is silent:
 *
 *   URL parameter (v6)            pg.Pool field             default here
 *   connection_limit              max                       10 (pg's default; see below)
 *   pool_timeout (s)              connectionTimeoutMillis   10s  (v6 default)
 *   max_idle_connection_lifetime  idleTimeoutMillis         300s (v6 default)
 *   max_connection_lifetime       maxLifetimeSeconds        0 = unlimited (v6 default)
 *   schema                        PrismaPg { schema }       unset
 *
 * The v6 default for connection_limit was `physical_cpus * 2 + 1`, which Node
 * cannot read; with no parameter we fall back to pg's 10. Deployments that
 * care (production) set connection_limit explicitly.
 *
 * `connect_timeout`, `socket_timeout`, `pgbouncer` and `statement_cache_size`
 * are also Prisma-only and are removed from the URL. pg has a single timeout
 * for "wait for a pooled client, including connecting", so pool_timeout is
 * the one honoured. sslmode and other libpq parameters pass through to pg.
 */
import path from 'path';
import dotenv from 'dotenv';
import { Pool, type PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { databaseUrlFor, DATABASE_URL_VARS, type DatabaseRole } from './database-urls';

/** Query parameters that only Prisma's Rust engine understood. */
const PRISMA_ONLY_PARAMS = [
  'connection_limit',
  'pool_timeout',
  'connect_timeout',
  'socket_timeout',
  'max_idle_connection_lifetime',
  'max_connection_lifetime',
  'pgbouncer',
  'statement_cache_size',
  'schema',
] as const;

const V6_POOL_TIMEOUT_SECONDS = 10;
const V6_MAX_IDLE_CONNECTION_LIFETIME_SECONDS = 300;

export interface PgSettings {
  /** pool.connectionString is DATABASE_URL with the Prisma-only parameters removed. */
  pool: PoolConfig;
  /** Postgres schema from `?schema=`, for PrismaPg; undefined = search_path. */
  schema?: string;
}

function numberParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`DATABASE_URL: ${name}=${raw} is not a non-negative number`);
  }
  return value;
}

/** Pure: split a Prisma-6-style DATABASE_URL into pg settings. */
export function pgSettingsFromUrl(databaseUrl: string): PgSettings {
  const url = new URL(databaseUrl);
  const params = url.searchParams;

  const connectionLimit = numberParam(params, 'connection_limit');
  if (connectionLimit !== undefined && (!Number.isInteger(connectionLimit) || connectionLimit < 1)) {
    throw new Error(`DATABASE_URL: connection_limit=${params.get('connection_limit')} must be a positive integer`);
  }
  const poolTimeout = numberParam(params, 'pool_timeout') ?? V6_POOL_TIMEOUT_SECONDS;
  const idle = numberParam(params, 'max_idle_connection_lifetime') ?? V6_MAX_IDLE_CONNECTION_LIFETIME_SECONDS;
  const lifetime = numberParam(params, 'max_connection_lifetime');
  const schema = params.get('schema') || undefined;

  for (const name of PRISMA_ONLY_PARAMS) params.delete(name);

  const pool: PoolConfig = {
    connectionString: url.toString(),
    // 0 means "no timeout" in both Prisma 6 and pg.
    connectionTimeoutMillis: poolTimeout * 1000,
    idleTimeoutMillis: idle * 1000,
  };
  if (connectionLimit !== undefined) pool.max = connectionLimit;
  if (lifetime !== undefined) pool.maxLifetimeSeconds = lifetime;

  return { pool, schema };
}

/**
 * The URL a role connects with: its own variable (APP_DATABASE_URL, ...),
 * else DATABASE_URL — see database-urls.ts.
 *
 * Prisma 6's generated client loaded backend/.env by itself (without
 * overriding variables already set). Prisma 7's does not, and several
 * scripts and DB-backed tests relied on that, so keep doing it here.
 * Resolves to backend/.env from src/lib; from dist/ it points at a file
 * that does not exist and is a no-op, as in production.
 */
export function databaseUrlFromEnv(role: DatabaseRole = 'app'): string {
  if (!databaseUrlFor(role)) {
    dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  }
  const databaseUrl = databaseUrlFor(role);
  if (!databaseUrl) {
    throw new Error(
      role === 'ops'
        ? 'OPS_DATABASE_URL is not set (the read-only dashboard role never falls back to DATABASE_URL)'
        : `Neither ${DATABASE_URL_VARS[role]} nor DATABASE_URL is set`,
    );
  }
  return databaseUrl;
}

/** What PrismaClient needs from an adapter factory (PrismaPg, structurally). */
export type PgAdapterFactory = Pick<PrismaPg, 'provider' | 'adapterName' | 'connect' | 'connectToShadowDb'>;

/** A string-configured PrismaPg creates no pool until connect(); used only for its name. */
const ADAPTER_NAME = new PrismaPg('postgresql://localhost').adapterName;

function buildAdapter(databaseUrl: string): PrismaPg {
  const { pool, schema } = pgSettingsFromUrl(databaseUrl);
  // disposeExternalPool: $disconnect() ends the pool, as it closed the
  // engine's pool in Prisma 6, so scripts that disconnect and exit keep
  // exiting promptly. A later query reconnects with a fresh pool built from
  // the same config (PrismaPg keeps it), again as in 6.
  return new PrismaPg(new Pool(pool), { schema, disposeExternalPool: true });
}

/**
 * A PrismaPg adapter over a pg.Pool we construct.
 *
 * Without an explicit URL, the role's URL (APP_DATABASE_URL for the default
 * `app` role, falling back to DATABASE_URL) is read on first connect rather
 * than at construction: Prisma 6 did the same, and importing lib/prisma
 * with no database configured (the image smoke test in aws-deploy.yml,
 * mocked unit tests) must keep working.
 */
export function createPrismaPgAdapter(databaseUrl?: string, role: DatabaseRole = 'app'): PgAdapterFactory {
  if (databaseUrl !== undefined) return buildAdapter(databaseUrl);
  let adapter: PrismaPg | undefined;
  const resolve = (): PrismaPg => (adapter ??= buildAdapter(databaseUrlFromEnv(role)));
  return {
    provider: 'postgres',
    adapterName: ADAPTER_NAME,
    connect: () => resolve().connect(),
    connectToShadowDb: () => resolve().connectToShadowDb(),
  };
}
