/**
 * The stage shim (TS-9): the one place stage numbers are computed from
 * participant milestones. Pure functions only; the database half is exercised
 * by the session-read golden on the target.
 */

import {
  activeStage,
  milestoneMap,
  PARTNER_VISIBLE_MILESTONES,
  partnerMilestoneMap,
  latestStageRow,
  messageStage,
  progressDTO,
  stageAt,
  stageRowsFor,
  unreachedStageMilestones,
  witnessStartedAt,
  type MilestoneReached,
  type ParticipantStageState,
} from '../stage-shim';
import { PARTNER_VISIBLE_BY_STAGE } from '../../testing/golden/scenario-checks';

const t = (s: number) => new Date(Date.UTC(2026, 9, 26, 12, 0, s));
const m = (key: string, s: number): MilestoneReached => ({ key, reachedAt: t(s) });
/** Not an inviter with an unsent invitation (the option is required: work-qmgc). */
const NP = { invitationPending: false };

// Ada in FEEL_HEARD_B: signed, felt heard, submitted her attempt.
const ADA = [m('invitation_sent', 0), m('compact_signed', 30), m('feel_heard', 60), m('empathy_submitted', 90)];

describe('stage shim — stageRowsFor', () => {
  it('rebuilds the old StageProgress rows: every stage before the current one COMPLETED at its terminal milestone', () => {
    const rows = stageRowsFor(2, ADA, t(-10), NP);
    expect(rows.map(r => [r.stage, r.status, r.startedAt, r.completedAt])).toEqual([
      [0, 'COMPLETED', t(-10), t(30)],
      [1, 'COMPLETED', t(30), t(60)],
      [2, 'IN_PROGRESS', t(60), null],
    ]);
  });

  it('completes stage 4 only at `closed`', () => {
    const all = [...ADA, m('empathy_validated', 100), m('needs_shared', 110), m('choices_shared', 120)];
    expect(stageRowsFor(4, all, t(0), NP)[4].status).toBe('IN_PROGRESS');
    const closed = stageRowsFor(4, [...all, m('closed', 130)], t(0), NP)[4];
    expect([closed.status, closed.completedAt]).toEqual(['COMPLETED', t(130)]);
  });
});

const EVERYTHING = [
  'invitation_sent',
  'compact_signed',
  'feel_heard',
  'empathy_submitted',
  'empathy_ready',
  'empathy_validated',
  'needs_confirmed',
  'needs_validated',
  'needs_shared',
  'repair_walkthrough_started',
  'choices_shared',
  'closed',
  'paused',
].map((k, i) => m(k, i));

describe('stage shim — milestoneMap (the DTO milestones)', () => {
  it('maps every reached milestone to its ISO instant, no key list, no renaming', () => {
    expect(milestoneMap(ADA)).toEqual({
      invitation_sent: t(0).toISOString(),
      compact_signed: t(30).toISOString(),
      feel_heard: t(60).toISOString(),
      empathy_submitted: t(90).toISOString(),
    });
    expect(Object.keys(milestoneMap(EVERYTHING))).toHaveLength(EVERYTHING.length);
    expect(milestoneMap([])).toEqual({});
  });
});

