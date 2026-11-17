import { PrismaClient, type Prisma } from '../generated/prisma/client';
import { withEncryption } from './prisma-encryption-middleware';
import { createPrismaPgAdapter, databaseUrlFromEnv } from './prisma-pg';
import { guardAdapterFactory, readRoleFactsAt } from './prisma-role-guard';
import type { DatabaseRole } from './database-urls';
import {
  bindTransactionSettings,
  identityBindingEnabled,
  keepRequestContextAcrossBatching,
  type BoundSetting,
} from './prisma-identity';
import { getRequestContext, sessionScopeOf } from './request-context';
import { isE2EBypassEnabled } from './e2e-bypass';

/**
 * A client a writer may be handed: the root client, or the client of an
 * interactive transaction (`$transaction(async tx => …)`), which has every
 * model delegate but no `$transaction`/`$connect` of its own.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

export interface PrismaClientOptions {
  /** Connect with this URL instead of the role's environment variable. */
  url?: string;
  /** Which role's URL to read (APP_/AI_/WORKER_/OPS_/AUTH_DATABASE_URL; app and auth fall back to DATABASE_URL). Default `app`. */
  role?: DatabaseRole;
  /**
   * Skip the runtime role guard (prisma-role-guard.ts) for this client, with
   * the reason. Only the E2E tooling client uses it; every runtime client is
   * guarded.
   */
  roleGuardExemption?: string;
}

/**
 * The transaction-local settings a role's client binds to every statement and transaction
 * (prisma-identity.ts; design note §6 "Session variables", work-k5fk.10.5), read from the request
 * context at the moment Prisma hands the statement over:
 *   - app.current_user_id, with DB_IDENTITY_BINDING=on (every role; off by default until §7 row 9c);
 *   - app.session_scope, for the ai and worker roles: the scope (`withSessionScope`, else the session
 *     a seated request is in). The database requires it — t_session_scope and the definers' AI /
 *     worker arms refuse a NULL one — so an AI write without one fails there, closed;
 *   - app.request_id, riding along whenever one of the two is set (audit only; a statement that
 *     binds nothing else is not wrapped for it).
 */
export function boundSettingsFor(
  role: DatabaseRole,
  identityBinding: boolean,
): () => ReadonlyArray<readonly [BoundSetting, string]> {
  const scoped = role === 'ai' || role === 'worker';
  return () => {
    const ctx = getRequestContext();
    const out: Array<readonly [BoundSetting, string]> = [];
    if (identityBinding && ctx?.userId) out.push(['app.current_user_id', ctx.userId]);
    const scope = scoped ? sessionScopeOf(ctx) : undefined;
    if (scope) out.push(['app.session_scope', scope]);
    if (out.length && ctx?.requestId) out.push(['app.request_id', ctx.requestId]);
    return out;
  };
}

/**
 * A PrismaClient with the encryption extension, over its own pg.Pool.
 * `prisma` below is the `app` one; the ai, worker, ops and auth clients are
 * built with this factory on first use.
 */
