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

import type { AllowList } from './types';

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
  ],
};