describe('stage shim — partnerMilestoneMap (never wider than the old partner gates)', () => {
  it('PARTNER_VISIBLE_MILESTONES equals the literal old-gate table the golden pair check uses', () => {
    expect(PARTNER_VISIBLE_MILESTONES).toEqual(PARTNER_VISIBLE_BY_STAGE);
  });

  it("exposes only the partner's current stage's old gate milestones", () => {
    const keysAt = (stage: number) => Object.keys(partnerMilestoneMap(stage, EVERYTHING)).sort();
    expect(keysAt(0)).toEqual(['compact_signed', 'invitation_sent']);
    expect(keysAt(1)).toEqual(['feel_heard']);
    // empathy_submitted / empathy_ready were never partner-visible gates.
    expect(keysAt(2)).toEqual(['empathy_validated']);
    expect(keysAt(3)).toEqual(['needs_confirmed', 'needs_shared', 'needs_validated']);
    // repair_walkthrough_started, closed and paused were never gates.
    expect(keysAt(4)).toEqual(['choices_shared']);
  });

  it("shows the partner's invitation_sent as true, never its instant (the old gate had no instant)", () => {
    expect(partnerMilestoneMap(0, EVERYTHING)).toEqual({
      compact_signed: EVERYTHING[1].reachedAt.toISOString(),
      invitation_sent: true,
    });
    expect(JSON.stringify(partnerMilestoneMap(0, EVERYTHING))).not.toContain(EVERYTHING[0].reachedAt.toISOString());
  });

  it('carries only reached milestones, with their instants', () => {
    expect(partnerMilestoneMap(1, ADA)).toEqual({ feel_heard: t(60).toISOString() });
    expect(partnerMilestoneMap(2, ADA)).toEqual({});
  });
});

describe('stage shim — unreachedStageMilestones (POST /stages/advance)', () => {
  it("lists the stage's required milestones not reached", () => {
    expect(unreachedStageMilestones(1, [m('compact_signed', 1)], NP)).toEqual(['feel_heard']);
    expect(unreachedStageMilestones(3, [m('needs_confirmed', 1)], NP)).toEqual(['needs_validated', 'needs_shared']);
    expect(unreachedStageMilestones(4, [m('choices_shared', 1)], NP)).toEqual(['closed']);
  });

  it('holds a pending inviter who signed on invitation_sent (the shim keeps them in stage 0)', () => {
    expect(unreachedStageMilestones(0, [m('compact_signed', 1)], { invitationPending: true })).toEqual([
      'invitation_sent',
    ]);
    expect(unreachedStageMilestones(0, [], { invitationPending: true })).toEqual(['compact_signed', 'invitation_sent']);
    expect(unreachedStageMilestones(0, [m('compact_signed', 1)], NP)).toEqual([]);
  });
});

describe("stage shim — stageAt (a message's stage)", () => {
  it('is the number of terminal milestones reached by the instant, in order', () => {
    expect(stageAt(ADA, t(10), NP)).toBe(0);
    expect(stageAt(ADA, t(30), NP)).toBe(1); // at the signing instant
    expect(stageAt(ADA, t(59), NP)).toBe(1);
    expect(stageAt(ADA, t(200), NP)).toBe(2);
  });

  it('stops at the first terminal not reached (a later one does not count)', () => {
    expect(stageAt([m('feel_heard', 5)], t(10), NP)).toBe(0);
  });
});

describe('stage shim — latestStageRow (the old partner-activity pick)', () => {
  it('prefers an unfinished row (completedAt DESC NULLS FIRST), then the latest start', () => {
    const rows = stageRowsFor(2, ADA, t(0), NP);
    expect(latestStageRow(rows)?.stage).toBe(2);
    expect(latestStageRow(rows.slice(0, 2))?.stage).toBe(1);
  });
});

describe('stage shim — progressDTO', () => {
  const state = (milestones: MilestoneReached[], stage: number): ParticipantStageState => ({
    participantId: 'p',
    current: {
      participantId: 'p',
      milestoneKey: null,
      ordinal: null,
      stageLabel: null,
      nextMilestoneKey: null,
      stage,
      invitationPending: false,
    },
    invitationPending: false,
    milestones,
    rows: stageRowsFor(stage, milestones, t(0), NP),
  });

  it('is NOT_STARTED only when there is no participant', () => {
    expect(progressDTO(undefined, { milestones: 'none' })).toEqual({
      stage: 0,
      status: 'NOT_STARTED',
      startedAt: null,
      completedAt: null,
    });
    expect(progressDTO(undefined, { milestones: 'partner' })).toEqual({
      stage: 0,
      status: 'NOT_STARTED',
      startedAt: null,
      completedAt: null,
      milestones: {},
    });
  });

  it('is IN_PROGRESS in stage 0 from the join instant for a present participant who reached nothing', () => {
    expect(progressDTO(state([], 0), { milestones: 'own' })).toEqual({
      stage: 0,
      status: 'IN_PROGRESS',
      startedAt: t(0).toISOString(),
      completedAt: null,
      milestones: {},
    });
  });

  it('is the current row, with every own milestone, the partner subset, or none', () => {
    expect(progressDTO(state(ADA, 2), { milestones: 'own' })).toEqual({
      stage: 2,
      status: 'IN_PROGRESS',
      startedAt: t(60).toISOString(),
      completedAt: null,
      milestones: milestoneMap(ADA),
    });
    expect(progressDTO(state(ADA, 2), { milestones: 'partner' }).milestones).toEqual({});
    expect(progressDTO(state(ADA, 2), { milestones: 'none' })).not.toHaveProperty('milestones');
  });

  it('witnessStartedAt is the start of stage 1 (the end of stage 0), null before it', () => {
    expect(witnessStartedAt(state(ADA, 2))).toBe(t(30).toISOString());
    expect(witnessStartedAt(state([], 0))).toBeNull();
    expect(witnessStartedAt(undefined)).toBeNull();
  });
});