export function createPrismaClient({ url, role = 'app', roleGuardExemption }: PrismaClientOptions = {}): PrismaClient {
  // DB_IDENTITY_BINDING=on binds the request's user id to every statement
  // (prisma-identity.ts); the ai and worker clients always bind app.session_scope.
  // Otherwise (the app, ops and auth clients with binding off) nothing below is wrapped at all.
  const identityBinding = identityBindingEnabled();
  const bindIdentityToStatements = identityBinding || role === 'ai' || role === 'worker';
  // work-k5fk.10.3: the first connect refuses a privileged, member or object-owning login. The URL
  // is resolved once (on first connect, as before) so the guard and the pool check the same one.
  let resolved: string | undefined = url;
  const urlOnce = (): string => (resolved ??= databaseUrlFromEnv(role));
  const pgAdapter = guardAdapterFactory(createPrismaPgAdapter(urlOnce, role), role, {
    exemption: roleGuardExemption,
    readFacts: () => readRoleFactsAt(urlOnce()),
  });
  const base = new PrismaClient({
    // Prisma 7: connections come from a pg.Pool; pool size and timeouts are
    // mapped from the URL's connection_limit etc. in prisma-pg.ts.
    adapter: bindIdentityToStatements
      ? bindTransactionSettings(pgAdapter, boundSettingsFor(role, identityBinding))
      : pgAdapter,
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
 * The AI connection (`AI_DATABASE_URL`, `mwf_ai`; REQUIRED — it never falls back to DATABASE_URL;
 * work-k5fk.10.5, design note §6): the reconciler, the facilitator's AI / SYSTEM lines
 * (message-store createFacilitatorMessage(Once)), the summarizer and classifier (ai_memory) and the
 * brain telemetry. One session per transaction: every statement carries app.session_scope (the
 * request's seated session, or `withSessionScope`), and the database refuses an AI write outside it.
 * Created on first use.
 */
const globalForAi = globalThis as unknown as { aiPrisma: PrismaClient | undefined };

export function getAiPrisma(): PrismaClient {
  if (!globalForAi.aiPrisma) globalForAi.aiPrisma = createPrismaClient({ role: 'ai' });
  return globalForAi.aiPrisma;
}

/**
 * The worker connection (`WORKER_DATABASE_URL`, `mwf_worker`; REQUIRED — it never falls back;
 * work-k5fk.10.5): the scheduled jobs (session and data retention, due follow-ups and reminders),
 * notification delivery (the recipient's push tokens) and the Stage 4 closure's cross-participant
 * decision (stage4-closure.ts, stage4-store createAgreementsAsJob / closeSessionAsJob), which runs
 * scoped to its session (`withSessionScope`). Created on first use.
 */
const globalForWorker = globalThis as unknown as { workerPrisma: PrismaClient | undefined };

export function getWorkerPrisma(): PrismaClient {
  if (!globalForWorker.workerPrisma) globalForWorker.workerPrisma = createPrismaClient({ role: 'worker' });
  return globalForWorker.workerPrisma;
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
 * The auth connection (`AUTH_DATABASE_URL`, `mwf_auth`; falls back to
 * DATABASE_URL when unset): the pre-identity bootstrap of every Clerk-signed
 * request (middleware/auth.ts, work-k5fk.1). mwf_auth holds EXECUTE on
 * app.resolve_user and app.create_user and nothing else — no table privilege
 * — so the request role (mwf_app) never reads or writes user_identity, and no
 * request can re-bind an account (work-bp5m). Created on first use.
 */
const globalForAuth = globalThis as unknown as { authPrisma: PrismaClient | undefined };

export function getAuthPrisma(): PrismaClient {
  if (!globalForAuth.authPrisma) globalForAuth.authPrisma = createPrismaClient({ role: 'auth' });
  return globalForAuth.authPrisma;
}

/**
 * The E2E tooling connection (work-k5fk.10.1): `DATABASE_URL` — the admin /
 * migration URL — for the test-only paths behind `E2E_AUTH_BYPASS`
 * (routes/e2e.ts seeding and cleanup, the auth bypass's user upsert). Those
 * paths write what no production request writes (a user with a caller-chosen
 * id, whole-account hard deletes), so they must not borrow the app's
 * connection — mwf_app holds only what production requests do. Refused
 * outright unless isE2EBypassEnabled() (E2E_AUTH_BYPASS=true and NODE_ENV test,
 * development or e2e; lib/e2e-bypass.ts).
 */
const globalForTooling = globalThis as unknown as { e2eToolingPrisma: PrismaClient | undefined };

export function getE2EToolingPrisma(): PrismaClient {
  if (!isE2EBypassEnabled()) {
    throw new Error('The E2E tooling connection exists only with E2E_AUTH_BYPASS=true and NODE_ENV test, development or e2e');
  }
  if (!globalForTooling.e2eToolingPrisma) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('The E2E tooling connection needs DATABASE_URL');
    globalForTooling.e2eToolingPrisma = createPrismaClient({
      url,
      roleGuardExemption: 'E2E tooling (E2E_AUTH_BYPASS, never production): seeds and deletes what no request may',
    });
  }
  return globalForTooling.e2eToolingPrisma;
}

/** Disconnect the ai, worker, ops, tooling and auth clients that were opened (tests, shutdown). */
export async function disconnectRolePrismas(): Promise<void> {
  const ai = globalForAi.aiPrisma;
  globalForAi.aiPrisma = undefined;
  await ai?.$disconnect();
  const worker = globalForWorker.workerPrisma;
  globalForWorker.workerPrisma = undefined;
  await worker?.$disconnect();
  const ops = globalForOps.opsPrisma;
  globalForOps.opsPrisma = undefined;
  await ops?.$disconnect();
  const tooling = globalForTooling.e2eToolingPrisma;
  globalForTooling.e2eToolingPrisma = undefined;
  await tooling?.$disconnect();
  const auth = globalForAuth.authPrisma;
  globalForAuth.authPrisma = undefined;
  await auth?.$disconnect();
}

/**
 * Startup check (work-k5fk.10.3): open the app, ai, worker and auth connections, and
 * the ops connection when it is configured, so the role guard
 * (prisma-role-guard.ts) runs before the server listens. Rejects with
 * RuntimeRoleRefusedError on a superuser, BYPASSRLS or object-owning login, and
 * fails when AI_DATABASE_URL or WORKER_DATABASE_URL is unset (they never fall back).
 */
export async function verifyRuntimeConnections(env: Record<string, string | undefined> = process.env): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  // Always: request paths write through both (work-k5fk.10.5); unset, they fail closed here.
  await getAiPrisma().$queryRaw`SELECT 1`;
  await getWorkerPrisma().$queryRaw`SELECT 1`;
  // Always, for the same reason: every Clerk-signed request resolves its user on it (work-k5fk.1).
  await getAuthPrisma().$queryRaw`SELECT 1`;
  // ops never falls back (it fails closed when unset), so it is checked only when configured.
  if (env.OPS_DATABASE_URL) await getOpsPrisma().$queryRaw`SELECT 1`;
}

export default prisma;
