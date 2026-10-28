/**
 * Allow-list and known leaks for `unrevealed-attempt-hidden` (golden R2).
 *
 * Plan §4 R2: an attempt in HELD/AWAITING_SHARING/REFINING/READY is absent
 * from the subject's reads; `v_empathy_direction_status` shows the status with
 * no content; present after REVEALED and still present after the author's next
 * round supersedes it. Spec §7: "a co-participant sees an attempt only once
 * REVEALED/VALIDATED"; "what the partner saw stays readable to them".
 *
 * Ada's resubmit (step RESUBMIT) IS a round on the target (spec §1.2,
 * `app.empathy_set_status` "on resubmit flips round n to SUPERSEDED and
 * inserts n+1"). Today it rewrites the one attempt row in place
 * (revisionCount → the view's round 2). Concept labels are taken from a row's
 * first appearance, so today's row is `<empathyAttempt:ada→bob@main#1>`
 * throughout, as the target's round-1 row will be. The target re-record may
 * therefore change, beyond the DTO rules every read carries:
 *
 *  RESUBMIT  round 1's change becomes "→ SUPERSEDED, content unchanged" and a
 *            round-2 row (the revised text, superseding #1) is added; the
 *            EMPATHY_STATEMENT the resubmit writes into Ada's chat names #2.
 *  REVEAL    the reveal flips round 2, not round 1; the delivered copies are
 *            round 2's (Ada→Bob) and round 1's (Bob→Ada), pinned to this step.
 *  reads     reveal payloads gain `round`/`attemptId`; the four post-reveal
 *            bodies that name Ada's attempt name round 2 (and its counter).
 *
 * Every row is pinned by key, lineage and content: a copy of the wrong round, a
 * second copy, or round 2 revealed before its time is still a violation.
 */

import type { KnownLeak } from '../privacy';
import { BOB_HELD_EMPATHY_STATEMENT } from '../../fixture-scenarios/scenarios';
import {
  declineConsent,
  notifiedOnce,
  roundTwoInstants,
  subjectDeclineRecord,
  authorAnalysisClosed,
  byteLabelShift,
  deliveredCopyInRead,
  deliveredStatementCopy,
  empathySubmittedMilestone,
  READ_DTO_RULES,
  targetByteRules,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_USER_NAME_RULE,
} from './common';
import type { AllowList, AllowRule } from './types';

/** Step layout (the scenario asserts the labels): 30 reads, accept 30, 15 reads, resubmit 46, 15 reads, reveal 62. */
export const R2_RESUBMIT_STEP = 46;
export const R2_REVEAL_STEP = 62;
/** Post-reveal reads whose bodies name Ada's attempt (pending actions, empathy status ×2, partner empathy). */
const ATTEMPT_ID_PATHS = [
  'steps.66.body.data.actions.0.id',
  'steps.67.body.data.partnerAttempt.id',
  'steps.67.body.data.partnerAttempt.revisionCount',
  'steps.68.body.data.attempt.id',
  'steps.68.body.data.attempt.revisionCount',
  'steps.82.body.data.myAttempt.id',
  'steps.82.body.data.myAttempt.revisionCount',
];

export const ADA_ORIGINAL =
  'I understand you might be feeling stressed from work. I want us to support each other better.';
export const ADA_REVISED = 'I see now that you are running on empty and need someone to notice how hard you try.';

