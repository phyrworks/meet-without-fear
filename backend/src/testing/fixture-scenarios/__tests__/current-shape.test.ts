import {
  GATE_ENCODING,
  gatesToJson,
  invitationFields,
  messageSender,
  phaseToStage,
  referencedClocks,
  resolveStamp,
  sessionStatus,
  stageProgressPlan,
} from '../current-shape';
import { at, DAY, ParticipantScenario, Scenario } from '../scenario-model';
import { scenarioFor } from '../scenarios';
import { TargetStage } from '../target-stage';

const base = (participants: ParticipantScenario[], extra: Partial<Scenario> = {}): Scenario => ({
  name: 'test',
  participants,
  invitation: { expiresAt: at(7 * DAY, 'invitation') },
  ...extra,
});

describe('stageProgressPlan — milestone set → StageProgress rows', () => {
  it('writes nothing for a participant whose journey has not begun', () => {
    const s = base([{ key: 'a', milestones: {} }]);
    expect(stageProgressPlan(s.participants[0], s)).toEqual({ rows: [], lateGates: [] });
  });

  it('a journey with no milestones is stage 0 in progress, started at the database default', () => {
    const s = base([{ key: 'a', journey: {}, milestones: {} }]);
    expect(stageProgressPlan(s.participants[0], s).rows).toEqual([
      { stage: 0, status: 'IN_PROGRESS', startedAt: undefined, completedAt: undefined, gates: [] },
    ]);
  });

  it('completes each stage at its terminal milestone and chains startedAt from the previous completion', () => {
    const s = base([
      {
        key: 'a',
        journey: { startedAt: at(-180000) },
        milestones: { compact_signed: at(-150000), feel_heard: at(-120000), empathy_submitted: at(-90000) },
      },
    ]);
    expect(stageProgressPlan(s.participants[0], s).rows).toEqual([
      {
        stage: 0,
        status: 'COMPLETED',
        startedAt: at(-180000),
        completedAt: at(-150000),
        gates: [
          ['compactSigned', true],
          ['compactSignedAt', at(-150000)],
        ],
      },
      {
        stage: 1,
        status: 'COMPLETED',
        startedAt: at(-150000),
        completedAt: at(-120000),
        gates: [
          ['feelHeardConfirmed', true],
          ['feelHeardConfirmedAt', at(-120000)],
        ],
      },
      // empathy_submitted is carried by the attempt row, never by a gate
      { stage: 2, status: 'IN_PROGRESS', startedAt: at(-120000), completedAt: undefined, gates: [] },
    ]);
  });

  it('omits the …At companion for milestones listed as untimed gates', () => {
    const s = base(
      [{ key: 'a', journey: { startedAt: at(-10) }, milestones: { compact_signed: at(-5) } }],
      { currentShape: { untimedGates: ['compact_signed'] } }
    );
    expect(stageProgressPlan(s.participants[0], s).rows[0].gates).toEqual([['compactSigned', true]]);
  });

  it('encodes stage 3: needs_confirmed/needs_validated as gates, needs_shared as the completion only', () => {
    const s = base([
      {
        key: 'a',
        journey: { startedAt: at(-350000) },
        milestones: {
          compact_signed: at(-300000),
          feel_heard: at(-240000),
          empathy_validated: at(-120000),
          needs_confirmed: at(-60000),
          needs_validated: at(-30000),
          needs_shared: at(0),
        },
      },
    ]);
    const rows = stageProgressPlan(s.participants[0], s).rows;
    expect(rows.map((r) => [r.stage, r.status])).toEqual([
      [0, 'COMPLETED'],
      [1, 'COMPLETED'],
      [2, 'COMPLETED'],
      [3, 'COMPLETED'],
      [4, 'IN_PROGRESS'],
    ]);
    expect(rows[2].gates).toEqual([
      ['empathyExchanged', true],
      ['empathyExchangedAt', at(-120000)],
    ]);
    expect(rows[3]).toEqual({
      stage: 3,
      status: 'COMPLETED',
      startedAt: at(-120000),
      completedAt: at(0),
      gates: [
        ['needsIdentified', true],
        ['needsIdentifiedAt', at(-60000)],
        ['needsValidated', true],
        ['needsValidatedAt', at(-30000)],
      ],
    });
    expect(rows[4]).toEqual({ stage: 4, status: 'IN_PROGRESS', startedAt: at(0), completedAt: undefined, gates: [] });
  });

  it('closed completes stage 4 and derives the legacy ranking/agreement keys from content', () => {
    const p: ParticipantScenario = {
      key: 'a',
      journey: { startedAt: at(-5) },
      milestones: {
        compact_signed: at(-4),
        feel_heard: at(-3),
        empathy_validated: at(-2),
        needs_shared: at(-1),
        closed: at(0),
      },
      ranking: { proposals: ['s1'], submittedAt: at(-1) },
    };
    const s = base([p], {
      currentShape: { untimedGates: ['compact_signed', 'feel_heard', 'empathy_validated'] },
      legacyStrategies: {
        strategies: [{ key: 's1', by: 'a', description: 'd', needsAddressed: [], duration: 'ongoing', at: at(-2) }],
        agreement: {
          proposal: 's1',
          description: 'd',
          type: 'COMMITMENT',
          status: 'AGREED',
          agreedBy: ['a'],
          agreedAt: at(0),
          followUpAt: at(14 * DAY),
        },
      },
    });
    const rows = stageProgressPlan(p, s).rows;
    expect(rows).toHaveLength(5);
    expect(rows[4]).toEqual({
      stage: 4,
      status: 'COMPLETED',
      startedAt: at(-1),
      completedAt: at(0),
      gates: [
        ['strategiesRanked', true],
        ['agreementCreated', true],
        ['agreementConfirmed', true],
      ],
    });
  });

  it('derives no stage-4 keys when there is no ranking or agreement', () => {
    const p: ParticipantScenario = { key: 'a', journey: {}, milestones: {} };
    expect(stageProgressPlan(p, base([p])).rows[0].gates).toEqual([]);
  });

  it('records choices_shared after the choices it attests to, as a late gate on the stage-4 row', () => {
    const p: ParticipantScenario = {
      key: 'a',
      journey: { startedAt: at(-5) },
      milestones: {
        compact_signed: at(-4),
        feel_heard: at(-3),
        empathy_validated: at(-2),
        needs_shared: at(-1),
        choices_shared: at(0, 'late'),
      },
      choices: [{ proposal: 'p1', decision: 'WILLING' }],
    };
    const plan = stageProgressPlan(p, base([p]));
    expect(plan.rows[4]).toEqual({ stage: 4, status: 'IN_PROGRESS', startedAt: at(-1), completedAt: undefined, gates: [] });
    expect(plan.lateGates).toEqual([
      {
        stage: 4,
        gates: [
          ['selectionSubmitted', true],
          ['selectionSubmittedAt', at(0, 'late')],
        ],
      },
    ]);
  });

  it('refuses a gate milestone for a stage the participant has not reached', () => {
    const p: ParticipantScenario = { key: 'a', journey: {}, milestones: { needs_confirmed: at(0) } };
    expect(() => stageProgressPlan(p, base([p]))).toThrow(/needs_confirmed.*stage 3/);
  });

  it('refuses milestones today’s fixtures never encoded rather than dropping them', () => {
    for (const key of ['paused', 'repair_walkthrough_started', 'empathy_ready'] as const) {
      const p: ParticipantScenario = { key: 'a', journey: {}, milestones: { [key]: at(0) } };
      expect(() => stageProgressPlan(p, base([p]))).toThrow(new RegExp(key));
    }
  });

  it('refuses a stage completed out of order', () => {
    const p: ParticipantScenario = { key: 'a', journey: {}, milestones: { feel_heard: at(0) } };
    expect(() => stageProgressPlan(p, base([p]))).toThrow(/feel_heard/);
  });
});

