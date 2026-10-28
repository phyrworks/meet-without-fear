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

import { ADA_EMPATHY_STATEMENT, BOB_HELD_EMPATHY_STATEMENT } from '../../fixture-scenarios/scenarios';
import {
  deliveredCopyInRead,
  deliveredStatementCopy,
  empathySubmittedMilestone,
  READ_DTO_RULES,
  statusVersionTwo,
  targetByteRules,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_USER_NAME_RULE,
  byteLabelShift,
  authorAnalysisClosed,
  declineConsent,
  subjectDeclineRecord,
} from './common';
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

/** The ada-first scenario's statement for Bob (its test's BOB_EMPATHY). */
const BOB_DRAFTED = 'I think you feel unseen when the chores pile up and nobody says anything.';

/**
 * TS-10 body rules shared by the concept and the byte-level comparison.
 * `reads`: the post-reveal `state` / `messages` read steps of each subject,
 * and the partner statement each one now holds (the delivered copy).
 */
const bodyRules = (
  reads: Array<{ state: number; messages: number; author: string; subject: string; statement: string }>,
  byteLevel: boolean,
): AllowRule[] => [
  ...READ_DTO_RULES,
  ROUND_RULE,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  ...reads.flatMap(r => [
    deliveredCopyInRead(r.state, r.author, r.subject, r.statement, {
      byteLevel,
      at: `steps.${r.state}.body.data.messages.messages`,
    }),
    deliveredCopyInRead(r.messages, r.author, r.subject, r.statement, { byteLevel }),
  ]),
];

/** ada-first: Ada's revealed reads start at 33, Bob's at 48 (EMPATHY_READS: state +1, messages +2, partner empathy +5). */
const ADA_FIRST_READS = [
  { state: 34, messages: 35, author: 'bob', subject: 'ada', statement: BOB_DRAFTED },
  { state: 49, messages: 50, author: 'ada', subject: 'bob', statement: ADA_EMPATHY_STATEMENT },
];
/** bob-first: Ada's revealed reads start at 32, Bob's at 47. */
const BOB_FIRST_READS = [
  { state: 33, messages: 34, author: 'bob', subject: 'ada', statement: BOB_HELD_EMPATHY_STATEMENT },
  { state: 48, messages: 49, author: 'ada', subject: 'bob', statement: ADA_EMPATHY_STATEMENT },
];

/**
 * bob-first runs on RECONCILER_SHOWN_B: the author (Ada) reads her empathy
 * status (5, 36), reconciler status (9, 40) and summary (11, 42) — the R6/R7
 * closures. Bob, the subject, reads after the reveal (55, 57): his own
 * analysis makes the reconciliation complete for him (readyForStage3), so the
 * summary is generated (MOCK_LLM returns none: 500 instead of the old 400 —
 * the old code required BOTH analyses, one of which is Ada's).
 */
const BOB_FIRST_CLOSURES = (concept: boolean): AllowRule[] => [
  ...authorAnalysisClosed({ empathyStatus: [5, 36], reconcilerStatus: [9, 40], summary: [11, 42], concept }),
  {
    kind: 'mayDiffer',
    at: ['steps.55.body.data.readyForStage3', 'steps.57.status', 'steps.57.body'],
    mustMatch: true,
    why:
      "R24/R6: Bob's reconciler status is computed from what he may see (his own analysis + the direction statuses), " +
      'so after the reveal it is complete for him; the old count needed both analyses. The summary is then built for ' +
      'him (R24) — under MOCK_LLM the model returns nothing (500). The scenario asserts both.',
  },
];

/** Ruling R32 (ada-first): Bob's round, submitted and revealed by the consent step, is at status_version 2, not 3. */
const ADA_FIRST_STATUS_VERSION: AllowRule = {
  kind: 'mayDiffer',
  at: ['steps.38.body.data.attempt.statusVersion'],
  mustMatch: true,
  why: 'ruling R32: no ANALYZING — Bob’s round goes HELD → READY → REVEALED (2). The scenario asserts it equals the row.',
};

const ROUND_RULE: AllowRule = {
  kind: 'addedKeys',
  at: ['steps.*.body.data.myAttempt', 'steps.*.body.data.partnerAttempt', 'steps.*.body.data.attempt'],
  keys: ['round', 'attemptId'],
  mustMatch: true,
  why: 'spec §1.2 empathy_attempt: revisionCount becomes rows with a round; a reveal payload names its round and row.',
};

