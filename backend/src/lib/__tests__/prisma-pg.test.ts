import { pgSettingsFromUrl, createPrismaPgAdapter } from '../prisma-pg';

describe('pgSettingsFromUrl', () => {
  it('maps connection_limit to pool max and strips it (production URL shape)', () => {
    const { pool, schema } = pgSettingsFromUrl(
      'postgresql://mwf_app:s3cr%40t@db:5432/mwf?connection_limit=12'
    );
    expect(pool.max).toBe(12);
    expect(pool.connectionString).toBe('postgresql://mwf_app:s3cr%40t@db:5432/mwf');
    expect(schema).toBeUndefined();
  });

  it('keeps the Prisma 6 timeout defaults when the URL is silent', () => {
    const { pool } = pgSettingsFromUrl('postgresql://u:p@localhost:5432/db');
    expect(pool.max).toBeUndefined(); // pg's default (10)
    expect(pool.connectionTimeoutMillis).toBe(10_000); // v6 pool_timeout
    expect(pool.idleTimeoutMillis).toBe(300_000); // v6 max_idle_connection_lifetime
    expect(pool.maxLifetimeSeconds).toBeUndefined();
  });

  it('honours the other Prisma pool parameters and passes libpq ones through', () => {
    const { pool, schema } = pgSettingsFromUrl(
      'postgresql://u:p@h/db?sslmode=require&pool_timeout=0&max_idle_connection_lifetime=30' +
        '&max_connection_lifetime=600&connect_timeout=5&pgbouncer=true&schema=app'
    );
    expect(pool.connectionTimeoutMillis).toBe(0);
    expect(pool.idleTimeoutMillis).toBe(30_000);
    expect(pool.maxLifetimeSeconds).toBe(600);
    expect(schema).toBe('app');
    expect(pool.connectionString).toBe('postgresql://u:p@h/db?sslmode=require');
  });

  it('rejects malformed values instead of silently ignoring them', () => {
    expect(() => pgSettingsFromUrl('postgresql://h/db?connection_limit=0')).toThrow(/connection_limit/);
    expect(() => pgSettingsFromUrl('postgresql://h/db?connection_limit=abc')).toThrow(/connection_limit/);
    expect(() => pgSettingsFromUrl('postgresql://h/db?pool_timeout=-1')).toThrow(/pool_timeout/);
  });
});

describe('createPrismaPgAdapter', () => {
  it('defers reading DATABASE_URL until the first connect', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const adapter = createPrismaPgAdapter();
      expect(adapter.provider).toBe('postgres');
      expect(adapter.adapterName).toBe('@prisma/adapter-pg');
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