describe('gatesToJson', () => {
  it('renders flags as true and stamps as ISO strings', () => {
    const resolve = () => new Date('2026-01-01T00:00:00.000Z');
    expect(
      gatesToJson(
        [
          ['compactSigned', true],
          ['compactSignedAt', at(0)],
        ],
        resolve
      )
    ).toEqual({ compactSigned: true, compactSignedAt: '2026-01-01T00:00:00.000Z' });
    expect(gatesToJson([], resolve)).toEqual({});
  });
});

describe('session and invitation encoding', () => {
  const inviter = (milestones = {}): ParticipantScenario => ({ key: 'a', milestones });

  it('session status: CREATED, then INVITED once the invitation is sent, ACTIVE once accepted', () => {
    expect(sessionStatus(base([inviter()]))).toBe('CREATED');
    expect(sessionStatus(base([inviter({ invitation_sent: at(0, 'invitation') })]))).toBe('INVITED');
    expect(
      sessionStatus(
        base([inviter({ invitation_sent: at(0, 'invitation') })], {
          invitation: { acceptedAt: at(0, 'invitation'), expiresAt: at(7 * DAY, 'invitation') },
        })
      )
    ).toBe('ACTIVE');
  });

  it('invitation_sent is encoded on the Invitation row, not as a gate', () => {
    const s = base([inviter({ invitation_sent: at(0, 'invitation') })]);
    expect(invitationFields(s)).toEqual({
      status: 'PENDING',
      createdAt: at(0, 'invitation'),
      acceptedAt: undefined,
      expiresAt: at(7 * DAY, 'invitation'),
      messageConfirmed: true,
      messageConfirmedAt: at(0, 'invitation'),
    });
    expect(invitationFields(base([inviter()]))).toMatchObject({ messageConfirmed: false, messageConfirmedAt: undefined });
  });
});