const R1 = '<empathyAttempt:ada→bob@main#1>';
const R2 = '<empathyAttempt:ada→bob@main#2>';

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
    // --- RESUBMIT: round 1 superseded, round 2 inserted --------------------
    // `replacedEntry`: the run entry must equal the recorded one with ONLY
    // these overrides — so round 1 keeps `revealed_at: null`,
    // `delivered_at: null`, `delivery_status: 'PENDING'`, its id, author,
    // subject and `submitted_at`, and its `before` side, as recorded.
    {
      kind: 'replacedEntry',
      at: `steps.${R2_RESUBMIT_STEP}.changes`,
      where: { view: 'empathy_attempt', key: R1, 'after.round': 2 },
      with: {
        changedFields: ['status', 'status_version'],
        'after.round': 1,
        'after.content': ADA_ORIGINAL,
        'after.status': 'SUPERSEDED',
        // One transition (REFINING → SUPERSEDED) from the recorded version 1.
        'after.status_version': 2,
      },
      mustMatch: true,
      why: 'spec §1.2/§4: on resubmit round 1 goes to SUPERSEDED and stays immutable (today the row is rewritten).',
    },
    {
      // `exact`: every column of the view, none unnamed.
      kind: 'addedEntries',
      exact: true,
      at: `steps.${R2_RESUBMIT_STEP}.changes`,
      where: {
        view: 'empathy_attempt',
        kind: 'added',
        key: R2,
        'after.id': R2,
        'after.author_participant_id': '<participant:ada@main>',
        'after.subject_participant_id': '<participant:bob@main>',
        'after.round': 2,
        'after.supersedes_attempt_id': R1,
        'after.content': ADA_REVISED,
        // The step settles after the reconciler has run: inserted HELD, it is
        // READY when the step's state is taken — as today's row is.
        'after.status': 'READY',
        // HELD at insert (0) → READY (1).
        'after.status_version': 1,
        'after.submitted_at': '<ts:fresh>',
        'after.revealed_at': null,
        'after.delivery_status': 'PENDING',
        'after.delivered_at': null,
        'after.seen_at': null,
      },
      mustMatch: true,
      why: 'spec §1.2: the resubmit inserts round n+1 superseding round n — unrevealed, undelivered.',
    },
    {
      kind: 'replacedEntry',
      at: `steps.${R2_RESUBMIT_STEP}.changes`,
      where: { view: 'message', key: '<message:ada@main/EMPATHY_STATEMENT:ada#2>', 'after.source_attempt_id': R1 },
      with: { 'after.source_attempt_id': R2 },
      mustMatch: true,
      why: 'plan §3 step 9 lineage: the resubmitted statement in the author’s chat names the round it states.',
    },
    // --- REVEAL: round 2 revealed; copies pinned to this step ---------------
    // Recorded: round "2" (today's rewritten row, label #1) READY → REVEALED.
    // Target: the round-2 row #2 — same transition, its own identity.
    {
      kind: 'replacedEntry',
      at: `steps.${R2_REVEAL_STEP}.changes`,
      where: { view: 'empathy_attempt', key: R1, 'after.status': 'REVEALED' },
      with: {
        key: R2,
        'before.id': R2,
        'after.id': R2,
        'before.supersedes_attempt_id': R1,
        'after.supersedes_attempt_id': R1,
        'before.submitted_at': '<ts:fresh>',
        'after.submitted_at': '<ts:fresh>',
        'before.status_version': 1,
        'after.status_version': 2,
      },
      mustMatch: true,
      why: 'spec §4: the reveal flips the live round (2); round 1 stays SUPERSEDED and unrevealed.',
    },
    deliveredStatementCopy('ada', 'bob', R2_REVEAL_STEP, 2),
    deliveredStatementCopy('bob', 'ada', R2_REVEAL_STEP, 1),
    {
      kind: 'mayDiffer',
      at: ATTEMPT_ID_PATHS,
      mustMatch: true,
      why:
        'the post-reveal reads return round 2’s row (its id and counter); the scenario’s “each subject reads the ' +
        'statement about them” probe pins its content to the revised text.',
    },
  ],
  targetOnly: [
    {
      assertion:
        "After the reveal, Ada resubmits again (round 3 supersedes the revealed round 2). Bob's reads still contain " +
        'round 2’s statement (his delivered EMPATHY_STATEMENT copy and the revealed row), and never round 3 until it is ' +
        'revealed.',
      why:
        'Plan §4 R2 "still present after the author\'s next round supersedes it"; spec §7 subject arm on revealed_at. ' +
        'Today no endpoint resubmits a revealed attempt (resubmit is for REFINING), so this arm cannot be driven on the ' +
        'current shape. The pre-reveal resubmit IS a round on the target and is declared above.',
    },
  ],
};

/** Observed against the current code; see `privacy.ts` for the contract. */
export const UNREVEALED_ATTEMPT_HIDDEN_KNOWN_LEAKS: KnownLeak[] = [];

