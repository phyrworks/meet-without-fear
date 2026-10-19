/**
 * Request identity on every Prisma statement — the Phase 3 D1 spike
 * (`DB_IDENTITY_BINDING=on`; default off).
 *
 * RLS policies read the caller from `app.current_user_id()`, i.e. from the
 * transaction-local setting `app.current_user_id`. Prisma has no hook that
 * runs a statement on the same pooled connection before a given query, so
 * this wraps the driver adapter instead, below every call site:
 *
 *   - A statement outside a transaction (queryRaw / executeRaw on the
 *     adapter) runs as   BEGIN; SELECT set_config(...,$1,true); <stmt>; COMMIT
 *     on one pooled connection. set_config(..., true) is SET LOCAL: the value
 *     dies with the transaction, so a pooled connection never carries one
 *     request's identity into another's statement.
 *   - startTransaction() (interactive `$transaction(async tx => ...)`, batch
 *     `$transaction([...])`, Prisma's own implicit write transactions) gets
 *     the set_config as the first statement after BEGIN (after SET
 *     TRANSACTION ISOLATION LEVEL when one is requested, which Postgres
 *     requires to come first). Every statement of the transaction then runs
 *     on that connection, under that identity.
 *
 * The identity is read from the request's AsyncLocalStorage context
 * (`getCurrentUserId()`) at the moment Prisma hands the statement to the
 * adapter. Fail-closed: no identity -> nothing is set, so a policy sees NULL
 * and matches no row. Nothing is changed when the flag is off — the adapter
 * is not wrapped at all.
 */
import type {
  IsolationLevel,
  SqlDriverAdapter,
  SqlMigrationAwareDriverAdapterFactory,
  SqlQuery,
  SqlResultSet,
  Transaction,
} from '@prisma/driver-adapter-utils';
import type { PgAdapterFactory } from './prisma-pg';
import { getCurrentUserId, getRequestContext, runInCapturedContext, type RequestContext } from './request-context';

/** `DB_IDENTITY_BINDING`: `on` | `off` (default). Anything else is a configuration error. */
export function identityBindingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DB_IDENTITY_BINDING;
  if (raw === undefined || raw === '' || raw === 'off') return false;
  if (raw === 'on') return true;
  throw new Error(`DB_IDENTITY_BINDING must be "on" or "off", got "${raw}"`);
}

export const SET_IDENTITY_SQL = "SELECT set_config('app.current_user_id', $1, true)";

function setIdentity(userId: string): SqlQuery {
  return { sql: SET_IDENTITY_SQL, args: [userId], argTypes: [{ scalarType: 'string', arity: 'scalar' }] };
}

const COMMIT: SqlQuery = { sql: 'COMMIT', args: [], argTypes: [] };
const ROLLBACK: SqlQuery = { sql: 'ROLLBACK', args: [], argTypes: [] };

type UserIdSource = () => string | undefined;

async function abandon(tx: Transaction): Promise<void> {
  try {
    await tx.executeRaw(ROLLBACK);
  } catch {
    // The connection may already be broken; releasing it is what matters.
  }
  await tx.rollback();
}

class IdentityBoundAdapter implements SqlDriverAdapter {
  readonly provider: SqlDriverAdapter['provider'];
  readonly adapterName: string;

  constructor(
    private readonly inner: SqlDriverAdapter,
    private readonly userId: UserIdSource
  ) {
    this.provider = inner.provider;
    this.adapterName = inner.adapterName;
  }

  queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const userId = this.userId();
    if (!userId) return this.inner.queryRaw(query);
    return this.inIdentityTransaction(userId, (tx) => tx.queryRaw(query));
  }

  executeRaw(query: SqlQuery): Promise<number> {
    const userId = this.userId();
    if (!userId) return this.inner.executeRaw(query);
    return this.inIdentityTransaction(userId, (tx) => tx.executeRaw(query));
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    const userId = this.userId();
    const tx = await this.inner.startTransaction(isolationLevel);
    if (!userId) return tx;
    try {
      await tx.executeRaw(setIdentity(userId));
    } catch (error) {
      await abandon(tx);
      throw error;
    }
    return tx;
  }

  executeScript(script: string): Promise<void> {
    return this.inner.executeScript(script);
  }

  getConnectionInfo(): ReturnType<NonNullable<SqlDriverAdapter['getConnectionInfo']>> {
    return this.inner.getConnectionInfo!();
  }

  dispose(): Promise<void> {
    return this.inner.dispose();
  }

  private async inIdentityTransaction<T>(userId: string, run: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.inner.startTransaction();
    let result: T;
    try {
      await tx.executeRaw(setIdentity(userId));
      result = await run(tx);
      await tx.executeRaw(COMMIT);
    } catch (error) {
      await abandon(tx);
      throw error;
    }
    await tx.commit();
    return result;
  }
}

/**
 * Wrap an adapter factory so every statement carries the request's identity.
 * `userId` is injectable for tests; production reads the request context.
 */
export function bindIdentity(
  factory: PgAdapterFactory,
  userId: UserIdSource = getCurrentUserId
): SqlMigrationAwareDriverAdapterFactory {
  return {
    provider: factory.provider,
    adapterName: factory.adapterName,
    connect: async () => new IdentityBoundAdapter(await factory.connect(), userId),
    // Migrations and the shadow database never run with a request identity.
    connectToShadowDb: () => factory.connectToShadowDb(),
  };
}

// ============================================================================
// Prisma's dataloader: keep each request in its own context
// ============================================================================

const CAPTURED = Symbol('mwf.requestContext');

type LoaderRequest = { [CAPTURED]?: RequestContext };
interface DataLoaderOptions {
  batchBy(request: LoaderRequest): string | undefined;
  singleLoader(request: LoaderRequest): Promise<unknown>;
  batchLoader(requests: LoaderRequest[]): Promise<unknown>;
}

/**
 * Prisma batches findUnique/findUniqueOrThrow of one shape, and the items of
 * every `$transaction([...])`, and dispatches ALL pending batches from a
 * single process.nextTick — which runs in the async context of whichever
 * request scheduled it. Two requests whose continuations land in one tick
 * (one pg socket read resolving both) would then share one identity: the
 * second's findUnique merged into the first's statement, or its whole batch
 * transaction opened under the other user (both measured; see
 * __tests__/db/prisma-identity.test.ts).
 *
 * This patches the client's dataloader (Prisma 7.10 internals:
 * `_requestHandler.dataloader.options`) so that a batch key includes the
 * caller's identity and each batch is dispatched inside the context of the
 * requests it holds. It throws at start-up if those internals are gone, so a
 * Prisma upgrade that moves them fails loudly instead of leaking.
 */
export function keepRequestContextAcrossBatching(client: object): void {
  const options = (client as { _requestHandler?: { dataloader?: { options?: Partial<DataLoaderOptions> } } })
    ._requestHandler?.dataloader?.options;
  if (
    !options ||
    typeof options.batchBy !== 'function' ||
    typeof options.singleLoader !== 'function' ||
    typeof options.batchLoader !== 'function'
  ) {
    throw new Error(
      'DB_IDENTITY_BINDING: Prisma client internals (_requestHandler.dataloader.options) not found; ' +
        'per-request identity cannot be guaranteed for batched queries with this Prisma version'
    );
  }
  const { batchBy, singleLoader, batchLoader } = options as DataLoaderOptions;
  options.batchBy = (request) => {
    // Called synchronously in the caller's context, before either loader.
    const context = getRequestContext();
    request[CAPTURED] = context;
    const key = batchBy(request);
    return key === undefined ? undefined : `${key}|identity:${context?.userId ?? ''}`;
  };
  options.singleLoader = (request) => runInCapturedContext(request[CAPTURED], () => singleLoader(request));
  options.batchLoader = (requests) => runInCapturedContext(requests[0]?.[CAPTURED], () => batchLoader(requests));
}