describe('clocks', () => {
  it('reads only the clocks a scenario references, in fixed order', () => {
    const s = base([{ key: 'a', journey: {}, milestones: {} }]);
    expect(referencedClocks(s)).toEqual(['invitation']);
    const t = base([{ key: 'a', journey: { startedAt: at(-1) }, milestones: { choices_shared: at(0, 'late') } }], {
      topic: { frame: 'x', confirmedAt: at(0, 'session') },
    });
    expect(referencedClocks(t)).toEqual(['session', 'invitation', 'scenario', 'late']);
  });

  it('resolves a stamp against its clock instant', () => {
    const instants = { scenario: new Date(10_000) };
    expect(resolveStamp(at(-2_500), instants).getTime()).toBe(7_500);
    expect(() => resolveStamp(at(0, 'late'), instants)).toThrow(/late/);
  });

  it('message authorship: USER is the owner, other roles nobody, unless stated', () => {
    const m = (role: 'USER' | 'AI' | 'EMPATHY_STATEMENT', from?: string | null) => ({
      role,
      content: 'x',
      phase: 'witness' as const,
      at: at(0),
      ...(from !== undefined ? { from } : {}),
    });
    expect(messageSender('a', m('USER'))).toBe('a');
    expect(messageSender('a', m('AI'))).toBeNull();
    expect(messageSender('a', m('EMPATHY_STATEMENT'))).toBeNull();
    expect(messageSender('a', m('EMPATHY_STATEMENT', 'a'))).toBe('a');
    expect(messageSender('a', m('USER', null))).toBeNull();
  });

  it('maps journey phases to today’s Message.stage integers', () => {
    expect(['onboarding', 'witness', 'perspective', 'needs', 'repair'].map((p) => phaseToStage(p as never))).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});

describe('gate encoding table', () => {
  it('covers every milestone key exactly once', () => {
    expect(Object.keys(GATE_ENCODING).sort()).toEqual(
      [
        'choices_shared',
        'closed',
        'compact_signed',
        'empathy_ready',
        'empathy_submitted',
        'empathy_validated',
        'feel_heard',
        'invitation_sent',
        'needs_confirmed',
        'needs_shared',
        'needs_validated',
        'paused',
        'repair_walkthrough_started',
      ].sort()
    );
  });
});

describe('scenarios', () => {
  const names = { a: 'Ada Lovelace', b: 'Bob Ross' };

  it.each(Object.values(TargetStage))('%s translates to current-shape rows for every participant', (stage) => {
    for (const withB of [true, false]) {
      const s = scenarioFor(stage, { a: names.a, b: withB ? names.b : undefined });
      expect(s.name).toBe(stage);
      expect(s.participants.length).toBe(withB ? 2 : 1);
      for (const p of s.participants) expect(() => stageProgressPlan(p, s)).not.toThrow();
      expect(() => invitationFields(s)).not.toThrow();
    }
  });

  it('every attempt has an empathy_submitted milestone and every choice set has choices_shared', () => {
    for (const stage of Object.values(TargetStage)) {
      const s = scenarioFor(stage, names);
      for (const p of s.participants) {
        if (p.empathy) expect(p.milestones.empathy_submitted).toBeDefined();
        expect(Boolean(p.choices?.length)).toBe(Boolean(p.milestones.choices_shared));
        if (p.needs?.length) expect(p.milestones.needs_confirmed).toBeDefined();
      }
    }
  });

  it('FEEL_HEARD_B: both signed and felt heard; only Ada has submitted empathy', () => {
    const s = scenarioFor(TargetStage.FEEL_HEARD_B, names);
    const [a, b] = s.participants;
    expect(Object.keys(a.milestones).sort()).toEqual(
      ['compact_signed', 'empathy_submitted', 'feel_heard', 'invitation_sent'].sort()
    );
    expect(Object.keys(b.milestones).sort()).toEqual(['compact_signed', 'feel_heard'].sort());
    expect(sessionStatus(s)).toBe('ACTIVE');
    expect(stageProgressPlan(b, s).rows.map((r) => r.status)).toEqual(['COMPLETED', 'COMPLETED', 'IN_PROGRESS']);
  });
});
