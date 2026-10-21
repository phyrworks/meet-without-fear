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
import { conceptGoldenName, recordOrVerify, recordOrVerifyConcept } from './runner';

export function goldenScenarioChecks(opts: {
  scenario: string;
  allowList: AllowList;
  harness: () => Harness;
  steps: () => StepResult[];
}): void {
  const { scenario, allowList } = opts;

  it('every identifier resolves to a structural label', async () => {
    const report = await recordOrVerify({ scenario, harness: opts.harness(), steps: opts.steps() });
    expect(report.unresolved).toEqual([]);
  });

  it('matches the recorded baseline', async () => {
    const report = await recordOrVerify({ scenario, harness: opts.harness(), steps: opts.steps() });
    if (report.recorded) {
      expect(process.env.GOLDEN_UPDATE?.split(',')).toContain(scenario);
      return;
    }
    if (report.diff) throw new Error(`Golden mismatch for "${scenario}":\n${report.diff}`);
    expect(report.diff).toBeNull();
  });

  it('matches the normalised concept baseline under its allow-list', async () => {
    const report = await recordOrVerifyConcept({ scenario, harness: opts.harness(), steps: opts.steps(), allowList });
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
