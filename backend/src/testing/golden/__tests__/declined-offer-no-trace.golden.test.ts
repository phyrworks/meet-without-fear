/**
 * Golden scenario R7: a declined share offer leaves no trace for the author
 * (plan §4; spec §7 "declining a share suggestion leaves no author-visible
 * trace": `consent` has no requester read arm, `context_share_offer` is
 * subject-only — P1-4).
 *
 * Fixture RECONCILER_SHOWN_B: the reconciler offered Bob (the subject) a share
 * to help Ada (the author). Ada makes a full read; Bob declines; Ada makes the
 * same full read. Every read must come back unchanged, except the direction's
 * status: declining releases the direction (AWAITING_SHARING → READY), and the
 * status is what `v_empathy_direction_status` shows the author by design.
 * The allowed status paths are listed in `DECLINE_STATUS_PATHS`; any other
 * difference is a trace of the decline.
 *
 * "Unchanged from before the offer" is read here as "unchanged from before
 * the decline": the fixture is restored with the offer already made, and no
 * client call creates one under MOCK_LLM (the mock reconciler always
 * PROCEEDs). ASSUMPTION, reported.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build RECONCILER_SHOWN_B
 * Record:   GOLDEN_UPDATE=declined-offer-no-trace npx jest declined-offer-no-trace.golden
 *           GOLDEN_UPDATE=declined-offer-no-trace.concept npx jest declined-offer-no-trace.golden
 */

import {
  DECLINED_OFFER_NO_TRACE_ALLOW,
  DECLINE_STATUS_PATHS,
  DECLINED_OFFER_NO_TRACE_KNOWN_TRACES,
} from '../allow-lists/declined-offer-no-trace';
import { listTables } from '../db';
import type { Harness, StepResult } from '../driver';
import { createHarness } from '../driver';
import { buildLabelMap, normalize } from '../normalize';
import { fullRead } from '../privacy';
import { goldenScenarioChecks } from '../scenario-checks';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'declined-offer-no-trace';
const READ_TABLES = ['User', 'Message', 'UserVessel', 'EmpathyAttempt', 'ReconcilerShareOffer', 'ConsentRecord'];

jest.setTimeout(600_000);

/** Leaf paths where two JSON values differ (`a.b.0.c`). */
function differingPaths(a: unknown, b: unknown, p: string[] = [], out: string[] = []): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
  if (obj(a) && obj(b) && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differingPaths(a[k], b[k], [...p, k], out);
    return out;
  }
  out.push(p.join('.'));
  return out;
}

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  let before: StepResult[];
  let after: StepResult[];
  let decline: StepResult;

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `${SCENARIO}_${process.pid}`,
      concept: true,
    });
    const { userA: ada, userB: bob } = harness.actors;
    if (!bob) throw new Error('RECONCILER_SHOWN_B must seed two users');
    const scope = await listTables(harness.fixture.target, harness.fixture.database);

    before = await fullRead(harness, ada, 'before decline', { tables: READ_TABLES, set: 'all' });
    decline = await harness.step({
      label: 'decline share as bob',
      actor: bob,
      tables: scope,
      asyncBoundary: true,
      call: agent =>
        agent.post(`/api/v1/sessions/${harness.sessionId}/reconciler/share-offer/respond`).send({ action: 'decline' }),
    });
    after = await fullRead(harness, ada, 'after decline', { tables: READ_TABLES, set: 'all' });
    steps = [...before, decline, ...after];
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: DECLINED_OFFER_NO_TRACE_ALLOW,
    harness: () => harness,
    steps: () => steps,
  });

  it('the decline happened (the offer is DECLINED and the direction released)', () => {
    expect(decline.status).toBe(200);
    const offer = decline.changes.find(c => c.table === 'ReconcilerShareOffer');
    expect((offer?.after as { status?: string })?.status).toBe('DECLINED');
  });

  it("the author's reads are unchanged by the decline, except the direction's status (known traces aside)", async () => {
    const map = await buildLabelMap(
      harness.fixture.target,
      harness.fixture.database,
      harness.fixture.manifest,
      harness.fixture.seededClerkIds,
    );
    const norm = (s: StepResult) =>
      normalize({ status: s.status, body: s.body }, map, { from: harness.startedAt, to: new Date(Date.now() + 60_000).toISOString() }).value;
    const traces: string[] = [];
    for (const [i, b] of before.entries()) {
      const a = after[i];
      const read = b.label.replace('before decline: ', '');
      expect(a.label).toBe(`after decline: ${read}`);
      for (const p of differingPaths(norm(b), norm(a))) {
        if (!DECLINE_STATUS_PATHS.some(allowed => allowed.read === read && allowed.path === p)) traces.push(`${read} @ ${p}`);
      }
    }
    expect({
      unexpected: traces.filter(t => !DECLINED_OFFER_NO_TRACE_KNOWN_TRACES.some(k => k.at === t)).sort(),
      stale: DECLINED_OFFER_NO_TRACE_KNOWN_TRACES.filter(k => !traces.includes(k.at)).map(k => k.at).sort(),
    }).toEqual({ unexpected: [], stale: [] });
  });
});
