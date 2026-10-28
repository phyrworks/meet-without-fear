/**
 * TS-11 real-role test support: a clone of a target fixture where the APP
 * connection logs in as `mwf_app` and the JOB connection as `mwf_job`, with
 * identity binding on — the roles and the identity production runs with.
 * Services must be imported AFTER `openTargetRun` (lib/prisma reads the URLs
 * when it is first loaded).
 */

import { Client } from 'pg';
import { withClient } from '../../testing/golden/db';
import { jobUrlFor } from '../../testing/golden/driver';
import { restoreFixture, type RestoredFixture } from '../../testing/golden/fixtures';

export const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

/** The request role on a run database (dev password, docs/development/local-setup.md). */
export function appUrlFor(t: { host: string; port: number }, database: string): string {
  const pw = encodeURIComponent(process.env.GOLDEN_APP_PASSWORD ?? 'mwf_app_dev');
  return `postgresql://mwf_app:${pw}@${t.host}:${t.port}/${database}`;
}

export interface TargetRun {
  fx: RestoredFixture;
  /** Superuser SQL on the run database (setup and assertions only). */
  sql<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** One statement as `role`, with the identity bound the way prisma-identity binds it. */
  as<T extends Record<string, unknown>>(
    role: 'mwf_app' | 'mwf_job',
    userId: string | null,
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  drop(): Promise<void>;
}

export async function openTargetRun(stage: string, runId: string): Promise<TargetRun> {
  const fx = await restoreFixture({ baseUrl: BASE_URL, stage, runId });
  process.env.DATABASE_URL = fx.url;
  process.env.APP_DATABASE_URL = appUrlFor(fx.target, fx.database);
  process.env.JOB_DATABASE_URL = jobUrlFor(fx.target, fx.database);
  process.env.DB_IDENTITY_BINDING = 'on';
  process.env.MOCK_LLM = 'true';
  const sql = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
    withClient(fx.target, async c => (await c.query<T>(text, params)).rows, fx.database);
  // mwf_app OWNS the tables in production (trailer T7: "mwf_app's table
  // privileges are unchanged … per-tier grants are TS-16"); on a run database
  // the superuser owns them, so the stand-in is table DML for mwf_app — exactly
  // what smoke-baseline.sql / functions-caller-tests.sql grant before testing
  // as mwf_app. Function EXECUTE stays as the baseline grants it (mwf_app has
  // none on app.need_share).
  await sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mwf_app`);
  const as = async <T extends Record<string, unknown>>(
    role: 'mwf_app' | 'mwf_job',
    userId: string | null,
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const url = role === 'mwf_app' ? appUrlFor(fx.target, fx.database) : jobUrlFor(fx.target, fx.database);
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      if (userId) await c.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      const r = await c.query<T>(text, params);
      await c.query('COMMIT');
      return r.rows;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  };
  return {
    fx,
    sql,
    as,
    drop: async () => {
      const { prisma, disconnectJobPrisma } = await import('../../lib/prisma');
      await prisma.$disconnect().catch(() => undefined);
      await disconnectJobPrisma().catch(() => undefined);
      await fx.drop();
    },
  };
}

/**
 * The app over HTTP as a user (E2E auth bypass, MOCK_LLM), on the run the
 * env points at — import AFTER `openTargetRun`.
 */
export async function httpAs(): Promise<
  (
    user: { id: string; email: string },
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: object,
  ) => Promise<{ status: number; body: any }>
> {
  process.env.E2E_AUTH_BYPASS = 'true';
  const request = (await import('supertest')).default;
  const appModule = await import('../../app');
  const app = (appModule as { default?: unknown }).default ?? appModule;
  return async (user, method, path, body) => {
    let r = request(app as never)
      [method](`/api/v1${path}`)
      .set('x-e2e-user-id', user.id)
      .set('x-e2e-user-email', user.email);
    if (body) r = r.send(body);
    const res = await r;
    return { status: res.status, body: res.body };
  };
}

/** Participant ids and user ids of Ada and Bob in the run's session. */
export async function adaAndBob(run: TargetRun): Promise<{
  session: string;
  ada: string;
  bob: string;
  adaUser: string;
  bobUser: string;
}> {
  const [p] = await run.sql<{ session: string; ada: string; bob: string; ada_user: string; bob_user: string }>(
    `SELECT pa.session_id AS session, pa.id AS ada, pb.id AS bob, pa.user_id AS ada_user, pb.user_id AS bob_user
     FROM participant pa JOIN "user" ua ON ua.id = pa.user_id AND ua.email = 'ada@e2e.test'
     JOIN participant pb ON pb.session_id = pa.session_id AND pb.id <> pa.id`,
  );
  return { session: p.session, ada: p.ada, bob: p.bob, adaUser: p.ada_user, bobUser: p.bob_user };
}
