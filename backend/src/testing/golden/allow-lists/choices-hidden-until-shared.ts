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

export const CHOICES_HIDDEN_UNTIL_SHARED_ALLOW: AllowList = {
  scenario: 'choices-hidden-until-shared',
  rules: [
    ...READ_DTO_RULES,
    {
      kind: 'mayDiffer',
      at: 'steps.*.body.data.**.label',
      mustMatch: true,
      why:
        'spec §1.4 v_need_coverage over need_share: a need named in Stage 4 is its shared text, not the label ' +
        'Stage4NeedCoverage copied (plan step 8: coverage is computed, not copied).',
    },
  ],
  targetOnly: [
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

/** Observed against the current code; see `privacy.ts` for the contract. */
export const CHOICES_HIDDEN_UNTIL_SHARED_KNOWN_LEAKS: KnownLeak[] = [];
