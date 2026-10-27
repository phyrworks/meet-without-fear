/**
 * Allow-list for `empathy-reveal`'s normalised baseline
 * (`__golden__/empathy-reveal.concept.json`).
 *
 * Plan §4, "Golden harness" row: old body ⊆ new body — every baseline value
 * present and equal — with `round` and `attemptId` as the exact list of keys
 * the target may add, and only on reveal payloads (the attempt objects the
 * empathy-status and partner-empathy reads return). Concept-view row diffs are
 * identical modulo the rows the target migration adds: the delivered
 * EMPATHY_STATEMENT copy in the subject's conversation (plan §3 step 9, §4
 * "Content-hash" row).
 *
 * On the current shape nothing is added, so the rules are satisfied trivially.
 */

import { ADA_EMPATHY_STATEMENT } from '../../fixture-scenarios/scenarios';
import {
  deliveredCopyInRead,
  empathySubmittedMilestone,
  statusVersionTwo,
  targetByteRules,
  TARGET_MESSAGE_STAGE_RULE,
  TARGET_USER_NAME_RULE,
} from './common';
import type { AllowList, AllowRule } from './types';

/** Bob's statement in this scenario (the test's BOB_EMPATHY). */
const BOB_EMPATHY = 'I think you feel unseen when the chores pile up and nobody says anything.';

export const EMPATHY_REVEAL_ALLOW: AllowList = {
  scenario: 'empathy-reveal',
  rules: [
    {
      kind: 'addedKeys',
      at: ['steps.*.body.data.myAttempt', 'steps.*.body.data.partnerAttempt', 'steps.*.body.data.attempt'],
      keys: ['round', 'attemptId'],
      mustMatch: true,
      why:
        'spec §1.2 empathy_attempt: revisionCount becomes rows with a round, so a reveal payload names the round ' +
        'and the attempt row it came from.',
    },
    // The two delivered copies, one per revealed attempt, each pinned by its
    // structural key AND its audience, lineage and sender. A predicate on
    // `kind` alone (the first version) admitted a statement copied into its
    // author's own conversation, duplicated, with the wrong lineage — the
    // R2/R3 leak class. Each rule admits exactly one row. No `initial` rule:
    // FEEL_HEARD_B holds no revealed attempt, so the target adds nothing there.
    ...(
      [
        ['ada', 'bob'],
        ['bob', 'ada'],
      ] as const
    ).map(([author, subject]) => ({
      kind: 'addedEntries' as const,
      at: 'steps.*.changes',
      where: {
        view: 'message',
        kind: 'added',
        key: `<message:${subject}@main/EMPATHY_STATEMENT:${author}#1>`,
        'after.kind': 'EMPATHY_STATEMENT',
        'after.role': 'USER',
        'after.conversation_id': `<conversation:${subject}@main/MAIN>`,
        'after.sender_participant_id': `<participant:${author}@main>`,
        'after.source_attempt_id': `<empathyAttempt:${author}→${subject}@main#1>`,
      },
      why:
        `plan §3 step 9: the reveal job writes ${author}'s EMPATHY_STATEMENT into the SUBJECT's (${subject}'s) ` +
        "conversation; today it is written only into the author's own chat (spec §1.1 message.source_attempt_id).",
    })),
    ...BODY_TARGET_RULES(),
    deliveredCopyInRead(4, 'bob', 'ada', BOB_EMPATHY),
    deliveredCopyInRead(7, 'ada', 'bob', ADA_EMPATHY_STATEMENT),
    // --- TS-10: target row representation (concept rows) -------------------------
    TARGET_USER_NAME_RULE,
    empathySubmittedMilestone('ada', 'initial', '<ts:14>'),
    empathySubmittedMilestone('bob', 1, '<ts:fresh>'),
    statusVersionTwo(1, 'ada', 'bob', 'changed'),
    statusVersionTwo(1, 'bob', 'ada', 'added'),
  ],
};

/** TS-10 rules over response bodies — they hold for the byte-level and the concept golden alike. */
function BODY_TARGET_RULES(): AllowRule[] {
  return [
    TARGET_MESSAGE_STAGE_RULE,
    {
      kind: 'mayDiffer',
      at: ['steps.3.body.data.attempt.statusVersion', 'steps.6.body.data.attempt.statusVersion'],
      mustMatch: true,
      why:
        'ruling R32: no ANALYZING on the target — the revealed round is at status_version 2, not 3. The scenario ' +
        'asserts each value equals the row (2).',
    },
  ];
}

/**
 * The byte-level golden (`__golden__/empathy-reveal.json`) on the TARGET shape
 * (TS-10). Recorded on the current shape, never re-recorded: compared under the
 * concept rules plus what is shape-bound in a byte-level step — the trace
 * (`traceMapped`) and the physical row changes (`changesMapped`, ruling R32).
 */
export const EMPATHY_REVEAL_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'empathy-reveal',
  rules: [
    EMPATHY_REVEAL_ALLOW.rules[0], // round / attemptId on reveal payloads
    ...BODY_TARGET_RULES(),
    deliveredCopyInRead(4, 'bob', 'ada', BOB_EMPATHY, { byteLevel: true }),
    deliveredCopyInRead(7, 'ada', 'bob', ADA_EMPATHY_STATEMENT, { byteLevel: true }),
    {
      kind: 'mayDiffer',
      at: ['steps.4.body.data.messages.13.id', 'steps.7.body.data.messages.12.id'],
      mustMatch: true,
      why:
        'byte-level message labels are global created_at ranks: the two delivered copies the reveal writes come before ' +
        'the reveal notices, so each notice ranks two later. The concept golden pins the notices structurally ' +
        '(<message:ada@main#13>, <message:bob@main#12>) and compares them.',
    },
    ...targetByteRules({
      trace: true,
      addedTables: [
        { step: 1, table: 'message', kind: 'added', count: 2, why: 'the two delivered EMPATHY_STATEMENT copies (the reveal)' },
        { step: 1, table: 'participant_milestone', kind: 'added', count: 1, why: "Bob's empathy_submitted (TS-10 consentToShare)" },
      ],
    }),
  ],
};
