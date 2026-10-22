/**
 * Golden R3 — what both orders of `reveal-all-ready` assert about the reveal,
 * read from the steps' raw row changes (whole-database scope).
 *
 *  - exactly once: each attempt moves into REVEALED in exactly one step, and
 *    its `revealedAt` is written in exactly one step;
 *  - routed: the reveal notice ("…is ready for you to review") reaches each
 *    subject exactly once, and only the subject;
 *  - the order held: after the first step, the first-ready direction is READY
 *    while the other is not;
 *  - P0-2 on today's shape: no EMPATHY_STATEMENT lands in a subject's chat —
 *    the delivered copy is the target's named addition (allow-list), so this
 *    asserts the gap rather than hiding it.
 */

import type { Harness, StepResult } from './driver';
import type { RowChange } from './snapshot';

type Row = Record<string, unknown>;

function changesOf(steps: StepResult[], table: string): Array<RowChange & { step: string }> {
  return steps.flatMap(s => s.changes.filter(c => c.table === table).map(c => ({ ...c, step: s.label })));
}

export function revealChecks(opts: {
  harness: () => Harness;
  steps: () => StepResult[];
  /** Label of the step after which exactly one direction is READY. */
  firstReadyStep: string;
  /** Whose attempt (author) is READY first. */
  firstReady: 'ada' | 'bob';
  /** Attempt statuses right after `firstReadyStep`, by author. */
  attemptsAfterFirst: () => Row[];
}): void {
  const idOf = (who: 'ada' | 'bob'): string => {
    const { userA, userB } = opts.harness().actors;
    return who === 'ada' ? userA.id : userB!.id;
  };

  it('the first direction reaches READY while the other is not yet READY (this order)', () => {
    const rows = opts.attemptsAfterFirst();
    const statusOf = (who: 'ada' | 'bob') => rows.find(r => r.sourceUserId === idOf(who))?.status;
    const other = opts.firstReady === 'ada' ? 'bob' : 'ada';
    expect(statusOf(opts.firstReady)).toBe('READY');
    expect(statusOf(other)).not.toBe('READY');
    expect(statusOf(other)).not.toBe('REVEALED');
  });

  it('each attempt is revealed in exactly one step, with revealedAt written once', () => {
    const attempts = changesOf(opts.steps(), 'EmpathyAttempt');
    for (const who of ['ada', 'bob'] as const) {
      const mine = attempts.filter(c => (c.after as Row | undefined)?.sourceUserId === idOf(who));
      const reveals = mine.filter(
        c => (c.after as Row).status === 'REVEALED' && (c.before as Row | undefined)?.status !== 'REVEALED',
      );
      expect(reveals.map(c => c.step)).toHaveLength(1);
      // An attempt created and revealed inside one step diffs as `added`.
      const revealedAtWrites = mine.filter(c =>
        c.kind === 'added' ? (c.after as Row).revealedAt != null : c.changedFields?.includes('revealedAt'),
      );
      expect(revealedAtWrites).toHaveLength(1);
    }
  });

  it('the reveal notice reaches each subject exactly once', () => {
    const notices = changesOf(opts.steps(), 'Message')
      .filter(c => c.kind === 'added')
      .map(c => c.after as Row)
      .filter(m => m.role === 'AI' && String(m.content).includes('is ready for you to review'));
    expect(notices.map(m => m.forUserId).sort()).toEqual([idOf('ada'), idOf('bob')].sort());
  });

  it("today's shape writes no EMPATHY_STATEMENT into a subject's chat (P0-2; the target's addition)", () => {
    const delivered = changesOf(opts.steps(), 'Message')
      .filter(c => c.kind === 'added')
      .map(c => c.after as Row)
      .filter(m => m.role === 'EMPATHY_STATEMENT' && m.forUserId !== m.senderId);
    expect(delivered).toEqual([]);
  });
}
