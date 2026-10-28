/**
 * Phase 3 D1 spike — does the identity-binding adapter put the request's
 * user id in front of EVERY statement Prisma sends, for every call shape,
 * without leaking it between requests that share a pooled connection?
 *
 * Real Prisma 7 client, real @prisma/adapter-pg, real Postgres, pool max 1
 * (so every request shares one connection — the worst case for a leak).
 * Two independent oracles:
 *   1. the wire: every client.query on the pooled connection is recorded, and
 *      every statement must sit in a BEGIN..COMMIT whose first statement
 *      (after SET TRANSACTION, if any) is set_config(<that request's id>);
 *   2. the server: $queryRaw of current_setting('app.current_user_id') returns
 *      what Postgres itself saw.
 *
 * Runs when DB_TEST_URL is set, or in CI (see app-helpers.test.ts).
 */
import { Pool, type PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { bindIdentity, keepRequestContextAcrossBatching, SET_IDENTITY_SQL } from '../../lib/prisma-identity';
import { getCurrentUserId, runWithContext } from '../../lib/request-context';

const url = process.env.DB_TEST_URL ?? (process.env.CI ? process.env.DATABASE_URL : undefined);
const describeDb = url ? describe : describe.skip;

type Wire = { pid: number; kind: string; userId?: string };

function classify(text: string, values: unknown[] | undefined): Omit<Wire, 'pid'> {
  if (text === 'BEGIN') return { kind: 'BEGIN' };
  if (text === 'COMMIT') return { kind: 'COMMIT' };
  if (text === 'ROLLBACK') return { kind: 'ROLLBACK' };
  if (text.startsWith('SET TRANSACTION')) return { kind: 'SET_TX' };
  if (text === SET_IDENTITY_SQL) return { kind: 'SET_ID', userId: String(values?.[0]) };
  return { kind: 'STMT' };
}

/** Group the wire log into transactions and plain statements, per connection order. */
function envelopes(log: Wire[]): Array<{ boundTo?: string; kinds: string[] }> {
  const out: Array<{ boundTo?: string; kinds: string[] }> = [];
  let open: { boundTo?: string; kinds: string[] } | undefined;
  for (const w of log) {
    if (w.kind === 'BEGIN') {
      open = { kinds: ['BEGIN'] };
      continue;
    }
    if (!open) {
      out.push({ kinds: [w.kind] });
      continue;
    }
    open.kinds.push(w.kind);
    if (w.kind === 'SET_ID' && open.boundTo === undefined) {
      const before = open.kinds.slice(1, -1);
      if (before.every(k => k === 'SET_TX')) open.boundTo = w.userId;
    }
    if (w.kind === 'COMMIT' || w.kind === 'ROLLBACK') {
      out.push(open);
      open = undefined;
    }
  }
  if (open) out.push(open);
  return out;
}

function ctx(userId?: string) {
  return { turnId: 't', requestId: `req-${userId ?? 'anon'}`, startTime: 0, userId };
}

describeDb('identity binding over Prisma 7 + adapter-pg (database)', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let wire: Wire[];
  const userIds: string[] = [];
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 1 });
    pool.on('connect', (client: PoolClient) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
        const first = args[0] as string | { text: string; values?: unknown[] };
        const text = typeof first === 'string' ? first : first.text;
        const values = typeof first === 'string' ? (args[1] as unknown[] | undefined) : first.values;
        wire.push({ pid: (client as unknown as { processID: number }).processID, ...classify(text, values) });
        return original(...args);
      };
    });
    prisma = new PrismaClient({ adapter: bindIdentity(new PrismaPg(pool), getCurrentUserId) });
    keepRequestContextAcrossBatching(prisma);
    wire = [];
    for (const name of ['alice', 'bob']) {
      const u = await prisma.user.create({ data: { email: `ts1-identity-${name}-${Date.now()}@example.test` } });
      userIds.push(u.id);
    }
    [alice, bob] = userIds;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
    await pool.end().catch(() => undefined);
  });

  beforeEach(() => {
    wire = [];
  });

  const seen = () => prisma.$queryRaw<Array<{ id: string }>>`SELECT current_setting('app.current_user_id', true) AS id`;

  function expectAllBoundTo(userId: string) {
    const groups = envelopes(wire);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.kinds[0]).toBe('BEGIN');
      expect(g.boundTo).toBe(userId);
    }
    return groups.map(g => g.kinds.join(' '));
  }

  it('findMany', async () => {
    await runWithContext(ctx(alice), async () => await prisma.user.findMany({ where: { id: alice } }));
    expect(expectAllBoundTo(alice)).toEqual(['BEGIN SET_ID STMT COMMIT']);
  });

  it('create (and update) a row', async () => {
    await runWithContext(ctx(alice), async () => {
      const u = await prisma.user.create({ data: { email: `ts1-identity-c-${Date.now()}@example.test` } });
      userIds.push(u.id);
      await prisma.user.update({ where: { id: u.id }, data: { firstName: 'c' } });
    });
    expect(expectAllBoundTo(alice)).toEqual(['BEGIN SET_ID STMT COMMIT', 'BEGIN SET_ID STMT COMMIT']);
  });

  it('batch $transaction([...])', async () => {
    await runWithContext(
      ctx(alice),
      async () => await prisma.$transaction([prisma.user.findMany({ where: { id: alice } }), prisma.user.count()]),
    );
    expect(expectAllBoundTo(alice)).toEqual(['BEGIN SET_ID STMT STMT COMMIT']);
  });

  it('interactive $transaction(async tx => ...), with an isolation level', async () => {
    const inside = await runWithContext(
      ctx(bob),
      async () =>
        await prisma.$transaction(
          async tx => {
            await tx.user.findMany({ where: { id: bob } });
            await new Promise(r => setTimeout(r, 5));
            return tx.$queryRaw<Array<{ id: string }>>`SELECT current_setting('app.current_user_id', true) AS id`;
          },
          { isolationLevel: 'Serializable' },
        ),
    );
    expect(inside[0].id).toBe(bob);
    expect(expectAllBoundTo(bob)).toEqual(['BEGIN SET_TX SET_ID STMT STMT COMMIT']);
  });

  it('$queryRaw: the server sees the identity', async () => {
    const rows = await runWithContext(ctx(alice), async () => await seen());
    expect(rows[0].id).toBe(alice);
    expect(expectAllBoundTo(alice)).toEqual(['BEGIN SET_ID STMT COMMIT']);
  });

  it('$executeRaw', async () => {
    await runWithContext(
      ctx(alice),
      async () => await prisma.$executeRaw`UPDATE "User" SET "firstName" = 'a' WHERE id = ${alice}::uuid`,
    );
    expect(expectAllBoundTo(alice)).toEqual(['BEGIN SET_ID STMT COMMIT']);
  });

  it('a query issued from a setImmediate / promise continuation inside the request', async () => {
    const rows = await runWithContext(
      ctx(bob),
      () =>
        new Promise<Array<{ id: string }>>((resolve, reject) => {
          setImmediate(() => {
            Promise.resolve()
              .then(() => seen())
              .then(resolve, reject);
          });
        }),
    );
    expect(rows[0].id).toBe(bob);
    expectAllBoundTo(bob);
  });

  it('a fire-and-forget continuation that outlives the request handler keeps its identity', async () => {
    let later: Promise<Array<{ id: string }>> | undefined;
    await runWithContext(ctx(alice), async () => {
      later = new Promise((resolve, reject) => setTimeout(() => seen().then(resolve, reject), 20));
    });
    // A different request runs meanwhile on the same single connection.
    await runWithContext(ctx(bob), async () => await seen());
    expect((await later!)[0].id).toBe(alice);
  });

  it('no identity: nothing is set, nothing is wrapped, and no earlier identity is visible', async () => {
    await runWithContext(ctx(alice), async () => await seen());
    wire = [];
    const rows = await runWithContext(ctx(undefined), async () => await seen());
    expect(rows[0].id ?? '').toBe('');
    expect(wire.map(w => w.kind)).toEqual(['STMT']);
    const outside = await seen();
    expect(outside[0].id ?? '').toBe('');
  });

  it('a failing statement rolls back and releases the connection with the identity gone', async () => {
    await expect(runWithContext(ctx(alice), async () => await prisma.$executeRaw`SELECT 1/0`)).rejects.toThrow();
    expect(envelopes(wire).map(g => g.kinds.join(' '))).toEqual(['BEGIN SET_ID STMT ROLLBACK']);
    const rows = await seen();
    expect(rows[0].id ?? '').toBe('');
  });

  it('a PrismaPromise is lazy: it runs under the identity of the context that awaits it, not the one that built it', async () => {
    // Prisma queries execute on .then(). Returning the un-awaited promise out
    // of the request context runs it with no identity (fail-closed) — and
    // awaiting it inside ANOTHER request's context would run it as that one.
    // Inside a request handler, building and awaiting share one context.
    const built = runWithContext(ctx(alice), () => seen());
    const ranAs = await runWithContext(ctx(bob), async () => await built);
    expect(ranAs[0].id).toBe(bob);
  });

  // Prisma's dataloader batches findUnique/findUniqueOrThrow calls of the same
  // shape, and every `$transaction([...])`, and dispatches them all from ONE
  // process.nextTick — which runs in the async context of whichever request
  // scheduled it. Two requests whose continuations land in the same tick
  // (one pg socket read resolving both, e.g. with a small pool) share it.
  it('findUnique from two requests in the same tick: each statement carries its own request id', async () => {
    await Promise.all([
      runWithContext(ctx(alice), async () => await prisma.user.findUnique({ where: { id: alice } })),
      runWithContext(ctx(bob), async () => await prisma.user.findUnique({ where: { id: bob } })),
    ]);
    const groups = envelopes(wire);
    expect(groups.map(g => g.kinds.join(' '))).toEqual(['BEGIN SET_ID STMT COMMIT', 'BEGIN SET_ID STMT COMMIT']);
    expect(groups.map(g => g.boundTo).sort()).toEqual([alice, bob].sort());
  });

  it('$transaction([...]) dispatched in the same tick as another request: bound to its own request', async () => {
    const [, inBatch] = await Promise.all([
      runWithContext(ctx(bob), async () => await prisma.user.findUnique({ where: { id: bob } })),
      runWithContext(ctx(alice), async () => await prisma.$transaction([seen(), prisma.user.count()])),
    ]);
    expect(inBatch[0][0].id).toBe(alice);
  });

  it('two concurrent requests on one pooled connection never see each other’s id', async () => {
    const request = (userId: string) =>
      runWithContext(ctx(userId), async () => {
        const observed: string[] = [];
        for (let i = 0; i < 10; i++) {
          const [a, b] = await Promise.all([
            seen(),
            prisma.$transaction(async tx => {
              await new Promise(r => setTimeout(r, Math.random() * 3));
              return tx.$queryRaw<Array<{ id: string }>>`SELECT current_setting('app.current_user_id', true) AS id`;
            }),
            prisma.user.findMany({ where: { id: userId } }),
          ]);
          observed.push(a[0].id, b[0].id);
          await new Promise(r => setImmediate(r));
        }
        return observed;
      });
    const [fromAlice, fromBob] = await Promise.all([request(alice), request(bob)]);
    expect(new Set(fromAlice)).toEqual(new Set([alice]));
    expect(new Set(fromBob)).toEqual(new Set([bob]));
    // And on the wire, every group carried exactly one of the two ids.
    for (const g of envelopes(wire)) expect([alice, bob]).toContain(g.boundTo);
    expect(new Set(wire.map(w => w.pid)).size).toBe(1);
  });
});
