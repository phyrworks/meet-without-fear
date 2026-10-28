import {
  buildTendingConversationPrompt,
  isExplicitAskForInput,
  needsBrainstormPersona,
  proposalRefinementPersona,
  noOverlapPersona,
  coverageReviewOpenNeedsClause,
  stage4HandoffBridgeMessage,
  TENDING_MORE_SUPPORT_PERSONA,
  TENDING_NEEDS_REVIEW_PERSONA,
  TENDING_WHAT_COMES_NEXT_PERSONA,
  TENDING_WHAT_WORKED_PERSONA,
} from '../stage4-prompts';

describe('isExplicitAskForInput', () => {
  it.each([
    'what should I do?',
    'What should I do here, honestly',
    'help me think about this please',
    'Can you weigh in?',
    'weigh in on this',
    'any advice?',
    'any ideas for next steps',
    'any suggestions?',
    'what would you suggest?',
    'what would you recommend',
    'what would you do',
    'give me your take',
    'give me advice',
  ])('matches explicit ask: %s', text => {
    expect(isExplicitAskForInput(text)).toBe(true);
  });

  it.each([
    '',
    'I was thinking about it on the drive home.',
    'It worked, actually.',
    'I stopped doing it last week.',
    "I don't know what to feel.",
    'what a day',
  ])('does not match passive/reflective text: %s', text => {
    expect(isExplicitAskForInput(text)).toBe(false);
  });
});

describe('persona templates ground in user phrasing', () => {
  it('needsBrainstormPersona quotes the exact need label verbatim', () => {
    const persona = needsBrainstormPersona('feeling like myself inside this marriage');
    expect(persona).toContain('"feeling like myself inside this marriage"');
    expect(persona).toMatch(/do not lead with your own draft/i);
  });

  it('needsBrainstormPersona falls back gracefully when label is missing', () => {
    const persona = needsBrainstormPersona(null);
    expect(persona).toContain('the named need');
  });

  it('proposalRefinementPersona quotes the proposal description and probes blockers', () => {
    const persona = proposalRefinementPersona('walk together each evening');
    expect(persona).toContain('"walk together each evening"');
    expect(persona).toMatch(/what's making (them|the user) hesitate/i);
  });

  it('noOverlapPersona instructs near-miss and combination scanning, not pushing closure', () => {
    const persona = noOverlapPersona();
    expect(persona).toMatch(/near-miss/i);
    expect(persona).toMatch(/combinable/i);
    expect(persona).toMatch(/not to push for closure/i);
  });
});

describe('coverageReviewOpenNeedsClause', () => {
  it('returns empty when there are no open needs', () => {
    expect(coverageReviewOpenNeedsClause([])).toBe('');
  });

  it('lists each open need by exact phrasing and instructs surfacing one at a time', () => {
    const clause = coverageReviewOpenNeedsClause([
      { needLabel: 'feeling like myself inside this marriage' },
      { needLabel: 'not being alone on the inside' },
    ]);
    expect(clause).toContain('"feeling like myself inside this marriage"');
    expect(clause).toContain('"not being alone on the inside"');
    expect(clause).toMatch(/one at a time/i);
    expect(clause).toMatch(/that's a valid place to land/i);
  });
});

describe('stage4HandoffBridgeMessage', () => {
  it('interpolates partner name and frames the wait + individual carry-forward', () => {
    const msg = stage4HandoffBridgeMessage('Eve');
    expect(msg).toContain('Eve');
    expect(msg).toMatch(/shared experiment/i);
    expect(msg).toMatch(/your own/i);
  });

  it('falls back to a generic partner phrase when name is missing', () => {
    expect(stage4HandoffBridgeMessage(null)).toContain('your partner');
    expect(stage4HandoffBridgeMessage('')).toContain('your partner');
  });
});

describe('Tending conversation prompt support', () => {
  it('what-worked posture asks what actually happened before treating anything as working', () => {
    expect(TENDING_WHAT_WORKED_PERSONA).toContain('what actually happened');
    expect(TENDING_WHAT_WORKED_PERSONA).toContain('Did it happen, partly happen, or not happen');
    expect(TENDING_WHAT_WORKED_PERSONA).toContain('never treated as resolution');
  });

  it('more-support posture treats failed follow-through as information and includes blocker categories', () => {
    expect(TENDING_MORE_SUPPORT_PERSONA).toContain('information, not failure');
    expect(TENDING_MORE_SUPPORT_PERSONA).toContain('forgot');
    expect(TENDING_MORE_SUPPORT_PERSONA).toContain('partner did not do part');
    expect(TENDING_MORE_SUPPORT_PERSONA).toContain('I did not do part');
    expect(TENDING_MORE_SUPPORT_PERSONA).toContain('circumstances changed');
  });

  it('needs-review posture checks underlying need resolution separately from commitment follow-through', () => {
    expect(TENDING_NEEDS_REVIEW_PERSONA).toContain('resolved, improving, still open, changed, or not sure');
    expect(TENDING_NEEDS_REVIEW_PERSONA).toContain('A commitment can happen and the need can still be open');
    expect(TENDING_NEEDS_REVIEW_PERSONA).toContain('not a failure');
  });

  it('what-comes-next routes failed follow-through toward adjustment or strategy reopening, not generic extension', () => {
    expect(TENDING_WHAT_COMES_NEXT_PERSONA).toContain('adjust the commitment');
    expect(TENDING_WHAT_COMES_NEXT_PERSONA).toContain('reopen strategy work');
    expect(TENDING_WHAT_COMES_NEXT_PERSONA).toContain('rather than generic extension');
    expect(TENDING_WHAT_COMES_NEXT_PERSONA).toContain('Private reminders do not notify the partner');
  });

  it('builds a phase-specific Tending prompt with private partner boundary and inspectable list context', () => {
    const prompt = buildTendingConversationPrompt('needsReview', {
      userName: 'Adam',
      partnerName: 'Eve',
      entries: [
        { id: 'entry-1', summary: 'Weekly walk', scope: 'SHARED', successCriteria: 'Both feel less alone.' },
        { id: 'entry-2', summary: 'Saturday mornings', scope: 'INDIVIDUAL' },
      ],
      needs: [{ id: 'need-1', label: 'not being alone on the inside' }],
      selectedBetweenPeriodNotes: [
        {
          id: 'note-1',
          content: 'I got tense before the second walk.',
          consentToShareWithPartner: false,
        },
      ],
      latestStructuredOutcomes: 'entry-1 happened and helped partly',
    });

    expect(prompt).toContain('speaking privately with Adam');
    expect(prompt).toContain('Eve is not in this conversation');
    expect(prompt).toContain('Nothing crosses to Eve unless Adam explicitly chooses');
    expect(prompt).toContain('Weekly walk');
    expect(prompt).toContain('Both feel less alone');
    expect(prompt).toContain('Saturday mornings');
    expect(prompt).toContain('not being alone on the inside');
    expect(prompt).toContain('I got tense before the second walk');
    expect(prompt).toContain('private; do not relay');
    expect(prompt).toContain('entry-1 happened and helped partly');
    expect(prompt).toContain('Ask one thing at a time');
  });
});
