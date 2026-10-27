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
import * as http from 'http';
import request from 'supertest';
import { applyConceptViews, CONCEPT_NAMES, ConceptName, conceptSqlForShape, takeConceptSnapshot } from './concept-views';
import { dropDatabase, mark, openMarkerClient, withClient } from './db';
import { restoreFixture, RestoredFixture } from './fixtures';
import { isTargetShape } from './shape';
import type { FreshWindow } from './normalize';
import { Snapshot, takeSnapshot, diffSnapshots, RowChange } from './snapshot';
import {
  APP_UNDER_TEST,
  LogReader,
  TraceSummary,
  UnassertedTrace,
  captureWindow,
  parsePostgresLog,
  podmanLogReader,
  statementsOutsideWindows,
} from './trace';

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
  /**
   * The `old_concept_*` views before the step and after it settled. Present
   * only when the harness was created with `concept`. Taken on muted harness
   * connections outside the trace window, so they change nothing the
   * byte-level golden records.
   */
  concept?: { before: Snapshot; after: Snapshot; unrepresentable?: undefined } | ConceptUnrepresentable;
}

/** A step after which the concept views could not represent the database (`conceptUnrepresentable: 'record'`). */
export interface ConceptUnrepresentable {
  before?: Snapshot;
  after?: undefined;
  unrepresentable: string;
}

export interface Harness {
  app: Express;
  fixture: RestoredFixture;
  actors: { userA: ActorRef; userB?: ActorRef };
  sessionId: string;
  /** When the fixture finished restoring — the lower bound of this run's writes. */
  startedAt: string;
  /** The concept views as restored, before any step. Present only with `concept`. */
  conceptInitial?: Snapshot;
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
     * Parts of this step's SQL trace that cannot be asserted, because a
     * concurrent writer makes them a sample of a race.
     *
     * A refusal, never a fitted range — see `UnassertedTrace` for the clean-tree
     * failure that ruled ranges out. Declare the narrowest thing that is
     * genuinely unassertable, and put the measurement beside the declaration.
     */
    traceUnasserted?: UnassertedTrace;
  }): Promise<StepResult>;
  snapshot(tables: string[]): Promise<Snapshot>;
  /**
   * How many app-under-test statements fell outside every step's window.
   *
   * Must be zero. `settle()` watches *rows*, so a trailing read that touches no
   * rows can outlive it and either contaminate the next step's window or land
   * between two and be seen by neither. Measured at zero on this machine today,
   * so this is prevention: it converts a silent gap into a failure, and it is
   * how an undeclared fire-and-forget path added later announces itself.
   *
   * Returns null when the harness was created without a trace.
   */
  unwindowedStatements(): Promise<number | null>;
  teardown(): Promise<void>;
}

/**
 * The job login (`mwf_job`) on a run database. Its password is the dev
 * literal from docs/development/local-setup.md (`GOLDEN_JOB_PASSWORD`
 * overrides). Tagged with the app-under-test application_name, so the job's
 * statements are part of the trace like the app's.
 */
export function jobUrlFor(t: { host: string; port: number }, database: string): string {
  const pw = encodeURIComponent(process.env.GOLDEN_JOB_PASSWORD ?? 'mwf_job_dev');
  return `postgresql://mwf_job:${pw}@${t.host}:${t.port}/${database}?application_name=${APP_UNDER_TEST}`;
}

