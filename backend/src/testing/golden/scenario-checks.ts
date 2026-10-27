/**
 * Golden harness — the checks every recorded scenario makes, as one call.
 *
 * `session-read` and `empathy-reveal` spell these out inline; the TS-5
 * privacy scenarios (R1–R7) share them through `goldenScenarioChecks` so each
 * file carries only what is particular to its scenario. Must be called inside
 * a `describe` whose `beforeAll` sets up the harness and runs the steps.
 */

import type { AllowList } from './allow-lists/types';
import type { Harness, StepResult } from './driver';
import { withClient } from './db';
import { isTargetShape } from './shape';
import { conceptGoldenName, recordOrVerify, recordOrVerifyConcept } from './runner';

export function goldenScenarioChecks(opts: {
  scenario: string;
  allowList: AllowList;
  harness: () => Harness;
  steps: () => StepResult[];
  /** See `recordOrVerifyConcept`'s `aliases`. */
  conceptAliases?: () => Array<{ id: string; sameAs: string }>;
  /**
   * TS-10: on the TARGET shape the byte-level golden is compared under this
   * allow-list (recordOrVerify's `targetAllowList`); required there.
   */
  byteTargetAllowList?: AllowList;
}): void {
  const { scenario, allowList } = opts;

  it('every identifier resolves to a structural label', async () => {
    const report = await recordOrVerify({
      scenario,
      harness: opts.harness(),
      steps: opts.steps(),
      tiedOrder: allowList.rules,
      targetAllowList: opts.byteTargetAllowList,
    });
    expect(report.unresolved).toEqual([]);
  });

  it('matches the recorded baseline', async () => {
    const report = await recordOrVerify({
      scenario,
      harness: opts.harness(),
      steps: opts.steps(),
      tiedOrder: allowList.rules,
      targetAllowList: opts.byteTargetAllowList,
    });
    if (report.recorded) {
      expect(process.env.GOLDEN_UPDATE?.split(',')).toContain(scenario);
      return;
    }
    if (report.diff) throw new Error(`Golden mismatch for "${scenario}":\n${report.diff}`);
    expect(report.diff).toBeNull();
  });

  it('matches the normalised concept baseline under its allow-list', async () => {
    const report = await recordOrVerifyConcept({
      scenario,
      harness: opts.harness(),
      steps: opts.steps(),
      allowList,
      aliases: opts.conceptAliases?.(),
    });
    expect(report.unresolved).toEqual([]);
    if (report.recorded) {
      expect(process.env.GOLDEN_UPDATE?.split(',')).toContain(conceptGoldenName(scenario));
      return;
    }
    if (report.violations.length) {
      throw new Error(`Normalised baseline mismatch for "${scenario}":\n${report.violations.join('\n')}`);
    }
    expect(report.unmatchedRules).toEqual([]);
  });

  it('every step reached quiescence (a timed-out step is not a baseline)', () => {
    expect(opts.steps().filter(s => !s.settled).map(s => s.label)).toEqual([]);
  });
}

/**
 * TS-10, target shape only: the pair of `TARGET_MESSAGE_STAGE_RULE` — every
 * message a read returns carries its owner's stage at the message instant,
 * computed here independently from the run database's milestones. The
 * owner is the step's reader (`… as <email>`).
 */
export function targetMessageStageChecks(opts: { harness: () => Harness; steps: () => StepResult[] }): void {
  const run = isTargetShape() ? it : it.skip;
  run("mayDiffer pair: each message's DTO stage is its owner's stage at the message instant", async () => {
    const h = opts.harness();
    // Imported here, never at module load: stage-shim imports lib/prisma, whose
    // client must be created after the harness repoints DATABASE_URL.
    const { stageAt } = await import('../../services/stage-shim');
    const rows = await withClient(
      h.fixture.target,
      async c =>
        (
          await c.query<{ email: string; key: string; at: Date }>(
            `SELECT u.email, pm.milestone_key AS key, pm.reached_at AS at
             FROM participant_milestone pm JOIN participant p ON p.id = pm.participant_id JOIN "user" u ON u.id = p.user_id
             WHERE p.session_id = $1`,
            [h.sessionId],
          )
        ).rows,
      h.fixture.database,
    );
    const byEmail = new Map<string, Array<{ key: string; reachedAt: Date }>>();
    for (const r of rows) byEmail.set(r.email, [...(byEmail.get(r.email) ?? []), { key: r.key, reachedAt: new Date(r.at) }]);
    let checked = 0;
    for (const step of opts.steps()) {
      const email = /as (\S+)$/.exec(step.label)?.[1];
      const data = (step.body as { data?: { messages?: unknown } } | undefined)?.data;
      if (!email || !data?.messages) continue;
      const list = (Array.isArray(data.messages) ? data.messages : (data.messages as { messages?: unknown[] }).messages ?? []) as Array<{
        stage: number;
        timestamp: string;
      }>;
      for (const m of list) {
        expect({ step: step.label, at: m.timestamp, stage: m.stage }).toEqual({
          step: step.label,
          at: m.timestamp,
          stage: stageAt(byEmail.get(email) ?? [], new Date(m.timestamp)),
        });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
}
