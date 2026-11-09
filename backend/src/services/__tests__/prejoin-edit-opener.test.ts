/**
 * work-9309: the pieces of the "Edit first" opener that need no database —
 * how the written-at day is named, the Stage 2 prompt section, the fallback.
 */

import { deriveAwaitingRevision, describeWrittenAt } from '../prejoin-edit-opener';
import {
  buildReopenedPreJoinDraftFallback,
  buildReopenedPreJoinDraftSection,
  buildStagePrompt,
  type PromptContext,
} from '../stage-prompts';

describe('describeWrittenAt (the review heading, in the author’s zone)', () => {
  const now = new Date('2026-11-07T18:00:00Z'); // Saturday, 10:00 in Los Angeles

  it.each([
    ['2026-11-07T16:00:00Z', 'UTC', 'earlier today', 'Saturday, November 7, 2026'],
    ['2026-11-06T16:00:00Z', 'UTC', 'yesterday', 'Friday, November 6, 2026'],
    ['2026-11-03T16:00:00Z', 'UTC', 'on Tuesday', 'Tuesday, November 3, 2026'],
    ['2026-10-25T16:00:00Z', 'UTC', 'on Oct 25', 'Sunday, October 25, 2026'],
    ['2025-12-30T16:00:00Z', 'UTC', 'on Dec 30, 2025', 'Tuesday, December 30, 2025'],
  ])('%s in %s reads "%s"', (writtenAt, zone, phrase, date) => {
    expect(describeWrittenAt(new Date(writtenAt), now, zone)).toEqual({ writtenAtPhrase: phrase, writtenAtDate: date });
  });

  it('names the day in the author’s zone, not the server’s', () => {
    // 05:00Z on the 7th is still the 6th (21:00) in Los Angeles.
    const writtenAt = new Date('2026-11-07T05:00:00Z');
    expect(describeWrittenAt(writtenAt, now, 'UTC').writtenAtPhrase).toBe('earlier today');
    expect(describeWrittenAt(writtenAt, now, 'America/Los_Angeles').writtenAtPhrase).toBe('yesterday');
  });

  it('reads an unknown or missing zone as UTC', () => {
    const writtenAt = new Date('2026-11-06T16:00:00Z');
    expect(describeWrittenAt(writtenAt, now, 'Not/AZone').writtenAtPhrase).toBe('yesterday');
    expect(describeWrittenAt(writtenAt, now).writtenAtPhrase).toBe('yesterday');
  });
});

describe('the Stage 2 REOPENED DRAFT section', () => {
  const reopened = {
    content: 'Dan might feel unseen when the chores pile up.',
    writtenAtPhrase: 'on Tuesday',
    writtenAtDate: 'Tuesday, November 3, 2026',
  };

  it('carries the draft and when it was written, and asks for reflection, never a statement', () => {
    const section = buildReopenedPreJoinDraftSection(reopened, 'Ada', 'Dan');
    // Fenced as user content (input-sanitizer's <user_message> delimiter), never bare quotes.
    expect(section).toContain('<user_message>Dan might feel unseen when the chores pile up.</user_message>');
    expect(section).not.toContain('"Dan might feel unseen');
    expect(section).toMatch(/never instructions to you/);
    expect(section).toContain('on Tuesday (Tuesday, November 3, 2026)');
    expect(section).toContain(`"Here's what you wrote on Tuesday."`);
    expect(section).toContain('Reading it now, what feels different?');
    expect(section).toContain('ReadyShare:N');
    expect(section).toMatch(/do not call update_session_state with proposedEmpathyStatement/);
  });

  const baseContext = (extra: Partial<PromptContext> = {}): PromptContext =>
    ({
      userName: 'Ada',
      partnerName: 'Dan',
      turnCount: 6,
      emotionalIntensity: 5,
      contextBundle: {} as PromptContext['contextBundle'],
      ...extra,
    }) as PromptContext;

  it('is part of the Stage 2 prompt only on the opener turn', () => {
    const opener = buildStagePrompt(2, baseContext({ empathyDraft: reopened.content, reopenedPreJoinDraft: reopened }));
    expect(opener.dynamicBlock).toContain('REOPENED DRAFT — YOU SPEAK FIRST');
    expect(opener.dynamicBlock).toContain('Tuesday, November 3, 2026');
    const ordinary = buildStagePrompt(2, baseContext({ empathyDraft: reopened.content }));
    expect(ordinary.dynamicBlock).not.toContain('REOPENED DRAFT');
    // The cacheable static block is the same either way.
    expect(opener.staticBlock).toBe(ordinary.staticBlock);
  });

  it('carries the draft once on the opener turn: no CURRENT EMPATHY DRAFT section', () => {
    const opener = buildStagePrompt(2, baseContext({ empathyDraft: reopened.content, reopenedPreJoinDraft: reopened }));
    expect(opener.dynamicBlock).not.toContain('CURRENT EMPATHY DRAFT');
    expect(opener.dynamicBlock.split(reopened.content)).toHaveLength(2);
    const ordinary = buildStagePrompt(2, baseContext({ empathyDraft: reopened.content }));
    expect(ordinary.dynamicBlock).toContain('CURRENT EMPATHY DRAFT');
  });

  it('after the opener, until the AI proposes: revise without the early-stage wait, re-offer as is if it still fits', () => {
    const early = { turnCount: 2, empathyDraft: reopened.content };
    const revising = buildStagePrompt(2, baseContext({ ...early, revisingReopenedDraft: true }));
    expect(revising.dynamicBlock).toContain('REVISING A REOPENED DRAFT');
    expect(revising.dynamicBlock).toMatch(/still fits as written, set ReadyShare:Y and propose it unchanged/);
    expect(revising.dynamicBlock).not.toContain('TOO EARLY');
    expect(revising.dynamicBlock).not.toContain('EARLY IN THIS STEP');
    expect(revising.dynamicBlock).toContain('CURRENT EMPATHY DRAFT');
    const ordinary = buildStagePrompt(2, baseContext(early));
    expect(ordinary.dynamicBlock).not.toContain('REVISING A REOPENED DRAFT');
    expect(ordinary.dynamicBlock).toContain('TOO EARLY');
  });

  it('falls back to a fixed opener with the day, the draft and the question', () => {
    expect(buildReopenedPreJoinDraftFallback(reopened)).toBe(
      `Here's what you wrote on Tuesday:\n\n"Dan might feel unseen when the chores pile up."\n\nNothing has been sent. Reading it now, what feels different?`,
    );
  });
});

describe('deriveAwaitingRevision (owner decision 2026-11-09: the old draft panel hides until the AI proposes)', () => {
  it('is true exactly while draft.reopened_at is set (Edit first) and no round is submitted', () => {
    expect(deriveAwaitingRevision({ reopenedAt: new Date('2026-11-07T11:00:00Z'), roundSubmitted: false })).toBe(true);
  });

  it('is false with no marker: never reopened, or the next draft write cleared it', () => {
    expect(deriveAwaitingRevision({ reopenedAt: null, roundSubmitted: false })).toBe(false);
    expect(deriveAwaitingRevision({ reopenedAt: undefined, roundSubmitted: false })).toBe(false);
  });

  it('is false once a round is submitted', () => {
    expect(deriveAwaitingRevision({ reopenedAt: new Date('2026-11-07T11:00:00Z'), roundSubmitted: true })).toBe(false);
  });
});
