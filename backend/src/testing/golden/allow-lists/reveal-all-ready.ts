/**
 * Allow-lists for `reveal-all-ready-ada-first` and `reveal-all-ready-bob-first`
 * (golden R3, the two orders).
 *
 * Plan §4 R3: two attempts reach READY in either order; the reveal occurs
 * exactly once; both subjects' conversations gain an `EMPATHY_STATEMENT` row.
 * Spec §4 `app.empathy_set_status`: on → REVEALED it writes the statement into
 * the SUBJECT's conversation; §7 the reveal fires only when the gate holds (all
 * N directions READY — P1 parked, N = 2 here).
 *
 * On the current shape the delivered copy does not exist (P0-2): the reveal
 * writes one AI notice per partner and flips both attempts, and the statement
 * stays only in its author's chat. The copies are therefore the target's named
 * additions on the reveal step, pinned completely; nothing else may change
 * beyond the DTO rules and the reveal payloads' `round`/`attemptId`.
 */

import { deliveredStatementCopy, READ_DTO_RULES } from './common';
import type { AllowList, AllowRule } from './types';

const rules = (revealStep: number): AllowRule[] => [
  ...READ_DTO_RULES,
  {
    kind: 'addedKeys',
    at: ['steps.*.body.data.myAttempt', 'steps.*.body.data.partnerAttempt', 'steps.*.body.data.attempt'],
    keys: ['round', 'attemptId'],
    mustMatch: true,
    why: 'spec §1.2 empathy_attempt: revisionCount becomes rows with a round; a reveal payload names its round and row.',
  },
  // Pinned to the reveal step: a copy written by any other step is a second
  // reveal, which R3's "exactly once" forbids.
  deliveredStatementCopy('ada', 'bob', revealStep),
  deliveredStatementCopy('bob', 'ada', revealStep),
];

/** ada-first: [hook, 30 reads, draft, consent ← reveal, …]. The scenario asserts the label at this index. */
export const REVEAL_ADA_FIRST_STEP = 32;
/** bob-first: [hook, 30 reads, decline ← reveal, …]. */
export const REVEAL_BOB_FIRST_STEP = 31;

export const REVEAL_ADA_FIRST_ALLOW: AllowList = {
  scenario: 'reveal-all-ready-ada-first',
  rules: rules(REVEAL_ADA_FIRST_STEP),
};
export const REVEAL_BOB_FIRST_ALLOW: AllowList = {
  scenario: 'reveal-all-ready-bob-first',
  rules: rules(REVEAL_BOB_FIRST_STEP),
};
