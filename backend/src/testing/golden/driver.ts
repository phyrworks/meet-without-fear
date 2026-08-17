/**
 * Golden harness — HTTP driver.
 *
 * Drives the real Express app (`src/app.ts`) with supertest against a disposable
 * fixture clone. HTTP is the replay boundary because it is the only one that
 * survives the migration: after Prisma is gone `prisma.session.findFirst(...)`
 * has no equivalent to call, but `GET /api/v1/sessions/:id/messages` still does.
 *
 * The app is imported **dynamically, after DATABASE_URL is repointed**, because
 * `lib/prisma.ts` binds its client at module load and caches it on `globalThis`.
 * One run database per test file follows from that.
 */

import type { Express } from 'express';
import request from 'supertest';
import { mark, openMarkerClient } from './db';
import { restoreFixture, RestoredFixture } from './fixtures';
import type { FreshWindow } from './normalize';
import { Snapshot, takeSnapshot, diffSnapshots, RowChange } from './snapshot';
import { APP_UNDER_TEST, LogReader, RaceBands, TraceSummary, captureWindow, podmanLogReader } from './trace';

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Parse an SSE body into ordered events.
 *
 * Extracted from the pattern already proven at `scripts/mwf-moment-real.ts:448`,
 * which drives this same endpoint through supertest.
 */
export function parseSse(raw: string): SseEvent[] {
  return raw
    .split(/\n\n+/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1] ?? 'message';
      const dataText = block.match(/^data:\s*(.+)$/m)?.[1] ?? '{}';
      let data: unknown;
      try {
        data = JSON.parse(dataText);
      } catch {
        data = dataText;
      }
      return { event, data };
    });
}

export interface ActorRef {
  id: string;
  email: string;
  name: string;
}

export interface StepResult {
  label: string;
  status: number;
  body: unknown;
  /** Present only for SSE steps. */
  sse?: SseEvent[];
  /** Row-level changes over the declared table scope, after quiescence. */
  changes: RowChange[];
  /** Changes visible the instant the response returned, before background work settled. */
  changesAtResponse: RowChange[];
  /** False when quiescence polling timed out rather than stabilising. */
  settled: boolean;
  /**
   * True when this step kicks off work that outlives the response, so
   * `changesAtResponse` observes a race rather than a transaction boundary.
   */
  asyncBoundary: boolean;
  /** Interval covering everything this run wrote, up to the end of this step. */
  window: FreshWindow;
  /**
   * What this step asked of Postgres — statements, plans and transaction
   * envelope. Present only when the harness was created with a trace.
   */
  trace?: TraceSummary;
}

export interface Harness {
  app: Express;
  fixture: RestoredFixture;
  actors: { userA: ActorRef; userB?: ActorRef };
  sessionId: string;
  /** When the fixture finished restoring — the lower bound of this run's writes. */
  startedAt: string;
  /** Run one HTTP step with before/after snapshots over `tables`. */
  step(opts: {
    label: string;
    actor: ActorRef;
    tables: string[];
    call: (agent: request.Agent, headers: Record<string, string>) => request.Test;
    sse?: boolean;
    /**
     * Declare that this endpoint starts work that finishes after it responds.
     * Set it when a controller kicks off a promise it does not await, e.g.
     * `consentToShare` firing the reconciler. The response-time snapshot is then
     * recorded as a race rather than as a baseline — a step like this was
     * measured landing on `READY` in one run and `REVEALED` in the next.
     */
    asyncBoundary?: boolean;
    /**
     * Ranges this step was *measured* moving its SQL trace across, so the golden
     * records the range instead of one sample of a race. A value outside its
     * declared range is still recorded exactly, so real movement fails.
     *
     * Independent of `asyncBoundary`: a band is justified by observation, not by
     * a category. Declare one only with the run count and the distribution in a
     * comment beside it.
     */
    traceBands?: RaceBands;
  }): Promise<StepResult>;
  snapshot(tables: string[]): Promise<Snapshot>;
  teardown(): Promise<void>;
}

export function authHeaders(actor: ActorRef): Record<string, string> {
  return { 'x-e2e-user-id': actor.id, 'x-e2e-user-email': actor.email };
}

/**
 * Wait until a snapshot stops changing.
 *
 * Fire-and-forget work outlives the response in several controllers
 * (`messages.ts:411, 456, 494, 996`), so a single post-response sample races it.
 * Polling to quiescence needs no application changes, which keeps this harness
 * strictly an observer. A test-only job registry would be more precise and is
 * the natural upgrade once app changes are in scope.
 */
async function settle(
  take: () => Promise<Snapshot>,
  opts: { stableFor?: number; timeoutMs?: number } = {},
): Promise<{ snapshot: Snapshot; settled: boolean }> {
  const stableFor = opts.stableFor ?? 4;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const deadline = Date.now() + timeoutMs;

  let last = await take();
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 120));
    const next = await take();
    stable = diffSnapshots(last, next).length === 0 ? stable + 1 : 0;
    last = next;
    // Returning `settled` matters: a timeout previously looked identical to
    // quiescence, so a truncated state could be recorded as the baseline and a
    // replay truncated at the same point would match it forever.
    if (stable >= stableFor) return { snapshot: last, settled: true };
  }
  return { snapshot: last, settled: false };
}

