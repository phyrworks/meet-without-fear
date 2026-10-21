/**
 * Allow-list and known leaks for `unrevealed-attempt-hidden` (golden R2).
 *
 * Plan §4 R2: an attempt in HELD/AWAITING_SHARING/REFINING/READY is absent
 * from the subject's reads; `v_empathy_direction_status` shows the status with
 * no content; present after REVEALED and still present after the author's next
 * round supersedes it. Spec §7: "a co-participant sees an attempt only once
 * REVEALED/VALIDATED"; "what the partner saw stays readable to them".
 *
 * The target re-record may change, beyond the DTO rules every read carries:
 *  - the reveal payloads gain `round` and `attemptId` (as `empathy-reveal`);
 *  - the reveal step gains the two delivered EMPATHY_STATEMENT copies, one in
 *    each subject's conversation, pinned completely.
 */

import type { KnownLeak } from '../privacy';
import { deliveredStatementCopy, READ_DTO_RULES } from './common';
import type { AllowList } from './types';

export const UNREVEALED_ATTEMPT_HIDDEN_ALLOW: AllowList = {
  scenario: 'unrevealed-attempt-hidden',
  rules: [
    ...READ_DTO_RULES,
    {
      kind: 'addedKeys',
      at: ['steps.*.body.data.myAttempt', 'steps.*.body.data.partnerAttempt', 'steps.*.body.data.attempt'],
      keys: ['round', 'attemptId'],
      mustMatch: true,
      why: 'spec §1.2 empathy_attempt: revisionCount becomes rows with a round; a reveal payload names its round and row.',
    },
    deliveredStatementCopy('ada', 'bob', 'steps'),
    deliveredStatementCopy('bob', 'ada', 'steps'),
  ],
  targetOnly: [
    {
      assertion:
        "After the reveal, Ada resubmits (round 2 supersedes round 1). Bob's reads still contain round 1's statement " +
        '(his delivered EMPATHY_STATEMENT copy and the revealed row), and never round 2 until it is revealed.',
      why:
        'Plan §4 R2 "still present after the author\'s next round supersedes it"; spec §7 subject arm on revealed_at. ' +
        'The current shape has no rounds: an attempt is one mutable row (revisionCount) and resubmission after a ' +
        'reveal does not exist, so this arm cannot be driven before the rebuild.',
    },
  ],
};

/** Observed against the current code; see `privacy.ts` for the contract. */
export const UNREVEALED_ATTEMPT_HIDDEN_KNOWN_LEAKS: KnownLeak[] = [];