// work-qmgc: the inviter signs the compact before crafting the invitation. The
// old StageProgress contract kept them IN_PROGRESS in stage 0 until
// POST /invitation/confirm (old sessions.ts: stage 0 COMPLETED with
// { compactSigned, invitationSent }); the client's invitation follow-up is
// gated on stage 0 (UnifiedSessionScreen shouldRunInvitationFollowUp).
describe('stage shim — Getting Started for an inviter (work-qmgc)', () => {
  // Ada signed at 10 while crafting, sent the invitation at 40.
  const SIGNED = [m('compact_signed', 10)];
  const SENT = [m('compact_signed', 10), m('invitation_sent', 40)];

  it('keeps an inviter with an unsent invitation in stage 0 after signing', () => {
    expect(activeStage(1, { invitationPending: true })).toBe(0);
    expect(activeStage(1, { invitationPending: false })).toBe(1);
    expect(stageAt(SIGNED, t(20), { invitationPending: true })).toBe(0);
    expect(messageStage(SIGNED, t(20), { invitationPending: true })).toBe(0);
    const rows = stageRowsFor(0, SIGNED, t(0), { invitationPending: true });
    expect(rows.map(r => [r.stage, r.status, r.completedAt])).toEqual([[0, 'IN_PROGRESS', null]]);
  });

  it('ends stage 0 at the later of compact_signed and invitation_sent once both exist', () => {
    expect(stageAt(SENT, t(20), NP)).toBe(0); // crafting, after signing: still stage 0
    expect(stageAt(SENT, t(40), NP)).toBe(1);
    expect(stageRowsFor(1, SENT, t(0), NP).map(r => [r.stage, r.status, r.startedAt, r.completedAt])).toEqual([
      [0, 'COMPLETED', t(0), t(40)],
      [1, 'IN_PROGRESS', t(40), null],
    ]);
  });

  it('leaves an invitee (no invitation of their own) at compact_signed', () => {
    expect(stageAt(SIGNED, t(20), NP)).toBe(1);
    expect(activeStage(1, { invitationPending: false })).toBe(1);
  });
  it('ends stage 0 at compact_signed when the invitation was sent first (the fixture order)', () => {
    const SENT_FIRST = [m('invitation_sent', 5), m('compact_signed', 10)];
    expect(stageAt(SENT_FIRST, t(7), NP)).toBe(0);
    expect(stageAt(SENT_FIRST, t(10), NP)).toBe(1);
    expect(stageRowsFor(1, SENT_FIRST, t(0), NP).map(r => [r.stage, r.status, r.completedAt])).toEqual([
      [0, 'COMPLETED', t(10)],
      [1, 'IN_PROGRESS', null],
    ]);
  });

  it('keeps a pending inviter who has not signed yet in stage 0', () => {
    expect(stageAt([], t(20), { invitationPending: true })).toBe(0);
    expect(activeStage(0, { invitationPending: true })).toBe(0);
  });
});