export const REVEAL_ADA_FIRST_ALLOW: AllowList = {
  scenario: 'reveal-all-ready-ada-first',
  rules: [
    ...rules(REVEAL_ADA_FIRST_STEP),
    ...bodyRules(ADA_FIRST_READS, false).filter(r => !READ_DTO_RULES.includes(r) && r !== ROUND_RULE),
    ADA_FIRST_STATUS_VERSION,
    TARGET_USER_NAME_RULE,
    empathySubmittedMilestone('ada', 'initial', '<ts:14>'),
    empathySubmittedMilestone('bob', REVEAL_ADA_FIRST_STEP, '<ts:fresh>'),
    statusVersionTwo(REVEAL_ADA_FIRST_STEP, 'bob', 'ada', 'added'),
  ],
};
export const REVEAL_BOB_FIRST_ALLOW: AllowList = {
  scenario: 'reveal-all-ready-bob-first',
  rules: [
    ...rules(REVEAL_BOB_FIRST_STEP),
    ...bodyRules(BOB_FIRST_READS, false).filter(r => !READ_DTO_RULES.includes(r) && r !== ROUND_RULE),
    TARGET_USER_NAME_RULE,
    empathySubmittedMilestone('ada', 'initial', '<ts:14>'),
    empathySubmittedMilestone('bob', 'initial', '<ts:24>'),
    ...BOB_FIRST_CLOSURES(true),
    declineConsent(REVEAL_BOB_FIRST_STEP),
    subjectDeclineRecord(59, false),
  ],
};

/** The byte-level goldens on the TARGET shape (TS-10): body rules + changesMapped (ruling R32). */
export const REVEAL_ADA_FIRST_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'reveal-all-ready-ada-first',
  rules: [
    ...bodyRules(ADA_FIRST_READS, true),
    ADA_FIRST_STATUS_VERSION,
    byteLabelShift(
      ['steps.13.body.data.records.0.id', 'steps.45.body.data.records.0.id', 'steps.60.body.data.records.0.id'],
      'consent',
    ),
    byteLabelShift(
      [
        'steps.34.body.data.messages.messages.14.id',
        'steps.35.body.data.messages.14.id',
        'steps.49.body.data.messages.messages.12.id',
        'steps.50.body.data.messages.12.id',
      ],
      'message',
    ),
    ...targetByteRules({
      addedTables: [
        {
          step: REVEAL_ADA_FIRST_STEP,
          table: 'message',
          kind: 'added',
          count: 2,
          why: 'the two delivered EMPATHY_STATEMENT copies',
        },
        {
          step: REVEAL_ADA_FIRST_STEP,
          table: 'participant_milestone',
          kind: 'added',
          count: 1,
          why: "Bob's empathy_submitted",
        },
      ],
    }),
  ],
};
export const REVEAL_BOB_FIRST_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'reveal-all-ready-bob-first',
  rules: [
    ...bodyRules(BOB_FIRST_READS, true),
    ...BOB_FIRST_CLOSURES(false),
    subjectDeclineRecord(59, true),
    byteLabelShift(
      [
        'steps.13.body.data.records.0.id',
        'steps.28.body.data.records.0.id',
        'steps.44.body.data.records.0.id',
        'steps.59.body.data.records.0.id',
      ],
      'consent',
    ),
    byteLabelShift(
      [
        'steps.33.body.data.messages.messages.13.id',
        'steps.34.body.data.messages.13.id',
        'steps.48.body.data.messages.messages.11.id',
        'steps.49.body.data.messages.11.id',
      ],
      'message',
    ),
    ...targetByteRules({
      addedTables: [
        {
          step: REVEAL_BOB_FIRST_STEP,
          table: 'message',
          kind: 'added',
          count: 2,
          why: 'the two delivered EMPATHY_STATEMENT copies',
        },
        {
          step: REVEAL_BOB_FIRST_STEP,
          table: 'consent',
          kind: 'added',
          count: 1,
          why: "the subject's DENIED consent naming the offer",
        },
      ],
    }),
  ],
};