/** TS-10: the request role (`mwf_app`) on a run database (dev password, local-setup.md; GOLDEN_APP_PASSWORD overrides). */
export function appUrlFor(t: { host: string; port: number }, database: string): string {
  const pw = encodeURIComponent(process.env.GOLDEN_APP_PASSWORD ?? 'mwf_app_dev');
  return `postgresql://mwf_app:${pw}@${t.host}:${t.port}/${database}?application_name=${APP_UNDER_TEST}`;
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
  /**
   * Apply the `old_concept_*` views (`concept-views/`) to the run database and
   * snapshot them around every step, for the normalised baseline
   * (`recordOrVerifyConcept`). `true` uses the SQL for the schema in use
   * (`conceptSqlForShape`); a path picks another concept SQL file.
   * `views` narrows the snapshot to those concepts (default: all of them;
   * `TS4_CONCEPT_NAMES` for the two scenarios recorded before TS-5's views).
   */
  concept?: boolean | { sql?: string; views?: readonly ConceptName[] };
  /**
   * What a step does when the concept views cannot represent the database
   * after it (default `'throw'`, which fails the run). `'record'` keeps the
   * reason on the step (`concept.unrepresentable`) and the normalised baseline
   * records it in place of the step's concept changes — for a scenario whose
   * subject IS such a state (TS-5 R5: today's account deletion leaves rows the
   * migration's mapping cannot direct). The restored state must still be
   * representable.
   */
  conceptUnrepresentable?: 'throw' | 'record';
  /**
   * TS-10: on the target, log the APP in as `mwf_app` on the run database
   * (default: the fixture's owner login, as every golden runs). For the
   * real-role unit tests: the request path then runs under mwf_app's
   * privileges with identity binding on, the job under mwf_job's.
   */
  appLogin?: 'owner' | 'mwf_app';
}): Promise<Harness> {
  const traceOpts: TraceOptions | null = opts.trace === true ? {} : opts.trace ? opts.trace : null;
  const conceptViews: readonly ConceptName[] =
    (typeof opts.concept === 'object' && opts.concept.views) || CONCEPT_NAMES;
  const fixture = await restoreFixture({
    baseUrl: opts.baseUrl,
    stage: opts.stage,
    runId: opts.runId,
    captureStatements: !!traceOpts,
  });

  // After the restore (and its rebase), before anything is snapshotted. On
  // failure the run database must go, as `restoreFixture` does for its own.
  // The concept SQL follows the schema in use (current-shape.sql or, on the
  // target branch, target-shape.sql — TS-9) unless the scenario names one.
  const conceptSql =
    opts.concept === true ? conceptSqlForShape() : opts.concept ? (opts.concept.sql ?? conceptSqlForShape()) : null;
  let conceptInitial: Snapshot | undefined;
  if (conceptSql) {
    try {
      await applyConceptViews(fixture.target, fixture.database, conceptSql);
      conceptInitial = await takeConceptSnapshot(fixture.target, fixture.database, conceptViews);
    } catch (e) {
      await dropDatabase(fixture.target, fixture.database);
      throw e;
    }
  }
  const conceptSnapshot = (): Promise<Snapshot> => takeConceptSnapshot(fixture.target, fixture.database, conceptViews);
  /**
   * A concept snapshot, or — with `conceptUnrepresentable: 'record'` — the
   * reason the views cannot represent the database (a `concept_check_*` row,
   * or a view that RAISEs). Either is the migration precheck failing on this
   * state, which is information, not a harness fault.
   */
  const conceptSnapshotOrReason = async (): Promise<{ snap?: Snapshot; reason?: string }> => {
    try {
      return { snap: await conceptSnapshot() };
    } catch (e) {
      if (opts.conceptUnrepresentable !== 'record') throw e;
      return { reason: (e as Error).message };
    }
  };

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
  if (opts.appLogin === 'mwf_app' && isTargetShape()) {
    // mwf_app owns the tables in production; on a local clone (owned by the
    // fixture's superuser) it gets exactly the privileges that ownership gives
    // the request path — as functions-caller-tests.sql and smoke-baseline.sql
    // do — so every refusal a test sees comes from a function or trigger.
    await withClient(
      fixture.target,
      c => c.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mwf_app'),
      fixture.database,
    );
  }
  process.env.DATABASE_URL =
    opts.appLogin === 'mwf_app' && isTargetShape()
      ? appUrlFor(fixture.target, fixture.database)
      : `${fixture.url}?application_name=${APP_UNDER_TEST}`;
  // lib/prisma prefers APP_DATABASE_URL over DATABASE_URL (database-urls.ts);
  // one left in a developer's environment would point the app elsewhere.
  delete process.env.APP_DATABASE_URL;
  // The job connection (TS-9: AI/SYSTEM and delivered messages, system
  // milestones and AI memory are written through it). On the target it logs
  // in as mwf_job ON THE RUN DATABASE (roles are cluster-wide), so the run
  // exercises the job's real grants; identity binding is on, so the
  // identity-bound reads (app.current_user_id(), v_empathy_direction_status)
  // behave as in production. On the current shape neither applies.
  if (isTargetShape()) {
    process.env.JOB_DATABASE_URL = jobUrlFor(fixture.target, fixture.database);
    process.env.DB_IDENTITY_BINDING = 'on';
  } else {
    delete process.env.JOB_DATABASE_URL;
  }
  process.env.E2E_AUTH_BYPASS = 'true';
  process.env.MOCK_LLM = 'true';
  process.env.E2E_FIXTURE_ID = process.env.E2E_FIXTURE_ID ?? 'user-a-full-journey';

  const appModule = await import('../../app');
  const app = (appModule.default ?? appModule) as Express;
  // One server for the run, bound to the loopback address explicitly.
  // `request(app)` listens on an ephemeral port on every interface per request
  // and the client then dials 127.0.0.1. TS-5 saw two runs fail on their first
  // steps with `Parse Error: Expected HTTP/, RTSP/ or ICE/` — a non-HTTP peer
  // answering — while other test processes were active on this machine; the
  // suspected cause is a dual-stack listener sharing a port number with another
  // process's 127.0.0.1 socket (macOS). Unproven; binding the address the
  // client dials removes that ambiguity and changes no recorded byte.
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

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
  const windows: Array<{ beginToken: string; endToken: string }> = [];
  const traceStartedAt = Date.now();

  return {
    app,
    fixture,
    actors,
    sessionId: seeded.sessionId,
    startedAt,
    conceptInitial,
    snapshot,
    async step({ label, actor, tables, call, sse, asyncBoundary, traceUnasserted }) {
      // Refusing to assert is only ever justified by concurrent background work,
      // and `asyncBoundary` is how a step declares it has any. Without this
      // coupling, `traceUnasserted` on the paginated read would silence the
      // dropped-`take` channel with code review as the only thing standing in the
      // way — and the whole point of that channel is that review cannot see it.
      if (traceUnasserted && !asyncBoundary) {
        throw new Error(
          `Step "${label}" declares traceUnasserted without asyncBoundary. A trace field may only go ` +
            `unasserted because work outliving the response races it; a synchronous step has no such ` +
            `excuse, and silencing one there would hide a real regression channel.`,
        );
      }

      const before = await snapshot(tables);
      const conceptBefore = conceptSql ? await conceptSnapshotOrReason() : undefined;

      // Sentinels bracket the window. The begin marker goes after the `before`
      // snapshot so the snapshot's own statements are outside it, even though
      // they are muted as well — two independent reasons the window is clean.
      const stepNo = stepIndex++;
      const beginToken = `${traceToken}_${stepNo}_b`;
      const endToken = `${traceToken}_${stepNo}_e`;
      const markedAt = Date.now();
      if (marker) {
        await mark(marker, beginToken);
        windows.push({ beginToken, endToken });
      }

      let test = call(request(server) as unknown as request.Agent, authHeaders(actor));
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
          // `connections` is unasserted on every step: under the Prisma 7 pg driver adapter, pg.Pool opens connections on demand under Promise.all, so the count varies run to run (3, 5, 6 measured on one step).
          unasserted: { ...traceUnasserted, connections: true },
        });
      }
      // After the end marker, so the trace window is exactly what it was
      // before the concept views existed.
      const conceptAfter = conceptBefore ? await conceptSnapshotOrReason() : undefined;
      const concept: StepResult['concept'] =
        conceptBefore && conceptAfter
          ? conceptBefore.snap && conceptAfter.snap
            ? { before: conceptBefore.snap, after: conceptAfter.snap }
            : { before: conceptBefore.snap, unrepresentable: (conceptAfter.reason ?? conceptBefore.reason)! }
          : undefined;

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
        ...(concept ? { concept } : {}),
      };
    },
    async unwindowedStatements() {
      if (!logReader) return null;
      const raw = await logReader.read((Date.now() - traceStartedAt) / 1000 + 30);
      return statementsOutsideWindows(parsePostgresLog(raw), { database: fixture.database, windows });
    },
    async teardown() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      const { prisma, disconnectJobPrisma } = await import('../../lib/prisma');
      await prisma.$disconnect().catch(() => undefined);
      await disconnectJobPrisma().catch(() => undefined);
      await marker?.end().catch(() => undefined);
      // The per-database capture settings need no cleanup: they live on the run
      // database and go with it. `log_line_prefix` is server-wide and stays —
      // see `ensureLogLinePrefix` for why restoring it is worse than leaving it.
      await fixture.drop();
    },
  };
}
