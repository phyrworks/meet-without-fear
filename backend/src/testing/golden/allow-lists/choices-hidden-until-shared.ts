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
import type { AllowList, AllowRule } from './types';

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

/**
 * The partner's need labels in Ada's reads — TS-11 (work-a39h.11.21): EMPTY.
 * The three entries recorded `<phase>: stage4 as ada@e2e.test ⊃ bob need label
 * Support` (finding "R4: GET /sessions/:id/stage4 shows a partner's private
 * need label (Stage4NeedCoverage.needLabel)"); on the target a partner's need
 * is named by its need_share.shared_text, so they are closed and deleted.
 */
export const CHOICES_NEED_LABEL_KNOWN_LEAKS: KnownLeak[] = [];

/**
 * Ada's need labels in Bob's write responses — TS-11 (work-a39h.11.21): EMPTY.
 * The eight entries recorded `<write step> ⊃ ada need label Partnership|Appreciation`
 * (finding F-R4-3, "Stage 4 write responses return the Stage 4 state with the
 * partner's private need labels"); closed on the target the same way.
 */
export const CHOICES_BOB_WRITES_KNOWN_LEAKS: KnownLeak[] = [];

// ============================================================================
// TS-11 — the byte-level golden on the TARGET shape
// ============================================================================
//
// Recorded on the current shape, never re-recorded: compared under the
// concept rules above plus what the target computes differently by design
// (ruling R29 / Q3). The Stage 4 state is built from v_need_coverage over
// need_share (no Stage4NeedCoverage table): need ids are need_share ids, the
// coverage buckets are computed (Partnership is PARTIAL while only Ada is
// WILLING), the coverage note is dropped, and Bob's "Understanding" appears
// because "pause" covers it. The rules are keyed by exact DTO keys under the
// enumerated Stage 4 paths, over the named Stage 4 steps (Ada's three Stage 4
// reads and Bob's four write responses, whose `state` is the same DTO). The
// scenario asserts the real values (the target-only checks in the test).
// The step changes are compared by TS-10's `changesMapped` once
// phoenix/target-shape carries it (R27/R28), and each newly visible need's
// `addedEntries` is pinned from the comparison output, in the post-merge round.

/** Ada's Stage 4 reads (the 6th read of each block of nine). */
export const ADA_STAGE4_READ_STEPS = [5, 16, 27];

/** Every Stage 4 state DTO of the scenario, as a path prefix. */
export const STAGE4_STATE_ROOTS = [
  ...ADA_STAGE4_READ_STEPS.map(i => `steps.${i}.body.data`),
  ...BOB_WRITE_STEPS.map(i => `steps.${i}.body.data.state`),
];

function stage4ComputedRules(): AllowRule[] {
  const needKeys = (prefix: string, keys: string[]) => keys.map(k => `${prefix}.${k}`);
  const at = STAGE4_STATE_ROOTS.flatMap(r => [
    ...needKeys(`${r}.walkthrough.currentNeed`, ['id', 'label', 'status']),
    ...needKeys(`${r}.walkthrough.ownNeeds.*`, ['id', 'label', 'status']),
    ...needKeys(`${r}.walkthrough.partnerNeeds.*`, ['id', 'label', 'status']),
    ...needKeys(`${r}.walkthrough.proposalGroups.*.proposals.*.needsAddressed.*`, ['id', 'label', 'coverage']),
    ...needKeys(`${r}.inventory.sharedProposals.*.needsAddressed.*`, ['id', 'label', 'coverage']),
    ...needKeys(`${r}.inventory.individualCommitments.*.needsAddressed.*`, ['id', 'label', 'coverage']),
    ...needKeys(`${r}.inventory.unaddressedNeeds.*`, ['id', 'label', 'note']),
    // The coverage status buckets and their instant are computed (v_need_coverage).
    ...needKeys(`${r}.coverageAudit`, ['covered', 'partial', 'open', 'updatedAt']),
  ]);
  return [
    {
      kind: 'mayDiffer',
      at,
      mustMatch: true,
      why:
        'R29: a need named in the Stage 4 state is a need_share id, named by the reader’s own label or the partner’s ' +
        'shared text; coverage is computed from v_need_coverage over the choices the reader may see (R20), and its ' +
        'note has no table.',
    },
    {
      kind: 'addedKeys',
      at: STAGE4_STATE_ROOTS.map(r => `${r}.inventory.individualCommitments.*.needsAddressed.*`),
      keys: ['id'],
      why: 'R29: the individual commitment’s need is a proposal_need link (a need_share id) — today a bare label with no id.',
    },
  ];
}

export const CHOICES_HIDDEN_UNTIL_SHARED_BYTE_TARGET_ALLOW: AllowList = {
  scenario: 'choices-hidden-until-shared',
  rules: [...CHOICES_HIDDEN_UNTIL_SHARED_ALLOW.rules, ...stage4ComputedRules()],
};
