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
    {
      kind: 'addedEntries',
      at: 'steps.*.changes',
      where: { view: 'message', kind: 'added', 'after.kind': 'EMPATHY_STATEMENT' },
      why:
        'plan §3 step 9: the reveal job writes an EMPATHY_STATEMENT row into the SUBJECT\'s conversation; today it ' +
        'is written only into the author\'s own chat (spec §1.1 message.source_attempt_id).',
    },
    {
      kind: 'addedEntries',
      // In `initial` the rows are keyed by label, so the entry is the row itself.
      at: 'initial.message',
      where: { kind: 'EMPATHY_STATEMENT' },
      why: 'as above, for a fixture that already holds a revealed attempt (none in FEEL_HEARD_B today).',
    },
  ],
};