/** TS-10 rules over bodies, for the concept and the byte-level comparison alike. */
const TARGET_BODY_RULES = (concept: boolean): AllowRule[] => [
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_COMPACT_SIGNED_MASK,
  TARGET_CONSENT_TARGET_ID_RULE,
  // Ada, the author, reads at "awaiting sharing" (15–29): the R6/R7 closures.
  ...authorAnalysisClosed({ empathyStatus: [19], reconcilerStatus: [23], summary: [25], concept }),
  // Bob's own consent history after he accepted the offer (refining 43, ready 59, revealed 75).
  ...[43, 59, 75].map(step => subjectDeclineRecord(step, !concept, 'GRANTED')),
  // After the reveal each subject's own conversation holds the partner's
  // statement: Bob (state 64, messages 65) round 2's, Ada (79, 80) Bob's.
  deliveredCopyInRead(64, 'ada', 'bob', ADA_REVISED, {
    byteLevel: !concept,
    at: 'steps.64.body.data.messages.messages',
  }),
  deliveredCopyInRead(65, 'ada', 'bob', ADA_REVISED, { byteLevel: !concept }),
  deliveredCopyInRead(79, 'bob', 'ada', BOB_HELD_EMPATHY_STATEMENT, {
    byteLevel: !concept,
    at: 'steps.79.body.data.messages.messages',
  }),
  deliveredCopyInRead(80, 'bob', 'ada', BOB_HELD_EMPATHY_STATEMENT, { byteLevel: !concept }),
  // Bob's pending actions: refining (34) stamps the delivery; ready (50), revealed (66) count 0.
  ...notifiedOnce(34, [50, 66], concept),
  roundTwoInstants([
    'steps.51.body.data.myAttempt.sharedAt',
    'steps.51.body.data.partnerEmpathySubmittedAt',
    'steps.67.body.data.myAttempt.sharedAt',
    'steps.67.body.data.partnerAttempt.sharedAt',
    'steps.67.body.data.partnerEmpathySubmittedAt',
    'steps.68.body.data.attempt.sharedAt',
    'steps.82.body.data.myAttempt.sharedAt',
    'steps.82.body.data.partnerAttempt.sharedAt',
    'steps.82.body.data.partnerEmpathySubmittedAt',
    ...(concept
      ? [51, 67, 68, 82]
          .flatMap(s => [`steps.${s}.changes.0.before.created_at`, `steps.${s}.changes.0.after.created_at`])
          .concat(['steps.62.changes.0.before.submitted_at', 'steps.62.changes.0.after.submitted_at'])
      : []),
  ]),
  {
    kind: 'mayDiffer',
    at: ['steps.68.body.data.attempt.statusVersion'],
    mustMatch: true,
    why:
      'ruling R32 + rounds: round 2 is a new row (HELD → READY → REVEALED = 2); today the one rewritten row counted ' +
      'every move of both submissions (4). The scenario asserts the row value.',
  },
];

UNREVEALED_ATTEMPT_HIDDEN_ALLOW.rules.push(
  ...TARGET_BODY_RULES(true),
  TARGET_USER_NAME_RULE,
  empathySubmittedMilestone('ada', 'initial', '<ts:14>'),
  empathySubmittedMilestone('bob', 'initial', '<ts:24>'),
  declineConsent(30, 'GRANTED'),
);

/** The byte-level golden on the TARGET shape (TS-10): body rules + changesMapped (ruling R32). */
export const UNREVEALED_ATTEMPT_HIDDEN_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'unrevealed-attempt-hidden',
  rules: [
    ...READ_DTO_RULES,
    UNREVEALED_ATTEMPT_HIDDEN_ALLOW.rules.find(r => r.kind === 'addedKeys')!,
    ...TARGET_BODY_RULES(false),
    ...targetByteRules({
      addedTables: [
        {
          step: R2_REVEAL_STEP,
          table: 'message',
          kind: 'added',
          count: 2,
          why: 'the two delivered EMPATHY_STATEMENT copies',
        },
        { step: 30, table: 'consent', kind: 'added', count: 1, why: "the subject's GRANTED consent naming the offer" },
        {
          step: 34,
          table: 'context_share_offer',
          kind: 'changed',
          count: 1,
          why: 'pending actions stamps delivery_notified_at (job)',
        },
      ],
    }),
  ],
};
UNREVEALED_ATTEMPT_HIDDEN_BYTE_TARGET_ALLOW.rules.push(
  byteLabelShift(
    [12, 27, 43, 59, 75, 90].map(s => `steps.${s}.body.data.records.0.id`),
    'consent',
  ),
  byteLabelShift(
    [
      'steps.64.body.data.messages.messages.12.id',
      'steps.65.body.data.messages.12.id',
      'steps.79.body.data.messages.messages.18.id',
      'steps.80.body.data.messages.18.id',
    ],
    'message',
  ),
);
