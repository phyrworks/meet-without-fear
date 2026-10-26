/**
 * The target-shape writer (TS-9): pure helpers, and — on the target shape,
 * with built templates — what it writes for the covered stages.
 *
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B   (etc.)
 */

import { at } from '../scenario-model';
import { scenarioFor } from '../scenarios';
import { TargetStage } from '../target-stage';
import { milestoneRows, revealedAtFor, roleAndKind, splitName, unsupportedFeatures } from '../target-shape';
import { applyConceptViews, takeConceptSnapshot } from '../../golden/concept-views';
import { withClient } from '../../golden/db';
import { restoreFixture } from '../../golden/fixtures';
import { isTargetShape } from '../../golden/shape';

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const t = (s: { offsetMs: number }) => new Date(T0 + s.offsetMs);

describe('target writer — pure helpers', () => {
  it('splits old single roles into role + kind (role USER for a delivered item with a sender)', () => {
    expect(roleAndKind('USER', true)).toEqual({ role: 'USER', kind: 'CHAT' });
    expect(roleAndKind('AI', false)).toEqual({ role: 'AI', kind: 'CHAT' });
    expect(roleAndKind('EMPATHY_STATEMENT', true)).toEqual({ role: 'USER', kind: 'EMPATHY_STATEMENT' });
    expect(roleAndKind('SHARED_CONTEXT', false)).toEqual({ role: 'AI', kind: 'SHARED_CONTEXT' });
  });

  it('splits a display name into the first/last names the generated `name` is built from', () => {
    expect(splitName('Ada Lovelace')).toEqual({ first: 'Ada', last: 'Lovelace' });
    expect(splitName('Prince')).toEqual({ first: 'Prince', last: null });
    expect(splitName('Mary Ann Evans')).toEqual({ first: 'Mary', last: 'Ann Evans' });
  });

  it('writes invitation_sent at the journey start (step 7 decoding), every other milestone at its own instant', () => {
    const s = scenarioFor(TargetStage.FEEL_HEARD_B, { a: 'Ada Lovelace', b: 'Bob Ross' });
    const ada = s.participants[0];
    const rows = milestoneRows(ada, t, t(ada.journey!.startedAt!));
    expect(rows.find(r => r.key === 'invitation_sent')?.reachedAt).toEqual(t(ada.journey!.startedAt!));
    expect(rows.find(r => r.key === 'empathy_submitted')?.reachedAt).toEqual(t(ada.milestones.empathy_submitted!));
    expect(rows.map(r => r.key).sort()).toEqual(['compact_signed', 'empathy_submitted', 'feel_heard', 'invitation_sent']);
  });

  it('gives a VALIDATED attempt without a reveal instant its validation instant (target CHECK)', () => {
    expect(revealedAtFor({ status: 'HELD' }, t)).toBeNull();
    expect(revealedAtFor({ status: 'REVEALED', revealedAt: at(5) }, t)).toEqual(t(at(5)));
    expect(revealedAtFor({ status: 'VALIDATED', validatedBy: { at: at(9) } }, t)).toEqual(t(at(9)));
    expect(revealedAtFor({ status: 'VALIDATED' }, t, at(3))).toEqual(t(at(3)));
  });

  it('refuses the repair stage rather than write a partial state', () => {
    const covered = [
      TargetStage.CREATED,
      TargetStage.INVITATION_READY,
      TargetStage.EMPATHY_SHARED_A,
      TargetStage.FEEL_HEARD_B,
      TargetStage.RECONCILER_SHOWN_B,
      TargetStage.CONTEXT_SHARED_B,
      TargetStage.EMPATHY_REVEALED,
      TargetStage.NEED_MAPPING_COMPLETE,
      TargetStage.NEEDS_CONFIRMED,
      TargetStage.INNER_WORK_LINKED_A,
    ];
    for (const stage of covered) {
      expect({ stage, unsupported: unsupportedFeatures(scenarioFor(stage, { a: 'A', b: 'B' })) }).toEqual({ stage, unsupported: [] });
    }
    expect(unsupportedFeatures(scenarioFor(TargetStage.STRATEGIC_REPAIR_COMPLETE, { a: 'A', b: 'B' }))).toContain('legacyStrategies');
  });
});

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('target writer — FEEL_HEARD_B as written (target fixture template)', () => {
  const BASE_URL =
    process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

  it('holds the scenario: two participants, one MAIN conversation each, the milestones, 23 messages, one attempt; the concept views represent it', async () => {
    const fx = await restoreFixture({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `writer_${process.pid}` });
    try {
      const q = async (sql: string) => withClient(fx.target, async c => (await c.query(sql)).rows, fx.database);
      expect(await q(`SELECT kind::text, count(*)::int AS n FROM conversation GROUP BY kind`)).toEqual([{ kind: 'MAIN', n: 2 }]);
      expect(
        await q(
          `SELECT u.email, array_agg(pm.milestone_key ORDER BY pm.milestone_key) AS keys
           FROM participant_milestone pm JOIN participant p ON p.id = pm.participant_id JOIN "user" u ON u.id = p.user_id
           GROUP BY u.email ORDER BY u.email`,
        ),
      ).toEqual([
        { email: 'ada@e2e.test', keys: ['compact_signed', 'empathy_submitted', 'feel_heard', 'invitation_sent'] },
        { email: 'bob@e2e.test', keys: ['compact_signed', 'feel_heard'] },
      ]);
      expect(await q(`SELECT count(*)::int AS n FROM message`)).toEqual([{ n: 23 }]);
      expect(await q(`SELECT name FROM "user" ORDER BY email`)).toEqual([{ name: 'Ada Lovelace' }, { name: 'Bob Ross' }]);
      // Every message is in its owner's conversation: the sender, when there is one, owns it — except the AI.
      expect(
        await q(
          `SELECT count(*)::int AS n FROM message m JOIN conversation c ON c.id = m.conversation_id
           WHERE m.sender_participant_id IS NOT NULL AND m.sender_participant_id <> c.participant_id`,
        ),
      ).toEqual([{ n: 0 }]);
      await applyConceptViews(fx.target, fx.database);
      const snap = await takeConceptSnapshot(fx.target, fx.database);
      expect(snap.tables.old_concept_participant.length).toBe(2);
    } finally {
      await fx.drop();
    }
  });
});
