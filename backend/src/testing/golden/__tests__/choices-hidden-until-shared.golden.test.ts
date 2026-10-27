/**
 * Golden scenario R4 (choices half): a partner's choices stay hidden until
 * they are shared (plan §4 "choices and needs hidden until shared"; spec §7).
 *
 * Fixture STAGE4_REDESIGN_PARTNER_INACTIVE: Stage 4 inventory; Ada has made
 * and shared her choice; Bob has made none. Bob chooses (WILLING on both
 * shared proposals) without sharing, Ada reads, Bob sets aside the one open
 * need his choices do not cover and shares, Ada reads again:
 *
 *   before Bob chooses       Ada reads (baseline)
 *   Bob chose, not shared    Ada reads: no partner selection, no partner decision on any card
 *   Bob shared               Ada reads: Bob's decisions visible
 *
 * Probes are Bob's selection rows (today their ids; on the target, where
 * proposal_choice has no id, the instants his choices were written): before
 * sharing they must appear in no read of Ada's. The concept half: every need
 * id `proposal_need` and `need_disposition` name is a `need_share` id.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_PARTNER_INACTIVE
 * Record:   GOLDEN_UPDATE=choices-hidden-until-shared npx jest choices-hidden-until-shared.golden
 *           GOLDEN_UPDATE=choices-hidden-until-shared.concept npx jest choices-hidden-until-shared.golden
 */

import {
  CHOICES_HIDDEN_UNTIL_SHARED_ALLOW,
  CHOICES_HIDDEN_UNTIL_SHARED_BYTE_TARGET_ALLOW,
  CHOICES_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS,
  CHOICES_NEED_LABEL_KNOWN_LEAKS,
  CHOICES_BOB_WRITES_KNOWN_LEAKS,
  ADA_READ_STEPS,
  ADA_SESSION_LIST_STEPS,
  ADA_STAGE4_READ_STEPS,
  BOB_WRITE_STEPS,
} from '../allow-lists/choices-hidden-until-shared';
import { viewName } from '../concept-views';
import { listTables, withClient } from '../db';
import type { ActorRef, Harness, StepResult } from '../driver';
import { createHarness, jobUrlFor } from '../driver';
import { findLeaks, fullRead, unexpectedLeakReport } from '../privacy';
import { goldenScenarioChecks, targetFixtureDeltaChecks } from '../scenario-checks';
import { isTargetShape } from '../shape';
import { Client } from 'pg';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

const SCENARIO = 'choices-hidden-until-shared';
const TARGET = isTargetShape();
// TS-11 renames: Stage4ProposalSelection → proposal_choice, Stage4NeedDeclination → need_disposition.
const READ_TABLES = TARGET
  ? ['user', 'message', 'conversation_read_state', 'participant_milestone', 'proposal_choice', 'need_disposition']
  : ['User', 'Message', 'UserVessel', 'StageProgress', 'Stage4ProposalSelection', 'Stage4NeedDeclination'];
// Not 'strategies': GET /strategies shuffled its list on every call (the old
// anonymous pool), so with more than one proposal it could not be a recorded
// baseline. It carries no choices.
const CHOICE_READS = ['session', 'state', 'progress', 'messages', 'stage4', 'agreements', 'pending actions',
  'session list', 'badge count'];

type Stage4 = {
  data?: {
    partnerSelections?: unknown[];
    partnerSelectionStatus?: string;
    coverageAudit?: Record<'covered' | 'partial' | 'open', Array<{ id: string; note: string | null }>>;
    walkthrough?: { partnerNeeds: Array<{ id: string; label: string }> };
    inventory?: { sharedProposals: Array<{ id: string; needsAddressed: Array<{ id?: string }> }> };
  };
};

jest.setTimeout(600_000);

