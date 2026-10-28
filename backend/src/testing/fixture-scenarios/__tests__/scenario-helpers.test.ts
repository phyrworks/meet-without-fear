/**
 * The shape-independent helpers the target-shape writer consumes. Ported from
 * the deleted `current-shape.test.ts` (TS-13, ruling R42): the cases below are
 * the ones that test these helpers; the StageProgress / gate-encoding cases
 * tested only the current-shape writer and left with it.
 */
import { invitationFields, messageSender, referencedClocks, resolveStamp, sessionStatus } from '../scenario-helpers';
import { at, DAY, ParticipantScenario, Scenario } from '../scenario-model';
import { scenarioFor } from '../scenarios';
import { TargetStage } from '../target-stage';

const base = (participants: ParticipantScenario[], extra: Partial<Scenario> = {}): Scenario => ({
  name: 'test',
  participants,
  invitation: { expiresAt: at(7 * DAY, 'invitation') },
  ...extra,
});

describe('session and invitation fields', () => {
  const inviter = (milestones = {}): ParticipantScenario => ({ key: 'a', milestones });

  it('session status: CREATED, then INVITED once the invitation is sent, ACTIVE once accepted', () => {
    expect(sessionStatus(base([inviter()]))).toBe('CREATED');
    expect(sessionStatus(base([inviter({ invitation_sent: at(0, 'invitation') })]))).toBe('INVITED');
    expect(
      sessionStatus(
        base([inviter({ invitation_sent: at(0, 'invitation') })], {
          invitation: { acceptedAt: at(0, 'invitation'), expiresAt: at(7 * DAY, 'invitation') },
        }),
      ),
    ).toBe('ACTIVE');
  });

  it('invitation_sent is the invitation’s confirmed message', () => {
    const s = base([inviter({ invitation_sent: at(0, 'invitation') })]);
    expect(invitationFields(s)).toEqual({
      status: 'PENDING',
      createdAt: at(0, 'invitation'),
      acceptedAt: undefined,
      expiresAt: at(7 * DAY, 'invitation'),
      messageConfirmed: true,
      messageConfirmedAt: at(0, 'invitation'),
    });
    expect(invitationFields(base([inviter()]))).toMatchObject({
      messageConfirmed: false,
      messageConfirmedAt: undefined,
    });
  });
});

describe('clocks and authorship', () => {
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
});

describe('scenarios', () => {
  const names = { a: 'Ada Lovelace', b: 'Bob Ross' };

  it.each(Object.values(TargetStage))('%s yields invitation fields and a session status', stage => {
    for (const withB of [true, false]) {
      const s = scenarioFor(stage, { a: names.a, b: withB ? names.b : undefined });
      expect(s.name).toBe(stage);
      expect(s.participants.length).toBe(withB ? 2 : 1);
      expect(() => invitationFields(s)).not.toThrow();
      expect(['CREATED', 'INVITED', 'ACTIVE']).toContain(sessionStatus(s));
    }
  });

  it('every attempt has an empathy_submitted milestone and every choice set has choices_shared', () => {
    for (const stage of Object.values(TargetStage)) {
      const s = scenarioFor(stage, names);
      for (const p of s.participants) {
        if (p.empathy) expect(p.milestones.empathy_submitted).toBeDefined();
        if (p.choices?.length) expect(p.milestones.choices_shared).toBeDefined();
        if (p.milestones.choices_shared && !p.choices?.length) expect(p.ranking).toBeDefined();
        if (p.needs?.length) expect(p.milestones.needs_confirmed).toBeDefined();
      }
    }
  });

  it('FEEL_HEARD_B: both signed and felt heard; only Ada has submitted empathy', () => {
    const s = scenarioFor(TargetStage.FEEL_HEARD_B, names);
    const [a, b] = s.participants;
    expect(Object.keys(a.milestones).sort()).toEqual(
      ['compact_signed', 'empathy_submitted', 'feel_heard', 'invitation_sent'].sort(),
    );
    expect(Object.keys(b.milestones).sort()).toEqual(['compact_signed', 'feel_heard'].sort());
    expect(sessionStatus(s)).toBe('ACTIVE');
  });
});
