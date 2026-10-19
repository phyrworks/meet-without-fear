/**
 * Allow-list for `session-read`'s normalised baseline
 * (`__golden__/session-read.concept.json`).
 *
 * Plan §4, "Golden harness" row: identical, except
 *  - `StageProgressDetailDTO.gatesSatisfied` is derived from
 *    `participant_milestone` in the target, and the four keys the step-7 key
 *    table drops are asserted ABSENT; every other key is asserted equal.
 *  - `ConsentRecordDTO.targetType` narrows to the target's five consent
 *    targets, so its values are asserted ⊆ the baseline's.
 * Nothing may be added anywhere: there is no `addedKeys` rule.
 *
 * On the current shape both rules are satisfied trivially: FEEL_HEARD_B's
 * `gatesSatisfied` bodies are `{}` (none of the four keys), and no consent DTO
 * appears in this scenario's bodies.
 */

import type { AllowList } from './types';

export const SESSION_READ_ALLOW: AllowList = {
  scenario: 'session-read',
  rules: [
    {
      kind: 'absentKeys',
      at: 'steps.*.body.**.gatesSatisfied',
      keys: ['feelHeardCheckOffered', 'readyToRank', 'rankingSubmitted', 'finalEmotionalReading'],
      // `session state` returns `progress.myProgress.gatesSatisfied` for both
      // actors today. If the DTO moves, this rule must move with it.
      mustMatch: true,
      why:
        'plan §3 step 7: feelHeardCheckOffered (AI hint) and finalEmotionalReading (always null) are dropped; ' +
        'readyToRank/rankingSubmitted are dropped with ranking. gatesSatisfied becomes derived from participant_milestone.',
    },
    {
      kind: 'valuesSubset',
      // The brief names `ConsentRecordDTO.targetType`; the shared DTO field is
      // spelled `contentType` (shared/src/dto/consent.ts). Both spellings are
      // covered. Neither appears in this scenario's bodies today, so the rule
      // is not `mustMatch`.
      at: ['steps.*.body.**.targetType', 'steps.*.body.**.contentType'],
      why:
        'spec §3 consent_target: 7 ConsentContentType values become 5 real targets (EMPATHY_DRAFT folds into ' +
        'EMPATHY_ATTEMPT; EVENT_SUMMARY/EMOTIONAL_PATTERN/BOUNDARY have none). A value may disappear, none may appear.',
    },
  ],
};