describe(`golden: ${SCENARIO}`, () => {
  let harness: Harness;
  let steps: StepResult[];
  const phase: Record<string, StepResult[]> = {};
  let bobSelectionProbes: string[] = [];
  let aliases: Array<{ id: string; sameAs: string }> = [];
  const ids: Record<string, string> = {};
  const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(text, params)).rows, harness.fixture.database);

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'STAGE4_REDESIGN_PARTNER_INACTIVE',
      runId: `${SCENARIO}_${process.pid}`,
      concept: true,
    });
    const { userA: ada, userB: bob } = harness.actors;
    if (!bob) throw new Error('STAGE4_REDESIGN_PARTNER_INACTIVE must seed two users');
    const scope = await listTables(harness.fixture.target, harness.fixture.database);
    const sid = harness.sessionId;
    steps = [];

    let proposal: (prefix: string) => string;
    let openNeedId: string;
    if (TARGET) {
      const rows = await harness.snapshot(['proposal', 'need']);
      proposal = prefix => String(rows.tables.proposal.find(p => String(p.description).startsWith(prefix))!.id);
      const needId = (label: string) => String(rows.tables.need.find(n => n.label === label)!.id);
      openNeedId = needId('Appreciation');
      for (const label of ['Partnership', 'Appreciation', 'Understanding', 'Support']) ids[label] = needId(label);
      ids.pause = proposal('Use a pause phrase');
    } else {
      const fixtureRows = await harness.snapshot(['StrategyProposal', 'Stage4NeedCoverage', 'IdentifiedNeed', 'UserVessel']);
      // A coverage row with no needId stands for the need it covers (the DTOs
      // name the need by the row's id): the owner's need with that label.
      aliases = fixtureRows.tables.Stage4NeedCoverage.flatMap(c => {
        const vessel = fixtureRows.tables.UserVessel.find(v => v.userId === c.sourceUserId);
        const need = fixtureRows.tables.IdentifiedNeed.find(n => n.vesselId === vessel?.id && n.need === c.needLabel);
        return need && !c.needId ? [{ id: String(c.id), sameAs: String(need.id) }] : [];
      });
      proposal = prefix => String(fixtureRows.tables.StrategyProposal.find(p => String(p.description).startsWith(prefix))!.id);
      const open = fixtureRows.tables.Stage4NeedCoverage.find(c => c.needLabel === 'Appreciation')!;
      openNeedId = String(open.needId ?? open.id);
    }
    const read = async (label: string, actor: ActorRef): Promise<StepResult[]> => {
      const r = await fullRead(harness, actor, label, { tables: READ_TABLES, set: 'all', only: CHOICE_READS });
      steps.push(...r);
      return r;
    };
    const post = async (label: string, actor: ActorRef, path: string, body: object): Promise<StepResult> => {
      const s = await harness.step({
        label,
        actor,
        tables: scope,
        call: agent => agent.post(`/api/v1/sessions/${sid}${path}`).send(body),
      });
      steps.push(s);
      return s;
    };

    phase.before = await read('before bob chooses', ada);
    for (const [name, prefix] of [
      ['pause', 'Use a pause phrase'],
      ['checkin', 'Try a Sunday'],
    ] as const) {
      await post(`choose ${name} as bob`, bob, `/stage4/proposals/${proposal(prefix)}/selection`, { decision: 'WILLING' });
    }
    if (TARGET) {
      // proposal_choice has no id: the instants Bob's choices were written are their probes (ISO, as a DTO would carry them).
      const iso = (v: unknown) => new Date(`${String(v).replace(' ', 'T')}Z`).toISOString();
      const rows = (await harness.snapshot(['proposal_choice', 'participant'])).tables;
      const bobP = rows.participant.find(p => p.user_id === bob.id)!.id;
      bobSelectionProbes = rows.proposal_choice.filter(c => c.participant_id === bobP).flatMap(c => [iso(c.created_at), iso(c.updated_at)]);
    } else {
      bobSelectionProbes = (await harness.snapshot(['Stage4ProposalSelection'])).tables.Stage4ProposalSelection.filter(
        s => s.userId === bob.id,
      ).map(s => String(s.id));
    }
    phase.unshared = await read('bob chose, not shared', ada);
    // Ada's "Appreciation" is the open need no shared proposal covers: Bob must
    // set it aside before the share gate lets him through.
    await post('set aside open need as bob', bob, `/stage4/needs/${openNeedId}/decline`, {});
    await post('share selections as bob', bob, '/stage4/share-selections', {});
    phase.shared = await read('bob shared', ada);
  });

  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  targetFixtureDeltaChecks({ harness: () => harness, steps: () => steps });
  goldenScenarioChecks({
    scenario: SCENARIO,
    allowList: CHOICES_HIDDEN_UNTIL_SHARED_ALLOW,
    byteTargetAllowList: CHOICES_HIDDEN_UNTIL_SHARED_BYTE_TARGET_ALLOW,
    harness: () => harness,
    steps: () => steps,
    conceptAliases: () => aliases,
  });

  const stage4Of = (p: string) => phase[p].find(s => s.label.includes(': stage4 as'))!.body as Stage4;

  it('every write succeeded and Bob holds two unshared choices before sharing', () => {
    expect(steps.filter(s => !s.label.includes(' as ada@')).map(s => [s.label, s.status])).toEqual([
      ['choose pause as bob', 200],
      ['choose checkin as bob', 200],
      ['set aside open need as bob', 200],
      ['share selections as bob', 200],
    ]);
    expect(bobSelectionProbes).toHaveLength(TARGET ? 4 : 2);
  });

  it("before Bob shares, none of Ada's reads carries his choices (known leaks aside)", () => {
    expect(stage4Of('unshared').data?.partnerSelections).toEqual([]);
    expect(JSON.stringify(stage4Of('unshared'))).not.toContain('"partnerDecisionVisible":"WILLING"');
    const probes = Object.fromEntries(bobSelectionProbes.map((id, i) => [`bob selection ${i + 1}`, id]));
    const observed = findLeaks([...phase.before, ...phase.unshared], probes);
    expect(unexpectedLeakReport(observed, CHOICES_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });

  it('after Bob shares, Ada reads his decisions', () => {
    expect(stage4Of('shared').data?.partnerSelectionStatus).toBe('SUBMITTED');
    expect(stage4Of('shared').data?.partnerSelections).toHaveLength(2);
  });

  it("Bob's need labels never reach Ada's reads (known leaks aside)", () => {
    // BOB_NEEDS in this fixture carry no evidence, so labels are the probes.
    // Quoted: a label is a JSON string value; the bare words also occur in
    // coverage notes and proposal text.
    const probes = { 'bob need label Understanding': '"Understanding"', 'bob need label Support': '"Support"' };
    const observed = findLeaks([...phase.before, ...phase.unshared, ...phase.shared], probes);
    expect(unexpectedLeakReport(observed, CHOICES_NEED_LABEL_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });

  it('the step layout matches the indices the allow-list pins', () => {
    expect(ADA_READ_STEPS.every(i => steps[i].label.endsWith(' as ada@e2e.test'))).toBe(true);
    expect(BOB_WRITE_STEPS.map(i => steps[i].label)).toEqual([
      'choose pause as bob',
      'choose checkin as bob',
      'set aside open need as bob',
      'share selections as bob',
    ]);
    expect(steps).toHaveLength(31);
  });

  // Fix round 2: Bob's own write responses return the Stage 4 state too —
  // with Ada's needs in it. Her labels are probes there (KNOWN if they hit).
  it("Ada's need labels never reach Bob's write responses (known leaks aside)", () => {
    const probes = { 'ada need label Partnership': '"Partnership"', 'ada need label Appreciation': '"Appreciation"' };
    const observed = findLeaks(
      BOB_WRITE_STEPS.map(i => steps[i]),
      probes,
    );
    expect(unexpectedLeakReport(observed, CHOICES_BOB_WRITES_KNOWN_LEAKS)).toEqual({ unexpected: [], stale: [] });
  });

  if (!TARGET) {
    // TAUTOLOGICAL ON THE CURRENT SHAPE (fix round 1, I4): the current-shape
    // proposal_need / need_disposition views join old_concept_need_share, and
    // this fixture has no need_share row at all. The real assertion is target-only.
    it('proposal_need and need_disposition are empty on the current shape (the junction check is targetOnly)', () => {
      const last = steps[steps.length - 1].concept!.after!.tables;
      expect(last[viewName('need_share')]).toEqual([]);
      expect(last[viewName('proposal_need')]).toEqual([]);
      expect(last[viewName('need_disposition')]).toEqual([]);
    });
  } else {
    // targetOnly #1.
    it('target: proposal_need and need_disposition are non-empty after the share, naming only need_share ids', () => {
      const last = steps[steps.length - 1].concept!.after!.tables;
      const shareIds = new Set(last[viewName('need_share')].map(r => r.need_id));
      expect(shareIds.size).toBe(4);
      const pn = last[viewName('proposal_need')];
      const nd = last[viewName('need_disposition')];
      expect(pn.length).toBeGreaterThan(0);
      expect(nd.length).toBeGreaterThan(0);
      for (const r of [...pn, ...nd]) expect(shareIds.has(r.need_id)).toBe(true);
      // Bob's "leave for now" is a DECLINED disposition over Ada's shared Appreciation.
      expect(nd).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'DECLINED' })]));
    });

    // Ruling R29 (Q3): the target-computed Stage 4 values the byte allow-list lets differ.
    // TS-11 post-merge: the pairs of the allow-list's fixture deltas and the
    // newly visible / no-longer-visible Stage 4 entries.
    describe('fixture deltas and R29/R30 (allow-list pairs)', () => {
      const body = (n: number) => (steps[n].body as { data: Record<string, any> }).data;
      const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

      it("feelHeardConfirmedAt is Ada's feel_heard instant on her state and progress reads", async () => {
        const [fh] = await sql<{ at: Date }>(
          `SELECT pm.reached_at AS at FROM participant_milestone pm JOIN participant p ON p.id = pm.participant_id
           JOIN "user" u ON u.id = p.user_id WHERE u.email = 'ada@e2e.test' AND pm.milestone_key = 'feel_heard'`,
        );
        const reads = steps.filter(st => /: (state|progress) as ada@e2e.test$/.test(st.label));
        expect(reads).toHaveLength(6);
        for (const st of reads) {
          const d = (st.body as { data: Record<string, any> }).data;
          expect((d.progress ?? d).milestones.feelHeardConfirmedAt).toBe(iso(fh.at));
        }
      });

      it('the session list says unread only for a message after last_viewed_at not sent by the reader', async () => {
        const [u] = await sql<{ n: string }>(
          `SELECT unread_count::text AS n FROM v_conversation_unread v JOIN participant p ON p.id = v.participant_id
           JOIN "user" u ON u.id = p.user_id WHERE u.email = 'ada@e2e.test'`,
        );
        for (const n of ADA_SESSION_LIST_STEPS) {
          expect(steps[n].label).toMatch(/: session list as ada@e2e.test$/);
          expect(body(n).items[0].hasUnread).toBe(Number(u.n) > 0);
        }
      });

      it("Bob never reads Ada's unshared individual commitment (proposal RLS); its labels resolved to proposal_need (R30)", async () => {
        const [commitment] = await sql<{ id: string; shared_at: Date | null }>(
          `SELECT id, shared_at FROM proposal WHERE kind = 'INDIVIDUAL_COMMITMENT'`,
        );
        expect(commitment.shared_at).toBeNull();
        for (const n of BOB_WRITE_STEPS) expect(JSON.stringify(steps[n].body)).not.toContain(commitment.id);
        const links = await sql<{ description: string; unresolved: string[]; labels: string[] }>(
          `SELECT p.description, p.unresolved_need_labels AS unresolved,
                  array_agg(n.label ORDER BY n.label) AS labels
           FROM proposal p JOIN proposal_need pn ON pn.proposal_id = p.id JOIN need n ON n.id = pn.need_id
           GROUP BY p.id ORDER BY p.created_at`,
        );
        expect(links.map(l => [l.unresolved, l.labels])).toEqual([
          [[], ['Partnership', 'Support']],
          [[], ['Understanding']],
          [[], ['Appreciation']],
          [[], ['Partnership']],
        ]);
      });

      it("the fixture's VALIDATED attempts are revealed at their submission (revealedAtFor)", async () => {
        const rows = await sql<{ s: Date; r: Date | null }>(`SELECT submitted_at AS s, revealed_at AS r FROM empathy_attempt`);
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(iso(r.r)).toBe(iso(r.s));
      });

      it('the rank-shifted instants are their rows’ instants', async () => {
        const choices = await sql<{ email: string; proposal_id: string; created_at: Date; updated_at: Date }>(
          `SELECT u.email, c.proposal_id, c.created_at, c.updated_at FROM proposal_choice c
           JOIN participant p ON p.id = c.participant_id JOIN "user" u ON u.id = p.user_id`,
        );
        const of = (email: string, pid: string) => choices.find(c => c.email === email && c.proposal_id === pid)!;
        for (const n of ADA_STAGE4_READ_STEPS) {
          const sel = body(n).mySelections[0];
          expect(sel.updatedAt).toBe(iso(of('ada@e2e.test', sel.proposalId).updated_at));
        }
        const share = body(21).state;
        const ps = share.partnerSelections[0];
        expect(ps.selectedAt).toBe(iso(of('ada@e2e.test', ps.proposalId).created_at));
        expect(ps.updatedAt).toBe(iso(of('ada@e2e.test', ps.proposalId).updated_at));
        const [latest] = await sql<{ at: Date }>(
          `SELECT max(updated_at) AS at FROM proposal WHERE NOT (kind = 'INDIVIDUAL_COMMITMENT' AND shared_at IS NULL)`,
        );
        expect(share.inventory.updatedAt).toBe(iso(latest.at));
      });
    });

    it('target: Partnership is PARTIAL before Bob chooses (only Ada is WILLING), COVERED once he has shared', () => {
      const ids0 = (p: string, k: 'covered' | 'partial' | 'open') => stage4Of(p).data!.coverageAudit![k].map(r => r.id);
      expect(ids0('before', 'partial')).toContain(ids.Partnership);
      // Bob's unshared WILLING does not move it (choices hidden until choices_shared).
      expect(ids0('unshared', 'partial')).toContain(ids.Partnership);
      expect(ids0('shared', 'covered')).toContain(ids.Partnership);
      // The coverage note has no table: dropped.
      for (const p of ['before', 'unshared', 'shared']) {
        const audit = stage4Of(p).data!.coverageAudit!;
        for (const r of [...audit.covered, ...audit.partial, ...audit.open]) expect(r.note).toBeNull();
      }
    });

    it("target: Bob's Understanding appears in Ada's walkthrough by its shared text, because 'pause' covers it", async () => {
      const [u] = await sql<{ shared_text: string }>(`SELECT shared_text FROM need_share WHERE need_id = $1`, [ids.Understanding]);
      for (const p of ['before', 'unshared', 'shared']) {
        const s = stage4Of(p).data!;
        expect(s.walkthrough!.partnerNeeds).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: ids.Understanding, label: u.shared_text })]),
        );
        const pause = s.inventory!.sharedProposals.find(card => card.id === ids.pause)!;
        expect(pause.needsAddressed.map(n => n.id)).toContain(ids.Understanding);
      }
    });

    // targetOnly #2: closure names only need_share ids — an open SHARED need is
    // in v_session_closure_items, an UNSHARED one never. Runs after the golden
    // checks (outside the recorded steps), on the same run database.
    it('target: closing Stage 4 lists an open shared need in the closure items and never an unshared one', async () => {
      const [bobP] = await sql<{ id: string }>(
        `SELECT p.id FROM participant p JOIN "user" u ON u.id = p.user_id WHERE u.email = 'bob@e2e.test'`,
      );
      const [unshared] = await sql<{ id: string }>(
        `INSERT INTO need (participant_id, label, category, ai_confidence, confirmed_at) VALUES ($1, 'PROBE_UNSHARED_AT_CLOSE', 'MEANING', 0.9, now()) RETURNING id`,
        [bobP.id],
      );
      const [open] = await sql<{ id: string }>(
        `INSERT INTO need (participant_id, label, category, ai_confidence, confirmed_at) VALUES ($1, 'PROBE_OPEN_AT_CLOSE', 'MEANING', 0.9, now()) RETURNING id`,
        [bobP.id],
      );
      await sql(`INSERT INTO consent (participant_id, need_id, decision, decided_at) VALUES ($1, $2, 'GRANTED', now())`, [bobP.id, open.id]);
      const job = new Client({ connectionString: jobUrlFor(harness.fixture.target, harness.fixture.database) });
      await job.connect();
      try {
        await job.query(`SELECT app.need_share($1::uuid, 'An open shared need at closure')`, [open.id]);
      } finally {
        await job.end();
      }
      const close = await harness.step({
        label: 'close as ada (outside the recorded steps)',
        actor: harness.actors.userA,
        tables: [],
        call: agent => agent.post(`/api/v1/sessions/${harness.sessionId}/stage4/close`).send({}),
      });
      expect(close.status).toBe(200);
      const [items] = await sql<{ open_need_ids: string[] }>(
        `SELECT open_need_ids FROM v_session_closure_items WHERE session_id = $1`,
        [harness.sessionId],
      );
      expect(items.open_need_ids).toContain(open.id);
      expect(items.open_need_ids).not.toContain(unshared.id);
      const shareIds = (await sql<{ need_id: string }>(`SELECT need_id FROM need_share`)).map(r => r.need_id);
      for (const id of items.open_need_ids) expect(shareIds).toContain(id);
      expect(JSON.stringify(close.body)).not.toContain('PROBE_OPEN_AT_CLOSE');
      expect(JSON.stringify(close.body)).not.toContain('PROBE_UNSHARED_AT_CLOSE');
    });
  }
});
