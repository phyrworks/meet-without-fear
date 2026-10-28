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
 *  - the delivered copy: on today's shape no EMPATHY_STATEMENT lands in a
 *    subject's chat (P0-2 — the target's named addition); on the TARGET shape
 *    (TS-10) exactly one copy of each revealed attempt lands in its subject's
 *    conversation, written by the reveal step, pointing at that attempt.
 */

import type { Harness, StepResult } from './driver';
import { withClient } from './db';
import { isTargetShape } from './shape';
import type { RowChange } from './snapshot';

type Row = Record<string, unknown>;

function changesOf(steps: StepResult[], table: string): Array<RowChange & { step: string }> {
  return steps.flatMap(s => s.changes.filter(c => c.table === table).map(c => ({ ...c, step: s.label })));
}

/** Target: participant id → user id, conversation id → owner's user id (run database). */
async function owners(
  h: Harness,
): Promise<{ ofParticipant: Map<string, string>; ofConversation: Map<string, string> }> {
  return withClient(
    h.fixture.target,
    async c => {
      const p = await c.query<{ id: string; user_id: string }>(`SELECT id, user_id FROM participant`);
      const conv = await c.query<{ id: string; user_id: string }>(
        `SELECT c.id, p.user_id FROM conversation c JOIN participant p ON p.id = c.participant_id`,
      );
      return {
        ofParticipant: new Map(p.rows.map(r => [r.id, r.user_id])),
        ofConversation: new Map(conv.rows.map(r => [r.id, r.user_id])),
      };
    },
    h.fixture.database,
  );
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
  /** Label of the step that reveals (target: the delivered copies are its writes). */
  revealStep?: string;
}): void {
  const T = isTargetShape();
  const ATTEMPTS = T ? 'empathy_attempt' : 'EmpathyAttempt';
  const MESSAGES = T ? 'message' : 'Message';
  const idOf = (who: 'ada' | 'bob'): string => {
    const { userA, userB } = opts.harness().actors;
    return who === 'ada' ? userA.id : userB!.id;
  };
  /** The author's user id of an attempt row (either shape). */
  const authorOf = async (r: Row | undefined): Promise<unknown> => {
    if (!r) return undefined;
    if (!T) return r.sourceUserId;
    return (await owners(opts.harness())).ofParticipant.get(String(r.author_participant_id));
  };

  it('the first direction reaches READY while the other is not yet READY (this order)', async () => {
    const rows = opts.attemptsAfterFirst();
    const authors = await Promise.all(rows.map(authorOf));
    const statusOf = (who: 'ada' | 'bob') => rows.find((_, i) => authors[i] === idOf(who))?.status;
    const other = opts.firstReady === 'ada' ? 'bob' : 'ada';
    expect(statusOf(opts.firstReady)).toBe('READY');
    expect(statusOf(other)).not.toBe('READY');
    expect(statusOf(other)).not.toBe('REVEALED');
  });

  it('each attempt is revealed in exactly one step, with revealedAt written once', async () => {
    const attempts = changesOf(opts.steps(), ATTEMPTS);
    const revealedAt = T ? 'revealed_at' : 'revealedAt';
    const authors = await Promise.all(attempts.map(c => authorOf(c.after as Row | undefined)));
    for (const who of ['ada', 'bob'] as const) {
      const mine = attempts.filter((_, i) => authors[i] === idOf(who));
      const reveals = mine.filter(
        c => (c.after as Row).status === 'REVEALED' && (c.before as Row | undefined)?.status !== 'REVEALED',
      );
      expect(reveals.map(c => c.step)).toHaveLength(1);
      // An attempt created and revealed inside one step diffs as `added`.
      const revealedAtWrites = mine.filter(c =>
        c.kind === 'added' ? (c.after as Row)[revealedAt] != null : c.changedFields?.includes(revealedAt),
      );
      expect(revealedAtWrites).toHaveLength(1);
    }
  });

  it('the reveal notice reaches each subject exactly once', async () => {
    const added = changesOf(opts.steps(), MESSAGES)
      .filter(c => c.kind === 'added')
      .map(c => c.after as Row)
      .filter(m => m.role === 'AI' && String(m.content).includes('is ready for you to review'));
    const conv = T ? (await owners(opts.harness())).ofConversation : null;
    const audience = added.map(m => (T ? conv!.get(String(m.conversation_id)) : m.forUserId));
    expect(audience.sort()).toEqual([idOf('ada'), idOf('bob')].sort());
  });

  if (!T) {
    it("today's shape writes no EMPATHY_STATEMENT into a subject's chat (P0-2; the target's addition)", () => {
      const delivered = changesOf(opts.steps(), 'Message')
        .filter(c => c.kind === 'added')
        .map(c => c.after as Row)
        .filter(m => m.role === 'EMPATHY_STATEMENT' && m.forUserId !== m.senderId);
      expect(delivered).toEqual([]);
    });
  } else {
    it("the reveal writes exactly one copy of each attempt into its subject's conversation (TS-10)", async () => {
      const o = await owners(opts.harness());
      const copies = changesOf(opts.steps(), 'message')
        .filter(c => c.kind === 'added')
        .map(c => ({ step: c.step, m: c.after as Row }))
        .filter(({ m }) => m.kind === 'EMPATHY_STATEMENT')
        .map(({ step, m }) => ({
          step,
          owner: o.ofConversation.get(String(m.conversation_id)),
          sender: o.ofParticipant.get(String(m.sender_participant_id)),
          source: m.source_attempt_id,
        }))
        .filter(c => c.owner !== c.sender); // the author's own copy is their own row, not a delivery
      expect(copies.map(c => c.step)).toEqual(copies.map(() => opts.revealStep));
      expect(copies.map(c => [c.owner, c.sender]).sort()).toEqual(
        [
          [idOf('bob'), idOf('ada')],
          [idOf('ada'), idOf('bob')],
        ].sort(),
      );
      const revealed = await withClient(
        opts.harness().fixture.target,
        async c =>
          (await c.query<{ id: string }>(`SELECT id FROM empathy_attempt WHERE revealed_at IS NOT NULL`)).rows.map(
            r => r.id,
          ),
        opts.harness().fixture.database,
      );
      expect(copies.map(c => c.source).sort()).toEqual([...revealed].sort());
    });
  }
}
