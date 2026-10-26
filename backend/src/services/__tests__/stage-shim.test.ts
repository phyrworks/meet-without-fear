/**
 * The stage shim (TS-9): the one place stage numbers are computed from
 * participant milestones. Pure functions only; the database half is exercised
 * by the session-read golden on the target.
 */

import {
  gatesFor,
  latestStageRow,
  progressDTO,
  stageAt,
  stageRowsFor,
  type MilestoneReached,
  type ParticipantStageState,
} from '../stage-shim';

const t = (s: number) => new Date(Date.UTC(2026, 9, 26, 12, 0, s));
const m = (key: string, s: number): MilestoneReached => ({ key, reachedAt: t(s) });

// Ada in FEEL_HEARD_B: signed, felt heard, submitted her attempt.
const ADA = [m('invitation_sent', 0), m('compact_signed', 30), m('feel_heard', 60), m('empathy_submitted', 90)];

describe('stage shim — stageRowsFor', () => {
  it('rebuilds the old StageProgress rows: every stage before the current one COMPLETED at its terminal milestone', () => {
    const rows = stageRowsFor(2, ADA, t(-10));
    expect(rows.map(r => [r.stage, r.status, r.startedAt, r.completedAt])).toEqual([
      [0, 'COMPLETED', t(-10), t(30)],
      [1, 'COMPLETED', t(30), t(60)],
      [2, 'IN_PROGRESS', t(60), null],
    ]);
  });

  it('completes stage 4 only at `closed`', () => {
    const all = [...ADA, m('empathy_validated', 100), m('needs_shared', 110), m('choices_shared', 120)];
    expect(stageRowsFor(4, all, t(0))[4].status).toBe('IN_PROGRESS');
    const closed = stageRowsFor(4, [...all, m('closed', 130)], t(0))[4];
    expect([closed.status, closed.completedAt]).toEqual(['COMPLETED', t(130)]);
  });
});

describe('stage shim — gatesFor (derived gatesSatisfied)', () => {
  it('derives each stage\'s gate keys from its milestones, with ISO instants', () => {
    expect(gatesFor(0, ADA)).toEqual({ compactSigned: true, signedAt: t(30).toISOString(), invitationSent: true });
    expect(gatesFor(1, ADA)).toEqual({ feelHeardConfirmed: true, feelHeardConfirmedAt: t(60).toISOString() });
    // empathy_submitted is not a gate: Ada's stage-2 gates are empty, as the old row's were.
    expect(gatesFor(2, ADA)).toEqual({});
  });

  it('never produces the four keys the target dropped', () => {
    const everything = [
      'compact_signed', 'invitation_sent', 'feel_heard', 'empathy_submitted', 'empathy_ready', 'empathy_validated',
      'needs_confirmed', 'needs_validated', 'needs_shared', 'repair_walkthrough_started', 'choices_shared', 'closed',
    ].map((k, i) => m(k, i));
    const keys = [0, 1, 2, 3, 4].flatMap(stage => Object.keys(gatesFor(stage, everything)));
    for (const dropped of ['feelHeardCheckOffered', 'readyToRank', 'rankingSubmitted', 'finalEmotionalReading']) {
      expect(keys).not.toContain(dropped);
    }
  });
});

describe('stage shim — stageAt (a message\'s stage)', () => {
  it('is the number of terminal milestones reached by the instant, in order', () => {
    expect(stageAt(ADA, t(10))).toBe(0);
    expect(stageAt(ADA, t(30))).toBe(1); // at the signing instant
    expect(stageAt(ADA, t(59))).toBe(1);
    expect(stageAt(ADA, t(200))).toBe(2);
  });

  it('stops at the first terminal not reached (a later one does not count)', () => {
    expect(stageAt([m('feel_heard', 5)], t(10))).toBe(0);
  });
});

describe('stage shim — latestStageRow (the old partner-activity pick)', () => {
  it('prefers an unfinished row (completedAt DESC NULLS FIRST), then the latest start', () => {
    const rows = stageRowsFor(2, ADA, t(0));
    expect(latestStageRow(rows)?.stage).toBe(2);
    expect(latestStageRow(rows.slice(0, 2))?.stage).toBe(1);
  });
});

describe('stage shim — progressDTO', () => {
  const state = (milestones: MilestoneReached[], stage: number): ParticipantStageState => ({
    participantId: 'p',
    current: { participantId: 'p', milestoneKey: null, ordinal: null, stageLabel: null, nextMilestoneKey: null, stage },
    milestones,
    rows: stageRowsFor(stage, milestones, t(0)),
  });

  it('is NOT_STARTED with null gates only when there is no participant', () => {
    expect(progressDTO(undefined, { gates: false })).toEqual({
      stage: 0,
      status: 'NOT_STARTED',
      startedAt: null,
      completedAt: null,
      gatesSatisfied: null,
    });
  });

  it('is IN_PROGRESS in stage 0 from the join instant for a present participant who reached nothing', () => {
    expect(progressDTO(state([], 0), { gates: true })).toEqual({
      stage: 0,
      status: 'IN_PROGRESS',
      startedAt: t(0).toISOString(),
      completedAt: null,
      gatesSatisfied: {},
    });
  });

  it('is the current row, with or without its derived gates', () => {
    expect(progressDTO(state(ADA, 2), { gates: true })).toEqual({
      stage: 2,
      status: 'IN_PROGRESS',
      startedAt: t(60).toISOString(),
      completedAt: null,
      gatesSatisfied: {},
    });
    expect(progressDTO(state(ADA, 2), { gates: false })).not.toHaveProperty('gatesSatisfied');
  });
});
