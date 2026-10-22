/**
 * Allow-list and known leaks for `choices-hidden-until-shared` (golden R4,
 * choices half).
 *
 * Plan §4 R4: partner `proposal_choice` invisible before `choices_shared`;
 * `proposal_need`, `v_need_coverage`, `v_session_closure_items` name only
 * `need_share` ids. Spec §7: "partner choices stay hidden until the chooser
 * reaches choices_shared" (`proposal_choice` RLS arm over
 * `participant_milestone`).
 *
 * Beyond the DTO rules, the target may change the need text the Stage 4 state
 * shows: every need it names comes from `need_share` (shared text) instead of
 * `Stage4NeedCoverage.needLabel` (a copy of the private label). Nothing about
 * choices may change.
 */

import type { KnownLeak } from '../privacy';
import { READ_DTO_RULES } from './common';
import type { AllowList } from './types';

/**
 * Step layout (the scenario asserts it): Ada's 9 reads (0–8), Bob chooses
 * twice (9, 10), Ada's 9 reads (11–19), Bob sets aside a need (20) and shares
 * (21), Ada's 9 reads (22–30).
 */
export const ADA_READ_STEPS = [0, 11, 22].flatMap(start => Array.from({ length: 9 }, (_, i) => start + i));
export const BOB_WRITE_STEPS = [9, 10, 20, 21];

export const CHOICES_HIDDEN_UNTIL_SHARED_ALLOW: AllowList = {
  scenario: 'choices-hidden-until-shared',
  rules: [
    ...READ_DTO_RULES,
    {
      // Only the keys that name a need in the Stage 4 state — never a
      // proposal's text or source label. Paired with the scenario's probe of
      // the partner's need labels (KNOWN leaks below): on the target the text
      // may change, the label may not reappear.
      // Fix round 2: pinned to Ada's READ steps (the probed ones); Bob's write
      // responses (which carry Ada's labels) are compared byte for byte.
      kind: 'mayDiffer',
      at: ADA_READ_STEPS.flatMap(i =>
        [
          'walkthrough.currentNeed.label',
          'walkthrough.ownNeeds.*.label',
          'walkthrough.partnerNeeds.*.label',
          '**.needsAddressed.*.label',
          'inventory.unaddressedNeeds.*.label',
          'coverageAudit.*.*.label',
        ].map(s => `steps.${i}.body.data.${s}`),
      ),
      mustMatch: true,
      why:
        'spec §1.4 v_need_coverage over need_share: a need named in Stage 4 is its shared text, not the label ' +
        'Stage4NeedCoverage copied (plan step 8: coverage is computed, not copied).',
    },
  ],
  targetOnly: [
    {
      assertion:
        'proposal_need and need_disposition are NON-EMPTY after the share, and every need_id they name is a need_share ' +
        'id (spec §7 "can never name an unshared need").',
      why:
        'On the current shape the check is tautological: the views join old_concept_need_share, so they can only name ' +
        'need_share ids, and this fixture has none (the scenario pins that they are empty). Only the target can make ' +
        'the assertion bite.',
    },
    {
      assertion:
        'v_session_closure_items names only need_share ids: close Stage 4 with an open shared need and an unshared ' +
        'one; the closure items list the shared one only.',
      why:
        'Closing needs every open need addressed or set aside and both partners’ choices shared; on today’s fixtures ' +
        'no need has a need_share row (TS-5 finding F2), so the "unshared vs shared" distinction the assertion needs ' +
        'cannot be built on the current shape. Recorded for the target re-record.',
    },
  ],
};

/** Choices: observed against the current code (none); see `privacy.ts` for the contract. */
export const CHOICES_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS: KnownLeak[] = [];

/** The partner's need labels in Ada's reads: observed against the current code. */
export const CHOICES_NEED_LABEL_KNOWN_LEAKS: KnownLeak[] = [
  'before bob chooses',
  'bob chose, not shared',
  'bob shared',
].map(phase => ({
  at: `${phase}: stage4 as ada@e2e.test ⊃ bob need label Support`,
  finding:
    'R4: GET /sessions/:id/stage4 shows a partner’s private need label (Stage4NeedCoverage.needLabel) in the ' +
    'walkthrough, coverage audit and proposal cards — the F-R4-1 class (label, not shared text)',
  evidence:
    'body.data.walkthrough.partnerNeeds[0].label, coverageAudit.partial[0].label and needsAddressed[].label = "Support" ' +
    '(Bob’s IdentifiedNeed.need, copied into Stage4NeedCoverage.needLabel by the fixture as Stage 4 coverage does); ' +
    'services/stage4-state.ts builds them from coverage rows. Bob’s other need ("Understanding") has no coverage row ' +
    'and is not shown.',
}));

/** Ada's need labels in Bob's write responses: observed against the current code (fix round 2). */
export const CHOICES_BOB_WRITES_KNOWN_LEAKS: KnownLeak[] = [
  'choose pause as bob',
  'choose checkin as bob',
  'set aside open need as bob',
  'share selections as bob',
].flatMap(step =>
  ['Partnership', 'Appreciation'].map(label => ({
    at: `${step} ⊃ ada need label ${label}`,
    finding:
      'R4: Stage 4 write responses (selection, need decline, share-selections) return the Stage 4 state with the ' +
      'partner’s private need labels — the mirror of F-R4-2 (F-R4-3)',
    evidence:
      `body.data.state (walkthrough.partnerNeeds / proposalGroups[].proposals[].needsAddressed / coverageAudit) names ` +
      `Ada's need "${label}" (Stage4NeedCoverage.needLabel) in the response to Bob's own write.`,
  })),
);
