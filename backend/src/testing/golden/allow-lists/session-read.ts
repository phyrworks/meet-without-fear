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
    ...SESSION_READ_FIXTURE_DELTAS(),
  ],
};

/**
 * TS-9 — FIXTURE-REPRESENTATION deltas, found by running the target. Not
 * behaviour changes: facts the FEEL_HEARD_B fixture encodes in a way the
 * target schema cannot hold (or holds more fully), each named with the
 * fixture fact and paired with an assertion of the target's real value in
 * `session-read.golden.test.ts`. On the current shape every one holds
 * trivially (masks are applied to target runs only; nothing differs).
 * Owner-visible: plan §4's "identical except two keys" did not anticipate
 * them — they are listed in the TS-9 report.
 */
function SESSION_READ_FIXTURE_DELTAS(): AllowList['rules'] {
  return [
    {
      kind: 'fixtureMask',
      at: ['steps.*.body.data.compact.mySignedAt', 'steps.*.body.data.compact.partnerSignedAt'],
      expect: 'isoTimestamp',
      baseline: null,
      why:
        'the current-shape fixture writes the compact gate as `compactSignedAt` (a fixture-only spelling, ' +
        'current-shape.sql header) where the app reads `signedAt`, so today the DTO says null — as it does in ' +
        'production for an inviter, whose stage-0 row confirmInvitationMessage completes with `compactSigned` and ' +
        'no `signedAt`. The target always holds the instant (participant_milestone compact_signed.reached_at) and ' +
        'the shim returns it (a visible behaviour change: the DTO gains an instant where it had null). As a new ' +
        'instant it would renumber every later <ts:N> of the step, so it is masked after the test asserts its value.',
    },
    {
      kind: 'mayDiffer',
      at: ['steps.*.body.data.messages.*.stage', 'steps.*.body.data.messages.messages.*.stage'],
      why:
        'spec §1.1 message: `stage` is dropped ("derivable from participant_milestone"). The fixture tags messages ' +
        'with journey phases that run ahead of its milestone instants (Ada\'s messages 3–6 are "witness" before ' +
        'her compact_signed). The target DTO stage is the owner\'s stage at the message instant (stage shim); the ' +
        'test asserts exactly that for every message.',
    },
    {
      kind: 'mayDiffer',
      at: [
        'initial.user.*.first_name',
        'initial.user.*.last_name',
        'steps.*.changes.*.before.first_name',
        'steps.*.changes.*.before.last_name',
        'steps.*.changes.*.after.first_name',
        'steps.*.changes.*.after.last_name',
      ],
      why:
        'spec §1.7 user: `name` is GENERATED from first/last; the old factory wrote only `name`. The target writer ' +
        'splits "Ada Lovelace" so `name` is equal (asserted by the comparison: `name` is not on this list).',
    },
    {
      kind: 'addedEntries',
      at: 'initial.participant_milestone',
      where: {
        $key: '<milestone:ada@main/empathy_submitted>',
        milestone_key: 'empathy_submitted',
        participant_id: '<participant:ada@main>',
        reached_at: '<ts:14>',
      },
      why:
        'Ada submitted her attempt (scenario milestone empathy_submitted; TS-7 step 7 derives it from ' +
        'EmpathyAttempt.sharedAt). The TS-4 view decodes only gate keys and omits it; the target stores it. ' +
        'Pinned to its instant: the attempt\'s submitted_at (<ts:14>).',
    },
  ];
}

/**
 * The byte-level golden (`__golden__/session-read.json`) on the TARGET shape
 * (TS-9). It was recorded on the current shape and is never re-recorded: the
 * target run is compared to it under the concept allow-list's rules plus what
 * is shape-bound in a byte-level step.
 */
export const SESSION_READ_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'session-read',
  rules: [
    ...SESSION_READ_ALLOW.rules,
    {
      kind: 'mayDiffer',
      at: 'steps.*.trace',
      mustMatch: true,
      why:
        'the SQL trace names relations and plans, which are shape-bound (README "Reading a trace diff during the ' +
        'migration"); its contract part for this scenario — the paginated read is bounded — is asserted on the ' +
        'target run by the test itself',
    },
  ],
};