/**
 * Options for the SQL-statement trace oracle.
 *
 * Opt-in per scenario: enabling it needs superuser on the database and one
 * server-wide `log_line_prefix`, which a scenario that does not record a trace
 * should not have to pay for.
 */
export interface TraceOptions {
  /** Where raw Postgres log text comes from. Defaults to the podman container. */
  reader?: LogReader;
  /** Container name for the default reader. */
  container?: string;
}

export async function createHarness(opts: {
  baseUrl: string;
  stage: string;
  runId: string;
  trace?: TraceOptions | boolean;
}): Promise<Harness> {
  const traceOpts: TraceOptions | null = opts.trace === true ? {} : opts.trace ? opts.trace : null;
  const fixture = await restoreFixture({ ...opts, captureStatements: !!traceOpts });

  const logReader =
    traceOpts &&
    (traceOpts.reader ?? podmanLogReader(traceOpts.container ?? process.env.MWF_PG_CONTAINER ?? 'mwf-postgres'));
  const marker = traceOpts ? await openMarkerClient(fixture.target, fixture.database) : null;

  // Repoint before the app (and therefore lib/prisma) is loaded.
  //
  // `application_name` rides along on the URL. Prisma passes it through to the
  // server, and it is what lets the trace tell the app under test apart from the
  // harness's own connections — which are the overwhelming majority of
  // statements against this database. Set unconditionally: it costs nothing and
  // it also makes `pg_stat_activity` legible while debugging a stuck run.
  process.env.DATABASE_URL = `${fixture.url}?application_name=${APP_UNDER_TEST}`;
  process.env.E2E_AUTH_BYPASS = 'true';
  process.env.MOCK_LLM = 'true';
  process.env.E2E_FIXTURE_ID = process.env.E2E_FIXTURE_ID ?? 'user-a-full-journey';

  const appModule = await import('../../app');
  const app = (appModule.default ?? appModule) as Express;

  const { seeded } = fixture.manifest;
  const actors = { userA: seeded.userA, userB: seeded.userB };
  // Anchored after the restore and its rebase, so every write from here on is
  // this run's own and every fixture value predates it.
  const startedAt = new Date().toISOString();

  const snapshot = (tables: string[]): Promise<Snapshot> =>
    takeSnapshot({ target: fixture.target, database: fixture.database, tables });

  // Sentinel tokens have to be unique against the whole container log, which
  // holds every run this machine has ever done. Restricted to the token
  // alphabet `mark()` enforces.
  const traceToken = `${opts.runId}_${Date.now().toString(36)}`.replace(/[^a-z0-9_]/gi, '_');
  let stepIndex = 0;

  return {
    app,
    fixture,
    actors,
    sessionId: seeded.sessionId,
    startedAt,
    snapshot,
    async step({ label, actor, tables, call, sse, asyncBoundary, traceBands }) {
      const before = await snapshot(tables);

      // Sentinels bracket the window. The begin marker goes after the `before`
      // snapshot so the snapshot's own statements are outside it, even though
      // they are muted as well — two independent reasons the window is clean.
      const stepNo = stepIndex++;
      const beginToken = `${traceToken}_${stepNo}_b`;
      const endToken = `${traceToken}_${stepNo}_e`;
      const markedAt = Date.now();
      if (marker) await mark(marker, beginToken);

      let test = call(request(app) as unknown as request.Agent, authHeaders(actor));
      for (const [k, v] of Object.entries(authHeaders(actor))) test = test.set(k, v);
      if (sse) {
        test = test
          .set('Accept', 'text/event-stream')
          .buffer(true)
          .parse((res, cb) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              raw += chunk;
            });
            res.on('end', () => cb(null, raw));
          });
      }

      const res = await test;
      const atResponse = await snapshot(tables);
      const { snapshot: settledSnap, settled } = await settle(() => snapshot(tables));

      // The end marker goes after `settle()`, not after the response. The whole
      // point of `empathy-reveal` is a reveal that `consentToShare` fires
      // without awaiting — closing the window at the response would put the
      // Serializable transaction this oracle exists to observe outside it.
      let trace: TraceSummary | undefined;
      if (marker && logReader) {
        await mark(marker, endToken);
        trace = await captureWindow({
          reader: logReader,
          database: fixture.database,
          beginToken,
          endToken,
          sinceSeconds: (Date.now() - markedAt) / 1000,
          bands: traceBands,
        });
      }

      return {
        label,
        status: res.status,
        body: sse ? undefined : res.body,
        sse: sse ? parseSse(String(res.body || res.text || '')) : undefined,
        changesAtResponse: diffSnapshots(before, atResponse),
        changes: diffSnapshots(before, settledSnap),
        settled,
        asyncBoundary: !!asyncBoundary,
        window: { from: startedAt, to: settledSnap.takenAt },
        ...(trace ? { trace } : {}),
      };
    },
    async teardown() {
      const { prisma } = await import('../../lib/prisma');
      await prisma.$disconnect().catch(() => undefined);
      await marker?.end().catch(() => undefined);
      // The per-database capture settings need no cleanup: they live on the run
      // database and go with it. `log_line_prefix` is server-wide and stays —
      // see `ensureLogLinePrefix` for why restoring it is worse than leaving it.
      await fixture.drop();
    },
  };
}
